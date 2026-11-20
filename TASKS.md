# QueryMind — Development Tasks

Roadmap broken into small, manageable tasks across six milestones. Follow the project rule: **understand → implement → run → test → review → proceed**.

## Milestone 1 — Foundation

**Goal:** MCP server running, TypeScript configured, project initialized.

### Tasks

- [ ] Initialize pnpm workspace / package.json at repo root
- [ ] Configure TypeScript (`tsconfig.json`) with strict mode
- [ ] Install MCP TypeScript SDK (`@modelcontextprotocol/sdk`)
- [ ] Install `pg` (node-postgres), `zod`, `vitest`, and dev dependencies
- [ ] Create `src/index.ts` application entry point
- [ ] Create `src/config/` for environment-based configuration
- [ ] Create `src/infrastructure/` for logging and shared utilities
- [ ] Scaffold `src/mcp/tools/`, `src/mcp/resources/`, `src/mcp/prompts/`
- [ ] Create a placeholder MCP tool (e.g., `ping` / `hello`)
- [ ] Verify the MCP server starts and responds to a tool call via stdio
- [ ] Add `.gitignore`, `.env.example`, and basic `docker-compose.yml` placeholders

**Success:** MCP server can be started and a tool can be invoked through an MCP client.

---

## Milestone 2 — Database Connectivity

**Goal:** PostgreSQL connection and schema introspection working.

### Tasks

- [ ] Create `src/modules/database/database.service.ts`
- [ ] Create `src/modules/database/connection.manager.ts` (pg pool management)
- [ ] Create `src/modules/database/database.types.ts`
- [ ] Implement PostgreSQL connection with configurable params (host, port, user, password, database)
- [ ] Implement connection testing (verify connectivity on startup)
- [ ] Use read-only database credentials
- [ ] Create `src/modules/schema/schema.service.ts`
- [ ] Create `src/modules/schema/schema.types.ts`
- [ ] Implement table and column introspection (information_schema queries)
- [ ] Implement foreign-key relationship detection
- [ ] Expose schema introspection as an MCP tool
- [ ] Write unit tests for database connection and schema queries

**Success:** Ask an MCP client to inspect a real PostgreSQL database and receive table/column/FK info.

---

## Milestone 3 — Query Engine

**Goal:** SQL validation and safe read-only execution.

### Tasks

- [ ] Select and integrate a PostgreSQL-aware SQL parser (TS equivalent of pg_query)
- [ ] Create `src/modules/query/query.service.ts`
- [ ] Create `src/modules/query/sql.validator.ts`
- [ ] Create `src/modules/query/query.types.ts`
- [ ] Implement SQL parsing to determine statement type
- [ ] Implement read-only validation (reject INSERT, UPDATE, DELETE, DROP, etc.)
- [ ] Reject dangerous constructs even within SELECT (e.g., CTEs with writes)
- [ ] Implement configurable execution timeout
- [ ] Implement configurable row limit
- [ ] Implement query execution against PostgreSQL via pg pool
- [ ] Return structured query results (columns, rows, row count)
- [ ] Expose query execution as an MCP tool
- [ ] Write unit tests for SQL validator and query executor

**Success:** Execute safe SQL through MCP — natural language or manual SQL returns results without touching writes.

---

## Milestone 4 — AI Integration

**Goal:** Natural language → SQL via Ollama.

### Tasks

- [ ] Create `src/ai/providers/` with a custom TypeScript LLM provider interface
- [ ] Implement Ollama provider (chat/completions endpoint)
- [ ] Create `src/ai/sql-generation/` for NL-to-SQL logic
- [ ] Create `src/ai/prompts/` for SQL generation prompts
- [ ] Implement schema context retrieval (feed schema info to the LLM)
- [ ] Implement natural language → SQL generation flow
- [ ] Implement structured output validation for generated SQL (Zod)
- [ ] Wire AI layer into the query execution pipeline (generate → validate → execute)
- [ ] Expose NL-to-SQL as an MCP tool
- [ ] Write unit tests for AI provider and SQL generation

**Success:** Ask a question in natural language and receive actual database results through MCP.

---

## Milestone 5 — Database Intelligence

**Goal:** Query explanation and optimization recommendations.

### Tasks

- [ ] Create `src/modules/analysis/analysis.service.ts`
- [ ] Implement EXPLAIN / EXPLAIN ANALYZE support for a query
- [ ] Return execution plan information in structured form
- [ ] Implement query optimization recommendations (e.g., missing indexes, sequential scans)
- [ ] Implement AI result analysis (interpret query results in plain language)
- [ ] Expose query explanation as an MCP tool
- [ ] Write unit tests for analysis service

**Success:** QueryMind can explain and analyze database behavior — users understand how their queries execute.

---

## Milestone 6 — MVP Polish

**Goal:** Reproducible, demonstrable GitHub project.

### Tasks

- [ ] Implement centralized error handling across MCP tools and services
- [ ] Add structured logging throughout the application
- [ ] Write automated tests (Vitest) for all core modules
- [ ] Set up Docker Compose for PostgreSQL + Ollama (one-command local stack)
- [ ] Create `docker/` directory with Dockerfiles if needed
- [ ] Write documentation (README, setup, MCP client configuration)
- [ ] Create a demo script or example queries
- [ ] Run benchmarks / smoke tests against a sample database
- [ ] Final review of all safety rules (read-only by default, SQL validation, timeouts, row limits)

**Success:** A reproducible, demonstrable GitHub project that can be cloned and run with Docker Compose.

---

## Notes

- Authentication and authorization are postponed — not part of this roadmap.
- No Go, no gRPC, no separate microservices.
- Create directories only when their corresponding functionality is needed.