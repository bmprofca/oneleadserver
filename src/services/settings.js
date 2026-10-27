const pool = require('../config/db');

const DEFAULTS = {
  auto_assign_enabled: false,
  auto_assign_last_user_id: null,
  lead_sources: ['manual', 'maps-import', 'import', 'website', 'referral', 'whatsapp', 'walk-in', 'other'],
  lost_reasons: ['Price too high', 'Chose competitor', 'No budget', 'Not reachable', 'No requirement', 'Other'],
  currency: 'INR',
};

const PUBLIC_KEYS = ['lead_sources', 'lost_reasons', 'currency', 'auto_assign_enabled'];

function parse(raw, fallback) {
  if (raw === null || raw === undefined) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

async function getAll(conn = pool) {
  const [rows] = await conn.query('SELECT setting_key, setting_value FROM app_settings');
  const values = { ...DEFAULTS };
  for (const row of rows) {
    if (row.setting_key in DEFAULTS) values[row.setting_key] = parse(row.setting_value, DEFAULTS[row.setting_key]);
  }
  return values;
}

async function get(key, conn = pool) {
  const [rows] = await conn.query('SELECT setting_value FROM app_settings WHERE setting_key = ? LIMIT 1', [key]);
  return rows.length ? parse(rows[0].setting_value, DEFAULTS[key]) : DEFAULTS[key];
}

async function set(key, value, userId = null, conn = pool) {
  await conn.query(
    `INSERT INTO app_settings (setting_key, setting_value, updated_by) VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value), updated_by = VALUES(updated_by)`,
    [key, JSON.stringify(value), userId]
  );
}

module.exports = { DEFAULTS, PUBLIC_KEYS, getAll, get, set };
