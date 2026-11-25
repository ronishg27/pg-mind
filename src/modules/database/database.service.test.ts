import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DatabaseService } from "./database.service.js";
import { CommitOutcomeUnknownError } from "./database.service.js";

const mockQuery = vi.fn();
const mockRelease = vi.fn();
const mockConnect = vi.fn();

vi.mock("pg", () => {
    const MockPool = vi.fn(function Pool(this: any) {
        this.connect = mockConnect;
    });
    return { Pool: MockPool };
});

beforeEach(() => {
    mockConnect.mockReset();
    mockQuery.mockReset();
    mockRelease.mockReset();

    mockConnect.mockResolvedValue({
        query: mockQuery,
        release: mockRelease,
    });
});

describe("DatabaseService.withWriteTransaction", () => {
    it("throws when the write pool is not configured", async () => {
        const database = new DatabaseService("postgres://read");
        await expect(
            database.withWriteTransaction("pgmind_dev", async () => {}),
        ).rejects.toThrow("Write pool is not configured");
    });

    it("returns the callback result and commits on success", async () => {
        mockQuery
            .mockResolvedValueOnce({}) // BEGIN
            .mockResolvedValueOnce({
                rows: [{ database: "pgmind_dev", role: "pgmind_writer" }],
            }) // identity check
            .mockResolvedValueOnce({}) // SET LOCAL statement_timeout
            .mockResolvedValueOnce({}); // COMMIT

        const database = new DatabaseService(
            "postgres://read",
            "postgres://write",
        );
        const result = await database.withWriteTransaction(
            "pgmind_dev",
            async () => "done",
        );

        expect(result).toBe("done");
        expect(mockQuery).toHaveBeenNthCalledWith(1, "BEGIN");
        expect(mockQuery).toHaveBeenNthCalledWith(4, "COMMIT");
        // Client returned to the pool for reuse (no release error).
        expect(mockRelease).toHaveBeenCalledWith(undefined);
    });

    it("throws the original SQL error when the callback fails and rollback succeeds", async () => {
        mockQuery
            .mockResolvedValueOnce({}) // BEGIN
            .mockResolvedValueOnce({
                rows: [{ database: "pgmind_dev", role: "pgmind_writer" }],
            }) // identity check
            .mockResolvedValueOnce({}) // SET LOCAL statement_timeout
            .mockResolvedValueOnce({}); // ROLLBACK

        const database = new DatabaseService(
            "postgres://read",
            "postgres://write",
        );
        const sqlError = new Error("SQL failed");
        await expect(
            database.withWriteTransaction("pgmind_dev", async () => {
                throw sqlError;
            }),
        ).rejects.toBe(sqlError);

        expect(mockQuery).toHaveBeenLastCalledWith("ROLLBACK");
        // Client returned to the pool for reuse (rollback succeeded).
        expect(mockRelease).toHaveBeenCalledWith(undefined);
    });

    it("throws the original SQL error (not the rollback error) and removes the client from the pool when rollback also fails", async () => {
        mockQuery
            .mockResolvedValueOnce({}) // BEGIN
            .mockResolvedValueOnce({
                rows: [{ database: "pgmind_dev", role: "pgmind_writer" }],
            }) // identity check
            .mockResolvedValueOnce({}) // SET LOCAL statement_timeout
            .mockRejectedValueOnce(new Error("rollback failed")); // ROLLBACK

        const database = new DatabaseService(
            "postgres://read",
            "postgres://write",
        );
        const sqlError = new Error("SQL failed");
        await expect(
            database.withWriteTransaction("pgmind_dev", async () => {
                throw sqlError;
            }),
        ).rejects.toBe(sqlError);

        expect(mockQuery).toHaveBeenLastCalledWith("ROLLBACK");
        // Client removed from the pool (uncertain connection not reused).
        expect(mockRelease).toHaveBeenCalledWith(expect.any(Error));
    });

    it("throws CommitOutcomeUnknownError and removes the client from the pool when COMMIT fails", async () => {
        mockQuery
            .mockResolvedValueOnce({}) // BEGIN
            .mockResolvedValueOnce({
                rows: [{ database: "pgmind_dev", role: "pgmind_writer" }],
            }) // identity check
            .mockResolvedValueOnce({}) // SET LOCAL statement_timeout
            .mockRejectedValueOnce(new Error("commit failed")) // COMMIT
            .mockResolvedValueOnce({}); // ROLLBACK (outer catch)

        const database = new DatabaseService(
            "postgres://read",
            "postgres://write",
        );
        await expect(
            database.withWriteTransaction("pgmind_dev", async () => 1),
        ).rejects.toBeInstanceOf(CommitOutcomeUnknownError);

        expect(mockQuery).toHaveBeenNthCalledWith(4, "COMMIT");
        // Client removed from the pool (commit outcome unknown).
        expect(mockRelease).toHaveBeenCalledWith(expect.any(Error));
    });

    it("throws an identity mismatch error with expected and actual values", async () => {
        mockQuery
            .mockResolvedValueOnce({}) // BEGIN
            .mockResolvedValueOnce({
                rows: [{ database: "other_db", role: "other_role" }],
            }) // identity check (mismatch)
            .mockResolvedValueOnce({}); // ROLLBACK

        const database = new DatabaseService(
            "postgres://read",
            "postgres://write",
        );
        await expect(
            database.withWriteTransaction("pgmind_dev", async () => {}),
        ).rejects.toThrow(
            "Writer connection identity mismatch. Expected database: pgmind_dev, role: pgmind_writer. Got database: other_db, role: other_role",
        );

        expect(mockQuery).toHaveBeenLastCalledWith("ROLLBACK");
        expect(mockRelease).toHaveBeenCalledWith(undefined);
    });
});
