require('dotenv').config();
const pool = require('../src/config/db');

function normalizeSeedPhone(raw) {
  if (!raw || !String(raw).trim()) return null;
  const digits = String(raw).replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) return digits.slice(2);
  if (digits.length === 10) return digits;
  return null;
}

async function resetUsers() {
  const seedPhone = normalizeSeedPhone(process.env.SEED_ADMIN_PHONE);
  const seedEmail = (process.env.SEED_ADMIN_EMAIL || 'admin@onelead.com').trim();

  if (!seedPhone) {
    console.error(
      'SEED_ADMIN_PHONE must be set in .env (10-digit mobile) before running reset-users.'
    );
    process.exit(1);
  }

  const connection = await pool.getConnection();
  try {
    console.log('Resetting users...');
    await connection.query('SET FOREIGN_KEY_CHECKS = 0');
    await connection.query('DELETE FROM communications');
    await connection.query('DELETE FROM appointments');
    await connection.query('DELETE FROM reminders');
    await connection.query('DELETE FROM leads');
    await connection.query('DELETE FROM otp_verifications');
    await connection.query('DELETE FROM user_sessions');
    await connection.query('DELETE FROM users');
    await connection.query('ALTER TABLE users AUTO_INCREMENT = 1');
    await connection.query('ALTER TABLE user_sessions AUTO_INCREMENT = 1');
    await connection.query('SET FOREIGN_KEY_CHECKS = 1');

    await connection.query(
      `INSERT INTO users (name, email, role, phone, status)
       VALUES (?, ?, 'admin', ?, 'active')`,
      ['Admin', seedEmail, seedPhone]
    );

    console.log('All users removed.');
    console.log('Admin recreated for mobile OTP login.');
    if (process.env.OTP_FIXED_CODE) {
      console.log('OTP: OTP_FIXED_CODE is set (dev bypass).');
    } else {
      console.log('OTP: sent via WhatsApp on login.');
    }
  } finally {
    connection.release();
    await pool.end();
  }
}

resetUsers().catch((err) => {
  console.error('Reset failed:', err.message);
  process.exit(1);
});
