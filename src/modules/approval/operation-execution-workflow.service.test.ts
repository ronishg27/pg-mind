import { describe, expect, it, vi } from "vitest";

import type { OperationExecutionService } from "./operation-execution.service.js";
import { OperationExecutionWorkflowService } from "./operation-execution-workflow.service.js";

describe("OperationExecutionWorkflowService", () => {
    it("should return the execution result", async () => {
        const executionService = {
            executeOperation: vi.fn().mockResolvedValue({
                approvalId: "approval-123",
                operation: "UPDATE",
                database: "pgmind_dev",
                affectedRows: 2,
                status: "executed",
            }),
        };

        const workflow = new OperationExecutionWorkflowService(
            executionService as unknown as OperationExecutionService,
        );

        const result = await workflow.execute("approval-123");

        expect(executionService.executeOperation).toHaveBeenCalledWith(
            "approval-123",
            undefined,
        );

        expect(result).toEqual({
            approvalId: "approval-123",
            operation: "UPDATE",
            database: "pgmind_dev",
            affectedRows: 2,
            status: "executed",
            message: "UPDATE operation executed successfully.",
        });
    });

    it("should propagate execution errors", async () => {
        const executionService = {
            executeOperation: vi
                .fn()
                .mockRejectedValue(new Error("Operation is not approved.")),
        };

        const workflow = new OperationExecutionWorkflowService(
            executionService as unknown as OperationExecutionService,
        );

        await expect(workflow.execute("approval-123")).rejects.toThrow(
            "Operation is not approved.",
        );
    });
});
