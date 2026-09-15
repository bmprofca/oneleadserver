require('dotenv').config();
const mysql = require('mysql2/promise');
const { APP_UTC_OFFSET } = require('../utils/timezone');

// Keep Node date math aligned with India.
process.env.TZ = process.env.TZ || 'Asia/Kolkata';

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  // Treat DATETIME values as Indian wall-clock time.
  timezone: APP_UTC_OFFSET,
});

pool.on('connection', (connection) => {
  connection.query(`SET time_zone = '${APP_UTC_OFFSET}'`, (err) => {
    if (err) {
      console.error('Failed to set MySQL session time_zone to IST:', err.message);
    }
  });
});

module.exports = pool;
