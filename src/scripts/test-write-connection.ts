import config from "../config/index.js";
import { DatabaseService } from "../modules/database/database.service.js";

process.loadEnvFile(".env");
const queryConnectionString = process.env.QUERY_DATABASE_URL;
const writeConnectionString = process.env.WRITE_DATABASE_URL;

if (!queryConnectionString || !writeConnectionString) {
    throw new Error("Database connection strings are missing.");
}

const database = new DatabaseService(
    queryConnectionString,
    writeConnectionString,
);

async function main() {
    try {
        // Verify read-only connection.
        const readResult = await database.query<{
            current_user: string;
        }>("SELECT current_user");

        console.log("Read connection:", readResult[0].current_user);

        // Verify write connection inside a transaction.
        await database.withWriteTransaction(
            config.databaseName,
            async (client) => {
                const result = await client.query(
                    "INSERT INTO products (name, price, stock) VALUES ($1, $2, $3) RETURNING id",
                    ["QueryMind Transaction Test", 10.0, 5],
                );

                console.log("Inserted test ID:", result.rows[0].id);

                throw new Error("Intentional rollback test");
            },
        );
    } catch (error) {
        if (
            error instanceof Error &&
            error.message === "Intentional rollback test"
        ) {
            console.log("Transaction rollback verified.");
        } else {
            throw error;
        }
    } finally {
        await database.close();
    }
}

main().catch(console.error);
