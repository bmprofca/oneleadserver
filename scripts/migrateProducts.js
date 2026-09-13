require('dotenv').config();
const pool = require('../src/config/db');

async function migrate() {
  const connection = await pool.getConnection();
  try {
    console.log('Migrating products...');

    await connection.query(`
      CREATE TABLE IF NOT EXISTS products (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(160) NOT NULL,
        description TEXT NULL,
        status ENUM('active', 'inactive') NOT NULL DEFAULT 'active',
        created_by INT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        CONSTRAINT fk_products_created_by FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
      )
    `);

    const [cols] = await connection.query(`SHOW COLUMNS FROM leads LIKE 'product_id'`);
    if (!cols.length) {
      await connection.query(
        'ALTER TABLE leads ADD COLUMN product_id INT NULL AFTER id'
      );
      try {
        await connection.query(`
          ALTER TABLE leads
          ADD CONSTRAINT fk_leads_product
          FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE SET NULL
        `);
      } catch (err) {
        console.log('product FK note:', err.message);
      }
    }

    const [existing] = await connection.query('SELECT id FROM products LIMIT 1');
    if (!existing.length) {
      await connection.query(
        `INSERT INTO products (name, description, status)
         VALUES
         (?, ?, 'active'),
         (?, ?, 'active')`,
        [
          'General',
          'Default product for uncategorized leads',
          'OneLead CRM',
          'Primary lead management product',
        ]
      );
      console.log('Seed products created: General, OneLead CRM');
    }

    console.log('Products migration complete.');
  } finally {
    connection.release();
    await pool.end();
  }
}

migrate().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
