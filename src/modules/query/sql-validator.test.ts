import { describe, expect, it } from 'vitest';

import { SqlValidator } from './sql-validator.js';

describe('SqlValidator (read queries)', () => {
    const validator = new SqlValidator();

    describe('Valid read queries', () => {
        it('should allow simple SELECT', () => {
            expect(validator.validate('SELECT * FROM products').valid).toBe(true);
        });

        it('should allow SELECT with WHERE', () => {
            expect(
                validator.validate('SELECT id, name FROM products WHERE price > 100').valid
            ).toBe(true);
        });

        it('should allow WITH (CTE) queries', () => {
            expect(
                validator.validate(`
                    WITH expensive AS (
                        SELECT * FROM products WHERE price > 1000
                    )
                    SELECT * FROM expensive
                `).valid
            ).toBe(true);
        });

        it('should allow SELECT with JOIN', () => {
            expect(
                validator.validate(`
                    SELECT p.name, c.name as category
                    FROM products p
                    JOIN categories c ON p.category_id = c.id
                `).valid
            ).toBe(true);
        });

        it('should allow SELECT with aggregate functions', () => {
            expect(validator.validate('SELECT COUNT(*), AVG(price) FROM products').valid).toBe(
                true
            );
        });
    });

    describe('Disallowed functions in read queries', () => {
        it('should reject pg_advisory_lock in SELECT', () => {
            expect(validator.validate('SELECT pg_advisory_lock(1)').valid).toBe(false);
        });

        it('should reject pg_try_advisory_lock in SELECT', () => {
            expect(validator.validate('SELECT pg_try_advisory_lock(1, 2)').valid).toBe(false);
        });

        it('should reject pg_advisory_unlock in SELECT', () => {
            expect(validator.validate('SELECT pg_advisory_unlock(1)').valid).toBe(false);
        });

        it('should reject pg_advisory_unlock_all in SELECT', () => {
            expect(validator.validate('SELECT pg_advisory_unlock_all()').valid).toBe(false);
        });

        it('should reject pg_advisory_lock in WHERE clause', () => {
            expect(
                validator.validate('SELECT * FROM products WHERE pg_advisory_lock(id) > 0').valid
            ).toBe(false);
        });

        // Transaction-level advisory locks are SAFE (auto-release at transaction end)
        it('should allow pg_advisory_xact_lock in SELECT', () => {
            expect(validator.validate('SELECT pg_advisory_xact_lock(1)').valid).toBe(true);
        });

        it('should allow pg_try_advisory_xact_lock in SELECT', () => {
            expect(validator.validate('SELECT pg_try_advisory_xact_lock(1, 2)').valid).toBe(true);
        });

        it('should reject pg_read_file in SELECT', () => {
            expect(validator.validate("SELECT pg_read_file('/etc/passwd')").valid).toBe(false);
        });

        it('should reject pg_terminate_backend in SELECT', () => {
            expect(validator.validate('SELECT pg_terminate_backend(12345)').valid).toBe(false);
        });
    });

    describe('Write operations rejected in read queries', () => {
        it('should reject INSERT', () => {
            expect(validator.validate("INSERT INTO products (name) VALUES ('test')").valid).toBe(
                false
            );
        });

        it('should reject UPDATE', () => {
            expect(validator.validate("UPDATE products SET name = 'test'").valid).toBe(false);
        });

        it('should reject DELETE', () => {
            expect(validator.validate('DELETE FROM products').valid).toBe(false);
        });

        it('should reject CREATE TABLE', () => {
            expect(validator.validate('CREATE TABLE test (id INT)').valid).toBe(false);
        });

        it('should reject DROP TABLE', () => {
            expect(validator.validate('DROP TABLE products').valid).toBe(false);
        });
    });

    describe('Row-locking clauses rejected', () => {
        it('should reject FOR UPDATE', () => {
            expect(validator.validate('SELECT * FROM products FOR UPDATE').valid).toBe(false);
        });

        it('should reject FOR SHARE', () => {
            expect(validator.validate('SELECT * FROM products FOR SHARE').valid).toBe(false);
        });

        it('should reject SELECT INTO', () => {
            expect(validator.validate('SELECT * INTO new_table FROM products').valid).toBe(false);
        });
    });

    describe('Multiple statements rejected', () => {
        it('should reject multiple statements', () => {
            expect(
                validator.validate('SELECT * FROM products; SELECT * FROM categories').valid
            ).toBe(false);
        });
    });

    describe('Empty or invalid SQL', () => {
        it('should reject empty SQL', () => {
            expect(validator.validate('').valid).toBe(false);
        });

        it('should reject whitespace-only SQL', () => {
            expect(validator.validate('   ').valid).toBe(false);
        });

        it('should reject invalid syntax', () => {
            expect(validator.validate('SELECT * FROM').valid).toBe(false);
        });
    });
});
