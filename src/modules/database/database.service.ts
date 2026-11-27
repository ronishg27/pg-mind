import { Pool, type PoolClient, type QueryResultRow, type PoolConfig } from 'pg';

export interface DatabaseConfig {
    poolMaxRead: number;
    poolMaxWrite: number;
    poolConnectionTimeoutMs: number;
    poolIdleTimeoutMs: number;
    applicationName: string;
    expectedDatabase: string;
    expectedUsername: string;
    expectedHost?: string;
    expectedPort?: number;
    statementTimeoutMs: number;
    lockTimeoutMs: number;
    idleInTransactionTimeoutMs: number;
}

export class DatabaseService {
    private readonly pool: Pool;
    private readonly writePool?: Pool;
    private readonly expectedDatabase: string;
    private readonly expectedUsername: string;
    private readonly expectedHost?: string;
    private readonly expectedPort?: number;
    private readonly statementTimeoutMs: number;
    private readonly lockTimeoutMs: number;
    private readonly idleInTransactionTimeoutMs: number;

    constructor(
        queryConnectionString: string,
        writeConnectionString?: string,
        configOverride?: Partial<DatabaseConfig>
    ) {
        const cfg = configOverride ?? {};

        const poolConfig: PoolConfig = {
            connectionString: queryConnectionString,
            max: cfg.poolMaxRead ?? 10,
            connectionTimeoutMillis: cfg.poolConnectionTimeoutMs ?? 5000,
            idleTimeoutMillis: cfg.poolIdleTimeoutMs ?? 30000,
            application_name: cfg.applicationName ?? 'pgmind',
        };

        this.pool = new Pool(poolConfig);
        this.setupPoolErrorHandlers(this.pool, 'read');

        if (writeConnectionString) {
            const writePoolConfig: PoolConfig = {
                connectionString: writeConnectionString,
                max: cfg.poolMaxWrite ?? 10,
                connectionTimeoutMillis: cfg.poolConnectionTimeoutMs ?? 5000,
                idleTimeoutMillis: cfg.poolIdleTimeoutMs ?? 30000,
                application_name: cfg.applicationName ?? 'pgmind',
            };
            this.writePool = new Pool(writePoolConfig);
            this.setupPoolErrorHandlers(this.writePool, 'write');
        }

        this.expectedDatabase = cfg.expectedDatabase ?? '';
        this.expectedUsername = cfg.expectedUsername ?? '';
        this.expectedHost = cfg.expectedHost;
        this.expectedPort = cfg.expectedPort;
        this.statementTimeoutMs = cfg.statementTimeoutMs ?? 10000;
        this.lockTimeoutMs = cfg.lockTimeoutMs ?? 5000;
        this.idleInTransactionTimeoutMs = cfg.idleInTransactionTimeoutMs ?? 30000;
    }

    private setupPoolErrorHandlers(pool: Pool, poolName: string): void {
        pool.on('error', (err) => {
            console.error(`Unexpected ${poolName} pool error:`, err);
        });
    }

    async verifyConnections(): Promise<void> {
        await this.verifyPool(this.pool, 'read');
        if (this.writePool) {
            await this.verifyPool(this.writePool, 'write');
        }
    }

