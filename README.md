# QueryMind

QueryMind is a **TypeScript-only MCP (Model Context Protocol) server** that connects to PostgreSQL, understands its schema, generates SQL using an LLM, validates the SQL for safety, executes read-only queries, and returns meaningful results to an AI client.

It bridges natural language and your PostgreSQL database — you ask questions in plain English, and QueryMind turns them into safe, validated SQL queries and returns the results.

## Purpose

- Let AI clients (Claude Desktop, Cursor, etc.) query PostgreSQL databases through natural language.
- Keep database access **read-only by default** — no destructive writes, even before authentication is introduced.
- Validate every generated SQL query deterministically before execution.
- Expose schema introspection, query execution, and query explanation as MCP tools.

## Features

| Feature | Status |
|---------|--------|
| MCP server (stdio) | MVP |
| PostgreSQL connection | MVP |
| Schema introspection (tables, columns, foreign keys) | MVP |
| Natural language → SQL | MVP |
| SQL validation (read-only, pg-aware parser) | MVP |
| Safe read-only query execution (timeouts, row limits) | MVP |
| Query explanation & EXPLAIN support | Next |
| Query optimization recommendations | Next |
| AI result analysis | Next |
| Authentication / authorization | Later |
| Multi-tenancy | Later |
| MySQL support | Later |
| Web dashboard | Not initially |

## Architecture

QueryMind is a **modular TypeScript monolith** — no separate microservices, no gRPC, no Go.

```
MCP Client (Claude Desktop / other)
        │ MCP protocol (stdio)
        ▼
QueryMind TypeScript Application
├── MCP Layer        → Tools, Resources, Prompts
├── Application Services → Database, Schema, Query, Analysis
├── AI Layer         → LLM provider, SQL generation, Context retrieval
└── Infrastructure Layer → pg driver, SQL parser, Config, Logging
        │
        ▼
External PostgreSQL Database       Ollama (Local LLM Provider)
```

## Technology Stack

| Component | Choice |
|-----------|--------|
| Language | TypeScript |
| Runtime | Node.js |
| Package manager | pnpm |
| MCP server | Official MCP TypeScript SDK |
| Backend architecture | Modular TypeScript application |
| Database | PostgreSQL |
| Database access | `pg` (node-postgres) |
| SQL parsing | PostgreSQL-aware SQL parser |
| Validation | Zod |
| AI integration | Ollama |
| AI provider abstraction | Custom TypeScript interface |
| Testing | Vitest |
| Containerization | Docker Compose |

## Repository Structure

```
querymind/
├── src/
│   ├── mcp/            # MCP tools, resources, prompts
│   ├── modules/        # Database, Schema, Query, Analysis services
│   ├── ai/             # LLM providers, SQL generation, prompts
│   ├── config/         # Configuration
│   ├── infrastructure/ # pg driver, parser, logging
│   └── index.ts        # Application entry point
├── test/
├── docker/
├── docs/
├── .env.example
├── .gitignore
├── package.json
├── pnpm-lock.yaml
├── tsconfig.json
└── docker-compose.yml
```

## Setup Instructions

### Prerequisites

- Node.js (LTS)
- pnpm
- Docker & Docker Compose (for PostgreSQL + Ollama)
- Git

### 1. Clone and install

```bash
pnpm install
```

### 2. Environment

Copy the example env file and fill in your values:

```bash
cp .env.example .env
```

### 3. Start infrastructure (PostgreSQL + Ollama)

```bash
docker compose up -d
```

### 4. Run the MCP server

```bash
pnpm dev
```

### 5. Connect an MCP client

Configure your MCP client (e.g., Claude Desktop) to point at the QueryMind server via stdio.

## Key Safety Rules

1. **MCP is the interface, not the entire application.** Business logic lives in independent services.
2. **Database operations are independent of MCP.** Services can be tested without an MCP client.
3. **AI providers are interchangeable.** Ollama isn't hardcoded throughout the app.
4. **LLMs never execute SQL directly.** Generated SQL passes deterministic validation first.
5. **Read-only execution by default.** Applies even before authentication.
6. **Keep the architecture extensible, not overengineered.**

## Development Principles

> Understand → Implement → Run → Test → Review → Proceed.

No giant code dumps, no unnecessary abstractions. One component at a time.