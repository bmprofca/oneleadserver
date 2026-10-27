// Schema helpers that work on both MySQL 8+ and MariaDB 10.5+.
// Every helper checks information_schema first, so migrations are safe to re-run.

async function hasTable(conn, table) {
  const [rows] = await conn.query(
    `SELECT 1 FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? LIMIT 1`,
    [table]
  );
  return rows.length > 0;
}

async function hasColumn(conn, table, column) {
  const [rows] = await conn.query(
    `SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1`,
    [table, column]
  );
  return rows.length > 0;
}

async function hasIndex(conn, table, index) {
  const [rows] = await conn.query(
    `SELECT 1 FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ? LIMIT 1`,
    [table, index]
  );
  return rows.length > 0;
}

async function columnType(conn, table, column) {
  const [rows] = await conn.query(
    `SELECT COLUMN_TYPE AS type FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1`,
    [table, column]
  );
  return rows.length ? String(rows[0].type) : null;
}

async function addColumn(conn, table, column, definition, log) {
  if (await hasColumn(conn, table, column)) return;
  await conn.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
  log(`  + ${table}.${column}`);
}

async function addIndex(conn, table, index, columns, log) {
  if (await hasIndex(conn, table, index)) return;
  await conn.query(`ALTER TABLE \`${table}\` ADD INDEX \`${index}\` (${columns})`);
  log(`  + index ${table}.${index}`);
}

async function createTable(conn, table, ddl, log) {
  if (await hasTable(conn, table)) return;
  await conn.query(ddl);
  log(`  + table ${table}`);
}

module.exports = { hasTable, hasColumn, hasIndex, columnType, addColumn, addIndex, createTable };
