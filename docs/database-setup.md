# YAML Configuration and PostgreSQL Setup

PG-mind is configured through **YAML**, not environment variables.

## Configuration file

- `pg-mind.config.yaml` — local configuration file (gitignored, contains credentials). Do not commit it with real credentials.
- `pg-mind.config.example.yaml` — example configuration template. Copy this to `pg-mind.config.yaml` and fill in your values.

The server loads `pg-mind.config.yaml` at startup via `src/config/index.ts` (`loadConfiguration`) and validates it with Zod. It can be reloaded at runtime without restarting the server using the `reload_configuration` MCP tool.

### Configuration structure

```yaml
database:
  # Default connection to use (must match one of the connection names below)
  default: local_dev

  # Named database connections
  # Each connection must have a unique name
  connections:
    local_dev:
      host: localhost
      port: 5433
      database: pgmind_dev
      username: pgmind
      password: "your_password_here"
      ssl: false

    # staging:
    #   host: staging.example.com
    #   port: 5432
    #   database: pgmind_staging
    #   username: developer
    #   password: "another_password_here"
    #   ssl: true

  # Connection pool settings (shared across all connections)
  # max: maximum connections per pool (each database has 2 pools: read and write)
  # maxTotal: maximum total connections across all pools for all databases
  pool:
    max: 10                       # Maximum connections per pool
    maxTotal: 100                 # Maximum total connections across all databases
    idleTimeoutMillis: 30000      # Close idle connections after 30 seconds
    connectionTimeoutMillis: 5000 # Wait up to 5 seconds for a connection

  # Optional: Verify connection host/port (useful for preventing misconfiguration)
  # expectedHost: localhost
  # expectedPort: 5433

  # Transaction timeouts (milliseconds)
  statementTimeoutMs: 10000        # 10 seconds
  lockTimeoutMs: 5000              # 5 seconds
  idleInTransactionTimeoutMs: 30000  # 30 seconds

  # Application name for PostgreSQL connection identification
  applicationName: pgmind
```

### Multi-connection behavior

- **Multiple named connections** are supported (up to 20).
- A **default connection** is configured via `database.default` and is used when no `connectionName` is supplied.
- Connections can be **switched at runtime** via the `switch_database` MCP tool. Switching changes the process-wide active connection; pools are not closed or recreated.
- Read tools accept an optional `connectionName` parameter to target a specific configured connection **without** changing the active connection.
- Prepared operations (`prepare_operation`) retain the connection they were prepared against; `execute_approved_operation` always executes against the original connection, never the currently active one.
- Read and write pools use the **same configured credentials** for each connection. PG-mind does not create separate read-only and writer database roles; PostgreSQL permissions are the primary security boundary.

### Configuration reload

`reload_configuration` reads and validates the entire YAML file from disk before applying changes:

- **Added** connections: created and validated before registration.
- **Modified** connections: replacement pools are initialized and validated before replacing the existing service; the previous working connection is preserved if replacement fails.
- **Removed** connections: unregistered and their pools shut down.
- **Unchanged** connections: existing `DatabaseService` instances and pools are reused.
- The active connection is preserved if it still exists; otherwise it falls back to the configured default, reported via `activeConnectionChanged`.

Existing approvals retain their original connection identity. If a connection is replaced or removed, existing approvals against it fail safely at execution rather than being redirected.

See `docs/architecture.md` for the full reload behavior and `docs/approval-workflow.md` for how approvals interact with reloads.

## PostgreSQL setup

PG-mind connects to PostgreSQL using the credentials in `pg-mind.config.yaml`. There is no application-enforced separation of read-only and writer roles — both pools use the same credentials. Database-level permissions are the primary security boundary; grant the connecting role only the privileges it needs.

### Minimal role setup

Run as a PostgreSQL superuser or administrator:

```sql
-- 1. Create the login role (once per cluster)
CREATE ROLE pgmind
    WITH LOGIN
    NOSUPERUSER
    NOCREATEDB
    NOCREATEROLE
    NOREPLICATION
    NOBYPASSRLS;

\password pgmind
```

Then, connected to the target database:

```sql
-- 2. Grant database and schema access
GRANT CONNECT ON DATABASE pgmind_dev TO pgmind;
GRANT USAGE ON SCHEMA public TO pgmind;

-- 3. Grant table access (SELECT for reads; INSERT/UPDATE/DELETE for writes)
GRANT SELECT ON ALL TABLES IN SCHEMA public TO pgmind;
GRANT INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO pgmind;

-- 4. Sequence permissions (needed for SERIAL/IDENTITY columns when RETURNING is used)
GRANT USAGE, UPDATE ON ALL SEQUENCES IN SCHEMA public TO pgmind;
```

### DDL privileges

If you intend to use allowlisted DDL operations (CREATE, ALTER, DROP, TRUNCATE) through the approval workflow, grant the corresponding privileges explicitly:

- `CREATE TABLE` requires `CREATE` privilege on the target schema.
- `ALTER` and `DROP` operations generally depend on ownership of the affected object.
- `TRUNCATE` requires the appropriate privilege or ownership.
- `CREATE SCHEMA` requires `CREATE` privilege on the database.

PostgreSQL does not provide generic `ALTER` or `DROP` privileges that can be granted independently; object ownership is the controlling factor for most ALTER and DROP operations.

Do **not** grant superuser or database-owner privileges merely to make write operations work. Add privileges only when the corresponding allowlisted DDL operation is intentionally required.

### Connection identity verification

Optionally, configure `expectedHost` and `expectedPort` in the YAML to bind each connection to a specific host and port. At startup, PG-mind verifies `current_database()`, `current_user`, and (when configured) host/port against the expected values for each connection pool. A mismatch prevents the connection from being registered.

### Verification

Connect as the configured role and check identity:

```sql
SELECT current_database() AS database_name,
       current_user AS login_role;
```

### Relationship to other docs

- `docs/security.md` — security model, boundaries, and limitations.
- `docs/architecture.md` — execution flows and connection-pool details.
- `docs/approval-workflow.md` — approval lifecycle and connection-aware guarantees.
