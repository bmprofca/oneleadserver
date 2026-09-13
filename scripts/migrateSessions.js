require('dotenv').config();
const pool = require('../src/config/db');

async function migrate() {
  const connection = await pool.getConnection();
  try {
    console.log('Creating user_sessions table...');
    await connection.query(`
      CREATE TABLE IF NOT EXISTS user_sessions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        token_hash VARCHAR(64) NOT NULL UNIQUE,
        user_agent VARCHAR(512) NULL,
        ip_address VARCHAR(64) NULL,
        last_seen_at DATETIME NOT NULL,
        expires_at DATETIME NOT NULL,
        revoked_at DATETIME NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_sessions_user (user_id),
        INDEX idx_sessions_active (user_id, revoked_at, expires_at),
        CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);
    console.log('user_sessions ready.');
  } finally {
    connection.release();
    await pool.end();
  }
}

migrate().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
