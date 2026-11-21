import type { ApprovalRequest } from "./approval.types.js";

export type ApprovalDecision = "approve" | "reject" | "cancel";

export interface ApprovalConfirmationInput {
    request: ApprovalRequest;
    summary: string;
}

export interface ApprovalConfirmationProvider {
    confirm(input: ApprovalConfirmationInput): Promise<ApprovalDecision>;
}



