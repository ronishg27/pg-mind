import { DatabaseService } from '../database/database.service.js';

import type {
    DatabaseSchema,
    SchemaMetadata,
    TableMetadata,
    ColumnMetadata,
    ConstraintMetadata,
    IndexMetadata,
    ViewMetadata,
    MaterializedViewMetadata,
    SequenceMetadata,
    FunctionMetadata,
    FunctionArgumentMetadata,
    ViewColumnMetadata,
    IndexColumnMetadata,
} from './schema.types.js';

interface SchemaRow {
    schema_name: string;
}

interface TableRow {
    table_schema: string;
    table_name: string;
    table_type: 'BASE TABLE' | 'VIEW' | 'MATERIALIZED VIEW' | 'FOREIGN TABLE';
}

interface ColumnRow {
    table_schema: string;
    table_name: string;
    table_type: 'BASE TABLE' | 'VIEW' | 'MATERIALIZED VIEW' | 'FOREIGN TABLE';
    column_name: string;
    data_type: string;
    is_nullable: boolean;
    column_default: string | null;
    ordinal_position: number;
    is_identity: boolean;
    identity_generation: 'ALWAYS' | 'BY DEFAULT' | null;
    is_generated: string | null;
    generation_expression: string | null;
    col_description: string | null;
}

interface ConstraintRow {
    constraint_name: string;
    table_schema: string;
    table_name: string;
    constraint_type: 'PRIMARY KEY' | 'FOREIGN KEY' | 'UNIQUE' | 'CHECK' | 'EXCLUSION';
    column_name: string;
    ordinal_position: number;
    referenced_table_schema: string | null;
    referenced_table_name: string | null;
    referenced_column_name: string | null;
    check_clause: string | null;
    exclusion_clause: string | null;
    is_deferrable: boolean;
    initially_deferred: boolean;
}

interface IndexRow {
    index_schema: string;
    index_name: string;
    table_schema: string;
    table_name: string;
    is_unique: boolean;
    is_primary: boolean;
    method: string;
    column_name: string;
    ordinal_position: number;
    sort_direction: 'ASC' | 'DESC' | 'DEFAULT';
    nulls_order: 'FIRST' | 'LAST' | 'DEFAULT';
    where_clause: string | null;
    definition: string;
}

interface ViewRow {
    table_schema: string;
    table_name: string;
    view_definition: string | null;
    column_name: string;
    data_type: string;
    ordinal_position: number;
}

interface MatViewRow {
    table_schema: string;
    table_name: string;
    definition: string | null;
    is_populated: boolean;
    column_name: string;
    data_type: string;
    ordinal_position: number;
}

interface SequenceRow {
    sequence_schema: string;
    sequence_name: string;
    data_type: string;
    start_value: string;
    minimum_value: string;
    maximum_value: string;
    increment: string;
    cycle_option: boolean;
    cache_size: number;
}

interface FunctionRow {
    schema_name: string;
    function_name: string;
    language: string;
    return_type: string;
    volatility: 'VOLATILE' | 'STABLE' | 'IMMUTABLE';
    is_strict: boolean;
    is_security_definer: boolean;
    definition: string | null;
    argument_name: string;
    argument_data_type: string;
    argument_mode: 'IN' | 'OUT' | 'INOUT' | 'VARIADIC';
    arguments_full: string | null;
}

export class SchemaService {
    constructor(private readonly database: DatabaseService) {}

