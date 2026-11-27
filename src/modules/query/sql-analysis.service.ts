import { parse } from 'pgsql-ast-parser';

export type SqlOperation =
    'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE' | 'CREATE' | 'ALTER' | 'DROP' | 'TRUNCATE' | 'OTHER';

export type SqlCategory = 'read' | 'write' | 'unknown';

export interface SqlAnalysis {
    statementCount: number;
    operation: SqlOperation;
    category: SqlCategory;
    isSupported: boolean;
    validationErrors: string[];
    requiresApproval: boolean;
    statementType: string;
}

const DISALLOWED_FUNCTIONS = new Set([
    'pg_terminate_backend',
    'pg_cancel_backend',
    'pg_read_file',
    'pg_read_binary_file',
    'pg_ls_dir',
    'pg_log_backend_memory_contexts',
    'pg_reload_conf',
    'pg_rotate_logfile',
    'set_config',
    'lo_import',
    'lo_export',
    // Session-level advisory locks (persist beyond transaction, dangerous in pooled connections)
    'pg_advisory_lock',
    'pg_try_advisory_lock',
    'pg_advisory_unlock',
    'pg_advisory_unlock_all',
]);

const DISALLOWED_STATEMENT_TYPES = new Set([
    'insert',
    'update',
    'delete',
    'create',
    'truncate',
    'alter',
    'drop',
    'grant',
    'revoke',
    'comment',
    'copy',
    'do',
    'rename',
]);

const SUPPORTED_WRITE_OPERATIONS = new Set([
    'INSERT',
    'UPDATE',
    'DELETE',
    'CREATE',
    'ALTER',
    'DROP',
    'TRUNCATE',
]);

const DML_WRITE_TYPES = new Set(['insert', 'update', 'delete']);

const DDL_WRITE_TYPES = new Set([
    'create table',
    'create index',
    'create schema',
    'create view',
    'alter table',
    'alter index',
    'drop table',
    'drop index',
    'truncate table',
]);

const SUPPORTED_WRITE_TYPES = new Set([...DML_WRITE_TYPES, ...DDL_WRITE_TYPES]);

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getFunctionName(node: Record<string, unknown>): string | null {
    if (node.type === 'call' && isObject(node.function)) {
        const name = node.function.name;
        if (typeof name === 'string') {
            return name.toLowerCase();
        }
    }
    return null;
}

function containsNodeType(node: unknown, targetTypes: Set<string>): boolean {
    if (Array.isArray(node)) {
        return node.some((item) => containsNodeType(item, targetTypes));
    }
    if (!isObject(node)) {
        return false;
    }
    const type = String(node.type ?? '').toLowerCase();
    if (targetTypes.has(type)) {
        return true;
    }
    return Object.values(node).some((value) => containsNodeType(value, targetTypes));
}

function containsDisallowedFunction(node: unknown): string | null {
    if (Array.isArray(node)) {
        for (const item of node) {
            const found = containsDisallowedFunction(item);
            if (found) return found;
        }
        return null;
    }
    if (!isObject(node)) {
        return null;
    }
    const funcName = getFunctionName(node);
    if (funcName && DISALLOWED_FUNCTIONS.has(funcName)) {
        return funcName;
    }
    for (const value of Object.values(node)) {
        const found = containsDisallowedFunction(value);
        if (found) return found;
    }
    return null;
}

function containsUnsafeSelect(node: unknown): boolean {
    if (Array.isArray(node)) {
        return node.some((item) => containsUnsafeSelect(item));
    }
    if (!isObject(node)) {
        return false;
    }
    if (node.type === 'select') {
        if ('into' in node || 'for' in node) {
            return true;
        }
    }
    return Object.values(node).some((value) => containsUnsafeSelect(value));
}

function containsConcurrently(node: unknown): boolean {
    if (Array.isArray(node)) {
        return node.some((item) => containsConcurrently(item));
    }
    if (!isObject(node)) {
        return false;
    }
    if (node.concurrently === true) {
        return true;
    }
    return Object.values(node).some((value) => containsConcurrently(value));
}

