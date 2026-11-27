import { parse } from 'pgsql-ast-parser';

import { SqlValidator } from '../modules/query/sql-validator.js';

const validator = new SqlValidator();

const tests = [
    // "SELECT now()",
    // "SELECT COUNT(*) FROM customers",
    // "SELECT pg_read_file('/etc/hosts')",
    // "SELECT pg_catalog.pg_read_file('/etc/hosts')",
    // "SELECT set_config('statement_timeout', '0', false)",
    // "WITH file_data AS (SELECT pg_read_file('/etc/hosts') AS content) SELECT * FROM file_data",

    // "SELECT (SELECT pg_read_file('/etc/hosts')) AS content",
    'CREATE INDEX idx_users_email ON users(email);',
    'DROP INDEX idx_users_email;',
];

for (const sql of tests) {
    console.log({
        sql,
        result: validator.validate(sql),
    });
}

// const ast = parse(`
//   SELECT
//     current_user,
//     now(),
//     COUNT(*)
//   FROM customers
// `);

// console.dir(ast, { depth: null });
