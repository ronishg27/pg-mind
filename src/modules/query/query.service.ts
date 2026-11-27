import { DatabaseService } from '../database/database.service.js';
import { SqlValidator } from './sql-validator.js';
import Cursor from 'pg-cursor';

const MAX_ROWS = 100;
const MAX_RESULT_BYTES = 1_000_000;
const FETCH_BATCH_SIZE = 50;

export interface QueryResult {
    columns: string[];
    rows: Record<string, unknown>[];
    rowCount: number;
    truncated: boolean;
    truncatedReason?: 'row_limit' | 'byte_limit';
}

export class QueryService {
    constructor(
        private readonly database: DatabaseService,
        private readonly validator: SqlValidator
    ) {}

    async executeQuery(sql: string): Promise<QueryResult> {
        const validation = this.validator.validate(sql);

        if (!validation.valid) {
            throw new Error(`Invalid SQL query: ${validation.reason}`);
        }

        const normalizedSql = sql.trim().replace(/;\s*$/, '');

        return this.database.withReadOnlyTransaction(async (client) => {
            const cursor = client.query(new Cursor(normalizedSql));

            const columns: string[] = [];
            const rows: Record<string, unknown>[] = [];
            let totalBytes = 0;
            let truncated = false;
            let truncatedReason: 'row_limit' | 'byte_limit' | undefined;

            try {
                while (rows.length < MAX_ROWS) {
                    const remainingRows = MAX_ROWS - rows.length;
                    const fetchSize = Math.min(FETCH_BATCH_SIZE, remainingRows);

                    const batch = await this.readBatch(cursor, fetchSize);

                    if (batch.length === 0) {
                        break;
                    }

                    if (columns.length === 0 && batch.length > 0) {
                        columns.push(...Object.keys(batch[0]));
                    }

                    for (const row of batch) {
                        const rowBytes = this.estimateRowBytes(row, columns);

                        if (totalBytes + rowBytes > MAX_RESULT_BYTES) {
                            truncated = true;
                            truncatedReason = 'byte_limit';
                            break;
                        }

                        rows.push(row);
                        totalBytes += rowBytes;
                    }

                    if (truncated) {
                        break;
                    }
                }

                if (!truncated && rows.length === MAX_ROWS) {
                    const hasMore = await this.readBatch(cursor, 1);
                    if (hasMore.length > 0) {
                        truncated = true;
                        truncatedReason = 'row_limit';
                    }
                }

                return {
                    columns,
                    rows,
                    rowCount: rows.length,
                    truncated,
                    truncatedReason,
                };
            } finally {
                await this.closeCursor(cursor);
            }
        });
    }

    private readBatch(cursor: Cursor, count: number): Promise<Record<string, unknown>[]> {
        return new Promise((resolve, reject) => {
            cursor.read(count, (err, rows) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(rows as Record<string, unknown>[]);
                }
            });
        });
    }

    private closeCursor(cursor: Cursor): Promise<void> {
        return new Promise((resolve, reject) => {
            cursor.close((err) => {
                if (err) {
                    reject(err);
                } else {
                    resolve();
                }
            });
        });
    }

    private estimateRowBytes(row: Record<string, unknown>, columns: string[]): number {
        let bytes = 2; // {} braces

        for (let i = 0; i < columns.length; i++) {
            const col = columns[i];
            const value = row[col];

            bytes += Buffer.byteLength(JSON.stringify(col), 'utf8');
            bytes += 1; // colon
            bytes += Buffer.byteLength(JSON.stringify(value), 'utf8');

            if (i < columns.length - 1) {
                bytes += 1; // comma
            }
        }

        return bytes;
    }
}
