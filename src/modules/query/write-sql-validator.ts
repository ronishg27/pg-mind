import { parse } from "pgsql-ast-parser";

import type { SqlOperationClassifier } from "./sql-operation-classifier.js";

const SUPPORTED_OPERATIONS = [
    "INSERT",
    "UPDATE",
    "DELETE",
    "CREATE",
    "ALTER",
    "DROP",
    "TRUNCATE",
];

const DML_WRITE_TYPES = new Set(["insert", "update", "delete"]);

const DDL_WRITE_TYPES = new Set([
    "create table",
    "create index",
    "create schema",
    "create view",
    "alter table",
    "alter index",
    "drop table",
    "drop index",
    "truncate table",
]);

const SUPPORTED_WRITE_TYPES = new Set([...DML_WRITE_TYPES, ...DDL_WRITE_TYPES]);

const DISALLOWED_FUNCTIONS = new Set([
    "pg_terminate_backend",
    "pg_cancel_backend",
    "pg_read_file",
    "pg_read_binary_file",
    "pg_ls_dir",
    "pg_log_backend_memory_contexts",
    "pg_reload_conf",
    "pg_rotate_logfile",
    "set_config",
    "lo_import",
    "lo_export",
]);

export interface WriteValidationResult {
    valid: boolean;
    reason?: string;
}

export class WriteSqlValidator {
    constructor(private readonly classifier: SqlOperationClassifier) {}

    validate(sql: string): WriteValidationResult {
        if (!sql || sql.trim() === "") {
            return {
                valid: false,
                reason: "SQL statement is empty.",
            };
        }
        if (sql.length > 50_000) {
            return {
                valid: false,
                reason: "SQL statement exceeds the maximum allowed length of 50,000 characters.",
            };
        }

        let statements: unknown[];

        try {
            statements = parse(sql);
        } catch {
            return {
                valid: false,
                reason: "Invalid SQL syntax.",
            };
        }

        if (statements.length !== 1) {
            return {
                valid: false,
                reason: "Only single SQL statements are allowed. Multiple statements detected.",
            };
        }

        const statement = statements[0];
        if (!this.isObject(statement)) {
            return {
                valid: false,
                reason: "Unsupported SQL statement.",
            };
        }

        const classification = this.classifier.classify(sql);

        if (
            classification.category !== "write" ||
            !SUPPORTED_OPERATIONS.includes(classification.operation)
        ) {
            return {
                valid: false,
                reason: "Unsupported operation. Only INSERT, UPDATE, DELETE, CREATE, ALTER, DROP, and TRUNCATE are allowed.",
            };
        }

        if (!this.hasSupportedStructure(statement)) {
            return {
                valid: false,
                reason: "Unsupported write statement structure.",
            };
        }

        if (this.containsDisallowedFunction(statement)) {
            return {
                valid: false,
                reason: "The SQL statement contains disallowed functions.",
            };
        }

        if (this.containsUnsafeSelect(statement)) {
            return {
                valid: false,
                reason: "SQL contains an unsupported SELECT operation.",
            };
        }

        if (this.containsConcurrently(statement)) {
            return {
                valid: false,
                reason: "CONCURRENTLY is not supported because it cannot run inside a transaction.",
            };
        }

        return { valid: true };
    }

    private hasSupportedStructure(statement: Record<string, unknown>): boolean {
        if (statement.type !== "with") {
            return SUPPORTED_WRITE_TYPES.has(String(statement.type).toLowerCase());
        }

        const bindings = statement.bind;
        const finalStatement = statement.in;

        if (
            !Array.isArray(bindings) ||
            bindings.length === 0 ||
            !this.isObject(finalStatement)
        ) {
            return false;
        }

        // CTEs must be read-only.
        for (const binding of bindings) {
            if (!this.isObject(binding) || !this.isObject(binding.statement)) {
                return false;
            }

            if (this.containsWriteStatement(binding.statement)) {
                return false;
            }
        }

        return SUPPORTED_WRITE_TYPES.has(
            String(finalStatement.type).toLowerCase(),
        );
    }

    private containsWriteStatement(node: unknown): boolean {
        if (Array.isArray(node)) {
            return node.some((item) => this.containsWriteStatement(item));
        }

        if (!this.isObject(node)) {
            return false;
        }

        const type = String(node.type ?? "").toLowerCase();

        if (SUPPORTED_WRITE_TYPES.has(type)) {
            return true;
        }

        return Object.values(node).some((value) =>
            this.containsWriteStatement(value),
        );
    }

    private containsDisallowedFunction(node: unknown): boolean {
        if (Array.isArray(node)) {
            return node.some((item) => this.containsDisallowedFunction(item));
        }

        if (!this.isObject(node)) {
            return false;
        }

        if (node.type === "call" && this.isObject(node.function)) {
            const functionName = String(node.function.name ?? "").toLowerCase();

            if (DISALLOWED_FUNCTIONS.has(functionName)) {
                return true;
            }
        }

        return Object.values(node).some((value) =>
            this.containsDisallowedFunction(value),
        );
    }

    private containsUnsafeSelect(node: unknown): boolean {
        if (Array.isArray(node)) {
            return node.some((item) => this.containsUnsafeSelect(item));
        }

        if (!this.isObject(node)) {
            return false;
        }

        if (node.type === "select") {
            // Reject SELECT INTO and row-locking clauses.
            if ("into" in node || "for" in node) {
                return true;
            }
        }

        return Object.values(node).some((value) =>
            this.containsUnsafeSelect(value),
        );
    }

    private containsConcurrently(node: unknown): boolean {
        if (Array.isArray(node)) {
            return node.some((item) => this.containsConcurrently(item));
        }

        if (!this.isObject(node)) {
            return false;
        }

        if (node.concurrently === true) {
            return true;
        }

        return Object.values(node).some((value) =>
            this.containsConcurrently(value),
        );
    }

    private isObject(value: unknown): value is Record<string, unknown> {
        return (
            typeof value === "object" && value !== null && !Array.isArray(value)
        );
    }
}
