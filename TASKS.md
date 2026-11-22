# QueryMind — Development Tasks

Roadmap broken into milestones. Follow the project rule: **understand → implement → run → test → review → proceed**.

> **Status note:** This document tracks planned and completed work. Milestones 1–3 and the write-operation milestone are complete. Milestones 4–5 (AI integration via Ollama, query explanation/EXPLAIN) are **not implemented**. SQL is supplied by the MCP client/LLM; QueryMind validates and executes it. Write operations support INSERT, UPDATE, DELETE, and an explicitly allowlisted set of DDL operations (CREATE, ALTER, DROP, TRUNCATE); arbitrary SQL and arbitrary DDL are not supported.

## Milestone 1 — Foundation ✅ Complete

**Goal:** MCP server running, TypeScript configured, project initialized.

- [x] Initialize pnpm workspace / package.json at repo root
- [x] Configure TypeScript (`tsconfig.json`) with strict mode
- [x] Install MCP TypeScript SDK (`@modelcontextprotocol/sdk`)
- [x] Install `pg` (node-postgres), `zod`, `vitest`, and dev dependencies
- [x] Create `src/index.ts` application entry point
- [x] Create `src/config/` for environment-based configuration
- [x] Create `src/mcp/` tool registration (in `src/index.ts`, not a separate `src/mcp/` directory)
- [x] Create placeholder MCP tool (`ping`)
- [x] Verify the MCP server starts and responds to a tool call via stdio
- [x] Add `.gitignore`, `.env.example`, and `docker-compose.yml`

**Success:** MCP server can be started and a tool can be invoked through an MCP client.

## Milestone 2 — Database Connectivity ✅ Complete

**Goal:** PostgreSQL connection and schema introspection working.

- [x] Create `src/modules/database/database.service.ts` (read + write pools)
- [x] Create `src/modules/schema/schema.service.ts` and `schema.types.ts`
- [x] Implement PostgreSQL connection with configurable connection strings
- [x] Use read-only database credentials (`querymind_readonly`)
- [x] Implement table, column, and foreign-key introspection (information_schema queries)
- [x] Expose schema introspection as an MCP tool (`get_database_schema`)
- [x] Write unit tests for SQL validator and query executor

**Success:** Ask an MCP client to inspect a real PostgreSQL database and receive table/column/FK info.

## Milestone 3 — Query Engine ✅ Complete

**Goal:** SQL validation and safe read-only execution.

- [x] Integrate `pgsql-ast-parser` (PostgreSQL-aware SQL parser)
- [x] Create `src/modules/query/query.service.ts`
- [x] Create `src/modules/query/sql-validator.ts` (read-only path)
- [x] Implement SQL parsing to determine statement type
- [x] Implement read-only validation (reject INSERT, UPDATE, DELETE, DROP, etc.)
- [x] Reject dangerous constructs even within SELECT (e.g., CTEs with writes, SELECT FOR UPDATE/SHARE, SELECT INTO)
- [x] Implement execution timeout (10s statement timeout)
- [x] Implement row limit (100 rows) and result size limit (1 MB) with truncation reporting
- [x] Implement query execution against PostgreSQL via pg pool
- [x] Return structured query results (columns, rows, row count, truncated)
- [x] Expose query execution as an MCP tool (`execute_query`)
- [x] Write unit tests for SQL validator and query executor

**Success:** Execute safe SQL through MCP — results returned without touching writes.

## Milestone: Human-Approved Write Operations ✅ Complete

**Goal:** Write operations (INSERT, UPDATE, DELETE, and an explicitly allowlisted set of DDL operations: CREATE, ALTER, DROP, TRUNCATE) behind explicit human approval.

- [x] Create `src/modules/query/sql-operation-classifier.ts` (operation + category + requiresApproval)
- [x] Create `src/modules/query/write-sql-validator.ts` (INSERT/UPDATE/DELETE and allowlisted DDL types)
- [x] Create `src/modules/approval/approval.store.ts` (in-memory Map, UUID, 5-min TTL, single-use claims)
- [x] Create `src/modules/approval/approval.service.ts`
- [x] Create `src/modules/approval/approval-workflow.service.ts`
- [x] Create `src/modules/approval/approval-confirmation.ts` (ApprovalConfirmationProvider interface)
- [x] Create `src/modules/approval/mcp-approval-confirmation.provider.ts` (MCP elicitation)
- [x] Create `src/modules/approval/operation-execution.service.ts`
- [x] Create `src/modules/approval/operation-execution-workflow.service.ts`
- [x] Register `prepare_operation` and `execute_approved_operation` MCP tools
- [x] Add `WRITE_DATABASE_URL` support, `WRITE_ROLE_NAME` configurable writer role (default `querymind_writer`), and runtime database/role verification
- [x] Write unit tests for approval store, service, workflow, provider, and execution
- [x] Implement transaction handling with `CommitOutcomeUnknownError` for uncertain commit outcomes
- [x] Implement failed rollback connection discard from the pool

**Success:** Write operations require human approval; execution runs exact stored SQL by approval ID only.

## Milestone 4 — AI Integration ❌ Not Implemented

**Goal:** Natural language → SQL via Ollama.

- [ ] Create LLM provider interface and Ollama provider
- [ ] Implement natural language → SQL generation
- [ ] Wire AI layer into the query execution pipeline
- [ ] Expose NL-to-SQL as an MCP tool

**Status:** Not implemented. SQL is supplied by the MCP client/LLM; QueryMind does not generate SQL.

## Milestone 5 — Database Intelligence ❌ Not Implemented

**Goal:** Query explanation and optimization recommendations.

- [ ] Implement EXPLAIN / EXPLAIN ANALYZE support
- [ ] Return execution plan information
- [ ] Implement query optimization recommendations

**Status:** Not implemented. `EXPLAIN` is rejected by the read-only validator.

## Milestone 6 — MVP Polish 🔄 In Progress

**Goal:** Reproducible, demonstrable project.

- [x] Centralized error handling across MCP tools (MCP `isError` responses)
- [x] Automated tests (Vitest) for core modules (195 tests, 10 files, all passing)
- [x] Docker Compose for PostgreSQL (one-command local stack)
- [x] Documentation (README, docs/, opencode-setup.md)
- [ ] Create a demo script or example queries
- [ ] Run benchmarks / smoke tests against a sample database

## Notes

- Authentication and authorization are postponed — not part of this roadmap.
- No Go, no gRPC, no separate microservices.
- Directories `src/infrastructure/`, `src/mcp/`, `src/ai/`, `src/analysis/`, `test/`, and `docker/` were planned but never created. MCP tools are registered in `src/index.ts`; tests are colocated with source.
- `context.md` does not exist (it is gitignored).
- Create directories only when their corresponding functionality is needed.
- **Live PostgreSQL integration checks** (separate from automated unit tests): `CREATE INDEX`, `ALTER INDEX ... RENAME TO`, `DELETE`, and `WITH ... UPDATE` have been executed against a live PostgreSQL instance through the approval workflow. Not all allowlisted DDL operations have been live-tested; unit coverage covers all allowlisted AST types across classifier, validator, and execution service.