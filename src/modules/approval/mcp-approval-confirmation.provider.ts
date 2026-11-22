import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type {
    ApprovalConfirmationInput,
    ApprovalConfirmationProvider,
    ApprovalDecision,
} from "./approval-confirmation.js";

type Severity = "low" | "medium" | "high";

interface OperationInfo {
    explanation: string;
    severity: Severity;
    destructiveWarning?: string;
}

const OPERATIONS: Record<string, OperationInfo> = {
    INSERT: {
        severity: "low",
        explanation: "Adds new records to the database.",
    },
    CREATE: { severity: "low", explanation: "Creates a new database object." },
    UPDATE: {
        severity: "medium",
        explanation:
            "Modifies existing records. Verify that the conditions target the intended records.",
    },
    ALTER: {
        severity: "medium",
        explanation:
            "Changes the structure or configuration of an existing database object.",
    },
    DELETE: {
        severity: "high",
        explanation: "Removes records matching the SQL conditions.",
    },
    DROP: {
        severity: "high",
        explanation:
            "Removes a database object. Review the target carefully before proceeding.",
        destructiveWarning:
            "Destructive operation — removes the specified database object.",
    },
    TRUNCATE: {
        severity: "high",
        explanation:
            "Removes all rows from the specified table. Review the target table carefully.",
        destructiveWarning:
            "Destructive operation — removes all rows from the specified table.",
    },
};

const FALLBACK: OperationInfo = {
    severity: "medium",
    explanation: "Performs a database write operation.",
};

const SEVERITY_EMOJI: Record<Severity, string> = {
    low: "🟢",
    medium: "🟡",
    high: "🔴",
};

const SEVERITY_LABEL: Record<Severity, string> = {
    low: "LOW RISK",
    medium: "MODERATE RISK",
    high: "HIGH RISK",
};

// Prefix each SQL line with a simple gutter so the statement reads as a block.
function formatSql(sql: string): string {
    return sql
        .trim()
        .split("\n")
        .map((line) => `│ ${line}`)
        .join("\n");
}

function buildMessage(input: ApprovalConfirmationInput): string {
    const { request, summary } = input;
    const info = OPERATIONS[request.operation] ?? FALLBACK;
    const emoji = SEVERITY_EMOJI[info.severity];
    const label = SEVERITY_LABEL[info.severity];

    return [
        "QueryMind — Approval Required",
        "────────────────────────────────────────────────────────",
        "",
        `${emoji} ${label}  ·  ${request.operation}`,
        info.destructiveWarning ? info.destructiveWarning : "",
        info.explanation,
        "",
        "────────────────────────────────────────────────────────",
        `🗄️  Database : ${request.database}`,
        `📝 Summary  : ${summary}`,
        "────────────────────────────────────────────────────────",
        "",
        "📜 Exact SQL to be executed:",
        formatSql(request.sql),
        "",
        "────────────────────────────────────────────────────────",
        "Your options",
        `  ✅ Approve → the SQL above is executed`,
        `  ❌ Reject → cancelled, no changes made`,
        "────────────────────────────────────────────────────────",
        "",
        "Approving authorizes this EXACT statement. Approve only if you understand it.",
    ]
        .filter((line, i, arr) => !(line === "" && arr[i - 1] === ""))
        .join("\n");
}

export class McpApprovalConfirmationProvider implements ApprovalConfirmationProvider {
    constructor(private readonly server: McpServer) {}

    async confirm(input: ApprovalConfirmationInput): Promise<ApprovalDecision> {
        const { request } = input;

        const result = await this.server.server.elicitInput({
            mode: "form",
            message: buildMessage(input),
            requestedSchema: {
                type: "object",
                properties: {
                    decision: {
                        type: "string",
                        title: "Approval decision",
                        description:
                            "Choose whether to authorize this database operation.",
                        oneOf: [
                            {
                                const: "approve",
                                title: "✅ Approve and execute",
                            },
                            { const: "reject", title: "❌ Reject operation" },
                        ],
                        default: "reject",
                    },
                },
                required: ["decision"],
            },
        });

        if (result.action === "cancel") return "cancel";
        if (result.action === "decline") return "reject";

        if (result.action === "accept") {
            const decision = result.content?.decision;

            if (decision === "reject") return "reject";

            if (decision === "approve") {
                return "approve";
            }
        }

        // Unknown or incomplete responses must never authorize execution.
        return "cancel";
    }
}
