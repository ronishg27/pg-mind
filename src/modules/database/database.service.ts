import { Pool, type PoolClient, type QueryResultRow } from "pg";

export class DatabaseService {
    private readonly pool: Pool;
    private readonly writePool?: Pool;

    constructor(queryConnectionString: string, writeConnectionString?: string) {
        this.pool = new Pool({
            connectionString: queryConnectionString,
            max: 10,
            connectionTimeoutMillis: 5000,
            idleTimeoutMillis: 30000,
        });

        if (writeConnectionString) {
            this.writePool = new Pool({
                connectionString: writeConnectionString,
                max: 10,
                connectionTimeoutMillis: 5000,
                idleTimeoutMillis: 30000,
            });
        }
    }

    async checkConnection(): Promise<boolean> {
        const result = await this.pool.query("SELECT 1 AS connected");
        return result.rows[0].connected === 1;
    }

    async close(): Promise<void> {
        await this.pool.end();
        await this.writePool?.end();
    }

    async query<T extends QueryResultRow>(
        sql: string,
        values: unknown[] = [],
    ): Promise<T[]> {
        const result = await this.pool.query<T>(sql, values);
        return result.rows;
    }

    async withReadOnlyTransaction<T>(
        callback: (client: PoolClient) => Promise<T>,
    ): Promise<T> {
        const client = await this.pool.connect();

        try {
            await client.query("BEGIN READ ONLY");

            // Cancel queries that exceed 10 seconds.
            await client.query("SET LOCAL statement_timeout = '10s'");

            const result = await callback(client);

            await client.query("COMMIT");

            return result;
        } catch (error) {
            try {
                await client.query("ROLLBACK");
            } catch (error) {
                // preserve the original error if rollback fails
            }
            throw error;
        } finally {
            client.release();
        }
    }

    async withWriteTransaction<T>(
        expectedDatabase: string,
        callback: (client: PoolClient) => Promise<T>,
    ): Promise<T> {
        if (!this.writePool) {
            throw new Error("Write pool is not configured");
        }

        const client = await this.writePool.connect();

        let commitAttempted = false;
        let releaseError: Error | undefined;

        try {
            await client.query("BEGIN");

            // Verify the writer connection before executing anything.
            const identityResult = await client.query<{
                database: string;
                role: string;
            }>(
                `SELECT 
                    current_database() AS database, 
                    current_user AS role
                `,
            );

            const identity = identityResult.rows[0];

            // TODO: Do not hardcode the role name. Instead, fetch it from a configuration or environment variable.
            if (
                identity?.database !== expectedDatabase ||
                identity?.role !== "querymind_writer"
            ) {
                throw new Error(
                    `Writer connection identity mismatch. Expected database: ${expectedDatabase}, role: querymind_writer. Got database: ${identity?.database}, role: ${identity?.role}`,
                );
            }

            // Cancel queries that exceed 10 seconds.
            await client.query("SET LOCAL statement_timeout = '10s'");

            const result = await callback(client);

            // From this point onward, a failed COMMIT has an uncertain outcome.
            commitAttempted = true;

            try {
                await client.query("COMMIT");
            } catch (error) {
                releaseError =
                    error instanceof Error ? error : new Error(String(error));
                throw new CommitOutcomeUnknownError(releaseError);
            }
            return result;
        } catch (error) {
            try {
                await client.query("ROLLBACK");
            } catch (error) {
                // preserve the original error if rollback fails
            }
            throw error;
        } finally {
            client.release(releaseError);
        }
    }
}
// Using Pool instead of Client
// Because Pool manages multiple clients and handles connection pooling, it is more efficient for applications that require multiple database connections. The Pool class allows you to reuse connections, reducing the overhead of establishing new connections for each query.

export class CommitOutcomeUnknownError extends Error {
    constructor(cause: unknown) {
        super(
            "The COMMIT result is unknown. The operation may have been committed.",
            { cause },
        );

        this.name = "CommitOutcomeUnknownError";
    }
}
