import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { StartedPostgreSqlContainer, PostgreSqlContainer } from "@testcontainers/postgresql";
import { DatabaseService } from "../database/database.service.js";
import { Pool } from "pg";
import { ApprovalStore } from "./approval.store.js";
import { ApprovalService } from "./approval.service.js";
import { ApprovalWorkflowService } from "./approval-workflow.service.js";
import { SqlOperationClassifier } from "../query/sql-operation-classifier.js";
import { SqlAnalysisService } from "../query/sql-analysis.service.js";
import { execSync } from "child_process";

let dockerAvailable = false;
try {
    execSync("docker version", { stdio: "ignore" });
    dockerAvailable = true;
} catch {
    dockerAvailable = false;
}

const describeIfDocker = dockerAvailable ? describe : describe.skip;

describeIfDocker("Approval Workflow Integration Tests (requires Docker)", () => {
    let container: StartedPostgreSqlContainer;
    let database: DatabaseService;
    let writePool: Pool;
    let queryUrl: string;
    let writeUrl: string;
    let writerUrl: string;

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
        writerUrl = `postgresql://pgmind_writer:postgres@${host}:${port}/pgmind_test`;

        writePool = new Pool({ connectionString: writeUrl });

        await setupTestRoles();
    }, 120000);

    afterAll(async () => {
        await writePool?.end();
        await database?.shutdown();
        await container?.stop();
    }, 30000);

    async function setupTestRoles(): Promise<void> {
        const client = await writePool.connect();
        try {
            await client.query(`CREATE ROLE pgmind_readonly NOINHERIT`);
            await client.query(`CREATE ROLE pgmind_writer NOINHERIT`);
            await client.query(`GRANT CONNECT ON DATABASE pgmind_test TO pgmind_readonly, pgmind_writer`);
            await client.query(`GRANT USAGE ON SCHEMA public TO pgmind_readonly, pgmind_writer`);
            await client.query(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO pgmind_readonly`);
            await client.query(`GRANT INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO pgmind_writer`);
            await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO pgmind_readonly`);
            await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT INSERT, UPDATE, DELETE ON TABLES TO pgmind_writer`);
            
            await client.query(`CREATE TABLE IF NOT EXISTS approval_test (id SERIAL PRIMARY KEY, name TEXT, status TEXT)`);
            await client.query(`GRANT SELECT ON approval_test TO pgmind_readonly`);
            await client.query(`GRANT INSERT, UPDATE, DELETE ON approval_test TO pgmind_writer`);
            await client.query(`GRANT USAGE, SELECT ON SEQUENCE approval_test_id_seq TO pgmind_writer`);
        } finally {
            client.release();
        }
    }

    beforeEach(async () => {
        database = new DatabaseService(queryUrl, writerUrl, {
            expectedDatabase: "pgmind_test",
            expectedUsername: "pgmind_writer",
            poolMaxRead: 5,
            poolMaxWrite: 5,
        });
        await database.verifyConnections();
    });

    afterEach(async () => {
        await database?.shutdown();
    });

    it("should complete full approval workflow: prepare -> approve -> execute", async () => {
        const approvalStore = new ApprovalStore();
        const classifier = new SqlOperationClassifier();
        const analysisService = new SqlAnalysisService();
        const approvalService = new ApprovalService(approvalStore, classifier, analysisService, database);
        
        // Mock confirmation provider that auto-approves
        const mockConfirmationProvider = {
            confirm: vi.fn().mockResolvedValue("approve"),
        };

        const approvalWorkflow = new ApprovalWorkflowService(approvalService, mockConfirmationProvider as any);

        const sql = "INSERT INTO approval_test (name, status) VALUES ('workflow_test', 'pending')";

        // Prepare
        const prepareResult = await approvalWorkflow.prepareAndConfirm(sql);
        expect(prepareResult.status).toBe("approved");
        expect(prepareResult.id).toBeDefined();

        // Execute
        const { OperationExecutionService } = await import("./operation-execution.service.js");
        const executionService = new OperationExecutionService(approvalStore, classifier, database);
        
        const execResult = await executionService.executeOperation(prepareResult.id);
        expect(execResult.status).toBe("executed");
        expect(execResult.affectedRows).toBe(1);

        // Verify in database
        const result = await database.query("SELECT * FROM approval_test WHERE name = 'workflow_test'");
        expect(result).toHaveLength(1);
        expect(result[0].status).toBe("pending");
    });

    it("should reject workflow for read-only SQL", async () => {
        const approvalStore = new ApprovalStore();
        const classifier = new SqlOperationClassifier();
        const analysisService = new SqlAnalysisService();
        const approvalService = new ApprovalService(approvalStore, classifier, analysisService, database);
        
        const mockConfirmationProvider = {
            confirm: vi.fn().mockResolvedValue("approve"),
        };

        const approvalWorkflow = new ApprovalWorkflowService(approvalService, mockConfirmationProvider as any);

        await expect(
            approvalWorkflow.prepareAndConfirm("SELECT * FROM approval_test")
        ).rejects.toThrow("Unsupported write operation");
    });

    it("should expire approval after TTL", async () => {
        const approvalStore = new ApprovalStore();
        
        const request = approvalStore.create({
            sql: "INSERT INTO approval_test (name, status) VALUES ('expiry_test', 'pending')",
            operation: "INSERT",
            database: "pgmind_test",
        });

        // Manually set old timestamp
        const stored = approvalStore.getById(request.id);
        if (stored) {
            stored.createdAt = new Date(Date.now() - 6 * 60 * 1000); // 6 minutes ago
        }

        // Cleanup should remove expired
        approvalStore.deleteExpired();

        expect(approvalStore.getById(request.id)).toBeUndefined();
    });

    it("should handle concurrent approval requests", async () => {
        const approvalStore = new ApprovalStore();
        const classifier = new SqlOperationClassifier();
        const analysisService = new SqlAnalysisService();
        const approvalService = new ApprovalService(approvalStore, classifier, analysisService, database);
        const { OperationExecutionService } = await import("./operation-execution.service.js");
        const executionService = new OperationExecutionService(approvalStore, classifier, database);
        
        const mockConfirmationProvider = {
            confirm: vi.fn().mockResolvedValue("approve"),
        };

        const approvalWorkflow = new ApprovalWorkflowService(approvalService, mockConfirmationProvider as any);

        // Create multiple concurrent approvals
        const promises = Array.from({ length: 5 }, (_, i) => 
            approvalWorkflow.prepareAndConfirm(
                `INSERT INTO approval_test (name, status) VALUES ('concurrent_${i}', 'pending')`
            )
        );

        const results = await Promise.all(promises);
        expect(results).toHaveLength(5);
        expect(results.every(r => r.status === "approved")).toBe(true);

        // Execute all
        const execPromises = results.map(r => executionService.executeOperation(r.id));
        const execResults = await Promise.all(execPromises);
        expect(execResults.every(r => r.status === "executed")).toBe(true);

        // Verify all inserted
        const count = await database.query("SELECT COUNT(*) FROM approval_test WHERE name LIKE 'concurrent_%'");
        expect(parseInt(count[0].count)).toBe(5);
    });

    it("should not execute same approval twice", async () => {
        const approvalStore = new ApprovalStore();
        const classifier = new SqlOperationClassifier();
        const analysisService = new SqlAnalysisService();
        const approvalService = new ApprovalService(approvalStore, classifier, analysisService, database);
        const { OperationExecutionService } = await import("./operation-execution.service.js");
        const executionService = new OperationExecutionService(approvalStore, classifier, database);
        
        const mockConfirmationProvider = {
            confirm: vi.fn().mockResolvedValue("approve"),
        };

        const approvalWorkflow = new ApprovalWorkflowService(approvalService, mockConfirmationProvider as any);

        const result = await approvalWorkflow.prepareAndConfirm(
            "INSERT INTO approval_test (name, status) VALUES ('duplicate_exec', 'pending')"
        );

        await executionService.executeOperation(result.id);
        
        await expect(executionService.executeOperation(result.id))
            .rejects.toThrow("not approved");
    });
});