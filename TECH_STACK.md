# QueryMind — Technical Stack

## Decision Summary

QueryMind is a **TypeScript-only** project. Go and gRPC have been removed entirely (see DECISION:1 in `context.md`). The architecture is a modular TypeScript monolith — no separate microservices.

## Stack Overview

| Component | Choice | Rationale |
|-----------|--------|-----------|
| Language | TypeScript | Single language across the stack, reduces complexity |
| Runtime | Node.js | Mature ecosystem, strong MCP SDK support |
| Package manager | pnpm | Fast, disk-efficient installs |
| MCP server | Official MCP TypeScript SDK | Canonical MCP implementation, actively maintained |
| Backend architecture | Modular TypeScript application | Monolith with separated concerns; easy to test and extend |
| Database | PostgreSQL | Target database for QueryMind |
| Database access | `pg` (node-postgres) | Native driver, direct control over SQL execution and introspection (no ORM) |
| SQL parsing | PostgreSQL-aware SQL parser | Uses PostgreSQL's own parser; safety is more complex than "starts with SELECT" |
| Validation | Zod | TypeScript-first schema validation for structured inputs/outputs |
| AI integration | Ollama | Local LLM provider, self-hosted, no API keys required |
| AI provider abstraction | Custom TypeScript interface | LLM providers are interchangeable; Ollama is not hardcoded |
| Testing | Vitest | Fast, TypeScript-native test runner |
| Containerization | Docker Compose | PostgreSQL + Ollama in one reproducible stack |

## Repository Structure (Modular Monolith)

```
querymind/
├── src/
│   ├── index.ts                # Application entry point
│   ├── config/                 # Configuration (env, app settings)
│   ├── infrastructure/         # pg driver, SQL parser, logging
│   ├── mcp/
│   │   ├── tools/              # MCP tool definitions
│   │   ├── resources/          # MCP resources
│   │   └── prompts/            # MCP prompts
│   ├── modules/
│   │   ├── database/           # Database service, connection manager, types
│   │   ├── schema/             # Schema service, types
│   │   ├── query/              # Query service, SQL validator, types
│   │   └── analysis/           # Analysis service (query explanation, EXPLAIN)
│   └── ai/
│       ├── providers/          # LLM provider implementations (Ollama, etc.)
│       ├── sql-generation/     # Natural language → SQL
│       └── prompts/            # AI prompts
├── test/
├── docker/                     # Docker-related files
├── docs/                       # Documentation
├── .env.example
├── .gitignore
├── package.json
├── pnpm-lock.yaml
├── tsconfig.json
└── docker-compose.yml          # PostgreSQL + Ollama
```

## Key Architectural Decisions

1. **No ORM.** The `pg` driver is used directly for full control over SQL execution and schema introspection.
2. **PostgreSQL-aware SQL parser.** Safety validation uses PostgreSQL's parser (e.g., `pg_query_go` equivalent in TS ecosystem) rather than naive string checks like "starts with SELECT".
3. **AI provider abstraction.** A custom TypeScript interface lets you swap Ollama for another provider without touching the rest of the app.
4. **MCP as interface only.** Business logic is in independent services (`modules/`, `ai/`), not inside MCP tool handlers.
5. **Read-only by default.** All database operations are read-only; destructive SQL is rejected at the validation layer.
6. **No unnecessary infrastructure.** No Redis, message queues, vector DB, or separate metadata database in the MVP.

## Local Development Dependencies

- Node.js (LTS)
- pnpm
- Docker & Docker Compose
- PostgreSQL (via Docker Compose)
- Ollama (via Docker Compose or local install)