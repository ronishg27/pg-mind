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
        for (const table of ["customers", "orders", "products"]) {
            const constraints = await schemaService.getTableConstraints(
                "public",
                table,
            );

            console.log(`\nConstraints in ${table}:`);
            console.table(constraints);
        }
    } finally {
        await database.close();
    }
}

main().catch((error: unknown) => {
    console.error("Constraint discovery failed:", error);
    process.exitCode = 1;
});
