import { DatabaseService } from "../database/database.service.js";

import type {
    DatabaseSchema,
    SchemaMetadata,
    TableMetadata,
    ColumnMetadata,
    KeyConstraintMetadata,
} from "./schema.types.js";

interface SchemaInfo {
    schema_name: string;
}

interface DatabaseObject {
    table_schema: string;
    table_name: string;
    table_type: "BASE TABLE" | "VIEW" | "FOREIGN TABLE";
}

interface ColumnInfo {
    column_name: string;
    data_type: string;
    is_nullable: "YES" | "NO";
    column_default: string | null;
    ordinal_position: number;
}

interface KeyConstraint {
    constraint_name: string;
    table_schema: string;
    table_name: string;
    column_name: string;
    constraint_type: "PRIMARY KEY" | "FOREIGN KEY";
    foreign_table_schema: string | null;
    foreign_table_name: string | null;
    foreign_column_name: string | null;
}

export class SchemaService {
    constructor(private readonly database: DatabaseService) {}

    async listSchemas(): Promise<SchemaInfo[]> {
        const sql = `
        SELECT schema_name
        FROM information_schema.schemata
        WHERE schema_name NOT IN ('information_schema', 'pg_catalog')
        AND schema_name NOT LIKE 'pg_toast%'
        ORDER BY schema_name
        `;
        return this.database.query<SchemaInfo>(sql);
    }

    async listTables(schemaName: string): Promise<DatabaseObject[]> {
        const sql = `
          SELECT table_schema, table_name, table_type
          FROM information_schema.tables
          WHERE table_schema = $1
          ORDER BY table_name
        `;
        return this.database.query<DatabaseObject>(sql, [schemaName]);
    }

    async getTableColumns(
        schemaName: string,
        tableName: string,
    ): Promise<ColumnInfo[]> {
        const sql = `
        SELECT column_name, data_type, is_nullable, column_default, ordinal_position
        FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = $2
        ORDER BY ordinal_position
        `;
        return this.database.query<ColumnInfo>(sql, [schemaName, tableName]);
    }

    async getTableConstraints(
        schemaName: string,
        tableName: string,
    ): Promise<KeyConstraint[]> {
        return this.database.query<KeyConstraint>(
            `
            SELECT
                con.conname AS constraint_name,
                ns.nspname AS table_schema,
                cls.relname AS table_name,
                att.attname AS column_name,
                CASE con.contype
                WHEN 'p' THEN 'PRIMARY KEY'
                WHEN 'f' THEN 'FOREIGN KEY'
                END AS constraint_type,
                CASE
                WHEN con.contype = 'f' THEN ref_ns.nspname
                ELSE NULL
                END AS foreign_table_schema,
                CASE
                WHEN con.contype = 'f' THEN ref_cls.relname
                ELSE NULL
                END AS foreign_table_name,
                CASE
                WHEN con.contype = 'f' THEN ref_att.attname
                ELSE NULL
                END AS foreign_column_name
            FROM pg_catalog.pg_constraint con
            JOIN pg_catalog.pg_class cls
                ON cls.oid = con.conrelid
            JOIN pg_catalog.pg_namespace ns
                ON ns.oid = cls.relnamespace
            JOIN pg_catalog.pg_attribute att
                ON att.attrelid = con.conrelid
                AND att.attnum = ANY(con.conkey)
            LEFT JOIN pg_catalog.pg_class ref_cls
                ON ref_cls.oid = con.confrelid
            LEFT JOIN pg_catalog.pg_namespace ref_ns
                ON ref_ns.oid = ref_cls.relnamespace
            LEFT JOIN pg_catalog.pg_attribute ref_att
                ON ref_att.attrelid = con.confrelid
                AND ref_att.attnum =
                con.confkey[array_position(con.conkey, att.attnum)]
            WHERE ns.nspname = $1
                AND cls.relname = $2
                AND con.contype IN ('p', 'f')
            ORDER BY
                con.contype,
                con.conname,
                array_position(con.conkey, att.attnum);
            `,
            [schemaName, tableName],
        );
    }

    async getDatabaseSchema(): Promise<DatabaseSchema> {
        const schemas = await this.listSchemas();

        const schemaMetadata: SchemaMetadata[] = [];

        for (const schema of schemas) {
            const objects = await this.listTables(schema.schema_name);

            const tables: TableMetadata[] = [];

            for (const object of objects) {
                const [columns, constraints] = await Promise.all([
                    this.getTableColumns(schema.schema_name, object.table_name),
                    this.getTableConstraints(
                        schema.schema_name,
                        object.table_name,
                    ),
                ]);

                tables.push({
                    name: object.table_name,
                    type: object.table_type,
                    columns: columns.map(
                        (column): ColumnMetadata => ({
                            name: column.column_name,
                            dataType: column.data_type,
                            nullable: column.is_nullable === "YES",
                            defaultValue: column.column_default,
                            position: column.ordinal_position,
                        }),
                    ),
                    constraints: constraints.map(
                        (constraint): KeyConstraintMetadata => ({
                            name: constraint.constraint_name,
                            type: constraint.constraint_type,
                            column: constraint.column_name,
                            referencedTable: constraint.foreign_table_name,
                            referencedColumn: constraint.foreign_column_name,
                        }),
                    ),
                });
            }

            schemaMetadata.push({
                name: schema.schema_name,
                tables,
            });
        }
        return {
            schemas: schemaMetadata,
        };
    }
}
