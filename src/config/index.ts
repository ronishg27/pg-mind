process.loadEnvFile(".env");

const config = {
    databaseName: process.env.DATABASE_NAME || "querymind_dev",
    queryDatabaseUrl: process.env.QUERY_DATABASE_URL || "",
    writeDatabaseUrl: process.env.WRITE_DATABASE_URL || "",
    writeRoleName: process.env.WRITE_ROLE_NAME || "querymind_writer",
};

export default config;
