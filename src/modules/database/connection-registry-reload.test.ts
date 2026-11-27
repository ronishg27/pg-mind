import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ConnectionRegistry } from './connection-registry.js';
import type { ResolvedConnectionConfig } from '../../config/configuration.types.js';

// Mock DatabaseService as a constructable mock function
vi.mock('./database.service.js', () => {
    const mock = vi.fn(function MockDatabaseService(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        this: any
    ) {
        this.verifyConnections = vi.fn().mockResolvedValue(undefined);
        this.shutdown = vi.fn().mockResolvedValue(undefined);
    });
    return { DatabaseService: mock };
});

// Mock the config modules so reload() doesn't read real YAML
vi.mock('../../config/index.js', async (importOriginal) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const actual: any = await importOriginal();
    return { ...actual, getDatabaseConfig: vi.fn() };
});

vi.mock('../../config/configuration.loader.js', async (importOriginal) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const actual: any = await importOriginal();
    return { ...actual, getAllResolvedConnectionConfigs: vi.fn() };
});

import { DatabaseService } from './database.service.js';
import { getDatabaseConfig } from '../../config/index.js';
import { getAllResolvedConnectionConfigs } from '../../config/configuration.loader.js';

// ConnectionConfig shape expected by getConnectionMetadata (host/database, not expectedHost/expectedDatabase)
function makeConnectionConfig(name: string): ResolvedConnectionConfig {
    return {
        name,
        connectionString: `postgresql://user:pass@localhost:5432/${name}`,
        writeConnectionString: `postgresql://user:pass@localhost:5432/${name}`,
        expectedDatabase: name,
        expectedUsername: 'user',
        expectedHost: 'localhost',
        expectedPort: 5432,
        poolMaxRead: 10,
        poolMaxWrite: 10,
        poolConnectionTimeoutMs: 5000,
        poolIdleTimeoutMs: 30000,
        applicationName: 'pgmind',
        statementTimeoutMs: 10000,
        lockTimeoutMs: 5000,
        idleInTransactionTimeoutMs: 30000,
    } as unknown as ResolvedConnectionConfig;
}

function mockConfig(connections: Record<string, ResolvedConnectionConfig>, defaultName: string) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (getDatabaseConfig as any).mockReturnValue({
        default: defaultName,
        connections,
        pool: { max: 10, maxTotal: 100, idleTimeoutMillis: 30000, connectionTimeoutMillis: 5000 },
        statementTimeoutMs: 10000,
        lockTimeoutMs: 5000,
        idleInTransactionTimeoutMs: 30000,
        applicationName: 'pgmind',
    });
    const resolved = new Map(Object.entries(connections).map(([name, c]) => [name, c]));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (getAllResolvedConnectionConfigs as any).mockReturnValue(resolved);
}

describe('ConnectionRegistry.reload lifecycle', () => {
    let registry: ConnectionRegistry;

    beforeEach(() => {
        vi.clearAllMocks();
        registry = new ConnectionRegistry(20);
        // Set up default config mock so register() can resolve metadata
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (getDatabaseConfig as any).mockReturnValue({
            default: 'db1',
            connections: { db1: makeConnectionConfig('db1') },
            pool: {
                max: 10,
                maxTotal: 100,
                idleTimeoutMillis: 30000,
                connectionTimeoutMillis: 5000,
            },
            statementTimeoutMs: 10000,
            lockTimeoutMs: 5000,
            idleInTransactionTimeoutMs: 30000,
            applicationName: 'pgmind',
        });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (getAllResolvedConnectionConfigs as any).mockReturnValue(
            new Map([['db1', makeConnectionConfig('db1')]])
        );
    });

    it('should serialize concurrent reloads', async () => {
        await registry.register('db1', makeConnectionConfig('db1'));
        mockConfig({ db1: makeConnectionConfig('db1') }, 'db1');

        const promise1 = registry.reload();
        await expect(registry.reload()).rejects.toThrow('already in progress');
        await promise1;
    });

    it('should preserve previous connection when replacement initialization fails', async () => {
        await registry.register('db1', makeConnectionConfig('db1'));
        const oldDb = registry.get('db1');

        // Make DatabaseService constructor throw for new instances
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (DatabaseService as any).mockImplementationOnce(() => {
            throw new Error('Validation failed');
        });

        mockConfig({ db1: makeConnectionConfig('db1') }, 'db1');

        await expect(registry.reload()).rejects.toThrow('Failed to replace connection');

        // Old connection should still be available
        expect(registry.has('db1')).toBe(true);
        expect(registry.get('db1')).toBe(oldDb);
    });

    it('should enforce maximum connection count during registration', async () => {
        mockConfig({ db1: makeConnectionConfig('db1'), db2: makeConnectionConfig('db2') }, 'db1');
        const smallRegistry = new ConnectionRegistry(2);
        await smallRegistry.register('db1', makeConnectionConfig('db1'));
        await smallRegistry.register('db2', makeConnectionConfig('db2'));

        await expect(smallRegistry.register('db3', makeConnectionConfig('db3'))).rejects.toThrow(
            'Maximum number of connections'
        );
    });

    it('should increment version when a connection is re-registered', async () => {
        await registry.register('db1', makeConnectionConfig('db1'));
        const metaBefore = registry.getMetadata('db1');
        const versionBefore = metaBefore.version;

        await registry.remove('db1');
        await registry.register('db1', makeConnectionConfig('db1'));

        const metaAfter = registry.getMetadata('db1');
        expect(metaAfter.version).toBe(versionBefore + 1);
    });

    it('should return metadata without credentials', async () => {
        await registry.register('db1', makeConnectionConfig('db1'));
        const meta = registry.getMetadata('db1');
        const serialized = JSON.stringify(meta);
        expect(serialized).not.toContain('pass');
        expect(meta).not.toHaveProperty('connectionString');
        expect(meta).not.toHaveProperty('writeConnectionString');
    });

    it('should get connection generation', async () => {
        await registry.register('db1', makeConnectionConfig('db1'));
        const gen1 = registry.getConnectionGeneration('db1');
        expect(gen1).toBe(1);

        await registry.remove('db1');
        await registry.register('db1', makeConnectionConfig('db1'));

        const gen2 = registry.getConnectionGeneration('db1');
        expect(gen2).toBe(2);
        expect(gen2).not.toBe(gen1);
    });

    it('should return 0 for unknown connection generation', () => {
        expect(registry.getConnectionGeneration('unknown')).toBe(0);
    });

    it('should remove connection and shutdown pools', async () => {
        mockConfig({ db1: makeConnectionConfig('db1'), db2: makeConnectionConfig('db2') }, 'db1');
        await registry.register('db1', makeConnectionConfig('db1'));
        await registry.register('db2', makeConnectionConfig('db2'));
        const db2 = registry.get('db2');
        const shutdownSpy = vi.spyOn(db2, 'shutdown');

        await registry.remove('db2');

        expect(registry.has('db2')).toBe(false);
        expect(shutdownSpy).toHaveBeenCalled();
        expect(registry.has('db1')).toBe(true);
    });
});
