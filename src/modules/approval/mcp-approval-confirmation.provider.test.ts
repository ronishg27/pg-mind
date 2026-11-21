import { describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { McpApprovalConfirmationProvider } from "./mcp-approval-confirmation.provider.js";
import type { ApprovalRequest } from "./approval.types.js";

describe("McpApprovalConfirmationProvider", () => {
    const request: ApprovalRequest = {
        id: "test-approval-id",
        sql: "UPDATE products SET price = 500 WHERE id = 1",
        operation: "UPDATE",
        database: "querymind_dev",
        status: "pending",
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 300_000),
    };

    function createProvider(response: unknown) {
        const elicitInput = vi.fn().mockResolvedValue(response);

        const server = {
            server: { elicitInput },
        } as unknown as McpServer;

        return {
            provider: new McpApprovalConfirmationProvider(server),
            elicitInput,
        };
    }

    const input = {
        request,
        summary: "Updates the price of product with ID 1.",
    };

    it("should approve when the user explicitly approves", async () => {
        const { provider } = createProvider({
            action: "accept",
            content: { decision: "approve" },
        });

        await expect(provider.confirm(input)).resolves.toBe("approve");
    });

    it("should reject when the user explicitly rejects", async () => {
        const { provider } = createProvider({
            action: "accept",
            content: { decision: "reject" },
        });

        await expect(provider.confirm(input)).resolves.toBe("reject");
    });

    it("should reject when elicitation is declined", async () => {
        const { provider } = createProvider({
            action: "decline",
        });

        await expect(provider.confirm(input)).resolves.toBe("reject");
    });

    it("should cancel when the user cancels", async () => {
        const { provider } = createProvider({
            action: "cancel",
        });

        await expect(provider.confirm(input)).resolves.toBe("cancel");
    });

    it("should cancel when the response is incomplete", async () => {
        const { provider } = createProvider({
            action: "accept",
            content: {},
        });

        await expect(provider.confirm(input)).resolves.toBe("cancel");
    });

    it("should propagate elicitation errors", async () => {
        const { provider } = createProvider(
            Promise.reject(new Error("Elicitation unavailable")),
        );

        await expect(provider.confirm(input)).rejects.toThrow(
            "Elicitation unavailable",
        );
    });

    it("should display the complete SQL and summary", async () => {
        const { provider, elicitInput } = createProvider({
            action: "cancel",
        });

        await provider.confirm(input);

        const params = elicitInput.mock.calls[0][0];

        expect(params.message).toContain(input.summary);
        expect(params.message).toContain(request.database);
        expect(params.message).toContain(request.operation);
        expect(params.message).toContain(request.sql);
    });
});
