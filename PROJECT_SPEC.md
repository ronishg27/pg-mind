# PostgreSQL MCP Server

## Goal

Build a simple MCP (Model Context Protocol) server that connects to PostgreSQL and allows developers to execute SQL queries through MCP tools.

## Functional Requirements

The server must support both read and write database operations.

### 1\. Read Operations

- Support read queries such as `SELECT`.
- Execute read queries immediately without requiring manual approval.

### 2\. Write Operations

- Support write queries such as `INSERT`, `UPDATE`, and `DELETE`.
- Require explicit manual approval before executing any write operation.
- Never execute a write operation without approval.

### 3\. Database Connection

- Connect to a PostgreSQL database.
- Provide a straightforward way to configure database connection credentials.
- Handle database connection and query errors appropriately.

## Scope

This is strictly a developer tool intended for local development and experimentation.

- Not intended for production use.
- Not intended for public hosting.
- Not intended for distribution or release.

## Implementation Guidelines

- Keep the implementation simple and practical.
- Avoid unnecessary abstractions and overengineering.
- Use reasonable engineering practices where needed.
- Make implementation decisions that best serve the core requirements.
- Do not introduce unnecessary features outside the intended scope.

**The objective is straightforward: a lightweight PostgreSQL MCP server with immediate read access and approval-gated write access.**
