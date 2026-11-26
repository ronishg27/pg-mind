import { DatabaseService } from "../database/database.service.js";
import { SchemaService } from "../schema/schema.service.js";
import { SqlValidator } from "../query/sql-validator.js";
import {
    ExplainOptions,
    ExplainResult,
    ExplainPlanNode,
    ErrorInfo,
    ErrorDiagnosis,
    AffectedObject,
    IndexDiagnosticsResult,
    IndexDiagnosticsInfo,
    IndexSuggestion,
    QueryPlanAnalysis,
    QueryPlanIssue,
} from "./diagnostics.types.js";

export class DiagnosticsService {
    constructor(
        private readonly database: DatabaseService,
        private readonly schemaService: SchemaService,
        private readonly validator: SqlValidator,
    ) {}

    async explainQuery(
        sql: string,
        options: ExplainOptions = {},
    ): Promise<ExplainResult> {
        const validation = this.validator.validate(sql);

        if (!validation.valid) {
            throw new Error(`Invalid SQL query: ${validation.reason}`);
        }

        const {
            analyze = false,
            verbose = true,
            costs = true,
            buffers = false,
            timing = false,
            summary = true,
            format = "json",
        } = options;

        const explainOptions: string[] = [];
        if (analyze) explainOptions.push("ANALYZE");
        if (verbose) explainOptions.push("VERBOSE");
        if (costs) explainOptions.push("COSTS");
        // BUFFERS and TIMING require ANALYZE
        if (analyze && buffers) explainOptions.push("BUFFERS");
        if (analyze && timing) explainOptions.push("TIMING");
        if (summary) explainOptions.push("SUMMARY");
        explainOptions.push(`FORMAT ${format.toUpperCase()}`);

        const explainSql = `EXPLAIN (${explainOptions.join(", ")}) ${sql}`;

        return this.database.withReadOnlyTransaction(async (client) => {
            const result = await client.query<{ [key: string]: unknown }>(explainSql);
            const row = result.rows[0];

            if (format === "json") {
                const planData = row["QUERY PLAN"] as Array<{ Plan: ExplainPlanNode; "Planning Time"?: number; "Execution Time"?: number }>;
                const explain = planData[0];
                return {
                    plan: explain.Plan,
                    planningTime: explain["Planning Time"],
                    executionTime: explain["Execution Time"],
                };
            }

            return {
                plan: { "Node Type": "Text", "Plan": row["QUERY PLAN"] as string } as ExplainPlanNode,
            };
        });
    }

    async analyzeQueryPlan(sql: string): Promise<QueryPlanAnalysis> {
        const explainResult = await this.explainQuery(sql, { analyze: true, format: "json" });
        const plan = explainResult.plan;

        const issues: QueryPlanIssue[] = [];
        this.analyzePlanNode(plan, issues);

        const summary = this.generatePlanSummary(plan);
        const recommendations = this.generateRecommendations(issues);

        return {
            summary,
            issues,
            recommendations,
        };
    }

