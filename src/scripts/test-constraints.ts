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
        for (const table of ['customers', 'orders', 'products']) {
            const result = await schemaService.getTable('public', table);

            if (result) {
                console.log(`\nConstraints in ${table}:`);
                console.table(
                    result.constraints.map((c) => ({
                        name: c.name,
                        type: c.type,
                        columns: c.columns.join(', '),
                        referencedSchema: c.referencedSchema || 'N/A',
                        referencedTable: c.referencedTable || 'N/A',
                        referencedColumns: c.referencedColumns?.join(', ') || 'N/A',
                        checkClause: c.checkClause || 'N/A',
                        deferrable: c.isDeferrable ? 'YES' : 'NO',
                        initiallyDeferred: c.initiallyDeferred ? 'YES' : 'NO',
                    }))
                );
            } else {
                console.log(`\nTable ${table} not found`);
            }
        }
    } finally {
        await database.shutdown();
    }
}

main().catch((error: unknown) => {
    console.error('Constraint discovery failed:', error);
    process.exitCode = 1;
});
