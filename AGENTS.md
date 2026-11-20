# AGENTS.md

Instructions for AI coding agents working in this repository.

## 1) Start Here

- Read `README.md` first for product scope, setup instructions, and workspace map.
- Read `PRD.md` for product requirements and success metrics.
- Read `TECH_STACK.md` for technology choices and architecture.
- Read `TASKS.md` for the current development roadmap and task status.
- Read `context.md` for project history and key decisions (including DECISION:1: TypeScript-only, no Go/gRPC).

## 2) Repository Shape

QueryMind is a **TypeScript-only modular monolith** — no separate microservices, no Go, no gRPC.

```
querymind/
├── src/
│   ├── index.ts                # Application entry point
│   ├── config/                 # Configuration
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
├── test/                       # Vitest tests
├── docker/                     # Docker-related files
├── docs/                       # Documentation
├── .env.example
├── .gitignore
├── package.json
├── pnpm-lock.yaml
├── tsconfig.json
└── docker-compose.yml          # PostgreSQL + Ollama
```

## 3) Dev Commands

Run from repo root unless noted.

- Install: `pnpm install`
- Dev server: `pnpm dev`
- Build: `pnpm build`
- Typecheck: `pnpm typecheck` (or `tsc --noEmit`)
- Lint: `pnpm lint`
- Tests: `pnpm test` (Vitest)
- Start infrastructure: `docker compose up -d` (PostgreSQL + Ollama)

## 4) Project Conventions

- **Language:** TypeScript only. No Go, no gRPC, no Python.
- **Package manager:** pnpm. Do not use npm or yarn for new dependencies.
- **Runtime:** Node.js (LTS).
- **MCP:** Official MCP TypeScript SDK (`@modelcontextprotocol/sdk`), stdio transport.
- **Database access:** `pg` (node-postgres) directly — no ORM.
- **Validation:** Zod for structured input/output validation.
- **Testing:** Vitest. Place tests alongside source or in `test/`.
- **Lint/Format:** Follow the project's existing Prettier/ESLint config if present; otherwise use standard TypeScript conventions.
- **Environment variables:** Use `.env.example` as a template; never commit real secrets to `.env`.

## 5) Database & Storage

- Target database: PostgreSQL.
- Connection via `pg` pool in `src/modules/database/connection.manager.ts`.
- Use **read-only database credentials** — destructive operations must be impossible at the connection level.
- SQL validation must use a **PostgreSQL-aware parser**, not naive string checks (e.g., do not rely on "starts with SELECT").
- Enforce execution timeouts and row limits on every query.
- No Redis, message queues, vector database, or separate metadata database in the MVP.

## 6) AI & LLM Conventions

- AI providers are **interchangeable**. Ollama is the default but must not be hardcoded throughout the app.
- Use the custom TypeScript LLM provider interface in `src/ai/providers/`.
- **LLMs never execute SQL directly.** Generated SQL must pass deterministic validation before execution.
- Schema context must be retrieved and fed to the LLM for SQL generation.
- Generated SQL output must be validated with Zod before reaching the validator/executor.

## 7) Safety Rules (Non-Negotiable)

1. **MCP is the interface, not the entire application.** Business logic belongs in independent services (`modules/`, `ai/`), not inside MCP tool handlers.
2. **Database operations are independent of MCP.** Services must be testable without an MCP client.
3. **AI providers are interchangeable.** Ollama is not hardcoded.
4. **LLMs never execute SQL directly.** Generated SQL passes deterministic validation first.
5. **Read-only execution by default.** Applies even before authentication is introduced.
6. **Keep the architecture extensible, not overengineered.** No unnecessary abstractions.

## 8) Development Principles

> Understand → Implement → Run → Test → Review → Proceed.

- No giant code dumps.
- No unnecessary abstractions.
- One component at a time.
- Create directories only when their corresponding functionality is needed.
- Authentication and authorization remain postponed.

## 9) High-Value File References

- Product + setup: `README.md`
- Product requirements: `PRD.md`
- Tech stack + architecture: `TECH_STACK.md`
- Roadmap + tasks: `TASKS.md`
- Project history + decisions: `context.md`
- Entry point: `src/index.ts`
- MCP tools: `src/mcp/tools/`
- Database layer: `src/modules/database/`
- Schema layer: `src/modules/schema/`
- Query layer: `src/modules/query/`
- Analysis layer: `src/modules/analysis/`
- AI layer: `src/ai/`
- Config: `src/config/`
- Infrastructure: `src/infrastructure/`