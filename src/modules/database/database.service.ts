import { Pool } from "pg";

export class DatabaseService {
    private readonly pool: Pool;

    constructor(connectionString: string) {
        this.pool = new Pool({
            connectionString,
            max: 10,
            connectionTimeoutMillis: 5000,
            idleTimeoutMillis: 30000,
        });
    }

    async checkConnection(): Promise<boolean> {
        const result = await this.pool.query("SELECT 1 AS connected");
        return result.rows[0].connected === 1;
    }

    async close(): Promise<void> {
        await this.pool.end();
    }
}

// Using Pool instead of Client
// Because Pool manages multiple clients and handles connection pooling, it is more efficient for applications that require multiple database connections. The Pool class allows you to reuse connections, reducing the overhead of establishing new connections for each query.
