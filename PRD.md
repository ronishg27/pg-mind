# QueryMind — Product Requirements Document

## 1. Overview

**Product:** QueryMind  
**Type:** MCP (Model Context Protocol) server  
**Language:** TypeScript (Node.js runtime)  
**Target database:** PostgreSQL  
**LLM provider:** Ollama (local)

QueryMind is an MCP server that lets AI clients query PostgreSQL databases using natural language. It understands the database schema, generates SQL from plain-English questions, validates that SQL for safety, executes read-only queries, and returns results — all through the MCP protocol.

## 2. Problem Statement

Users and AI assistants working with PostgreSQL databases today must:
- Write SQL by hand, or
- Rely on generic text-to-SQL tools that lack schema awareness and safety guarantees.

There is no lightweight, self-hostable MCP server that combines schema introspection, LLM-powered SQL generation, deterministic SQL validation, and safe read-only execution in one TypeScript package.

## 3. Goals

- Enable natural language queries against PostgreSQL via any MCP client.
- Guarantee read-only execution by default (no `INSERT`, `UPDATE`, `DELETE`, `DROP`, etc.).
- Validate every LLM-generated SQL query before it touches the database.
- Expose schema, query execution, and query explanation as discoverable MCP tools.
- Keep the codebase TypeScript-only, modular, and easy to extend.

## 4. Non-Goals (out of scope for MVP)

- Authentication and authorization.
- Write / mutating query support.
- Multi-tenancy.
- MySQL or other database support.
- Web dashboard.
- Vector database or schema-aware RAG (v1).

## 5. Target Users

| User | Why they use QueryMind |
|------|------------------------|
| Developers | Explore and query PostgreSQL databases through an AI assistant without writing SQL by hand. |
| Data analysts | Ask questions about business data in natural language and get structured results back. |
| AI client users (Claude Desktop, Cursor, etc.) | Connect their MCP client to a local PostgreSQL instance and query it conversationally. |

## 6. Product Requirements

### 6.1 MCP Server

- [ ] Expose MCP tools over stdio.
- [ ] Tools must be discoverable by MCP clients.
- [ ] Each tool returns structured, machine-readable results.

### 6.2 Database Connectivity

- [ ] Connect to PostgreSQL via `pg` (node-postgres).
- [ ] Support configurable connection parameters (host, port, user, password, database).
- [ ] Test the connection before use.
- [ ] Use read-only database credentials.

### 6.3 Schema Introspection

- [ ] List tables and views.
- [ ] List columns with types for each table.
- [ ] Detect foreign-key relationships.
- [ ] Return schema context to the AI layer for SQL generation.

### 6.4 Natural Language → SQL

- [ ] Accept a natural language question plus schema context.
- [ ] Send to an LLM provider (Ollama) to generate a SQL query.
- [ ] Support interchangeable AI providers via a custom TypeScript interface.
- [ ] Return structured SQL output.

### 6.5 SQL Validation

- [ ] Validate generated SQL using a PostgreSQL-aware parser (not simple string checks).
- [ ] Enforce read-only execution — reject any non-`SELECT` statement.
- [ ] Reject dangerous clauses even within SELECT (e.g., `DELETE` in CTEs).
- [ ] Apply execution timeouts and row limits.

### 6.6 Query Execution

- [ ] Execute validated read-only SQL against PostgreSQL.
- [ ] Return structured query results (rows, columns, row count).
- [ ] Apply configurable timeouts and row limits.
- [ ] Handle errors gracefully and return meaningful messages.

### 6.7 Query Explanation

- [ ] Support `EXPLAIN` / `EXPLAIN ANALYZE` for a query.
- [ ] Return execution plan information to the user.
- [ ] Offer optimization recommendations based on the plan.

## 7. Success Metrics (MVP)

- [ ] MCP server starts and responds to tool calls.
- [ ] Can connect to a real PostgreSQL database and inspect its schema.
- [ ] Can ask a natural language question and receive actual database results.
- [ ] All generated SQL is validated before execution — no destructive queries reach the database.
- [ ] Project is demonstrable and reproducible via Docker Compose.

## 8. Roadmap (Milestones)

| Milestone | Focus |
|-----------|-------|
| 1. Foundation | MCP server running, TypeScript configured |
| 2. Database connectivity | PostgreSQL connection + schema introspection |
| 3. Query engine | SQL parsing, read-only validation, safe execution |
| 4. AI integration | Ollama, natural language → SQL |
| 5. Intelligence | Query explanation, optimization recommendations |
| 6. MVP polish | Testing, Docker Compose, documentation, demo |

## 9. Architectural Principles

1. MCP is the interface, not the entire application. Business logic lives in independent services.
2. Database operations are independent of MCP — testable without an MCP client.
3. AI providers are interchangeable — Ollama is not hardcoded.
4. LLMs never execute SQL directly — generated SQL passes deterministic validation first.
5. Read-only execution by default, even before authentication.
6. Extensible, not overengineered.