    private analyzePlanNode(node: ExplainPlanNode, issues: QueryPlanIssue[], parentNode?: ExplainPlanNode): void {
        const nodeType = node["Node Type"];

        if (nodeType === "Seq Scan") {
            const tableName = node["Relation Name"];
            const schema = node["Schema"];
            issues.push({
                type: "seq_scan",
                severity: "high",
                node,
                description: `Sequential scan on ${schema ? `${schema}.` : ""}${tableName || "unknown table"}`,
                recommendation: "Consider adding an index on the filtered columns",
            });
        }

        if (nodeType === "Nested Loop") {
            const actualRows = node["Actual Rows"] as number | undefined;
            const planRows = node["Plan Rows"] as number | undefined;
            if (actualRows && planRows && actualRows > planRows * 10) {
                issues.push({
                    type: "nested_loop",
                    severity: "medium",
                    node,
                    description: `Nested loop with significant row estimate error (actual: ${actualRows}, planned: ${planRows})`,
                    recommendation: "Check statistics with ANALYZE; consider joining smaller table first",
                });
            }
        }

        if (nodeType === "Sort") {
            const sortSpaceUsed = node["Sort Space Used"] as number | undefined;
            const sortSpaceType = node["Sort Space Type"] as string | undefined;
            if (sortSpaceType === "Disk" && sortSpaceUsed && sortSpaceUsed > 1024 * 1024) {
                issues.push({
                    type: "sort_spill",
                    severity: "high",
                    node,
                    description: `Sort spilled to disk (${sortSpaceUsed} KB)`,
                    recommendation: "Increase work_mem or add index to avoid sort",
                });
            }
        }

        const totalCost = node["Total Cost"] as number | undefined;
        if (totalCost && totalCost > 10000) {
            issues.push({
                type: "high_cost",
                severity: "medium",
                node,
                description: `High cost operation (cost: ${totalCost.toFixed(2)})`,
                recommendation: "Review query structure and indexes",
            });
        }

        const actualRows = node["Actual Rows"] as number | undefined;
        const planRows = node["Plan Rows"] as number | undefined;
        if (actualRows && planRows && planRows > 0 && (actualRows / planRows > 10 || planRows / actualRows > 10)) {
            issues.push({
                type: "row_estimate_error",
                severity: "medium",
                node,
                description: `Row estimate error: actual ${actualRows} vs planned ${planRows}`,
                recommendation: "Run ANALYZE on involved tables",
            });
        }

        if (node["Subplans"]) {
            for (const subplan of node["Subplans"] as ExplainPlanNode[]) {
                this.analyzePlanNode(subplan, issues, node);
            }
        }

        if (node["Plans"]) {
            for (const subplan of node["Plans"] as ExplainPlanNode[]) {
                this.analyzePlanNode(subplan, issues, node);
            }
        }
    }

    private generatePlanSummary(plan: ExplainPlanNode): string {
        const nodeType = plan["Node Type"];
        const totalCost = plan["Total Cost"];
        const actualTime = plan["Actual Total Time"];
        const actualRows = plan["Actual Rows"];

        let summary = `Query plan: ${nodeType}`;
        if (totalCost !== undefined) summary += ` (cost: ${totalCost.toFixed(2)})`;
        if (actualTime !== undefined) summary += `, actual time: ${actualTime.toFixed(2)} ms`;
        if (actualRows !== undefined) summary += `, rows: ${actualRows}`;

        return summary;
    }

    private generateRecommendations(issues: QueryPlanIssue[]): string[] {
        const recommendations = new Set<string>();

        for (const issue of issues) {
            recommendations.add(issue.recommendation);
        }

        return Array.from(recommendations);
    }

    async diagnoseError(error: Error & { code?: string; detail?: string; hint?: string; schema?: string; table?: string; column?: string; constraint?: string }): Promise<ErrorDiagnosis> {
        const errorInfo = this.parseError(error);
        const affectedObjects = await this.findAffectedObjects(errorInfo, error);
        const explanation = this.generateErrorExplanation(errorInfo);
        const suggestedActions = this.generateSuggestedActions(errorInfo, affectedObjects);

        return {
            error: errorInfo,
            explanation,
            affectedObjects,
            suggestedActions,
        };
    }

    private parseError(error: Error & { code?: string; detail?: string; hint?: string; schema?: string; table?: string; column?: string; constraint?: string }): ErrorInfo {
        // node-postgres exposes SQLSTATE as err.code
        if (error.code) {
            return {
                code: error.code,
                message: error.message,
                severity: "ERROR",
            };
        }

        // Fallback: try to parse from message
        const message = error.message;
        const pgErrorMatch = message.match(/^(?<severity>\w+):\s*(?<message>.+?)(?:\s+\(SQLSTATE\s+(?<code>\w+)\))?$/);
        
        if (pgErrorMatch?.groups) {
            const { severity, message: msg, code } = pgErrorMatch.groups;
            return {
                code: code || "UNKNOWN",
                message: msg,
                severity: severity || "ERROR",
            };
        }

        return {
            code: "APPLICATION_ERROR",
            message,
            severity: "ERROR",
        };
    }

