import { z } from 'zod';

/**
 * Configuration for a single PostgreSQL connection.
 * Both read and write pools use the same credentials.
 */
export const ConnectionConfigSchema = z.object({
    host: z.string().min(1, 'Host is required'),
    port: z.number().int().positive().min(1).max(65535, 'Port must be between 1 and 65535'),
    database: z.string().min(1, 'Database name is required'),
    username: z.string().min(1, 'Username is required'),
    password: z.string().min(1, 'Password is required'),
    ssl: z.boolean().default(false),
});

export type ConnectionConfig = z.infer<typeof ConnectionConfigSchema>;

/**
 * Shared pool configuration applied to all connections.
 * max: maximum connections per pool (each database has 2 pools: read and write)
 * maxTotal: maximum total connections across all pools for all databases
 */
export const PoolConfigSchema = z.object({
    max: z.number().int().positive().default(10),
    maxTotal: z.number().int().positive().default(100),
    idleTimeoutMillis: z.number().int().positive().default(30000),
    connectionTimeoutMillis: z.number().int().positive().default(5000),
});

export type PoolConfig = z.infer<typeof PoolConfigSchema>;

/**
 * Database-level configuration for all connections.
 */
export const DatabaseConfigSchema = z
    .object({
        /** Default connection name (must exist in connections) */
        default: z.string().min(1, 'Default connection name is required'),

        /** Named connections */
        connections: z.record(z.string(), ConnectionConfigSchema),

        /** Shared pool settings */
        pool: PoolConfigSchema.optional(),

        /** Identity verification settings (applied to all connections) */
        expectedHost: z.string().optional(),
        expectedPort: z.number().int().positive().optional(),

        /** Transaction timeouts (milliseconds) */
        statementTimeoutMs: z.number().int().positive().default(10000),
        lockTimeoutMs: z.number().int().positive().default(5000),
        idleInTransactionTimeoutMs: z.number().int().positive().default(30000),

        /** Application name for connection identification */
        applicationName: z.string().default('pgmind'),
    })
    .refine((data) => Object.keys(data.connections).length > 0, {
        message: 'At least one connection must be defined',
        path: ['connections'],
    })
    .refine((data) => Object.keys(data.connections).length <= 20, {
        message: 'Maximum 20 connections allowed',
        path: ['connections'],
    });

export type DatabaseConfig = z.infer<typeof DatabaseConfigSchema>;

/**
 * Full configuration file structure.
 */
export const ConfigFileSchema = z.object({
    database: DatabaseConfigSchema,
});

export type ConfigFile = z.infer<typeof ConfigFileSchema>;

/**
 * Connection metadata returned to callers (credentials redacted).
 */
export interface ConnectionMetadata {
    id: string;
    name: string;
    host: string;
    port: number;
    database: string;
    username: string;
    ssl: boolean;
    version: number;
}

/**
 * Configuration for a single DatabaseService instance.
 * Used internally to create DatabaseService with proper credentials.
 */
export interface ResolvedConnectionConfig {
    name: string;
    connectionString: string;
    writeConnectionString: string;
    expectedDatabase: string;
    expectedUsername: string;
    expectedHost?: string;
    expectedPort?: number;
    poolMaxRead: number;
    poolMaxWrite: number;
    poolConnectionTimeoutMs: number;
    poolIdleTimeoutMs: number;
    applicationName: string;
    statementTimeoutMs: number;
    lockTimeoutMs: number;
    idleInTransactionTimeoutMs: number;
}
