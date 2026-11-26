import { loadConfiguration, getDefaultResolvedConnectionConfig, getAllResolvedConnectionConfigs } from "./configuration.loader.js";
import type { DatabaseConfig, ResolvedConnectionConfig, ConnectionMetadata } from "./configuration.types.js";

// Lazy-loaded configuration
let _databaseConfig: DatabaseConfig | null = null;
let _configLoadError: Error | null = null;

/**
 * Get the database configuration, loading it on first access.
 */
function getDatabaseConfig(): DatabaseConfig {
    if (_configLoadError) {
        throw _configLoadError;
    }
    if (!_databaseConfig) {
        try {
            _databaseConfig = loadConfiguration();
        } catch (error) {
            _configLoadError = error instanceof Error ? error : new Error(String(error));
            throw _configLoadError;
        }
    }
    return _databaseConfig;
}

/**
 * Reset configuration for testing.
 * @internal
 */
export function __resetConfigForTesting(): void {
    _databaseConfig = null;
    _configLoadError = null;
}

/**
 * Set configuration directly for testing.
 * @internal
 */
export function __setConfigForTesting(config: DatabaseConfig): void {
    _databaseConfig = config;
    _configLoadError = null;
}

// Create a proxy object that provides both the function-like access and property access
// for backward compatibility
const databaseConfigProxy = new Proxy({} as DatabaseConfig, {
    get(_target, prop: string | symbol) {
        if (prop === "default") {
            return getDatabaseConfig().default;
        }
        if (prop === "connections") {
            return getDatabaseConfig().connections;
        }
        if (prop === "pool") {
            return getDatabaseConfig().pool;
        }
        if (prop === "expectedHost") {
            return getDatabaseConfig().expectedHost;
        }
        if (prop === "expectedPort") {
            return getDatabaseConfig().expectedPort;
        }
        if (prop === "statementTimeoutMs") {
            return getDatabaseConfig().statementTimeoutMs;
        }
        if (prop === "lockTimeoutMs") {
            return getDatabaseConfig().lockTimeoutMs;
        }
        if (prop === "idleInTransactionTimeoutMs") {
            return getDatabaseConfig().idleInTransactionTimeoutMs;
        }
        if (prop === "applicationName") {
            return getDatabaseConfig().applicationName;
        }
        // For any other property, delegate to the actual config
        const config = getDatabaseConfig();
        return (config as any)[prop];
    },
    ownKeys() {
        const config = getDatabaseConfig();
        return Reflect.ownKeys(config);
    },
    getOwnPropertyDescriptor(_target, prop: string | symbol) {
        const config = getDatabaseConfig();
        return Reflect.getOwnPropertyDescriptor(config, prop);
    },
});

// Backward compatibility: provide the default connection config in the old format
// This allows existing code to work without changes
const ConfigSchema = {
    // Database connection (backward compatible)
    get queryDatabaseUrl(): string {
        const config = getDatabaseConfig();
        const defaultResolved = getDefaultResolvedConnectionConfig(config);
        return defaultResolved.connectionString;
    },
    get writeDatabaseUrl(): string | undefined {
        const config = getDatabaseConfig();
        const defaultResolved = getDefaultResolvedConnectionConfig(config);
        return defaultResolved.writeConnectionString;
    },

    // Database identity verification
    get expectedDatabase(): string {
        const config = getDatabaseConfig();
        const defaultResolved = getDefaultResolvedConnectionConfig(config);
        return defaultResolved.expectedDatabase;
    },
    get expectedUsername(): string {
        const config = getDatabaseConfig();
        const defaultResolved = getDefaultResolvedConnectionConfig(config);
        return defaultResolved.expectedUsername;
    },
    get expectedHost(): string | undefined {
        const config = getDatabaseConfig();
        const defaultResolved = getDefaultResolvedConnectionConfig(config);
        return defaultResolved.expectedHost;
    },
    get expectedPort(): number | undefined {
        const config = getDatabaseConfig();
        const defaultResolved = getDefaultResolvedConnectionConfig(config);
        return defaultResolved.expectedPort;
    },

    // Pool configuration
    get poolMaxRead(): number {
        const config = getDatabaseConfig();
        const defaultResolved = getDefaultResolvedConnectionConfig(config);
        return defaultResolved.poolMaxRead;
    },
    get poolMaxWrite(): number {
        const config = getDatabaseConfig();
        const defaultResolved = getDefaultResolvedConnectionConfig(config);
        return defaultResolved.poolMaxWrite;
    },
    get poolConnectionTimeoutMs(): number {
        const config = getDatabaseConfig();
        const defaultResolved = getDefaultResolvedConnectionConfig(config);
        return defaultResolved.poolConnectionTimeoutMs;
    },
    get poolIdleTimeoutMs(): number {
        const config = getDatabaseConfig();
        const defaultResolved = getDefaultResolvedConnectionConfig(config);
        return defaultResolved.poolIdleTimeoutMs;
    },

    // Transaction timeouts (milliseconds)
    get statementTimeoutMs(): number {
        const config = getDatabaseConfig();
        const defaultResolved = getDefaultResolvedConnectionConfig(config);
        return defaultResolved.statementTimeoutMs;
    },
    get lockTimeoutMs(): number {
        const config = getDatabaseConfig();
        const defaultResolved = getDefaultResolvedConnectionConfig(config);
        return defaultResolved.lockTimeoutMs;
    },
    get idleInTransactionTimeoutMs(): number {
        const config = getDatabaseConfig();
        const defaultResolved = getDefaultResolvedConnectionConfig(config);
        return defaultResolved.idleInTransactionTimeoutMs;
    },

    // Application
    get applicationName(): string {
        const config = getDatabaseConfig();
        const defaultResolved = getDefaultResolvedConnectionConfig(config);
        return defaultResolved.applicationName;
    },
};

// Export the new multi-database configuration system
export { databaseConfigProxy as databaseConfig, loadConfiguration, getDefaultResolvedConnectionConfig, getAllResolvedConnectionConfigs };
export type { DatabaseConfig, ResolvedConnectionConfig, ConnectionMetadata };

// Also export the function for internal use
export { getDatabaseConfig };

// Backward compatible default export
export default ConfigSchema;
export type Config = typeof ConfigSchema;