# PGMind Security Model

PGMind uses a **defense-in-depth** approach. No single layer is relied upon as the complete security boundary. Application-level SQL validation complements — but does not replace — database-level role permissions.

## Defense-in-Depth Layers

1. **Dedicated read-only database role** (`pgmind_readonly`) — used by the read connection pool. Granted only CONNECT, schema USAGE, and SELECT. No write or DDL privileges.

2. **Restricted writer database role** — used by the write connection pool. Granted only CONNECT, schema USAGE, DML permissions (INSERT/UPDATE/DELETE), and sequence permissions by default. DDL privileges are not granted unless explicitly required for allowlisted DDL operations. No database-owner or superuser privileges.

3. **Separate read and write connection pools** — read queries never touch the write pool; write operations never touch the read pool. The write pool is optional and absent unless `WRITE_DATABASE_URL` is configured.

4. **SQL AST parsing and classification** — SQL is parsed with `pgsql-ast-parser` (PostgreSQL-aware AST parser), not naive string checks. Statements are classified by operation type and category.

5. **Separate read and write validators** — `SqlValidator` guards the read-only path (SELECT/WITH only). `WriteSqlValidator` guards the write path, accepting INSERT, UPDATE, DELETE, and an explicitly allowlisted set of DDL statement types (CREATE, ALTER, DROP, TRUNCATE). They are intentionally not merged into one permissive validator.

6. **Human approval before write execution** — `prepare_operation` classifies the SQL and creates a pending approval request that stores the exact SQL, operation type, and target database. `execute_approved_operation` runs only after explicit human approval via MCP elicitation. Supported write operations include INSERT, UPDATE, DELETE, and an allowlisted set of DDL operations. Approval is required before any write is executed.

7. **Exact SQL binding to approval requests** — the execution tool accepts an approval ID, not arbitrary SQL. The exact stored SQL is retrieved from the approval store and executed.

8. **Single-use approval IDs** — an approval transitions to `executing` synchronously before database execution, preventing duplicate claims. An approval can only be executed once.

9. **Approval expiration** — approvals expire after five minutes. Expired pending or approved requests transition to `expired` and cannot execute.

10. **Connection-aware approvals** — each approval retains its original `connectionName`, `database`, and `connectionGeneration` identity. Execution always resolves the originally stored connection, never the currently active connection. Configuration reloads increment the connection generation, so old approvals cannot execute against replacement connections.

11. **Database and role verification** — `withWriteTransaction` verifies `current_database()` matches the approval request's database and `current_user` matches the configured writer role (`writeRoleName`, default `pgmind_writer`, overridable via `WRITE_ROLE_NAME`) before executing anything.

11. **Transaction management** — writes run inside a transaction with `COMMIT`/`ROLLBACK`. Read queries run inside `BEGIN READ ONLY` transactions. A failed ROLLBACK causes the connection client to be discarded from the pool rather than returned for reuse, preventing an uncertain connection from being recycled.

12. **Statement timeout** — a 10-second `statement_timeout` applies on both read and write transactions.

13. **Result row and size limits** — read queries are limited to 100 rows and 1 MB of result size, with truncation reported.

14. **Uncertain commit handling** — a failed COMMIT raises `CommitOutcomeUnknownError`, marks the execution as `execution_unknown`, and discards the connection client from the pool. An unknown commit outcome means the operation may or may not have been applied. It must not trigger automatic retry, as retrying could cause duplicate effects.

## Limitations

PGMind is **not** completely secure. Do not assume that every SQL injection or malicious SQL scenario is prevented. Specific limitations:

- **SQL validation is not a complete SQL sandbox.** AST-based validation reduces risk but cannot catch every dangerous construct or side effect.
- **The dangerous-function list is not exhaustive.** Both validators maintain a set of disallowed PostgreSQL functions, but the list may not cover every function with side effects.
- **In-memory approvals are lost on restart.** `ApprovalStore` is an in-memory `Map`. All pending approvals disappear when the server restarts.
- **Approval does not guarantee that an operation is logically correct.** Human approval authorizes the exact SQL, but it does not verify that the SQL produces the intended business outcome.
- **Database role permissions remain the primary enforcement boundary.** Application validation is a secondary safeguard. If the read-only or writer role is over-permissioned, validation cannot compensate.
- **A statement timeout does not guarantee that all database resource consumption is bounded.** Long-running transactions, locks, and other resource usage may still occur before the timeout fires.
- **`execution_unknown` requires manual database-state verification before any new attempt.** An uncertain commit outcome means the operation may or may not have been applied. Retrying blindly could cause duplicate effects.
- **The current writer permission model does not support arbitrary DDL.** DDL support is limited to explicitly allowlisted AST statement types accepted by `WriteSqlValidator` (CREATE, ALTER, DROP, TRUNCATE). Unsupported DDL such as `DROP SCHEMA`, `DROP VIEW`, `CREATE TYPE`, `CREATE FUNCTION`, `ALTER SEQUENCE`, and `DROP TYPE` is rejected by the validator. Whether an allowlisted DDL operation succeeds depends on the PostgreSQL privileges and ownership assigned to the writer role.
- **`CREATE SCHEMA` passes application validation but currently fails** when executed with the default writer role, because that role lacks database-level `CREATE` permission.
- **`CREATE INDEX CONCURRENTLY` and `DROP INDEX CONCURRENTLY` are rejected** by `WriteSqlValidator` because they cannot run inside a transaction, and write operations always execute inside a transaction.
- **Not every supported DDL operation has been live-tested against PostgreSQL.** Do not assume that an allowlisted DDL operation has been verified in a real database.

## Trust Boundaries

- PGMind trusts the MCP client to authenticate the end user. PGMind itself has no authentication or authorization layer.
- PGMind trusts that the PostgreSQL roles are configured with the least privilege described in `docs/database-setup.md`.
- Human approval is the trust boundary for write operations. The human reviewer must read the complete SQL statement presented in the elicitation prompt before approving.
