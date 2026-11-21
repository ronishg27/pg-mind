import type { SqlOperation } from "../query/sql-operation-classifier.js";

export type ApprovalStatus =
    | "pending"
    | "approved"
    | "executing"
    | "rejected"
    | "expired"
    | "executed"
    | "failed";

export interface ApprovalRequest {
    id: string;
    sql: string;
    operation: SqlOperation;
    database: string;
    status: ApprovalStatus;
    createdAt: Date;
    expiresAt: Date;
    affectedRows?: number;
}
