import { DatabaseService } from "./database.service.js";
import type { ResolvedConnectionConfig, ConnectionMetadata } from "../../config/configuration.types.js";
import { getConnectionMetadata, getAllResolvedConnectionConfigs } from "../../config/configuration.loader.js";
import { getDatabaseConfig } from "../../config/index.js";

/**
 * Registry for managing multiple named DatabaseService instances.
 * Handles registration, retrieval, and lifecycle of database connections.
 */
export class ConnectionRegistry {
    private readonly connections = new Map<string, DatabaseService>();
    private readonly metadata = new Map<string, ConnectionMetadata>();
    protected readonly maxConnections: number;
    private readonly versionCounter = new Map<string, number>();
    private activeConnectionName: string | undefined;

    constructor(maxConnections: number = 20) {
        this.maxConnections = maxConnections;
    }

    /**
     * Register a new database connection.
     * Validates connectivity and database identity before successful registration.
     * @throws Error if connection already exists, max connections reached, or validation fails
     */
    async register(name: string, config: ResolvedConnectionConfig): Promise<ConnectionMetadata> {
        // Check for duplicate name
        if (this.connections.has(name)) {
            throw new Error(`Connection '${name}' is already registered`);
        }

        // Check max connections limit
        if (this.connections.size >= this.maxConnections) {
            throw new Error(
                `Maximum number of connections (${this.maxConnections}) reached. ` +
                `Cannot register '${name}'.`
            );
        }

        // Create DatabaseService instance
        const database = new DatabaseService(
            config.connectionString,
            config.writeConnectionString,
            {
                poolMaxRead: config.poolMaxRead,
                poolMaxWrite: config.poolMaxWrite,
                poolConnectionTimeoutMs: config.poolConnectionTimeoutMs,
                poolIdleTimeoutMs: config.poolIdleTimeoutMs,
                applicationName: config.applicationName,
                expectedDatabase: config.expectedDatabase,
                expectedUsername: config.expectedUsername,
                expectedHost: config.expectedHost,
                expectedPort: config.expectedPort,
                statementTimeoutMs: config.statementTimeoutMs,
                lockTimeoutMs: config.lockTimeoutMs,
                idleInTransactionTimeoutMs: config.idleInTransactionTimeoutMs,
            }
        );

        try {
            // Validate connectivity and identity
            await database.verifyConnections();
        } catch (error) {
            // Clean up pools on validation failure
            await database.shutdown();
            throw new Error(
                `Failed to validate connection '${name}': ${error instanceof Error ? error.message : String(error)}`
            );
        }

        // Register successfully
        this.connections.set(name, database);

        // Generate metadata with version tracking
        const version = (this.versionCounter.get(name) ?? 0) + 1;
        this.versionCounter.set(name, version);

        const meta = getConnectionMetadata(getDatabaseConfig(), name, version);
        this.metadata.set(name, meta);

        return meta;
    }

    /**
     * Get a registered database connection by name.
     * @throws Error if connection not found
     */
    get(name: string): DatabaseService {
        const database = this.connections.get(name);
        if (!database) {
            const available = Array.from(this.connections.keys()).join(", ") || "none";
            throw new Error(
                `Connection '${name}' not found. Available connections: ${available}`
            );
        }
        return database;
    }

    /**
     * Get connection metadata (credentials redacted).
     * @throws Error if connection not found
     */
    getMetadata(name: string): ConnectionMetadata {
        const meta = this.metadata.get(name);
        if (!meta) {
            const available = Array.from(this.metadata.keys()).join(", ") || "none";
            throw new Error(
                `Connection '${name}' not found. Available connections: ${available}`
            );
        }
        return meta;
    }

    /**
     * List all registered connection metadata.
     */
    list(): ConnectionMetadata[] {
        return Array.from(this.metadata.values());
    }

    /**
     * Check if a connection is registered.
     */
    has(name: string): boolean {
        return this.connections.has(name);
    }

    /**
     * Remove a connection and close its pools.
     * @throws Error if connection not found
     */
    async remove(name: string): Promise<void> {
        const database = this.connections.get(name);
        if (!database) {
            throw new Error(`Connection '${name}' not found`);
        }

        // Close pools
        await database.shutdown();

        // Remove from registry
        this.connections.delete(name);
        this.metadata.delete(name);
    }

