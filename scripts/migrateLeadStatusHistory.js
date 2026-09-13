require('dotenv').config();
const pool = require('../src/config/db');

async function migrate() {
  const conn = await pool.getConnection();
  try {
    console.log('Creating lead_status_history table...');
    await conn.query(`
      CREATE TABLE IF NOT EXISTS lead_status_history (
        id INT AUTO_INCREMENT PRIMARY KEY,
        lead_id VARCHAR(120) NOT NULL,
        from_status VARCHAR(40) NULL,
        to_status VARCHAR(40) NOT NULL,
        changed_by INT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_status_history_lead (lead_id),
        CONSTRAINT fk_status_history_lead
          FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE,
        CONSTRAINT fk_status_history_user
          FOREIGN KEY (changed_by) REFERENCES users(id) ON DELETE SET NULL
      )
    `);
    console.log('lead_status_history ready.');
  } finally {
    conn.release();
    await pool.end();
  }
}

migrate().catch((err) => {
  console.error(err);
  process.exit(1);
});
