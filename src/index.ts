import { McpServer } from "@modelcontextprotocol/sdk/server/mcp";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio";
import { z } from "zod";
// import { process } from "node:process";

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

async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);

    console.error("QueryMind MCP server is running. Waiting for requests...");
}

main().catch((err) => {
    console.error("Error starting QueryMind MCP server:", err);
    process.exit(1);
});
