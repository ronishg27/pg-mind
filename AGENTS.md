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
- `pnpm db:test` / `db:schema` / `db:tables` / `db:columns` / `db:constraints` / `db:schema:full` / `query:test` / `db:write:test` — `tsx src/scripts/test-*.ts`; require a running PostgreSQL
- Run one test file: `vitest run src/modules/query/sql-validator.test.ts`
- There is **no `pnpm lint`** script and no ESLint/Prettier config

## Setup

- Copy `.env.example` to `.env` (`.env` is gitignored). The app loads it automatically via `process.loadEnvFile(".env")` in `src/index.ts` and `src/config/index.ts`.
- Restart the MCP server after changing `.env`; the connection pool is created at startup.
- Start infrastructure: `docker compose up -d`. The file is `docker-compose.yaml` and defines only `postgres` (no Ollama); it maps host **5433 → container 5432**. The local `.env` uses `localhost:5433`; `.env.example` shows 5432 — match your actual running port.
- To run QueryMind as an MCP server: `pnpm build`, then `node dist/index.js` (see `opencode-setup.md` for the OpenCode MCP server config pointing at `dist/index.js`).

## Tests

- Vitest. Tests are **colocated with source** (`src/**/*.test.ts`); there is **no `test/` directory**.
- `tsconfig.json` excludes a nonexistent `test/` — the exclusion is stale but harmless.

## Code conventions

- TypeScript only, ESM (`"type": "module"`), `NodeNext` module resolution. Import paths use `.js` extensions. Strict mode.
- `tsconfig.json` includes only `src/**/*.ts`; build output goes to `dist/`.
- Validation with Zod. SQL parsed with `pgsql-ast-parser` (not naive string checks).
- Database access via `pg` pool directly (`src/modules/database/database.service.ts`); no ORM.

## Architecture (what actually exists)

- Entry point: `src/index.ts` — builds the MCP stdio server and registers tools (`ping`, `execute_query`, `get_database_schema`, `prepare_operation`, `execute_approved_operation`).
- Config: `src/config/index.ts` (`QUERY_DATABASE_URL`, `WRITE_DATABASE_URL`, `writeRoleName` default `querymind_writer`).
- Modules under `src/modules/`: `database`, `schema`, `query`, `approval`.
- Directories `src/mcp/`, `src/ai/`, `src/infrastructure/`, `src/analysis/` **do not exist**. MCP tools are registered in `src/index.ts`.
- `context.md` does not exist (it is gitignored).

## Reference docs

- `README.md` — product scope and setup
- `PRD.md` — product requirements
- `TECH_STACK.md` — technology choices
- `TASKS.md` — roadmap and task status

None of these exist as separate `context.md` (gitignored). Product/roadmap docs live in the four files above.

## Safety

- Default query path (`execute_query`) is read-only: `BEGIN READ ONLY`, 10s statement timeout, AST-based validation allowing SELECT/WITH only.
- Write operations exist behind human approval (`prepare_operation` → `execute_approved_operation`) using a separate write pool (`WRITE_DATABASE_URL`, role `querymind_writer`). Writes are not impossible at the connection level — gate them at the approval layer.
- Read-only execution by default applies even before authentication.
