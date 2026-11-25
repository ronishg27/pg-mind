# PostgreSQL Setup and Role Permissions

PGMind uses three PostgreSQL roles with distinct responsibilities:

| Role | Responsibility |
|------|----------------|
| `pgmind` | Development / database owner role (used by Docker Compose as the initial superuser of the `pgmind_dev` database) |
| `pgmind_readonly` | Read-only database access (schema discovery, SELECT queries) |
| `pgmind_writer` | Restricted execution (approved DML and allowlisted DDL operations) |

## pgmind_readonly — Read-Only Role

This role is used by the read connection pool (`QUERY_DATABASE_URL`). It must have the minimum permissions needed to inspect and read data:

- `CONNECT` on the target database.
- `USAGE` on each schema the application must inspect or query.
- `SELECT` on the tables and views it must read.

Do **not** grant `INSERT`, `UPDATE`, `DELETE`, `TRUNCATE`, `CREATE`, or ownership privileges to this role.

### Setup (read-only)

Run as a PostgreSQL superuser or administrator:

```sql
-- 1. Create the login role (once per cluster)
CREATE ROLE pgmind_readonly
    WITH LOGIN
    NOSUPERUSER
    NOCREATEDB
    NOCREATEROLE
    NOREPLICATION
    NOBYPASSRLS;

\password pgmind_readonly
```

Then, connected to the target database:

```sql
-- 2. Grant database, schema, and table access
GRANT CONNECT ON DATABASE pgmind_dev TO pgmind_readonly;
GRANT USAGE ON SCHEMA public TO pgmind_readonly;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO pgmind_readonly;

-- 3. (Optional) Default privileges for future tables owned by another role
-- Replace <table_owner> with the role that creates application tables.
ALTER DEFAULT PRIVILEGES FOR ROLE <table_owner>
IN SCHEMA public
GRANT SELECT ON TABLES TO pgmind_readonly;
```

### Optional: default read-only transactions

```sql
ALTER ROLE pgmind_readonly
    IN DATABASE pgmind_dev
    SET default_transaction_read_only = on;
```

This is an additional safety default, not a replacement for database privileges.

For a step-by-step read-only setup guide (including verification SQL and troubleshooting), see `postgresql-readonly-user-guide.md`.

## pgmind_writer — Restricted Write Role

This role is used by the write connection pool (`WRITE_DATABASE_URL`) for executing approved write operations. It is **optional at startup**: if `WRITE_DATABASE_URL` is not configured, write operations are unavailable.

### Intended permissions

The writer role should have:

- `CONNECT` on the target database.
- `USAGE` on the schema(s) containing the target tables.
- DML permissions: `INSERT`, `UPDATE`, `DELETE` on the target tables.
- Sequence permissions: `USAGE` and `UPDATE` on sequences (needed for `SERIAL`/`IDENTITY` columns when `RETURNING` is used).

Additional DDL privileges are **not** granted by default. They should only be added when a specific allowlisted DDL operation is intentionally required.

### What the writer role must NOT receive

- Broad database-owner privileges.
- Superuser privileges.
- Unrestricted DDL privileges on schemas or tables.

The writer role must not receive broad database-owner or superuser privileges merely to make write operations work. Additional DDL privileges or object ownership should only be introduced when the corresponding allowlisted DDL operations are intentionally required. Database-level role permissions remain the primary enforcement boundary.

### Supported operations

The execution service allows INSERT, UPDATE, DELETE, and a limited, explicitly allowlisted set of DDL operations (CREATE, ALTER, DROP, TRUNCATE) through the approval workflow.

Application validation accepts only specific AST statement types: `create table`, `create index`, `create schema`, `create view`, `alter table`, `alter index`, `drop table`, `drop index`, and `truncate table`, together with the DML types `insert`, `update`, and `delete`. This is **not** unrestricted SQL or unrestricted DDL. Operations such as `DROP SCHEMA`, `DROP VIEW`, `CREATE TYPE`, `CREATE FUNCTION`, `ALTER SEQUENCE`, and `DROP TYPE` are rejected by `WriteSqlValidator`.

