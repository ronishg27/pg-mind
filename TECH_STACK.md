# QueryMind — Technical Stack

## Decision Summary

QueryMind is a **TypeScript-only** project. Go and gRPC have been removed entirely. The architecture is a modular TypeScript monolith — no separate microservices.

## Stack Overview

| Component | Choice | Rationale |
|-----------|--------|-----------|
| Language | TypeScript | Single language across the stack, reduces complexity |
| Runtime | Node.js | Mature ecosystem, strong MCP SDK support |
| Package manager | pnpm | Fast, disk-efficient installs |
| MCP server | Official MCP TypeScript SDK (`@modelcontextprotocol/sdk`) | Canonical MCP implementation, stdio transport |
| Backend architecture | Modular TypeScript application | Monolith with separated concerns; easy to test and extend |
| Database | PostgreSQL | Target database for QueryMind |
| Database access | `pg` (node-postgres) | Native driver, direct control over SQL execution and introspection (no ORM) |
| SQL parsing | `pgsql-ast-parser` | PostgreSQL-aware AST parser; safety is more complex than "starts with SELECT" |
| Validation | Zod | TypeScript-first schema validation for structured inputs/outputs |
| Testing | Vitest | Fast, TypeScript-native test runner; tests colocated at `src/**/*.test.ts` |
| Containerization | Docker Compose | PostgreSQL only (`docker-compose.yaml`) |

**Not part of the current implementation:** Ollama / AI integration, natural language → SQL, query explanation (EXPLAIN). SQL is supplied by the MCP client/LLM; QueryMind validates and executes it.

## Repository Structure (Modular Monolith)

```
querymind/
├── src/
│   ├── index.ts                # MCP server entry point; registers all 5 tools
│   ├── config/index.ts         # Environment configuration
│   ├── modules/
│   │   ├── database/           # DatabaseService (read + write pools), CommitOutcomeUnknownError
│   │   ├── schema/             # SchemaService (schema introspection)
│   │   ├── query/              # SqlValidator, SqlOperationClassifier, WriteSqlValidator, QueryService
│   │   └── approval/           # ApprovalStore, ApprovalService, ApprovalWorkflowService,
│   │                           # ApprovalConfirmationProvider, McpApprovalConfirmationProvider,
│   │                           # OperationExecutionService, OperationExecutionWorkflowService
│   └── scripts/                # Development smoke-test scripts (require a live database)
├── docs/                       # Documentation (architecture, database-setup, security, approval-workflow, development, opencode-integration)
├── .env.example                # Environment variable template
├── .gitignore
├── package.json
├── pnpm-lock.yaml
├── tsconfig.json
└── docker-compose.yaml         # PostgreSQL only (maps host 5433 → container 5432)
```

**Directories that do NOT exist** (planned but never implemented): `src/infrastructure/`, `src/mcp/`, `src/ai/`, `src/analysis/`, `test/`, `docker/`. MCP tools are registered directly in `src/index.ts`. There is no separate `test/` directory — tests are colocated with source.

## Key Architectural Decisions

1. **No ORM.** The `pg` driver is used directly for full control over SQL execution and schema introspection.
2. **PostgreSQL-aware SQL parser.** Safety validation uses `pgsql-ast-parser` rather than naive string checks like "starts with SELECT".
3. **Two connection pools.** A read pool (`QUERY_DATABASE_URL`, required) and an optional write pool (`WRITE_DATABASE_URL`). Database-level roles (`querymind_readonly`, `querymind_writer`) are the primary security boundary.
4. **Human-approved writes.** Write operations go through `prepare_operation` (MCP elicitation for human approval) and `execute_approved_operation` (execution by approval ID only). The execution tool never accepts arbitrary SQL.
5. **Separate read and write validators.** `SqlValidator` guards the read-only path; `WriteSqlValidator` guards the write path. They are intentionally not merged.
6. **MCP as interface only.** Business logic is in independent services under `src/modules/`, not inside MCP tool handlers.
7. **No unnecessary infrastructure.** No Redis, message queues, vector DB, or separate metadata database.

## Local Development Dependencies

- Node.js (LTS)
- pnpm
- Docker & Docker Compose (for PostgreSQL)

## Test Summary

- **8 test files, 98 tests, all passing** (fresh `pnpm test` run).
- Typecheck (`tsc --noEmit`) passes clean.
