import { parse } from 'pgsql-ast-parser';

const examples = [
    {
        name: 'Simple SELECT',
        sql: 'SELECT id, name FROM customers WHERE id = 1;',
    },
    {
        name: 'SELECT with CTE',
        sql: `
      WITH recent_orders AS (
        SELECT id, customer_id FROM orders
      )
      SELECT * FROM recent_orders;
    `,
    },
    {
        name: 'DELETE statement',
        sql: 'DELETE FROM customers WHERE id = 1;',
    },
    {
        name: 'Data-modifying CTE',
        sql: `
    WITH deleted AS (
      DELETE FROM customers
      RETURNING *
    )
    SELECT * FROM deleted;
  `,
    },
    {
        name: 'Multiple statements',
        sql: `
    SELECT * FROM customers;
    DELETE FROM customers;
  `,
    },
    {
        name: 'SELECT FOR UPDATE',
        sql: 'SELECT * FROM customers FOR UPDATE;',
    },
];

for (const example of examples) {
    console.log(`\n--- ${example.name} ---`);

    try {
        const statements = parse(example.sql);

        console.log('Statement count:', statements.length);
        console.dir(statements, { depth: null });
    } catch (error) {
        console.error('Parsing failed:', error);
    }
}
