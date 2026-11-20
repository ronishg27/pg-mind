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
        const schema = await schemaService.getDatabaseSchema();

        console.log(JSON.stringify(schema, null, 2));
    } finally {
        await database.close();
    }
}

main().catch((error: unknown) => {
    console.error("Full schema discovery failed:", error);
    process.exitCode = 1;
});
