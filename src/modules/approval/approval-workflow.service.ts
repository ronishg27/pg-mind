import type { DatabaseService } from '../database/database.service.js';
import type { ApprovalService } from './approval.service.js';
import type { ApprovalConfirmationProvider } from './approval-confirmation.js';

export class ApprovalWorkflowService {
    constructor(
        private readonly approvalService: ApprovalService,
        private readonly confirmationProvider: ApprovalConfirmationProvider
    ) {}

    async prepareAndConfirm(
        sql: string,
        connectionName?: string,
        databaseService?: DatabaseService,
        connectionGeneration?: number
    ) {
        const request = await this.approvalService.prepareOperation(
            sql,
            connectionName,
            databaseService,
            connectionGeneration
        );

        const summary = this.createSummary(request.operation);

        let decision;

        try {
            decision = await this.confirmationProvider.confirm({
                request,
                summary,
            });
        } catch {
            await this.approvalService.rejectOperation(request.id);

            return {
                id: request.id,
                status: 'rejected' as const,
                message: 'Approval confirmation failed. Operation was not authorized.',
            };
        }

        if (decision === 'approve') {
            const approved = await this.approvalService.approveOperation(request.id);

            return {
                id: approved.id,
                status: approved.status,
                message: 'Operation approved. It has not been executed.',
            };
        }

        const rejected = await this.approvalService.rejectOperation(request.id);

        return {
            id: rejected.id,
            status: rejected.status,
            message:
                decision === 'cancel'
                    ? 'Approval cancelled. Operation was not authorized.'
                    : 'Operation rejected. It was not authorized.',
        };
    }

    private createSummary(operation: string): string {
        const summaries: Record<string, string> = {
            INSERT: 'Adds new records to a database table.',
            UPDATE: 'Modifies existing records in a database table.',
            DELETE: 'Removes records from a database table.',
            CREATE: 'Creates a new database object.',
            ALTER: 'Changes the structure of a database object.',
            DROP: 'Removes a database object.',
            TRUNCATE: 'Removes all records from a database table.',
        };

        return summaries[operation] ?? 'Performs a database write operation.';
    }
}
