import { DatabaseService } from "../database/database.service.js";
import { SqlOperationClassifier } from "../query/sql-operation-classifier.js";
import { SqlAnalysisService } from "../query/sql-analysis.service.js";
import { ApprovalStore } from "./approval.store.js";

export class ApprovalService {
    constructor(
        private readonly approvalStore: ApprovalStore,
        private readonly classifier: SqlOperationClassifier,
        private readonly analysisService: SqlAnalysisService,
        private readonly databaseService: DatabaseService,
    ) {}

    async prepareOperation(sql: string) {
        const analysis = this.analysisService.analyzeWrite(sql);

        if (!analysis.isSupported) {
            throw new Error(
                `Unsupported write operation: ${analysis.validationErrors.join("; ")}`,
            );
        }

        const databaseResult = await this.databaseService.query<{
            database: string;
        }>("SELECT current_database() as database");

        const database = databaseResult[0]?.database;

        if (!database) {
            throw new Error("Unable to identify the current database.");
        }

        return this.approvalStore.create({
            sql,
            operation: analysis.operation,
            database,
        });
    }

    getApproval(id: string) {
        const request = this.approvalStore.getById(id);

        if (!request) {
            throw new Error("Approval request not found.");
        }

        return request;
    }

    approveOperation(id: string) {
        return this.approvalStore.updateStatus(id, "approved");
    }

    rejectOperation(id: string) {
        return this.approvalStore.updateStatus(id, "rejected");
    }
}