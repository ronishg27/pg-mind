# Development

## Prerequisites

- Node.js (LTS)
- pnpm (package manager is `pnpm@10.17.1`; do not use npm or yarn)
- Docker & Docker Compose (for PostgreSQL, required by database-dependent scripts)

## Install

```bash
pnpm install
```

## Scripts

All scripts run from the repo root.

| Script | Command | Description |
|--------|---------|-------------|
| `dev` | `tsx watch src/index.ts` | Run the MCP server in watch mode |
| `build` | `tsc` | Compile TypeScript to `dist/` |
| `start` | `node dist/index.js` | Run the compiled MCP server (requires `build` first) |
| `typecheck` | `tsc --noEmit` | Type-check without emitting |
| `test` | `vitest run --coverage` | Run all unit tests with coverage |
| `test:watch` | `vitest watch` | Run tests in watch mode |
| `db:test` | `tsx src/scripts/test-database.ts` | Test read connection (uses `DATABASE_URL`) |
| `db:schema` | `tsx src/scripts/test-schema.ts` | List schemas (uses `DATABASE_URL`) |
| `db:tables` | `tsx src/scripts/test-tables.ts` | List tables (uses `DATABASE_URL`) |
| `db:columns` | `tsx src/scripts/test-columns.ts` | List columns (uses `DATABASE_URL`) |
| `db:constraints` | `tsx src/scripts/test-constraints.ts` | List constraints (uses `DATABASE_URL`) |
| `db:schema:full` | `tsx src/scripts/test-full-schema.ts` | Full schema dump (uses `DATABASE_URL`) |
| `query:test` | `tsx src/scripts/test-query-service.ts` | Test read-only query service (uses `QUERY_DATABASE_URL`) |
| `db:write:test` | `tsx src/scripts/test-write-connection.ts` | Test write connection + transaction rollback (uses `QUERY_DATABASE_URL` and `WRITE_DATABASE_URL`) |

There is **no `pnpm lint`** script and no ESLint/Prettier config.

Run one test file:

```bash
vitest run src/modules/query/sql-validator.test.ts
```

## Tests

Tests are colocated with source at `src/**/*.test.ts` (Vitest). There is no separate `test/` directory.

### Verified test results

A fresh run of `pnpm test` produces:

- **8 test files passed**
- **98 tests passed**
- Duration: ~1 second

Test coverage by module:

| Test file | Module under test | Tests |
|-----------|-------------------|-------|
| `approval.store.test.ts` | `ApprovalStore` | 27 |
| `approval.service.test.ts` | `ApprovalService` | 10 |
| `approval-workflow.service.test.ts` | `ApprovalWorkflowService` | 6 |
| `mcp-approval-confirmation.provider.test.ts` | `McpApprovalConfirmationProvider` | 7 |
| `operation-execution.service.test.ts` | `OperationExecutionService` | 8 |
| `operation-execution-workflow.service.test.ts` | `OperationExecutionWorkflowService` | 2 |
| `sql-operation-classifier.test.ts` | `SqlOperationClassifier` | 25 |
| `write-sql-validator.test.ts` | `WriteSqlValidator` | 13 |
| **Total** | **8 test files** | **98** |

### What the tests cover

- **SQL operation classification** — SELECT/WITH as read; INSERT/UPDATE/DELETE/CREATE/ALTER/DROP/TRUNCATE as write; data-modifying CTEs; multiple statements; invalid syntax; unsupported SQL (EXPLAIN, DROP SCHEMA/VIEW).
- **Read-only SQL validation** (`SqlValidator`) — SELECT/WITH allowed; disallowed statement types rejected; disallowed functions rejected; SELECT FOR UPDATE/SHARE and SELECT INTO rejected; exactly one statement; max 50,000 characters.
- **Write SQL validation** (`WriteSqlValidator`) — INSERT/UPDATE/DELETE allowed; data-modifying CTEs rejected; read-only CTEs allowed; SELECT rejected; CREATE/TRUNCATE rejected; invalid syntax, multiple statements, and over-length SQL rejected; disallowed functions rejected.
- **Approval storage and expiration** (`ApprovalStore`) — creation, UUIDs, timestamps, defensive copies, status transitions, expiration on access, single-use claims, `deleteExpired`, expired-approved rejection.
- **Approval workflow** (`ApprovalWorkflowService`) — approve, reject, cancel, confirmation failure, no execution after approval.
- **MCP elicitation provider** (`McpApprovalConfirmationProvider`) — approve/reject/cancel/decline/incomplete/error handling; displays complete SQL and summary.
- **Operation execution** (`OperationExecutionService`) — successful execution, failed execution, missing/not-approved rejection, single-use protection, unsupported operation rejection, `execution_unknown` on commit uncertainty, no retry of `execution_unknown`.
- **Execution workflow** (`OperationExecutionWorkflowService`) — returns result, propagates errors.

### Database-dependent scripts

The `db:*` and `query:test` and `db:write:test` scripts require a running PostgreSQL instance and a configured `.env`. Start infrastructure with:

```bash
docker compose up -d
```

Then copy `.env.example` to `.env` and fill in credentials before running these scripts.

## TypeScript Configuration

- Target: ES2022
- Module: NodeNext (import paths use `.js` extensions)
- Strict mode: enabled
- Output: `dist/`
- Included: `src/**/*.ts`

## Environment Loading

`process.loadEnvFile(".env")` is called at startup in `src/index.ts` and `src/config/index.ts`. Restart the server after changing `.env`.
