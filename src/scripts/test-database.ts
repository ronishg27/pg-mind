import { DatabaseService } from '../modules/database/database.service.js';

async function main() {
    process.loadEnvFile('.env');

    const connectionString = process.env.DATABASE_URL;

    if (!connectionString) {
        throw new Error('DATABASE_URL is not configured');
    }

    const database = new DatabaseService(connectionString);

    try {
        const connected = await database.checkConnection();

        if (!connected) {
            throw new Error('Database connection check failed');
        }

        console.log('Successfully connected to PostgreSQL!');
    } finally {
        await database.close();
    }
}

main().catch((error: unknown) => {
    console.error('Database test failed:', error);
    process.exitCode = 1;
});
