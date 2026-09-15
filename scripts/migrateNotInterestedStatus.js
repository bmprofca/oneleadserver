require('dotenv').config();
const pool = require('../src/config/db');

async function migrate() {
  const conn = await pool.getConnection();
  try {
    await conn.query(`
      ALTER TABLE leads
      MODIFY COLUMN status
      ENUM(
        'new',
        'contacted',
        'qualified',
        'proposal',
        'negotiation',
        'won',
        'lost',
        'not_interested'
      ) NOT NULL DEFAULT 'new'
    `);
    console.log("Added lead status 'not_interested'.");
  } finally {
    conn.release();
    await pool.end();
  }
}

migrate().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
