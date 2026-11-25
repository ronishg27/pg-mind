# PGMind Architecture

PGMind is a **modular TypeScript monolith** — a single deployable application with separated concerns. It does not contain its own LLM. The MCP client (e.g., OpenCode) provides the AI agent, while PGMind provides database capabilities and execution safeguards.

```
User → OpenCode LLM → PGMind MCP Server → PGMind Services → PostgreSQL.
```

## Module Layout

```
src/
├── index.ts                  # MCP server entry point; registers all 5 tools
├── config/index.ts           # Environment configuration
├── modules/
│   ├── database/             # DatabaseService (read + write pools)
│   ├── schema/               # SchemaService (schema introspection)
│   ├── query/                # SqlValidator, SqlOperationClassifier, WriteSqlValidator, QueryService
│   └── approval/             # ApprovalStore, ApprovalService, ApprovalWorkflowService,
│                             # ApprovalConfirmationProvider, McpApprovalConfirmationProvider,
│                             # OperationExecutionService, OperationExecutionWorkflowService
└── scripts/                  # Development smoke-test scripts (require a live database)
```

MCP tools are registered in `src/index.ts`. Business logic lives in the services under `src/modules/`, not inside MCP tool handlers.

## Two Database Execution Paths

PGMind has two distinct database execution paths:

### A. Read-only execution path

Used by `execute_query`. Responsibilities:

- Execute SELECT queries (and read-only WITH/CTE queries).
- Validate SQL before execution using `SqlValidator`.
- Reject unsupported and unsafe operations (INSERT, UPDATE, DELETE, CREATE, ALTER, DROP, TRUNCATE, etc.).
- Execute queries through the read-only database connection.
- Use read-only transactions (`BEGIN READ ONLY`).
- Apply a 10-second statement timeout.
- Limit returned rows to 100.
- Limit result size to 1 MB.
- Report whether results were truncated (`truncated` flag).

The dedicated PostgreSQL role is `pgmind_readonly`.

**Important:** Database-level read-only permissions are the primary security boundary. Application-level SQL validation alone is not a sufficient security boundary. The read-only role must not have INSERT, UPDATE, DELETE, CREATE, or similar privileges.

### B. Approval-gated write execution path

This is the major architectural addition. Used by `prepare_operation` and `execute_approved_operation`.

The workflow is:

1. The user requests a database modification.
2. The LLM generates SQL.
3. The LLM calls `prepare_operation`.
4. PGMind classifies the SQL (`SqlOperationClassifier`).
5. PGMind creates an approval request (`ApprovalStore`).
6. The MCP elicitation mechanism presents the complete SQL and operation summary to the human (`McpApprovalConfirmationProvider`).
7. The human explicitly approves, rejects, or cancels.
8. If approved, PGMind stores the approved request (`approved` status).
9. The LLM can subsequently call `execute_approved_operation` with the approval ID.
10. PGMind validates the stored SQL again (`WriteSqlValidator`).
11. PGMind claims the approval request for execution (`approved` → `executing`).
12. PGMind verifies the writer connection (database + role identity).
13. PGMind executes the exact stored SQL in a transaction.
14. PGMind records the final execution status and affected row count.

```
┌─────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   LLM       │────▶│ prepare_operation│────▶│  MCP Elicitation│
│ generates   │     │ (classify + store│     │   (human review)│
│ SQL         │     │  pending approval│     └────────┬────────┘
└─────────────┘     └──────────────────┘             │ approve
                                                    ▼
                                          ┌─────────────────┐
                                          │  ApprovalStore  │
                                          │  (approved)     │
                                          └────────┬────────┘
                                                   │ execute_approved_operation
                                                   ▼
                                          ┌─────────────────┐
                                          │WriteSqlValidator│
                                          │(re-validate SQL)│
                                          └────────┬────────┘
                                                   ▼
                                          ┌─────────────────┐
                                          │ ApprovalStore   │
                                          │ (executing claim│
                                          │  single-use)    │
                                          └────────┬────────┘
                                                   ▼
                                          ┌─────────────────┐
                                          │DatabaseService  │
                                          │ withWriteTxn    │
                                          │ (verify role,   │
                                          │  10s timeout,   │
                                          │  COMMIT)        │
                                          └────────┬────────┘
                                                   ▼
                                          ┌─────────────────┐
                                          │  Status recorded│
                                          │ (executed/failed│
                                          │  /execution_unknown)│
                                          └─────────────────┘
```

Key constraints:

- The execution tool (`execute_approved_operation`) must **never** accept arbitrary SQL. It accepts an approval ID (UUID) and retrieves the exact SQL from the approval store.
- The LLM must not be able to approve its own operations through a separate model-callable approval tool. Human approval happens through the MCP confirmation/elicitation provider only.
- Approval does **not** execute SQL. `prepare_operation` only stores a pending approval request.

## Database Connections

`DatabaseService` manages two connection pools:

| Pool | Env var | Required? | Role | Purpose |
|------|---------|-----------|------|---------|
| Read pool | `QUERY_DATABASE_URL` | Yes | `pgmind_readonly` | Schema discovery, read-only queries, metadata |
| Write pool | `WRITE_DATABASE_URL` | No | `writeRoleName` (default `pgmind_writer`) | Execute approved write operations |

