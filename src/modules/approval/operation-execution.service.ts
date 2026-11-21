import type { ApprovalStore } from "./approval.store.js";
import type { WriteSqlValidator } from "../query/write-sql-validator.js";
import type { SqlOperationClassifier } from "../query/sql-operation-classifier.js";
import type { DatabaseService } from "../database/database.service.js";
import { CommitOutcomeUnknownError } from "../database/database.service.js";
import type { OperationExecutionResult } from "./approval.types.js";

export class OperationExecutionService {
    constructor(
        private readonly approvalStore: ApprovalStore,
        private readonly validator: WriteSqlValidator,
        private readonly classifier: SqlOperationClassifier,
        private readonly databaseService: DatabaseService,
    ) {}

    prepareExecution(approvalId: string) {
        const request = this.approvalStore.getById(approvalId);

        if (!request) {
            throw new Error(
                `Approval request with ID ${approvalId} not found.`,
            );
        }

        if (request.status !== "approved") {
            throw new Error(
                `Approval request with ID ${approvalId} is not approved. Current status: ${request.status}`,
            );
        }

        const validation = this.validator.validate(request.sql);

        if (!validation.valid) {
            throw new Error(
                `SQL validation failed for approval request with ID ${approvalId}. Reason: ${validation.reason}`,
            );
        }

        const classification = this.classifier.classify(request.sql);

        const supportedOperations = ["INSERT", "UPDATE", "DELETE"];

        if (
            classification.category !== "write" ||
            !supportedOperations.includes(classification.operation)
        ) {
            throw new Error(
                `Operation ${classification.operation} is not supported for execution.`,
            );
        }

        if (classification.operation !== request.operation) {
            throw new Error(
                `Operation mismatch: expected ${request.operation}, but got ${classification.operation}.`,
            );
        }

        // Claim synchronously before any database operation.
        this.approvalStore.updateStatus(approvalId, "executing");
        return {
            approvalId: request.id,
            sql: request.sql,
            operation: request.operation,
            database: request.database,
        };
    }

    async executeOperation(
        approvalId: string,
    ): Promise<OperationExecutionResult> {
        const execution = this.prepareExecution(approvalId);

        let affectedRows: number;

        try {
            affectedRows = await this.databaseService.withWriteTransaction(
                execution.database,
                async (client) => {
                    const result = await client.query(execution.sql);

                    return result.rowCount ?? 0;
                },
            );
        } catch (error) {
            if (error instanceof CommitOutcomeUnknownError) {
                this.approvalStore.updateStatus(
                    approvalId,
                    "execution_unknown",
                );
            } else {
                this.approvalStore.updateStatus(approvalId, "failed");
            }

            throw error;
        }

        this.approvalStore.updateStatus(approvalId, "executed");

        return {
            approvalId: execution.approvalId,
            operation: execution.operation,
            database: execution.database,
            affectedRows,
            status: "executed",
        };
    }
}