    /**
     * Get the default connection (as configured in YAML).
     */
    getDefault(): DatabaseService {
        return this.get(getDatabaseConfig().default);
    }

    /**
     * Get the default connection name.
     */
    getDefaultName(): string {
        return getDatabaseConfig().default;
    }

    /**
     * Resolve the DatabaseService to use for a read-only operation.
     *
     * Resolution behavior:
     * 1. If connectionName is provided, use that configured connection.
     * 2. Otherwise, use the currently active connection.
     * 3. If the selected connection does not exist, throw a clear error.
     *
     * Explicit connectionName selection does NOT modify the active connection.
     * @throws Error if no connection can be resolved
     */
    resolve(connectionName?: string): DatabaseService {
        const name = connectionName ?? this.activeConnectionName;

        if (!name) {
            throw new Error(
                "No active database connection. Use switch_database to select a connection.",
            );
        }

        return this.get(name);
    }

    /**
     * Switch the active connection to the configured connection with the given name.
     * Does not close or recreate any pools.
     * @throws Error if the connection name is unknown
     */
    setActive(connectionName: string): void {
        if (!this.connections.has(connectionName)) {
            const available = this.names().join(", ") || "none";
            throw new Error(
                `Connection '${connectionName}' not found. Available connections: ${available}`,
            );
        }
        this.activeConnectionName = connectionName;
    }

    /**
     * Get the name of the currently active connection.
     */
    getActiveName(): string | undefined {
        return this.activeConnectionName;
    }

    /**
     * Get the currently active DatabaseService.
     */
    getActive(): DatabaseService | undefined {
        if (!this.activeConnectionName) {
            return undefined;
        }
        return this.connections.get(this.activeConnectionName);
    }

    /**
     * Close all registered connections.
     * Used during application shutdown.
     */
    async shutdown(): Promise<void> {
        const shutdownPromises = Array.from(this.connections.entries()).map(
            async ([name, database]) => {
                try {
                    await database.shutdown();
                } catch (error) {
                    console.error(`Error closing connection '${name}':`, error);
                }
            }
        );

        await Promise.all(shutdownPromises);
        this.connections.clear();
        this.metadata.clear();
        this.activeConnectionName = undefined;
    }

    /**
     * Get the number of registered connections.
     */
    size(): number {
        return this.connections.size;
    }

    /**
     * Get all registered connection names.
     */
    names(): string[] {
        return Array.from(this.connections.keys());
    }
}

/**
 * Global connection registry instance.
 * Initialized during application startup.
 */
let globalRegistry: ConnectionRegistry | null = null;

/**
 * Initialize the global connection registry with all configured connections.
 * This should be called once during application startup.
 */
export async function initializeConnectionRegistry(
    maxConnections: number = 20,
): Promise<ConnectionRegistry> {
    if (globalRegistry) {
        throw new Error("Connection registry already initialized");
    }

    const registry = new ConnectionRegistry(maxConnections);
    const resolvedConfigs = getAllResolvedConnectionConfigs(getDatabaseConfig());

    // Register all configured connections
    const registrationPromises = Array.from(resolvedConfigs.entries()).map(
        async ([name, config]) => {
            try {
                await registry.register(name, config);
            } catch (error) {
                // If any connection fails to register, shut down all and re-throw
                await registry.shutdown();
                throw error;
            }
        }
    );

    await Promise.all(registrationPromises);

    // The active connection defaults to the configured default connection.
    registry.setActive(getDatabaseConfig().default);

    globalRegistry = registry;
    return registry;
}

/**
 * Get the global connection registry instance.
 * @throws Error if registry not initialized
 */
export function getConnectionRegistry(): ConnectionRegistry {
    if (!globalRegistry) {
        throw new Error("Connection registry not initialized. Call initializeConnectionRegistry() first.");
    }
    return globalRegistry;
}

/**
 * Shutdown the global connection registry.
 */
export async function shutdownConnectionRegistry(): Promise<void> {
    if (globalRegistry) {
        await globalRegistry.shutdown();
        globalRegistry = null;
    }
}