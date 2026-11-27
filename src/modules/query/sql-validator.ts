import { SqlAnalysisService } from './sql-analysis.service.js';

export interface ValidationResult {
    valid: boolean;
    reason?: string;
}

export class SqlValidator {
    private readonly analysisService = new SqlAnalysisService();

    validate(sql: string): ValidationResult {
        const analysis = this.analysisService.analyzeRead(sql);

        if (!analysis.isSupported) {
            return {
                valid: false,
                reason: analysis.validationErrors.join('; '),
            };
        }

        return { valid: true };
    }
}
