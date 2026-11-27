# PG-mind — Technical Stack

## Decision Summary

PG-mind is a **TypeScript-only** project. Go and gRPC have been removed entirely. The architecture is a modular TypeScript monolith — no separate microservices.

## Stack Overview

| Component | Choice | Rationale |
|---|---|---|
| Language | TypeScript | Single language across the stack, reduces complexity |
| Runtime | Node.js | Mature ecosystem, strong MCP SDK support |
| Package manager | pnpm | Fast, disk-efficient installs (`pnpm@10.17.1`) |
| MCP server | Official MCP TypeScript SDK (`@modelcontextprotocol/sdk`, ^1.32.2) | Canonical MCP implementation, stdio transport |
| Backend architecture | Modular TypeScript application | Monolith with separated concerns; easy to test and extend |
| Database | PostgreSQL | Target database for PG-mind |
| Configuration | YAML (`pg-mind.config.yaml`) | Multiple named connections, default connection, runtime reload |
| Database access | `pg` (node-postgres, ^8.23.1) | Native driver, direct control over SQL execution and introspection (no ORM) |
| SQL parsing | `pgsql-ast-parser` (^12.0.2) | PostgreSQL-aware AST parser; safety is more complex than "starts with SELECT" |
| Validation | Zod (^4.6.7) | TypeScript-first schema validation for structured inputs/outputs |
| Testing | Vitest (^5.1.1) | Fast, TypeScript-native test runner; tests colocated at `src/**/*.test.ts` |
| Containerization | Docker Compose | PostgreSQL only (`docker-compose.yaml`) |

**Not part of the current implementation:** Ollama / AI integration, natural language → SQL. SQL is supplied by the MCP client/LLM; PG-mind validates and executes it.

## Repository Structure (Modular Monolith)

```
pgmind/
├── src/
│   ├── index.ts                # MCP server entry point; registers all 16 tools
│   ├── config/index.ts         # YAML configuration loading and reload
│   ├── config/configuration.types.ts   # Zod schemas for config
│   ├── config/configuration.loader.ts  # YAML load + validation
│   ├── modules/
│   │   ├── database/           # DatabaseService (read + write pools), ConnectionRegistry (multi-connection, reload)
│   │   ├── schema/             # SchemaService (schema introspection)
│   │   ├── query/              # SqlValidator, SqlOperationClassifier, WriteSqlValidator, QueryService, SqlAnalysisService
│   │   └── approval/           # ApprovalStore, ApprovalService, ApprovalWorkflowService,
│   │                           # ApprovalConfirmationProvider, McpApprovalConfirmationProvider,
│   │                           # OperationExecutionService, OperationExecutionWorkflowService
│   └── scripts/                # Development smoke-test scripts (require a live database)
├── src/**/*.test.ts            # Colocated unit tests (Vitest)
├── docs/                       # Documentation (architecture, database-setup, security, approval-workflow, development, opencode-integration)
├── pg-mind.config.example.yaml # Example YAML configuration (template)
├── pg-mind.config.yaml         # Local YAML configuration (gitignored, contains credentials)
├── .gitignore
├── package.json
├── pnpm-lock.yaml
├── tsconfig.json
├── vitest.config.ts
└── docker-compose.yaml         # PostgreSQL only (maps host 5433 → container 5432)
```

**Directories that do NOT exist** (planned but never implemented): `src/infrastructure/`, `src/mcp/`, `src/ai/`, `src/analysis/`, `test/`, `docker/`. MCP tools are registered directly in `src/index.ts`. There is no separate `test/` directory — tests are colocated with source.

## Key Architectural Decisions

1. **No ORM.** The `pg` driver is used directly for full control over SQL execution and schema introspection.
2. **PostgreSQL-aware SQL parser.** Safety validation uses `pgsql-ast-parser` rather than naive string checks like "starts with SELECT".
3. **YAML configuration.** Connections are defined in `pg-mind.config.yaml` with named connections, a default connection, shared pool settings, and transaction timeouts. The server loads and validates the YAML file at startup and can reload it at runtime via the `reload_configuration` tool. There is no `.env`-based single-database setup.
4. **Read and write pools use the same credentials.** Each configured connection creates a read pool and (optionally) a write pool from the same username/password. PG-mind does not enforce separate database roles; PostgreSQL permissions are the primary security boundary.
5. **Human-approved writes.** Write operations go through `prepare_operation` (MCP elicitation for human approval) and `execute_approved_operation` (execution by approval ID only). Supported writes include INSERT, UPDATE, DELETE, and an explicitly allowlisted set of DDL operations (CREATE, ALTER, DROP, TRUNCATE). The execution tool never accepts arbitrary SQL — only an approval ID.
6. **Separate read and write validators.** `SqlValidator` guards the read-only path; `WriteSqlValidator` guards the write path. They are intentionally not merged.
7. **MCP as interface only.** Business logic is in independent services under `src/modules/`, not inside MCP tool handlers.
8. **No unnecessary infrastructure.** No Redis, message queues, vector DB, or separate metadata database.

## Local Development Dependencies

- Node.js (LTS)
- pnpm
- Docker & Docker Compose (for PostgreSQL, required by database-dependent scripts)

## Test Summary

Tests are colocated unit tests (Vitest) at `src/**/*.test.ts`. There is no separate `test/` directory.

A full `pnpm test` run executes 17 test files. Unit tests (15 files) pass without a live database. The remaining 2 files (`database.service.test.ts`, `schema.service.test.ts`) are Docker integration tests requiring a specifically configured running PostgreSQL instance; they could not be completed in this environment due to connection-identity mismatches against the available Docker database.

Typecheck (`tsc --noEmit`) passes clean. Lint and format checks are configured via ESLint and Prettier.

Tests cover SQL operation classification, read-only SQL validation, write SQL validation, approval storage and expiration, approval workflow, MCP elicitation, operation execution, execution workflow, and configuration loading. Test coverage percentage is not a security or quality guarantee.
