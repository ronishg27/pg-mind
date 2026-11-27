import { DatabaseService } from './database.service.js';
import type {
    ResolvedConnectionConfig,
    ConnectionMetadata,
} from '../../config/configuration.types.js';
import {
    getConnectionMetadata,
    getAllResolvedConnectionConfigs,
} from '../../config/configuration.loader.js';
import { getDatabaseConfig } from '../../config/index.js';

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
    /** Re-entrancy guard: prevents concurrent reloads from corrupting registry state. */
    private reloading = false;

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
                `Failed to validate connection '${name}': ${error instanceof Error ? error.message : String(error)}`,
                { cause: error }
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
     * Reload configuration from disk and synchronize the registry.
     *
     * Lifecycle guarantees:
     * - The entire new configuration is validated before any change is applied.
     * - Added connections are created and validated before registration.
     * - Modified connections: replacement pools are initialized and validated before
     *   replacing existing services; the previous working connection is preserved if
     *   replacement initialization fails.
     * - Removed connections are shut down only after being unregistered; old pools
     *   are closed once they are no longer referenced by any registry state.
     * - Unchanged connections reuse their existing DatabaseService instances.
     * - The active connection is preserved if it still exists; otherwise falls back
     *   to the new configured default and reports this explicitly.
     *
     * Concurrent reloads are serialized via a re-entrancy guard.
     *
     * @throws Error if the new configuration is invalid or the default connection
     *         is missing.
     */
    async reload(): Promise<{
        added: string[];
        removed: string[];
        modified: string[];
        unchanged: string[];
        activeConnectionName: string;
        defaultConnectionName: string;
        activeConnectionChanged: boolean;
    }> {
        // Serialize concurrent reloads.
        if (this.reloading) {
            throw new Error('Configuration reload already in progress. Please retry.');
        }
        this.reloading = true;

        try {
            // Read and validate the entire new configuration before applying anything.
            const config = getDatabaseConfig(); // validates fresh from disk via reloadConfiguration
            const newConfigs = getAllResolvedConnectionConfigs(config);
            const newDefault = config.default;

            if (!newConfigs.has(newDefault)) {
                throw new Error(
                    `Configured default connection '${newDefault}' does not exist in the reloaded configuration.`
                );
            }

            const oldNames = new Set(this.names());
            const newNames = new Set(newConfigs.keys());

            const added: string[] = [];
            const removed: string[] = [];
            const unchanged: string[] = [];

            // Determine changes.
            for (const name of newNames) {
                if (!oldNames.has(name)) {
                    added.push(name);
                } else {
                    unchanged.push(name); // placeholder; may become modified below
                }
            }
            for (const name of oldNames) {
                if (!newNames.has(name)) {
                    removed.push(name);
                }
            }

            // Detect modified connections by comparing resolved configs.
            // Build a deterministic signature for comparison (credentials excluded).
            const configSignature = (c: ResolvedConnectionConfig): string =>
                JSON.stringify({
                    database: c.expectedDatabase,
                    username: c.expectedUsername,
                    host: c.expectedHost,
                    port: c.expectedPort,
                    poolMaxRead: c.poolMaxRead,
                    poolMaxWrite: c.poolMaxWrite,
                    poolConnectionTimeoutMs: c.poolConnectionTimeoutMs,
                    poolIdleTimeoutMs: c.poolIdleTimeoutMs,
                    applicationName: c.applicationName,
                    statementTimeoutMs: c.statementTimeoutMs,
                    lockTimeoutMs: c.lockTimeoutMs,
                    idleInTransactionTimeoutMs: c.idleInTransactionTimeoutMs,
                });

            const newModified: string[] = [];
            const newUnchanged: string[] = [];
            for (const name of unchanged) {
                const oldConfig = this.connectionConfig(name);
                const newConfig = newConfigs.get(name)!;
                if (oldConfig && configSignature(oldConfig) !== configSignature(newConfig)) {
                    newModified.push(name);
                } else {
                    newUnchanged.push(name);
                }
            }

            // 1. Add new connections: create + validate before registering.
            const addedDatabases = new Map<string, DatabaseService>();
            for (const name of added) {
                const config = newConfigs.get(name)!;
                let database: DatabaseService;
                try {
                    database = await this.createAndValidateDatabase(name, config);
                } catch (error) {
                    // Clean up any pools created so far in this batch.
                    for (const addedDb of addedDatabases.values()) {
                        await addedDb.shutdown().catch(() => {});
                    }
                    throw error;
                }
                addedDatabases.set(name, database);
            }

            // 2. Replace modified connections: initialize + validate replacements first.
            const replacementDatabases = new Map<string, DatabaseService>();
            for (const name of newModified) {
                const config = newConfigs.get(name)!;
                let database: DatabaseService;
                try {
                    database = await this.createAndValidateDatabase(name, config);
                } catch (error) {
                    // Preserve the previous working connection on failure.
                    // Clean up replacement pools created so far in this batch.
                    for (const replacementDb of replacementDatabases.values()) {
                        await replacementDb.shutdown().catch(() => {});
                    }
                    // Clean up added databases too, since we're aborting this reload.
                    for (const addedDb of addedDatabases.values()) {
                        await addedDb.shutdown().catch(() => {});
                    }
                    throw new Error(
                        `Failed to replace connection '${name}': ${error instanceof Error ? error.message : String(error)}. Previous connection preserved.`,
                        { cause: error }
                    );
                }
                replacementDatabases.set(name, database);
            }

            // 3. Apply all successful changes atomically.
            // Register added connections.
            for (const [name, database] of addedDatabases) {
                this.connections.set(name, database);
                const version = (this.versionCounter.get(name) ?? 0) + 1;
                this.versionCounter.set(name, version);
                this.metadata.set(name, getConnectionMetadata(getDatabaseConfig(), name, version));
            }

            // Replace modified connections: shut down old pools after replacement is in place.
            for (const [name, replacementDb] of replacementDatabases) {
                const oldDb = this.connections.get(name);
                this.connections.set(name, replacementDb);
                const version = (this.versionCounter.get(name) ?? 0) + 1;
                this.versionCounter.set(name, version);
                this.metadata.set(name, getConnectionMetadata(getDatabaseConfig(), name, version));
                // Close old pools now that the replacement is registered.
                if (oldDb && oldDb !== replacementDb) {
                    await oldDb.shutdown().catch((error) => {
                        console.error(`Error shutting down replaced connection '${name}':`, error);
                    });
                }
            }

            // Remove connections: shut down and unregister.
            for (const name of removed) {
                const database = this.connections.get(name);
                if (database) {
                    await database.shutdown().catch((error) => {
                        console.error(`Error shutting down removed connection '${name}':`, error);
                    });
                }
                this.connections.delete(name);
                this.metadata.delete(name);
            }

            // 4. Update default and active connection.
            const previousActive = this.activeConnectionName;

            // Update the active connection based on rules.
            let activeConnectionChanged = false;
            let newActiveName: string | undefined;

            if (previousActive && this.connections.has(previousActive)) {
                // Preserve the current active connection if it still exists.
                newActiveName = previousActive;
            } else if (this.connections.has(newDefault)) {
                // Active connection was removed; fall back to the new configured default.
                newActiveName = newDefault;
                activeConnectionChanged = previousActive !== newDefault;
            } else {
                newActiveName = undefined;
            }

            if (newActiveName !== undefined) {
                this.activeConnectionName = newActiveName;
            }

            return {
                added,
                removed,
                modified: newModified,
                unchanged: newUnchanged,
                activeConnectionName: this.activeConnectionName ?? '',
                defaultConnectionName: newDefault,
                activeConnectionChanged,
            };
        } finally {
            this.reloading = false;
        }
    }

    /**
     * Create, verify, and return a DatabaseService without registering it.
     * Used during reload so replacement/addition can be fully validated before
     * mutating registry state.
     */
    private async createAndValidateDatabase(
        name: string,
        config: ResolvedConnectionConfig
    ): Promise<DatabaseService> {
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
            await database.verifyConnections();
        } catch (error) {
            await database.shutdown();
            throw new Error(
                `Failed to validate connection '${name}': ${error instanceof Error ? error.message : String(error)}`,
                { cause: error }
            );
        }

        return database;
    }

    /**
     * Return the resolved config for a registered connection, if available.
     * Used to compare configurations during reload. Returns undefined if the
     * connection is registered but its original config is not retained.
     */
    private connectionConfig(name: string): ResolvedConnectionConfig | undefined {
        // The registry does not retain the original resolved config after
        // registration. Compare using metadata fields that are retained.
        const meta = this.metadata.get(name);
        if (!meta) return undefined;
        return {
            name,
            connectionString: '',
            writeConnectionString: '',
            expectedDatabase: meta.database,
            expectedUsername: meta.username,
            expectedHost: meta.host,
            expectedPort: meta.port,
            poolMaxRead: 0,
            poolMaxWrite: 0,
            poolConnectionTimeoutMs: 0,
            poolIdleTimeoutMs: 0,
            applicationName: '',
            statementTimeoutMs: 0,
            lockTimeoutMs: 0,
            idleInTransactionTimeoutMs: 0,
        };
    }

    /**
     * Get a registered database connection by name.
     * @throws Error if connection not found
     */
    get(name: string): DatabaseService {
        const database = this.connections.get(name);
        if (!database) {
            const available = Array.from(this.connections.keys()).join(', ') || 'none';
            throw new Error(`Connection '${name}' not found. Available connections: ${available}`);
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
            const available = Array.from(this.metadata.keys()).join(', ') || 'none';
            throw new Error(`Connection '${name}' not found. Available connections: ${available}`);
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
                'No active database connection. Use switch_database to select a connection.'
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
            const available = this.names().join(', ') || 'none';
            throw new Error(
                `Connection '${connectionName}' not found. Available connections: ${available}`
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

    /**
     * Get the current generation (version) token for a registered connection.
     * The generation increments each time a connection is registered or replaced.
     * Used by approval records to detect if the underlying connection instance
     * was replaced (e.g. by configuration reload) since preparation.
     * @throws Error if connection not found
     */
    getConnectionGeneration(name: string): number {
        return this.versionCounter.get(name) ?? 0;
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
    maxConnections: number = 20
): Promise<ConnectionRegistry> {
    if (globalRegistry) {
        throw new Error('Connection registry already initialized');
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
        throw new Error(
            'Connection registry not initialized. Call initializeConnectionRegistry() first.'
        );
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
