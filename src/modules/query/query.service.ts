import { DatabaseService } from "../database/database.service.js";
import { SqlValidator } from "./sql-validator.js";

const MAX_ROWS = 100;
const MAX_RESULT_BYTES = 1_000_000;

export interface QueryResult {
    columns: string[];
    rows: Record<string, unknown>[];
    rowCount: number;
    truncated: boolean;
}

export class QueryService {
    constructor(
        private readonly database: DatabaseService,
        private readonly validator: SqlValidator,
    ) {}

    async executeQuery(sql: string): Promise<QueryResult> {
        // 1. Validate the SQL query before execution
        const validation = this.validator.validate(sql);

        if (!validation.valid) {
            throw new Error(`Invalid SQL query: ${validation.reason}`);
        }

        // 2. Remove the optional trailing statement terminator
        const normalizedSql = sql.trim().replace(/;\s*$/, "");

        // 3. Wrap the query and fetch one extra row
        const limitedSql = `
          SELECT * 
          FROM (${normalizedSql}) AS pgmind_result
          LIMIT ${MAX_ROWS + 1};
        `;

        // 4. Execute inside a read-only transaction
        return this.database.withReadOnlyTransaction(async (client) => {
            const result = await client.query(limitedSql);
            const columns = result.fields.map((field) => field.name);

            const rows: Record<string, unknown>[] = [];
            let truncated = result.rows.length > MAX_ROWS;

            for (const row of result.rows.slice(0, MAX_ROWS)) {
                const candidateRows = [...rows, row];

                const responseSize = Buffer.byteLength(
                    JSON.stringify({
                        columns,
                        rows: candidateRows,
                    }),
                    "utf8",
                );

                if (responseSize > MAX_RESULT_BYTES) {
                    truncated = true;
                    break;
                }

                rows.push(row);
            }

            return {
                columns,
                rows,
                rowCount: rows.length,
                truncated,
            };
        });
    }
}
