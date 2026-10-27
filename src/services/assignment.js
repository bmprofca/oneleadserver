const pool = require('../config/db');
const settings = require('./settings');

/**
 * Round-robin over active sales users who opted into auto-assignment.
 * Returns an array of user ids (one per lead) and persists the pointer.
 */
async function nextAssignees(count = 1, { force = false } = {}) {
  if (count < 1) return [];
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const enabled = force || (await settings.get('auto_assign_enabled', conn));
    if (!enabled) {
      await conn.rollback();
      return Array(count).fill(null);
    }
    const [users] = await conn.query(
      `SELECT id FROM users WHERE role = 'sales' AND status = 'active' AND auto_assign = 1 ORDER BY id ASC`
    );
    if (!users.length) {
      await conn.rollback();
      return Array(count).fill(null);
    }
    // Lock the pointer row so concurrent creates don't hand out the same user.
    await conn.query(
      `INSERT IGNORE INTO app_settings (setting_key, setting_value) VALUES ('auto_assign_last_user_id', 'null')`
    );
    const [[row]] = await conn.query(
      `SELECT setting_value FROM app_settings WHERE setting_key = 'auto_assign_last_user_id' FOR UPDATE`
    );
    const last = Number(JSON.parse(row?.setting_value || 'null')) || 0;
    let index = users.findIndex((u) => u.id > last);
    if (index === -1) index = 0;

    const result = [];
    for (let i = 0; i < count; i += 1) {
      result.push(users[(index + i) % users.length].id);
    }
    await conn.query(
      `UPDATE app_settings SET setting_value = ? WHERE setting_key = 'auto_assign_last_user_id'`,
      [JSON.stringify(result[result.length - 1])]
    );
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback().catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
}

module.exports = { nextAssignees };
