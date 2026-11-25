import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApprovalStore } from "./approval.store.js";

describe("ApprovalStore", () => {
    let store: ApprovalStore;

    const validInput = {
        sql: "UPDATE users SET status = 'active'",
        operation: "UPDATE" as const,
        database: "pgmind_dev",
        affectedRows: 5,
    };

    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-11-21T10:00:00Z"));
        store = new ApprovalStore();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    describe("create", () => {
        it("should create a pending approval request", () => {
            const request = store.create(validInput);

            expect(request.id).toBeDefined();
            expect(request.status).toBe("pending");
            expect(request.sql).toBe(validInput.sql);
            expect(request.operation).toBe("UPDATE");
            expect(request.database).toBe("pgmind_dev");
            expect(request.affectedRows).toBe(5);
        });

        it("should set creation and expiration timestamps", () => {
            const request = store.create(validInput);

            expect(request.createdAt).toEqual(new Date("2026-11-21T10:00:00Z"));

            expect(request.expiresAt).toEqual(new Date("2026-11-21T10:05:00Z"));
        });

        it("should generate unique IDs", () => {
            const first = store.create(validInput);
            const second = store.create(validInput);

            expect(first.id).not.toBe(second.id);
        });
    });

    describe("getById", () => {
        it("should retrieve an existing request", () => {
            const created = store.create(validInput);

            expect(store.getById(created.id)).toEqual(created);
        });

        it("should return undefined for an unknown ID", () => {
            expect(store.getById("unknown-id")).toBeUndefined();
        });

        it("should expire an overdue pending request", () => {
            const request = store.create(validInput);

            vi.advanceTimersByTime(5 * 60 * 1000);

            const result = store.getById(request.id);

            expect(result?.status).toBe("expired");
        });

        it("should not allow modifying the stored request through returned objects", () => {
            const request = store.create(validInput);

            const retrieved = store.getById(request.id);

            expect(retrieved).toBeDefined();

            if (!retrieved) return;

            retrieved.status = "executed";

            const stored = store.getById(request.id);

            expect(stored?.status).toBe("pending");
        });

        it("should return independent date objects", () => {
            const request = store.create(validInput);

            const retrieved = store.getById(request.id);

            expect(retrieved).toBeDefined();

            if (!retrieved) return;

            retrieved.expiresAt.setFullYear(2000);

            const stored = store.getById(request.id);

            expect(stored?.expiresAt.getFullYear()).not.toBe(2000);
        });
    });

    describe("updateStatus", () => {
        it("should approve a pending request", () => {
            const request = store.create(validInput);

            const updated = store.updateStatus(request.id, "approved");

            expect(updated.status).toBe("approved");
        });

        it("should reject a pending request", () => {
            const request = store.create(validInput);

            const updated = store.updateStatus(request.id, "rejected");

            expect(updated.status).toBe("rejected");
        });

        it("should allow execution after approval", () => {
            const request = store.create(validInput);

            store.updateStatus(request.id, "approved");
            store.updateStatus(request.id, "executing");
            const updated = store.updateStatus(request.id, "executed");

            expect(updated.status).toBe("executed");
        });

        it("should reject invalid status transitions", () => {
            const request = store.create(validInput);

            expect(() => store.updateStatus(request.id, "executed")).toThrow(
                "Invalid status transition",
            );
        });

        it("should not approve an expired request", () => {
            const request = store.create(validInput);

            vi.advanceTimersByTime(5 * 60 * 1000);

            expect(() => store.updateStatus(request.id, "approved")).toThrow(
                "Invalid status transition",
            );
        });

        it("should throw when the request does not exist", () => {
            expect(() => store.updateStatus("unknown-id", "approved")).toThrow(
                "Approval request not found",
            );
        });

        it("should prevent executing a request more than once", () => {
            const request = store.create(validInput);

            store.updateStatus(request.id, "approved");
            store.updateStatus(request.id, "executing");
            store.updateStatus(request.id, "executed");

            expect(() => store.updateStatus(request.id, "executed")).toThrow(
                "Invalid status transition",
            );
        });

        it("should require an executing state before execution", () => {
            const request = store.create({
                sql: "UPDATE users SET status = 'active'",
                operation: "UPDATE",
                database: "pgmind_dev",
            });

            store.updateStatus(request.id, "approved");

            expect(() => {
                store.updateStatus(request.id, "executed");
            }).toThrow();
        });

        it("should prevent claiming an approval more than once", () => {
            const request = store.create({
                sql: "UPDATE users SET status = 'active'",
                operation: "UPDATE",
                database: "pgmind_dev",
            });

            store.updateStatus(request.id, "approved");

            store.updateStatus(request.id, "executing");

            expect(() => {
                store.updateStatus(request.id, "executing");
            }).toThrow();
        });

        it("should allow an executing request to transition to failed", () => {
            const request = store.create({
                sql: "UPDATE users SET status = 'active'",
                operation: "UPDATE",
                database: "pgmind_dev",
            });

            store.updateStatus(request.id, "approved");
            store.updateStatus(request.id, "executing");

            const result = store.updateStatus(request.id, "failed");

            expect(result.status).toBe("failed");
        });

        it("should allow executing to execution_unknown", () => {
            const request = store.create({
                sql: "UPDATE products SET price = 500",
                operation: "UPDATE",
                database: "pgmind_dev",
            });

            store.updateStatus(request.id, "approved");
            store.updateStatus(request.id, "executing");

            const result = store.updateStatus(request.id, "execution_unknown");

            expect(result.status).toBe("execution_unknown");
        });

        it("should not allow retrying an execution_unknown request", () => {
            const request = store.create({
                sql: "UPDATE products SET price = 500",
                operation: "UPDATE",
                database: "pgmind_dev",
            });

            store.updateStatus(request.id, "approved");
            store.updateStatus(request.id, "executing");
            store.updateStatus(request.id, "execution_unknown");

            expect(() => store.updateStatus(request.id, "executing")).toThrow();
        });

        it("should not allow execution_unknown to become executed", () => {
            const request = store.create({
                sql: "UPDATE products SET price = 500",
                operation: "UPDATE",
                database: "pgmind_dev",
            });

            store.updateStatus(request.id, "approved");
            store.updateStatus(request.id, "executing");
            store.updateStatus(request.id, "execution_unknown");

            expect(() => store.updateStatus(request.id, "executed")).toThrow();
        });
    });

    describe("deleteExpired", () => {
        it("should delete expired pending requests", () => {
            store.create(validInput);
            store.create(validInput);

            vi.advanceTimersByTime(5 * 60 * 1000);

            expect(store.deleteExpired()).toBe(2);
        });

        it("should not delete requests that have not expired", () => {
            store.create(validInput);

            vi.advanceTimersByTime(4 * 60 * 1000);

            expect(store.deleteExpired()).toBe(0);
        });

        it("should not delete approved requests", () => {
            const request = store.create(validInput);

            store.updateStatus(request.id, "approved");

            vi.advanceTimersByTime(4 * 60 * 1000);

            expect(store.deleteExpired()).toBe(0);
        });

        it("should expire an approved request after its original TTL", () => {
            const request = store.create({
                sql: "UPDATE users SET status = 'active'",
                operation: "UPDATE",
                database: "pgmind_dev",
            });

            store.updateStatus(request.id, "approved");

            vi.advanceTimersByTime(5 * 60 * 1000);

            const result = store.getById(request.id);

            expect(result?.status).toBe("expired");
        });

        it("should not allow an expired approved request to be executed", () => {
            const request = store.create({
                sql: "UPDATE users SET status = 'active'",
                operation: "UPDATE",
                database: "pgmind_dev",
            });

            store.updateStatus(request.id, "approved");

            vi.advanceTimersByTime(5 * 60 * 1000);

            expect(() => {
                store.updateStatus(request.id, "executed");
            }).toThrow();
        });

        it("should delete expired approved requests", () => {
            const request = store.create({
                sql: "UPDATE users SET status = 'active'",
                operation: "UPDATE",
                database: "pgmind_dev",
            });

            store.updateStatus(request.id, "approved");

            vi.advanceTimersByTime(5 * 60 * 1000);

            expect(store.deleteExpired()).toBe(1);
            expect(store.getById(request.id)).toBeUndefined();
        });
    });
});
