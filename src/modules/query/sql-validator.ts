import { parse } from "pgsql-ast-parser";

const DISALLOWED_STATEMENT_TYPES = new Set([
    "insert",
    "update",
    "delete",
    "create",
    "truncate",
    "alter",
    "drop",
    "grant",
    "revoke",
    "comment",
    "copy",
    "do",
    "rename",
]);

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

interface ValidationResult {
    valid: boolean;
    reason?: string;
}

export class SqlValidator {
    validate(sql: string): ValidationResult {
        if (!sql || !sql.trim()) {
            return {
                valid: false,
                reason: "SQL query cannot be empty",
            };
        }

        const MAX_SQL_LENGTH = 50_000;

        if (sql.length > MAX_SQL_LENGTH) {
            return {
                valid: false,
                reason: `SQL query exceeds the maximum length of ${MAX_SQL_LENGTH} characters`,
            };
        }
        let statements: unknown[];

        // 1. Parse the SQL string into statements
        try {
            statements = parse(sql);
        } catch (error) {
            return {
                valid: false,
                reason:
                    error instanceof Error
                        ? `Invalid SQL: ${error.message}`
                        : `Invalid SQL syntax`,
            };
        }

        //  2. Requires exactly one statement
        if (statements.length !== 1) {
            return {
                valid: false,
                reason: `Expected exactly one SQL statement, but found ${statements.length}`,
            };
        }

        const statement = statements[0];

        if (
            typeof statement !== "object" ||
            statement === null ||
            !("type" in statement)
        ) {
            return {
                valid: false,
                reason: "Unsupported SQL statement",
            };
        }

        const statementType = statement.type;

        // 3. Only allow SELECT and WITH statements
        if (statementType !== "select" && statementType !== "with") {
            return {
                valid: false,
                reason: `Disallowed SQL statement type: ${statementType}`,
            };
        }

        // 4. Inspect nested AST nodes
        const unsafeReason = this.inspectNode(statement);

        if (unsafeReason) {
            return {
                valid: false,
                reason: unsafeReason,
            };
        }

        return { valid: true };
    }

    private inspectNode(node: unknown): string | null {
        if (Array.isArray(node)) {
            for (const item of node) {
                const reason = this.inspectNode(item);

                if (reason) return reason;
            }

            return null;
        }

        if (typeof node !== "object" || node === null) {
            return null;
        }

        const record = node as Record<string, unknown>;

        // Reject write operations, including nested CTE statements
        if (
            typeof record.type === "string" &&
            DISALLOWED_STATEMENT_TYPES.has(record.type)
        ) {
            return `Operation '${record.type}' is not allowed`;
        }

        const functionNode = record.function;
        if (
            record.type === "call" &&
            typeof functionNode === "object" &&
            functionNode !== null &&
            "name" in functionNode &&
            typeof functionNode.name === "string" &&
            DISALLOWED_FUNCTIONS.has(functionNode.name.toLowerCase())
        ) {
            return `Function '${functionNode.name}' is not allowed`;
        }

        // Reject SELECT FOR UPDATE / SHARE
        if ("for" in record) {
            return "Row-locking clauses are not allowed";
        }

        // Reject SELECT INTO
        if ("into" in record) {
            return "SELECT INTO is not allowed";
        }

        // Recursively inspect child nodes
        for (const value of Object.values(record)) {
            const reason = this.inspectNode(value);

            if (reason) return reason;
        }

        return null;
    }
}
