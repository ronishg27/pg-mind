import type { ApprovalStore } from './approval.store.js';
import type { SqlOperationClassifier } from '../query/sql-operation-classifier.js';
import type { DatabaseService } from '../database/database.service.js';
import { CommitOutcomeUnknownError } from '../database/database.service.js';
import type { ConnectionRegistry } from '../database/connection-registry.js';
import type { OperationExecutionResult } from './approval.types.js';

export class OperationExecutionService {
    constructor(
        private readonly approvalStore: ApprovalStore,
        private readonly classifier: SqlOperationClassifier,
        private readonly databaseService: DatabaseService,
        private readonly connectionRegistry?: ConnectionRegistry
    ) {}

    prepareExecution(approvalId: string) {
        const request = this.approvalStore.getById(approvalId);

        if (!request) {
            throw new Error(`Approval request with ID ${approvalId} not found.`);
        }

        if (request.status !== 'approved') {
            throw new Error(
                `Approval request with ID ${approvalId} is not approved. Current status: ${request.status}`
            );
        }

        // Connection-identity integrity: if the approval was prepared against a
        // specific connection, ensure the underlying connection instance has not
        // been replaced (e.g. by configuration reload) since preparation.
        if (
            request.connectionName &&
            request.connectionGeneration !== undefined &&
            this.connectionRegistry
        ) {
            const currentGeneration = this.connectionRegistry.getConnectionGeneration(
                request.connectionName
            );
            if (currentGeneration !== request.connectionGeneration) {
                throw new Error(
                    `Connection '${request.connectionName}' has been replaced since this approval was prepared. ` +
                        `The approval cannot execute against a different connection instance.`
                );
            }
        }

        const classification = this.classifier.classify(request.sql);

        const supportedOperations = [
            'INSERT',
            'UPDATE',
            'DELETE',
            'CREATE',
            'ALTER',
            'DROP',
            'TRUNCATE',
        ];

        if (
            classification.category !== 'write' ||
            !supportedOperations.includes(classification.operation)
        ) {
            throw new Error(
                `Operation ${classification.operation} is not supported for execution.`
            );
        }

        if (classification.operation !== request.operation) {
            throw new Error(
                `Operation mismatch: expected ${request.operation}, but got ${classification.operation}.`
            );
        }

        // Claim synchronously before any database operation.
        this.approvalStore.updateStatus(approvalId, 'executing');
        return {
            approvalId: request.id,
            sql: request.sql,
            operation: request.operation,
            database: request.database,
        };
    }

    async executeOperation(
        approvalId: string,
        databaseService?: DatabaseService
    ): Promise<OperationExecutionResult> {
        const execution = this.prepareExecution(approvalId);

        let affectedRows: number;
        const db = databaseService ?? this.databaseService;

        try {
            affectedRows = await db.withWriteTransaction(async (client) => {
                const result = await client.query(execution.sql);

                return result.rowCount ?? 0;
            });
        } catch (error) {
            if (error instanceof CommitOutcomeUnknownError) {
                this.approvalStore.updateStatus(approvalId, 'execution_unknown');
            } else {
                this.approvalStore.updateStatus(approvalId, 'failed');
            }

            throw error;
        }

        this.approvalStore.updateStatus(approvalId, 'executed');

        return {
            approvalId: execution.approvalId,
            operation: execution.operation,
            database: execution.database,
            affectedRows,
            status: 'executed',
        };
    }
}
