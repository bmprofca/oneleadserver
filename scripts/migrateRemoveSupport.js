require('dotenv').config();
const pool = require('../src/config/db');

async function migrateRemoveSupport() {
  const connection = await pool.getConnection();
  try {
    console.log('Removing support role...');

    const [converted] = await connection.query(
      `UPDATE users SET role = 'sales' WHERE role = 'support'`
    );
    console.log(`Converted ${converted.affectedRows || 0} support user(s) to sales.`);

    await connection.query(
      `ALTER TABLE users
       MODIFY role ENUM('admin', 'sales') NOT NULL DEFAULT 'sales'`
    );
    console.log("Updated users.role ENUM to ('admin', 'sales').");

    console.log('Support role removed successfully.');
  } finally {
    connection.release();
    await pool.end();
  }
}

migrateRemoveSupport().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
