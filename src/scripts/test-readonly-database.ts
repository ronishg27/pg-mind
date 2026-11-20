process.loadEnvFile(".env");

import { DatabaseService } from "../modules/database/database.service.js";

async function main() {
    const connectionString = process.env.QUERY_DATABASE_URL;

    if (!connectionString) {
        throw new Error("QUERY_DATABASE_URL is not configured");
    }

    const database = new DatabaseService(connectionString);

    try {
        // Test 1: Read operation
        const customers = await database.withReadOnlyTransaction(
            async (client) => {
                const result = await client.query(
                    "SELECT * FROM customers LIMIT 1",
                );

                return result.rows;
            },
        );

        console.log("Read transaction succeeded:", customers);

        // Test 2: Write operation
        try {
            await database.withReadOnlyTransaction(async (client) => {
                await client.query("CREATE TABLE transaction_test (id SERIAL)");
            });

            console.log("Unexpected: write operation succeeded");
        } catch (error) {
            console.log("Write operation correctly rejected:");
            console.log(error instanceof Error ? error.message : error);
        }
        // // test 3: Timeout behavior
        // try {
        //     await database.withReadOnlyTransaction(async (client) => {
        //         await client.query("SELECT pg_sleep(15)");
        //     });

        //     console.log("Unexpected: timeout did not occur");
        // } catch (error) {
        //     console.log("Timeout correctly triggered:");
        //     console.log(error instanceof Error ? error.message : error);
        // }
    } finally {
        await database.close();
    }
}

main().catch((error) => {
    console.error("Transaction test failed:", error);
    process.exit(1);
});
