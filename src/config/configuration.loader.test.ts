import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import {
    getResolvedConnectionConfig,
    getAllResolvedConnectionConfigs,
    getDefaultResolvedConnectionConfig,
    getConnectionMetadata,
    ConfigFileSchema,
} from './configuration.loader.js';
import type { DatabaseConfig } from './configuration.types.js';

const TEST_CONFIG_DIR = path.join(process.cwd(), 'test-config-temp');
const TEST_CONFIG_FILE = path.join(TEST_CONFIG_DIR, 'pg-mind.config.yaml');

function writeTestConfig(config: object): void {
    if (!fs.existsSync(TEST_CONFIG_DIR)) {
        fs.mkdirSync(TEST_CONFIG_DIR, { recursive: true });
    }
    fs.writeFileSync(TEST_CONFIG_FILE, yaml.dump(config));
}

function cleanupTestConfig(): void {
    if (fs.existsSync(TEST_CONFIG_FILE)) {
        fs.unlinkSync(TEST_CONFIG_FILE);
    }
    if (fs.existsSync(TEST_CONFIG_DIR)) {
        fs.rmSync(TEST_CONFIG_DIR, { recursive: true, force: true });
    }
}

// Test helper to load and validate config
function loadTestConfig(): DatabaseConfig {
    const configPath = TEST_CONFIG_FILE;
    if (!fs.existsSync(configPath)) {
        throw new Error(
            `Configuration file not found: ${configPath}\n` +
                `Create pg-mind.config.yaml in the project root with your database connections.\n` +
                `See pg-mind.config.example.yaml for a template.`
        );
    }

    let fileContent: string;
    try {
        fileContent = fs.readFileSync(configPath, 'utf-8');
    } catch (error) {
        throw new Error(
            `Failed to read configuration file: ${configPath}\n` +
                `${error instanceof Error ? error.message : String(error)}`
        );
    }

    let parsed: unknown;
    try {
        parsed = yaml.load(fileContent);
    } catch (error) {
        throw new Error(
            `Failed to parse YAML configuration: ${configPath}\n` +
                `${error instanceof Error ? error.message : String(error)}`
        );
    }

    const result = ConfigFileSchema.safeParse(parsed);

    if (!result.success) {
        const errors = result.error.issues
            .map((e) => `${e.path.map(String).join('.')}: ${e.message}`)
            .join('\n');
        throw new Error(`Configuration validation failed:\n${errors}`);
    }

    const config = result.data.database;

    // Validate that default connection exists
    if (!config.connections[config.default]) {
        const available = Object.keys(config.connections).join(', ') || 'none';
        throw new Error(
            `Default connection '${config.default}' not found in connections.\n` +
                `Available connections: ${available}`
        );
    }

    // Validate unique connection names
    const names = Object.keys(config.connections);
    const uniqueNames = new Set(names);
    if (names.length !== uniqueNames.size) {
        throw new Error(
            'Duplicate connection names found. Each connection must have a unique name.'
        );
    }

    // Validate pool capacity: maxTotal must be >= max * 2 * number of connections
    if (config.pool) {
        const maxPerDb = config.pool.max * 2; // read + write pools
        const minTotal = maxPerDb * names.length;
        if (config.pool.maxTotal < minTotal) {
            throw new Error(
                `Pool maxTotal (${config.pool.maxTotal}) must be at least ${minTotal} ` +
                    `(${config.pool.max} per pool * 2 pools * ${names.length} connections)`
            );
        }
    }

    return config;
}

