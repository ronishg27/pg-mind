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
|---|---|---|
| `dev` | `tsx watch src/index.ts` | Run the MCP server in watch mode |
| `build` | `tsc` | Compile TypeScript to `dist/` |
| `start` | `node dist/index.js` | Run the compiled MCP server (requires `build` first) |
| `typecheck` | `tsc --noEmit` | Type-check without emitting |
| `lint` | `eslint .` | Lint TypeScript source |
| `lint:fix` | `eslint . --fix` | Auto-fix lint issues |
| `format` | `prettier --write "src/**/*.ts"` | Format source |
| `format:check` | `prettier --check "src/**/*.ts"` | Check formatting |
| `test` | `vitest run --coverage` | Run all unit tests with coverage |
| `test:watch` | `vitest watch` | Run tests in watch mode |
| `db:test` | `tsx src/scripts/test-database.ts` | Test read connection (requires live PostgreSQL) |
| `db:schema` | `tsx src/scripts/test-schema.ts` | List schemas (requires live PostgreSQL) |
| `db:tables` | `tsx src/scripts/test-tables.ts` | List tables (requires live PostgreSQL) |
| `db:columns` | `tsx src/scripts/test-columns.ts` | List columns (requires live PostgreSQL) |
| `db:constraints` | `tsx src/scripts/test-constraints.ts` | List constraints (requires live PostgreSQL) |
| `db:schema:full` | `tsx src/scripts/test-full-schema.ts` | Full schema dump (requires live PostgreSQL) |
| `query:test` | `tsx src/scripts/test-query-service.ts` | Test read-only query service (requires live PostgreSQL) |
| `db:write:test` | `tsx src/scripts/test-write-connection.ts` | Test write connection + transaction rollback (requires live PostgreSQL) |

Run one test file:

```bash
vitest run src/modules/query/sql-validator.test.ts
```

## Tests

Tests are colocated with source at `src/**/*.test.ts` (Vitest). There is no separate `test/` directory.

### Unit tests vs. Docker integration tests

- **Unit tests** (15 test files) run against in-memory/mocked services and do **not** require a live database. These pass without Docker.
- **Docker integration tests** (2 test files: `database.service.test.ts` and `schema.service.test.ts`) require a specifically configured running PostgreSQL instance and are not part of the unit-test suite.

### Test results (last full `pnpm test` run)

- **17 test files total**, 15 passed, 2 failed.
- **329 tests passed**, 33 failed.
- All 33 failures are confined to the 2 Docker integration test files and are caused by connection-identity mismatches against the available Docker database (the tests expect specific roles/databases that are not present in the local environment). These are environment limitations, not code defects.
- 4 unhandled errors were also reported during the Docker integration test run, all related to connection teardown in the integration tests.

Typecheck (`tsc --noEmit`) passes clean. Lint (`pnpm lint`) and format check (`pnpm format:check`) are configured via ESLint and Prettier.

See `package.json` for the full script list and `vitest.config.ts` for test configuration.

## Database-dependent scripts

The `db:*` and `query:test` and `db:write:test` scripts require a running PostgreSQL instance. Start infrastructure with:

```bash
docker compose up -d
```

Then create `pg-mind.config.yaml` from `pg-mind.config.example.yaml` with your connection details before running these scripts.

**Note:** PG-mind itself is configured through `pg-mind.config.yaml` (YAML), not `.env`. The `.env` file is read directly only by the `db:*` development test scripts; the MCP server does not load `.env`.

## TypeScript Configuration

- Target: ES2022
- Module: NodeNext (import paths use `.js` extensions)
- Strict mode: enabled
- Output: `dist/`
- Included: `src/**/*.ts`

## Environment Loading

The MCP server loads `pg-mind.config.yaml` at startup. The `db:*` development test scripts call `process.loadEnvFile('.env')` directly and require a `.env` file.