function classifyStatementType(statementType: string): {
    operation: SqlOperation;
    category: SqlCategory;
} {
    const normalizedType = statementType.toLowerCase();
    if (normalizedType === 'select') {
        return { operation: 'SELECT', category: 'read' };
    }

    const operationMap: Record<string, SqlOperation> = {
        insert: 'INSERT',
        update: 'UPDATE',
        delete: 'DELETE',
        'create table': 'CREATE',
        'create index': 'CREATE',
        'create schema': 'CREATE',
        'create view': 'CREATE',
        'alter table': 'ALTER',
        'alter index': 'ALTER',
        'drop table': 'DROP',
        'drop index': 'DROP',
        'truncate table': 'TRUNCATE',
    };

    const operation = operationMap[normalizedType];
    if (operation) {
        return { operation, category: 'write' };
    }

    return { operation: 'OTHER', category: 'unknown' };
}

function classifyCteStatement(statement: Record<string, unknown>): {
    operation: SqlOperation;
    category: SqlCategory;
} {
    const bindings = statement.bind;
    if (!Array.isArray(bindings) || bindings.length === 0) {
        return { operation: 'OTHER', category: 'unknown' };
    }

    for (const binding of bindings) {
        if (!isObject(binding) || !isObject(binding.statement)) {
            return { operation: 'OTHER', category: 'unknown' };
        }

        const cteStatement = binding.statement;
        const cteType = String(cteStatement.type ?? '').toLowerCase();

        let result: { operation: SqlOperation; category: SqlCategory };
        if (cteType === 'with') {
            result = classifyCteStatement(cteStatement);
        } else {
            result = classifyStatementType(String(cteStatement.type ?? ''));
        }

        if (result.category !== 'read') {
            return result;
        }
    }

    const innerStatement = statement.in;
    if (!isObject(innerStatement) || !('type' in innerStatement)) {
        return { operation: 'OTHER', category: 'unknown' };
    }

    const innerType = String(innerStatement.type ?? '').toLowerCase();
    if (innerType === 'with') {
        return classifyCteStatement(innerStatement);
    }
    return classifyStatementType(String(innerStatement.type ?? ''));
}

function classifySingleStatement(statement: unknown): {
    operation: SqlOperation;
    category: SqlCategory;
    statementType: string;
} {
    if (!isObject(statement) || !('type' in statement)) {
        return { operation: 'OTHER', category: 'unknown', statementType: 'unknown' };
    }

    const statementType = String(statement.type);
    const normalizedType = statementType.toLowerCase();

    if (normalizedType === 'with') {
        const result = classifyCteStatement(statement);
        return { ...result, statementType };
    }

    return { ...classifyStatementType(statementType), statementType };
}

function validateReadPolicy(statement: unknown): string[] {
    const errors: string[] = [];

    if (containsNodeType(statement, DISALLOWED_STATEMENT_TYPES)) {
        errors.push('Write operations are not allowed in read queries');
    }

    const disallowedFunc = containsDisallowedFunction(statement);
    if (disallowedFunc) {
        errors.push(`Function '${disallowedFunc}' is not allowed`);
    }

    if (containsUnsafeSelect(statement)) {
        errors.push('Row-locking clauses (FOR UPDATE/SHARE) and SELECT INTO are not allowed');
    }

    return errors;
}

function validateWritePolicy(statement: unknown): string[] {
    const errors: string[] = [];

    if (!isObject(statement) || !hasSupportedWriteStructure(statement)) {
        errors.push('Unsupported write statement structure');
    }

    const disallowedFunc = containsDisallowedFunction(statement);
    if (disallowedFunc) {
        errors.push(`Function '${disallowedFunc}' is not allowed`);
    }

    if (containsUnsafeSelect(statement)) {
        errors.push('SQL contains an unsupported SELECT operation');
    }

    if (containsConcurrently(statement)) {
        errors.push('CONCURRENTLY is not supported because it cannot run inside a transaction');
    }

    return errors;
}

