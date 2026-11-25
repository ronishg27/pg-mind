# QueryMind — Product Requirements Document (Historical)

> **Status:** Historical / reference. This document describes the original project scope and goals. The current implementation has evolved beyond this document: **human-approved write operations (INSERT, UPDATE, DELETE) are now implemented** behind the `prepare_operation` and `execute_approved_operation` MCP tools. Natural language → SQL via Ollama and query explanation (EXPLAIN) are **not** implemented. For the current state of the codebase, see `README.md`, `docs/architecture.md`, and the source under `src/`.

## 1. Overview

**Product:** QueryMind  
**Type:** MCP (Model Context Protocol) server  
**Language:** TypeScript (Node.js runtime)  
**Target database:** PostgreSQL

QueryMind is an MCP server that lets AI clients interact with PostgreSQL databases. It understands the database schema, validates SQL for safety, executes read-only queries, and supports write operations behind explicit human approval — all through the MCP protocol.

## 2. Problem Statement

Users and AI assistants working with PostgreSQL databases today must:
- Write SQL by hand, or
- Rely on generic tools that lack schema awareness and safety guarantees.

There is no lightweight, self-hostable MCP server that combines schema introspection, deterministic SQL validation, safe read-only execution, and human-approved write operations in one TypeScript package.

## 3. Goals

- Enable safe database access against PostgreSQL via any MCP client.
- Guarantee read-only execution by default (no `INSERT`, `UPDATE`, `DELETE`, `DROP`, etc. without approval).
- Validate every SQL query before it touches the database.
- Expose schema, query execution, and write-operation management as discoverable MCP tools.
- Keep the codebase TypeScript-only, modular, and easy to extend.

## 4. Non-Goals (out of scope)

- Authentication and authorization.
- Natural language → SQL generation (the MCP client/LLM generates SQL; QueryMind validates and executes it).
- Multi-tenancy.
- MySQL or other database support.
- Web dashboard.
- Vector database or schema-aware RAG.
- Arbitrary DDL through the approval workflow (CREATE, ALTER, DROP, TRUNCATE are recognized by the classifier but not executable through the approval path).

## 5. Target Users

| User | Why they use QueryMind |
|------|------------------------|
| Developers | Explore and query PostgreSQL databases through an AI assistant without writing SQL by hand. |
| Data analysts | Ask questions about business data and get structured results back. |
| AI client users (OpenCode, Claude Desktop, Cursor, etc.) | Connect their MCP client to a local PostgreSQL instance and query it conversationally. |

## 6. Product Requirements

### 6.1 MCP Server

- [x] Expose MCP tools over stdio.
- [x] Tools must be discoverable by MCP clients.
- [x] Each tool returns structured, machine-readable results.

Tools: `ping`, `execute_query`, `get_database_schema`, `prepare_operation`, `execute_approved_operation`.

### 6.2 Database Connectivity

- [x] Connect to PostgreSQL via `pg` (node-postgres).
- [x] Support configurable connection parameters via connection strings (`QUERY_DATABASE_URL`, `WRITE_DATABASE_URL`).
- [ ] Test the connection before use (not implemented as a startup check).
- [x] Use read-only database credentials for the read path.
- [x] Use a restricted writer role (`pgmind_writer`) for the optional write path.

### 6.3 Schema Introspection

- [x] List tables and views.
- [x] List columns with types for each table.
- [x] Detect foreign-key relationships.
- [ ] Return schema context to the AI layer for SQL generation (schema is exposed via MCP tool; NL-to-SQL is not implemented).

### 6.4 Natural Language → SQL

- [ ] Not implemented. SQL is supplied by the MCP client/LLM; QueryMind validates and executes it.

### 6.5 SQL Validation

- [x] Validate generated SQL using a PostgreSQL-aware parser (`pgsql-ast-parser`), not simple string checks.
- [x] Enforce read-only execution for the read path — reject any non-SELECT statement.
- [x] Reject dangerous clauses even within SELECT (e.g., `DELETE` in CTEs, SELECT FOR UPDATE/SHARE, SELECT INTO).
- [x] Apply execution timeouts (10s) and row limits (100 rows, 1 MB result size).
- [x] Separate write-path validator (`WriteSqlValidator`) allowing only INSERT, UPDATE, DELETE.

### 6.6 Query Execution

- [x] Execute validated read-only SQL against PostgreSQL.
- [x] Return structured query results (columns, rows, row count, truncated flag).
- [x] Apply configurable timeouts and row limits.
- [x] Handle errors gracefully and return meaningful messages (MCP `isError` responses).
- [x] Execute approved write operations behind human approval.

### 6.7 Query Explanation

- [ ] Not implemented. `EXPLAIN` / `EXPLAIN ANALYZE` is not supported and is rejected by the read-only validator.

## 7. Success Metrics

- [x] MCP server starts and responds to tool calls.
- [x] Can connect to a real PostgreSQL database and inspect its schema.
- [ ] Can ask a natural language question and receive actual database results (NL-to-SQL not implemented).
- [x] All generated SQL is validated before execution — no destructive queries reach the database without approval.
- [x] Project is demonstrable and reproducible via Docker Compose.

## 8. Roadmap (Milestones)

| Milestone | Focus | Status |
|-----------|-------|--------|
| 1. Foundation | MCP server running, TypeScript configured | Complete |
| 2. Database connectivity | PostgreSQL connection + schema introspection | Complete |
| 3. Query engine | SQL parsing, read-only validation, safe execution | Complete |
| 4. AI integration | Ollama, natural language → SQL | Not implemented |
| 5. Intelligence | Query explanation, optimization recommendations | Not implemented |
| 6. Write operations | Human-approved INSERT, UPDATE, DELETE | Complete |
| 7. MVP polish | Testing, Docker Compose, documentation, demo | In progress |

## 9. Architectural Principles

1. MCP is the interface, not the entire application. Business logic lives in independent services.
2. Database operations are independent of MCP — testable without an MCP client.
3. LLMs never execute SQL directly — generated SQL passes deterministic validation first.
4. Read-only execution by default, even before authentication.
5. Write operations require explicit human approval via MCP elicitation.
6. Database-level role permissions are the primary security boundary; application validation is a secondary safeguard.
7. Extensible, not overengineered.