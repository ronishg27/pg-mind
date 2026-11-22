import { describe, expect, it, vi } from "vitest";

import { DatabaseService } from "../database/database.service.js";
import { SqlOperationClassifier } from "./sql-operation-classifier.js";
import { WriteSqlValidator } from "./write-sql-validator.js";
import { ApprovalStore } from "../approval/approval.store.js";
import { OperationExecutionService } from "../approval/operation-execution.service.js";

// Each entry: [label, example SQL, expected broad operation]
// When adding a new supported operation, add it here with its SQL example
// and the broad operation category it maps to.
const SUPPORTED_WRITE_OPERATIONS = [
    ["INSERT", "INSERT INTO products (name, price) VALUES ('Keyboard', 100)", "INSERT"],
    ["UPDATE", "UPDATE products SET price = 500 WHERE id = 1", "UPDATE"],
    ["DELETE", "DELETE FROM products WHERE id = 1", "DELETE"],
    ["CREATE TABLE", "CREATE TABLE test_table (id INTEGER)", "CREATE"],
    ["CREATE INDEX", "CREATE INDEX idx_products_name ON products(name)", "CREATE"],
    ["CREATE SCHEMA", "CREATE SCHEMA myschema", "CREATE"],
    ["CREATE VIEW", "CREATE VIEW active_products AS SELECT * FROM products", "CREATE"],
    ["ALTER TABLE", "ALTER TABLE products ADD COLUMN description TEXT", "ALTER"],
    ["ALTER INDEX", "ALTER INDEX idx_products_name RENAME TO idx_new", "ALTER"],
    ["DROP TABLE", "DROP TABLE test_table", "DROP"],
    ["DROP INDEX", "DROP INDEX idx_products_name", "DROP"],
    ["TRUNCATE TABLE", "TRUNCATE TABLE products", "TRUNCATE"],
] as const;

// DDL types the parser can handle but that must remain rejected everywhere.
const UNSUPPORTED_DDL_OPERATIONS = [
    "CREATE TYPE mood AS ENUM ('sad', 'ok', 'happy')",
    "CREATE FUNCTION add_one(integer) RETURNS integer LANGUAGE sql AS 'SELECT $1 + 1'",
    "ALTER SEQUENCE myseq RESTART WITH 10",
    "DROP TYPE mood",
    "DROP SCHEMA myschema",
    "DROP VIEW active_products",
    "GRANT SELECT ON products TO public",
    "REVOKE INSERT ON products FROM public",
    "VACUUM products",
    "ANALYZE products",
    "EXPLAIN SELECT * FROM products",
] as const;

const EXECUTION_ALLOWLIST = [
    "INSERT",
    "UPDATE",
    "DELETE",
    "CREATE",
    "ALTER",
    "DROP",
    "TRUNCATE",
] as const;

