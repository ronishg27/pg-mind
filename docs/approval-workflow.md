# Approval Workflow

PGMind's write operations are gated behind explicit human approval. Supported writes include INSERT, UPDATE, DELETE, and an explicitly allowlisted set of DDL operations (CREATE, ALTER, DROP, TRUNCATE). Approval and execution are separate steps:

- **Approval** authorizes a specific SQL statement for later execution. It does **not** execute SQL.
- **Execution** runs the approved SQL against the database, but only with a valid approval ID.

## Approval Store (`ApprovalStore`)

`ApprovalStore` holds approval requests in memory:

- **In-memory `Map` storage.** All requests live in a `Map<string, ApprovalRequest>`.
- **UUID-based approval IDs.** Each request gets a unique `randomUUID()` identifier.
- **Five-minute expiration.** `APPROVAL_TTL_MS = 5 * 60 * 1000` (5 minutes) from creation.
- **Defensive copies.** `getById` and `create` return cloned copies so callers cannot mutate stored requests through the returned object.
- **Single-use execution claims.** The transition to `executing` happens synchronously before database execution, preventing duplicate claims.
- **Explicit status transitions.** Allowed transitions are defined in `ALLOWED_TRANSITIONS`.
- **Expiration checks on access.** When a `pending` or `approved` request is accessed and its TTL has passed, it transitions to `expired`.
- **Expired request cleanup.** `deleteExpired()` removes expired `pending` and `approved` requests and returns the count deleted.

### Approval request fields

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | UUID approval ID |
| `sql` | `string` | The exact SQL statement to execute |
| `operation` | `SqlOperation` | Classified operation type (INSERT, UPDATE, DELETE, CREATE, ALTER, DROP, TRUNCATE) |
| `database` | `string` | Actual database name from `SELECT current_database()` at preparation |
| `connectionName` | `string \| undefined` | Configured connection name the operation targets |
| `connectionGeneration` | `number \| undefined` | Immutable connection instance/generation token, incremented on connection replacement (e.g. config reload) |
| `status` | `ApprovalStatus` | Current lifecycle status |
| `createdAt` | `Date` | Creation timestamp |
| `expiresAt` | `Date` | Expiration timestamp (5 minutes TTL) |
| `affectedRows` | `number \| undefined` | Rows affected after execution |

**Limitation:** Approval requests disappear when the server restarts. In-memory storage is not durable.

## Connection-Aware Approval Guarantees

The possible status values are:

| Status | Meaning |
|--------|---------|
| `pending` | Initial state after creation. Awaiting human decision. |
| `approved` | Human approved. Ready to be executed. |
| `executing` | Claimed for execution. The SQL is about to run (or running). |
| `rejected` | Human rejected. Terminal. |
| `expired` | TTL passed before a decision. Terminal. |
| `executed` | Execution completed successfully. Terminal. |
| `failed` | Execution failed (non-commit error). Terminal. |
| `execution_unknown` | COMMIT outcome uncertain. Terminal. Manual DB verification required. |

### Allowed Transitions

```
pending  →  approved, rejected, expired
approved →  executing, expired
executing → executed, failed, execution_unknown
rejected → (terminal)
expired  → (terminal)
executed → (terminal)
failed   → (terminal)
execution_unknown → (terminal)
```

### Important Behaviors

- **An approval can only be executed once.** After `executed`, no further transitions are allowed. Attempting to execute the same approval ID again fails because the status is no longer `approved`.
- **An expired approval cannot execute.** Expired requests transition to `expired` (terminal) and `updateStatus` rejects any further transition.
- **A rejected approval cannot execute.** `rejected` is terminal.
- **An executed approval cannot be reused.** `executed` is terminal.
- **The transition from `approved` to `executing` happens synchronously before database execution** to prevent duplicate claims between the check and the execution.
- **An execution with an uncertain commit outcome cannot be retried automatically.** It is marked `execution_unknown` (terminal). A retry attempt fails because the status is no longer `approved`.

## Connection-Aware Approval Guarantees

PGMind's write approval workflow is **connection-aware**. An approved operation must always execute against the exact database connection used when it was prepared, regardless of subsequent active database changes or configuration reloads.

1. **Connection resolution during preparation.** `prepare_operation` supports an optional `connectionName`. If supplied, that configured connection is used; otherwise the currently active connection is used. Unknown connection names are rejected with a clear error. The active connection is never changed by an explicit `connectionName`.

2. **Connection identity bound to approval records.** The approval record retains `connectionName` (the configured connection name) and `database` (the actual database name), plus `connectionGeneration` (an immutable token incremented each time the underlying connection instance is replaced). Approvals remain associated with their original connection throughout their lifecycle.

3. **Connection-aware execution.** `execute_approved_operation` resolves the originally stored connection from the approval record — never the current active connection. If the original connection is no longer configured, execution fails safely rather than falling back to the default or active connection. The stored `connectionGeneration` is checked against the current generation; if they differ (e.g. the connection was replaced by a configuration reload), execution is rejected.

