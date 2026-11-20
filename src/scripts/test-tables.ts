import { DatabaseService } from "../modules/database/database.service.js";
import { SchemaService } from "../modules/schema/schema.service.js";

async function main() {
    process.loadEnvFile(".env");

    const connectionString = process.env.DATABASE_URL;

    if (!connectionString) {
        throw new Error("DATABASE_URL is not configured");
    }

    const database = new DatabaseService(connectionString);
    const schemaService = new SchemaService(database);

    try {
        const tables = await schemaService.listTables("public");

        console.log("Database objects:");
        console.table(tables);
    } finally {
        await database.close();
    }
}

main().catch((error: unknown) => {
    console.error("Table discovery failed:", error);
    process.exitCode = 1;
});