    private async findAffectedObjects(errorInfo: ErrorInfo, originalError?: Error & { schema?: string; table?: string; column?: string; constraint?: string }): Promise<AffectedObject[]> {
        const objects: AffectedObject[] = [];

        // Use node-postgres error properties if available
        if (originalError) {
            const schema = originalError.schema || "public";
            if (originalError.schema) objects.push({ type: "schema", schema, name: originalError.schema });
            if (originalError.table) objects.push({ type: "table", schema, name: originalError.table });
            if (originalError.column) objects.push({ type: "column", schema, name: originalError.column });
            if (originalError.constraint) objects.push({ type: "constraint", schema, name: originalError.constraint });
        }

        return objects;
    }

    private generateErrorExplanation(errorInfo: ErrorInfo): string {
        const explanations: Record<string, string> = {
            "23505": "Unique constraint violation - attempting to insert/update a duplicate value in a column with a unique constraint",
            "23503": "Foreign key violation - referencing a non-existent row in the parent table",
            "23502": "Not null violation - attempting to insert NULL into a NOT NULL column",
            "23514": "Check constraint violation - data doesn't satisfy a CHECK constraint",
            "42501": "Insufficient privilege - the current role lacks permission for this operation",
            "42P01": "Undefined table - the referenced table doesn't exist",
            "42703": "Undefined column - the referenced column doesn't exist",
            "42883": "Undefined function - the function doesn't exist or argument types don't match",
            "42601": "Syntax error - invalid SQL syntax",
            "42P07": "Duplicate table - attempting to create a table that already exists",
            "42710": "Duplicate object - attempting to create an object that already exists",
            "55P03": "Lock not available - could not obtain lock within timeout",
            "40001": "Serialization failure - concurrent transaction conflict",
            "40P01": "Deadlock detected - transaction was rolled back due to deadlock",
            "57014": "Query cancelled - statement timeout or manual cancellation",
            "53300": "Out of memory - insufficient memory for operation",
            "53100": "Disk full - insufficient disk space",
        };

        return explanations[errorInfo.code] || `PostgreSQL error ${errorInfo.code}: ${errorInfo.message}`;
    }

    private generateSuggestedActions(errorInfo: ErrorInfo, affectedObjects: AffectedObject[]): string[] {
        const actions: string[] = [];

        switch (errorInfo.code) {
            case "23505":
                actions.push("Check for duplicate values before insert/update");
                actions.push("Use ON CONFLICT clause for upsert behavior");
                break;
            case "23503":
                actions.push("Ensure referenced row exists in parent table");
                actions.push("Check foreign key column values");
                break;
            case "23502":
                actions.push("Provide value for NOT NULL column");
                actions.push("Check column default values");
                break;
            case "42501":
                actions.push("Grant required privileges to the role");
                actions.push("Check role membership and permissions");
                break;
            case "42P01":
                actions.push("Verify table name and schema");
                actions.push("Check if table exists in search_path");
                break;
            case "42703":
                actions.push("Verify column name spelling");
                actions.push("Check table schema for correct column");
                break;
            case "57014":
                actions.push("Optimize query to run faster");
                actions.push("Increase statement_timeout if appropriate");
                break;
            case "40001":
            case "40P01":
                actions.push("Retry the transaction");
                actions.push("Consider adjusting isolation level");
                break;
            default:
                actions.push("Review the error message and SQL query");
        }

        return actions;
    }

