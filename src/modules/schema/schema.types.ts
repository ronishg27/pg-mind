export interface DatabaseSchema {
    schemas: SchemaMetadata[];
}

export interface SchemaMetadata {
    name: string;
    tables: TableMetadata[];
}

export interface TableMetadata {
    name: string;
    type: string;
    columns: ColumnMetadata[];
    constraints: KeyConstraintMetadata[];
}

export interface ColumnMetadata {
    name: string;
    dataType: string;
    nullable: boolean;
    defaultValue: string | null;
    position: number;
}

export interface KeyConstraintMetadata {
    name: string;
    type: "PRIMARY KEY" | "FOREIGN KEY";
    column: string;
    referencedTable: string | null;
    referencedColumn: string | null;
}
