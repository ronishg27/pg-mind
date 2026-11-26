import { z } from "zod";

process.loadEnvFile(".env");

const ConfigSchema = z.object({
    // Database connection
    queryDatabaseUrl: z.string().url("QUERY_DATABASE_URL must be a valid PostgreSQL connection string"),
    writeDatabaseUrl: z.string().url("WRITE_DATABASE_URL must be a valid PostgreSQL connection string").optional(),
    
    // Database identity verification
    expectedDatabase: z.string().min(1, "EXPECTED_DATABASE is required"),
    expectedReadRole: z.string().default("pgmind_readonly"),
    expectedWriteRole: z.string().default("pgmind_writer"),
    expectedHost: z.string().optional(),
    expectedPort: z.coerce.number().int().positive().optional(),
    
    // Pool configuration
    poolMaxRead: z.coerce.number().int().positive().default(10),
    poolMaxWrite: z.coerce.number().int().positive().default(10),
    poolConnectionTimeoutMs: z.coerce.number().int().positive().default(5000),
    poolIdleTimeoutMs: z.coerce.number().int().positive().default(30000),
    
    // Transaction timeouts (milliseconds)
    statementTimeoutMs: z.coerce.number().int().positive().default(10000),
    lockTimeoutMs: z.coerce.number().int().positive().default(5000),
    idleInTransactionTimeoutMs: z.coerce.number().int().positive().default(30000),
    
    // Application
    applicationName: z.string().default("pgmind"),
});

type Config = z.infer<typeof ConfigSchema>;

const parsed = ConfigSchema.safeParse({
    queryDatabaseUrl: process.env.QUERY_DATABASE_URL,
    writeDatabaseUrl: process.env.WRITE_DATABASE_URL,
    expectedDatabase: process.env.EXPECTED_DATABASE,
    expectedReadRole: process.env.EXPECTED_READ_ROLE,
    expectedWriteRole: process.env.WRITE_ROLE_NAME,
    expectedHost: process.env.EXPECTED_HOST,
    expectedPort: process.env.EXPECTED_PORT,
    poolMaxRead: process.env.POOL_MAX_READ,
    poolMaxWrite: process.env.POOL_MAX_WRITE,
    poolConnectionTimeoutMs: process.env.POOL_CONNECTION_TIMEOUT_MS,
    poolIdleTimeoutMs: process.env.POOL_IDLE_TIMEOUT_MS,
    statementTimeoutMs: process.env.STATEMENT_TIMEOUT_MS,
    lockTimeoutMs: process.env.LOCK_TIMEOUT_MS,
    idleInTransactionTimeoutMs: process.env.IDLE_IN_TRANSACTION_TIMEOUT_MS,
    applicationName: process.env.APPLICATION_NAME,
});

if (!parsed.success) {
    const errors = parsed.error.issues.map((e) => `${e.path.map(String).join(".")}: ${e.message}`).join("\n");
    throw new Error(`Configuration validation failed:\n${errors}`);
}

const config = parsed.data;

export default config;
export type { Config };
