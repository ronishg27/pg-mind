# PG-mind Security Model

PG-mind applies a **defense-in-depth** approach. No single layer is relied upon as the complete security boundary. Application-level SQL validation complements — but does not replace — database-level permissions.

PG-mind is **not** a security product. Do not describe it as "production-ready", "fully secure", or "guaranteed safe". It is a developer tool for local development and experimentation with PostgreSQL through MCP.

## Defense-in-depth layers

1. **Application-level SQL validation.** Statements are parsed with `pgsql-ast-parser` (a PostgreSQL-aware AST parser), not naive string checks. Read-only queries are restricted to SELECT/WITH; writes are restricted to INSERT, UPDATE, DELETE, and an explicitly allowlisted set of DDL statement types (CREATE, ALTER, DROP, TRUNCATE).

2. **Separate read and write validators.** `SqlValidator` guards the read-only path (SELECT/WITH only). `WriteSqlValidator` guards the write path (INSERT, UPDATE, DELETE, and allowlisted DDL types). They are intentionally not merged into one permissive validator.

3. **Human approval before write execution.** `prepare_operation` classifies the SQL and creates a pending approval request that stores the exact SQL, operation type, and target database. `execute_approved_operation` runs only after explicit human approval via MCP elicitation. Approval is required before any write is executed.

4. **Exact SQL binding to approval requests.** The execution tool accepts an approval ID, not arbitrary SQL. The exact stored SQL is retrieved from the approval store and executed.

5. **Single-use approval IDs.** An approval transitions to `executing` synchronously before database execution, preventing duplicate claims. An approval can only be executed once.

6. **Approval expiration.** Approvals expire after five minutes. Expired pending or approved requests transition to `expired` and cannot execute.

7. **Connection-aware approvals.** Each approval retains its original `connectionName`, `database`, and `connectionGeneration` identity. Execution always resolves the originally stored connection, never the currently active connection. Configuration reloads increment the connection generation, so old approvals cannot execute against replacement connections.

8. **Database and role verification.** `withWriteTransaction` verifies `current_database()` matches the expected database and `current_user` matches the configured username before executing anything. Read queries run inside `BEGIN READ ONLY` transactions.

9. **Transaction management.** Writes run inside a transaction with `COMMIT`/`ROLLBACK`. Read queries run inside `BEGIN READ ONLY` transactions. A failed ROLLBACK causes the connection client to be discarded from the pool rather than returned for reuse, preventing an uncertain connection from being recycled.

10. **Statement timeout.** A 10-second `statement_timeout` applies on both read and write transactions (configurable via `statementTimeoutMs`).

11. **Result row and size limits.** Read queries are limited to 100 rows and 1 MB of result size, with truncation reported.

12. **Uncertain commit handling.** A failed COMMIT raises `CommitOutcomeUnknownError`, marks the execution as `execution_unknown`, and discards the connection client from the pool. An unknown commit outcome means the operation may or may not have been applied. It must not trigger automatic retry, as retrying could cause duplicate effects.

## Credentials and database roles

PG-mind creates a read pool and (optionally) a write pool for each configured connection, using the **same configured credentials** (username/password) for both. PG-mind does **not** enforce separate database roles (for example, a distinct `pgmind_readonly` and `pgmind_writer`). PostgreSQL role permissions are the primary enforcement boundary at the database level:

- Grant the connecting role only the privileges it needs (CONNECT, schema USAGE, SELECT for reads; INSERT/UPDATE/DELETE for writes).
- Do not grant superuser or database-owner privileges merely to make write operations work.
- Add DDL privileges (CREATE on a schema, object ownership for ALTER/DROP, database-level CREATE for CREATE SCHEMA) only when the corresponding allowlisted DDL operation is intentionally required.

See `docs/database-setup.md` for PostgreSQL setup guidance.

## Limitations

PG-mind is **not** completely secure. Do not assume that every SQL injection or malicious SQL scenario is prevented. Specific limitations:

- **SQL validation is not a complete SQL sandbox.** AST-based validation reduces risk but cannot catch every dangerous construct or side effect.
- **The disallowed-function list is not exhaustive.** Both validators maintain a set of disallowed PostgreSQL functions, but the list may not cover every function with side effects.
- **In-memory approvals are lost on restart.** `ApprovalStore` is an in-memory `Map`. All pending approvals disappear when the server restarts.
- **Approval does not guarantee that an operation is logically correct.** Human approval authorizes the exact SQL, but it does not verify that the SQL produces the intended business outcome.
- **Database role permissions remain the primary enforcement boundary.** Application validation is a secondary safeguard. If the connecting role is over-permissioned, validation cannot compensate.
- **A statement timeout does not guarantee that all database resource consumption is bounded.** Long-running transactions, locks, and other resource usage may still occur before the timeout fires.
- **`execution_unknown` requires manual database-state verification before any new attempt.** An uncertain commit outcome means the operation may or may not have been applied. Retrying blindly could cause duplicate effects.
- **The current permission model does not support arbitrary DDL.** DDL support is limited to explicitly allowlisted AST statement types accepted by `WriteSqlValidator` (CREATE, ALTER, DROP, TRUNCATE). Unsupported DDL such as `DROP SCHEMA`, `DROP VIEW`, `CREATE TYPE`, `CREATE FUNCTION`, `ALTER SEQUENCE`, and `DROP TYPE` is rejected by the validator. Whether an allowlisted DDL operation succeeds depends on the PostgreSQL privileges and ownership assigned to the connecting role.
- **`CREATE SCHEMA` passes application validation but currently fails** when executed with a role that lacks database-level `CREATE` permission.
- **`CREATE INDEX CONCURRENTLY` and `DROP INDEX CONCURRENTLY` are rejected** by `WriteSqlValidator` because they cannot run inside a transaction, and write operations always execute inside a transaction.
- **Not every supported DDL operation has been live-tested against PostgreSQL.** Do not assume that an allowlisted DDL operation has been verified in a real database.

## Trust boundaries

- PG-mind trusts the MCP client to authenticate the end user. PG-mind itself has **no authentication or authorization layer**.
- PG-mind trusts that the connecting database role is configured with least privilege as described in `docs/database-setup.md`.
- Human approval is the trust boundary for write operations. The human reviewer must read the complete SQL statement presented in the elicitation prompt before approving.
