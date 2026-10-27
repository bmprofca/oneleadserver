const express = require('express');
const pool = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');
const { asyncHandler, badRequest, toBool } = require('../lib/http');
const settings = require('../services/settings');
const { audit } = require('../services/audit');

const router = express.Router();
router.use(authenticate);

// Settings every user needs (dropdown options); admins also get assignment details.
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const all = await settings.getAll();
    const out = {};
    for (const key of settings.PUBLIC_KEYS) out[key] = all[key];
    if (req.user.role === 'admin') {
      const [users] = await pool.query(
        `SELECT id, name, phone, auto_assign FROM users
         WHERE role = 'sales' AND status = 'active' ORDER BY name ASC`
      );
      out.auto_assign_users = users.map((u) => ({ ...u, auto_assign: !!u.auto_assign }));
    }
    return res.json(out);
  })
);

const cleanList = (value, label) => {
  if (!Array.isArray(value)) throw badRequest(`${label} must be a list`);
  const list = [...new Set(value.map((v) => String(v).trim()).filter(Boolean))].slice(0, 50);
  if (!list.length) throw badRequest(`${label} cannot be empty`);
  return list;
};

router.put(
  '/',
  authorize('admin'),
  asyncHandler(async (req, res) => {
    const before = await settings.getAll();
    const changes = {};
    if (req.body.auto_assign_enabled !== undefined) {
      changes.auto_assign_enabled = toBool(req.body.auto_assign_enabled);
    }
    if (req.body.lead_sources !== undefined) changes.lead_sources = cleanList(req.body.lead_sources, 'Lead sources');
    if (req.body.lost_reasons !== undefined) changes.lost_reasons = cleanList(req.body.lost_reasons, 'Lost reasons');
    if (req.body.currency !== undefined) changes.currency = String(req.body.currency).trim().slice(0, 8) || 'INR';

    for (const [key, value] of Object.entries(changes)) {
      await settings.set(key, value, req.user.id);
    }

    if (Array.isArray(req.body.auto_assign_users)) {
      for (const u of req.body.auto_assign_users) {
        await pool.query(`UPDATE users SET auto_assign = ? WHERE id = ? AND role = 'sales'`, [
          toBool(u.auto_assign) ? 1 : 0,
          Number(u.id),
        ]);
      }
    }

    const diffed = {};
    for (const key of Object.keys(changes)) diffed[key] = [before[key], changes[key]];
    await audit(req, {
      entityType: 'settings',
      action: 'update',
      summary: 'Updated workspace settings',
      changes: Object.keys(diffed).length ? diffed : null,
    });
    return res.json({ message: 'Settings saved' });
  })
);

module.exports = router;