    async getIndexDiagnostics(
        schemaName: string,
        tableName: string,
    ): Promise<IndexDiagnosticsResult> {
        const table = await this.schemaService.getTable(schemaName, tableName);

        if (!table) {
            throw new Error(`Table ${schemaName}.${tableName} not found`);
        }

        const indexes: IndexDiagnosticsInfo[] = [];

        for (const index of table.indexes) {
            const stats = await this.getIndexStats(schemaName, tableName, index.name);
            
            const isDuplicate = await this.checkDuplicateIndex(schemaName, tableName, index);
            
            const idxScan = stats.idxScan ?? 0;
            const idxTupFetch = stats.idxTupFetch ?? 0;
            
            indexes.push({
                name: index.name,
                isUnique: index.isUnique,
                isPrimary: index.isPrimary,
                method: index.method,
                columns: index.columns.map((c) => c.name),
                size: stats.size || "unknown",
                indexScans: idxScan,
                tuplesRead: stats.idxTupRead ?? 0,
                tuplesFetched: idxTupFetch,
                indexUsageRatio: idxScan > 0 ? idxTupFetch / idxScan : 0,
                isUnused: idxScan === 0 && !index.isPrimary,
                isDuplicate,
            });
        }

        const suggestions = this.generateIndexSuggestions(table, indexes);

        return {
            tableSchema: schemaName,
            tableName,
            indexes,
            suggestions,
        };
    }

    private async getIndexStats(
        schemaName: string,
        tableName: string,
        indexName: string,
    ): Promise<{ size?: string; idxScan?: number; idxTupRead?: number; idxTupFetch?: number }> {
        try {
            const result = await this.database.query<{
                size: string;
                idx_scan: number;
                idx_tup_read: number;
                idx_tup_fetch: number;
            }>(`
                SELECT
                    pg_size_pretty(pg_relation_size(i.oid)) AS size,
                    COALESCE(s.idx_scan, 0) AS idx_scan,
                    COALESCE(s.idx_tup_read, 0) AS idx_tup_read,
                    COALESCE(s.idx_tup_fetch, 0) AS idx_tup_fetch
                FROM pg_class i
                JOIN pg_namespace n ON n.oid = i.relnamespace
                LEFT JOIN pg_stat_user_indexes s ON s.indexrelid = i.oid
                WHERE n.nspname = $1 AND i.relname = $2
            `, [schemaName, indexName]);

            return result[0] || {};
        } catch {
            return {};
        }
    }

    private async checkDuplicateIndex(
        schemaName: string,
        tableName: string,
        index: { name: string; columns: { name: string }[]; method: string },
    ): Promise<boolean> {
        const cols = index.columns.map((c) => c.name).join(",");
        
        const result = await this.database.query<{ count: string }>(`
            SELECT COUNT(*)::text AS count
            FROM pg_index i
            JOIN pg_class c ON c.oid = i.indrelid
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = $1 AND c.relname = $2
            AND i.indisprimary = false
            AND i.indkey::text[]::text LIKE $3
            AND i.indexrelid != (
                SELECT oid FROM pg_class WHERE relname = $4 AND relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = $1)
            )
        `, [schemaName, tableName, `%${index.columns[0].name}%`, index.name]);

        return parseInt(result[0]?.count || "0") > 0;
    }

    private generateIndexSuggestions(
        table: { columns: { name: string }[]; indexes: { columns: { name: string }[] }[] },
        indexes: IndexDiagnosticsInfo[],
    ): IndexSuggestion[] {
        const suggestions: IndexSuggestion[] = [];

        for (const index of indexes) {
            if (index.isUnused && !index.isPrimary) {
                suggestions.push({
                    type: "unused_index",
                    description: `Index ${index.name} has never been scanned - consider dropping`,
                    sql: `DROP INDEX ${index.name}`,
                    impact: "low",
                });
            }

            if (index.isDuplicate) {
                suggestions.push({
                    type: "duplicate_index",
                    description: `Index ${index.name} may duplicate another index`,
                    impact: "medium",
                });
            }
        }

        return suggestions;
    }
}