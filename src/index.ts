import { DatabaseService } from "./modules/database/database.service.js";
import { SqlValidator } from "./modules/query/sql-validator.js";
import { QueryService } from "./modules/query/query.service.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SchemaService } from "./modules/schema/schema.service.js";
import { ApprovalStore } from "./modules/approval/approval.store.js";
import { ApprovalService } from "./modules/approval/approval.service.js";
import { ApprovalWorkflowService } from "./modules/approval/approval-workflow.service.js";
import { McpApprovalConfirmationProvider } from "./modules/approval/mcp-approval-confirmation.provider.js";
import { SqlOperationClassifier } from "./modules/query/sql-operation-classifier.js";
import { WriteSqlValidator } from "./modules/query/write-sql-validator.js";
import { SqlAnalysisService } from "./modules/query/sql-analysis.service.js";
import { OperationExecutionService } from "./modules/approval/operation-execution.service.js";
import { OperationExecutionWorkflowService } from "./modules/approval/operation-execution-workflow.service.js";
import { DiagnosticsService } from "./modules/diagnostics/diagnostics.service.js";
import { z } from "zod";
import config from "./config/index.js";
import {
    registerTool,
    createReadOnlyTool,
    createReadOnlyNonIdempotentTool,
    createWriteToolRequiresApproval,
    createWriteToolExecutes,
    executeWithCancellation,
} from "./modules/mcp/tool-registry.js";
import {
    createToolError,
    createSuccessResult,
    createErrorResult,
    handleValidationError,
    handleApprovalError,
} from "./modules/mcp/mcp-response.js";

const queryConnectionString = config.queryDatabaseUrl;
const writeConnectionString = config.writeDatabaseUrl;

if (!queryConnectionString) {
    throw new Error("QUERY_DATABASE_URL is not configured");
}

const database = new DatabaseService(
    queryConnectionString,
    writeConnectionString,
);
const validator = new SqlValidator();
const queryService = new QueryService(database, validator);
const schemaService = new SchemaService(database);
const diagnosticsService = new DiagnosticsService(database, schemaService, validator);

const server = new McpServer({
    name: "pgmind",
    version: "1.0.0",
});

const approvalStore = new ApprovalStore();

const operationClassifier = new SqlOperationClassifier();
const analysisService = new SqlAnalysisService();

const approvalService = new ApprovalService(
    approvalStore,
    operationClassifier,
    analysisService,
    database,
);

const confirmationProvider = new McpApprovalConfirmationProvider(server);

const approvalWorkflow = new ApprovalWorkflowService(
    approvalService,
    confirmationProvider,
);

const writeSqlValidator = new WriteSqlValidator();

const operationExecutionService = new OperationExecutionService(
    approvalStore,
    operationClassifier,
    database,
);

const operationExecutionWorkflow = new OperationExecutionWorkflowService(
    operationExecutionService,
);

// Tool: ping
registerTool(server, createReadOnlyTool(
    "ping",
    "Health check endpoint. Returns server status.",
    z.object({
        message: z.string().optional().describe("Optional message to echo back"),
    }),
    async ({ message }) => ({
        success: true,
        data: {
            status: "running",
            server: "pgmind",
            message: message ? `Message received: ${message}` : "Pong!",
        },
    }),
));

// Tool: execute_query
registerTool(server, createReadOnlyNonIdempotentTool(
    "execute_query",
    "Execute a read-only SQL query against the connected PostgreSQL database. " +
    "Only SELECT and read-only CTE statements are supported. " +
    "Writes, row-locking queries (FOR UPDATE/SHARE), and unsupported statements are rejected. " +
    "Results are bounded by row limit (100) and response size limit (1MB).",
    z.object({
        sql: z
            .string()
            .min(1, "SQL query cannot be empty")
            .max(50_000, "SQL query exceeds the maximum length of 50,000 characters")
            .describe("The SQL query to execute"),
    }),
    async ({ sql }) => {
        const validation = validator.validate(sql);
        if (!validation.valid) {
            return createErrorResult(handleValidationError(new Error(validation.reason)));
        }

        const normalizedSql = sql.trim().replace(/;\s*$/, "");

        return executeWithCancellation(undefined, async () => {
            const result = await queryService.executeQuery(normalizedSql);
            return createSuccessResult(result, {
                truncated: result.truncated,
                truncatedReason: result.truncatedReason,
                rowCount: result.rowCount,
            });
        });
    },
));