The write pool is optional. If `WRITE_DATABASE_URL` is not configured, `DatabaseService` is created without a write pool, and any attempt to execute a write operation fails with `"Write pool is not configured"`.

The expected writer role name is configured via `WRITE_ROLE_NAME` and defaults to `pgmind_writer`. The writer connection identity is verified at runtime in `withWriteTransaction`, so the configured role name must match the actual PostgreSQL role used by `WRITE_DATABASE_URL`.

### Read transaction (`withReadOnlyTransaction`)

- `BEGIN READ ONLY`
- `SET LOCAL statement_timeout = '10s'`
- Execute callback
- `COMMIT` on success, `ROLLBACK` on error
- Connection always released in `finally`

### Write transaction (`withWriteTransaction`)

- Requires the write pool; throws `"Write pool is not configured"` if absent.
- `BEGIN`
- Verify connection identity: `current_database()` must equal the expected database (from the approval request), and `current_user` must equal the configured writer role (`writeRoleName`, default `pgmind_writer`, overridable via `WRITE_ROLE_NAME`). A mismatch aborts the operation.
- `SET LOCAL statement_timeout = '10s'`
- Execute callback (the exact stored SQL)
- `COMMIT` — from this point onward a failed COMMIT has an **uncertain outcome**. If COMMIT fails, a `CommitOutcomeUnknownError` is thrown rather than assuming rollback.
- `ROLLBACK` on error (before COMMIT attempt). If ROLLBACK also fails, the connection client is discarded from the pool rather than returned for reuse, preventing an uncertain connection from being recycled. The original operation error is preserved and rethrown.
- Connection released in `finally`; `client.release(releaseError)` is used so a commit or rollback error causes the client to be removed from the pool.

## Commit Outcome Handling

`CommitOutcomeUnknownError` is thrown when the COMMIT request fails. A failed COMMIT does **not** necessarily mean the transaction was rolled back — the database may already have committed it. The connection client is discarded from the pool rather than returned for reuse. PGMind therefore marks the execution as `execution_unknown` rather than assuming failure or retrying automatically. An unknown commit outcome means the operation may or may not have been applied. Manual database-state verification is required before any new attempt, and retrying blindly could cause duplicate effects.

## SQL Validation and Classification

PGMind separates SQL validation and classification into distinct components:

- **`SqlValidator`** — protects the read-only execution path. Allows only SELECT and WITH statements; rejects disallowed statement types, disallowed functions, SELECT FOR UPDATE/SHARE, and SELECT INTO. Exactly one statement required. Max 50,000 characters.
- **`SqlOperationClassifier`** — classifies SQL into operations (SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, DROP, TRUNCATE, OTHER) and categories (read, write, unknown), with an `requiresApproval` flag. Handles direct statements, WITH statements, data-modifying CTEs, and nested CTEs. Rejects multiple statements, invalid syntax, and unsupported SQL (e.g., EXPLAIN).
- **`WriteSqlValidator`** — a separate validator for the write execution path. Accepts INSERT, UPDATE, DELETE, and an explicitly allowlisted set of DDL statement types (CREATE, ALTER, DROP, TRUNCATE). Rejects data-modifying CTEs while allowing CTEs containing read-only SELECT statements. Rejects SELECT INTO/FOR UPDATE and disallowed functions. Transaction-incompatible operations such as `CREATE INDEX CONCURRENTLY` and `DROP INDEX CONCURRENTLY` are rejected because they cannot run inside a transaction.

Separate validators exist because the read-only and write paths have different security requirements. Merging them into one permissive validator would weaken the read-only path's guarantees.

## Approval Storage

`ApprovalStore` uses an in-memory `Map`:

- UUID-based approval IDs.
- Five-minute expiration (TTL).
- Defensive copies returned from the store (callers cannot mutate stored requests).
- Single-use execution claims (an approval can only be executed once).
- Explicit status transitions (defined in `ALLOWED_TRANSITIONS`).
- Expiration checks when accessing requests (`pending` and `approved` expire to `expired`).
- Expired request cleanup (`deleteExpired`).

**Limitation:** Approval requests disappear when the server restarts. In-memory storage is not durable.

## MCP Tools

Five tools are registered in `src/index.ts`:

| Tool | Input | Output | Modifies DB? |
|------|-------|--------|--------------|
| `ping` | `{ message?: string }` | Text: `"PGMind is running. Pong!"` or echo | No |
| `execute_query` | `{ sql: string }` (1–50,000 chars) | JSON `QueryResult` (columns, rows, rowCount, truncated) | No |
| `get_database_schema` | `{}` | JSON schema (schemas, tables, columns, constraints) | No |
| `prepare_operation` | `{ sql: string }` (1–50,000 chars) | JSON `{ id, status, message }` | No (stores approval only) |
| `execute_approved_operation` | `{ approvalId: uuid }` | JSON `{ approvalId, operation, database, affectedRows, status, message }` | Yes |

All tools catch errors and return MCP `isError` responses with the error message.
