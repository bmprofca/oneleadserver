require('dotenv').config();
const pool = require('../src/config/db');

async function migrate() {
  const connection = await pool.getConnection();
  try {
    console.log('Making appointments.user_id optional (assignee)...');

    // Drop existing FK if present, then allow NULL assignee
    const [fks] = await connection.query(
      `SELECT CONSTRAINT_NAME
       FROM information_schema.KEY_COLUMN_USAGE
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = 'appointments'
         AND COLUMN_NAME = 'user_id'
         AND REFERENCED_TABLE_NAME IS NOT NULL`
    );

    for (const row of fks) {
      await connection.query(
        `ALTER TABLE appointments DROP FOREIGN KEY \`${row.CONSTRAINT_NAME}\``
      );
    }

    await connection.query(
      `ALTER TABLE appointments MODIFY user_id INT NULL`
    );

    await connection.query(
      `ALTER TABLE appointments
       ADD CONSTRAINT fk_appointments_user
       FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL`
    );

    console.log('appointments.user_id is now optional assignee.');
  } finally {
    connection.release();
    await pool.end();
  }
}

migrate().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
