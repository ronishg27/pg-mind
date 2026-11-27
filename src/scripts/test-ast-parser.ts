import { parse } from 'pgsql-ast-parser';

console.dir(parse('WITH x AS (SELECT 1) SELECT * FROM x'), { depth: null });

console.dir(parse('WITH x AS (SELECT 1) DELETE FROM users'), { depth: null });

console.dir(
    parse(`
        WITH deleted AS (
            DELETE FROM users
            RETURNING *
        )
        SELECT * FROM deleted
    `),
    { depth: null }
);
