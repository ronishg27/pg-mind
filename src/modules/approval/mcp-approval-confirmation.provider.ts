import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type {
    ApprovalConfirmationInput,
    ApprovalConfirmationProvider,
    ApprovalDecision,
} from "./approval-confirmation.js";

export class McpApprovalConfirmationProvider implements ApprovalConfirmationProvider {
    constructor(private readonly server: McpServer) {}

    async confirm(input: ApprovalConfirmationInput): Promise<ApprovalDecision> {
        const { request, summary } = input;

        const result = await this.server.server.elicitInput({
            mode: "form",
            message: [
                "Review this database operation carefully.",
                "",
                `Operation: ${request.operation}`,
                `Database: ${request.database}`,
                `Summary: ${summary}`,
                "",
                "Complete SQL statement:",
                request.sql,
                "",
                "Approve only if you understand and authorize this exact operation.",
            ].join("\n"),
            requestedSchema: {
                type: "object",
                properties: {
                    decision: {
                        type: "string",
                        title: "Approval decision",
                        description:
                            "Choose whether to authorize this operation.",
                        enum: ["approve", "reject"],
                        enumNames: ["Approve", "Reject"],
                    },
                },
                required: ["decision"],
            },
        });

        if (result.action === "cancel") {
            return "cancel";
        }

        if (result.action === "decline") {
            return "reject";
        }

        if (result.action === "accept") {
            const decision = result.content?.decision;

            if (decision === "approve") {
                return "approve";
            }

            if (decision === "reject") {
                return "reject";
            }
        }

        // Unknown or incomplete responses must never authorize execution.
        return "cancel";
    }
}