describe("Write operation coverage across layers", () => {
    const classifier = new SqlOperationClassifier();
    const validator = new WriteSqlValidator(classifier);
    const store = new ApprovalStore();
    const database = {
        withWriteTransaction: vi.fn(),
    } as unknown as DatabaseService;
    const service = new OperationExecutionService(
        store,
        validator,
        classifier,
        database,
    );

    describe("Supported write operations", () => {
        it.each(SUPPORTED_WRITE_OPERATIONS)(
            "classifies %s, validates it, and allows execution",
            (_label, sql, expectedOperation) => {
                // Layer 1: classifier
                const classification = classifier.classify(sql);
                expect(classification.category).toBe("write");
                expect(classification.operation).toBe(expectedOperation);
                expect(classification.requiresApproval).toBe(true);

                // Layer 2: validator
                const validation = validator.validate(sql);
                expect(validation.valid).toBe(true);

                // Layer 3: execution service allowlist
                const request = store.create({
                    sql,
                    operation: expectedOperation,
                    database: "querymind_dev",
                });
                store.updateStatus(request.id, "approved");

                const execution = service.prepareExecution(request.id);
                expect(execution.approvalId).toBe(request.id);
                expect(execution.operation).toBe(expectedOperation);
            },
        );

        it("covers every broad operation in the execution allowlist", () => {
            const coveredOperations = new Set(
                SUPPORTED_WRITE_OPERATIONS.map(([, , op]) => op),
            );
            for (const op of EXECUTION_ALLOWLIST) {
                expect(coveredOperations.has(op)).toBe(true);
            }
        });
    });

    describe("Unsupported DDL operations", () => {
        it.each(UNSUPPORTED_DDL_OPERATIONS)(
            "rejects %s at the validator layer",
            (sql) => {
                const validation = validator.validate(sql);
                expect(validation.valid).toBe(false);
            },
        );

        it.each(UNSUPPORTED_DDL_OPERATIONS)(
            "rejects %s at the execution service layer",
            (sql) => {
                // Validator runs first inside prepareExecution, so it must reject.
                const request = store.create({
                    sql,
                    operation: "OTHER",
                    database: "querymind_dev",
                });
                store.updateStatus(request.id, "approved");

                expect(() => service.prepareExecution(request.id)).toThrow(
                    /SQL validation failed|Operation .* is not supported|Expected exactly one/,
                );
            },
        );
    });

    describe("CTE edge cases", () => {
        it("should reject a data-modifying CTE with a read-only final SELECT", () => {
            const sql = `WITH deleted AS (
                DELETE FROM products WHERE id = 1 RETURNING *
            )
            SELECT * FROM deleted`;

            // Validator must reject: the CTE contains a data-modifying statement.
            const validation = validator.validate(sql);
            expect(validation.valid).toBe(false);

            // Execution service must reject because the validator runs first.
            const request = store.create({
                sql,
                operation: "SELECT",
                database: "querymind_dev",
            });
            store.updateStatus(request.id, "approved");

            expect(() => service.prepareExecution(request.id)).toThrow(
                /SQL validation failed/,
            );
        });

        it("should accept a read-only CTE with a final UPDATE", () => {
            const sql = `WITH selected AS (
                SELECT id FROM products WHERE price > 100
            )
            UPDATE products SET price = 200 WHERE id IN (SELECT id FROM selected)`;

            // Classifier recognizes the final UPDATE as a write operation.
            const classification = classifier.classify(sql);
            expect(classification.category).toBe("write");
            expect(classification.operation).toBe("UPDATE");

            // Validator accepts it: read-only CTEs are allowed.
            const validation = validator.validate(sql);
            expect(validation.valid).toBe(true);

            // Execution service allows it: UPDATE is in the allowlist.
            const request = store.create({
                sql,
                operation: "UPDATE",
                database: "querymind_dev",
            });
            store.updateStatus(request.id, "approved");

            const execution = service.prepareExecution(request.id);
            expect(execution.approvalId).toBe(request.id);
            expect(execution.operation).toBe("UPDATE");
        });
    });

    describe("Operation mismatch", () => {
        it("should reject when the request operation does not match SQL classification", () => {
            // SQL classifies as DELETE, but the stored request says UPDATE.
            const request = store.create({
                sql: "DELETE FROM products WHERE id = 1",
                operation: "UPDATE",
                database: "querymind_dev",
            });
            store.updateStatus(request.id, "approved");

            expect(() => service.prepareExecution(request.id)).toThrow(
                "Operation mismatch: expected UPDATE, but got DELETE.",
            );
        });
    });

    describe("Invalid or malformed SQL", () => {
        it.each([
            "",
            "UPDATE SET price = 100",
            "UPDATE products SET price = 100; DELETE FROM products",
        ])("rejects %s at the validator layer", (sql) => {
            const validation = validator.validate(sql);
            expect(validation.valid).toBe(false);
        });

        it.each([
            "",
            "UPDATE SET price = 100",
            "UPDATE products SET price = 100; DELETE FROM products",
        ])("rejects %s at the execution service layer", (sql) => {
            const request = store.create({
                sql,
                operation: "UPDATE",
                database: "querymind_dev",
            });
            store.updateStatus(request.id, "approved");

            expect(() => service.prepareExecution(request.id)).toThrow(
                /SQL validation failed|Expected exactly one/,
            );
        });
    });
});
