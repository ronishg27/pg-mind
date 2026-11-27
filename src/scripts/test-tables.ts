import config from '../config/index.js';
import { DatabaseService } from '../modules/database/database.service.js';
import { SchemaService } from '../modules/schema/schema.service.js';

async function main() {
    const connectionString = config.queryDatabaseUrl;

    if (!connectionString) {
        throw new Error('QUERY_DATABASE_URL is not configured');
    }

    const database = new DatabaseService(connectionString);
    await database.verifyConnections();
    const schemaService = new SchemaService(database);

    try {
        const result = await schemaService.getSchema('public');

        if (result) {
            console.log('Database objects in public schema:');

            console.log('\nTables:');
            console.table(
                result.tables.map((t) => ({
                    name: t.name,
                    type: t.type,
                    columns: t.columns.length,
                    constraints: t.constraints.length,
                    indexes: t.indexes.length,
                }))
            );

            console.log('\nViews:');
            console.table(
                result.views.map((v) => ({
                    name: v.name,
                    columns: v.columns.length,
                }))
            );

            console.log('\nMaterialized Views:');
            console.table(
                result.materializedViews.map((v) => ({
                    name: v.name,
                    columns: v.columns.length,
                    populated: v.isPopulated,
                }))
            );

            console.log('\nSequences:');
            console.table(
                result.sequences.map((s) => ({
                    name: s.name,
                    type: s.dataType,
                }))
            );

            console.log('\nFunctions:');
            console.table(
                result.functions.map((f) => ({
                    name: f.name,
                    language: f.language,
                    returnType: f.returnType,
                    args: f.arguments.length,
                }))
            );
        }
    } finally {
        await database.shutdown();
    }
}

main().catch((error: unknown) => {
    console.error('Table discovery failed:', error);
    process.exitCode = 1;
});