    private async verifyPool(pool: Pool, poolName: string): Promise<void> {
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
                    `${poolName} pool database mismatch. Expected: ${this.expectedDatabase}, Got: ${identity?.database}`
                );
            }

            if (identity?.role !== this.expectedUsername) {
                throw new Error(
                    `${poolName} pool user mismatch. Expected: ${this.expectedUsername}, Got: ${identity?.role}`
                );
            }

            if (this.expectedHost && identity?.host !== this.expectedHost) {
                throw new Error(
                    `${poolName} pool host mismatch. Expected: ${this.expectedHost}, Got: ${identity?.host}`
                );
            }

            if (this.expectedPort && identity?.port !== this.expectedPort) {
                throw new Error(
                    `${poolName} pool port mismatch. Expected: ${this.expectedPort}, Got: ${identity?.port}`
                );
            }
        } finally {
            client.release();
        }
    }

    async checkConnection(): Promise<boolean> {
        const result = await this.pool.query('SELECT 1 AS connected');
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

    async query<T extends QueryResultRow>(sql: string, values: unknown[] = []): Promise<T[]> {
        const result = await this.pool.query<T>(sql, values);
        return result.rows;
    }

    async withReadOnlyTransaction<T>(callback: (client: PoolClient) => Promise<T>): Promise<T> {
        const client = await this.pool.connect();
        let released = false;

        const release = (error?: Error) => {
            if (released) return;
            released = true;
            client.release(error);
        };

        try {
            await client.query('BEGIN READ ONLY');

            await client.query(`SET LOCAL statement_timeout = '${this.statementTimeoutMs}ms'`);
            await client.query(`SET LOCAL lock_timeout = '${this.lockTimeoutMs}ms'`);
            await client.query(
                `SET LOCAL idle_in_transaction_session_timeout = '${this.idleInTransactionTimeoutMs}ms'`
            );

            const result = await callback(client);

            await client.query('COMMIT');

            return result;
        } catch (error) {
            try {
                await client.query('ROLLBACK');
            } catch (rollbackError) {
                release(
                    rollbackError instanceof Error
                        ? rollbackError
                        : new Error(String(rollbackError))
                );
                throw error;
            }
            throw error;
        } finally {
            release();
        }
    }

    async withWriteTransaction<T>(callback: (client: PoolClient) => Promise<T>): Promise<T> {
        if (!this.writePool) {
            throw new Error('Write pool is not configured');
        }

        const client = await this.writePool.connect();
        let released = false;

        const release = (error?: Error) => {
            if (released) return;
            released = true;
            client.release(error);
        };

        let commitAttempted = false;
        let commitError: Error | undefined;

        try {
            await client.query('BEGIN');

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
                identity?.role !== this.expectedUsername
            ) {
                throw new Error(
                    `Writer connection identity mismatch. Expected database: ${this.expectedDatabase}, user: ${this.expectedUsername}. Got database: ${identity?.database}, user: ${identity?.role}`
                );
            }

            if (this.expectedHost && identity?.host !== this.expectedHost) {
                throw new Error(
                    `Writer connection host mismatch. Expected: ${this.expectedHost}, Got: ${identity?.host}`
                );
            }

            if (this.expectedPort && identity?.port !== this.expectedPort) {
                throw new Error(
                    `Writer connection port mismatch. Expected: ${this.expectedPort}, Got: ${identity?.port}`
                );
            }

            await client.query(`SET LOCAL statement_timeout = '${this.statementTimeoutMs}ms'`);
            await client.query(`SET LOCAL lock_timeout = '${this.lockTimeoutMs}ms'`);
            await client.query(
                `SET LOCAL idle_in_transaction_session_timeout = '${this.idleInTransactionTimeoutMs}ms'`
            );

            const result = await callback(client);

            commitAttempted = true;

            try {
                await client.query('COMMIT');
            } catch (error) {
                commitError = error instanceof Error ? error : new Error(String(error));
                throw new CommitOutcomeUnknownError(commitError);
            }

            return result;
        } catch (error) {
            if (commitAttempted) {
                throw error;
            }

            try {
                await client.query('ROLLBACK');
            } catch (rollbackError) {
                const rollbackErr =
                    rollbackError instanceof Error
                        ? rollbackError
                        : new Error(String(rollbackError));
                if (error instanceof Error) {
                    // Preserve both errors without mutating the original
                    const combined = new Error(
                        `${error.message} | Rollback also failed: ${rollbackErr.message}`
                    );
                    combined.cause = error;
                    release(combined);
                } else {
                    release(rollbackErr);
                }
                throw error;
            }

            throw error;
        } finally {
            if (commitAttempted && commitError) {
                release(commitError);
            } else {
                release();
            }
        }
    }
}

export class CommitOutcomeUnknownError extends Error {
    constructor(cause: unknown) {
        super('The COMMIT result is unknown. The operation may have been committed.', { cause });

        this.name = 'CommitOutcomeUnknownError';
    }
}
