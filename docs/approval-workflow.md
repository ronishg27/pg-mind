# Approval Workflow

QueryMind's write operations are gated behind explicit human approval. Approval and execution are separate steps:

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

**Limitation:** Approval requests disappear when the server restarts. In-memory storage is not durable.

## Approval Status Lifecycle

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

- **Operation type** (e.g., UPDATE).
- **Database name** (from the approval request).
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
   - Classifies the SQL (`SqlOperationClassifier`). Rejects non-write operations.
   - Identifies the current database (`SELECT current_database()`).
   - Creates a `pending` approval request in `ApprovalStore` (UUID, 5-minute TTL).
4. `ApprovalWorkflowService.prepareAndConfirm`:
   - Builds an operation summary.
   - Calls `McpApprovalConfirmationProvider.confirm` to elicit a human decision.
   - On `approve`: transitions to `approved`, returns `{ id, status: "approved", message: "Operation approved. It has not been executed." }`.
   - On `reject`/`cancel`/confirmation failure: transitions to `rejected`.
5. The human sees the complete SQL in the elicitation prompt and chooses approve or reject.
6. If approved, the LLM (or user) calls `execute_approved_operation({ approvalId })`.
7. `OperationExecutionService.executeOperation`:
   - `prepareExecution`: retrieves the request; requires status `approved`.
   - Re-validates the stored SQL with `WriteSqlValidator` (INSERT/UPDATE/DELETE only).
   - Re-classifies and verifies the operation matches the stored operation.
   - Claims the approval: transitions `approved` → `executing` synchronously.
8. `DatabaseService.withWriteTransaction`:
   - Verifies `current_database()` and `current_user === "querymind_writer"`.
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
