require('dotenv').config();
const pool = require('../src/config/db');

async function migrate() {
  const conn = await pool.getConnection();
  try {
    const [noteCol] = await conn.query(
      `SHOW COLUMNS FROM lead_status_history LIKE 'note'`
    );
    if (!noteCol.length) {
      await conn.query(
        `ALTER TABLE lead_status_history
         ADD COLUMN note TEXT NULL AFTER to_status`
      );
      console.log('Added lead_status_history.note');
    } else {
      console.log('lead_status_history.note already exists');
    }

    const [waCol] = await conn.query(
      `SHOW COLUMNS FROM leads LIKE 'whatsapp_active'`
    );
    if (!waCol.length) {
      await conn.query(
        `ALTER TABLE leads
         ADD COLUMN whatsapp_active TINYINT(1) NOT NULL DEFAULT 0 AFTER notes`
      );
      console.log('Added leads.whatsapp_active (default inactive)');
    } else {
      console.log('leads.whatsapp_active already exists');
    }

    console.log('Migration complete.');
  } finally {
    conn.release();
    await pool.end();
  }
}

migrate().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
