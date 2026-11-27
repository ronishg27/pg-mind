import { SqlAnalysisService } from './sql-analysis.service.js';

export interface WriteValidationResult {
    valid: boolean;
    reason?: string;
}

export class WriteSqlValidator {
    private readonly analysisService = new SqlAnalysisService();

    validate(sql: string): WriteValidationResult {
        const analysis = this.analysisService.analyzeWrite(sql);

        if (!analysis.isSupported) {
            return {
                valid: false,
                reason: analysis.validationErrors.join('; '),
            };
        }

        return { valid: true };
    }
}
