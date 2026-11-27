export interface ExplainOptions {
    analyze?: boolean;
    verbose?: boolean;
    costs?: boolean;
    buffers?: boolean;
    timing?: boolean;
    summary?: boolean;
    format?: 'text' | 'json' | 'xml' | 'yaml';
}

export interface ExplainResult {
    plan: ExplainPlanNode;
    planningTime?: number;
    executionTime?: number;
}

export interface ExplainPlanNode {
    'Node Type': string;
    'Startup Cost'?: number;
    'Total Cost'?: number;
    'Plan Rows'?: number;
    'Plan Width'?: number;
    'Actual Startup Time'?: number;
    'Actual Total Time'?: number;
    'Actual Rows'?: number;
    'Actual Loops'?: number;
    'Shared Hit Blocks'?: number;
    'Shared Read Blocks'?: number;
    'Shared Dirtied Blocks'?: number;
    'Shared Written Blocks'?: number;
    'Local Hit Blocks'?: number;
    'Local Read Blocks'?: number;
    'Local Dirtied Blocks'?: number;
    'Local Written Blocks'?: number;
    'Temp Read Blocks'?: number;
    'Temp Written Blocks'?: number;
    'Workers Planned'?: number;
    'Workers Launched'?: number;
    'Worker Number'?: number;
    'Parallel Aware'?: boolean;
    'Relation Name'?: string;
    Schema?: string;
    Alias?: string;
    'Index Name'?: string;
    'Index Cond'?: string;
    Filter?: string;
    'Rows Removed by Filter'?: number;
    'Join Type'?: string;
    'Join Filter'?: string;
    'Hash Cond'?: string;
    'Merge Cond'?: string;
    'Sort Key'?: string[];
    'Sort Method'?: string;
    'Sort Space Used'?: number;
    'Sort Space Type'?: string;
    Subplans?: ExplainPlanNode[];
    Plans?: ExplainPlanNode[];
    [key: string]: unknown;
}

export interface ErrorInfo {
    code: string;
    message: string;
    severity: string;
    detail?: string;
    hint?: string;
    position?: string;
    internalPosition?: string;
    internalQuery?: string;
    where?: string;
    schema?: string;
    table?: string;
    column?: string;
    dataType?: string;
    constraint?: string;
    file?: string;
    line?: string;
    routine?: string;
}

export interface ErrorDiagnosis {
    error: ErrorInfo;
    explanation: string;
    affectedObjects: AffectedObject[];
    suggestedActions: string[];
}

export interface AffectedObject {
    type: 'table' | 'index' | 'constraint' | 'column' | 'function' | 'schema';
    schema: string;
    name: string;
    details?: string;
}

export interface IndexDiagnosticsResult {
    tableSchema: string;
    tableName: string;
    indexes: IndexDiagnosticsInfo[];
    suggestions: IndexSuggestion[];
}

export interface IndexDiagnosticsInfo {
    name: string;
    isUnique: boolean;
    isPrimary: boolean;
    method: string;
    columns: string[];
    size: string;
    indexScans: number;
    tuplesRead: number;
    tuplesFetched: number;
    indexUsageRatio: number;
    isUnused: boolean;
    isDuplicate: boolean;
}

export interface IndexSuggestion {
    type: 'missing_index' | 'unused_index' | 'duplicate_index' | 'partial_index';
    description: string;
    sql?: string;
    impact: 'high' | 'medium' | 'low';
}

export interface QueryPlanAnalysis {
    summary: string;
    issues: QueryPlanIssue[];
    recommendations: string[];
}

export interface QueryPlanIssue {
    type:
        | 'seq_scan'
        | 'nested_loop'
        | 'sort_spill'
        | 'high_cost'
        | 'row_estimate_error'
        | 'missing_stats';
    severity: 'high' | 'medium' | 'low';
    node: ExplainPlanNode;
    description: string;
    recommendation: string;
}