4. **No credential storage.** Approval records never store database credentials or connection URLs.

## Configuration Reload and Pending Approvals

When `reload_configuration` is invoked:

- **Unchanged connection:** Existing approvals continue working — the connection instance and generation are unchanged.
- **Modified connection:** Existing approvals fail safely at execution. The connection's generation is incremented on replacement, and `OperationExecutionService` verifies the stored generation matches before executing.
- **Removed connection:** Existing approvals fail safely because the connection no longer exists in the registry.
- **Re-added connection with the same name:** Treated as a new connection instance — its generation is incremented, so old approvals prepared against the previous instance cannot execute against it.

Configuration reload never redirects existing approvals to replacement or different connections.

## Approval Confirmation

### `ApprovalConfirmationProvider` Interface

```ts
export interface ApprovalConfirmationProvider {
    confirm(input: ApprovalConfirmationInput): Promise<ApprovalDecision>;
}

export type ApprovalDecision = "approve" | "reject" | "cancel";
```

### MCP Elicitation Implementation (`McpApprovalConfirmationProvider`)

Uses the MCP server's `elicitInput` mechanism with `mode: "form"`. The confirmation prompt displays:

- **Connection name** (from the stored approval request).
- **Database name** (from the stored approval request).
- **Operation type** (e.g., UPDATE).
- **Operation summary** (human-readable description of INSERT/UPDATE/DELETE/CREATE/ALTER/DROP/TRUNCATE).
- **Complete SQL statement** (the exact statement to be executed).
- **Explicit approve/reject choice** (enum: `approve` / `reject`).

Behavior:

- User chooses **approve** → decision `"approve"` → request status transitions to `approved`.
- User chooses **reject** → decision `"reject"` → status transitions to `rejected`.
- User **cancels** the elicitation dialog → decision `"cancel"` → status transitions to `rejected`.
- Elicitation is **declined** by the client → `"reject"`.
- Response is **incomplete** (e.g., accept without a decision) → `"cancel"` (never authorizes execution).
- Elicitation **errors** → the error propagates and the request is rejected.

## End-to-End Approval Flow

1. LLM generates SQL for a data modification.
2. LLM calls `prepare_operation({ sql })`.
3. `ApprovalService.prepareOperation`:
   - Classifies the SQL (`SqlOperationClassifier`), identifying the operation type, category (read/write/unknown), and whether approval is required. Rejects non-write or unknown classifications.
   - Identifies the current database (`SELECT current_database()`).
   - Creates a `pending` approval request in `ApprovalStore` storing the original SQL, classified operation, and target database (UUID, 5-minute TTL).
4. `ApprovalWorkflowService.prepareAndConfirm`:
   - Builds an operation summary.
   - Calls `McpApprovalConfirmationProvider.confirm` to elicit a human decision.
   - On `approve`: transitions to `approved`, returns `{ id, status: "approved", message: "Operation approved. It has not been executed." }`.
   - On `reject`/`cancel`/confirmation failure: transitions to `rejected`.
5. The human sees the complete SQL in the elicitation prompt and chooses approve or reject.
6. If approved, the LLM (or user) calls `execute_approved_operation({ approvalId })`.
7. `OperationExecutionService.executeOperation`:
   - `prepareExecution`: retrieves the request; requires status `approved`.
   - Re-validates the stored SQL with `WriteSqlValidator` (INSERT, UPDATE, DELETE, and allowlisted DDL types).
   - Re-classifies and verifies the operation matches the stored operation.
   - Claims the approval: transitions `approved` → `executing` synchronously.
8. `DatabaseService.withWriteTransaction`:
   - Verifies `current_database()` matches the expected database and `current_user` matches the configured writer role (`writeRoleName`, default `pgmind_writer`).
   - Sets `statement_timeout = '10s'`.
   - Executes the exact stored SQL.
   - Returns `rowCount` as `affectedRows`.
9. On success: status `executed`, returns `{ approvalId, operation, database, affectedRows, status: "executed" }`.
10. On non-commit error: status `failed`.
11. On commit failure: `CommitOutcomeUnknownError`, status `execution_unknown`.

## Components

| Component | Responsibility |
|-----------|----------------|
| `ApprovalStore` | In-memory storage, UUIDs, TTL, status transitions, defensive copies, expiration cleanup |
| `ApprovalService` | `prepareOperation`, `getApproval`, `approveOperation`, `rejectOperation` |
| `ApprovalWorkflowService` | `prepareAndConfirm` — orchestrates classification, elicitation, and decision |
| `ApprovalConfirmationProvider` | Interface for confirmation/elicitation |
| `McpApprovalConfirmationProvider` | MCP `elicitInput`-based implementation (form mode) |
| `OperationExecutionService` | `executeOperation` — re-validate, claim, execute via write transaction, record status |
| `OperationExecutionWorkflowService` | `execute` — thin wrapper around `OperationExecutionService` |
