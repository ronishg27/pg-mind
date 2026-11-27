import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { z } from 'zod';
import type { ToolError, ToolResult } from './mcp-response.js';
import { createToolError, mapPostgresError, ToolAnnotations } from './mcp-response.js';

export interface ToolHandler<Input extends z.ZodObject<z.ZodRawShape>, Output> {
    (input: z.infer<Input>): Promise<ToolResult<Output>>;
}

export interface ToolDefinition<Input extends z.ZodObject<z.ZodRawShape>, Output> {
    name: string;
    description: string;
    inputSchema: Input;
    annotations?: {
        title?: string;
        readOnlyHint?: boolean;
        destructiveHint?: boolean;
        idempotentHint?: boolean;
        openWorldHint?: boolean;
    };
    handler: ToolHandler<Input, Output>;
}

export function registerTool<Input extends z.ZodObject<z.ZodRawShape>, Output>(
    server: McpServer,
    definition: ToolDefinition<Input, Output>
): void {
    server.registerTool(
        definition.name,
        {
            description: definition.description,
            inputSchema: definition.inputSchema,
            annotations: definition.annotations,
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (async (input: any) => {
            try {
                const result = await definition.handler(input as z.infer<Input>);

                if (result.success) {
                    return {
                        content: [
                            { type: 'text' as const, text: JSON.stringify(result.data, null, 2) },
                        ],
                    };
                }

                return {
                    isError: true,
                    content: [
                        { type: 'text' as const, text: result.error?.message || 'Unknown error' },
                    ],
                };
            } catch (err) {
                const toolError =
                    err instanceof Error
                        ? mapPostgresError(err)
                        : createToolError('INTERNAL_ERROR', String(err));
                return {
                    isError: true,
                    content: [{ type: 'text' as const, text: toolError.message }],
                };
            }
        }) as
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            any
    );
}
export function createReadOnlyTool<Input extends z.ZodObject<z.ZodRawShape>, Output>(
    name: string,
    description: string,
    inputSchema: Input,
    handler: ToolHandler<Input, Output>
): ToolDefinition<Input, Output> {
    return {
        name,
        description,
        inputSchema,
        annotations: ToolAnnotations.readOnly,
        handler,
    };
}

export function createReadOnlyNonIdempotentTool<Input extends z.ZodObject<z.ZodRawShape>, Output>(
    name: string,
    description: string,
    inputSchema: Input,
    handler: ToolHandler<Input, Output>
): ToolDefinition<Input, Output> {
    return {
        name,
        description,
        inputSchema,
        annotations: ToolAnnotations.readOnlyNonIdempotent,
        handler,
    };
}

export function createWriteToolRequiresApproval<Input extends z.ZodObject<z.ZodRawShape>, Output>(
    name: string,
    description: string,
    inputSchema: Input,
    handler: ToolHandler<Input, Output>
): ToolDefinition<Input, Output> {
    return {
        name,
        description,
        inputSchema,
        annotations: ToolAnnotations.writeRequiresApproval,
        handler,
    };
}

export function createWriteToolExecutes<Input extends z.ZodObject<z.ZodRawShape>, Output>(
    name: string,
    description: string,
    inputSchema: Input,
    handler: ToolHandler<Input, Output>
): ToolDefinition<Input, Output> {
    return {
        name,
        description,
        inputSchema,
        annotations: ToolAnnotations.writeExecutes,
        handler,
    };
}

export async function executeWithCancellation<T>(
    signal: AbortSignal | undefined,
    operation: (signal: AbortSignal) => Promise<T>
): Promise<T> {
    if (!signal) {
        const fakeSignal = {
            aborted: false,
            addEventListener: () => {},
            removeEventListener: () => {},
            dispatchEvent: () => true,
        } as unknown as AbortSignal;
        return operation(fakeSignal);
    }

    if (signal.aborted) {
        throw createToolError('CANCELLED', 'Operation was cancelled', true);
    }

    return new Promise<T>((resolve, reject) => {
        const abortHandler = () => {
            reject(createToolError('CANCELLED', 'Operation was cancelled', true));
        };

        signal.addEventListener('abort', abortHandler);

        (async () => {
            try {
                const result = await operation(signal);
                resolve(result);
            } catch (err) {
                reject(err);
            } finally {
                signal.removeEventListener('abort', abortHandler);
            }
        })();
    });
}

export function handleDatabaseError(err: unknown): ToolError {
    return mapPostgresError(err instanceof Error ? err : new Error(String(err)));
}

export function handleValidationError(err: unknown): ToolError {
    if (err instanceof Error) {
        if (err.message.includes('validation') || err.message.includes('Invalid SQL')) {
            return createToolError('INVALID_SQL', err.message);
        }
    }
    return handleDatabaseError(err);
}

export function handleApprovalError(err: unknown): ToolError {
    if (err instanceof Error) {
        const message = err.message;
        if (message.includes('expired')) {
            return createToolError('APPROVAL_EXPIRED', message);
        }
        if (
            message.includes('already') &&
            (message.includes('consumed') || message.includes('executed'))
        ) {
            return createToolError('APPROVAL_ALREADY_CONSUMED', message);
        }
        if (message.includes('not found')) {
            return createToolError('APPROVAL_NOT_FOUND', message);
        }
        if (message.includes('not approved')) {
            return createToolError('VALIDATION_FAILED', message);
        }
    }
    return handleDatabaseError(err);
}
