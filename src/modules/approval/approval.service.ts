import type { DatabaseService } from '../database/database.service.js';
import type { SqlOperationClassifier } from '../query/sql-operation-classifier.js';
import type { SqlAnalysisService } from '../query/sql-analysis.service.js';
import type { ApprovalStore } from './approval.store.js';

export class ApprovalService {
    constructor(
        private readonly approvalStore: ApprovalStore,
        private readonly classifier: SqlOperationClassifier,
        private readonly analysisService: SqlAnalysisService,
        private readonly databaseService: DatabaseService
    ) {}

    async prepareOperation(
        sql: string,
        connectionName?: string,
        databaseService?: DatabaseService,
        connectionGeneration?: number
    ) {
        const analysis = this.analysisService.analyzeWrite(sql);

        if (!analysis.isSupported) {
            throw new Error(`Unsupported write operation: ${analysis.validationErrors.join('; ')}`);
        }

        const db = databaseService ?? this.databaseService;

        const databaseResult = await db.query<{
            database: string;
        }>('SELECT current_database() as database');

        const database = databaseResult[0]?.database;

        if (!database) {
            throw new Error('Unable to identify the current database.');
        }

        return this.approvalStore.create({
            sql,
            operation: analysis.operation,
            database,
            connectionName,
            connectionGeneration,
        });
    }

    getApproval(id: string) {
        const request = this.approvalStore.getById(id);

        if (!request) {
            throw new Error('Approval request not found.');
        }

        return request;
    }

    approveOperation(id: string) {
        return this.approvalStore.updateStatus(id, 'approved');
    }

    rejectOperation(id: string) {
        return this.approvalStore.updateStatus(id, 'rejected');
    }
}
