# AGENTS.md

Instructions for AI coding agents working in this repository.

## Commands (run from repo root)

- `pnpm install` — install (packageManager is `pnpm@10.17.1`; do not use npm or yarn)
- `pnpm dev` — `tsx watch src/index.ts`
- `pnpm build` — `tsc` → `dist/`
- `pnpm start` — `node dist/index.js` (requires `pnpm build` first)
- `pnpm typecheck` — `tsc --noEmit`
- `pnpm test` — `vitest run --coverage`
- `pnpm test:watch` — `vitest watch`
- `pnpm lint` — `eslint .`
- `pnpm lint:fix` — `eslint . --fix`
- `pnpm format` — `prettier --write "src/**/*.ts"`
- `pnpm format:check` — `prettier --check "src/**/*.ts"`
- `pnpm db:test` / `db:schema` / `db:tables` / `db:columns` / `db:constraints` / `db:schema:full` / `query:test` / `db:write:test` — `tsx src/scripts/test-*.ts`; require a running PostgreSQL
- Run one test file: `vitest run src/modules/query/sql-validator.test.ts`
- Linting: ESLint flat config (`eslint.config.js`, TypeScript recommended + Prettier integration). Formatting: Prettier (`.prettierrc`, 4-space indent, single quotes, semicolons, LF). A pre-commit hook (`.husky/pre-commit`) runs `lint-staged`, which formats staged `.ts` files with Prettier before each commit.

## Project overview

PG-mind is a **TypeScript-only MCP (Model Context Protocol) server** that connects to PostgreSQL, understands its schema, validates SQL for safety, executes read-only queries, and supports write operations behind explicit human approval. It exposes schema introspection, query execution, and write-operation management as MCP tools.

The architecture is a **modular TypeScript monolith** — business logic lives in independent services under `src/modules/` (`database`, `schema`, `query`, `approval`), not inside MCP tool handlers. PG-mind does **not** contain its own LLM; the MCP client provides the AI agent.

## Configuration

PG-mind is configured through **YAML**, not environment variables:

- `pg-mind.config.yaml` is the local configuration file (gitignored, contains credentials).
- `pg-mind.config.example.yaml` is the example configuration template.
- The project supports **multiple named database connections**.
- A **default connection** can be configured (`database.default`).
- Connections can be **switched at runtime** via the `switch_database` MCP tool.
- Read operations can explicitly target a connection using the optional `connectionName` parameter (this does **not** change the active connection).
- Read and write pools use the **same configured credentials** for each connection. PG-mind does not enforce separate database roles; PostgreSQL permissions are the primary security boundary.

The server loads `pg-mind.config.yaml` at startup via `src/config/index.ts` (`loadConfiguration`) and can reload it at runtime via the `reload_configuration` MCP tool. The app does **not** load `.env`; `.env` is only read directly by the `db:*` development test scripts.

## MCP tools (16 registered in src/index.ts)

1. `ping`
2. `execute_query`
3. `list_databases`
4. `get_active_database`
5. `switch_database`
6. `reload_configuration`
7. `get_database_schema`
8. `prepare_operation`
9. `execute_approved_operation`
10. `explain_query`
11. `analyze_query_plan`
12. `diagnose_error`
13. `get_index_diagnostics`
14. `get_schema`
15. `get_table`
16. `list_schemas`

Most tools accept an optional `connectionName` to target a specific connection without changing the active connection. `execute_approved_operation` accepts an approval ID (UUID), not arbitrary SQL.

**SQL parsing:** `pgsql-ast-parser` (PostgreSQL-aware AST parser), not naive string checks. **Database access:** `pg` pool directly, no ORM.

## Setup

- Create `pg-mind.config.yaml` from `pg-mind.config.example.yaml` with your database connections. Restart the MCP server after changing the YAML (or use `reload_configuration`).
- Start infrastructure: `docker compose up -d`. The file is `docker-compose.yaml` and defines only `postgres` (no Ollama); it maps host **5433 → container 5432**. The local `pg-mind.config.yaml` should use the matching port.
- To run PG-mind as an MCP server: `pnpm build`, then `node dist/index.js` (see `opencode-setup.md` for the OpenCode MCP server config pointing at `dist/index.js`).

## Tests

- Vitest. Tests are **colocated with source** (`src/**/*.test.ts`); there is **no `test/` directory**.
- `tsconfig.json` excludes a nonexistent `test/` — the exclusion is stale but harmless.

## Code conventions

