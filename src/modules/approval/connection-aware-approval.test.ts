import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { StartedPostgreSqlContainer, PostgreSqlContainer } from "@testcontainers/postgresql";
import { DatabaseService } from "../database/database.service.js";
import { Pool } from "pg";
import { ApprovalStore } from "./approval.store.js";
import { ApprovalService } from "./approval.service.js";
import { ApprovalWorkflowService } from "./approval-workflow.service.js";
import { SqlOperationClassifier } from "../query/sql-operation-classifier.js";
import { SqlAnalysisService } from "../query/sql-analysis.service.js";
import { OperationExecutionService } from "./operation-execution.service.js";
import { execSync } from "child_process";

let dockerAvailable = false;
try {
    execSync("docker version", { stdio: "ignore" });
    dockerAvailable = true;
} catch {
    dockerAvailable = false;
}

const describeIfDocker = dockerAvailable ? describe : describe.skip;

describeIfDocker("Connection-Aware Approval Workflow (requires Docker)", () => {
    let container: StartedPostgreSqlContainer;
    let host: string;
    let port: number;
    let setupPool: Pool | undefined;
    let supergenDb: DatabaseService;
    let pgmindDb: DatabaseService;

    beforeAll(async () => {
        container = await new PostgreSqlContainer("postgres:16-alpine")
            .withDatabase("postgres")
            .withUsername("postgres")
            .withPassword("postgres")
            .start();

        host = container.getHost();
        port = container.getPort();

        // Superuser pool for creating databases/roles.
        setupPool = new Pool({
            connectionString: `postgresql://postgres:postgres@${host}:${port}/postgres`,
        });

        const client = await setupPool.connect();
        try {
            await client.query('CREATE DATABASE supergen');
            await client.query('CREATE DATABASE pgmind_dev');
        } catch {
            // Databases may already exist if container is reused.
        } finally {
            client.release();
        }

        await setupPool.end();
        setupPool = undefined;
    }, 120000);

    afterAll(async () => {
        // Pools are already shut down in afterEach; guard against double-shutdown.
        try { await supergenDb?.shutdown(); } catch { /* ignore */ }
        try { await pgmindDb?.shutdown(); } catch { /* ignore */ }
        await setupPool?.end();
        await container?.stop();
    }, 30000);

    async function setupDatabase(dbName: string): Promise<void> {
        const url = `postgresql://postgres:postgres@${host}:${port}/${dbName}`;
        const pool = new Pool({ connectionString: url });

        const client = await pool.connect();
        try {
            await client.query(`CREATE TABLE IF NOT EXISTS write_test (id SERIAL PRIMARY KEY, name TEXT, status TEXT)`);
        } finally {
            client.release();
            await pool.end();
        }
    }

    beforeEach(async () => {
        await setupDatabase("supergen");
        await setupDatabase("pgmind_dev");

        supergenDb = new DatabaseService(
            `postgresql://postgres:postgres@${host}:${port}/supergen`,
            `postgresql://postgres:postgres@${host}:${port}/supergen`,
            { expectedDatabase: "supergen", expectedUsername: "postgres", poolMaxRead: 5, poolMaxWrite: 5 },
        );
        await supergenDb.verifyConnections();

        pgmindDb = new DatabaseService(
            `postgresql://postgres:postgres@${host}:${port}/pgmind_dev`,
            `postgresql://postgres:postgres@${host}:${port}/pgmind_dev`,
            { expectedDatabase: "pgmind_dev", expectedUsername: "postgres", poolMaxRead: 5, poolMaxWrite: 5 },
        );
        await pgmindDb.verifyConnections();
    });

    afterEach(async () => {
        await supergenDb?.shutdown();
        await pgmindDb?.shutdown();
    });

    function buildServices(db: DatabaseService, store?: ApprovalStore) {
        const approvalStore = store ?? new ApprovalStore();
        const classifier = new SqlOperationClassifier();
        const analysisService = new SqlAnalysisService();
        const approvalService = new ApprovalService(approvalStore, classifier, analysisService, db);

        const mockConfirmationProvider = {
            confirm: vi.fn().mockResolvedValue("approve"),
        };

        const approvalWorkflow = new ApprovalWorkflowService(approvalService, mockConfirmationProvider as any);
        const executionService = new OperationExecutionService(approvalStore, classifier, db);

        return { approvalStore, approvalWorkflow, executionService };
    }

    it("preparation without connectionName uses the provided database service", async () => {
        const { approvalWorkflow, executionService } = buildServices(supergenDb);

        const sql = "INSERT INTO write_test (name, status) VALUES ('active_default', 'pending')";
        const result = await approvalWorkflow.prepareAndConfirm(sql);
        expect(result.status).toBe("approved");

        const execResult = await executionService.executeOperation(result.id);
        expect(execResult.status).toBe("executed");

        const rows = await supergenDb.query("SELECT * FROM write_test WHERE name = 'active_default'");
        expect(rows).toHaveLength(1);
    });

    it("preparation with explicit connection targets that connection", async () => {
        const { approvalWorkflow, executionService } = buildServices(pgmindDb);

        const sql = "INSERT INTO write_test (name, status) VALUES ('explicit_pgmind', 'pending')";
        const result = await approvalWorkflow.prepareAndConfirm(sql);
        expect(result.status).toBe("approved");

        const execResult = await executionService.executeOperation(result.id);
        expect(execResult.status).toBe("executed");

        const rows = await pgmindDb.query("SELECT * FROM write_test WHERE name = 'explicit_pgmind'");
        expect(rows).toHaveLength(1);
    });

    it("retains correct connection identity in the approval record", async () => {
        const store = new ApprovalStore();
        const classifier = new SqlOperationClassifier();
        const analysisService = new SqlAnalysisService();
        const approvalService = new ApprovalService(store, classifier, analysisService, supergenDb);

        const sql = "INSERT INTO write_test (name, status) VALUES ('identity_test', 'pending')";
        const request = await approvalService.prepareOperation(sql, "supergen");

        expect(request.connectionName).toBe("supergen");
        expect(request.database).toBe("supergen");
        expect(request.sql).toBe(sql);
    });

    it("execution runs against the original connection even after switching active connection", async () => {
        const store = new ApprovalStore();
        const classifier = new SqlOperationClassifier();
        const analysisService = new SqlAnalysisService();
        const supergenService = new ApprovalService(store, classifier, analysisService, supergenDb);

        const mockConfirmationProvider = {
            confirm: vi.fn().mockResolvedValue("approve"),
        };
        const supergenWorkflow = new ApprovalWorkflowService(supergenService, mockConfirmationProvider as any);

        // Prepare against supergen (simulating active = supergen).
        const sql = "INSERT INTO write_test (name, status) VALUES ('switch_test', 'pending')";
        const prepareResult = await supergenWorkflow.prepareAndConfirm(sql);
        expect(prepareResult.status).toBe("approved");

        // Simulate switching active connection to pgmind: execution still uses supergenDb.
        const execResult = await buildServices(supergenDb, store).executionService.executeOperation(prepareResult.id);
        expect(execResult.status).toBe("executed");

        const supergenRows = await supergenDb.query("SELECT * FROM write_test WHERE name = 'switch_test'");
        expect(supergenRows).toHaveLength(1);

        const pgmindRows = await pgmindDb.query("SELECT * FROM write_test WHERE name = 'switch_test'");
        expect(pgmindRows).toHaveLength(0);
    });

    it("integration scenario: prepare on supergen, switch active to pgmind, execute affects supergen only", async () => {
        const store = new ApprovalStore();
        const classifier = new SqlOperationClassifier();
        const analysisService = new SqlAnalysisService();
        const supergenService = new ApprovalService(store, classifier, analysisService, supergenDb);

        const mockConfirmationProvider = {
            confirm: vi.fn().mockResolvedValue("approve"),
        };
        const supergenWorkflow = new ApprovalWorkflowService(supergenService, mockConfirmationProvider as any);

        // 1. Active connection is supergen.
        // 2. Prepare without explicit connection name.
        const sql = "INSERT INTO write_test (name, status) VALUES ('integration_supergen', 'pending')";
        const prepareResult = await supergenWorkflow.prepareAndConfirm(sql);
        expect(prepareResult.status).toBe("approved");

        // 3. Switch active connection to pgmind (simulated).
        // 4. Execute against the original supergen connection.
        const execResult = await buildServices(supergenDb, store).executionService.executeOperation(prepareResult.id);
        expect(execResult.status).toBe("executed");
        expect(execResult.database).toBe("supergen");

        // 5. Verify operation affected supergen.
        const supergenRows = await supergenDb.query("SELECT * FROM write_test WHERE name = 'integration_supergen'");
        expect(supergenRows).toHaveLength(1);

        // 6. Verify pgmind was not modified.
        const pgmindRows = await pgmindDb.query("SELECT * FROM write_test WHERE name = 'integration_supergen'");
        expect(pgmindRows).toHaveLength(0);
    });

    it("integration scenario: explicit connectionName supergen executes against supergen", async () => {
        const store = new ApprovalStore();
        const classifier = new SqlOperationClassifier();
        const analysisService = new SqlAnalysisService();
        const supergenService = new ApprovalService(store, classifier, analysisService, supergenDb);

        const mockConfirmationProvider = {
            confirm: vi.fn().mockResolvedValue("approve"),
        };
        const supergenWorkflow = new ApprovalWorkflowService(supergenService, mockConfirmationProvider as any);

        // Explicitly prepare with connectionName: supergen.
        const sql = "INSERT INTO write_test (name, status) VALUES ('explicit_supergen', 'pending')";
        const prepareResult = await supergenWorkflow.prepareAndConfirm(sql, "supergen", supergenDb);
        expect(prepareResult.status).toBe("approved");

        // Execute against supergen even if active were switched to pgmind.
        const execResult = await buildServices(supergenDb, store).executionService.executeOperation(prepareResult.id);
        expect(execResult.status).toBe("executed");

        const supergenRows = await supergenDb.query("SELECT * FROM write_test WHERE name = 'explicit_supergen'");
        expect(supergenRows).toHaveLength(1);

        const pgmindRows = await pgmindDb.query("SELECT * FROM write_test WHERE name = 'explicit_supergen'");
        expect(pgmindRows).toHaveLength(0);
    });

    it("expired approvals cannot execute", async () => {
        const store = new ApprovalStore();
        const classifier = new SqlOperationClassifier();
        const analysisService = new SqlAnalysisService();

        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-11-21T10:00:00Z"));

        const request = store.create({
            sql: "INSERT INTO write_test (name, status) VALUES ('expired_test', 'pending')",
            operation: "INSERT",
            database: "supergen",
            connectionName: "supergen",
        });

        store.updateStatus(request.id, "approved");

        vi.advanceTimersByTime(5 * 60 * 1000);
        vi.useRealTimers();

        const executionService = new OperationExecutionService(store, classifier, supergenDb);

        await expect(executionService.executeOperation(request.id)).rejects.toThrow(
            "not approved",
        );

        expect(store.getById(request.id)?.status).toBe("expired");
    });

    it("approval cannot be reused after execution", async () => {
        const { approvalWorkflow, executionService } = buildServices(supergenDb);

        const sql = "INSERT INTO write_test (name, status) VALUES ('reuse_test', 'pending')";
        const result = await approvalWorkflow.prepareAndConfirm(sql);

        await executionService.executeOperation(result.id);

        await expect(executionService.executeOperation(result.id)).rejects.toThrow("not approved");

        const rows = await supergenDb.query("SELECT * FROM write_test WHERE name = 'reuse_test'");
        expect(rows).toHaveLength(1);
    });
});
