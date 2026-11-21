import type { OperationExecutionService } from "./operation-execution.service.js";

export class OperationExecutionWorkflowService {
    constructor(private readonly executionService: OperationExecutionService) {}

    async execute(approvalId: string) {
        const result = await this.executionService.executeOperation(approvalId);

        return {
            approvalId: result.approvalId,
            operation: result.operation,
            database: result.database,
            affectedRows: result.affectedRows,
            status: result.status,
            message: `${result.operation} operation executed successfully.`,
        };
    }
}
