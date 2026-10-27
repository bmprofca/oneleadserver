/**
 * Full logical backup of the configured database to backups/<db>-<timestamp>.sql
 *
 * - Read-only: only SHOW / SELECT statements are executed.
 * - DATETIME/TIMESTAMP values are read as raw strings so no timezone shifting happens.
 * - Writes a manifest (.json) with per-table row counts and a sha256 of the dump.
 *
 * Usage: npm run backup-db
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mysql = require('mysql2/promise');

const BATCH = 500;
// Marks the end of each statement so restoreDb.js can replay them one at a time.
const END = '\n-- @@end\n';

function stamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(
    d.getMinutes()
  )}${pad(d.getSeconds())}`;
}

async function backup() {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
  });

  const dir = path.join(__dirname, '..', 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const base = `${process.env.DB_NAME}-${stamp()}`;
  const sqlPath = path.join(dir, `${base}.sql`);
  const out = fs.createWriteStream(sqlPath);
  const write = (s) => new Promise((resolve) => (out.write(s) ? resolve() : out.once('drain', resolve)));

  const manifest = { database: process.env.DB_NAME, created_at: new Date().toISOString(), tables: {} };

  try {
    await conn.query('SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await conn.query('START TRANSACTION WITH CONSISTENT SNAPSHOT');

    const [tables] = await conn.query(
      `SELECT TABLE_NAME AS name FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'
       ORDER BY TABLE_NAME`
    );

    await write(`-- OneLead backup of \`${process.env.DB_NAME}\` at ${manifest.created_at}\n`);
    await write(`SET NAMES utf8mb4;${END}SET FOREIGN_KEY_CHECKS = 0;${END}SET UNIQUE_CHECKS = 0;${END}\n`);

    for (const { name } of tables) {
      const [[create]] = await conn.query(`SHOW CREATE TABLE \`${name}\``);
      await write(`-- Table ${name}\nDROP TABLE IF EXISTS \`${name}\`;${END}${create['Create Table']};${END}\n`);

      let offset = 0;
      let count = 0;
      for (;;) {
        const [rows] = await conn.query(`SELECT * FROM \`${name}\` LIMIT ? OFFSET ?`, [BATCH, offset]);
        if (!rows.length) break;
        const cols = Object.keys(rows[0]).map((c) => `\`${c}\``).join(', ');
        const values = rows
          .map((row) => `(${Object.values(row).map((v) => conn.escape(v)).join(', ')})`)
          .join(',\n');
        await write(`INSERT INTO \`${name}\` (${cols}) VALUES\n${values};${END}`);
        count += rows.length;
        offset += rows.length;
        if (rows.length < BATCH) break;
      }

      const [[{ total }]] = await conn.query(`SELECT COUNT(*) AS total FROM \`${name}\``);
      if (Number(total) !== count) {
        throw new Error(`Row count mismatch on ${name}: dumped ${count}, table has ${total}`);
      }
      manifest.tables[name] = count;
      await write('\n');
      console.log(`  ${name.padEnd(28)} ${count} rows`);
    }

    await write(`SET UNIQUE_CHECKS = 1;${END}SET FOREIGN_KEY_CHECKS = 1;${END}`);
    await conn.query('COMMIT');
  } finally {
    await new Promise((resolve) => out.end(resolve));
    await conn.end();
  }

  manifest.sha256 = crypto.createHash('sha256').update(fs.readFileSync(sqlPath)).digest('hex');
  manifest.bytes = fs.statSync(sqlPath).size;
  fs.writeFileSync(path.join(dir, `${base}.json`), JSON.stringify(manifest, null, 2));

  console.log(`\nBackup written: ${sqlPath}`);
  console.log(`Size: ${(manifest.bytes / 1024).toFixed(1)} KB, sha256 ${manifest.sha256.slice(0, 16)}…`);
}

backup().catch((err) => {
  console.error('Backup failed:', err.message);
  process.exit(1);
});
