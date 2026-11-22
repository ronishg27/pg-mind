# PostgreSQL Setup and Role Permissions

QueryMind uses three PostgreSQL roles with distinct responsibilities:

| Role | Responsibility |
|------|----------------|
| `querymind` | Development / database owner role (used by Docker Compose as the initial superuser of the `querymind_dev` database) |
| `querymind_readonly` | Read-only database access (schema discovery, SELECT queries) |
| `querymind_writer` | Restricted DML execution (approved INSERT, UPDATE, DELETE only) |

## querymind_readonly — Read-Only Role

This role is used by the read connection pool (`QUERY_DATABASE_URL`). It must have the minimum permissions needed to inspect and read data:

- `CONNECT` on the target database.
- `USAGE` on each schema the application must inspect or query.
- `SELECT` on the tables and views it must read.

Do **not** grant `INSERT`, `UPDATE`, `DELETE`, `TRUNCATE`, `CREATE`, or ownership privileges to this role.

### Setup (read-only)

Run as a PostgreSQL superuser or administrator:

```sql
-- 1. Create the login role (once per cluster)
CREATE ROLE querymind_readonly
    WITH LOGIN
    NOSUPERUSER
    NOCREATEDB
    NOCREATEROLE
    NOREPLICATION
    NOBYPASSRLS;

\password querymind_readonly
```

Then, connected to the target database:

```sql
-- 2. Grant database, schema, and table access
GRANT CONNECT ON DATABASE querymind_dev TO querymind_readonly;
GRANT USAGE ON SCHEMA public TO querymind_readonly;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO querymind_readonly;

-- 3. (Optional) Default privileges for future tables owned by another role
-- Replace <table_owner> with the role that creates application tables.
ALTER DEFAULT PRIVILEGES FOR ROLE <table_owner>
IN SCHEMA public
GRANT SELECT ON TABLES TO querymind_readonly;
```

### Optional: default read-only transactions

```sql
ALTER ROLE querymind_readonly
    IN DATABASE querymind_dev
    SET default_transaction_read_only = on;
```

This is an additional safety default, not a replacement for database privileges.

For a step-by-step read-only setup guide (including verification SQL and troubleshooting), see `postgresql-readonly-user-guide.md`.

## querymind_writer — Restricted Write Role

This role is used by the write connection pool (`WRITE_DATABASE_URL`) for executing approved write operations. It is **optional at startup**: if `WRITE_DATABASE_URL` is not configured, write operations are unavailable.

### Intended permissions

The writer role should have:

- `CONNECT` on the target database.
- `USAGE` on the schema(s) containing the target tables.
- DML permissions: `INSERT`, `UPDATE`, `DELETE` on the target tables.
- Sequence permissions: `USAGE` and `UPDATE` on sequences (needed for `SERIAL`/`IDENTITY` columns when `RETURNING` is used).

### What the writer role must NOT receive

- Broad database-owner privileges.
- Superuser privileges.
- `CREATE`, `ALTER`, `DROP`, `TRUNCATE` on schemas or tables (DDL).

The writer role must not receive broad database-owner or superuser privileges merely to make write operations work. Database-level role permissions remain the primary enforcement boundary.

### Supported operations

The current execution implementation supports **INSERT, UPDATE, and DELETE** only through the approval workflow. Although `SqlOperationClassifier` recognizes CREATE, ALTER, DROP, and TRUNCATE operations, those are **not** executable through the approval workflow because `WriteSqlValidator` rejects them. DDL requires a separate permission and ownership design and is not part of the current implementation.

### Example grants

```sql
CREATE ROLE querymind_writer
    WITH LOGIN
    NOSUPERUSER
    NOCREATEDB
    NOCREATEROLE
    NOREPLICATION
    NOBYPASSRLS;

\password querymind_writer

GRANT CONNECT ON DATABASE querymind_dev TO querymind_writer;
GRANT USAGE ON SCHEMA public TO querymind_writer;
GRANT INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO querymind_writer;
GRANT USAGE, UPDATE ON ALL SEQUENCES IN SCHEMA public TO querymind_writer;
```

## Connection Strings

Configure in `.env`:

```dotenv
QUERY_DATABASE_URL=postgresql://querymind_readonly:your_password@localhost:5433/querymind_dev
WRITE_DATABASE_URL=postgresql://querymind_writer:your_password@localhost:5433/querymind_dev
```

- `QUERY_DATABASE_URL` is **required**. The server will not start without it.
- `WRITE_DATABASE_URL` is **optional**. Omit it if you only need read-only access.

## Verification

Connect as each role and check identity:

```sql
SELECT current_database() AS database_name,
       current_user AS login_role;
```

Expected values:

| Role | database_name | login_role |
|------|---------------|------------|
| `querymind_readonly` | `querymind_dev` | `querymind_readonly` |
| `querymind_writer` | `querymind_dev` | `querymind_writer` |

QueryMind's `withWriteTransaction` verifies at runtime that the writer connection's `current_database()` matches the approval request's database and that `current_user` is `querymind_writer`. A mismatch aborts the operation.

## Relationship to Other Docs

- `docs/security.md` — defense-in-depth model and limitations.
- `docs/architecture.md` — execution flows and connection-pool details.
- `postgresql-readonly-user-guide.md` — detailed read-only role setup with verification commands.