    async getDatabaseSchema(options?: {
        schemaNames?: string[];
        tableNames?: string[];
        includeViews?: boolean;
        includeMaterializedViews?: boolean;
        includeSequences?: boolean;
        includeFunctions?: boolean;
        includeIndexes?: boolean;
        includeConstraints?: boolean;
    }): Promise<DatabaseSchema> {
        const {
            schemaNames,
            tableNames,
            includeViews = true,
            includeMaterializedViews = true,
            includeSequences = true,
            includeFunctions = true,
            includeIndexes = true,
            includeConstraints = true,
        } = options || {};

        const schemaFilter = schemaNames?.length
            ? `AND n.nspname IN (${schemaNames.map((_, i) => `$${i + 1}`).join(',')})`
            : `AND n.nspname NOT IN ('information_schema', 'pg_catalog') AND n.nspname NOT LIKE 'pg_toast%'`;

        const tableFilter = tableNames?.length
            ? `AND c.relname IN (${tableNames.map((_, i) => `$${(schemaNames?.length || 0) + i + 1}`).join(',')})`
            : '';

        const indexTableFilter = tableNames?.length
            ? `AND tc.relname IN (${tableNames.map((_, i) => `$${(schemaNames?.length || 0) + i + 1}`).join(',')})`
            : '';

        // Build parameter arrays
        const params: (string | number)[] = [];
        if (schemaNames) params.push(...schemaNames);
        if (tableNames) params.push(...tableNames);

        // Batch query 1: All tables, views, materialized views with columns
        const tablesQuery = `
            SELECT
                n.nspname AS table_schema,
                c.relname AS table_name,
                CASE c.relkind
                    WHEN 'r' THEN 'BASE TABLE'
                    WHEN 'v' THEN 'VIEW'
                    WHEN 'm' THEN 'MATERIALIZED VIEW'
                    WHEN 'f' THEN 'FOREIGN TABLE'
                END AS table_type,
                a.attname AS column_name,
                pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type,
                a.attnotnull = false AS is_nullable,
                pg_catalog.pg_get_expr(ad.adbin, ad.adrelid) AS column_default,
                a.attnum AS ordinal_position,
                a.attidentity <> '' AS is_identity,
                a.attidentity AS identity_generation,
                CASE WHEN a.attgenerated = '' THEN NULL ELSE a.attgenerated END AS is_generated,
                pg_catalog.pg_get_expr(ad.adbin, ad.adrelid) AS generation_expression,
                pg_catalog.col_description(a.attrelid, a.attnum) AS col_description
            FROM pg_catalog.pg_class c
            JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
            JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid
            LEFT JOIN pg_catalog.pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
            WHERE n.nspname NOT IN ('information_schema', 'pg_catalog')
                AND n.nspname NOT LIKE 'pg_toast%'
                AND c.relkind IN ('r', 'v', 'm', 'f')
                AND a.attnum > 0
                AND NOT a.attisdropped
                ${schemaFilter}
                ${tableFilter}
            ORDER BY n.nspname, c.relname, a.attnum
        `;

        // Batch query 2: All constraints (PK, FK, UNIQUE, CHECK, EXCLUSION)
        const constraintsQuery = includeConstraints
            ? `
            SELECT
                con.conname AS constraint_name,
                n.nspname AS table_schema,
                c.relname AS table_name,
                CASE con.contype
                    WHEN 'p' THEN 'PRIMARY KEY'
                    WHEN 'f' THEN 'FOREIGN KEY'
                    WHEN 'u' THEN 'UNIQUE'
                    WHEN 'c' THEN 'CHECK'
                    WHEN 'x' THEN 'EXCLUSION'
                END AS constraint_type,
                a.attname AS column_name,
                k.ordinality AS ordinal_position,
                ref_ns.nspname AS referenced_table_schema,
                ref_c.relname AS referenced_table_name,
                ref_a.attname AS referenced_column_name,
                pg_catalog.pg_get_constraintdef(con.oid) AS check_clause,
                pg_catalog.pg_get_constraintdef(con.oid) AS exclusion_clause,
                con.condeferrable AS is_deferrable,
                con.condeferred AS initially_deferred
            FROM pg_catalog.pg_constraint con
            JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
            JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
            JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS k(attnum, ordinality) ON true
            JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
            LEFT JOIN pg_catalog.pg_class ref_c ON ref_c.oid = con.confrelid
            LEFT JOIN pg_catalog.pg_namespace ref_ns ON ref_ns.oid = ref_c.relnamespace
            LEFT JOIN LATERAL (
                SELECT ref_a.attname
                FROM pg_catalog.pg_attribute ref_a
                WHERE ref_a.attrelid = ref_c.oid
                  AND ref_a.attnum = con.confkey[k.ordinality]
            ) ref_a ON con.contype = 'f'
            WHERE n.nspname NOT IN ('information_schema', 'pg_catalog')
                AND n.nspname NOT LIKE 'pg_toast%'
                AND con.contype IN ('p', 'f', 'u', 'c', 'x')
                ${schemaFilter}
                ${tableFilter}
            ORDER BY n.nspname, c.relname, con.conname, k.ordinality
        `
            : '';

        // Batch query 3: All indexes
        const indexesQuery = includeIndexes
            ? `
            SELECT
                n.nspname AS index_schema,
                i.relname AS index_name,
                tn.nspname AS table_schema,
                tc.relname AS table_name,
                ind.indisunique AS is_unique,
                ind.indisprimary AS is_primary,
                am.amname AS method,
                a.attname AS column_name,
                generate_subscripts(ind.indkey, 1) AS ordinal_position,
                CASE
                    WHEN (ind.indoption[generate_subscripts(ind.indkey, 1) - 1] & 1) = 1 THEN 'DESC'
                    ELSE 'ASC'
                END AS sort_direction,
                CASE
                    WHEN (ind.indoption[generate_subscripts(ind.indkey, 1) - 1] & 2) = 2 THEN 'FIRST'
                    ELSE 'LAST'
                END AS nulls_order,
                pg_catalog.pg_get_expr(ind.indpred, tc.oid) AS where_clause,
                pg_catalog.pg_get_indexdef(i.oid) AS definition
            FROM pg_catalog.pg_index ind
            JOIN pg_catalog.pg_class i ON i.oid = ind.indexrelid
            JOIN pg_catalog.pg_namespace n ON n.oid = i.relnamespace
            JOIN pg_catalog.pg_class tc ON tc.oid = ind.indrelid
            JOIN pg_catalog.pg_namespace tn ON tn.oid = tc.relnamespace
            JOIN pg_catalog.pg_am am ON am.oid = i.relam
            JOIN pg_catalog.pg_attribute a ON a.attrelid = tc.oid AND a.attnum = ind.indkey[generate_subscripts(ind.indkey, 1)]
            WHERE tn.nspname NOT IN ('information_schema', 'pg_catalog')
                AND tn.nspname NOT LIKE 'pg_toast%'
                ${schemaFilter}
                ${indexTableFilter}
            ORDER BY tn.nspname, tc.relname, i.relname, ordinal_position
        `
            : '';

        // Batch query 4: Views
        const viewsQuery = includeViews
            ? `
            SELECT
                n.nspname AS table_schema,
                c.relname AS table_name,
                pg_catalog.pg_get_viewdef(c.oid, true) AS view_definition,
                a.attname AS column_name,
                pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type,
                a.attnum AS ordinal_position
            FROM pg_catalog.pg_class c
            JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
            JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid
            WHERE c.relkind = 'v'
                AND n.nspname NOT IN ('information_schema', 'pg_catalog')
                AND n.nspname NOT LIKE 'pg_toast%'
                AND a.attnum > 0
                AND NOT a.attisdropped
                ${schemaFilter}
                ${tableFilter}
            ORDER BY n.nspname, c.relname, a.attnum
        `
            : '';

        // Batch query 5: Materialized views
        const matViewsQuery = includeMaterializedViews
            ? `
            SELECT
                n.nspname AS table_schema,
                c.relname AS table_name,
                pg_catalog.pg_get_viewdef(c.oid, true) AS definition,
                c.relispopulated AS is_populated,
                a.attname AS column_name,
                pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type,
                a.attnum AS ordinal_position
            FROM pg_catalog.pg_class c
            JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
            JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid
            WHERE c.relkind = 'm'
                AND n.nspname NOT IN ('information_schema', 'pg_catalog')
                AND n.nspname NOT LIKE 'pg_toast%'
                AND a.attnum > 0
                AND NOT a.attisdropped
                ${schemaFilter}
                ${tableFilter}
            ORDER BY n.nspname, c.relname, a.attnum
        `
            : '';

        // Batch query 6: Sequences
        const sequencesQuery = includeSequences
            ? `
            SELECT
                n.nspname AS sequence_schema,
                c.relname AS sequence_name,
                pg_catalog.format_type(seq.seqtypid, NULL) AS data_type,
                seq.seqstart::text AS start_value,
                seq.seqmin::text AS minimum_value,
                seq.seqmax::text AS maximum_value,
                seq.seqincrement::text AS increment,
                seq.seqcycle AS cycle_option,
                seq.seqcache AS cache_size
            FROM pg_catalog.pg_class c
            JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
            JOIN pg_catalog.pg_sequence seq ON seq.seqrelid = c.oid
            WHERE c.relkind = 'S'
                AND n.nspname NOT IN ('information_schema', 'pg_catalog')
                AND n.nspname NOT LIKE 'pg_toast%'
                ${schemaFilter}
            ORDER BY n.nspname, c.relname
        `
            : '';

        // Batch query 7: Functions
        const functionsQuery = includeFunctions
            ? `
            SELECT
                n.nspname AS schema_name,
                p.proname AS function_name,
                l.lanname AS language,
                pg_catalog.format_type(p.prorettype, NULL) AS return_type,
                p.provolatile AS volatility,
                p.proisstrict AS is_strict,
                p.prosecdef AS is_security_definer,
                pg_catalog.pg_get_functiondef(p.oid) AS definition,
                unnest(p.proargnames) AS argument_name,
                unnest(p.proargtypes)::regtype AS argument_data_type,
                unnest(p.proargmodes) AS argument_mode,
                pg_catalog.pg_get_function_arguments(p.oid) AS arguments_full
            FROM pg_catalog.pg_proc p
            JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
            JOIN pg_catalog.pg_language l ON l.oid = p.prolang
            WHERE n.nspname NOT IN ('information_schema', 'pg_catalog')
                AND n.nspname NOT LIKE 'pg_toast%'
                AND p.prokind = 'f'
                ${schemaFilter}
            ORDER BY n.nspname, p.proname
        `
            : '';

        // Execute all queries in parallel
        const [
            tablesResult,
            constraintsResult,
            indexesResult,
            viewsResult,
            matViewsResult,
            sequencesResult,
            functionsResult,
        ] = await Promise.all([
            this.database.query<ColumnRow>(tablesQuery, params),
            includeConstraints
                ? this.database.query<ConstraintRow>(constraintsQuery, params)
                : Promise.resolve([]),
            includeIndexes
                ? this.database.query<IndexRow>(indexesQuery, params)
                : Promise.resolve([]),
            includeViews ? this.database.query<ViewRow>(viewsQuery, params) : Promise.resolve([]),
            includeMaterializedViews
                ? this.database.query<MatViewRow>(matViewsQuery, params)
                : Promise.resolve([]),
            includeSequences
                ? this.database.query<SequenceRow>(sequencesQuery, params)
                : Promise.resolve([]),
            includeFunctions
                ? this.database.query<FunctionRow>(functionsQuery, params)
                : Promise.resolve([]),
        ]);

        // Group results by schema
        const schemaMap = new Map<string, SchemaMetadata>();

        // Process tables and columns
        for (const row of tablesResult) {
            let schema = schemaMap.get(row.table_schema);
            if (!schema) {
                schema = {
                    name: row.table_schema,
                    tables: [],
                    views: [],
                    materializedViews: [],
                    sequences: [],
                    functions: [],
                };
                schemaMap.set(row.table_schema, schema);
            }

            let table = schema.tables.find((t) => t.name === row.table_name);
            if (!table) {
                table = {
                    name: row.table_name,
                    type: row.table_type,
                    columns: [],
                    constraints: [],
                    indexes: [],
                };
                schema.tables.push(table);
            }

            table.columns.push({
                name: row.column_name,
                dataType: row.data_type,
                nullable: row.is_nullable,
                defaultValue: row.column_default,
                position: row.ordinal_position,
                isIdentity: row.is_identity,
                identityGeneration: row.identity_generation,
                isGenerated: !!row.is_generated,
                generationExpression: row.generation_expression,
                comment: row.col_description,
            });
        }

        // Process constraints
        if (includeConstraints) {
            for (const row of constraintsResult) {
                const schema = schemaMap.get(row.table_schema);
                if (!schema) continue;

                const table = schema.tables.find((t) => t.name === row.table_name);
                if (!table) continue;

                // Check if constraint already exists (for multi-column constraints)
                let constraint = table.constraints.find((c) => c.name === row.constraint_name);
                if (!constraint) {
                    constraint = {
                        name: row.constraint_name,
                        type: row.constraint_type,
                        columns: [],
                        referencedSchema: row.referenced_table_schema,
                        referencedTable: row.referenced_table_name,
                        referencedColumns: [],
                        checkClause: row.check_clause,
                        exclusionClause: row.exclusion_clause,
                        isDeferrable: row.is_deferrable,
                        initiallyDeferred: row.initially_deferred,
                    };
                    table.constraints.push(constraint);
                }

                constraint.columns.push(row.column_name);
                if (row.referenced_column_name) {
                    constraint.referencedColumns!.push(row.referenced_column_name);
                }
            }
        }

        // Process indexes
        if (includeIndexes) {
            const indexMap = new Map<string, IndexMetadata>();

            for (const row of indexesResult) {
                const key = `${row.index_schema}.${row.index_name}`;
                let index = indexMap.get(key);

                if (!index) {
                    index = {
                        name: row.index_name,
                        schema: row.index_schema,
                        tableName: row.table_name,
                        isUnique: row.is_unique,
                        isPrimary: row.is_primary,
                        method: row.method,
                        columns: [],
                        whereClause: row.where_clause,
                        definition: row.definition,
                    };
                    indexMap.set(key, index);
                }

                index.columns.push({
                    name: row.column_name,
                    ordinalPosition: row.ordinal_position,
                    sortDirection: row.sort_direction,
                    nullsOrder: row.nulls_order,
                });

                // Attach to table
                const schema = schemaMap.get(row.table_schema);
                if (schema) {
                    const table = schema.tables.find((t) => t.name === row.table_name);
                    if (table && !table.indexes.some((i) => i.name === row.index_name)) {
                        table.indexes.push(index);
                    }
                }
            }
        }

        // Process views
        if (includeViews) {
            const viewMap = new Map<string, ViewMetadata>();

            for (const row of viewsResult) {
                const key = `${row.table_schema}.${row.table_name}`;
                let view = viewMap.get(key);

                if (!view) {
                    view = {
                        name: row.table_name,
                        definition: row.view_definition,
                        columns: [],
                    };
                    viewMap.set(key, view);
                }

                view.columns.push({
                    name: row.column_name,
                    dataType: row.data_type,
                });

                const schema = schemaMap.get(row.table_schema);
                if (schema && !schema.views.some((v) => v.name === row.table_name)) {
                    schema.views.push(view);
                }
            }
        }

        // Process materialized views
        if (includeMaterializedViews) {
            const matViewMap = new Map<string, MaterializedViewMetadata>();

            for (const row of matViewsResult) {
                const key = `${row.table_schema}.${row.table_name}`;
                let matView = matViewMap.get(key);

                if (!matView) {
                    matView = {
                        name: row.table_name,
                        definition: row.definition,
                        columns: [],
                        isPopulated: row.is_populated,
                    };
                    matViewMap.set(key, matView);
                }

                matView.columns.push({
                    name: row.column_name,
                    dataType: row.data_type,
                });

                const schema = schemaMap.get(row.table_schema);
                if (schema && !schema.materializedViews.some((v) => v.name === row.table_name)) {
                    schema.materializedViews.push(matView);
                }
            }
        }

        // Process sequences
        if (includeSequences) {
            for (const row of sequencesResult) {
                const schema = schemaMap.get(row.sequence_schema);
                if (!schema) continue;

                schema.sequences.push({
                    name: row.sequence_name,
                    dataType: row.data_type,
                    startValue: row.start_value,
                    minValue: row.minimum_value,
                    maxValue: row.maximum_value,
                    increment: row.increment,
                    cycle: row.cycle_option,
                    cache: row.cache_size,
                });
            }
        }

        // Process functions
        if (includeFunctions) {
            const functionMap = new Map<string, FunctionMetadata>();

            for (const row of functionsResult) {
                const key = `${row.schema_name}.${row.function_name}`;
                let func = functionMap.get(key);

                if (!func) {
                    func = {
                        name: row.function_name,
                        schema: row.schema_name,
                        language: row.language,
                        returnType: row.return_type,
                        arguments: [],
                        volatility: row.volatility,
                        isStrict: row.is_strict,
                        isSecurityDefiner: row.is_security_definer,
                        definition: row.definition,
                    };
                    functionMap.set(key, func);
                }

                func.arguments.push({
                    name: row.argument_name,
                    dataType: row.argument_data_type,
                    mode: row.argument_mode || 'IN',
                    defaultExpression: null, // pg_get_function_arguments would need separate parsing
                    ordinalPosition: func.arguments.length + 1,
                });

                const schema = schemaMap.get(row.schema_name);
                if (schema && !schema.functions.some((f) => f.name === row.function_name)) {
                    schema.functions.push(func);
                }
            }
        }

        // Sort and return
        const sortedSchemas = Array.from(schemaMap.values()).sort((a, b) =>
            a.name.localeCompare(b.name)
        );

        for (const schema of sortedSchemas) {
            schema.tables.sort((a, b) => a.name.localeCompare(b.name));
            schema.views.sort((a, b) => a.name.localeCompare(b.name));
            schema.materializedViews.sort((a, b) => a.name.localeCompare(b.name));
            schema.sequences.sort((a, b) => a.name.localeCompare(b.name));
            schema.functions.sort((a, b) => a.name.localeCompare(b.name));

            for (const table of schema.tables) {
                table.columns.sort((a, b) => a.position - b.position);
                table.constraints.sort((a, b) => a.name.localeCompare(b.name));
                table.indexes.sort((a, b) => a.name.localeCompare(b.name));

                for (const constraint of table.constraints) {
                    // Do NOT sort - preserve ordinal order from query (critical for composite FKs)
                }

                for (const index of table.indexes) {
                    index.columns.sort((a, b) => a.ordinalPosition - b.ordinalPosition);
                }
            }
        }

        return { schemas: sortedSchemas };
    }

    // Convenience methods for filtered introspection
    async getSchema(schemaName: string): Promise<SchemaMetadata | null> {
        const result = await this.getDatabaseSchema({ schemaNames: [schemaName] });
        return result.schemas[0] || null;
    }

    async getTable(schemaName: string, tableName: string): Promise<TableMetadata | null> {
        const result = await this.getDatabaseSchema({
            schemaNames: [schemaName],
            tableNames: [tableName],
        });
        return result.schemas[0]?.tables[0] || null;
    }

    async listSchemas(): Promise<string[]> {
        const sql = `
            SELECT schema_name
            FROM information_schema.schemata
            WHERE schema_name NOT IN ('information_schema', 'pg_catalog')
            AND schema_name NOT LIKE 'pg_toast%'
            ORDER BY schema_name
        `;
        const rows = await this.database.query<{ schema_name: string }>(sql);
        return rows.map((r) => r.schema_name);
    }
}
