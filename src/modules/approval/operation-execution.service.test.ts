import { beforeEach, describe, expect, it, vi } from "vitest";

import { DatabaseService } from "../database/database.service.js";
import { SqlOperationClassifier } from "../query/sql-operation-classifier.js";
import { WriteSqlValidator } from "../query/write-sql-validator.js";
import { ApprovalStore } from "./approval.store.js";
import { OperationExecutionService } from "./operation-execution.service.js";
import { CommitOutcomeUnknownError } from "../database/database.service.js";

describe("OperationExecutionService", () => {
    let store: ApprovalStore;
    let database: {
        withWriteTransaction: ReturnType<typeof vi.fn>;
    };
    let service: OperationExecutionService;

    beforeEach(() => {
        store = new ApprovalStore();

        database = {
            withWriteTransaction: vi.fn(),
        };

        service = new OperationExecutionService(
            store,
            new WriteSqlValidator(new SqlOperationClassifier()),
            new SqlOperationClassifier(),
            database as unknown as DatabaseService,
        );
    });

    function createApprovedRequest(
        sql = "UPDATE products SET price = 500 WHERE id = 1",
        operation: "INSERT" | "UPDATE" | "DELETE" = "UPDATE",
    ) {
        const request = store.create({
            sql,
            operation,
            database: "querymind_dev",
        });

        store.updateStatus(request.id, "approved");

        return request;
    }

    it("should execute an approved operation", async () => {
        const request = createApprovedRequest();

        database.withWriteTransaction.mockImplementation(
            async (
                databaseName: string,
                callback: (client: unknown) => Promise<number>,
            ) => {
                expect(databaseName).toBe("querymind_dev");

                return callback({
                    query: vi.fn().mockResolvedValue({
                        rowCount: 1,
                    }),
                });
            },
        );

        const result = await service.executeOperation(request.id);

        expect(result).toEqual({
            approvalId: request.id,
            operation: "UPDATE",
            database: "querymind_dev",
            affectedRows: 1,
            status: "executed",
        });

        expect(store.getById(request.id)?.status).toBe("executed");
    });

    it("should mark a failed operation as failed", async () => {
        const request = createApprovedRequest();

        database.withWriteTransaction.mockRejectedValue(
            new Error("Database execution failed"),
        );

        await expect(service.executeOperation(request.id)).rejects.toThrow(
            "Database execution failed",
        );

        expect(store.getById(request.id)?.status).toBe("failed");
    });

    it("should reject execution when approval is missing", async () => {
        await expect(service.executeOperation("missing-id")).rejects.toThrow(
            "not found",
        );

        expect(database.withWriteTransaction).not.toHaveBeenCalled();
    });

    it("should reject execution when approval is not approved", async () => {
        const request = store.create({
            sql: "UPDATE products SET price = 500 WHERE id = 1",
            operation: "UPDATE",
            database: "querymind_dev",
        });

        await expect(service.executeOperation(request.id)).rejects.toThrow(
            "not approved",
        );

        expect(database.withWriteTransaction).not.toHaveBeenCalled();
    });

    it("should not execute the same approval twice", async () => {
        const request = createApprovedRequest();

        database.withWriteTransaction.mockImplementation(
            async (
                _databaseName: string,
                callback: (client: unknown) => Promise<number>,
            ) => {
                return callback({
                    query: vi.fn().mockResolvedValue({
                        rowCount: 1,
                    }),
                });
            },
        );

        await service.executeOperation(request.id);

        await expect(service.executeOperation(request.id)).rejects.toThrow(
            "not approved",
        );

        expect(database.withWriteTransaction).toHaveBeenCalledTimes(1);
    });

    it("should reject unsupported operations", async () => {
        const request = createApprovedRequest(
            "CREATE TABLE test_table (id INTEGER)",
            "UPDATE",
        );

        await expect(service.executeOperation(request.id)).rejects.toThrow();

        expect(store.getById(request.id)?.status).toBe("approved");
        expect(database.withWriteTransaction).not.toHaveBeenCalled();
    });

    it("should mark an operation as execution_unknown when commit outcome is uncertain", async () => {
        const request = createApprovedRequest();

        database.withWriteTransaction.mockRejectedValue(
            new CommitOutcomeUnknownError(
                new Error("Connection lost during COMMIT"),
            ),
        );

        await expect(service.executeOperation(request.id)).rejects.toThrow(
            CommitOutcomeUnknownError,
        );

        expect(store.getById(request.id)?.status).toBe("execution_unknown");
    });

    it("should not retry an operation with an uncertain execution outcome", async () => {
        const request = createApprovedRequest();

        database.withWriteTransaction.mockRejectedValue(
            new CommitOutcomeUnknownError(
                new Error("Connection lost during COMMIT"),
            ),
        );

        await expect(service.executeOperation(request.id)).rejects.toThrow();

        await expect(service.executeOperation(request.id)).rejects.toThrow(
            "not approved",
        );

        expect(database.withWriteTransaction).toHaveBeenCalledTimes(1);
    });
});
