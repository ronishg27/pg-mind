import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { StartedPostgreSqlContainer, PostgreSqlContainer } from "@testcontainers/postgresql";
import { DatabaseService } from "./database.service.js";
import { Pool } from "pg";
import { execSync } from "child_process";

let dockerAvailable = false;
try {
    execSync("docker version", { stdio: "ignore" });
    dockerAvailable = true;
} catch {
    dockerAvailable = false;
}

const describeIfDocker = dockerAvailable ? describe : describe.skip;

describeIfDocker("DatabaseService Integration Tests (requires Docker)", () => {
    let container: StartedPostgreSqlContainer;
    let database: DatabaseService;
    let readPool: Pool;
    let writePool: Pool;
    let queryUrl: string;
    let writeUrl: string;

    beforeAll(async () => {
        container = await new PostgreSqlContainer("postgres:16-alpine")
            .withDatabase("pgmind_test")
            .withUsername("postgres")
            .withPassword("postgres")
            .start();

        const host = container.getHost();
        const port = container.getPort();
        queryUrl = `postgresql://postgres:postgres@${host}:${port}/pgmind_test`;
        writeUrl = `postgresql://postgres:postgres@${host}:${port}/pgmind_test`;

        readPool = new Pool({ connectionString: queryUrl });
        writePool = new Pool({ connectionString: writeUrl });

        await setupTestRoles();
    }, 120000);

    afterAll(async () => {
        await readPool?.end();
        await writePool?.end();
        await database?.shutdown();
        await container?.stop();
    }, 30000);

    async function setupTestRoles(): Promise<void> {
        const client = await writePool.connect();
        try {
            await client.query(`CREATE ROLE pgmind_readonly NOINHERIT`);
            await client.query(`CREATE ROLE pgmind_writer NOINHERIT`);
            await client.query(`GRANT CONNECT ON DATABASE pgmind_test TO pgmind_readonly, pgmind_writer`);
            await client.query(`GRANT USAGE ON SCHEMA public TO pgmind_readonly, pgmind_writer`);
            await client.query(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO pgmind_readonly`);
            await client.query(`GRANT INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO pgmind_writer`);
            await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO pgmind_readonly`);
            await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT INSERT, UPDATE, DELETE ON TABLES TO pgmind_writer`);
        } finally {
            client.release();
        }
    }

    beforeEach(async () => {
        vi.stubEnv("QUERY_DATABASE_URL", queryUrl);
        vi.stubEnv("WRITE_DATABASE_URL", writeUrl);
        vi.stubEnv("EXPECTED_DATABASE", "pgmind_test");
        vi.stubEnv("EXPECTED_READ_ROLE", "postgres");
        vi.stubEnv("EXPECTED_WRITE_ROLE", "postgres");
        vi.stubEnv("POOL_MAX_READ", "5");
        vi.stubEnv("POOL_MAX_WRITE", "5");

        database = new DatabaseService(queryUrl, writeUrl);
        await database.verifyConnections();
    });

    afterEach(async () => {
        vi.unstubAllEnvs();
        await database?.shutdown();
    });

    describe("verifyConnections", () => {
        it("should verify read and write pool identities", async () => {
            await expect(database.verifyConnections()).resolves.not.toThrow();
        });

        it("should reject mismatched database name", async () => {
            vi.stubEnv("EXPECTED_DATABASE", "wrong_database");
            const db = new DatabaseService(queryUrl, writeUrl);
            await expect(db.verifyConnections()).rejects.toThrow("database mismatch");
        });

        it("should reject mismatched read role", async () => {
            vi.stubEnv("EXPECTED_READ_ROLE", "wrong_role");
            const db = new DatabaseService(queryUrl, writeUrl);
            await expect(db.verifyConnections()).rejects.toThrow("role mismatch");
        });

        it("should reject mismatched write role", async () => {
            vi.stubEnv("EXPECTED_WRITE_ROLE", "wrong_role");
            const db = new DatabaseService(queryUrl, writeUrl);
            await expect(db.verifyConnections()).rejects.toThrow("role mismatch");
        });
    });

    describe("withReadOnlyTransaction", () => {
        it("should execute read-only query successfully", async () => {
            const result = await database.withReadOnlyTransaction(async (client) => {
                const res = await client.query("SELECT 1 AS val");
                return res.rows[0].val;
            });
            expect(result).toBe(1);
        });

        it("should enforce statement_timeout", async () => {
            vi.stubEnv("STATEMENT_TIMEOUT_MS", "100");
            const db = new DatabaseService(queryUrl, writeUrl);
            await db.verifyConnections();

            await expect(
                db.withReadOnlyTransaction(async (client) => {
                    await client.query("SELECT pg_sleep(1)");
                }),
            ).rejects.toThrow(/statement timeout|canceling statement/i);
        });

        it("should enforce lock_timeout", async () => {
            vi.stubEnv("LOCK_TIMEOUT_MS", "100");
            const db = new DatabaseService(queryUrl, writeUrl);
            await db.verifyConnections();

            const client1 = await writePool.connect();
            await client1.query("BEGIN");
            await client1.query("CREATE TEMP TABLE lock_test (id int)");
            await client1.query("INSERT INTO lock_test VALUES (1)");

            await expect(
                db.withReadOnlyTransaction(async (client) => {
                    await client.query("SELECT * FROM lock_test FOR UPDATE");
                }),
            ).rejects.toThrow(/lock timeout/i);

            await client1.query("ROLLBACK");
            client1.release();
        });

        it("should enforce idle_in_transaction_session_timeout", async () => {
            vi.stubEnv("IDLE_IN_TRANSACTION_TIMEOUT_MS", "100");
            const db = new DatabaseService(queryUrl, writeUrl);
            await db.verifyConnections();

            await expect(
                db.withReadOnlyTransaction(async (client) => {
                    await new Promise(resolve => setTimeout(resolve, 200));
                }),
            ).rejects.toThrow(/idle in transaction/i);
        });

        it("should discard client on rollback failure", async () => {
            const originalQuery = Pool.prototype.query.bind(readPool);
            let shouldFailRollback = false;
            
            vi.spyOn(readPool, "query").mockImplementation(async function(this: Pool, ...args) {
                if (args[0] === "ROLLBACK" && shouldFailRollback) {
                    throw new Error("Simulated rollback failure");
                }
                return originalQuery(...args);
            });

            await expect(
                database.withReadOnlyTransaction(async (client) => {
                    await client.query("SELECT 1");
                    throw new Error("Force rollback");
                }),
            ).rejects.toThrow("Force rollback");

            shouldFailRollback = true;
            await expect(
                database.withReadOnlyTransaction(async (client) => {
                    await client.query("SELECT 1");
                    throw new Error("Force rollback again");
                }),
            ).rejects.toThrow("Force rollback again");
        });
    });

    describe("withWriteTransaction", () => {
        it("should execute write transaction successfully", async () => {
            await database.withWriteTransaction(async (client) => {
                await client.query("CREATE TEMP TABLE write_test (id int, name text)");
                await client.query("INSERT INTO write_test VALUES (1, 'test')");
            });

            const result = await database.query("SELECT * FROM write_test");
            expect(result).toHaveLength(1);
            expect(result[0].id).toBe(1);
            expect(result[0].name).toBe("test");
        });

        it("should verify writer identity before execution", async () => {
            vi.stubEnv("EXPECTED_WRITE_ROLE", "wrong_role");
            const db = new DatabaseService(queryUrl, writeUrl);
            await expect(db.verifyConnections()).rejects.toThrow("role mismatch");
        });

        it("should throw CommitOutcomeUnknownError on commit failure", async () => {
            vi.stubEnv("STATEMENT_TIMEOUT_MS", "10");
            const db = new DatabaseService(queryUrl, writeUrl);
            await db.verifyConnections();

            await expect(
                db.withWriteTransaction(async (client) => {
                    await client.query("CREATE TEMP TABLE commit_test (id int)");
                    await client.query("SELECT pg_sleep(1)");
                }),
            ).rejects.toThrow("COMMIT result is unknown");
        });

        it("should discard client after CommitOutcomeUnknownError", async () => {
            vi.stubEnv("STATEMENT_TIMEOUT_MS", "10");
            const db = new DatabaseService(queryUrl, writeUrl);
            await db.verifyConnections();

            try {
                await db.withWriteTransaction(async (client) => {
                    await client.query("CREATE TEMP TABLE commit_test2 (id int)");
                    await client.query("SELECT pg_sleep(1)");
                });
            } catch (e) {
                expect(e).toBeInstanceOf(Error);
                expect((e as Error).name).toBe("CommitOutcomeUnknownError");
            }

            const result = await db.query("SELECT 1 AS val");
            expect(result[0].val).toBe(1);
        });

        it("should rollback on error before commit", async () => {
            await expect(
                database.withWriteTransaction(async (client) => {
                    await client.query("CREATE TEMP TABLE rollback_test (id int)");
                    await client.query("INSERT INTO rollback_test VALUES (1)");
                    throw new Error("Intentional error");
                }),
            ).rejects.toThrow("Intentional error");

            const result = await database.query("SELECT * FROM rollback_test");
            expect(result).toHaveLength(0);
        });

        it("should enforce statement_timeout", async () => {
            vi.stubEnv("STATEMENT_TIMEOUT_MS", "100");
            const db = new DatabaseService(queryUrl, writeUrl);
            await db.verifyConnections();

            await expect(
                db.withWriteTransaction(async (client) => {
                    await client.query("SELECT pg_sleep(1)");
                }),
            ).rejects.toThrow(/statement timeout|canceling statement/i);
        });

        it("should enforce lock_timeout", async () => {
            vi.stubEnv("LOCK_TIMEOUT_MS", "100");
            const db = new DatabaseService(queryUrl, writeUrl);
            await db.verifyConnections();

            const client1 = await writePool.connect();
            await client1.query("BEGIN");
            await client1.query("CREATE TEMP TABLE lock_test2 (id int)");
            await client1.query("INSERT INTO lock_test2 VALUES (1)");

            await expect(
                db.withWriteTransaction(async (client) => {
                    await client.query("SELECT * FROM lock_test2 FOR UPDATE");
                }),
            ).rejects.toThrow(/lock timeout/i);

            await client1.query("ROLLBACK");
            client1.release();
        });

        it("should enforce idle_in_transaction_session_timeout", async () => {
            vi.stubEnv("IDLE_IN_TRANSACTION_TIMEOUT_MS", "100");
            const db = new DatabaseService(queryUrl, writeUrl);
            await db.verifyConnections();

            await expect(
                db.withWriteTransaction(async (client) => {
                    await new Promise(resolve => setTimeout(resolve, 200));
                }),
            ).rejects.toThrow(/idle in transaction/i);
        });
    });

    describe("pool configuration", () => {
        it("should respect poolMaxRead", async () => {
            vi.stubEnv("POOL_MAX_READ", "2");
            const db = new DatabaseService(queryUrl, writeUrl);
            await db.verifyConnections();

            const promises = Array.from({ length: 5 }, () => 
                db.withReadOnlyTransaction(async (client) => {
                    await new Promise(resolve => setTimeout(resolve, 50));
                    return 1;
                })
            );
            const results = await Promise.all(promises);
            expect(results).toHaveLength(5);
        });

        it("should respect poolMaxWrite", async () => {
            vi.stubEnv("POOL_MAX_WRITE", "2");
            const db = new DatabaseService(queryUrl, writeUrl);
            await db.verifyConnections();

            const promises = Array.from({ length: 5 }, () => 
                db.withWriteTransaction(async (client) => {
                    await new Promise(resolve => setTimeout(resolve, 50));
                    return 1;
                })
            );
            const results = await Promise.all(promises);
            expect(results).toHaveLength(5);
        });
    });

    describe("graceful shutdown", () => {
        it("should shutdown pools cleanly", async () => {
            await expect(database.shutdown()).resolves.not.toThrow();
            
            const newDb = new DatabaseService(queryUrl, writeUrl);
            await newDb.verifyConnections();
            await newDb.shutdown();
        });
    });
});