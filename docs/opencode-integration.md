# OpenCode MCP Integration

PG-mind runs as a local MCP server over stdio. OpenCode connects to it as an MCP server and invokes its tools through the LLM.

## 1. Build PG-mind

```bash
pnpm install
pnpm build
```

This compiles TypeScript from `src/` to `dist/`. The entry point is `dist/index.js`.

## 2. Configure the database connection

PG-mind is configured through **YAML**, not environment variables. Copy the example configuration:

```bash
cp pg-mind.config.example.yaml pg-mind.config.yaml
```

Edit `pg-mind.config.yaml` with your database connections. The file is gitignored and must never be committed with real credentials.

Minimal example:

```yaml
database:
  default: local_dev
  connections:
    local_dev:
      host: localhost
      port: 5433
      database: pgmind_dev
      username: pgmind
      password: your_password_here
      ssl: false
```

The app loads `pg-mind.config.yaml` relative to the working directory at startup. Restart the MCP server (and the OpenCode session that launched it) after changing the YAML, or use the `reload_configuration` MCP tool to reload without restarting.

## 3. Register in OpenCode

Add PG-mind to your OpenCode MCP server configuration (`~/.opencode/config.json` or the workspace-level MCP config):

```json
{
    "$schema": "https://opencode.ai/config.json",
    "mcp": {
        "servers": {
            "pgmind": {
                "type": "local",
                "command": ["node", "dist/index.js"],
                "cwd": "path-to-pgmind",
                "codemode": false
            }
        }
    }
}
```

Replace `path-to-pgmind` with the absolute path to the PG-mind repository working directory. The `cwd` matters because `src/index.ts` loads `pg-mind.config.yaml` relative to the working directory.

See also `opencode-setup.md` for the config snippet.

## 4. Start the server

Start PostgreSQL:

```bash
docker compose up -d
```

Start PG-mind:

```bash
pnpm start
```

The server runs on stdio and logs `"PG-mind MCP server is running. Waiting for requests..."` to stderr.

## 5. Verify MCP connectivity

Use the `ping` tool to confirm the server is reachable:

```
ping(message: "hello")
```

Expected response: a JSON object with `{ status: "running", server: "pgmind", message: "Message received: hello" }`.

Without a message:

```
ping()
```

Expected response: `{ status: "running", server: "pgmind", message: "Pong!" }`.

## 6. Inspect available tools

PG-mind registers **16** MCP tools:

| Tool | Input | Purpose | Modifies DB? |
|---|---|---|---|
| `ping` | `{ message?: string }` | Verify connectivity | No |
| `execute_query` | `{ sql: string, connectionName? }` | Execute validated read-only SQL | No |
| `list_databases` | `{}` | List configured connections and metadata | No |
| `get_active_database` | `{}` | Return the active connection's metadata | No |
| `switch_database` | `{ connectionName: string }` | Switch the active connection by name | No |
| `reload_configuration` | `{}` | Reload `pg-mind.config.yaml` at runtime | No |
| `get_database_schema` | `{ schemaNames?, tableNames?, ... }` | Retrieve schema information | No |
| `get_schema` | `{ schemaName: string }` | Get schema metadata for a specific schema | No |
| `get_table` | `{ schemaName: string, tableName: string }` | Get detailed table metadata | No |
| `list_schemas` | `{}` | List all accessible schema names | No |
| `explain_query` | `{ sql, analyze?, format?, ... }` | Get PostgreSQL EXPLAIN plan for a query | No |
| `analyze_query_plan` | `{ sql: string, connectionName? }` | Analyze query plan for performance issues | No |
| `diagnose_error` | `{ errorMessage: string, connectionName? }` | Diagnose PostgreSQL error messages | No |
| `get_index_diagnostics` | `{ schemaName: string, tableName: string, connectionName? }` | Get index usage stats and suggestions | No |
| `prepare_operation` | `{ sql: string, connectionName? }` | Prepare a write operation for approval | No (stores approval only) |
| `execute_approved_operation` | `{ approvalId: uuid }` | Execute an approved write operation | Yes |

Your OpenCode client should list these tools once connected. Read tools accept an optional `connectionName` to target a specific connection without changing the active connection. `execute_approved_operation` accepts an approval ID (UUID), not arbitrary SQL.

## 7. Test the approval workflow

This example walks through preparing, reviewing, approving, executing, and verifying an UPDATE, then attempting to reuse the same approval ID.

### Step 1: Prepare an UPDATE

The LLM (or user) calls `prepare_operation` with an UPDATE statement:

```
prepare_operation(sql: "UPDATE products SET price = 500 WHERE id = 1")
```

PG-mind classifies the SQL, creates a pending approval request, and presents the MCP elicitation prompt. The tool returns:

```json
{
    "id": "<uuid>",
    "status": "pending",
    "message": "..."
}
```

The elicitation prompt (shown to the human through the MCP client) displays:

- Operation: UPDATE
- Database: pgmind_dev
- Summary: Modifies existing records in a database table.
- Complete SQL statement: `UPDATE products SET price = 500 WHERE id = 1`
- Approve / Reject choice

### Step 2: Review the elicitation prompt

The human reviews the complete SQL statement and the operation summary. Approve only if you understand and authorize this exact operation.

### Step 3: Approve the operation

The human chooses **Approve** in the elicitation prompt. PG-mind transitions the request to `approved`. The tool returns:

```json
{
    "id": "<uuid>",
    "status": "approved",
    "message": "Operation approved. It has not been executed."
}
```

Important: approval does **not** execute SQL. The UPDATE has not run yet.

### Step 4: Execute with the approval ID

The LLM calls `execute_approved_operation` with the returned approval ID:

```
execute_approved_operation(approvalId: "<uuid>")
```

PG-mind re-validates the stored SQL, claims the approval (single-use), verifies the writer connection (`current_database()` + `current_user`), executes the exact stored SQL in a transaction, and records the result:

```json
{
    "approvalId": "<uuid>",
    "operation": "UPDATE",
    "database": "pgmind_dev",
    "affectedRows": 1,
    "status": "executed",
    "message": "UPDATE operation executed successfully."
}
```

### Step 5: Verify the result with SELECT

Use `execute_query` to confirm the change:

```
execute_query(sql: "SELECT * FROM products WHERE id = 1")
```

Expected: the row with `id = 1` now has `price = 500`.

### Step 6: Attempt to reuse the approval ID

Call `execute_approved_operation` again with the same approval ID:

```
execute_approved_operation(approvalId: "<uuid>")
```

This is **rejected** because the approval is already in `executed` status (single-use protection). The error indicates the request is not approved.

## Working directory

The MCP server's `cwd` must be the PG-mind repository root so that `pg-mind.config.yaml` is found at startup. If you move the server or run it from another directory, the configuration file will not be found and the server will fail to start.

## No AI/LLM inside PG-mind

PG-mind does not contain its own LLM. OpenCode provides the AI agent. PG-mind exposes database capabilities (schema, read query, approved write) as MCP tools for the LLM to invoke.
