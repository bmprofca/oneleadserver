/**
 * Restore a backup produced by backupDb.js. DESTRUCTIVE for the target database:
 * every table in the dump is dropped and recreated.
 *
 * Usage:
 *   node scripts/restoreDb.js backups/<file>.sql --target <database_name> --yes
 *
 * The --target name must match DB_NAME in .env, so a restore can never hit
 * a database by accident.
 */
require('dotenv').config();
const fs = require('fs');
const crypto = require('crypto');
const mysql = require('mysql2/promise');

async function restore() {
  const args = process.argv.slice(2);
  const file = args[0];
  const target = args[args.indexOf('--target') + 1];

  if (!file || !fs.existsSync(file)) throw new Error('Pass the path to a .sql backup file');
  if (!args.includes('--yes') || args.indexOf('--target') === -1) {
    throw new Error('Refusing to restore without --target <db> --yes');
  }
  if (target !== process.env.DB_NAME) {
    throw new Error(`--target "${target}" does not match DB_NAME in .env`);
  }

  const manifestPath = file.replace(/\.sql$/, '.json');
  if (fs.existsSync(manifestPath)) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const sha = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    if (sha !== manifest.sha256) throw new Error('Backup file checksum does not match its manifest');
  }

  const conn = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  });
  try {
    const statements = fs
      .readFileSync(file, 'utf8')
      .split('\n-- @@end\n')
      .map((s) => s.replace(/^(\s*--[^\n]*\n)+/, '').trim())
      .filter(Boolean);
    for (const statement of statements) {
      await conn.query(statement);
    }
    console.log(`Restored ${statements.length} statements from ${file} into ${target}`);
  } finally {
    await conn.end();
  }
}

restore().catch((err) => {
  console.error('Restore failed:', err.message);
  process.exit(1);
});
