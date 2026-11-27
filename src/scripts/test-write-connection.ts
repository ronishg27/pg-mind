import config from '../config/index.js';
import { DatabaseService } from '../modules/database/database.service.js';

process.loadEnvFile('.env');
const queryConnectionString = config.queryDatabaseUrl;
const writeConnectionString = config.writeDatabaseUrl;

if (!queryConnectionString || !writeConnectionString) {
    throw new Error('Database connection strings are missing.');
}

const database = new DatabaseService(queryConnectionString, writeConnectionString);

async function main() {
    try {
        await database.verifyConnections();

        // Verify read-only connection.
        const readResult = await database.query<{
            current_user: string;
        }>('SELECT current_user');

        console.log('Read connection:', readResult[0].current_user);

        // Verify write connection inside a transaction.
        await database.withWriteTransaction(async (client) => {
            const result = await client.query(
                'INSERT INTO products (name, price, stock) VALUES ($1, $2, $3) RETURNING id',
                ['PGMind Transaction Test', 10.0, 5]
            );

            console.log('Inserted test ID:', result.rows[0].id);

            throw new Error('Intentional rollback test');
        });
    } catch (error) {
        if (error instanceof Error && error.message === 'Intentional rollback test') {
            console.log('Transaction rollback verified.');
        } else {
            throw error;
        }
    } finally {
        await database.shutdown();
    }
}

main().catch(console.error);
