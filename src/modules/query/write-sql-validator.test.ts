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
    });

    describe("WITH statements", () => {
        it("should allow a write using a read-only CTE", () => {
            expect(
                validator.validate(`
                    WITH selected AS (
                        SELECT id FROM products WHERE price > 100
                    )
                    UPDATE products
                    SET price = 200
                    WHERE id IN (SELECT id FROM selected)
                `).valid,
            ).toBe(true);
        });

        it("should reject a data-modifying CTE", () => {
            expect(
                validator.validate(`
                    WITH deleted AS (
                        DELETE FROM products
                        WHERE id = 1
                        RETURNING id
                    )
                    UPDATE products
                    SET price = 200
                    WHERE id IN (SELECT id FROM deleted)
                `).valid,
            ).toBe(false);
        });
    });

    describe("Unsupported operations", () => {
        it("should reject SELECT", () => {
            expect(validator.validate("SELECT * FROM products").valid).toBe(
                false,
            );
        });

        it("should reject CREATE TABLE", () => {
            expect(
                validator.validate("CREATE TABLE test_table (id INTEGER)")
                    .valid,
            ).toBe(false);
        });

        it("should reject TRUNCATE", () => {
            expect(validator.validate("TRUNCATE TABLE products").valid).toBe(
                false,
            );
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
});
