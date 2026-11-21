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
        callback: (client: PoolClient) => Promise<T>,
    ): Promise<T> {
        if (!this.writePool) {
            throw new Error("Write pool is not configured");
        }

        const client = await this.writePool.connect();

        try {
            await client.query("BEGIN");

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
}
// Using Pool instead of Client
// Because Pool manages multiple clients and handles connection pooling, it is more efficient for applications that require multiple database connections. The Pool class allows you to reuse connections, reducing the overhead of establishing new connections for each query.
