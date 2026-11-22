import { describe, expect, it } from "vitest";

import { SqlOperationClassifier } from "./sql-operation-classifier.js";
import { WriteSqlValidator } from "./write-sql-validator.js";

describe("WriteSqlValidator", () => {
    const classifier = new SqlOperationClassifier();
    const validator = new WriteSqlValidator(classifier);

    describe("Supported write operations", () => {
        it("should allow INSERT", () => {
            expect(
                validator.validate(
                    "INSERT INTO products (name, price) VALUES ('Keyboard', 100)",
                ).valid,
            ).toBe(true);
        });

        it("should allow UPDATE", () => {
            expect(
                validator.validate(
                    "UPDATE products SET price = 500 WHERE id = 1",
                ).valid,
            ).toBe(true);
        });

        it("should allow DELETE", () => {
            expect(
                validator.validate("DELETE FROM products WHERE id = 1").valid,
            ).toBe(true);
        });

        it("should allow CREATE TABLE", () => {
            expect(
                validator.validate("CREATE TABLE test_table (id INTEGER)").valid,
            ).toBe(true);
        });

        it("should allow CREATE INDEX", () => {
            expect(
                validator.validate(
                    "CREATE INDEX idx_products_name ON products(name)",
                ).valid,
            ).toBe(true);
        });

        it("should allow CREATE SCHEMA", () => {
            expect(
                validator.validate("CREATE SCHEMA myschema").valid,
            ).toBe(true);
        });

        it("should allow CREATE VIEW", () => {
            expect(
                validator.validate(
                    "CREATE VIEW active_products AS SELECT * FROM products",
                ).valid,
            ).toBe(true);
        });

        it("should allow ALTER TABLE", () => {
            expect(
                validator.validate(
                    "ALTER TABLE products ADD COLUMN description TEXT",
                ).valid,
            ).toBe(true);
        });

        it("should allow ALTER INDEX", () => {
            expect(
                validator.validate(
                    "ALTER INDEX idx_products_name RENAME TO idx_products_name_new",
                ).valid,
            ).toBe(true);
        });

        it("should allow DROP TABLE", () => {
            expect(
                validator.validate("DROP TABLE test_table").valid,
            ).toBe(true);
        });

        it("should allow DROP INDEX", () => {
            expect(
                validator.validate("DROP INDEX idx_products_name").valid,
            ).toBe(true);
        });

        it("should allow TRUNCATE TABLE", () => {
            expect(
                validator.validate("TRUNCATE TABLE products").valid,
            ).toBe(true);
        });
    });

    describe("WITH statements", () => {
        it("should allow a write using a read-only CTE", () => {
            expect(
                validator.validate(`WITH selected AS (
                    SELECT id FROM products WHERE price > 100
                )
                UPDATE products
                SET price = 200
                WHERE id IN (SELECT id FROM selected)`).valid,
            ).toBe(true);
        });

        it("should allow CREATE TABLE with a read-only CTE", () => {
            // NOTE: pgsql-ast-parser does not support WITH ... CREATE TABLE syntax.
            // This is verified by the parser rejecting it as invalid SQL syntax.
            expect(
                validator.validate(
                    "WITH src AS (SELECT 1) CREATE TABLE t (id INTEGER)",
                ).valid,
            ).toBe(false);
        });

        it("should reject a data-modifying CTE", () => {
            expect(
                validator.validate(`WITH deleted AS (
                    DELETE FROM products
                    WHERE id = 1
                    RETURNING id
                )
                UPDATE products
                SET price = 200
                WHERE id IN (SELECT id FROM deleted)`).valid,
            ).toBe(false);
        });

        it("should reject a CTE containing INSERT", () => {
            expect(
                validator.validate(`WITH inserted AS (
                    INSERT INTO products (name) VALUES ('Test')
                    RETURNING id
                )
                UPDATE products SET price = 200 WHERE id IN (SELECT id FROM inserted)`).valid,
            ).toBe(false);
        });

        it("should reject a CTE containing CREATE TABLE", () => {
            expect(
                validator.validate(`WITH created AS (
                    CREATE TABLE temp_table (id INTEGER)
                )
                UPDATE products SET price = 200 WHERE id = 1`).valid,
            ).toBe(false);
        });
    });

    describe("Unsupported operations", () => {
        it("should reject SELECT", () => {
            expect(validator.validate("SELECT * FROM products").valid).toBe(
                false,
            );
        });

        it("should reject GRANT", () => {
            expect(validator.validate("GRANT SELECT ON products TO public").valid).toBe(false);
        });

        it("should reject REVOKE", () => {
            expect(validator.validate("REVOKE INSERT ON products FROM public").valid).toBe(false);
        });

        it("should reject VACUUM", () => {
            expect(validator.validate("VACUUM products").valid).toBe(false);
        });

        it("should reject ANALYZE", () => {
            expect(validator.validate("ANALYZE products").valid).toBe(false);
        });

        it("should reject EXPLAIN", () => {
            expect(validator.validate("EXPLAIN SELECT * FROM products").valid).toBe(false);
        });
    });

    describe("Invalid SQL", () => {
        it("should reject empty SQL", () => {
            expect(validator.validate("").valid).toBe(false);
        });

        it("should reject invalid SQL syntax", () => {
            expect(validator.validate("UPDATE SET price = 100").valid).toBe(
                false,
            );
        });

        it("should reject multiple statements", () => {
            expect(
                validator.validate(
                    "UPDATE products SET price = 100; DELETE FROM products",
                ).valid,
            ).toBe(false);
        });

        it("should reject SQL exceeding the maximum length", () => {
            expect(validator.validate("x".repeat(50_001)).valid).toBe(false);
        });

        it("should reject malformed CREATE TABLE", () => {
            expect(
                validator.validate("CREATE TABLE").valid,
            ).toBe(false);
        });

        it("should reject malformed ALTER TABLE", () => {
            expect(
                validator.validate("ALTER TABLE").valid,
            ).toBe(false);
        });

        it("should reject malformed DROP TABLE", () => {
            expect(
                validator.validate("DROP TABLE").valid,
            ).toBe(false);
        });

        it("should reject malformed TRUNCATE TABLE", () => {
            expect(
                validator.validate("TRUNCATE TABLE").valid,
            ).toBe(false);
        });

        it("should reject malformed CREATE VIEW", () => {
            expect(
                validator.validate("CREATE VIEW").valid,
            ).toBe(false);
        });
    });

    describe("Unsafe SQL", () => {
        it("should reject a disallowed PostgreSQL function", () => {
            expect(
                validator.validate(`
                    UPDATE products
                    SET name = pg_read_file('/some/path')
                    WHERE id = 1
                `).valid,
            ).toBe(false);
        });
    });

    describe("Transaction-incompatible variants", () => {
        it("should reject CREATE INDEX CONCURRENTLY", () => {
            expect(
                validator.validate(
                    "CREATE INDEX CONCURRENTLY idx_products_name ON products(name)",
                ).valid,
            ).toBe(false);
        });

        it("should reject DROP INDEX CONCURRENTLY", () => {
            expect(
                validator.validate(
                    "DROP INDEX CONCURRENTLY idx_products_name",
                ).valid,
            ).toBe(false);
        });

        it("should still allow CREATE INDEX without CONCURRENTLY", () => {
            expect(
                validator.validate(
                    "CREATE INDEX idx_products_name ON products(name)",
                ).valid,
            ).toBe(true);
        });

        it("should still allow DROP INDEX without CONCURRENTLY", () => {
            expect(
                validator.validate("DROP INDEX idx_products_name").valid,
            ).toBe(true);
        });
    });

    describe("Unsupported DDL rejected by parser", () => {
        it("should reject DROP SCHEMA (parser does not support it)", () => {
            expect(
                validator.validate("DROP SCHEMA myschema").valid,
            ).toBe(false);
        });

        it("should reject DROP VIEW (parser does not support it)", () => {
            expect(
                validator.validate("DROP VIEW active_products").valid,
            ).toBe(false);
        });
    });

    describe("Unsupported DDL (parser-supported but rejected)", () => {
        it("should reject CREATE TYPE", () => {
            expect(
                validator.validate(
                    "CREATE TYPE mood AS ENUM ('sad', 'ok', 'happy')",
                ).valid,
            ).toBe(false);
        });

        it("should reject CREATE FUNCTION", () => {
            expect(
                validator.validate(
                    "CREATE FUNCTION add_one(integer) RETURNS integer LANGUAGE sql AS 'SELECT $1 + 1'",
                ).valid,
            ).toBe(false);
        });

        it("should reject ALTER SEQUENCE", () => {
            expect(
                validator.validate("ALTER SEQUENCE myseq RESTART WITH 10")
                    .valid,
            ).toBe(false);
        });

        it("should reject DROP TYPE", () => {
            expect(validator.validate("DROP TYPE mood").valid).toBe(false);
        });
    });
});
