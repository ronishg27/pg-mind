import config from "../config/index.js";
import { DatabaseService } from "../modules/database/database.service.js";
import { SqlValidator } from "../modules/query/sql-validator.js";
import { QueryService } from "../modules/query/query.service.js";

async function main() {
    const connectionString = config.queryDatabaseUrl;

    if (!connectionString) {
        throw new Error("QUERY_DATABASE_URL is not configured");
    }

    const database = new DatabaseService(connectionString);
    await database.verifyConnections();

    const validator = new SqlValidator();
    const queryService = new QueryService(database, validator);

    try {
        // Test 1: Basic SELECT
        console.log("\n--- Basic SELECT ---");

        const customers = await queryService.executeQuery(
            "SELECT * FROM customers",
        );

        console.dir(customers, { depth: null });

        // Test 2: CTE
        console.log("\n--- CTE Query ---");

        const cteResult = await queryService.executeQuery(`
      WITH recent_orders AS (
        SELECT * FROM orders
      )
      SELECT * FROM recent_orders;
    `);

        console.dir(cteResult, { depth: null });

        // Test 3: Rejected write query
        console.log("\n--- DELETE Rejection ---");

        try {
            await queryService.executeQuery("DELETE FROM customers");
        } catch (error) {
            console.log(
                "Correctly rejected:",
                error instanceof Error ? error.message : error,
            );
        }

        // Test 4: Row limit
        console.log("\n--- Row Limit ---");

        const limitResult = await queryService.executeQuery(`
      SELECT generate_series(1, 150) AS number
    `);

        console.log({
            rowCount: limitResult.rowCount,
            truncated: limitResult.truncated,
            truncatedReason: limitResult.truncatedReason,
            firstRow: limitResult.rows[0],
            lastRow: limitResult.rows.at(-1),
        });

        // Test 5: Response size limit
        console.log("\n--- Response Size Limit ---");

        const largeResult = await queryService.executeQuery(`
  SELECT
    generate_series(1, 10) AS id,
    repeat('A', 200000) AS large_text
`);

        const responseBytes = Buffer.byteLength(
            JSON.stringify({
                columns: largeResult.columns,
                rows: largeResult.rows,
            }),
            "utf8",
        );

        console.log({
            rowCount: largeResult.rowCount,
            truncated: largeResult.truncated,
            truncatedReason: largeResult.truncatedReason,
            responseBytes,
            responseLimit: 1_000_000,
        });

        // Test 6: ORDER BY preservation
        console.log("\n--- ORDER BY Preservation ---");

        const orderResult = await queryService.executeQuery(`
      SELECT generate_series(1, 10) AS number
      ORDER BY number DESC
    `);

        console.log({
            rowCount: orderResult.rowCount,
            numbers: orderResult.rows.map(r => r.number),
            isDescending: orderResult.rows[0]?.number === 10 && orderResult.rows.at(-1)?.number === 1,
        });
    } finally {
        await database.shutdown();
    }
}

main().catch((error) => {
    console.error("Query service test failed:", error);
    process.exit(1);
});