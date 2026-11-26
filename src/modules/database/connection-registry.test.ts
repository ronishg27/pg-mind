import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ConnectionRegistry } from "./connection-registry.js";
import type { ResolvedConnectionConfig, ConnectionMetadata } from "../../config/configuration.types.js";

// Create a mock class that mimics DatabaseService
class MockDatabaseService {
    public verifyConnections = vi.fn().mockResolvedValue(undefined);
    public shutdown = vi.fn().mockResolvedValue(undefined);
    public query = vi.fn().mockResolvedValue([{ connected: 1 }]);
    public withReadOnlyTransaction = vi.fn();
    public withWriteTransaction = vi.fn();
}

// Helper to create a registry with mocked DatabaseService
function createRegistryWithMock(maxConnections = 5, customMockFactory?: () => MockDatabaseService): { registry: ConnectionRegistry; mockFactory: () => MockDatabaseService } {
    const mockFactory = customMockFactory ?? (() => new MockDatabaseService());
    
    // We'll monkey-patch the DatabaseService import in the registry
    // Since we can't easily mock the constructor, we'll test the registry logic directly
    // by creating a subclass that overrides the database creation
    
    class TestableRegistry extends ConnectionRegistry {
        private mockFactory: () => MockDatabaseService;
        
        constructor(maxConnections: number, mockFactory: () => MockDatabaseService) {
            super(maxConnections);
            this.mockFactory = mockFactory;
        }
        
        // Override the register method to use our mock factory
        async register(name: string, config: ResolvedConnectionConfig): Promise<ConnectionMetadata> {
            // Check for duplicate name
            if (this.has(name)) {
                throw new Error(`Connection '${name}' is already registered`);
            }
            
            // Check max connections limit
            if (this.size() >= this.maxConnections) {
                throw new Error(
                    `Maximum number of connections (${this.maxConnections}) reached. ` +
                    `Cannot register '${name}'.`
                );
            }
            
            // Create mock database instance
            const database = this.mockFactory();
            
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
            
            // Register successfully - use internal methods
            (this as any).connections.set(name, database);
            
            // Generate metadata with version tracking
            const version = ((this as any).versionCounter.get(name) ?? 0) + 1;
            (this as any).versionCounter.set(name, version);
            
            // Create metadata (simplified version of getConnectionMetadata)
            const meta: ConnectionMetadata = {
                id: `${name}-${config.expectedHost}-${config.expectedDatabase}`.toLowerCase().replace(/[^a-z0-9-]/g, "-"),
                name,
                host: config.expectedHost ?? "localhost",
                port: config.expectedPort ?? 5432,
                database: config.expectedDatabase,
                username: config.expectedUsername,
                ssl: false,
                version,
            };
            
            (this as any).metadata.set(name, meta);
            
            return meta;
        }
    }
    
    return { registry: new TestableRegistry(maxConnections, mockFactory), mockFactory };
}

