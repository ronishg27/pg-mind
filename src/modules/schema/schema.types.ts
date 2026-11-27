export interface DatabaseSchema {
    schemas: SchemaMetadata[];
}

export interface SchemaMetadata {
    name: string;
    tables: TableMetadata[];
    views: ViewMetadata[];
    materializedViews: MaterializedViewMetadata[];
    sequences: SequenceMetadata[];
    functions: FunctionMetadata[];
}

export interface TableMetadata {
    name: string;
    type: 'BASE TABLE' | 'VIEW' | 'MATERIALIZED VIEW' | 'FOREIGN TABLE';
    columns: ColumnMetadata[];
    constraints: ConstraintMetadata[];
    indexes: IndexMetadata[];
}

export interface ViewMetadata {
    name: string;
    definition: string | null;
    columns: ViewColumnMetadata[];
}

export interface MaterializedViewMetadata {
    name: string;
    definition: string | null;
    columns: ViewColumnMetadata[];
    isPopulated: boolean;
}

export interface SequenceMetadata {
    name: string;
    dataType: string;
    startValue: string;
    minValue: string;
    maxValue: string;
    increment: string;
    cycle: boolean;
    cache: number;
}

export interface FunctionMetadata {
    name: string;
    schema: string;
    language: string;
    returnType: string;
    arguments: FunctionArgumentMetadata[];
    volatility: 'VOLATILE' | 'STABLE' | 'IMMUTABLE';
    isStrict: boolean;
    isSecurityDefiner: boolean;
    definition: string | null;
}

export interface FunctionArgumentMetadata {
    name: string | null;
    dataType: string;
    mode: 'IN' | 'OUT' | 'INOUT' | 'VARIADIC';
    defaultExpression: string | null;
    ordinalPosition: number;
}

export interface ViewColumnMetadata {
    name: string;
    dataType: string;
}

export interface ColumnMetadata {
    name: string;
    dataType: string;
    nullable: boolean;
    defaultValue: string | null;
    position: number;
    isIdentity: boolean;
    identityGeneration: 'ALWAYS' | 'BY DEFAULT' | null;
    isGenerated: boolean;
    generationExpression: string | null;
    comment: string | null;
}

export type ConstraintType = 'PRIMARY KEY' | 'FOREIGN KEY' | 'UNIQUE' | 'CHECK' | 'EXCLUSION';

export interface ConstraintMetadata {
    name: string;
    type: ConstraintType;
    columns: string[];
    // For FOREIGN KEY
    referencedSchema?: string | null;
    referencedTable?: string | null;
    referencedColumns?: string[] | null;
    // For CHECK
    checkClause?: string | null;
    // For EXCLUSION
    exclusionClause?: string | null;
    // For PRIMARY KEY / UNIQUE
    isDeferrable?: boolean;
    initiallyDeferred?: boolean;
}

export interface IndexMetadata {
    name: string;
    schema: string;
    tableName: string;
    isUnique: boolean;
    isPrimary: boolean;
    method: string; // btree, hash, gist, gin, etc.
    columns: IndexColumnMetadata[];
    whereClause: string | null; // partial index predicate
    definition: string; // full CREATE INDEX statement
}

export interface IndexColumnMetadata {
    name: string;
    ordinalPosition: number;
    sortDirection: 'ASC' | 'DESC' | 'DEFAULT';
    nullsOrder: 'FIRST' | 'LAST' | 'DEFAULT';
}
