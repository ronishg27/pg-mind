import { describe, expect, it, vi } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { McpApprovalConfirmationProvider } from './mcp-approval-confirmation.provider.js';
import type { ApprovalRequest } from './approval.types.js';

type RequestedSchemaProperties = {
    decision: {
        type: string;
        title: string;
        description: string;
        oneOf: Array<{ const: string; title: string }>;
        default: string;
    };
};

type ElicitParams = {
    message: string;
    requestedSchema: {
        properties: RequestedSchemaProperties;
        required: string[];
    };
};

describe('McpApprovalConfirmationProvider', () => {
    const request: ApprovalRequest = {
        id: 'test-approval-id',
        sql: 'UPDATE products SET price = 500 WHERE id = 1',
        operation: 'UPDATE',
        database: 'pgmind_dev',
        status: 'pending',
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 300_000),
    };

    function createProvider(response: unknown) {
        const elicitInput = vi.fn().mockResolvedValue(response);

        const server = {
            server: { elicitInput },
        } as unknown as McpServer;

        return {
            provider: new McpApprovalConfirmationProvider(server),
            elicitInput,
        };
    }

    const input = {
        request,
        summary: 'Updates the price of product with ID 1.',
    };

    it('should approve when the user explicitly approves', async () => {
        const { provider } = createProvider({
            action: 'accept',
            content: { decision: 'approve' },
        });

        await expect(provider.confirm(input)).resolves.toBe('approve');
    });

    it('should reject when the user explicitly rejects', async () => {
        const { provider } = createProvider({
            action: 'accept',
            content: { decision: 'reject' },
        });

        await expect(provider.confirm(input)).resolves.toBe('reject');
    });

    it('should reject when elicitation is declined', async () => {
        const { provider } = createProvider({
            action: 'decline',
        });

        await expect(provider.confirm(input)).resolves.toBe('reject');
    });

    it('should cancel when the user cancels', async () => {
        const { provider } = createProvider({
            action: 'cancel',
        });

        await expect(provider.confirm(input)).resolves.toBe('cancel');
    });

    it('should cancel when the response is incomplete', async () => {
        const { provider } = createProvider({
            action: 'accept',
            content: {},
        });

        await expect(provider.confirm(input)).resolves.toBe('cancel');
    });

    it('should cancel when the decision is an unexpected value', async () => {
        const { provider } = createProvider({
            action: 'accept',
            content: { decision: 'maybe' },
        });

        await expect(provider.confirm(input)).resolves.toBe('cancel');
    });

    it('should propagate elicitation errors', async () => {
        const { provider } = createProvider(Promise.reject(new Error('Elicitation unavailable')));

        await expect(provider.confirm(input)).rejects.toThrow('Elicitation unavailable');
    });

    it('should display the complete SQL and summary', async () => {
        const { provider, elicitInput } = createProvider({
            action: 'cancel',
        });

        await provider.confirm(input);

        const params = elicitInput.mock.calls[0][0] as ElicitParams;

        expect(params.message).toContain(input.summary);
        expect(params.message).toContain(request.database);
        expect(params.message).toContain(request.operation);
        expect(params.message).toContain(request.sql);
    });

    it('should display severity, emoji, and explanation for UPDATE', async () => {
        const { provider, elicitInput } = createProvider({
            action: 'cancel',
        });

        await provider.confirm(input);

        const params = elicitInput.mock.calls[0][0] as ElicitParams;

        expect(params.message).toContain('PGMind — Approval Required');
        expect(params.message).toContain('🟡 MODERATE RISK  ·  UPDATE');
        expect(params.message).toContain(
            'Modifies existing records. Verify that the conditions target the intended records.'
        );
        expect(params.message).toContain('Exact SQL to be executed:');
        expect(params.message).toContain('Approving authorizes this EXACT statement.');
    });

    it('should keep the complete SQL statement untruncated', async () => {
        const { provider, elicitInput } = createProvider({
            action: 'cancel',
        });

        await provider.confirm(input);

        const params = elicitInput.mock.calls[0][0] as ElicitParams;

        expect(params.message).toContain(request.sql);
    });

    it('should format multi-line SQL with a gutter', async () => {
        const { provider, elicitInput } = createProvider({
            action: 'cancel',
        });

        const multiLineSql = 'UPDATE products\nSET price = 500\nWHERE id = 1';
        const multiLineRequest: ApprovalRequest = {
            ...request,
            sql: multiLineSql,
        };

        await provider.confirm({ request: multiLineRequest, summary: 'summary' });

        const params = elicitInput.mock.calls[0][0] as ElicitParams;

        expect(params.message).toContain('│ UPDATE products');
        expect(params.message).toContain('│ SET price = 500');
        expect(params.message).toContain('│ WHERE id = 1');
    });

    it('should use the updated titled oneOf decision schema', async () => {
        const { provider, elicitInput } = createProvider({
            action: 'cancel',
        });

        await provider.confirm(input);

        const params = elicitInput.mock.calls[0][0] as ElicitParams;

        const decision = params.requestedSchema.properties.decision;

        expect(decision.type).toBe('string');
        expect(decision.title).toBe('Approval decision');
        expect(decision.description).toBe('Choose whether to authorize this database operation.');
        expect(decision.oneOf).toEqual([
            { const: 'approve', title: '✅ Approve operation' },
            { const: 'reject', title: '❌ Reject operation' },
        ]);
        expect(decision.default).toBe('reject');
    });

    it('should require the decision field', async () => {
        const { provider, elicitInput } = createProvider({
            action: 'cancel',
        });

        await provider.confirm(input);

        const params = elicitInput.mock.calls[0][0] as ElicitParams;

        expect(params.requestedSchema.required).toContain('decision');
    });

    const operationCases: Array<{
        operation: string;
        expectedEmoji: string;
        expectedLabel: string;
        expectedExplanation: string;
        expectedDestructiveWarning?: string;
    }> = [
        {
            operation: 'INSERT',
            expectedEmoji: '🟢',
            expectedLabel: 'LOW RISK',
            expectedExplanation: 'Adds new records to the database.',
        },
        {
            operation: 'CREATE',
            expectedEmoji: '🟢',
            expectedLabel: 'LOW RISK',
            expectedExplanation: 'Creates a new database object.',
        },
        {
            operation: 'UPDATE',
            expectedEmoji: '🟡',
            expectedLabel: 'MODERATE RISK',
            expectedExplanation:
                'Modifies existing records. Verify that the conditions target the intended records.',
        },
        {
            operation: 'ALTER',
            expectedEmoji: '🟡',
            expectedLabel: 'MODERATE RISK',
            expectedExplanation:
                'Changes the structure or configuration of an existing database object.',
        },
        {
            operation: 'DELETE',
            expectedEmoji: '🔴',
            expectedLabel: 'HIGH RISK',
            expectedExplanation: 'Removes records matching the SQL conditions.',
        },
        {
            operation: 'DROP',
            expectedEmoji: '🔴',
            expectedLabel: 'HIGH RISK',
            expectedExplanation:
                'Removes a database object. Review the target carefully before proceeding.',
            expectedDestructiveWarning:
                'Destructive operation — removes the specified database object.',
        },
        {
            operation: 'TRUNCATE',
            expectedEmoji: '🔴',
            expectedLabel: 'HIGH RISK',
            expectedExplanation:
                'Removes all rows from the specified table. Review the target table carefully.',
            expectedDestructiveWarning:
                'Destructive operation — removes all rows from the specified table.',
        },
    ];

    it.each(operationCases)(
        'should display severity, emoji, and explanation for $operation',
        async ({
            operation,
            expectedEmoji,
            expectedLabel,
            expectedExplanation,
            expectedDestructiveWarning,
        }) => {
            const { provider, elicitInput } = createProvider({
                action: 'cancel',
            });

            const operationRequest: ApprovalRequest = {
                ...request,
                operation: operation as ApprovalRequest['operation'],
            };

            const operationInput = {
                request: operationRequest,
                summary: 'A summary for the operation.',
            };

            await provider.confirm(operationInput);

            const params = elicitInput.mock.calls[
                elicitInput.mock.calls.length - 1
            ][0] as ElicitParams;

            expect(params.message).toContain(`${expectedEmoji} ${expectedLabel}  ·  ${operation}`);
            expect(params.message).toContain(expectedExplanation);

            if (expectedDestructiveWarning) {
                expect(params.message).toContain(expectedDestructiveWarning);
            }

            const properties = params.requestedSchema.properties as Record<string, unknown>;

            expect(properties.confirm_destructive).toBeUndefined();
            expect(params.requestedSchema.required).toEqual(['decision']);
        }
    );

    it('should display destructive warning for DROP and TRUNCATE', async () => {
        const { provider, elicitInput } = createProvider({
            action: 'cancel',
        });

        for (const operation of ['DROP', 'TRUNCATE']) {
            const operationRequest: ApprovalRequest = {
                ...request,
                operation: operation as ApprovalRequest['operation'],
            };

            const operationInput = {
                request: operationRequest,
                summary: 'A summary.',
            };

            await provider.confirm(operationInput);

            const params = elicitInput.mock.calls[
                elicitInput.mock.calls.length - 1
            ][0] as ElicitParams;

            expect(params.message).toContain('Destructive operation');
        }
    });

    it('should keep the complete SQL present and unchanged for each operation', async () => {
        const { provider, elicitInput } = createProvider({
            action: 'cancel',
        });

        const sqlByOperation: Record<string, string> = {
            INSERT: "INSERT INTO products (name, price) VALUES ('Widget', 9.99)",
            UPDATE: 'UPDATE products SET price = 500 WHERE id = 1',
            DELETE: 'DELETE FROM products WHERE id = 1',
            CREATE: 'CREATE TABLE test_table (id INTEGER)',
            ALTER: 'ALTER TABLE products ADD COLUMN description TEXT',
            DROP: 'DROP TABLE old_logs',
            TRUNCATE: 'TRUNCATE TABLE products',
        };

        for (const [operation, sql] of Object.entries(sqlByOperation)) {
            const operationRequest: ApprovalRequest = {
                ...request,
                operation: operation as ApprovalRequest['operation'],
                sql,
            };

            const operationInput = {
                request: operationRequest,
                summary: 'A summary.',
            };

            await provider.confirm(operationInput);

            const params = elicitInput.mock.calls[
                elicitInput.mock.calls.length - 1
            ][0] as ElicitParams;

            expect(params.message).toContain(sql);
        }
    });

    it('should preserve existing decision handling for approve, reject, decline, cancel, and error', async () => {
        const { provider } = createProvider({
            action: 'accept',
            content: { decision: 'approve' },
        });
        await expect(provider.confirm(input)).resolves.toBe('approve');

        const rejectProvider = createProvider({
            action: 'accept',
            content: { decision: 'reject' },
        });
        await expect(rejectProvider.provider.confirm(input)).resolves.toBe('reject');

        const declineProvider = createProvider({ action: 'decline' });
        await expect(declineProvider.provider.confirm(input)).resolves.toBe('reject');

        const cancelProvider = createProvider({ action: 'cancel' });
        await expect(cancelProvider.provider.confirm(input)).resolves.toBe('cancel');

        const errorProvider = createProvider(Promise.reject(new Error('Elicitation unavailable')));
        await expect(errorProvider.provider.confirm(input)).rejects.toThrow(
            'Elicitation unavailable'
        );
    });
});