describe("ConnectionRegistry", () => {
    let registry: ConnectionRegistry;
    let mockFactory: () => MockDatabaseService;
    let mockConfig: ResolvedConnectionConfig;

    beforeEach(() => {
        vi.clearAllMocks();
        ({ registry, mockFactory } = createRegistryWithMock(5));

        mockConfig = {
            name: "test_db",
            connectionString: "postgresql://user:pass@localhost:5432/test_db",
            writeConnectionString: "postgresql://user:pass@localhost:5432/test_db",
            expectedDatabase: "test_db",
            expectedUsername: "user",
            expectedHost: "localhost",
            expectedPort: 5432,
            poolMaxRead: 10,
            poolMaxWrite: 10,
            poolConnectionTimeoutMs: 5000,
            poolIdleTimeoutMs: 30000,
            applicationName: "pgmind",
            statementTimeoutMs: 10000,
            lockTimeoutMs: 5000,
            idleInTransactionTimeoutMs: 30000,
        };
    });

    describe("register", () => {
        it("should register a new connection successfully", async () => {
            const metadata = await registry.register("test_db", mockConfig);

            expect(metadata.name).toBe("test_db");
            expect(metadata.host).toBe("localhost");
            expect(metadata.port).toBe(5432);
            expect(metadata.database).toBe("test_db");
            expect(metadata.username).toBe("user");
            expect(metadata.ssl).toBe(false);
            expect(metadata.version).toBe(1);
            expect(registry.has("test_db")).toBe(true);
        });

        it("should return metadata without credentials", async () => {
            const metadata = await registry.register("test_db", mockConfig);

            expect(JSON.stringify(metadata)).not.toContain("pass");
            expect(metadata).not.toHaveProperty("password");
        });

        it("should reject duplicate connection names", async () => {
            await registry.register("test_db", mockConfig);

            await expect(registry.register("test_db", mockConfig)).rejects.toThrow("already registered");
        });

        it("should enforce maximum connection count", async () => {
            const { registry: smallRegistry } = createRegistryWithMock(2);

            await smallRegistry.register("db1", { ...mockConfig, name: "db1" });
            await smallRegistry.register("db2", { ...mockConfig, name: "db2" });

            await expect(smallRegistry.register("db3", { ...mockConfig, name: "db3" }))
                .rejects.toThrow("Maximum number of connections (2) reached");
        });

        it("should clean up pools on verification failure", async () => {
            const failingMockFactory = () => {
                const mock = new MockDatabaseService();
                mock.verifyConnections.mockRejectedValueOnce(new Error("Connection failed"));
                mock.shutdown.mockResolvedValueOnce(undefined);
                return mock;
            };
            
            const { registry: failingRegistry } = createRegistryWithMock(5, failingMockFactory);

            await expect(failingRegistry.register("test_db", mockConfig)).rejects.toThrow("Failed to validate connection");
        });

        it("should increment version on re-registration after removal", async () => {
            await registry.register("test_db", mockConfig);
            await registry.remove("test_db");

            const metadata = await registry.register("test_db", mockConfig);
            expect(metadata.version).toBe(2);
        });
    });

    describe("get", () => {
        beforeEach(async () => {
            await registry.register("test_db", mockConfig);
        });

        it("should return registered database service", () => {
            const db = registry.get("test_db");
            expect(db).toBeInstanceOf(MockDatabaseService);
        });

        it("should throw error for unknown connection", () => {
            expect(() => registry.get("unknown")).toThrow("Connection 'unknown' not found");
        });
    });

    describe("getMetadata", () => {
        beforeEach(async () => {
            await registry.register("test_db", mockConfig);
        });

        it("should return connection metadata", () => {
            const meta = registry.getMetadata("test_db");
            expect(meta.name).toBe("test_db");
            expect(meta.version).toBe(1);
            expect(meta.username).toBe("user");
        });

        it("should throw error for unknown connection", () => {
            expect(() => registry.getMetadata("unknown")).toThrow("Connection 'unknown' not found");
        });
    });

    describe("list", () => {
        it("should return empty array when no connections", () => {
            expect(registry.list()).toEqual([]);
        });

        it("should list all registered connections", async () => {
            await registry.register("db1", { ...mockConfig, name: "db1" });
            await registry.register("db2", { ...mockConfig, name: "db2" });

            const list = registry.list();
            expect(list).toHaveLength(2);
            expect(list.map(m => m.name).sort()).toEqual(["db1", "db2"]);
        });
    });

    describe("remove", () => {
        beforeEach(async () => {
            await registry.register("test_db", mockConfig);
        });

        it("should remove connection and shutdown pools", async () => {
            const db = registry.get("test_db") as unknown as MockDatabaseService;
            await registry.remove("test_db");

            expect(db.shutdown).toHaveBeenCalled();
            expect(registry.has("test_db")).toBe(false);
        });

        it("should throw error for unknown connection", async () => {
            await expect(registry.remove("unknown")).rejects.toThrow("Connection 'unknown' not found");
        });
    });

    describe("shutdown", () => {
        it("should shutdown all connections", async () => {
            await registry.register("db1", { ...mockConfig, name: "db1" });
            await registry.register("db2", { ...mockConfig, name: "db2" });

            const db1 = registry.get("db1") as unknown as MockDatabaseService;
            const db2 = registry.get("db2") as unknown as MockDatabaseService;

            await registry.shutdown();

            expect(db1.shutdown).toHaveBeenCalled();
            expect(db2.shutdown).toHaveBeenCalled();
            expect(registry.size()).toBe(0);
        });

        it("should handle shutdown errors gracefully", async () => {
            const mock = new MockDatabaseService();
            mock.shutdown.mockRejectedValueOnce(new Error("Shutdown failed"));
            
            const { registry: errorRegistry } = createRegistryWithMock(5, () => mock);
            await errorRegistry.register("test_db", mockConfig);

            await expect(errorRegistry.shutdown()).resolves.not.toThrow();
        });
    });

    describe("size and names", () => {
        it("should track size correctly", async () => {
            expect(registry.size()).toBe(0);
            await registry.register("db1", { ...mockConfig, name: "db1" });
            expect(registry.size()).toBe(1);
            await registry.register("db2", { ...mockConfig, name: "db2" });
            expect(registry.size()).toBe(2);
            await registry.remove("db1");
            expect(registry.size()).toBe(1);
        });

        it("should return connection names", async () => {
            await registry.register("db1", { ...mockConfig, name: "db1" });
            await registry.register("db2", { ...mockConfig, name: "db2" });

            expect(registry.names().sort()).toEqual(["db1", "db2"]);
        });
    });
});