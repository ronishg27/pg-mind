import config from "../config/index.js";
import { DatabaseService } from "../modules/database/database.service.js";
import { SchemaService } from "../modules/schema/schema.service.js";

async function main() {
    const connectionString = config.queryDatabaseUrl;

    if (!connectionString) {
        throw new Error("QUERY_DATABASE_URL is not configured");
    }

    const database = new DatabaseService(connectionString);
    await database.verifyConnections();
    const schemaService = new SchemaService(database);

    try {
        const tables = ["customers", "products", "orders"];

        for (const table of tables) {
            const result = await schemaService.getTable("public", table);

            if (result) {
                console.log(`\nColumns in ${table}:`);
                console.table(result.columns.map(c => ({
                    name: c.name,
                    type: c.dataType,
                    nullable: c.nullable,
                    default: c.defaultValue,
                    position: c.position,
                    identity: c.isIdentity ? c.identityGeneration : "N/A",
                    generated: c.isGenerated ? c.generationExpression : "N/A",
                    comment: c.comment || "N/A",
                })));
            } else {
                console.log(`\nTable ${table} not found`);
            }
        }
    } finally {
        await database.shutdown();
    }
}

main().catch((error: unknown) => {
    console.error("Column discovery failed:", error);
    process.exitCode = 1;
});