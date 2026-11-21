import { describe, expect, it } from "vitest";
import { SqlOperationClassifier } from "./sql-operation-classifier.js";

describe("SqlOperationClassifier", () => {
    const classifier = new SqlOperationClassifier();

    describe("Read operations", () => {
        it("should classify SELECT as read", () => {
            const result = classifier.classify("SELECT * FROM users");

            expect(result).toEqual({
                operation: "SELECT",
                category: "read",
                requiresApproval: false,
            });
        });

        it("should classify WITH SELECT as read", () => {
            const result = classifier.classify(
                "WITH x AS (SELECT 1) SELECT * FROM x",
            );

            expect(result.category).toBe("read");
            expect(result.operation).toBe("SELECT");
        });

        it("should classify multiple read-only CTEs as read", () => {
            const result = classifier.classify(`
        WITH
            first_cte AS (
                SELECT * FROM users
            ),
            second_cte AS (
                SELECT * FROM products
            )
        SELECT * FROM first_cte;
    `);

            expect(result).toEqual({
                operation: "SELECT",
                category: "read",
                requiresApproval: false,
            });
        });
    });

    describe("Write operations", () => {
        const cases = [
            ["INSERT", "INSERT INTO users (name) VALUES ('Ron')"],
            ["UPDATE", "UPDATE users SET name = 'Ron'"],
            ["DELETE", "DELETE FROM users"],
            ["CREATE", "CREATE TABLE users (id INT)"],
            ["ALTER", "ALTER TABLE users ADD COLUMN age INT"],
            ["DROP", "DROP TABLE users"],
            ["TRUNCATE", "TRUNCATE TABLE users"],
            ["CREATE", "CREATE INDEX idx_users_email ON users(email)"],
            ["DROP", "DROP INDEX idx_users_email"],
        ] as const;

        it.each(cases)("should classify %s as write", (operation, sql) => {
            const result = classifier.classify(sql);

            expect(result).toEqual({
                operation,
                category: "write",
                requiresApproval: true,
            });
        });

        it("should classify WITH DELETE as write", () => {
            const result = classifier.classify(
                "WITH x AS (SELECT 1) DELETE FROM users",
            );

            expect(result.operation).toBe("DELETE");
            expect(result.category).toBe("write");
            expect(result.requiresApproval).toBe(true);
        });

        it("should detect DELETE inside a CTE", () => {
            const result = classifier.classify(`
                WITH deleted AS (
                    DELETE FROM users
                    RETURNING *
                )
                SELECT * FROM deleted
            `);

            expect(result.operation).toBe("DELETE");
            expect(result.category).toBe("write");
            expect(result.requiresApproval).toBe(true);
        });

        it("should detect write operations in multiple CTEs", () => {
            const result = classifier.classify(`
        WITH
            first_cte AS (
                SELECT id FROM users
            ),
            deleted AS (
                DELETE FROM users
                WHERE id IN (SELECT id FROM first_cte)
                RETURNING *
            )
        SELECT * FROM deleted
    `);

            expect(result).toEqual({
                operation: "DELETE",
                category: "write",
                requiresApproval: true,
            });
        });

        it("should detect write operations in nested CTEs", () => {
            const result = classifier.classify(`
        WITH outer_cte AS (
            WITH inner_cte AS (
                DELETE FROM users
                RETURNING *
            )
            SELECT * FROM inner_cte
        )
        SELECT * FROM outer_cte
    `);

            expect(result).toEqual({
                operation: "DELETE",
                category: "write",
                requiresApproval: true,
            });
        });

        it.each([
            ["CREATE SCHEMA test_schema", "CREATE"],

            ["CREATE VIEW active_users AS SELECT * FROM users", "CREATE"],
            ["ALTER INDEX users_idx RENAME TO users_idx_new", "ALTER"],
        ])("should classify %s as write", (sql, operation) => {
            expect(classifier.classify(sql)).toEqual({
                operation,
                category: "write",
                requiresApproval: true,
            });
        });
    });

    describe("Invalid SQL", () => {
        it("should reject empty SQL", () => {
            expect(() => classifier.classify("")).toThrow();
        });

        it("should reject invalid SQL syntax", () => {
            expect(() => classifier.classify("SELEC * FORM users")).toThrow();
        });

        it.each(["DROP SCHEMA test_schema", "DROP VIEW active_users"])(
            "should reject unsupported DDL: %s",
            (sql) => {
                expect(() => classifier.classify(sql)).toThrow();
            },
        );
        it("should reject multiple statements", () => {
            expect(() => classifier.classify("SELECT 1; SELECT 2")).toThrow(
                "Expected exactly one SQL statement.",
            );
        });

        it("should reject unsupported SQL syntax", () => {
            expect(() =>
                classifier.classify("EXPLAIN SELECT * FROM users"),
            ).toThrow();
        });
    });
});

// import { parse } from "pgsql-ast-parser";

// const queries = [
//     "CREATE TABLE users (id INT)",
//     "ALTER TABLE users ADD COLUMN age INT",
//     "DROP TABLE users",
//     "TRUNCATE TABLE users",
// ];

// for (const sql of queries) {
//     console.log(`\nSQL: ${sql}`);
//     console.dir(parse(sql), { depth: null });
// }
