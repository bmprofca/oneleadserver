require('dotenv').config();
const pool = require('../src/config/db');

async function migrate() {
  const connection = await pool.getConnection();
  try {
    console.log('Running schema updates...');
    await connection.query('SET FOREIGN_KEY_CHECKS = 0');

    // Drop password from users
    try {
      await connection.query('ALTER TABLE users DROP COLUMN password');
      console.log('Dropped users.password');
    } catch (err) {
      console.log('users.password note:', err.message);
    }

    // Drop product code
    try {
      await connection.query('ALTER TABLE products DROP COLUMN code');
      console.log('Dropped products.code');
    } catch (err) {
      console.log('products.code note:', err.message);
    }

    // Appointment platform
    const [platformCol] = await connection.query(
      `SHOW COLUMNS FROM appointments LIKE 'platform'`
    );
    if (!platformCol.length) {
      await connection.query(`
        ALTER TABLE appointments
        ADD COLUMN platform ENUM('meet','call','zoom','teams','in_person','other')
        NOT NULL DEFAULT 'call' AFTER location
      `);
      console.log('Added appointments.platform');
    }

    // Rebuild leads around Excel source ID as primary key
    await connection.query('DELETE FROM communications');
    await connection.query('DELETE FROM appointments');
    await connection.query('DELETE FROM reminders');
    await connection.query('DROP TABLE IF EXISTS leads');

    await connection.query(`
      CREATE TABLE leads (
        id VARCHAR(120) PRIMARY KEY,
        product_id INT NULL,
        name VARCHAR(255) NOT NULL,
        email TEXT NULL,
        phone VARCHAR(80) NULL,
        company VARCHAR(255) NULL,
        address TEXT NULL,
        website VARCHAR(255) NULL,
        category VARCHAR(120) NULL,
        open_hours VARCHAR(255) NULL,
        rating VARCHAR(40) NULL,
        rating_info VARCHAR(120) NULL,
        latitude DECIMAL(12,8) NULL,
        longitude DECIMAL(12,8) NULL,
        maps_url TEXT NULL,
        featured_image TEXT NULL,
        social_medias TEXT NULL,
        facebook VARCHAR(255) NULL,
        instagram VARCHAR(255) NULL,
        twitter VARCHAR(255) NULL,
        source VARCHAR(80) NULL DEFAULT 'import',
        status ENUM('new','contacted','qualified','proposal','negotiation','won','lost') NOT NULL DEFAULT 'new',
        assigned_to INT NULL,
        notes TEXT NULL,
        created_by INT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        CONSTRAINT fk_leads_product FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE SET NULL,
        CONSTRAINT fk_leads_assigned FOREIGN KEY (assigned_to) REFERENCES users(id) ON DELETE SET NULL,
        CONSTRAINT fk_leads_created_by FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
      )
    `);
    console.log('Recreated leads table with string primary id');

    // Reminder lead_id required + varchar
    try {
      await connection.query('ALTER TABLE reminders DROP FOREIGN KEY fk_reminders_lead');
    } catch (_) {}
    await connection.query(
      `ALTER TABLE reminders MODIFY lead_id VARCHAR(120) NOT NULL`
    );
    await connection.query(`
      ALTER TABLE reminders
      ADD CONSTRAINT fk_reminders_lead
      FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE
    `);

    try {
      await connection.query('ALTER TABLE appointments DROP FOREIGN KEY fk_appointments_lead');
    } catch (_) {}
    await connection.query(
      `ALTER TABLE appointments MODIFY lead_id VARCHAR(120) NULL`
    );
    await connection.query(`
      ALTER TABLE appointments
      ADD CONSTRAINT fk_appointments_lead
      FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE
    `);

    try {
      await connection.query(
        'ALTER TABLE communications DROP FOREIGN KEY fk_communications_lead'
      );
    } catch (_) {}
    await connection.query(
      `ALTER TABLE communications MODIFY lead_id VARCHAR(120) NOT NULL`
    );
    await connection.query(`
      ALTER TABLE communications
      ADD CONSTRAINT fk_communications_lead
      FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE
    `);

    await connection.query('SET FOREIGN_KEY_CHECKS = 1');
    console.log('Schema updates complete.');
  } finally {
    connection.release();
    await pool.end();
  }
}

migrate().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
