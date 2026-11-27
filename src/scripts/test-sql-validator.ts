import { SqlValidator } from '../modules/query/sql-validator.js';

const validator = new SqlValidator();

const examples = [
    {
        name: 'Simple SELECT',
        sql: 'SELECT * FROM customers;',
    },
    {
        name: 'SELECT with CTE',
        sql: `
      WITH recent_orders AS (
        SELECT * FROM orders
      )
      SELECT * FROM recent_orders;
    `,
    },
    {
        name: 'DELETE',
        sql: 'DELETE FROM customers;',
    },
    {
        name: 'Data-modifying CTE',
        sql: `
      WITH deleted AS (
        DELETE FROM customers RETURNING *
      )
      SELECT * FROM deleted;
    `,
    },
    {
        name: 'Multiple statements',
        sql: 'SELECT * FROM customers; DELETE FROM customers;',
    },
    {
        name: 'SELECT FOR UPDATE',
        sql: 'SELECT * FROM customers FOR UPDATE;',
    },
    {
        name: 'SELECT INTO',
        sql: 'SELECT * INTO backup_customers FROM customers;',
    },
    {
        name: 'Empty SQL',
        sql: '',
    },
    {
        name: 'Whitespace-only SQL',
        sql: '   \n\t  ',
    },
    {
        name: 'SQL exceeds maximum length',
        sql: 'SELECT 1 ' + ' '.repeat(50_000),
    },
    {
        name: 'Normal SELECT',
        sql: 'SELECT * FROM customers',
    },
];

for (const example of examples) {
    console.log(`\n--- ${example.name} ---`);
    console.log(validator.validate(example.sql));
}
