import { z } from "zod";

export interface ToolError {
    code: string;
    message: string;
    retryable: boolean;
    details?: unknown;
}

export interface ToolResult<T = unknown> {
    success: boolean;
    data?: T;
    error?: ToolError;
    metadata?: {
        truncated?: boolean;
        truncatedReason?: string;
        rowCount?: number;
        executionTimeMs?: number;
        approvalId?: string;
        affectedRows?: number;
    };
}

export const ToolErrorCodeSchema = z.enum([
    "INVALID_SQL",
    "UNSUPPORTED_OPERATION",
    "PERMISSION_DENIED",
    "QUERY_TIMEOUT",
    "CONNECTION_FAILURE",
    "TRANSACTION_FAILURE",
    "APPROVAL_EXPIRED",
    "APPROVAL_ALREADY_CONSUMED",
    "APPROVAL_NOT_FOUND",
    "EXECUTION_UNKNOWN",
    "VALIDATION_FAILED",
    "RESOURCE_LIMIT_EXCEEDED",
    "CANCELLED",
    "INTERNAL_ERROR",
]);

export type ToolErrorCode = z.infer<typeof ToolErrorCodeSchema>;

export function createToolError(
    code: ToolErrorCode | string,
    message: string,
    retryable = false,
    details?: unknown,
): ToolError {
    return { code, message, retryable, details };
}

export function createSuccessResult<T>(
    data: T,
    metadata?: ToolResult<T>["metadata"],
): ToolResult<T> {
    return { success: true, data, metadata };
}

export function createErrorResult(
    error: ToolError,
): ToolResult<never> {
    return { success: false, error };
}

export function mapPostgresError(err: Error): ToolError {
    const message = err.message;
    
    // SQLSTATE error codes
    const sqlStateMatch = message.match(/SQLSTATE\s+(\w+)/i);
    const sqlState = sqlStateMatch?.[1];

    const errorMap: Record<string, ToolErrorCode> = {
        "23505": "VALIDATION_FAILED", // unique_violation
        "23503": "VALIDATION_FAILED", // foreign_key_violation
        "23502": "VALIDATION_FAILED", // not_null_violation
        "23514": "VALIDATION_FAILED", // check_violation
        "42501": "PERMISSION_DENIED", // insufficient_privilege
        "42P01": "INVALID_SQL", // undefined_table
        "42703": "INVALID_SQL", // undefined_column
        "42883": "INVALID_SQL", // undefined_function
        "42601": "INVALID_SQL", // syntax_error
        "42P07": "VALIDATION_FAILED", // duplicate_table
        "42710": "VALIDATION_FAILED", // duplicate_object
        "55P03": "TRANSACTION_FAILURE", // lock_not_available
        "40001": "TRANSACTION_FAILURE", // serialization_failure
        "40P01": "TRANSACTION_FAILURE", // deadlock_detected
        "57014": "QUERY_TIMEOUT", // query_cancelled
        "53300": "RESOURCE_LIMIT_EXCEEDED", // out_of_memory
        "53100": "RESOURCE_LIMIT_EXCEEDED", // disk_full
    };

    if (sqlState && errorMap[sqlState]) {
        return createToolError(errorMap[sqlState], message, sqlState === "57014" || sqlState === "40001" || sqlState === "40P01");
    }

    // Check for common error patterns
    if (message.includes("statement timeout") || message.includes("canceling statement")) {
        return createToolError("QUERY_TIMEOUT", message, true);
    }
    if (message.includes("lock timeout")) {
        return createToolError("QUERY_TIMEOUT", message, true);
    }
    if (message.includes("idle in transaction")) {
        return createToolError("QUERY_TIMEOUT", message, true);
    }
    if (message.includes("permission denied") || message.includes("readonly")) {
        return createToolError("PERMISSION_DENIED", message);
    }
    if (message.includes("connection") && (message.includes("refused") || message.includes("failed"))) {
        return createToolError("CONNECTION_FAILURE", message, true);
    }
    if (message.includes("not found") || message.includes("does not exist")) {
        return createToolError("INVALID_SQL", message);
    }
    if (message.includes("expired")) {
        return createToolError("APPROVAL_EXPIRED", message);
    }
    if (message.includes("already") && (message.includes("consumed") || message.includes("executed"))) {
        return createToolError("APPROVAL_ALREADY_CONSUMED", message);
    }
    if (message.includes("COMMIT result is unknown") || message.includes("execution_unknown")) {
        return createToolError("EXECUTION_UNKNOWN", message);
    }
    if (message.includes("cancelled") || message.includes("aborted")) {
        return createToolError("CANCELLED", message, true);
    }

    return createToolError("INTERNAL_ERROR", message);
}

export function handleValidationError(err: unknown): ToolError {
    if (err instanceof Error) {
        if (err.message.includes("validation") || err.message.includes("Invalid SQL")) {
            return createToolError("INVALID_SQL", err.message);
        }
    }
    return mapPostgresError(err instanceof Error ? err : new Error(String(err)));
}

export function handleApprovalError(err: unknown): ToolError {
    if (err instanceof Error) {
        const message = err.message;
        if (message.includes("expired")) {
            return createToolError("APPROVAL_EXPIRED", message);
        }
        if (message.includes("already") && (message.includes("consumed") || message.includes("executed"))) {
            return createToolError("APPROVAL_ALREADY_CONSUMED", message);
        }
        if (message.includes("not found")) {
            return createToolError("APPROVAL_NOT_FOUND", message);
        }
        if (message.includes("not approved")) {
            return createToolError("VALIDATION_FAILED", message);
        }
    }
    return mapPostgresError(err instanceof Error ? err : new Error(String(err)));
}

export const ToolAnnotations = {
    readOnly: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    readOnlyNonIdempotent: { readOnlyHint: true, destructiveHint: false, idempotentHint: false },
    writeRequiresApproval: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, title: "Write Operation (Requires Approval)" },
    writeExecutes: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, title: "Execute Approved Write Operation" },
} as const;

export function withStructuredOutput<T>(
    result: ToolResult<T>,
): { content: Array<{ type: "text"; text: string }>; structuredContent?: T } {
    if (result.success) {
        return {
            content: [{ type: "text", text: "Success" }],
            structuredContent: result.data,
        };
    }
    return {
        content: [{ type: "text", text: result.error?.message || "Unknown error" }],
    };
}