Whether a supported operation actually succeeds depends on the PostgreSQL privileges and ownership assigned to `pgmind_writer` (or the role configured via `WRITE_ROLE_NAME`):

- `CREATE TABLE` requires `CREATE` privilege on the target schema.
- `ALTER` and `DROP` operations generally depend on ownership of the affected object.
- `TRUNCATE` requires the appropriate privilege or ownership.
- `CREATE SCHEMA` requires `CREATE` privilege on the database.

PostgreSQL does not provide generic `ALTER` or `DROP` privileges that can be granted independently; object ownership is the controlling factor for most ALTER and DROP operations.

### Example grants

```sql
CREATE ROLE pgmind_writer
    WITH LOGIN
    NOSUPERUSER
    NOCREATEDB
    NOCREATEROLE
    NOREPLICATION
    NOBYPASSRLS;

\password pgmind_writer

GRANT CONNECT ON DATABASE pgmind_dev TO pgmind_writer;
GRANT USAGE ON SCHEMA public TO pgmind_writer;
GRANT INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO pgmind_writer;
GRANT USAGE, UPDATE ON ALL SEQUENCES IN SCHEMA public TO pgmind_writer;
```

These example grants cover DML only. DDL privileges are intentionally **not** included. Add `CREATE` on a schema (for `CREATE TABLE`), object ownership (for `ALTER`/`DROP`), or database-level `CREATE` (for `CREATE SCHEMA`) only when the corresponding DDL operation is explicitly required.

## Connection Strings

Configure in `.env`:

```dotenv
QUERY_DATABASE_URL=postgresql://pgmind_readonly:your_password@localhost:5433/pgmind_dev
WRITE_DATABASE_URL=postgresql://pgmind_writer:your_password@localhost:5433/pgmind_dev
```

- `QUERY_DATABASE_URL` is **required**. The server will not start without it.
- `WRITE_DATABASE_URL` is **optional**. Omit it if you only need read-only access.

The expected writer role name is configured via `WRITE_ROLE_NAME` and defaults to `pgmind_writer`. The writer connection identity is verified at runtime in `withWriteTransaction`, so the configured role name must match the actual PostgreSQL role used by `WRITE_DATABASE_URL`.

## Verification

Connect as each role and check identity:

```sql
SELECT current_database() AS database_name,
       current_user AS login_role;
```

Expected values:

| Role | database_name | login_role |
|------|---------------|------------|
| `pgmind_readonly` | `pgmind_dev` | `pgmind_readonly` |
| `pgmind_writer` | `pgmind_dev` | `pgmind_writer` |

PGMind's `withWriteTransaction` verifies at runtime that the writer connection's `current_database()` matches the approval request's database and that `current_user` matches the configured `writeRoleName` (default `pgmind_writer`, overridable via `WRITE_ROLE_NAME`). A mismatch aborts the operation.

## Known limitations

The following DDL behaviors are important to understand before granting writer privileges:

- **`CREATE SCHEMA` passes application validation but currently fails** when executed with the default `pgmind_writer` role, because that role lacks database-level `CREATE` permission. Grant `CREATE` on the database only if schema creation is explicitly required.
- **`CREATE INDEX CONCURRENTLY` and `DROP INDEX CONCURRENTLY` are rejected** by `WriteSqlValidator` because they cannot run inside a transaction, and the execution workflow always runs write operations in a transaction.
- **Unsupported DDL must not be presented as supported.** `DROP SCHEMA`, `DROP VIEW`, `CREATE TYPE`, `CREATE FUNCTION`, `ALTER SEQUENCE`, and `DROP TYPE` are rejected by `WriteSqlValidator` and are not in the execution allowlist. Not every DDL operation has been live-tested against PostgreSQL.

## Relationship to Other Docs

- `docs/security.md` — defense-in-depth model and limitations.
- `docs/architecture.md` — execution flows and connection-pool details.
- `postgresql-readonly-user-guide.md` — detailed read-only role setup with verification commands.
