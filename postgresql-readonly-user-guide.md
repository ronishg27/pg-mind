# PostgreSQL Read-Only User Setup Guide

This guide explains how to create a dedicated PostgreSQL login role for an application such as PGMind, grant it read-only access to a database, and verify that the permissions work.

The examples use:

| Setting | Example value |
|---|---|
| Database | `supergen` |
| Read-only role | `pgmind_readonly` |
| Schema | `public` |
| PostgreSQL host | `localhost` |
| PostgreSQL port | `5432` |

Replace these values with the ones for your environment. The commands assume you are connected as a PostgreSQL superuser or an administrator with the required privileges.

## 1. Understand how PostgreSQL permissions work

A PostgreSQL role is created at the **cluster level**, so the same login role can connect to multiple databases in that PostgreSQL instance. However, permissions to connect to a database, use a schema, and read tables must be granted separately in each database.

For a read-only application account, the essential permissions are:

- `CONNECT` on the target database.
- `USAGE` on each schema the application must inspect or query.
- `SELECT` on the existing tables and views it must read.

Do not grant `INSERT`, `UPDATE`, `DELETE`, `TRUNCATE`, `CREATE`, or ownership privileges to this role.

## 2. Connect as an administrator

From PowerShell, connect to the target database using an administrative account:

```powershell
psql -h localhost -p 5432 -U postgres -d supergen
```

Change `postgres`, the host, port, or database name as required. The `-d` option is important: without it, `psql` normally tries to connect to a database with the same name as the login role.

You can create the login role while connected to any database in the same PostgreSQL cluster.

## 3. Create the read-only login role

Run this once per PostgreSQL cluster:

```sql
CREATE ROLE pgmind_readonly
    WITH LOGIN
    NOSUPERUSER
    NOCREATEDB
    NOCREATEROLE
    NOREPLICATION
    NOBYPASSRLS;
```

Set its password using the `psql` password command:

```psql
\password pgmind_readonly
```

Enter the password when prompted. This avoids putting the plaintext password directly into a SQL command or shell history.

### If the role already exists

Do not run `CREATE ROLE` again. Instead, ensure it has the intended login attributes and reset its password if needed:

```sql
ALTER ROLE pgmind_readonly
    WITH LOGIN
    NOSUPERUSER
    NOCREATEDB
    NOCREATEROLE
    NOREPLICATION
    NOBYPASSRLS;
```

Then run:

```psql
\password pgmind_readonly
```

## 4. Grant access to the target database and schema

Make sure your `psql` session is connected to the target database:

```psql
\connect supergen
```

Grant the role permission to connect to the database, use the `public` schema, and select from existing tables and views:

```sql
GRANT CONNECT ON DATABASE supergen TO pgmind_readonly;

GRANT USAGE ON SCHEMA public TO pgmind_readonly;

GRANT SELECT ON ALL TABLES IN SCHEMA public TO pgmind_readonly;
```

These grants apply to the `supergen` database and its `public` schema. They do not automatically grant access to other databases or schemas.

### Grant access to additional schemas

If the application needs to inspect or query another schema, grant access to that schema too. For example, for a schema named `sales`:

```sql
GRANT USAGE ON SCHEMA sales TO pgmind_readonly;
GRANT SELECT ON ALL TABLES IN SCHEMA sales TO pgmind_readonly;
```

Repeat this for every application schema the account should access. Grant only the schemas that the application actually needs.

## 5. Grant access to tables created in the future

The `GRANT SELECT ON ALL TABLES` command only covers objects that already exist. To grant `SELECT` on future tables and views, configure default privileges for the role that creates those objects.

First, identify the owner of the existing application tables. For example:

```sql
SELECT
    n.nspname AS schema_name,
    c.relname AS object_name,
    pg_get_userbyid(c.relowner) AS object_owner,
    c.relkind AS object_type
FROM pg_catalog.pg_class AS c
JOIN pg_catalog.pg_namespace AS n
    ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
ORDER BY object_owner, object_name;
```

Replace `actual_table_owner` below with the role that creates the tables or runs migrations. For example, if the owner is `supergen_owner`:

```sql
ALTER DEFAULT PRIVILEGES FOR ROLE supergen_owner
IN SCHEMA public
GRANT SELECT ON TABLES TO pgmind_readonly;
```

For another schema, specify that schema:

```sql
ALTER DEFAULT PRIVILEGES FOR ROLE supergen_owner
IN SCHEMA sales
GRANT SELECT ON TABLES TO pgmind_readonly;
```

**Important:** Default privileges are specific to the role that creates the objects. If migrations or application code create tables under multiple owner roles, configure default privileges for each owner. A superuser can configure these defaults; otherwise, run the command as the relevant object-creating role or a role permitted to act for it.

Default privileges do not automatically grant `USAGE` on a schema that is created in the future. When a new schema is created, grant `USAGE` on it to `pgmind_readonly` as well.

## 6. Optional: Set read-only transactions by default

You can make new transactions default to read-only for this role in this database:

```sql
ALTER ROLE pgmind_readonly
    IN DATABASE supergen
    SET default_transaction_read_only = on;
```

