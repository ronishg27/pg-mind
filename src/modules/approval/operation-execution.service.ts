import { SqlOperation } from "../query/sql-operation-classifier.js";

export interface OperationExecutionResult {
    approvalId: string;
    operation: SqlOperation;
    database: string;
    affectedRows: number;
    status: "executed";
}