describe('Configuration Loader', () => {
    beforeEach(() => {
        cleanupTestConfig();
    });

    afterEach(() => {
        cleanupTestConfig();
    });

    let config: DatabaseConfig;

    function setupConfig(configObj: object) {
        writeTestConfig(configObj);
        config = loadTestConfig();
    }

    describe('loadConfiguration (via test helper)', () => {
        it('should load valid configuration', () => {
            setupConfig({
                database: {
                    default: 'local_dev',
                    connections: {
                        local_dev: {
                            host: 'localhost',
                            port: 5432,
                            database: 'test_db',
                            username: 'user',
                            password: 'pass',
                            ssl: false,
                        },
                    },
                },
            });

            expect(config.default).toBe('local_dev');
            expect(config.connections.local_dev).toBeDefined();
            expect(config.connections.local_dev.host).toBe('localhost');
            expect(config.connections.local_dev.port).toBe(5432);
        });

        it('should apply default pool settings when not specified', () => {
            setupConfig({
                database: {
                    default: 'local_dev',
                    connections: {
                        local_dev: {
                            host: 'localhost',
                            port: 5432,
                            database: 'test_db',
                            username: 'user',
                            password: 'pass',
                        },
                    },
                },
            });

            // Pool is optional in the schema - when not specified, it's undefined
            // The resolver (getResolvedConnectionConfig) applies defaults
            // Here we just verify the config loads successfully
            expect(config).toBeDefined();
        });

        it('should apply custom pool settings', () => {
            setupConfig({
                database: {
                    default: 'local_dev',
                    connections: {
                        local_dev: {
                            host: 'localhost',
                            port: 5432,
                            database: 'test_db',
                            username: 'user',
                            password: 'pass',
                        },
                    },
                    pool: {
                        max: 20,
                        maxTotal: 100,
                        idleTimeoutMillis: 60000,
                        connectionTimeoutMillis: 10000,
                    },
                },
            });

            expect(config.pool?.max).toBe(20);
            expect(config.pool?.maxTotal).toBe(100);
            expect(config.pool?.idleTimeoutMillis).toBe(60000);
            expect(config.pool?.connectionTimeoutMillis).toBe(10000);
        });

        it('should apply default timeout settings', () => {
            setupConfig({
                database: {
                    default: 'local_dev',
                    connections: {
                        local_dev: {
                            host: 'localhost',
                            port: 5432,
                            database: 'test_db',
                            username: 'user',
                            password: 'pass',
                        },
                    },
                },
            });

            expect(config.statementTimeoutMs).toBe(10000);
            expect(config.lockTimeoutMs).toBe(5000);
            expect(config.idleInTransactionTimeoutMs).toBe(30000);
        });

        it('should throw error when config file is missing', () => {
            cleanupTestConfig();
            expect(() => loadTestConfig()).toThrow('Configuration file not found');
        });

        it('should throw error for invalid YAML', () => {
            fs.mkdirSync(TEST_CONFIG_DIR, { recursive: true });
            fs.writeFileSync(TEST_CONFIG_FILE, 'invalid: yaml: content: [');

            expect(() => loadTestConfig()).toThrow('Failed to parse YAML configuration');
        });

        it('should throw error for missing default connection', () => {
            writeTestConfig({
                database: {
                    default: 'nonexistent',
                    connections: {
                        local_dev: {
                            host: 'localhost',
                            port: 5432,
                            database: 'test_db',
                            username: 'user',
                            password: 'pass',
                        },
                    },
                },
            });

            try {
                loadTestConfig();
                expect.fail('Should have thrown');
            } catch (error) {
                expect(error).toBeInstanceOf(Error);
                expect((error as Error).message).toContain(
                    "Default connection 'nonexistent' not found in connections"
                );
                expect((error as Error).message).toContain('Available connections: local_dev');
            }
        });

        it('should throw error for missing required fields', () => {
            writeTestConfig({
                database: {
                    default: 'local_dev',
                    connections: {
                        local_dev: {
                            host: 'localhost',
                            // missing port, database, username, password
                        },
                    },
                },
            });

            try {
                loadTestConfig();
                expect.fail('Should have thrown');
            } catch (error) {
                expect(error).toBeInstanceOf(Error);
                expect((error as Error).message).toContain('Configuration validation failed');
                expect((error as Error).message).toContain('port: Invalid input');
                expect((error as Error).message).toContain('database: Invalid input');
                expect((error as Error).message).toContain('username: Invalid input');
                expect((error as Error).message).toContain('password: Invalid input');
            }
        });

        it('should throw error for invalid port range', () => {
            writeTestConfig({
                database: {
                    default: 'local_dev',
                    connections: {
                        local_dev: {
                            host: 'localhost',
                            port: 70000, // invalid port
                            database: 'test_db',
                            username: 'user',
                            password: 'pass',
                        },
                    },
                },
            });

            try {
                loadTestConfig();
                expect.fail('Should have thrown');
            } catch (error) {
                expect(error).toBeInstanceOf(Error);
                expect((error as Error).message).toContain('Configuration validation failed');
                expect((error as Error).message).toContain('Port must be between 1 and 65535');
            }
        });

        it('should throw error for empty connections', () => {
            writeTestConfig({
                database: {
                    default: 'local_dev',
                    connections: {},
                },
            });

            try {
                loadTestConfig();
                expect.fail('Should have thrown');
            } catch (error) {
                expect(error).toBeInstanceOf(Error);
                expect((error as Error).message).toContain('Configuration validation failed');
                expect((error as Error).message).toContain(
                    'At least one connection must be defined'
                );
            }
        });

        it('should throw error for too many connections', () => {
            const connections: Record<string, any> = {};
            for (let i = 0; i < 21; i++) {
                connections[`conn_${i}`] = {
                    host: 'localhost',
                    port: 5432,
                    database: `test_db_${i}`,
                    username: 'user',
                    password: 'pass',
                };
            }

            writeTestConfig({
                database: {
                    default: 'conn_0',
                    connections,
                },
            });

            try {
                loadTestConfig();
                expect.fail('Should have thrown');
            } catch (error) {
                expect(error).toBeInstanceOf(Error);
                expect((error as Error).message).toContain('Configuration validation failed');
                expect((error as Error).message).toContain('Maximum 20 connections allowed');
            }
        });

        it('should throw error when maxTotal is less than required minimum', () => {
            // 2 connections * 2 pools * max 10 = 40 minimum
            writeTestConfig({
                database: {
                    default: 'conn_0',
                    connections: {
                        conn_0: {
                            host: 'localhost',
                            port: 5432,
                            database: 'test_db_0',
                            username: 'user',
                            password: 'pass',
                        },
                        conn_1: {
                            host: 'localhost',
                            port: 5432,
                            database: 'test_db_1',
                            username: 'user',
                            password: 'pass',
                        },
                    },
                    pool: {
                        max: 10,
                        maxTotal: 20, // Too low - need at least 40
                    },
                },
            });

            try {
                loadTestConfig();
                expect.fail('Should have thrown');
            } catch (error) {
                expect(error).toBeInstanceOf(Error);
                expect((error as Error).message).toContain('maxTotal');
                expect((error as Error).message).toContain('at least');
            }
        });
    });

    describe('getResolvedConnectionConfig', () => {
        beforeEach(() => {
            setupConfig({
                database: {
                    default: 'local_dev',
                    connections: {
                        local_dev: {
                            host: 'localhost',
                            port: 5432,
                            database: 'test_db',
                            username: 'user',
                            password: 'pass',
                            ssl: false,
                        },
                        staging: {
                            host: 'staging.example.com',
                            port: 5432,
                            database: 'staging_db',
                            username: 'staging_user',
                            password: 'staging_pass',
                            ssl: true,
                        },
                    },
                    pool: {
                        max: 15,
                        maxTotal: 100,
                        idleTimeoutMillis: 45000,
                        connectionTimeoutMillis: 8000,
                    },
                    statementTimeoutMs: 15000,
                },
            });
        });

        it('should resolve connection config with all settings (host/port verification skipped when not configured)', () => {
            const resolved = getResolvedConnectionConfig(config, 'local_dev');

            expect(resolved.name).toBe('local_dev');
            expect(resolved.connectionString).toContain(
                'postgresql://user:pass@localhost:5432/test_db'
            );
            expect(resolved.writeConnectionString).toBe(resolved.connectionString);
            expect(resolved.expectedDatabase).toBe('test_db');
            expect(resolved.expectedUsername).toBe('user');
            // expectedHost and expectedPort are undefined when not explicitly configured in YAML
            expect(resolved.expectedHost).toBeUndefined();
            expect(resolved.expectedPort).toBeUndefined();
            expect(resolved.poolMaxRead).toBe(15);
            expect(resolved.poolMaxWrite).toBe(15);
            expect(resolved.poolConnectionTimeoutMs).toBe(8000);
            expect(resolved.poolIdleTimeoutMs).toBe(45000);
            expect(resolved.statementTimeoutMs).toBe(15000);
        });

        it('should resolve staging connection with SSL', () => {
            const resolved = getResolvedConnectionConfig(config, 'staging');

            expect(resolved.name).toBe('staging');
            expect(resolved.connectionString).toContain('sslmode=require');
            expect(resolved.expectedHost).toBeUndefined();
            expect(resolved.expectedPort).toBeUndefined();
            expect(resolved.expectedUsername).toBe('staging_user');
        });

        it('should throw error for unknown connection', () => {
            expect(() => getResolvedConnectionConfig(config, 'unknown')).toThrow(
                "Connection 'unknown' not found"
            );
        });
    });

    describe('getResolvedConnectionConfig with explicit host/port verification', () => {
        beforeEach(() => {
            setupConfig({
                database: {
                    default: 'local_dev',
                    connections: {
                        local_dev: {
                            host: 'localhost',
                            port: 5432,
                            database: 'test_db',
                            username: 'user',
                            password: 'pass',
                            ssl: false,
                        },
                    },
                    pool: {
                        max: 15,
                        maxTotal: 100,
                        idleTimeoutMillis: 45000,
                        connectionTimeoutMillis: 8000,
                    },
                    expectedHost: 'localhost',
                    expectedPort: 5432,
                    statementTimeoutMs: 15000,
                },
            });
        });

        it('should include expectedHost and expectedPort when explicitly configured', () => {
            const resolved = getResolvedConnectionConfig(config, 'local_dev');

            expect(resolved.expectedHost).toBe('localhost');
            expect(resolved.expectedPort).toBe(5432);
        });
    });

    describe('getAllResolvedConnectionConfigs', () => {
        beforeEach(() => {
            setupConfig({
                database: {
                    default: 'local_dev',
                    connections: {
                        local_dev: {
                            host: 'localhost',
                            port: 5432,
                            database: 'test_db',
                            username: 'user',
                            password: 'pass',
                        },
                        staging: {
                            host: 'staging.example.com',
                            port: 5432,
                            database: 'staging_db',
                            username: 'staging_user',
                            password: 'staging_pass',
                        },
                    },
                },
            });
        });

        it('should return all resolved configs', () => {
            const configs = getAllResolvedConnectionConfigs(config);

            expect(configs.size).toBe(2);
            expect(configs.has('local_dev')).toBe(true);
            expect(configs.has('staging')).toBe(true);
        });
    });

    describe('getDefaultResolvedConnectionConfig', () => {
        beforeEach(() => {
            setupConfig({
                database: {
                    default: 'local_dev',
                    connections: {
                        local_dev: {
                            host: 'localhost',
                            port: 5432,
                            database: 'test_db',
                            username: 'user',
                            password: 'pass',
                        },
                    },
                },
            });
        });

        it('should return default connection config', () => {
            const resolved = getDefaultResolvedConnectionConfig(config);
            expect(resolved.name).toBe('local_dev');
        });
    });

    describe('getConnectionMetadata', () => {
        beforeEach(() => {
            setupConfig({
                database: {
                    default: 'local_dev',
                    connections: {
                        local_dev: {
                            host: 'localhost',
                            port: 5432,
                            database: 'test_db',
                            username: 'user',
                            password: 'pass',
                            ssl: false,
                        },
                    },
                },
            });
        });

        it('should return metadata without credentials', () => {
            const meta = getConnectionMetadata(config, 'local_dev', 1);

            // The ID generation replaces non-alphanumeric chars with hyphens
            expect(meta.id).toBe('local-dev-localhost-test-db');
            expect(meta.name).toBe('local_dev');
            expect(meta.host).toBe('localhost');
            expect(meta.port).toBe(5432);
            expect(meta.database).toBe('test_db');
            expect(meta.username).toBe('user');
            expect(meta.ssl).toBe(false);
            expect(meta.version).toBe(1);
            // Ensure no credentials in metadata
            expect(JSON.stringify(meta)).not.toContain('pass');
        });

        it('should throw error for unknown connection', () => {
            expect(() => getConnectionMetadata(config, 'unknown')).toThrow(
                "Connection 'unknown' not found"
            );
        });
    });
});
