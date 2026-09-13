require('dotenv').config();
const pool = require('../src/config/db');

const schema = `
CREATE TABLE IF NOT EXISTS users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  email VARCHAR(160) NOT NULL UNIQUE,
  role ENUM('admin', 'sales') NOT NULL DEFAULT 'sales',
  phone VARCHAR(20) NULL UNIQUE,
  status ENUM('active', 'inactive') NOT NULL DEFAULT 'active',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS otp_verifications (
  id INT AUTO_INCREMENT PRIMARY KEY,
  phone VARCHAR(20) NOT NULL,
  otp_hash VARCHAR(255) NOT NULL,
  purpose ENUM('login') NOT NULL DEFAULT 'login',
  attempts INT NOT NULL DEFAULT 0,
  max_attempts INT NOT NULL DEFAULT 5,
  is_used TINYINT(1) NOT NULL DEFAULT 0,
  expires_at DATETIME NOT NULL,
  verified_at DATETIME NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_otp_phone (phone),
  INDEX idx_otp_expires (expires_at),
  INDEX idx_otp_active (phone, purpose, is_used)
);

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
);

CREATE TABLE IF NOT EXISTS products (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(160) NOT NULL,
  description TEXT NULL,
  status ENUM('active', 'inactive') NOT NULL DEFAULT 'active',
  created_by INT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_products_created_by FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS leads (
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
  status ENUM('new', 'contacted', 'qualified', 'proposal', 'negotiation', 'won', 'lost') NOT NULL DEFAULT 'new',
  assigned_to INT NULL,
  notes TEXT NULL,
  created_by INT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_leads_product FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE SET NULL,
  CONSTRAINT fk_leads_assigned FOREIGN KEY (assigned_to) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fk_leads_created_by FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS reminders (
  id INT AUTO_INCREMENT PRIMARY KEY,
  lead_id VARCHAR(120) NOT NULL,
  user_id INT NOT NULL,
  title VARCHAR(200) NOT NULL,
  description TEXT NULL,
  remind_at DATETIME NOT NULL,
  is_completed TINYINT(1) NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_reminders_lead FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE,
  CONSTRAINT fk_reminders_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS appointments (
  id INT AUTO_INCREMENT PRIMARY KEY,
  lead_id VARCHAR(120) NULL,
  user_id INT NULL,
  title VARCHAR(200) NOT NULL,
  description TEXT NULL,
  location VARCHAR(200) NULL,
  platform ENUM('meet', 'call', 'zoom', 'teams', 'in_person', 'other') NOT NULL DEFAULT 'call',
  start_at DATETIME NOT NULL,
  end_at DATETIME NULL,
  status ENUM('scheduled', 'completed', 'cancelled', 'no_show') NOT NULL DEFAULT 'scheduled',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_appointments_lead FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE,
  CONSTRAINT fk_appointments_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS communications (
  id INT AUTO_INCREMENT PRIMARY KEY,
  lead_id VARCHAR(120) NOT NULL,
  user_id INT NOT NULL,
  type ENUM('call', 'message', 'email') NOT NULL,
  direction ENUM('inbound', 'outbound') NOT NULL DEFAULT 'outbound',
  subject VARCHAR(200) NULL,
  content TEXT NULL,
  outcome VARCHAR(120) NULL,
  duration_seconds INT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_communications_lead FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE,
  CONSTRAINT fk_communications_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS lead_status_history (
  id INT AUTO_INCREMENT PRIMARY KEY,
  lead_id VARCHAR(120) NOT NULL,
  from_status VARCHAR(40) NULL,
  to_status VARCHAR(40) NOT NULL,
  changed_by INT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_status_history_lead (lead_id),
  CONSTRAINT fk_status_history_lead FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE,
  CONSTRAINT fk_status_history_user FOREIGN KEY (changed_by) REFERENCES users(id) ON DELETE SET NULL
);
`;

function normalizeSeedPhone(raw) {
  if (!raw || !String(raw).trim()) return null;
  const digits = String(raw).replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) return digits.slice(2);
  if (digits.length === 10) return digits;
  return null;
}

async function initDb() {
  const connection = await pool.getConnection();
  try {
    console.log('Connected to database. Creating tables...');
    const statements = schema
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean);

    for (const statement of statements) {
      await connection.query(statement);
    }

    const seedPhone = normalizeSeedPhone(process.env.SEED_ADMIN_PHONE);
    const seedEmail = (process.env.SEED_ADMIN_EMAIL || 'admin@onelead.com').trim();

    if (!seedPhone) {
      const [anyAdmin] = await connection.query(
        "SELECT id FROM users WHERE role = 'admin' LIMIT 1"
      );
      if (!anyAdmin.length) {
        console.log(
          'No admin user seeded. Set SEED_ADMIN_PHONE in .env and run init-db again, or create an admin after first login.'
        );
      }
    } else {
      const [existing] = await connection.query(
        'SELECT id FROM users WHERE phone = ? LIMIT 1',
        [seedPhone]
      );

      if (existing.length === 0) {
        await connection.query(
          `INSERT INTO users (name, email, role, phone, status)
           VALUES (?, ?, ?, ?, ?)`,
          ['Admin', seedEmail, 'admin', seedPhone, 'active']
        );

        console.log('Admin seeded (mobile OTP login).');
        if (process.env.OTP_FIXED_CODE) {
          console.log('  OTP: OTP_FIXED_CODE is set (dev bypass).');
        } else {
          console.log('  OTP: sent via WhatsApp on login.');
        }
        console.log('  Create more admins / sales from Users page.');
      } else {
        console.log('Admin user with this phone already exists. Skipping seed.');
      }
    }

    console.log('Database initialized successfully.');
  } finally {
    connection.release();
    await pool.end();
  }
}

initDb().catch((err) => {
  console.error('Database init failed:', err.message);
  process.exit(1);
});