// Tool: get_database_schema
registerTool(server, createReadOnlyTool(
    "get_database_schema",
    "Discover the connected PostgreSQL database schemas, tables, views, columns, constraints, indexes, sequences, and functions. " +
    "Returns comprehensive metadata for all accessible objects. " +
    "Supports filtering via optional parameters.",
    z.object({
        schemaNames: z.array(z.string()).optional().describe("Optional: filter to specific schemas"),
        tableNames: z.array(z.string()).optional().describe("Optional: filter to specific tables"),
        includeViews: z.boolean().optional().default(true).describe("Include views"),
        includeMaterializedViews: z.boolean().optional().default(true).describe("Include materialized views"),
        includeSequences: z.boolean().optional().default(true).describe("Include sequences"),
        includeFunctions: z.boolean().optional().default(true).describe("Include functions"),
        includeIndexes: z.boolean().optional().default(true).describe("Include indexes"),
        includeConstraints: z.boolean().optional().default(true).describe("Include constraints"),
    }),
    async (params) => {
        return executeWithCancellation(undefined, async () => {
            const result = await schemaService.getDatabaseSchema(params);
            return createSuccessResult(result);
        });
    },
));

// Tool: prepare_operation
registerTool(server, createWriteToolRequiresApproval(
    "prepare_operation",
    "Prepare a database write operation and request explicit human approval. Does not execute SQL. " +
    "Supported operations: INSERT, UPDATE, DELETE, CREATE, ALTER, DROP, TRUNCATE. " +
    "Requires human confirmation via MCP elicitation before execution.",
    z.object({
        sql: z.string().min(1).max(50_000).describe("The SQL write operation to prepare"),
    }),
    async ({ sql }) => {
        const validation = writeSqlValidator.validate(sql);
        if (!validation.valid) {
            return createErrorResult(handleValidationError(new Error(validation.reason)));
        }

        return executeWithCancellation(undefined, async () => {
            const result = await approvalWorkflow.prepareAndConfirm(sql);
            return createSuccessResult(result, { approvalId: result.id });
        });
    },
));

// Tool: execute_approved_operation
registerTool(server, createWriteToolExecutes(
    "execute_approved_operation",
    "Execute a database operation that has already received human approval. " +
    "Requires an approval ID returned by prepare_operation. " +
    "The exact SQL from the approval request is executed. " +
    "Single-use: each approval ID can only be executed once.",
    z.object({
        approvalId: z.uuid().describe("The approval ID returned by prepare_operation"),
    }),
    async ({ approvalId }) => {
        return executeWithCancellation(undefined, async () => {
            const result = await operationExecutionWorkflow.execute(approvalId);
            return createSuccessResult(result, {
                approvalId: result.approvalId,
                affectedRows: result.affectedRows,
            });
        });
    },
));

// Tool: explain_query
registerTool(server, createReadOnlyNonIdempotentTool(
    "explain_query",
    "Get the PostgreSQL EXPLAIN plan for a query. " +
    "Supports ANALYZE option for actual execution statistics (note: ANALYZE executes the query). " +
    "Formats: json (structured), text (human-readable), xml, yaml.",
    z.object({
        sql: z.string().min(1).max(50_000).describe("The SQL query to explain"),
        analyze: z.boolean().optional().default(false).describe("Execute query and show actual timing (modifies data for writes!)"),
        format: z.enum(["json", "text", "xml", "yaml"]).optional().default("json").describe("Output format"),
        verbose: z.boolean().optional().default(true).describe("Show detailed plan information"),
        costs: z.boolean().optional().default(true).describe("Show cost estimates"),
        buffers: z.boolean().optional().default(true).describe("Show buffer usage"),
        timing: z.boolean().optional().default(true).describe("Show timing information"),
    }),
    async ({ sql, analyze, format, verbose, costs, buffers, timing }) => {
        const validation = validator.validate(sql);
        if (!validation.valid) {
            return createErrorResult(handleValidationError(new Error(validation.reason)));
        }

        return executeWithCancellation(undefined, async () => {
            const result = await diagnosticsService.explainQuery(sql, {
                analyze,
                format,
                verbose,
                costs,
                buffers,
                timing,
            });
            return createSuccessResult(result);
        });
    },
));

