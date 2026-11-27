# PG-mind

PG-mind is a **TypeScript-only MCP (Model Context Protocol) server** that connects to PostgreSQL, understands its schema, validates SQL for safety, executes read-only queries, and supports write operations behind explicit human approval. It exposes schema introspection, query execution, and write-operation management as MCP tools.

```
User → MCP client (e.g., OpenCode LLM) → PG-mind MCP server → PG-mind services → PostgreSQL
```

PG-mind does **not** contain its own LLM. The MCP client provides the AI agent. PG-mind provides PostgreSQL capabilities and execution safeguards. PostgreSQL remains the database.

## Problem it addresses

AI coding agents can generate SQL, but they need a safe, controlled way to inspect and modify a PostgreSQL database. PG-mind gives MCP clients a set of database tools with built-in safeguards:

- Read-only queries are validated with a PostgreSQL-aware AST parser before execution, run in read-only transactions, and are bounded by row and size limits.
- Write operations (INSERT, UPDATE, DELETE, and allowlisted DDL) require explicit human approval via MCP elicitation before they execute. The execution tool accepts only an approval ID — never arbitrary SQL.

## Key features

| Feature | Description |
|---|---|
| MCP server (stdio) | Official MCP TypeScript SDK, stdio transport |
| Multi-database connections | YAML-configured named connections with a default and runtime switching |
| Schema introspection | Tables, columns, constraints, indexes, sequences, functions, views |
| Read-only query execution | SELECT/WITH only, read-only transactions, 10s statement timeout, 100-row / 1 MB result limits |
| SQL validation | `pgsql-ast-parser` PostgreSQL-aware AST parser (not naive string checks) |
| Approval-gated writes | INSERT, UPDATE, DELETE, and allowlisted DDL behind human approval via MCP elicitation |
| Query explanation | EXPLAIN (json/text/xml/yaml), with optional ANALYZE |
| Query plan analysis | Detects sequential scans, nested loops, sort spills, and row-estimate errors |
| Error diagnosis | SQLSTATE mapping to explanations and remediation steps |
| Index diagnostics | Index usage stats, unused/duplicate index detection, suggestions |
| Runtime config reload | Reload `pg-mind.config.yaml` without restarting the server |

## How it works

1. **MCP client provides the AI agent** (for example, OpenCode). The agent calls PG-mind's MCP tools.
2. **PG-mind validates** every SQL statement before execution using a PostgreSQL-aware AST parser. Read-only queries are restricted to SELECT/WITH; writes are restricted to INSERT/UPDATE/DELETE and an allowlisted set of DDL types.
3. **Read queries run immediately** against the active (or explicitly selected) connection in a read-only transaction with timeouts and result limits.
4. **Write operations go through an approval workflow**: `prepare_operation` classifies the SQL and requests human confirmation via MCP elicitation; `execute_approved_operation` runs the exact stored SQL only after approval, identified by approval ID.
5. **PostgreSQL remains the database** — PG-mind is a tool layer, not a database itself.

## Architecture overview

PG-mind is a **modular TypeScript monolith**. Business logic lives in independent services under `src/modules/` (`database`, `schema`, `query`, `approval`), not inside MCP tool handlers. MCP tools are registered in `src/index.ts`.

```
MCP Client (OpenCode / other)
        │ MCP protocol (stdio)
        ▼
PG-mind TypeScript Application (src/index.ts)
├── MCP tools (16): ping, execute_query, list_databases, get_active_database,
│   switch_database, reload_configuration, get_database_schema,
│   prepare_operation, execute_approved_operation, reload_configuration,
│   explain_query, analyze_query_plan, diagnose_error, get_index_diagnostics,
│   get_schema, get_table, list_schemas
├── Services: database, schema, query, approval
└── Config: pg-mind.config.yaml (YAML, multiple named connections)
        │
        ▼
External PostgreSQL Database
```

See `docs/architecture.md` for detailed execution flows, including the read-only and approval-gated write paths, transaction handling, and commit-outcome semantics.

## Supported MCP tools

| Tool | Modifies DB? | Purpose |
|---|---|---|
| `ping` | No | Health check; returns server status |
| `execute_query` | No | Execute validated read-only SQL (SELECT/WITH) |
| `list_databases` | No | List configured connections and their metadata |
| `get_active_database` | No | Return the active connection's metadata |
| `switch_database` | No | Switch the active connection by name |
| `reload_configuration` | No | Reload `pg-mind.config.yaml` at runtime |
| `get_database_schema` | No | Discover schemas, tables, columns, constraints, indexes, sequences, functions |
| `get_schema` | No | Schema metadata for one schema |
| `get_table` | No | Detailed table metadata (columns, constraints, indexes) |
| `list_schemas` | No | List all accessible schema names |
| `explain_query` | No | PostgreSQL EXPLAIN plan (json/text/xml/yaml) |
| `analyze_query_plan` | No | Query-plan performance analysis with recommendations |
| `diagnose_error` | No | Diagnose a PostgreSQL error message (SQLSTATE mapping) |
| `get_index_diagnostics` | No | Index usage stats and suggestions for a table |
| `prepare_operation` | No (stores approval only) | Prepare a write operation and request human approval |
| `execute_approved_operation` | Yes | Execute an approved write operation by approval ID |

Read tools accept an optional `connectionName` to target a specific configured connection without changing the active connection. `execute_approved_operation` accepts an approval ID (UUID), not arbitrary SQL.

## Installation and quick start

### Prerequisites

- Node.js (LTS)
- pnpm (package manager is `pnpm@10.17.1`; do not use npm or yarn)
- Docker & Docker Compose (for PostgreSQL)

