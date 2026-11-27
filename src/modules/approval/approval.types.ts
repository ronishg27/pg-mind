import type { SqlOperation } from '../query/sql-operation-classifier.js';

export type ApprovalStatus =
    | 'pending'
    | 'approved'
    | 'executing'
    | 'rejected'
    | 'expired'
    | 'executed'
    | 'failed'
    | 'execution_unknown'; // This status is used when the execution result is unknown due to an error or unexpected situation.

export interface ApprovalRequest {
    id: string;
    sql: string;
    operation: SqlOperation;
    database: string;
    connectionName?: string;
    /** Immutable connection generation/identity token assigned at preparation time.
     * Used to detect if the underlying connection instance was replaced (e.g. by
     * configuration reload) so old approvals cannot execute against replacement
     * settings. */
    connectionGeneration?: number;
    status: ApprovalStatus;
    createdAt: Date;
    expiresAt: Date;
    affectedRows?: number;
}

export interface OperationExecutionResult {
    approvalId: string;
    operation: SqlOperation;
    database: string;
    affectedRows: number;
    status: 'executed';
}
