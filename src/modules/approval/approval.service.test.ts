import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApprovalService } from "./approval.service.js";
import { SqlAnalysisService } from "../query/sql-analysis.service.js";

describe("ApprovalService", () => {
    let service: ApprovalService;
    let approvalStore: any;
    let classifier: any;
    let analysisService: any;
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

        analysisService = {
            analyzeWrite: vi.fn(),
        };

        databaseService = {
            query: vi.fn().mockResolvedValue([{ database: "pgmind_dev" }]),
        };

        service = new ApprovalService(
            approvalStore,
            classifier,
            analysisService,
            databaseService,
        );
    });

    describe("prepareOperation", () => {
        it("should create an approval request for a supported write operation", async () => {
            const sql = "UPDATE users SET status = 'active'";

            analysisService.analyzeWrite.mockReturnValue({
                operation: "UPDATE",
                category: "write",
                isSupported: true,
                validationErrors: [],
                requiresApproval: true,
                statementCount: 1,
                statementType: "update",
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
            analysisService.analyzeWrite.mockReturnValue({
                operation: "SELECT",
                category: "read",
                isSupported: false,
                validationErrors: ["Only write operations are allowed"],
                requiresApproval: false,
                statementCount: 1,
                statementType: "select",
            });

            await expect(
                service.prepareOperation("SELECT * FROM users"),
            ).rejects.toThrow(
                "Unsupported write operation: Only write operations are allowed",
            );

            expect(approvalStore.create).not.toHaveBeenCalled();
        });

        it("should reject unknown operations", async () => {
            analysisService.analyzeWrite.mockReturnValue({
                operation: "OTHER",
                category: "unknown",
                isSupported: false,
                validationErrors: ["Operation OTHER is not supported"],
                requiresApproval: true,
                statementCount: 1,
                statementType: "explain",
            });

            await expect(
                service.prepareOperation("EXPLAIN SELECT * FROM users"),
            ).rejects.toThrow(
                "Unsupported write operation: Operation OTHER is not supported",
            );
        });

        it("should reject when the database cannot be identified", async () => {
            analysisService.analyzeWrite.mockReturnValue({
                operation: "DELETE",
                category: "write",
                isSupported: true,
                validationErrors: [],
                requiresApproval: true,
                statementCount: 1,
                statementType: "delete",
            });

            databaseService.query.mockResolvedValue([]);

            await expect(
                service.prepareOperation("DELETE FROM users"),
            ).rejects.toThrow("Unable to identify the current database.");

            expect(approvalStore.create).not.toHaveBeenCalled();
        });

        it("should include connectionName in the approval request when supplied", async () => {
            const sql = "UPDATE users SET status = 'active'";

            analysisService.analyzeWrite.mockReturnValue({
                operation: "UPDATE",
                category: "write",
                isSupported: true,
                validationErrors: [],
                requiresApproval: true,
                statementCount: 1,
                statementType: "update",
            });

            const result = await service.prepareOperation(sql, "supergen");

            expect(result.id).toBe("test-approval-id");

            expect(approvalStore.create).toHaveBeenCalledWith({
                sql,
                operation: "UPDATE",
                database: "pgmind_dev",
                connectionName: "supergen",
            });
        });

        it("should omit connectionName from the approval request when not supplied", async () => {
            const sql = "UPDATE users SET status = 'active'";

            analysisService.analyzeWrite.mockReturnValue({
                operation: "UPDATE",
                category: "write",
                isSupported: true,
                validationErrors: [],
                requiresApproval: true,
                statementCount: 1,
                statementType: "update",
            });

            const result = await service.prepareOperation(sql);

            expect(result.id).toBe("test-approval-id");

            expect(approvalStore.create).toHaveBeenCalledWith({
                sql,
                operation: "UPDATE",
                database: "pgmind_dev",
                connectionName: undefined,
            });
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
