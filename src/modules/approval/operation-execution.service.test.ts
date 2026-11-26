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
        operation:
            | "SELECT"
            | "INSERT"
            | "UPDATE"
            | "DELETE"
            | "CREATE"
            | "ALTER"
            | "DROP"
            | "TRUNCATE" = "UPDATE",
    ) {
        const request = store.create({
            sql,
            operation,
            database: "pgmind_dev",
        });

        store.updateStatus(request.id, "approved");

        return request;
    }

    it("should execute an approved operation", async () => {
        const request = createApprovedRequest();

        database.withWriteTransaction.mockImplementation(
            async (callback: (client: unknown) => Promise<number>) => {
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
            database: "pgmind_dev",
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
            database: "pgmind_dev",
        });

        await expect(service.executeOperation(request.id)).rejects.toThrow(
            "not approved",
        );

        expect(database.withWriteTransaction).not.toHaveBeenCalled();
    });

    it("should not execute the same approval twice", async () => {
        const request = createApprovedRequest();

        database.withWriteTransaction.mockImplementation(
            async (callback: (client: unknown) => Promise<number>) => {
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

    describe("Allowed preparation for supported operations", () => {
        const cases = [
            ["INSERT", "INSERT INTO products (name, price) VALUES ('Keyboard', 100)"],
            ["UPDATE", "UPDATE products SET price = 500 WHERE id = 1"],
            ["DELETE", "DELETE FROM products WHERE id = 1"],
            ["CREATE", "CREATE TABLE test_table (id INTEGER)"],
            ["CREATE", "CREATE INDEX idx_products_name ON products(name)"],
            ["CREATE", "CREATE SCHEMA myschema"],
            ["ALTER", "ALTER TABLE products ADD COLUMN description TEXT"],
            ["ALTER", "ALTER INDEX idx_products_name RENAME TO idx_new"],
            ["DROP", "DROP TABLE test_table"],
            ["DROP", "DROP INDEX idx_products_name"],
            ["TRUNCATE", "TRUNCATE TABLE products"],
        ] as const;

        it.each(cases)(
            "should prepare %s operation for execution",
            async (operation, sql) => {
                const request = createApprovedRequest(sql, operation);

                database.withWriteTransaction.mockImplementation(
                    async (callback: (client: unknown) => Promise<number>) => {
                        return callback({
                            query: vi.fn().mockResolvedValue({
                                rowCount: 0,
                            }),
                        });
                    },
                );

                await expect(
                    service.executeOperation(request.id),
                ).resolves.toMatchObject({
                    approvalId: request.id,
                    operation,
                    database: "pgmind_dev",
                    status: "executed",
                });

                expect(store.getById(request.id)?.status).toBe("executed");
            },
        );
    });

    describe("Rejected preparation", () => {
        it("should reject SELECT (unsupported for execution)", async () => {
            const request = createApprovedRequest(
                "SELECT * FROM products",
                "SELECT",
            );

            await expect(service.executeOperation(request.id)).rejects.toThrow(
                "SQL validation failed",
            );

            expect(store.getById(request.id)?.status).toBe("approved");
            expect(database.withWriteTransaction).not.toHaveBeenCalled();
        });

        it("should reject CREATE FUNCTION (unsupported DDL)", async () => {
            const request = createApprovedRequest(
                "CREATE FUNCTION add_one(integer) RETURNS integer LANGUAGE sql AS 'SELECT $1 + 1'",
                "CREATE",
            );

            await expect(service.executeOperation(request.id)).rejects.toThrow();

            expect(store.getById(request.id)?.status).toBe("approved");
            expect(database.withWriteTransaction).not.toHaveBeenCalled();
        });

        it("should reject DROP TYPE (unsupported DDL)", async () => {
            const request = createApprovedRequest(
                "DROP TYPE mood",
                "DROP",
            );

            await expect(service.executeOperation(request.id)).rejects.toThrow();

            expect(store.getById(request.id)?.status).toBe("approved");
            expect(database.withWriteTransaction).not.toHaveBeenCalled();
        });

        it("should reject SQL whose classification differs from stored operation", async () => {
            const request = createApprovedRequest(
                "UPDATE products SET price = 500 WHERE id = 1",
                "DELETE",
            );

            await expect(service.executeOperation(request.id)).rejects.toThrow(
                "Operation mismatch",
            );

            expect(store.getById(request.id)?.status).toBe("approved");
            expect(database.withWriteTransaction).not.toHaveBeenCalled();
        });

        it("should reject invalid SQL", async () => {
            const request = createApprovedRequest(
                "UPDATE SET price = 100",
                "UPDATE",
            );

            await expect(service.executeOperation(request.id)).rejects.toThrow(
                "SQL validation failed",
            );

            expect(store.getById(request.id)?.status).toBe("approved");
            expect(database.withWriteTransaction).not.toHaveBeenCalled();
        });

        it("should reject reusing an approval ID that is no longer approved", async () => {
            const request = createApprovedRequest();

            database.withWriteTransaction.mockImplementation(
                async (callback: (client: unknown) => Promise<number>) => {
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

            expect(store.getById(request.id)?.status).toBe("executed");
            expect(database.withWriteTransaction).toHaveBeenCalledTimes(1);
        });
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