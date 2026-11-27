import { SqlAnalysisService, type SqlAnalysis } from './sql-analysis.service.js';

export type SqlOperation =
    'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE' | 'CREATE' | 'ALTER' | 'DROP' | 'TRUNCATE' | 'OTHER';

export interface SqlClassification {
    operation: SqlOperation;
    category: 'read' | 'write' | 'unknown';
    requiresApproval: boolean;
}

export class SqlOperationClassifier {
    private readonly analysisService = new SqlAnalysisService();

    classify(sql: string): SqlClassification {
        const analysis = this.analysisService.analyze(sql);

        return {
            operation: analysis.operation,
            category: analysis.category,
            requiresApproval: analysis.requiresApproval,
        };
    }

    getAnalysis(sql: string): SqlAnalysis {
        return this.analysisService.analyze(sql);
    }
}