- TypeScript only, ESM (`"type": "module"`), `NodeNext` module resolution. Import paths use `.js` extensions. Strict mode.
- `tsconfig.json` includes only `src/**/*.ts`; build output goes to `dist/`.
- Validation with Zod. SQL parsed with `pgsql-ast-parser`.
- Database access via `pg` pool directly; no ORM.
- Follow existing module and test-file organization. Use the scripts defined in `package.json`.
- Run `pnpm typecheck`, `pnpm lint`, and `pnpm format:check` after relevant changes.

## SQL safety rules

- **Read queries and write operations use separate execution paths.** `execute_query` uses the read pool; `execute_approved_operation` uses the write pool.
- **Read queries** are restricted by `SqlValidator` (SELECT/WITH only) and run inside `BEGIN READ ONLY` transactions with a 10s statement timeout.
- **Writes require the approval workflow.** `prepare_operation` classifies SQL, stores an approval request; `execute_approved_operation` runs it only after explicit human approval. Approval does **not** execute SQL.
- **Supported writes** are INSERT, UPDATE, DELETE, and an explicitly allowlisted set of DDL AST types (CREATE, ALTER, DROP, TRUNCATE). Arbitrary SQL and arbitrary DDL **must never** be assumed to be supported.
- **`execute_approved_operation` accepts an approval ID (UUID), not arbitrary SQL.** The exact stored SQL is retrieved from the approval store and executed.
- **Never bypass:** approval, validation, database identity checks, or transaction handling.
- **Do not weaken** the exact AST allowlists in `SqlOperationClassifier` or `WriteSqlValidator` without an explicit design decision and corresponding tests.

## Database and transaction rules

- Read and write pools use the same configured credentials per connection; there is no separate `WRITE_ROLE_NAME` enforced by the application. Database-level role permissions are the primary enforcement boundary.
- **Runtime database and writer-role identity checks remain** in `withWriteTransaction` — they verify `current_database()` matches the expected database and `current_user` matches the configured username. These checks apply to the configured credentials, not to a separately configured writer role.
- **Do not grant superuser privileges or unnecessary PostgreSQL permissions.** Database-level role permissions are the primary enforcement boundary.
- **Preserve rollback-failure connection disposal:** if `ROLLBACK` fails after an operation error, the connection client is discarded from the pool rather than returned for reuse.
- **Preserve `CommitOutcomeUnknownError` handling:** a failed COMMIT raises `CommitOutcomeUnknownError`, marks the execution as `execution_unknown`, and discards the client from the pool. **Never automatically retry** an operation with an unknown commit outcome — the operation may already have committed.
- **DDL operations must remain compatible with** the transaction-based execution workflow (e.g., `CREATE INDEX CONCURRENTLY` is rejected because it cannot run inside a transaction).

## Architecture (what actually exists)

- Entry point: `src/index.ts` — builds the MCP stdio server and registers 16 tools (`ping`, `execute_query`, `get_database_schema`, `get_schema`, `get_table`, `list_schemas`, `prepare_operation`, `execute_approved_operation`, `explain_query`, `analyze_query_plan`, `diagnose_error`, `get_index_diagnostics`, `list_databases`, `get_active_database`, `switch_database`, `reload_configuration`).
- Config: `src/config/index.ts` (`loadConfiguration`, `reloadConfiguration`) reads `pg-mind.config.yaml`.
- Modules under `src/modules/`: `database`, `schema`, `query`, `approval`.
- Directories `src/mcp/`, `src/ai/`, `src/infrastructure/`, `src/analysis/` **do not exist**. MCP tools are registered in `src/index.ts`.
- `context.md` does not exist (it is gitignored).

## Scope and design discipline

- Prefer simple, focused changes.
- Avoid unnecessary abstractions and dependencies.
- Do not introduce Redis, queues, an ORM, a vector database, or additional database engines without an explicit architectural decision.
- Do not implement planned AI/NL-to-SQL or database-intelligence features unless explicitly requested.
- Do not silently change established architecture or security boundaries.
- Add tests for new behavior, especially SQL classification, validation, approval lifecycle, and execution safety.

## Documentation references

- `README.md` — product scope and setup
- `TECH_STACK.md` — technology choices
- `docs/architecture.md` — internal architecture and execution flows
- `docs/security.md` — security model, defense-in-depth, and limitations
- `docs/approval-workflow.md` — approval lifecycle, statuses, and execution
- `docs/database-setup.md` — YAML configuration and PostgreSQL setup
- `docs/development.md` — development scripts, testing, and test coverage
- `docs/opencode-integration.md` — OpenCode MCP client integration

None of these exist as separate `context.md` (gitignored). Product/roadmap docs live in the files above.
