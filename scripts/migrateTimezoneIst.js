require('dotenv').config();
const pool = require('../src/config/db');

/**
 * Previous app/DB used UTC wall-clock for NOW()/Date inserts into DATETIME.
 * After switching session TZ to IST, shift those auto DATETIME values by +5:30.
 * Do NOT touch user-entered remind_at / appointment start_at / end_at.
 */
async function migrate() {
  const connection = await pool.getConnection();
  try {
    await connection.query(`SET time_zone = '+00:00'`);

    const [otp] = await connection.query(`
      UPDATE otp_verifications
      SET
        expires_at = DATE_ADD(expires_at, INTERVAL 330 MINUTE),
        verified_at = IF(verified_at IS NULL, NULL, DATE_ADD(verified_at, INTERVAL 330 MINUTE))
    `);

    const [sessions] = await connection.query(`
      UPDATE user_sessions
      SET
        last_seen_at = DATE_ADD(last_seen_at, INTERVAL 330 MINUTE),
        expires_at = DATE_ADD(expires_at, INTERVAL 330 MINUTE),
        revoked_at = IF(revoked_at IS NULL, NULL, DATE_ADD(revoked_at, INTERVAL 330 MINUTE))
    `);

    console.log('Shifted OTP DATETIME rows:', otp.affectedRows || 0);
    console.log('Shifted session DATETIME rows:', sessions.affectedRows || 0);
    console.log('Migration complete (IST wall-clock for auto DATETIME fields).');
  } finally {
    connection.release();
    await pool.end();
  }
}

migrate().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
