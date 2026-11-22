# QueryMind

QueryMind is a **TypeScript-only MCP (Model Context Protocol) server** that connects to PostgreSQL, understands its schema, validates SQL for safety, executes read-only queries, and supports write operations behind explicit human approval. It exposes schema introspection, query execution, and write-operation management as MCP tools.

The general architecture is:

```
User → OpenCode LLM → QueryMind MCP Server → QueryMind Services → PostgreSQL.
```

QueryMind does **not** contain its own LLM. The MCP client provides the AI agent, while QueryMind provides database capabilities and execution safeguards.

## Features

| Feature | Status |
|---------|--------|
| MCP server (stdio) | Available |
| PostgreSQL connection management | Available |
| Schema introspection (tables, columns, foreign keys) | Available |
| Read-only query execution (timeouts, row limits, size limits) | Available |
| SQL validation (read-only, pg-aware AST parser) | Available |
| Write operations behind human approval | Available |
| Approval-gated write execution (INSERT, UPDATE, DELETE) | Available |
| Query explanation & EXPLAIN support | Not yet |
| Authentication / authorization | Not yet |
| Multi-tenancy | Not yet |

## Architecture

QueryMind is a **modular TypeScript monolith**. Business logic lives in independent services under `src/modules/` (`database`, `schema`, `query`, `approval`), not inside MCP tool handlers.

```
MCP Client (OpenCode / other)
        │ MCP protocol (stdio)
        ▼
QueryMind TypeScript Application (src/index.ts)
├── MCP tools: ping, execute_query, get_database_schema,
│   prepare_operation, execute_approved_operation
├── Services: database, schema, query, approval
└── Infrastructure: pg driver, pgsql-ast-parser, config
        │
        ▼
External PostgreSQL Database
```

There are two distinct database execution paths:

1. **Read-only execution path** — `execute_query` runs validated SELECT/WITH SQL through a read-only connection pool (`QUERY_DATABASE_URL`, role `querymind_readonly`) inside a read-only transaction with a 10s statement timeout, a 100-row limit, and a 1 MB result-size limit.

2. **Approval-gated write execution path** — `prepare_operation` classifies SQL and requests human approval via MCP elicitation; `execute_approved_operation` runs the exact stored SQL through a separate write connection pool (`WRITE_DATABASE_URL`, role `querymind_writer`) only after explicit human approval.

See `docs/architecture.md` for detailed execution flows.

## Technology Stack

| Component | Choice |
|-----------|--------|
| Language | TypeScript (strict, ESM, NodeNext) |
| Runtime | Node.js |
| Package manager | pnpm |
| MCP server | Official MCP TypeScript SDK (`@modelcontextprotocol/sdk`), stdio transport |
| Database | PostgreSQL |
| Database access | `pg` (node-postgres) directly — no ORM |
| SQL parsing | `pgsql-ast-parser` (PostgreSQL-aware AST parser) |
| Validation | Zod |
| Testing | Vitest (tests colocated at `src/**/*.test.ts`) |
| Containerization | Docker Compose (`docker-compose.yaml`, PostgreSQL only) |

## Setup

### Prerequisites

- Node.js (LTS)
- pnpm
- Docker & Docker Compose (for PostgreSQL)

### 1. Install

```bash
pnpm install
```

### 2. Environment

Copy the example env file and fill in your values:

```bash
cp .env.example .env
```

The app loads `.env` automatically via `process.loadEnvFile(".env")` at startup. Restart the server after changing `.env`.

Required variables:

| Variable | Required | Description |
|----------|----------|-------------|
| `QUERY_DATABASE_URL` | Yes | Read-only connection string (role `querymind_readonly`) |
| `WRITE_DATABASE_URL` | No | Write connection string (role `querymind_writer`). Write operations are unavailable if not configured. |

See `.env.example` for placeholder values and `docs/database-setup.md` for PostgreSQL role setup.

### 3. Start infrastructure (PostgreSQL)

```bash
docker compose up -d
```

`docker-compose.yaml` defines only `postgres` (no Ollama) and maps host **5433 → container 5432**. The local `.env` uses `localhost:5433`; `.env.example` shows 5432 — match your actual running port.

### 4. Build and run the MCP server

```bash
pnpm build
node dist/index.js
```

The server runs on stdio. Configure your MCP client (e.g., OpenCode) to point at `node dist/index.js` (see `docs/opencode-integration.md` and `opencode-setup.md`).

## MCP Tools

| Tool | Purpose | Modifies DB? |
|------|---------|--------------|
| `ping` | Verify MCP server connectivity | No |
| `execute_query` | Execute validated read-only SQL | No |
| `get_database_schema` | Retrieve database schema information | No |
| `prepare_operation` | Prepare a write operation and request human approval | No (stores approval only) |
| `execute_approved_operation` | Execute a previously approved write operation | Yes |

See `docs/architecture.md` and the tool handler implementations in `src/index.ts` for input schemas, validation behavior, and security restrictions.

## Key Safety Rules

1. **MCP is the interface, not the entire application.** Business logic lives in independent services.
2. **Database operations are independent of MCP.** Services can be tested without an MCP client.
3. **Read-only execution by default.** `execute_query` runs in a read-only transaction with a 10s statement timeout and AST-based validation allowing SELECT/WITH only.
4. **Write operations require human approval.** `prepare_operation` prepares a write and requests confirmation; `execute_approved_operation` runs it only after approval, using a separate write pool (`WRITE_DATABASE_URL`). Writes are not impossible at the connection level — gate them at the approval layer.
5. **LLMs never execute SQL directly.** Generated SQL passes deterministic validation before execution.
6. **Application-level validation is not a complete security boundary.** Database-level role permissions (`querymind_readonly`, `querymind_writer`) are the primary enforcement boundary.

## Development Commands (run from repo root)

- `pnpm dev` — `tsx watch src/index.ts`
- `pnpm build` — `tsc` → `dist/`
- `pnpm start` — `node dist/index.js` (requires `pnpm build` first)
- `pnpm typecheck` — `tsc --noEmit`
- `pnpm test` — `vitest run --coverage`
- `pnpm test:watch` — `vitest watch`

Run one test file: `vitest run src/modules/query/sql-validator.test.ts`

There is **no `pnpm lint`** script and no ESLint/Prettier config.

## Documentation

| Document | Description |
|----------|-------------|
| `docs/architecture.md` | Internal architecture and execution flows |
| `docs/database-setup.md` | PostgreSQL setup and role permissions |
| `docs/security.md` | Security model, defense-in-depth, and limitations |
| `docs/approval-workflow.md` | Approval lifecycle, statuses, and execution |
| `docs/development.md` | Development scripts, testing, and test coverage |
| `docs/opencode-integration.md` | OpenCode MCP client integration |
| `postgresql-readonly-user-guide.md` | Detailed read-only role setup guide |
| `opencode-setup.md` | OpenCode MCP server config snippet |
| `PRD.md` | Original product requirements (historical) |
| `TECH_STACK.md` | Technical decisions and stack overview |
| `TASKS.md` | Development roadmap and task status |
| `AGENTS.md` | Instructions for AI coding agents |
