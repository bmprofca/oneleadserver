require('dotenv').config();
const pool = require('../src/config/db');

async function addProductColumn(connection, table) {
  const [cols] = await connection.query(`SHOW COLUMNS FROM ${table} LIKE 'product_id'`);
  if (cols.length) {
    console.log(`${table}.product_id already exists.`);
    return;
  }

  await connection.query(
    `ALTER TABLE ${table}
     ADD COLUMN product_id INT NULL AFTER lead_id,
     ADD INDEX idx_${table}_product (product_id),
     ADD CONSTRAINT fk_${table}_product
       FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE SET NULL`
  );
  console.log(`Added product_id to ${table}.`);

  // Backfill from linked lead product when available
  const [result] = await connection.query(
    `UPDATE ${table} t
     INNER JOIN leads l ON l.id = t.lead_id
     SET t.product_id = l.product_id
     WHERE t.product_id IS NULL AND l.product_id IS NOT NULL`
  );
  console.log(`Backfilled ${result.affectedRows || 0} ${table} row(s) from leads.`);
}

async function migrate() {
  const connection = await pool.getConnection();
  try {
    console.log('Adding product_id to reminders and appointments...');
    await addProductColumn(connection, 'reminders');
    await addProductColumn(connection, 'appointments');
    console.log('Migration complete.');
  } finally {
    connection.release();
    await pool.end();
  }
}

migrate().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
