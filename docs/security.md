# QueryMind Security Model

QueryMind uses a **defense-in-depth** approach. No single layer is relied upon as the complete security boundary. Application-level SQL validation complements — but does not replace — database-level role permissions.

## Defense-in-Depth Layers

1. **Dedicated read-only database role** (`querymind_readonly`) — used by the read connection pool. Granted only CONNECT, schema USAGE, and SELECT. No write or DDL privileges.

2. **Restricted writer database role** (`querymind_writer`) — used by the write connection pool. Granted only CONNECT, schema USAGE, DML (INSERT/UPDATE/DELETE), and sequence permissions. No database-owner or superuser privileges.

3. **Separate read and write connection pools** — read queries never touch the write pool; write operations never touch the read pool. The write pool is optional and absent unless `WRITE_DATABASE_URL` is configured.

4. **SQL AST parsing and classification** — SQL is parsed with `pgsql-ast-parser` (PostgreSQL-aware AST parser), not naive string checks. Statements are classified by operation type and category.

5. **Separate read and write validators** — `SqlValidator` guards the read-only path (SELECT/WITH only). `WriteSqlValidator` guards the write path (INSERT/UPDATE/DELETE only). They are intentionally not merged into one permissive validator.

6. **Human approval before write execution** — `prepare_operation` stores a pending approval; `execute_approved_operation` runs only after explicit human approval via MCP elicitation.

7. **Exact SQL binding to approval requests** — the execution tool accepts an approval ID, not arbitrary SQL. The exact stored SQL is retrieved from the approval store and executed.

8. **Single-use approval IDs** — an approval transitions to `executing` synchronously before database execution, preventing duplicate claims. An approval can only be executed once.

9. **Approval expiration** — approvals expire after five minutes. Expired pending or approved requests transition to `expired` and cannot execute.

10. **Database and role verification** — `withWriteTransaction` verifies `current_database()` matches the approval request's database and `current_user` is `querymind_writer` before executing anything.

11. **Transaction management** — writes run inside a transaction with `COMMIT`/`ROLLBACK`. Read queries run inside `BEGIN READ ONLY` transactions.

12. **Statement timeout** — a 10-second `statement_timeout` applies on both read and write transactions.

13. **Result row and size limits** — read queries are limited to 100 rows and 1 MB of result size, with truncation reported.

14. **Uncertain commit handling** — a failed COMMIT raises `CommitOutcomeUnknownError` and marks the execution as `execution_unknown` rather than assuming rollback or retrying automatically.

## Limitations

QueryMind is **not** completely secure. Do not assume that every SQL injection or malicious SQL scenario is prevented. Specific limitations:

- **SQL validation is not a complete SQL sandbox.** AST-based validation reduces risk but cannot catch every dangerous construct or side effect.
- **The dangerous-function list is not exhaustive.** Both validators maintain a set of disallowed PostgreSQL functions, but the list may not cover every function with side effects.
- **In-memory approvals are lost on restart.** `ApprovalStore` is an in-memory `Map`. All pending approvals disappear when the server restarts.
- **Approval does not guarantee that an operation is logically correct.** Human approval authorizes the exact SQL, but it does not verify that the SQL produces the intended business outcome.
- **Database role permissions remain the primary enforcement boundary.** Application validation is a secondary safeguard. If the read-only or writer role is over-permissioned, validation cannot compensate.
- **A statement timeout does not guarantee that all database resource consumption is bounded.** Long-running transactions, locks, and other resource usage may still occur before the timeout fires.
- **`execution_unknown` requires manual database-state verification before any new attempt.** An uncertain commit outcome means the operation may or may not have been applied. Retrying blindly could cause duplicate effects.
- **The current writer permission model does not support arbitrary DDL.** CREATE, ALTER, DROP, and TRUNCATE are recognized by the classifier but rejected by the write validator. They cannot be executed through the approval workflow.

## Trust Boundaries

- QueryMind trusts the MCP client to authenticate the end user. QueryMind itself has no authentication or authorization layer.
- QueryMind trusts that the PostgreSQL roles are configured with the least privilege described in `docs/database-setup.md`.
- Human approval is the trust boundary for write operations. The human reviewer must read the complete SQL statement presented in the elicitation prompt before approving.
