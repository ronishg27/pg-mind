# OpenCode MCP Integration

PGMind runs as a local MCP server over stdio. OpenCode connects to it as an MCP server and invokes its tools through the LLM.

## 1. Build PGMind

```bash
pnpm install
pnpm build
```

This compiles TypeScript from `src/` to `dist/`. The entry point is `dist/index.js`.

## 2. Configure Environment

Copy `.env.example` to `.env` and fill in your values:

```bash
cp .env.example .env
```

Required:

```dotenv
QUERY_DATABASE_URL=postgresql://querymind_readonly:your_password@localhost:5433/querymind_dev
```

Optional (enables write operations):

```dotenv
WRITE_DATABASE_URL=postgresql://querymind_writer:your_password@localhost:5433/querymind_dev
```

The app loads `.env` automatically via `process.loadEnvFile(".env")` at startup. Restart the MCP server (and the OpenCode session that launched it) after changing `.env`.

## 3. Register in OpenCode

Add PGMind to your OpenCode MCP server configuration (`~/.opencode/config.json` or the workspace-level MCP config):

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

Replace `path-to-pgmind` with the absolute path to the PGMind repository working directory. The `cwd` matters because `src/index.ts` loads `.env` relative to the working directory.

See also `opencode-setup.md` for the config snippet.

## 4. Start the Server

Start PostgreSQL:

```bash
docker compose up -d
```

Start PGMind:

```bash
pnpm start
```

The server runs on stdio and logs `"PGMind MCP server is running. Waiting for requests..."` to stderr.

## 5. Verify MCP Connectivity

Use the `ping` tool to confirm the server is reachable:

```
ping(message: "hello")
```

Expected response: `"PGMind is running. Message Received: hello"`.

Without a message:

```
ping()
```

Expected response: `"PGMind is running. Pong!"`.

## 6. Inspect Available Tools

PGMind registers five MCP tools:

| Tool | Input | Purpose |
|------|-------|---------|
| `ping` | `{ message?: string }` | Verify connectivity |
| `execute_query` | `{ sql: string }` | Execute validated read-only SQL |
| `get_database_schema` | `{}` | Retrieve schema information |
| `prepare_operation` | `{ sql: string }` | Prepare a write operation for approval |
| `execute_approved_operation` | `{ approvalId: string }` | Execute an approved write operation |

Your OpenCode client should list these tools once connected.

## 7. Test the Approval Workflow

This example walks through preparing, reviewing, approving, executing, and verifying an UPDATE, then attempting to reuse the same approval ID.

### Step 1: Prepare an UPDATE

The LLM (or user) calls `prepare_operation` with an UPDATE statement:

```
prepare_operation(sql: "UPDATE products SET price = 500 WHERE id = 1")
```

PGMind classifies the SQL, creates a pending approval request, and presents the MCP elicitation prompt. The tool returns:

```json
{
    "id": "<uuid>",
    "status": "pending",
    "message": "..."
}
```

The elicitation prompt (shown to the human through the MCP client) displays:

- Operation: UPDATE
- Database: querymind_dev
- Summary: Modifies existing records in a database table.
- Complete SQL statement: `UPDATE products SET price = 500 WHERE id = 1`
- Approve / Reject choice

### Step 2: Review the Elicitation Prompt

The human reviews the complete SQL statement and the operation summary. Approve only if you understand and authorize this exact operation.

### Step 3: Approve the Operation

The human chooses **Approve** in the elicitation prompt. PGMind transitions the request to `approved`. The tool returns:

```json
{
    "id": "<uuid>",
    "status": "approved",
    "message": "Operation approved. It has not been executed."
}
```

Important: approval does **not** execute SQL. The UPDATE has not run yet.

### Step 4: Execute with the Approval ID

The LLM calls `execute_approved_operation` with the returned approval ID:

```
execute_approved_operation(approvalId: "<uuid>")
```

PGMind re-validates the stored SQL, claims the approval (single-use), verifies the writer connection (`current_database()` + `current_user === "querymind_writer"`), executes the exact stored SQL in a transaction, and records the result:

```json
{
    "approvalId": "<uuid>",
    "operation": "UPDATE",
    "database": "querymind_dev",
    "affectedRows": 1,
    "status": "executed",
    "message": "UPDATE operation executed successfully."
}
```

### Step 5: Verify the Result with SELECT

Use `execute_query` to confirm the change:

```
execute_query(sql: "SELECT * FROM products WHERE id = 1")
```

Expected: the row with `id = 1` now has `price = 500`.

### Step 6: Attempt to Reuse the Approval ID

Call `execute_approved_operation` again with the same approval ID:

```
execute_approved_operation(approvalId: "<uuid>")
```

This is **rejected** because the approval is already in `executed` status (single-use protection). The error indicates the request is not approved.

## Working Directory

The MCP server's `cwd` must be the PGMind repository root so that `.env` is found by `process.loadEnvFile(".env")`. If you move the server or run it from another directory, environment variables will not load and the server will fail to start.

## No AI/LLM Inside PGMind

PGMind does not contain its own LLM. OpenCode provides the AI agent. PGMind exposes database capabilities (schema, read query, approved write) as MCP tools for the LLM to invoke.
