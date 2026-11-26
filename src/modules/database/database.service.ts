import config from "../../config/index.js";
import { Pool, type PoolClient, type QueryResultRow, type PoolConfig } from "pg";

export class DatabaseService {
    private readonly pool: Pool;
    private readonly writePool?: Pool;
    private readonly expectedDatabase: string;
    private readonly expectedReadRole: string;
    private readonly expectedWriteRole: string;
    private readonly expectedHost?: string;
    private readonly expectedPort?: number;

    constructor(queryConnectionString: string, writeConnectionString?: string) {
        const poolConfig: PoolConfig = {
            connectionString: queryConnectionString,
            max: config.poolMaxRead,
            connectionTimeoutMillis: config.poolConnectionTimeoutMs,
            idleTimeoutMillis: config.poolIdleTimeoutMs,
            application_name: config.applicationName,
        };

        this.pool = new Pool(poolConfig);
        this.setupPoolErrorHandlers(this.pool, "read");

        if (writeConnectionString) {
            const writePoolConfig: PoolConfig = {
                connectionString: writeConnectionString,
                max: config.poolMaxWrite,
                connectionTimeoutMillis: config.poolConnectionTimeoutMs,
                idleTimeoutMillis: config.poolIdleTimeoutMs,
                application_name: config.applicationName,
            };
            this.writePool = new Pool(writePoolConfig);
            this.setupPoolErrorHandlers(this.writePool, "write");
        }

        this.expectedDatabase = config.expectedDatabase;
        this.expectedReadRole = config.expectedReadRole;
        this.expectedWriteRole = config.expectedWriteRole;
        this.expectedHost = config.expectedHost;
        this.expectedPort = config.expectedPort;
    }

    private setupPoolErrorHandlers(pool: Pool, poolName: string): void {
        pool.on("error", (err) => {
            console.error(`Unexpected ${poolName} pool error:`, err);
        });
    }

    async verifyConnections(): Promise<void> {
        await this.verifyPool(this.pool, "read", this.expectedReadRole);
        if (this.writePool) {
            await this.verifyPool(this.writePool, "write", this.expectedWriteRole);
        }
    }

    private async verifyPool(pool: Pool, poolName: string, expectedRole: string): Promise<void> {
        const client = await pool.connect();
        try {
            const identityResult = await client.query<{
                database: string;
                role: string;
                host: string | null;
                port: number | null;
            }>(`
                SELECT 
                    current_database() AS database,
                    current_user AS role,
                    inet_server_addr() AS host,
                    inet_server_port() AS port
            `);

            const identity = identityResult.rows[0];

            if (identity?.database !== this.expectedDatabase) {
                throw new Error(
                    `${poolName} pool database mismatch. Expected: ${this.expectedDatabase}, Got: ${identity?.database}`,
                );
            }

            if (identity?.role !== expectedRole) {
                throw new Error(
                    `${poolName} pool role mismatch. Expected: ${expectedRole}, Got: ${identity?.role}`,
                );
            }

            if (this.expectedHost && identity?.host !== this.expectedHost) {
                throw new Error(
                    `${poolName} pool host mismatch. Expected: ${this.expectedHost}, Got: ${identity?.host}`,
                );
            }

            if (this.expectedPort && identity?.port !== this.expectedPort) {
                throw new Error(
                    `${poolName} pool port mismatch. Expected: ${this.expectedPort}, Got: ${identity?.port}`,
                );
            }
        } finally {
            client.release();
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

    async shutdown(): Promise<void> {
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

            await client.query(`SET LOCAL statement_timeout = '${config.statementTimeoutMs}ms'`);
            await client.query(`SET LOCAL lock_timeout = '${config.lockTimeoutMs}ms'`);
            await client.query(`SET LOCAL idle_in_transaction_session_timeout = '${config.idleInTransactionTimeoutMs}ms'`);

            const result = await callback(client);

            await client.query("COMMIT");

            return result;
        } catch (error) {
            try {
                await client.query("ROLLBACK");
            } catch (rollbackError) {
                // Rollback failed — connection state uncertain, discard the client
                client.release(rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError)));
                throw error;
            }
            throw error;
        } finally {
            client.release();
        }
    }

    async withWriteTransaction<T>(
        callback: (client: PoolClient) => Promise<T>,
    ): Promise<T> {
        if (!this.writePool) {
            throw new Error("Write pool is not configured");
        }

        const client = await this.writePool.connect();

        let commitAttempted = false;
        let commitError: Error | undefined;

        try {
            await client.query("BEGIN");

            const identityResult = await client.query<{
                database: string;
                role: string;
                host: string | null;
                port: number | null;
            }>(`
                SELECT 
                    current_database() AS database, 
                    current_user AS role,
                    inet_server_addr() AS host,
                    inet_server_port() AS port
            `);

            const identity = identityResult.rows[0];

            if (
                identity?.database !== this.expectedDatabase ||
                identity?.role !== this.expectedWriteRole
            ) {
                throw new Error(
                    `Writer connection identity mismatch. Expected database: ${this.expectedDatabase}, role: ${this.expectedWriteRole}. Got database: ${identity?.database}, role: ${identity?.role}`,
                );
            }

            if (this.expectedHost && identity?.host !== this.expectedHost) {
                throw new Error(
                    `Writer connection host mismatch. Expected: ${this.expectedHost}, Got: ${identity?.host}`,
                );
            }

            if (this.expectedPort && identity?.port !== this.expectedPort) {
                throw new Error(
                    `Writer connection port mismatch. Expected: ${this.expectedPort}, Got: ${identity?.port}`,
                );
            }

            await client.query(`SET LOCAL statement_timeout = '${config.statementTimeoutMs}ms'`);
            await client.query(`SET LOCAL lock_timeout = '${config.lockTimeoutMs}ms'`);
            await client.query(`SET LOCAL idle_in_transaction_session_timeout = '${config.idleInTransactionTimeoutMs}ms'`);

            const result = await callback(client);

            commitAttempted = true;

            try {
                await client.query("COMMIT");
            } catch (error) {
                commitError = error instanceof Error ? error : new Error(String(error));
                throw new CommitOutcomeUnknownError(commitError);
            }

            return result;
        } catch (error) {
            if (commitAttempted) {
                // COMMIT was attempted but failed — outcome unknown, discard connection
                throw error;
            }

            // Failure before commit — safe to rollback
            try {
                await client.query("ROLLBACK");
            } catch (rollbackError) {
                // Rollback also failed — discard connection, preserve original error
                const rollbackErr = rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError));
                if (error instanceof Error) {
                    error.message += ` | Rollback also failed: ${rollbackErr.message}`;
                }
                client.release(rollbackErr);
                throw error;
            }

            throw error;
        } finally {
            if (commitAttempted && commitError) {
                // COMMIT failed — discard the client
                client.release(commitError);
            } else {
                client.release();
            }
        }
    }
}

export class CommitOutcomeUnknownError extends Error {
    constructor(cause: unknown) {
        super(
            "The COMMIT result is unknown. The operation may have been committed.",
            { cause },
        );

        this.name = "CommitOutcomeUnknownError";
    }
}