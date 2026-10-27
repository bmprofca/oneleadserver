const pool = require('../config/db');

const IGNORED = new Set(['updated_at', 'created_at', 'phone_normalized', 'last_activity_at']);

/** Field-level diff between two row snapshots: { field: [before, after] } */
function diff(before = {}, after = {}) {
  const changes = {};
  for (const key of Object.keys(after)) {
    if (IGNORED.has(key)) continue;
    const a = before[key] instanceof Date ? before[key].toISOString() : before[key] ?? null;
    const b = after[key] instanceof Date ? after[key].toISOString() : after[key] ?? null;
    if (String(a) !== String(b)) changes[key] = [a, b];
  }
  return changes;
}

/**
 * Record an audit entry. Never throws — auditing must not break the request.
 * @param {object} req  Express request (for user and IP) or null for system actions
 */
async function audit(req, { entityType, entityId = null, action, summary = null, changes = null }, conn = pool) {
  try {
    const hasChanges = changes && Object.keys(changes).length;
    await conn.query(
      `INSERT INTO audit_logs (user_id, entity_type, entity_id, action, summary, changes, ip_address)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        req?.user?.id || null,
        entityType,
        entityId === null ? null : String(entityId),
        action,
        summary ? String(summary).slice(0, 255) : null,
        hasChanges ? JSON.stringify(changes) : null,
        req ? String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim().slice(0, 64) : null,
      ]
    );
  } catch (err) {
    console.error('Audit log failed:', err.message);
  }
}

module.exports = { audit, diff };