// Tool: analyze_query_plan
registerTool(server, createReadOnlyTool(
    "analyze_query_plan",
    "Analyze a query's EXPLAIN plan and identify performance issues with recommendations. " +
    "Detects: sequential scans, nested loops with row estimate errors, sort spills to disk, " +
    "high cost operations, and row estimate errors. Returns structured issues with severity and recommendations.",
    z.object({
        sql: z.string().min(1).max(50_000).describe("The SQL query to analyze"),
    }),
    async ({ sql }) => {
        const validation = validator.validate(sql);
        if (!validation.valid) {
            return createErrorResult(handleValidationError(new Error(validation.reason)));
        }

        return executeWithCancellation(undefined, async () => {
            const result = await diagnosticsService.analyzeQueryPlan(sql);
            return createSuccessResult(result);
        });
    },
));

// Tool: diagnose_error
registerTool(server, createReadOnlyTool(
    "diagnose_error",
    "Diagnose a PostgreSQL error message and provide explanation, affected objects, and suggested actions. " +
    "Maps SQLSTATE codes to human-readable explanations (e.g., 23505=unique violation, 23503=FK violation, 42501=permission denied). " +
    "Returns structured diagnosis with affected database objects and remediation steps.",
    z.object({
        errorMessage: z.string().min(1).describe("The PostgreSQL error message to diagnose"),
    }),
    async ({ errorMessage }) => {
        return executeWithCancellation(undefined, async () => {
            const error = new Error(errorMessage);
            const result = await diagnosticsService.diagnoseError(error);
            return createSuccessResult(result);
        });
    },
));

// Tool: get_index_diagnostics
registerTool(server, createReadOnlyTool(
    "get_index_diagnostics",
    "Get index usage statistics and suggestions for a table. " +
    "Returns: index scans, tuples read/fetched, unused index detection, duplicate index detection, " +
    "and suggestions for missing/dropping indexes.",
    z.object({
        schemaName: z.string().min(1).describe("Schema name"),
        tableName: z.string().min(1).describe("Table name"),
    }),
    async ({ schemaName, tableName }) => {
        return executeWithCancellation(undefined, async () => {
            const result = await diagnosticsService.getIndexDiagnostics(schemaName, tableName);
            return createSuccessResult(result);
        });
    },
));

// Tool: get_schema (filtered)
registerTool(server, createReadOnlyTool(
    "get_schema",
    "Get schema metadata for a specific schema. More efficient than get_database_schema when you only need one schema.",
    z.object({
        schemaName: z.string().min(1).describe("Schema name to retrieve"),
    }),
    async ({ schemaName }) => {
        return executeWithCancellation(undefined, async () => {
            const result = await schemaService.getSchema(schemaName);
            if (!result) {
                return createErrorResult(createToolError("INVALID_SQL", `Schema '${schemaName}' not found`));
            }
            return createSuccessResult(result);
        });
    },
));

// Tool: get_table (filtered)
registerTool(server, createReadOnlyTool(
    "get_table",
    "Get detailed table metadata including columns, constraints, and indexes for a specific table.",
    z.object({
        schemaName: z.string().min(1).describe("Schema name"),
        tableName: z.string().min(1).describe("Table name"),
    }),
    async ({ schemaName, tableName }) => {
        return executeWithCancellation(undefined, async () => {
            const result = await schemaService.getTable(schemaName, tableName);
            if (!result) {
                return createErrorResult(createToolError("INVALID_SQL", `Table '${schemaName}.${tableName}' not found`));
            }
            return createSuccessResult(result);
        });
    },
));

// Tool: list_schemas
registerTool(server, createReadOnlyTool(
    "list_schemas",
    "List all accessible schema names in the database.",
    z.object({}),
    async () => {
        return executeWithCancellation(undefined, async () => {
            const result = await schemaService.listSchemas();
            return createSuccessResult({ schemas: result });
        });
    },
));

async function main() {
    await database.verifyConnections();

    const transport = new StdioServerTransport();
    try {
        await server.connect(transport);

        console.error(
            "PGMind MCP server is running. Waiting for requests...",
        );
    } catch (error) {
        await database.shutdown();
        throw error;
    }
}

let isShuttingDown = false;

async function shutdown() {
    if (isShuttingDown) {
        return;
    }
    isShuttingDown = true;
    console.error("Shutting down PGMind MCP server...");
    try {
        await server.close();
    } catch (error) {
        console.error("Error closing MCP server:", error);
    }

    try {
        await database.shutdown();
        console.error("Database connection pools closed.");
    } catch (error) {
        console.error("Error closing database connection pools:", error);
    }

    process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

main().catch(async (err) => {
    console.error("Error starting PGMind MCP server:", err);
    await database.shutdown();
    process.exit(1);
});