import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";
import { z } from "zod";
import {
    ConfigFileSchema,
    DatabaseConfig,
    ConnectionConfig,
    ResolvedConnectionConfig,
    PoolConfig,
} from "./configuration.types.js";

export { ConfigFileSchema };

const CONFIG_FILENAME = "pg-mind.config.yaml";
const EXAMPLE_CONFIG_FILENAME = "pg-mind.config.example.yaml";

/**
 * Default configuration file locations in order of priority.
 */
const CONFIG_SEARCH_PATHS = [process.cwd(), path.join(process.cwd(), "config")];

/**
 * Build a PostgreSQL connection string from connection config.
 * Password is included in the connection string but never logged.
 */
function buildConnectionString(config: ConnectionConfig): string {
    const sslParam = config.ssl ? "?sslmode=require" : "";
    return `postgresql://${encodeURIComponent(config.username)}:${encodeURIComponent(config.password)}@${config.host}:${config.port}/${config.database}${sslParam}`;
}

/**
 * Default pool configuration values.
 */
const DEFAULT_POOL_CONFIG: PoolConfig = {
    max: 10,
    maxTotal: 100,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
};

/**
 * Resolve a single connection config into DatabaseService constructor parameters.
 */
function resolveConnectionConfig(
    name: string,
    connection: ConnectionConfig,
    databaseConfig: DatabaseConfig,
): ResolvedConnectionConfig {
    const pool = databaseConfig.pool ?? DEFAULT_POOL_CONFIG;
    return {
        name,
        connectionString: buildConnectionString(connection),
        writeConnectionString: buildConnectionString(connection), // Same credentials for read/write
        expectedDatabase: connection.database,
        expectedUsername: connection.username,
        // Only verify host/port if explicitly configured in YAML
        expectedHost: databaseConfig.expectedHost,
        expectedPort: databaseConfig.expectedPort,
        poolMaxRead: pool.max,
        poolMaxWrite: pool.max,
        poolConnectionTimeoutMs: pool.connectionTimeoutMillis,
        poolIdleTimeoutMs: pool.idleTimeoutMillis,
        applicationName: databaseConfig.applicationName,
        statementTimeoutMs: databaseConfig.statementTimeoutMs,
        lockTimeoutMs: databaseConfig.lockTimeoutMs,
        idleInTransactionTimeoutMs: databaseConfig.idleInTransactionTimeoutMs,
    };
}

/**
 * Load and parse the YAML configuration file.
 * @throws Error with actionable message if config is missing or invalid.
 */
export function loadConfiguration(): DatabaseConfig {
    const configPath = findConfigFile();

    if (!configPath) {
        throw new Error(
            `Configuration file not found: ${CONFIG_FILENAME}\n` +
                `Create ${CONFIG_FILENAME} in the project root with your database connections.\n` +
                `See ${EXAMPLE_CONFIG_FILENAME} for a template.`,
        );
    }

    let fileContent: string;
    try {
        fileContent = fs.readFileSync(configPath, "utf-8");
    } catch (error) {
        throw new Error(
            `Failed to read configuration file: ${configPath}\n` +
                `${error instanceof Error ? error.message : String(error)}`,
        );
    }

    let parsed: unknown;
    try {
        parsed = yaml.load(fileContent);
    } catch (error) {
        throw new Error(
            `Failed to parse YAML configuration: ${configPath}\n` +
                `${error instanceof Error ? error.message : String(error)}`,
        );
    }

    const result = ConfigFileSchema.safeParse(parsed);

    if (!result.success) {
        const errors = result.error.issues
            .map((e) => `${e.path.map(String).join(".")}: ${e.message}`)
            .join("\n");
        throw new Error(`Configuration validation failed:\n${errors}`);
    }

    const config = result.data.database;

    // Validate that default connection exists
    if (!config.connections[config.default]) {
        const available = Object.keys(config.connections).join(", ") || "none";
        throw new Error(
            `Default connection '${config.default}' not found in connections.\n` +
                `Available connections: ${available}`,
        );
    }

    // Validate unique connection names (enforced by z.record but double-check)
    const names = Object.keys(config.connections);
    const uniqueNames = new Set(names);
    if (names.length !== uniqueNames.size) {
        throw new Error(
            "Duplicate connection names found. Each connection must have a unique name.",
        );
    }

    // Validate pool capacity: maxTotal must be >= max * 2 * number of connections
    if (config.pool) {
        const maxPerDb = config.pool.max * 2; // read + write pools
        const minTotal = maxPerDb * names.length;
        if (config.pool.maxTotal < minTotal) {
            throw new Error(
                `Pool maxTotal (${config.pool.maxTotal}) must be at least ${minTotal} ` +
                    `(${config.pool.max} per pool * 2 pools * ${names.length} connections)`,
            );
        }
    }

    return config;
}

/**
 * Find the configuration file in standard locations.
 */
function findConfigFile(): string | null {
    for (const searchPath of CONFIG_SEARCH_PATHS) {
        const candidate = path.join(searchPath, CONFIG_FILENAME);
        if (fs.existsSync(candidate)) {
            return candidate;
        }
    }
    return null;
}

/**
 * Get resolved configuration for a specific named connection.
 */
export function getResolvedConnectionConfig(
    databaseConfig: DatabaseConfig,
    connectionName: string,
): ResolvedConnectionConfig {
    const connection = databaseConfig.connections[connectionName];
    if (!connection) {
        const available =
            Object.keys(databaseConfig.connections).join(", ") || "none";
        throw new Error(
            `Connection '${connectionName}' not found.\n` +
                `Available connections: ${available}`,
        );
    }
    return resolveConnectionConfig(connectionName, connection, databaseConfig);
}

/**
 * Get all resolved connection configurations.
 */
export function getAllResolvedConnectionConfigs(
    databaseConfig: DatabaseConfig,
): Map<string, ResolvedConnectionConfig> {
    const configs = new Map<string, ResolvedConnectionConfig>();
    for (const [name, connection] of Object.entries(
        databaseConfig.connections,
    )) {
        configs.set(
            name,
            resolveConnectionConfig(name, connection, databaseConfig),
        );
    }
    return configs;
}

/**
 * Get the default resolved connection configuration.
 */
export function getDefaultResolvedConnectionConfig(
    databaseConfig: DatabaseConfig,
): ResolvedConnectionConfig {
    return getResolvedConnectionConfig(databaseConfig, databaseConfig.default);
}

/**
 * Generate connection metadata for display (credentials redacted).
 */
export function getConnectionMetadata(
    databaseConfig: DatabaseConfig,
    connectionName: string,
    version: number = 1,
): {
    id: string;
    name: string;
    host: string;
    port: number;
    database: string;
    username: string;
    ssl: boolean;
    version: number;
} {
    const connection = databaseConfig.connections[
        connectionName
    ] as ConnectionConfig;
    if (!connection) {
        throw new Error(`Connection '${connectionName}' not found`);
    }

    // Generate deterministic ID from name and host/database
    const id = `${connectionName}-${connection.host}-${connection.database}`
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, "-");

    return {
        id,
        name: connectionName,
        host: connection.host,
        port: connection.port,
        database: connection.database,
        username: connection.username,
        ssl: connection.ssl,
        version,
    };
}
