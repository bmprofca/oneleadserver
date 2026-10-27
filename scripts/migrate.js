/**
 * Versioned schema migrations.
 *
 *   npm run migrate -- --status   list applied / pending migrations (read-only)
 *   npm run migrate               apply pending migrations
 *
 * Always run `npm run backup-db` first in production.
 */
require('dotenv').config();
const mysql = require('mysql2/promise');
const migrations = require('../src/migrations');
const { APP_UTC_OFFSET } = require('../src/utils/timezone');

const LOCK = 'onelead_schema_migrate';

async function main() {
  const statusOnly = process.argv.includes('--status');
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    timezone: APP_UTC_OFFSET,
  });
  const log = (msg) => console.log(msg);

  try {
    await conn.query(`SET time_zone = '${APP_UTC_OFFSET}'`);
    console.log(`Database: ${process.env.DB_NAME} @ ${process.env.DB_HOST}`);

    const [[{ ok }]] = await conn.query('SELECT GET_LOCK(?, 10) AS ok', [LOCK]);
    if (!ok) throw new Error('Another migration run holds the lock; try again later');

    let applied = new Set();
    const [tables] = await conn.query(
      `SELECT 1 FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'schema_migrations'`
    );
    if (tables.length) {
      const [rows] = await conn.query('SELECT id FROM schema_migrations');
      applied = new Set(rows.map((r) => r.id));
    } else if (!statusOnly) {
      await conn.query(
        `CREATE TABLE schema_migrations (
           id VARCHAR(120) PRIMARY KEY,
           description VARCHAR(255) NULL,
           applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
         ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
      );
    }

    const pending = migrations.filter((m) => !applied.has(m.id));
    for (const m of migrations) {
      console.log(`${applied.has(m.id) ? '[applied]' : '[pending]'} ${m.id} — ${m.description}`);
    }
    if (statusOnly) return;
    if (!pending.length) {
      console.log('\nNothing to do. Schema is up to date.');
      return;
    }

    for (const m of pending) {
      console.log(`\nApplying ${m.id}`);
      await m.up(conn, log);
      await conn.query('INSERT INTO schema_migrations (id, description) VALUES (?, ?)', [
        m.id,
        m.description,
      ]);
      console.log(`Done ${m.id}`);
    }
    console.log(`\nApplied ${pending.length} migration(s).`);
  } finally {
    await conn.query('SELECT RELEASE_LOCK(?)', [LOCK]).catch(() => {});
    await conn.end();
  }
}

main().catch((err) => {
  console.error('\nMigration failed:', err.message);
  console.error('Migrations are idempotent — fix the cause and run again.');
  process.exit(1);
});
