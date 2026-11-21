
import { describe, expect, it, vi } from "vitest";

import { ApprovalWorkflowService } from "./approval-workflow.service.js";
import type { ApprovalService } from "./approval.service.js";
import type { ApprovalConfirmationProvider } from "./approval-confirmation.js";
import type { ApprovalRequest } from "./approval.types.js";

describe("ApprovalWorkflowService", () => {
    const request: ApprovalRequest = {
        id: "approval-123",
        sql: "UPDATE products SET price = 500 WHERE id = 1",
        operation: "UPDATE",
        database: "querymind_dev",
        status: "pending",
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 300_000),
    };

    function createWorkflow(decision: string) {
        const approvalService = {
            prepareOperation: vi.fn().mockResolvedValue(request),
            approveOperation: vi.fn().mockResolvedValue({
                ...request,
                status: "approved",
            }),
            rejectOperation: vi.fn().mockResolvedValue({
                ...request,
                status: "rejected",
            }),
        };

        const confirmationProvider = {
            confirm: vi.fn().mockResolvedValue(decision),
        };

        const workflow = new ApprovalWorkflowService(
            approvalService as unknown as ApprovalService,
            confirmationProvider as ApprovalConfirmationProvider,
        );

        return { workflow, approvalService, confirmationProvider };
    }

    it("should approve an explicitly approved operation", async () => {
        const { workflow, approvalService } = createWorkflow("approve");

        const result = await workflow.prepareAndConfirm(request.sql);

        expect(result.status).toBe("approved");
        expect(approvalService.approveOperation).toHaveBeenCalledWith(
            request.id,
        );
        expect(approvalService.rejectOperation).not.toHaveBeenCalled();
    });

    it("should reject a rejected operation", async () => {
        const { workflow, approvalService } = createWorkflow("reject");

        const result = await workflow.prepareAndConfirm(request.sql);

        expect(result.status).toBe("rejected");
        expect(approvalService.rejectOperation).toHaveBeenCalledWith(
            request.id,
        );
        expect(approvalService.approveOperation).not.toHaveBeenCalled();
    });

    it("should reject a cancelled operation", async () => {
        const { workflow, approvalService } = createWorkflow("cancel");

        const result = await workflow.prepareAndConfirm(request.sql);

        expect(result.status).toBe("rejected");
        expect(approvalService.rejectOperation).toHaveBeenCalledWith(
            request.id,
        );
        expect(approvalService.approveOperation).not.toHaveBeenCalled();
    });

    it("should reject the operation if confirmation fails", async () => {
        const { workflow, approvalService, confirmationProvider } =
            createWorkflow("approve");

        vi.mocked(confirmationProvider.confirm).mockRejectedValue(
            new Error("Elicitation unavailable"),
        );

        const result = await workflow.prepareAndConfirm(request.sql);

        expect(result.status).toBe("rejected");
        expect(approvalService.rejectOperation).toHaveBeenCalledWith(
            request.id,
        );
        expect(approvalService.approveOperation).not.toHaveBeenCalled();
    });

    it("should propagate preparation errors without requesting confirmation", async () => {
        const { workflow, approvalService, confirmationProvider } =
            createWorkflow("approve");

        vi.mocked(approvalService.prepareOperation).mockRejectedValue(
            new Error("Unsupported SQL"),
        );

        await expect(
            workflow.prepareAndConfirm("INVALID SQL"),
        ).rejects.toThrow("Unsupported SQL");

        expect(confirmationProvider.confirm).not.toHaveBeenCalled();
    });

    it("should not execute SQL after approval", async () => {
        const { workflow, approvalService } = createWorkflow("approve");

        const result = await workflow.prepareAndConfirm(request.sql);

        expect(result.message).toContain("not been executed");
        expect(approvalService.approveOperation).toHaveBeenCalledOnce();
    });
});
