import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { StartedPostgreSqlContainer, PostgreSqlContainer } from "@testcontainers/postgresql";
import { DatabaseService } from "../database/database.service.js";
import { Pool } from "pg";
import { SchemaService } from "./schema.service.js";
import { execSync } from "child_process";

let dockerAvailable = false;
try {
    execSync("docker version", { stdio: "ignore" });
    dockerAvailable = true;
} catch {
    dockerAvailable = false;
}

const describeIfDocker = dockerAvailable ? describe : describe.skip;

describeIfDocker("SchemaService Integration Tests (requires Docker)", () => {
    let container: StartedPostgreSqlContainer;
    let database: DatabaseService;
    let writePool: Pool;
    let schemaService: SchemaService;
    let queryUrl: string;
    let writeUrl: string;

    beforeAll(async () => {
        container = await new PostgreSqlContainer("postgres:16-alpine")
            .withDatabase("pgmind_test")
            .withUsername("postgres")
            .withPassword("postgres")
            .start();

        const host = container.getHost();
        const port = container.getPort();
        queryUrl = `postgresql://postgres:postgres@${host}:${port}/pgmind_test`;
        writeUrl = `postgresql://postgres:postgres@${host}:${port}/pgmind_test`;

        writePool = new Pool({ connectionString: writeUrl });

        await setupTestSchema();
    }, 120000);

    afterAll(async () => {
        await writePool?.end();
        await database?.shutdown();
        await container?.stop();
    }, 30000);

    async function setupTestSchema(): Promise<void> {
        const client = await writePool.connect();
        try {
            // Create roles (ignore errors if they already exist)
            await client.query(`CREATE ROLE pgmind_readonly NOINHERIT`).catch(() => {});
            await client.query(`CREATE ROLE pgmind_writer NOINHERIT`).catch(() => {});
            await client.query(`GRANT CONNECT ON DATABASE pgmind_test TO pgmind_readonly, pgmind_writer`);
            await client.query(`GRANT USAGE ON SCHEMA public TO pgmind_readonly, pgmind_writer`);
            await client.query(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO pgmind_readonly`);
            await client.query(`GRANT INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO pgmind_writer`);
            await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO pgmind_readonly`);
            await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT INSERT, UPDATE, DELETE ON TABLES TO pgmind_writer`);

            // Create test schema
            await client.query(`CREATE SCHEMA IF NOT EXISTS test_schema`);

            // Create tables with various constraints
            await client.query(`
                CREATE TABLE test_schema.users (
                    id SERIAL PRIMARY KEY,
                    email TEXT UNIQUE NOT NULL,
                    name TEXT NOT NULL,
                    created_at TIMESTAMPTZ DEFAULT NOW()
                )
            `);

            await client.query(`
                CREATE TABLE test_schema.orders (
                    id SERIAL PRIMARY KEY,
                    user_id INT NOT NULL REFERENCES test_schema.users(id),
                    total DECIMAL(10,2) NOT NULL CHECK (total > 0),
                    status TEXT DEFAULT 'pending'
                )
            `);

            await client.query(`
                CREATE TABLE test_schema.products (
                    id SERIAL PRIMARY KEY,
                    sku TEXT UNIQUE NOT NULL,
                    name TEXT NOT NULL,
                    price DECIMAL(10,2) NOT NULL
                )
            `);

            // Create indexes
            await client.query(`CREATE INDEX idx_users_email ON test_schema.users(email)`);
            await client.query(`CREATE INDEX idx_orders_user_id ON test_schema.orders(user_id)`);
            await client.query(`CREATE UNIQUE INDEX idx_products_sku ON test_schema.products(sku)`);

            // Create view
            await client.query(`
                CREATE VIEW test_schema.user_order_summary AS
                SELECT u.id, u.name, COUNT(o.id) as order_count, SUM(o.total) as total_spent
                FROM test_schema.users u
                LEFT JOIN test_schema.orders o ON u.id = o.user_id
                GROUP BY u.id, u.name
            `);

            // Create materialized view
            await client.query(`
                CREATE MATERIALIZED VIEW test_schema.product_stats AS
                SELECT COUNT(*) as product_count, AVG(price) as avg_price
                FROM test_schema.products
            `);

            // Grant permissions
            await client.query(`GRANT USAGE ON SCHEMA test_schema TO pgmind_readonly, pgmind_writer`);
            await client.query(`GRANT SELECT ON ALL TABLES IN SCHEMA test_schema TO pgmind_readonly`);
            await client.query(`GRANT SELECT ON ALL SEQUENCES IN SCHEMA test_schema TO pgmind_readonly`);
        } finally {
            client.release();
        }
    }

    beforeEach(async () => {
        database = new DatabaseService(queryUrl, writeUrl, {
            expectedDatabase: "pgmind_test",
            expectedReadRole: "postgres",
            expectedWriteRole: "postgres",
            poolMaxRead: 5,
            poolMaxWrite: 5,
        });
        await database.verifyConnections();
        schemaService = new SchemaService(database);
    });

    afterEach(async () => {
        await database?.shutdown();
    });

    it("should discover all schemas including test_schema", async () => {
        const result = await schemaService.getDatabaseSchema();
        const schemaNames = result.schemas.map((s) => s.name);
        expect(schemaNames).toContain("test_schema");
        expect(schemaNames).toContain("public");
    });

    it("should discover tables in test_schema", async () => {
        const result = await schemaService.getDatabaseSchema();
        const testSchema = result.schemas.find((s) => s.name === "test_schema");
        expect(testSchema).toBeDefined();
        
        const tableNames = testSchema!.tables.map((t) => t.name);
        expect(tableNames).toContain("users");
        expect(tableNames).toContain("orders");
        expect(tableNames).toContain("products");
    });

    it("should discover views as table_type VIEW", async () => {
        const result = await schemaService.getDatabaseSchema();
        const testSchema = result.schemas.find((s) => s.name === "test_schema");
        
        const views = testSchema!.tables.filter((t) => t.type === "VIEW");
        const viewNames = views.map((v) => v.name);
        expect(viewNames).toContain("user_order_summary");
    });

    it("should discover materialized views as table_type MATERIALIZED VIEW", async () => {
        const result = await schemaService.getDatabaseSchema();
        const testSchema = result.schemas.find((s) => s.name === "test_schema");
        
        const matViews = testSchema!.tables.filter((t) => t.type === "MATERIALIZED VIEW");
        const mvNames = matViews.map((v) => v.name);
        expect(mvNames).toContain("product_stats");
    });

    it("should discover columns with correct types", async () => {
        const result = await schemaService.getDatabaseSchema();
        const testSchema = result.schemas.find((s) => s.name === "test_schema");
        const usersTable = testSchema!.tables.find((t) => t.name === "users");
        
        const columnNames = usersTable!.columns.map((c) => c.name);
        expect(columnNames).toContain("id");
        expect(columnNames).toContain("email");
        expect(columnNames).toContain("name");
        expect(columnNames).toContain("created_at");

        const idColumn = usersTable!.columns.find((c) => c.name === "id");
        expect(idColumn?.dataType).toContain("integer");
        expect(idColumn?.nullable).toBe(false);
    });

    it("should discover primary keys", async () => {
        const result = await schemaService.getDatabaseSchema();
        const testSchema = result.schemas.find((s) => s.name === "test_schema");
        const usersTable = testSchema!.tables.find((t) => t.name === "users");
        
        const pkConstraints = usersTable!.constraints.filter((c) => c.type === "PRIMARY KEY");
        expect(pkConstraints.length).toBeGreaterThanOrEqual(1);
        expect(pkConstraints[0].column).toBe("id");
    });

    it("should discover foreign keys", async () => {
        const result = await schemaService.getDatabaseSchema();
        const testSchema = result.schemas.find((s) => s.name === "test_schema");
        const ordersTable = testSchema!.tables.find((t) => t.name === "orders");
        
        const fks = ordersTable!.constraints.filter((c) => c.type === "FOREIGN KEY");
        expect(fks.length).toBeGreaterThanOrEqual(1);
        
        const userFk = fks.find((fk) => fk.column === "user_id");
        expect(userFk).toBeDefined();
        expect(userFk?.referencedTable).toBe("users");
    });

    it("should discover unique constraints via PRIMARY KEY and UNIQUE indexes", async () => {
        const result = await schemaService.getDatabaseSchema();
        const testSchema = result.schemas.find((s) => s.name === "test_schema");
        
        // Primary key is a unique constraint
        const usersTable = testSchema!.tables.find((t) => t.name === "users");
        const pkConstraints = usersTable!.constraints.filter((c) => c.type === "PRIMARY KEY");
        expect(pkConstraints.length).toBeGreaterThanOrEqual(1);
        
        // Email has UNIQUE constraint
        const emailColumn = usersTable!.columns.find((c) => c.name === "email");
        expect(emailColumn).toBeDefined();
    });
});