function hasSupportedWriteStructure(statement: Record<string, unknown>): boolean {
    if (statement.type !== 'with') {
        return SUPPORTED_WRITE_TYPES.has(String(statement.type).toLowerCase());
    }

    const bindings = statement.bind;
    const finalStatement = statement.in;

    if (!Array.isArray(bindings) || bindings.length === 0 || !isObject(finalStatement)) {
        return false;
    }

    for (const binding of bindings) {
        if (!isObject(binding) || !isObject(binding.statement)) {
            return false;
        }
        if (containsWriteStatement(binding.statement)) {
            return false;
        }
    }

    return SUPPORTED_WRITE_TYPES.has(String(finalStatement.type).toLowerCase());
}

function containsWriteStatement(node: unknown): boolean {
    if (Array.isArray(node)) {
        return node.some((item) => containsWriteStatement(item));
    }
    if (!isObject(node)) {
        return false;
    }
    const type = String(node.type ?? '').toLowerCase();
    if (SUPPORTED_WRITE_TYPES.has(type)) {
        return true;
    }
    return Object.values(node).some((value) => containsWriteStatement(value));
}

export class SqlAnalysisService {
    analyze(sql: string): SqlAnalysis {
        const errors: string[] = [];

        if (!sql || !sql.trim()) {
            return {
                statementCount: 0,
                operation: 'OTHER',
                category: 'unknown',
                isSupported: false,
                validationErrors: ['SQL query cannot be empty'],
                requiresApproval: false,
                statementType: 'empty',
            };
        }

        if (sql.length > 50_000) {
            return {
                statementCount: 0,
                operation: 'OTHER',
                category: 'unknown',
                isSupported: false,
                validationErrors: ['SQL query exceeds the maximum length of 50,000 characters'],
                requiresApproval: false,
                statementType: 'oversized',
            };
        }

        let statements: unknown[];
        try {
            statements = parse(sql);
        } catch (error) {
            return {
                statementCount: 0,
                operation: 'OTHER',
                category: 'unknown',
                isSupported: false,
                validationErrors: [
                    error instanceof Error
                        ? `Invalid SQL syntax: ${error.message}`
                        : 'Invalid SQL syntax',
                ],
                requiresApproval: false,
                statementType: 'invalid',
            };
        }

        if (statements.length !== 1) {
            return {
                statementCount: statements.length,
                operation: 'OTHER',
                category: 'unknown',
                isSupported: false,
                validationErrors: [
                    `Expected exactly one SQL statement, but found ${statements.length}`,
                ],
                requiresApproval: false,
                statementType: 'multiple',
            };
        }

        const statement = statements[0];
        const { operation, category, statementType } = classifySingleStatement(statement);

        const isRead = category === 'read';
        const policyErrors = isRead
            ? validateReadPolicy(statement)
            : validateWritePolicy(statement);
        errors.push(...policyErrors);

        const isSupported =
            (category !== 'unknown' && SUPPORTED_WRITE_OPERATIONS.has(operation)) ||
            category === 'read';
        const requiresApproval = category === 'write' && isSupported;

        return {
            statementCount: 1,
            operation,
            category,
            isSupported: isSupported && errors.length === 0,
            validationErrors: errors,
            requiresApproval,
            statementType,
        };
    }

    analyzeRead(sql: string): SqlAnalysis {
        const analysis = this.analyze(sql);
        if (analysis.category !== 'read') {
            return {
                ...analysis,
                isSupported: false,
                validationErrors: [
                    ...analysis.validationErrors,
                    'Only read operations (SELECT/WITH) are allowed',
                ],
            };
        }
        return analysis;
    }

    analyzeWrite(sql: string): SqlAnalysis {
        const analysis = this.analyze(sql);
        if (analysis.category !== 'write') {
            return {
                ...analysis,
                isSupported: false,
                validationErrors: [
                    ...analysis.validationErrors,
                    'Only write operations are allowed',
                ],
            };
        }
        if (!SUPPORTED_WRITE_OPERATIONS.has(analysis.operation)) {
            return {
                ...analysis,
                isSupported: false,
                validationErrors: [
                    ...analysis.validationErrors,
                    `Operation ${analysis.operation} is not supported`,
                ],
            };
        }
        return analysis;
    }
}