This is an additional safety default, not a replacement for database privileges. A session setting is not a complete security boundary. The actual restriction must come from not granting write privileges and from keeping the role separate from privileged roles.

## 7. Verify the read-only account

Exit the administrator session:

```psql
\q
```

Connect as the new read-only role. Always specify the target database with `-d`:

```powershell
psql -h localhost -p 5432 -U pgmind_readonly -d supergen
```

Check the connection identity:

```sql
SELECT current_database() AS database_name,
       current_user AS login_role;
```

Expected values:

- `database_name`: `supergen`
- `login_role`: `pgmind_readonly`

Check which tables and views are visible to the account:

```sql
SELECT table_schema, table_name, table_type
FROM information_schema.tables
WHERE table_schema NOT IN ('information_schema', 'pg_catalog')
ORDER BY table_schema, table_name;
```

Check effective privileges on a known table (replace `products` if necessary):

```sql
SELECT
    has_database_privilege(current_user, current_database(), 'CONNECT') AS can_connect,
    has_schema_privilege(current_user, 'public', 'USAGE') AS can_use_public_schema,
    has_table_privilege(current_user, 'public.products', 'SELECT') AS can_select_products;
```

If `public.products` does not exist, use a table that does exist. The table privilege check should return `true` for a table the role is meant to read.

### Verify that writes are denied

The following test runs inside a transaction and always rolls back. It will not leave a table behind:

```sql
BEGIN;

CREATE TABLE public.readonly_permission_test (
    id integer
);

ROLLBACK;
```

Expected result: `CREATE TABLE` fails with a permission error because the role does not have `CREATE` on the schema. After the error, run `ROLLBACK;` if `psql` has not already processed it. If the `CREATE TABLE` unexpectedly succeeds, the `ROLLBACK` removes the test table; review the role's grants before using it.

## 8. Configure the application connection

For PGMind, set `QUERY_DATABASE_URL` to the read-only account and the intended database:

```dotenv
QUERY_DATABASE_URL=postgresql://pgmind_readonly:YOUR_PASSWORD@localhost:5432/supergen
```

Use the correct host and port for your PostgreSQL server. If the password contains URL-reserved characters (for example `@`, `:`, `/`, `?`, `#`, or `%`), URL-encode the password in the connection string.

Keep administrative or write-capable credentials separate. PGMind's query-execution connection should use `QUERY_DATABASE_URL`, not an owner or administrator account.

After changing `.env`, restart the PGMind MCP server and the OpenCode session that launched it. An already-running process and connection pool will continue using the connection settings it loaded at startup.

## 9. Troubleshooting

### `FATAL: database "pgmind_readonly" does not exist`

The `psql` command omitted `-d`, so it tried to connect to a database named after the user. Specify the database explicitly:

```powershell
psql -h localhost -p 5432 -U pgmind_readonly -d supergen
```

### The application reports that no tables exist

Check each of the following:

1. Confirm the application is connected to the intended host, port, and database:

   ```sql
   SELECT current_database(), current_user, inet_server_addr(), inet_server_port();
   ```

2. Connect as an administrator to that same database and check whether the tables actually exist:

   ```sql
   SELECT schemaname, tablename, tableowner
   FROM pg_catalog.pg_tables
   WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
   ORDER BY schemaname, tablename;
   ```

3. If tables exist in a schema other than `public`, grant `USAGE` on that schema and `SELECT` on its tables.
4. If tables exist but are not visible to the read-only account, repeat the schema and table grants while connected to the correct database.
5. Confirm the application's `.env` has the updated `QUERY_DATABASE_URL`, then restart the MCP server and OpenCode.

### Existing tables are visible, but newly created tables are not

Check which role owns the new tables. Configure `ALTER DEFAULT PRIVILEGES` for that exact object-creating role and schema. Default privileges configured for one owner do not cover objects created by a different owner.

### The database contains multiple application schemas

Grant `USAGE` and `SELECT` on each required schema. Do not assume granting access to `public` grants access to every schema in the database.

## 10. Security notes

- Use a dedicated login role for the application. Do not use a database owner, superuser, or administrator account for query execution.
- Grant only the database, schemas, and tables the application needs to inspect.
- Do not grant table ownership, schema `CREATE`, or data-modification privileges to the read-only role.
- PostgreSQL permissions are one security layer. Applications that accept generated SQL should also validate statements, enforce timeouts and result limits, and handle database errors safely.
- A read-only role is not a complete sandbox for every SQL function or external side effect. Keep application-level SQL validation and function restrictions in place as additional safeguards.
- If the database uses row-level security (RLS), the rows visible to this role may be further restricted by the applicable policies.

---

## Quick reference

For an existing `public` schema in database `supergen`, the core grants are:

```sql
GRANT CONNECT ON DATABASE supergen TO pgmind_readonly;
GRANT USAGE ON SCHEMA public TO pgmind_readonly;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO pgmind_readonly;

-- Replace supergen_owner with the role that creates future tables.
ALTER DEFAULT PRIVILEGES FOR ROLE supergen_owner
IN SCHEMA public
GRANT SELECT ON TABLES TO pgmind_readonly;
```

The default-privileges command is important for future tables; the first three grants cover the current database, schema, and existing tables.
