import { parse } from "pgsql-ast-parser";

export type SqlOperation =
    | "SELECT"
    | "INSERT"
    | "UPDATE"
    | "DELETE"
    | "CREATE"
    | "ALTER"
    | "DROP"
    | "TRUNCATE"
    | "OTHER";

export interface SqlClassification {
    operation: SqlOperation;
    category: "read" | "write" | "unknown";
    requiresApproval: boolean;
}

export class SqlOperationClassifier {
    classify(sql: string): SqlClassification {
        const statements = parse(sql);

        if (statements.length !== 1) {
            throw new Error("Expected exactly one SQL statement.");
        }

        const statement = statements[0];

        if (
            !statement ||
            typeof statement !== "object" ||
            !("type" in statement) ||
            typeof statement.type !== "string"
        ) {
            throw new Error("Unsupported SQL statement.");
        }

        const statementType = statement.type.toUpperCase();

        if (statementType === "WITH") {
            return this.classifyStatement(statement);
        }

        // switch (statementType) {
        //     case "SELECT":
        //         return {
        //             operation: "SELECT",
        //             category: "read",
        //             requiresApproval: false,
        //         };
        //     case "INSERT":
        //     case "UPDATE":
        //     case "DELETE":
        //     case "CREATE":
        //     case "ALTER":
        //     case "DROP":
        //     case "TRUNCATE":
        //         return {
        //             operation: statementType,
        //             category: "write",
        //             requiresApproval: true,
        //         };
        //     default:
        //         return {
        //             operation: "OTHER",
        //             category: "unknown",
        //             requiresApproval: true,
        //         };
        // }
        return this.classifyStatementType(statementType);
    }

    private classifyStatement(statement: unknown): SqlClassification {
        if (!statement || typeof statement !== "object") {
            return this.unknownClassification();
        }

        const record = statement as Record<string, unknown>;
        const bindings = record.bind;

        if (!Array.isArray(bindings) || bindings.length === 0) {
            return this.unknownClassification();
        }

        for (const binding of bindings) {
            if (!binding || typeof binding !== "object") {
                return this.unknownClassification();
            }

            const cteStatement = (binding as Record<string, unknown>).statement;

            if (
                !cteStatement ||
                typeof cteStatement !== "object" ||
                !("type" in cteStatement) ||
                typeof cteStatement.type !== "string"
            ) {
                return this.unknownClassification();
            }

            const result =
                cteStatement.type.toLowerCase() === "with"
                    ? this.classifyStatement(cteStatement)
                    : this.classifyStatementType(cteStatement.type);

            if (result.category !== "read") {
                return result;
            }
        }

        const innerStatement = record.in;

        if (
            !innerStatement ||
            typeof innerStatement !== "object" ||
            !("type" in innerStatement) ||
            typeof innerStatement.type !== "string"
        ) {
            return this.unknownClassification();
        }

        return innerStatement.type.toLowerCase() === "with"
            ? this.classifyStatement(innerStatement)
            : this.classifyStatementType(innerStatement.type);
    }

    private classifyStatementType(statementType: string): SqlClassification {
        const normalizedType = statementType.toLowerCase();
        if (normalizedType === "select") {
            return {
                operation: "SELECT",
                category: "read",
                requiresApproval: false,
            };
        }

        const operationMap: Record<string, SqlOperation> = {
            insert: "INSERT",
            update: "UPDATE",
            delete: "DELETE",

            "create table": "CREATE",
            "create index": "CREATE",
            "create schema": "CREATE",
            "create view": "CREATE",

            "alter table": "ALTER",
            "alter index": "ALTER",

            "drop table": "DROP",
            "drop index": "DROP",

            "truncate table": "TRUNCATE",
        };

        const operation = operationMap[normalizedType];

        if (operation) {
            return {
                operation,
                category: "write",
                requiresApproval: true,
            };
        }

        return {
            operation: "OTHER",
            category: "unknown",
            requiresApproval: true,
        };
    }
    private unknownClassification(): SqlClassification {
        return {
            operation: "OTHER",
            category: "unknown",
            requiresApproval: true,
        };
    }
}
