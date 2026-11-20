import { DatabaseService } from "./modules/database/database.service.js";
import { SqlValidator } from "./modules/query/sql-validator.js";
import { QueryService } from "./modules/query/query.service.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

process.loadEnvFile(".env");
const connectionString = process.env.QUERY_DATABASE_URL;
if (!connectionString) {
    throw new Error("QUERY_DATABASE_URL is not configured");
}

const database = new DatabaseService(connectionString);
const validator = new SqlValidator();
const queryService = new QueryService(database, validator);

const server = new McpServer({
    name: "querymind",
    version: "1.0.0",
});

// first tool ping
server.registerTool(
    "ping",
    {
        description: "Check whether the QueryMind MCP server is running.",
        inputSchema: z.object({
            message: z.string().optional(),
        }),
    },
    async ({ message }) => ({
        content: [
            {
                type: "text",
                text: message
                    ? `QueryMind is running. Message Received: ${message}`
                    : "QueryMind is running. Pong!",
            },
        ],
    }),
);

server.registerTool(
    "execute_query",
    {
        description:
            "Execute a read-only SQL query against the connected PostgreSQL database.",
        inputSchema: z.object({
            sql: z
                .string()
                .min(1, "SQL query cannot be empty")
                .max(
                    50_000,
                    "SQL query exceeds the maximum length of 50,000 characters",
                ),
        }),
    },
    async ({ sql }) => {
        try {
            const result = await queryService.executeQuery(sql);
            return {
                content: [
                    {
                        type: "text" as const,
                        text: JSON.stringify(result, null, 2),
                    },
                ],
            };
        } catch (error) {
            return {
                isError: true,
                content: [
                    {
                        type: "text" as const,
                        text:
                            error instanceof Error
                                ? error.message
                                : "An unknown error occurred",
                    },
                ],
            };
        }
    },
);

async function main() {
    const transport = new StdioServerTransport();
    try {
        await server.connect(transport);

        console.error(
            "QueryMind MCP server is running. Waiting for requests...",
        );
    } catch (error) {
        await database.close();
        throw error;
    }
}

let isShuttingDown = false;

async function shutdown() {
    if (isShuttingDown) {
        return;
    }
    isShuttingDown = true;
    console.error("Shutting down QueryMind MCP server...");
    try {
        await server.close();
    } catch (error) {
        console.error("Error closing MCP server :", error);
    }

    try {
        await database.close();
        console.error("Database connection pool closed.");
    } catch (error) {
        console.error("Error closing database connection pool:", error);
    }

    process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

main().catch(async (err) => {
    console.error("Error starting QueryMind MCP server:", err);
    await database.close();
    process.exit(1);
});
