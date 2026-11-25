import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApprovalService } from "./approval.service.js";

describe("ApprovalService", () => {
    let service: ApprovalService;
    let approvalStore: any;
    let classifier: any;
    let databaseService: any;

    beforeEach(() => {
        approvalStore = {
            create: vi.fn().mockReturnValue({
                id: "test-approval-id",
                status: "pending",
            }),
        };

        classifier = {
            classify: vi.fn(),
        };

        databaseService = {
            query: vi.fn().mockResolvedValue([{ database: "pgmind_dev" }]),
        };

        service = new ApprovalService(
            approvalStore,
            classifier,
            databaseService,
        );
    });

    describe("prepareOperation", () => {
        it("should create an approval request for a supported write operation", async () => {
            const sql = "UPDATE users SET status = 'active'";

            classifier.classify.mockReturnValue({
                operation: "UPDATE",
                category: "write",
                requiresApproval: true,
            });

            const result = await service.prepareOperation(sql);

            expect(result.id).toBe("test-approval-id");

            expect(approvalStore.create).toHaveBeenCalledWith({
                sql,
                operation: "UPDATE",
                database: "pgmind_dev",
            });
        });

        it("should reject read operations", async () => {
            classifier.classify.mockReturnValue({
                operation: "SELECT",
                category: "read",
                requiresApproval: false,
            });

            await expect(
                service.prepareOperation("SELECT * FROM users"),
            ).rejects.toThrow(
                "Only supported write operations can be prepared for approval.",
            );

            expect(approvalStore.create).not.toHaveBeenCalled();
        });

        it("should reject unknown operations", async () => {
            classifier.classify.mockReturnValue({
                operation: "OTHER",
                category: "unknown",
                requiresApproval: true,
            });

            await expect(
                service.prepareOperation("EXPLAIN SELECT * FROM users"),
            ).rejects.toThrow(
                "Only supported write operations can be prepared for approval.",
            );
        });

        it("should reject when the database cannot be identified", async () => {
            classifier.classify.mockReturnValue({
                operation: "DELETE",
                category: "write",
                requiresApproval: true,
            });

            databaseService.query.mockResolvedValue([]);

            await expect(
                service.prepareOperation("DELETE FROM users"),
            ).rejects.toThrow("Unable to identify the current database.");

            expect(approvalStore.create).not.toHaveBeenCalled();
        });
    });

    describe("getApproval", () => {
        it("should return an existing approval request", () => {
            const request = {
                id: "test-approval-id",
                status: "pending",
            };

            approvalStore.getById = vi.fn().mockReturnValue(request);

            const result = service.getApproval(request.id);

            expect(result).toEqual(request);
            expect(approvalStore.getById).toHaveBeenCalledWith(request.id);
        });

        it("should throw when the request does not exist", () => {
            approvalStore.getById = vi.fn().mockReturnValue(undefined);

            expect(() => service.getApproval("unknown-id")).toThrow(
                "Approval request not found.",
            );
        });
    });

    describe("approveOperation", () => {
        it("should approve a pending request", () => {
            const approvedRequest = {
                id: "test-approval-id",
                status: "approved",
            };

            approvalStore.updateStatus = vi
                .fn()
                .mockReturnValue(approvedRequest);

            const result = service.approveOperation("test-approval-id");

            expect(result).toEqual(approvedRequest);
            expect(approvalStore.updateStatus).toHaveBeenCalledWith(
                "test-approval-id",
                "approved",
            );
        });

        it("should propagate errors from the store", () => {
            approvalStore.updateStatus = vi.fn().mockImplementation(() => {
                throw new Error("Invalid status transition");
            });

            expect(() => service.approveOperation("test-approval-id")).toThrow(
                "Invalid status transition",
            );
        });
    });

    describe("rejectOperation", () => {
        it("should reject a pending request", () => {
            const rejectedRequest = {
                id: "test-approval-id",
                status: "rejected",
            };

            approvalStore.updateStatus = vi
                .fn()
                .mockReturnValue(rejectedRequest);

            const result = service.rejectOperation("test-approval-id");

            expect(result).toEqual(rejectedRequest);
            expect(approvalStore.updateStatus).toHaveBeenCalledWith(
                "test-approval-id",
                "rejected",
            );
        });

        it("should propagate errors from the store", () => {
            approvalStore.updateStatus = vi.fn().mockImplementation(() => {
                throw new Error("Invalid status transition");
            });

            expect(() => service.rejectOperation("test-approval-id")).toThrow(
                "Invalid status transition",
            );
        });
    });
});