### 1. Install dependencies

```bash
pnpm install
```

### 2. Configure the database connection

PG-mind is configured through **YAML**, not environment variables. Copy the example configuration:

```bash
cp pg-mind.config.example.yaml pg-mind.config.yaml
```

Edit `pg-mind.config.yaml` with your connection details. The file is gitignored and must never be committed with real credentials.

Minimal example:

```yaml
database:
  default: local_dev
  connections:
    local_dev:
      host: localhost
      port: 5433
      database: pgmind_dev
      username: pgmind
      password: your_password_here
      ssl: false
  pool:
    max: 10
    maxTotal: 100
    idleTimeoutMillis: 30000
    connectionTimeoutMillis: 5000
  statementTimeoutMs: 10000
  lockTimeoutMs: 5000
  idleInTransactionTimeoutMs: 30000
  applicationName: pgmind
```

Each connection has read and write pools created from the same credentials. See `pg-mind.config.example.yaml` for a full template and `docs/database-setup.md` for PostgreSQL setup guidance.

### 3. Start infrastructure (PostgreSQL)

```bash
docker compose up -d
```

`docker-compose.yaml` defines only `postgres` (no Ollama) and maps host **5433 → container 5432**. Match the port to your configuration.

### 4. Build and run the MCP server

```bash
pnpm build
node dist/index.js
```

The server runs on stdio. Configure your MCP client (e.g., OpenCode) to point at `node dist/index.js` (see `docs/opencode-integration.md` and `opencode-setup.md`).

## OpenCode integration

Add PG-mind to your OpenCode MCP server configuration:

```json
{
    "$schema": "https://opencode.ai/config.json",
    "mcp": {
        "servers": {
            "pgmind": {
                "type": "local",
                "command": ["node", "dist/index.js"],
                "cwd": "path-to-pgmind",
                "codemode": false
            }
        }
    }
}
```

Replace `path-to-pgmind` with the absolute path to the PG-mind repository working directory. See `docs/opencode-integration.md` for the full integration guide and `opencode-setup.md` for the config snippet.

## Security model and limitations

PG-mind applies defense-in-depth, but it is **not** a security product and should not be described as "production-ready", "fully secure", or "guaranteed safe". Understand the boundaries:

- **Application-level SQL validation.** Statements are parsed with `pgsql-ast-parser` and validated by separate read-only and write validators. This reduces risk but is not a complete SQL sandbox; the disallowed-function list is not exhaustive.
- **Human approval before write execution.** Writes require explicit human confirmation via MCP elicitation. The execution tool accepts only an approval ID — never arbitrary SQL. Approval is in-memory and lost on server restart.
- **PostgreSQL permissions are the primary enforcement boundary.** PG-mind creates read and write pools from the configured credentials but does not enforce database-level role separation itself. Grant database roles least privilege and do not grant superuser or unnecessary permissions.
- **Connection-aware approvals.** An approved operation executes against the exact connection it was prepared for, regardless of later active-connection changes or configuration reloads.
- **No authentication or authorization layer.** PG-mind trusts the MCP client to authenticate the end user.

See `docs/security.md` for the full security model, boundaries, and limitations.

## Development and testing

All commands run from the repo root:

| Script | Description |
|---|---|
| `pnpm dev` | `tsx watch src/index.ts` — run the MCP server in watch mode |
| `pnpm build` | `tsc` — compile TypeScript to `dist/` |
| `pnpm start` | `node dist/index.js` — run the compiled server (requires `build`) |
| `pnpm typecheck` | `tsc --noEmit` — type-check without emitting |
| `pnpm lint` | `eslint .` — lint TypeScript source |
| `pnpm lint:fix` | `eslint . --fix` — auto-fix lint issues |
| `pnpm format` | `prettier --write "src/**/*.ts"` — format source |
| `pnpm format:check` | `prettier --check "src/**/*.ts"` — check formatting |
| `pnpm test` | `vitest run --coverage` — run all unit tests with coverage |
| `pnpm test:watch` | `vitest watch` — run tests in watch mode |

Database-dependent scripts (`db:test`, `db:schema`, `db:tables`, `db:columns`, `db:constraints`, `db:schema:full`, `query:test`, `db:write:test`) require a running PostgreSQL instance and are not part of the unit-test suite.

Run one test file:

```bash
vitest run src/modules/query/sql-validator.test.ts
```

### Test results (last full run)

The unit-test suite runs against in-memory/mocked services and does not require a live database. The Docker integration tests (`database.service.test.ts`, `schema.service.test.ts`) require a specifically configured PostgreSQL instance and could not be completed in this environment (connection-identity mismatches against the available Docker database).

See `docs/development.md` for the development workflow.

## Current project status

PG-mind is a developer tool for local development and experimentation with PostgreSQL through MCP. It is not intended for production use or public hosting without additional security review. Documentation is maintained to match the current implementation; `PROJECT_SPEC.md` describes the original baseline proposal.

## Documentation

| Document | Description |
|---|---|
| `docs/architecture.md` | Internal architecture and execution flows |
| `docs/approval-workflow.md` | Prepare → approve → execute lifecycle |
| `docs/database-setup.md` | YAML configuration and PostgreSQL setup |
| `docs/security.md` | Security model, boundaries, and limitations |
| `docs/development.md` | Development workflow, scripts, and tests |
| `docs/opencode-integration.md` | OpenCode MCP client integration |
| `opencode-setup.md` | OpenCode MCP server config snippet |
| `TECH_STACK.md` | Technology choices and rationale |
| `AGENTS.md` | Instructions for AI coding agents |
| `PROJECT_SPEC.md` | Original project specification (baseline) |
