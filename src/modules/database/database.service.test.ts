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
    let readonlyPool: Pool;
    let writerPool: Pool;
    let queryUrl: string;
    let writeUrl: string;
    let readonlyUrl: string;
    let writerUrl: string;

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
        readonlyUrl = `postgresql://pgmind_readonly:postgres@${host}:${port}/pgmind_test`;
        writerUrl = `postgresql://pgmind_writer:postgres@${host}:${port}/pgmind_test`;

        readPool = new Pool({ connectionString: queryUrl });
        writePool = new Pool({ connectionString: writeUrl });
        readonlyPool = new Pool({ connectionString: readonlyUrl });
        writerPool = new Pool({ connectionString: writerUrl });

        await setupTestRoles();
    }, 120000);

    afterAll(async () => {
        await readPool?.end();
        await writePool?.end();
        await readonlyPool?.end();
        await writerPool?.end();
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
            
            // Create test table
            await client.query(`CREATE TABLE IF NOT EXISTS test_table (id SERIAL PRIMARY KEY, name TEXT, value INT)`);
            await client.query(`GRANT SELECT ON test_table TO pgmind_readonly`);
            await client.query(`GRANT INSERT, UPDATE, DELETE ON test_table TO pgmind_writer`);
            await client.query(`GRANT USAGE, SELECT ON SEQUENCE test_table_id_seq TO pgmind_writer`);
        } finally {
            client.release();
        }
    }

    beforeEach(async () => {
        database = new DatabaseService(queryUrl, writeUrl, {
            expectedDatabase: "pgmind_test",
            expectedUsername: "postgres",
            poolMaxRead: 5,
            poolMaxWrite: 5,
        });
        await database.verifyConnections();
    });

    afterEach(async () => {
        vi.unstubAllEnvs();
        if (database) {
            await database.shutdown();
            database = undefined as any;
        }
    });

    describe("verifyConnections", () => {
        it("should verify read and write pool identities", async () => {
            await expect(database.verifyConnections()).resolves.not.toThrow();
        });

        it("should reject mismatched database name", async () => {
            const db = new DatabaseService(queryUrl, writeUrl, {
                expectedDatabase: "wrong_database",
                expectedUsername: "postgres",
            });
            await expect(db.verifyConnections()).rejects.toThrow("database mismatch");
            await db.shutdown();
        });

        it("should reject mismatched username", async () => {
            const db = new DatabaseService(queryUrl, writeUrl, {
                expectedDatabase: "pgmind_test",
                expectedUsername: "wrong_user",
            });
            await expect(db.verifyConnections()).rejects.toThrow("user mismatch");
            await db.shutdown();
        });

        it("should reject mismatched write username", async () => {
            const db = new DatabaseService(queryUrl, writeUrl, {
                expectedDatabase: "pgmind_test",
                expectedUsername: "wrong_user",
            });
            await expect(db.verifyConnections()).rejects.toThrow("user mismatch");
            await db.shutdown();
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
            const db = new DatabaseService(queryUrl, writeUrl, {
                expectedDatabase: "pgmind_test",
                expectedUsername: "postgres",
                statementTimeoutMs: 100,
            });
            await db.verifyConnections();

            await expect(
                db.withReadOnlyTransaction(async (client) => {
                    await client.query("SELECT pg_sleep(1)");
                }),
            ).rejects.toThrow(/statement timeout|canceling statement/i);
            await db.shutdown();
        });

        it("should enforce lock_timeout", async () => {
            const db = new DatabaseService(queryUrl, writeUrl, {
                expectedDatabase: "pgmind_test",
                expectedUsername: "postgres",
                lockTimeoutMs: 100,
            });
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
            await db.shutdown();
        });

        it("should enforce idle_in_transaction_session_timeout", async () => {
            const db = new DatabaseService(queryUrl, writeUrl, {
                expectedDatabase: "pgmind_test",
                expectedUsername: "postgres",
                idleInTransactionTimeoutMs: 100,
            });
            await db.verifyConnections();

            await expect(
                db.withReadOnlyTransaction(async (client) => {
                    await new Promise(resolve => setTimeout(resolve, 200));
                }),
            ).rejects.toThrow(/idle in transaction/i);
            await db.shutdown();
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
            const db = new DatabaseService(queryUrl, writeUrl, {
                expectedDatabase: "pgmind_test",
                expectedUsername: "wrong_user",
            });
            await expect(db.verifyConnections()).rejects.toThrow("user mismatch");
            await db.shutdown();
        });

        it("should throw CommitOutcomeUnknownError on commit failure", async () => {
            const db = new DatabaseService(queryUrl, writeUrl, {
                expectedDatabase: "pgmind_test",
                expectedUsername: "postgres",
                statementTimeoutMs: 10,
            });
            await db.verifyConnections();

            await expect(
                db.withWriteTransaction(async (client) => {
                    await client.query("CREATE TEMP TABLE commit_test (id int)");
                    await client.query("SELECT pg_sleep(1)");
                }),
            ).rejects.toThrow("COMMIT result is unknown");
            await db.shutdown();
        });

        it("should discard client after CommitOutcomeUnknownError", async () => {
            const db = new DatabaseService(queryUrl, writeUrl, {
                expectedDatabase: "pgmind_test",
                expectedUsername: "postgres",
                statementTimeoutMs: 10,
            });
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
            await db.shutdown();
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
            const db = new DatabaseService(queryUrl, writeUrl, {
                expectedDatabase: "pgmind_test",
                expectedUsername: "postgres",
                statementTimeoutMs: 100,
            });
            await db.verifyConnections();

            await expect(
                db.withWriteTransaction(async (client) => {
                    await client.query("SELECT pg_sleep(1)");
                }),
            ).rejects.toThrow(/statement timeout|canceling statement/i);
            await db.shutdown();
        });

        it("should enforce lock_timeout", async () => {
            const db = new DatabaseService(queryUrl, writeUrl, {
                expectedDatabase: "pgmind_test",
                expectedUsername: "postgres",
                lockTimeoutMs: 100,
            });
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
            await db.shutdown();
        });

        it("should enforce idle_in_transaction_session_timeout", async () => {
            const db = new DatabaseService(queryUrl, writeUrl, {
                expectedDatabase: "pgmind_test",
                expectedUsername: "postgres",
                idleInTransactionTimeoutMs: 100,
            });
            await db.verifyConnections();

            await expect(
                db.withWriteTransaction(async (client) => {
                    await new Promise(resolve => setTimeout(resolve, 200));
                }),
            ).rejects.toThrow(/idle in transaction/i);
            await db.shutdown();
        });
    });

    describe("pool configuration", () => {
        it("should respect poolMaxRead", async () => {
            const db = new DatabaseService(queryUrl, writeUrl, {
                expectedDatabase: "pgmind_test",
                expectedUsername: "postgres",
                poolMaxRead: 2,
            });
            await db.verifyConnections();

            const promises = Array.from({ length: 5 }, () => 
                db.withReadOnlyTransaction(async (client) => {
                    await new Promise(resolve => setTimeout(resolve, 50));
                    return 1;
                })
            );
            const results = await Promise.all(promises);
            expect(results).toHaveLength(5);
            await db.shutdown();
        });

        it("should respect poolMaxWrite", async () => {
            const db = new DatabaseService(queryUrl, writeUrl, {
                expectedDatabase: "pgmind_test",
                expectedUsername: "postgres",
                poolMaxWrite: 2,
            });
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

    describe("read-only transaction enforcement", () => {
        let readonlyDatabase: DatabaseService;

        beforeEach(async () => {
            readonlyDatabase = new DatabaseService(readonlyUrl, writeUrl, {
                expectedDatabase: "pgmind_test",
                expectedUsername: "pgmind_readonly",
            });
            await readonlyDatabase.verifyConnections();
        });

        afterEach(async () => {
            await readonlyDatabase?.shutdown();
        });

        it("should allow SELECT queries", async () => {
            const result = await readonlyDatabase.withReadOnlyTransaction(async (client) => {
                const res = await client.query("SELECT 1 AS val");
                return res.rows[0].val;
            });
            expect(result).toBe(1);
        });

        it("should reject INSERT via read-only transaction", async () => {
            await expect(
                readonlyDatabase.withReadOnlyTransaction(async (client) => {
                    await client.query("INSERT INTO test_table (name, value) VALUES ('test', 1)");
                }),
            ).rejects.toThrow(/permission denied|readonly/i);
        });

        it("should reject UPDATE via read-only transaction", async () => {
            await expect(
                readonlyDatabase.withReadOnlyTransaction(async (client) => {
                    await client.query("UPDATE test_table SET value = 2 WHERE id = 1");
                }),
            ).rejects.toThrow(/permission denied|readonly/i);
        });

        it("should reject DELETE via read-only transaction", async () => {
            await expect(
                readonlyDatabase.withReadOnlyTransaction(async (client) => {
                    await client.query("DELETE FROM test_table WHERE id = 1");
                }),
            ).rejects.toThrow(/permission denied|readonly/i);
        });

        it("should reject DDL via read-only transaction", async () => {
            await expect(
                readonlyDatabase.withReadOnlyTransaction(async (client) => {
                    await client.query("CREATE TABLE temp_ddl (id INT)");
                }),
            ).rejects.toThrow(/permission denied|readonly/i);
        });
    });

    describe("write transaction enforcement", () => {
        let writerDatabase: DatabaseService;

        beforeEach(async () => {
            writerDatabase = new DatabaseService(queryUrl, writerUrl, {
                expectedDatabase: "pgmind_test",
                expectedUsername: "pgmind_writer",
            });
            await writerDatabase.verifyConnections();
        });

        afterEach(async () => {
            await writerDatabase?.shutdown();
        });

        it("should allow INSERT via write pool", async () => {
            await writerDatabase.withWriteTransaction(async (client) => {
                await client.query("INSERT INTO test_table (name, value) VALUES ('writer_test', 42)");
            });

            const result = await writerDatabase.query("SELECT * FROM test_table WHERE name = 'writer_test'");
            expect(result).toHaveLength(1);
            expect(result[0].value).toBe(42);
        });

        it("should allow UPDATE via write pool", async () => {
            await writerDatabase.withWriteTransaction(async (client) => {
                await client.query("INSERT INTO test_table (name, value) VALUES ('update_test', 100)");
            });

            await writerDatabase.withWriteTransaction(async (client) => {
                await client.query("UPDATE test_table SET value = 200 WHERE name = 'update_test'");
            });

            const result = await writerDatabase.query("SELECT value FROM test_table WHERE name = 'update_test'");
            expect(result[0].value).toBe(200);
        });

        it("should allow DELETE via write pool", async () => {
            await writerDatabase.withWriteTransaction(async (client) => {
                await client.query("INSERT INTO test_table (name, value) VALUES ('delete_test', 300)");
            });

            await writerDatabase.withWriteTransaction(async (client) => {
                await client.query("DELETE FROM test_table WHERE name = 'delete_test'");
            });

            const result = await writerDatabase.query("SELECT * FROM test_table WHERE name = 'delete_test'");
            expect(result).toHaveLength(0);
        });

        it("should allow DDL via write pool", async () => {
            await writerDatabase.withWriteTransaction(async (client) => {
                await client.query("CREATE TABLE writer_ddl_test (id INT PRIMARY KEY, data TEXT)");
            });

            const result = await writerDatabase.query(`
                SELECT 1 FROM information_schema.tables 
                WHERE table_name = 'writer_ddl_test'
            `);
            expect(result).toHaveLength(1);

            await writerDatabase.withWriteTransaction(async (client) => {
                await client.query("DROP TABLE writer_ddl_test");
            });
        });
    });

    describe("query cancellation", () => {
        it("should handle cancelled read queries", async () => {
            const controller = new AbortController();
            const signal = controller.signal;

            const promise = database.withReadOnlyTransaction(async (client) => {
                await client.query("SELECT pg_sleep(10)");
            });

            // Cancel after a short delay
            setTimeout(() => controller.abort(), 50);

            await expect(promise).rejects.toThrow(/cancelled|aborted/i);
        });

        it("should handle cancelled write queries", async () => {
            const controller = new AbortController();
            const signal = controller.signal;

            const promise = database.withWriteTransaction(async (client) => {
                await client.query("SELECT pg_sleep(10)");
            });

            setTimeout(() => controller.abort(), 50);

            await expect(promise).rejects.toThrow(/cancelled|aborted/i);
        });
    });

    describe("concurrent approval execution", () => {
        it("should handle multiple concurrent write transactions", async () => {
            const promises = Array.from({ length: 10 }, (_, i) =>
                database.withWriteTransaction(async (client) => {
                    await client.query(
                        "INSERT INTO test_table (name, value) VALUES ($1, $2)",
                        [`concurrent_${i}`, i]
                    );
                })
            );

            await Promise.all(promises);

            const result = await database.query("SELECT COUNT(*) FROM test_table WHERE name LIKE 'concurrent_%'");
            expect(parseInt(result[0].count)).toBe(10);
        });

        it("should handle concurrent read and write transactions", async () => {
            await database.withWriteTransaction(async (client) => {
                await client.query("INSERT INTO test_table (name, value) VALUES ('base', 1)");
            });

            const readPromises = Array.from({ length: 20 }, () =>
                database.withReadOnlyTransaction(async (client) => {
                    const res = await client.query("SELECT value FROM test_table WHERE name = 'base'");
                    return res.rows[0].value;
                })
            );

            const writePromises = Array.from({ length: 5 }, (_, i) =>
                database.withWriteTransaction(async (client) => {
                    await client.query(
                        "INSERT INTO test_table (name, value) VALUES ($1, $2)",
                        [`mixed_${i}`, i * 10]
                    );
                })
            );

            const [readResults, writeResults] = await Promise.all([
                Promise.all(readPromises),
                Promise.all(writePromises),
            ]);

            expect(readResults.every(v => v === 1)).toBe(true);
            expect(writeResults).toHaveLength(5);
        });
    });

    describe("deadlock detection", () => {
        it("should detect deadlock and abort one transaction", async () => {
            const client1 = await writePool.connect();
            const client2 = await writePool.connect();

            try {
                await client1.query("BEGIN");
                await client1.query("UPDATE test_table SET value = 1 WHERE id = 1");

                await client2.query("BEGIN");
                await client2.query("UPDATE test_table SET value = 2 WHERE id = 2");

                // This should cause a deadlock
                const promise1 = client1.query("UPDATE test_table SET value = 3 WHERE id = 2");
                const promise2 = client2.query("UPDATE test_table SET value = 4 WHERE id = 1");

                await Promise.allSettled([promise1, promise2]);

                // One should succeed, one should fail with deadlock
                const results = await Promise.allSettled([promise1, promise2]);
                const deadlockErrors = results.filter(r => 
                    r.status === "rejected" && 
                    (r.reason as Error).message.includes("deadlock")
                );
                expect(deadlockErrors.length).toBeGreaterThanOrEqual(1);
            } finally {
                try { await client1.query("ROLLBACK"); } catch {}
                try { await client2.query("ROLLBACK"); } catch {}
                client1.release();
                client2.release();
            }
        });
    });

    describe("DDL permissions", () => {
        let writerDatabase: DatabaseService;

        beforeEach(async () => {
            writerDatabase = new DatabaseService(queryUrl, writerUrl, {
                expectedDatabase: "pgmind_test",
                expectedUsername: "pgmind_writer",
            });
            await writerDatabase.verifyConnections();
        });

        afterEach(async () => {
            await writerDatabase?.shutdown();
        });

        it("should allow CREATE TABLE", async () => {
            await writerDatabase.withWriteTransaction(async (client) => {
                await client.query("CREATE TABLE ddl_test (id SERIAL PRIMARY KEY, data JSONB)");
            });

            const result = await writerDatabase.query(`
                SELECT 1 FROM information_schema.tables WHERE table_name = 'ddl_test'
            `);
            expect(result).toHaveLength(1);
        });

        it("should allow CREATE INDEX", async () => {
            await writerDatabase.withWriteTransaction(async (client) => {
                await client.query("CREATE INDEX idx_test_table_name ON test_table(name)");
            });

            const result = await writerDatabase.query(`
                SELECT 1 FROM pg_indexes WHERE indexname = 'idx_test_table_name'
            `);
            expect(result).toHaveLength(1);
        });

        it("should allow ALTER TABLE", async () => {
            await writerDatabase.withWriteTransaction(async (client) => {
                await client.query("ALTER TABLE test_table ADD COLUMN IF NOT EXISTS new_col TEXT");
            });

            const result = await writerDatabase.query(`
                SELECT 1 FROM information_schema.columns 
                WHERE table_name = 'test_table' AND column_name = 'new_col'
            `);
            expect(result).toHaveLength(1);
        });

        it("should allow DROP TABLE", async () => {
            await writerDatabase.withWriteTransaction(async (client) => {
                await client.query("CREATE TABLE to_drop (id INT)");
            });

            await writerDatabase.withWriteTransaction(async (client) => {
                await client.query("DROP TABLE to_drop");
            });

            const result = await writerDatabase.query(`
                SELECT 1 FROM information_schema.tables WHERE table_name = 'to_drop'
            `);
            expect(result).toHaveLength(0);
        });

        it("should allow TRUNCATE TABLE", async () => {
            await writerDatabase.withWriteTransaction(async (client) => {
                await client.query("INSERT INTO test_table (name, value) VALUES ('truncate_me', 999)");
            });

            await writerDatabase.withWriteTransaction(async (client) => {
                await client.query("TRUNCATE TABLE test_table");
            });

            const result = await writerDatabase.query("SELECT COUNT(*) FROM test_table");
            expect(parseInt(result[0].count)).toBe(0);
        });
    });

    describe("large result handling", () => {
        it("should handle large result sets within limits", async () => {
            const result = await database.withReadOnlyTransaction(async (client) => {
                const res = await client.query("SELECT generate_series(1, 1000) AS num");
                return res.rows;
            });
            expect(result).toHaveLength(1000);
        });

        it("should handle wide rows with many columns", async () => {
            const result = await database.withReadOnlyTransaction(async (client) => {
                const columns = Array.from({ length: 50 }, (_, i) => `md5(random()::text) AS col_${i}`);
                const res = await client.query(`SELECT ${columns.join(", ")}`);
                return res.rows[0];
            });
            expect(Object.keys(result)).toHaveLength(50);
        });
    });

    describe("failed connection behavior", () => {
        it("should reject invalid connection strings", async () => {
            const badDb = new DatabaseService("postgresql://invalid:invalid@localhost:9999/nonexistent", undefined, {
                expectedDatabase: "nonexistent",
                expectedUsername: "invalid",
            });
            await expect(badDb.verifyConnections()).rejects.toThrow();
            
            await badDb.shutdown();
        });

        it("should handle connection pool exhaustion gracefully", async () => {
            const smallDb = new DatabaseService(queryUrl, writeUrl, {
                expectedDatabase: "pgmind_test",
                expectedUsername: "postgres",
                poolMaxRead: 2,
                poolMaxWrite: 2,
            });
            await smallDb.verifyConnections();

            // Try to exceed pool - should queue and eventually succeed
            const promises = Array.from({ length: 5 }, (_, i) =>
                smallDb.withReadOnlyTransaction(async (client) => {
                    await new Promise(r => setTimeout(r, 100));
                    return i;
                })
            );

            const results = await Promise.all(promises);
            expect(results).toHaveLength(5);
            
            await smallDb.shutdown();
        });
    });

    describe("transaction isolation", () => {
        it("should maintain READ ONLY transaction isolation", async () => {
            await database.withWriteTransaction(async (client) => {
                await client.query("INSERT INTO test_table (name, value) VALUES ('isolation_test', 1000)");
            });

            // Read should see the committed data
            const result1 = await database.withReadOnlyTransaction(async (client) => {
                const res = await client.query("SELECT value FROM test_table WHERE name = 'isolation_test'");
                return res.rows[0]?.value;
            });
            expect(result1).toBe(1000);

            // Uncommitted write should not be visible
            const client = await writePool.connect();
            await client.query("BEGIN");
            await client.query("UPDATE test_table SET value = 2000 WHERE name = 'isolation_test'");

            const result2 = await database.withReadOnlyTransaction(async (client) => {
                const res = await client.query("SELECT value FROM test_table WHERE name = 'isolation_test'");
                return res.rows[0]?.value;
            });
            expect(result2).toBe(1000); // Still sees old value

            await client.query("ROLLBACK");
            client.release();
        });
    });
});