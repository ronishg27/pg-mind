import { DatabaseService } from '../modules/database/database.service.js';
import { SchemaService } from '../modules/schema/schema.service.js';

async function main() {
    process.loadEnvFile('.env');

    const connectionString = process.env.DATABASE_URL;

    if (!connectionString) {
        throw new Error('DATABASE_URL is not configured');
    }

    const database = new DatabaseService(connectionString);
    const schemaService = new SchemaService(database);

    try {
        const schemas = await schemaService.listSchemas();

        console.log('Available schemas:');
        console.table(schemas);
    } finally {
        await database.close();
    }
}

main().catch((error: unknown) => {
    console.error('Schema discovery failed:', error);
    process.exitCode = 1;
});
