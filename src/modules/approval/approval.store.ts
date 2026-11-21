import { randomUUID } from "node:crypto";
import { ApprovalRequest, ApprovalStatus } from "./approval.types.js";

const APPROVAL_TTL_MS = 5 * 60 * 1000; // 5 minutes

// Define allowed status transitions for approval requests.
const ALLOWED_TRANSITIONS: Record<ApprovalStatus, ApprovalStatus[]> = {
    pending: ["approved", "rejected", "expired"],
    approved: ["executing", "expired"],
    executing: ["executed", "failed"],
    rejected: [],
    expired: [],
    executed: [],
    failed: [],
};

export class ApprovalStore {
    // In-memory store for approval requests.
    private readonly requests = new Map<string, ApprovalRequest>();
    create(
        input: Omit<
            ApprovalRequest,
            "id" | "status" | "createdAt" | "expiresAt"
        >,
    ): ApprovalRequest {
        const now = new Date();
        const request: ApprovalRequest = {
            ...input,
            id: randomUUID(),
            status: "pending",
            createdAt: now,
            expiresAt: new Date(now.getTime() + APPROVAL_TTL_MS),
        };

        this.requests.set(request.id, request);
        return this.cloneRequest(request);
    }

    getById(id: string): ApprovalRequest | undefined {
        const request = this.requests.get(id);
        if (!request) {
            return undefined;
        }

        this.expireIfNecessary(request);
        return this.cloneRequest(request);
    }

    updateStatus(id: string, status: ApprovalStatus): ApprovalRequest {
        const request = this.requests.get(id);

        if (!request) {
            throw new Error(`Approval request not found`);
        }

        this.expireIfNecessary(request);
        if (!ALLOWED_TRANSITIONS[request.status].includes(status)) {
            throw new Error(
                `Invalid status transition from ${request.status} to ${status}`,
            );
        }

        request.status = status;
        return this.cloneRequest(request);
    }

    deleteExpired(): number {
        let deletedCount = 0;
        const now = new Date();

        for (const [id, request] of this.requests.entries()) {
            const isExpirable =
                request.status === "pending" || request.status === "approved";

            const hasExpired = request.expiresAt <= now;

            if (request.status === "expired" || (isExpirable && hasExpired)) {
                this.requests.delete(id);
                deletedCount++;
            }
        }
        return deletedCount;
    }

    private expireIfNecessary(request: ApprovalRequest): void {
        const ifExpirable =
            request.status === "pending" || request.status === "approved";

        if (ifExpirable && request.expiresAt <= new Date()) {
            request.status = "expired";
        }
    }

    private cloneRequest(request: ApprovalRequest): ApprovalRequest {
        return {
            ...request,
            createdAt: new Date(request.createdAt),
            expiresAt: new Date(request.expiresAt),
        };
    }
}
