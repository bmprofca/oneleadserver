const express = require('express');
const { body } = require('express-validator');
const pool = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');
const { asyncHandler, validate, parsePagination, pageResult, badRequest, forbidden, notFound, toBool, emptyToNull } = require('../lib/http');
const { getLeadForUser, assertProduct, touchActivity } = require('../services/leads');
const { formatMysqlDateTime } = require('../utils/timezone');

const router = express.Router();
router.use(authenticate);

const PRIORITIES = ['low', 'normal', 'high'];

async function getOwnedReminder(id, user) {
  const [rows] = await pool.query('SELECT * FROM reminders WHERE id = ? LIMIT 1', [id]);
  if (!rows.length) throw notFound('Reminder not found');
  if (user.role !== 'admin' && rows[0].user_id !== user.id) throw forbidden();
  return rows[0];
}

async function resolveOwner(req, userId) {
  if (req.user.role !== 'admin' || !userId) return req.user.id;
  const [rows] = await pool.query(`SELECT id FROM users WHERE id = ? AND status = 'active' LIMIT 1`, [Number(userId)]);
  if (!rows.length) throw badRequest('Select an active user');
  return rows[0].id;
}

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const where = [];
    const params = [];
    if (req.user.role !== 'admin') {
      where.push('r.user_id = ?');
      params.push(req.user.id);
    } else if (req.query.user_id) {
      where.push('r.user_id = ?');
      params.push(Number(req.query.user_id));
    }
    if (req.query.completed !== undefined) {
      where.push('r.is_completed = ?');
      params.push(req.query.completed === 'true' ? 1 : 0);
    }
    if (req.query.lead_id) {
      where.push('r.lead_id = ?');
      params.push(req.query.lead_id);
    }
    if (req.query.product_id) {
      where.push('r.product_id = ?');
      params.push(req.query.product_id);
    }
    if (req.user.role === 'admin' && req.query.assigned_to) {
      where.push('l.assigned_to = ?');
      params.push(Number(req.query.assigned_to));
    }
    // Custom date range on the callback time (India dates, inclusive).
    const DATE = /^\d{4}-\d{2}-\d{2}$/;
    if (req.query.from && DATE.test(req.query.from)) {
      where.push('r.remind_at >= ?');
      params.push(`${req.query.from} 00:00:00`);
    }
    if (req.query.to && DATE.test(req.query.to)) {
      where.push('r.remind_at < ? + INTERVAL 1 DAY');
      params.push(`${req.query.to} 00:00:00`);
    }
    if (req.query.priority && PRIORITIES.includes(req.query.priority)) {
      where.push('r.priority = ?');
      params.push(req.query.priority);
    }
    if (req.query.due === 'overdue') where.push('r.is_completed = 0 AND r.remind_at < NOW()');
    if (req.query.due === 'today') where.push('DATE(r.remind_at) = CURDATE()');
    if (req.query.due === 'upcoming') where.push('r.is_completed = 0 AND r.remind_at >= NOW()');
    if (req.query.search) {
      where.push('(r.title LIKE ? OR l.name LIKE ? OR l.phone LIKE ?)');
      const like = `%${req.query.search}%`;
      params.push(like, like, like);
    }

    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const order = req.query.completed === 'true' ? 'r.completed_at DESC, r.remind_at DESC' : 'r.is_completed ASC, r.remind_at ASC';
    const selectSql = `SELECT r.*,
        l.name AS lead_name, l.phone AS lead_phone, l.status AS lead_status, l.archived_at AS lead_archived_at,
        l.whatsapp_active AS lead_whatsapp, l.address AS lead_address, l.maps_url AS lead_maps_url,
        l.business_profile_url AS lead_business_profile_url, l.latitude AS lead_latitude, l.longitude AS lead_longitude,
        l.assigned_to AS lead_assigned_to, au.name AS lead_assigned_name,
        p.name AS product_name, u.name AS user_name
      FROM reminders r
      INNER JOIN leads l ON l.id = r.lead_id
      LEFT JOIN products p ON p.id = r.product_id
      LEFT JOIN users u ON u.id = r.user_id
      LEFT JOIN users au ON au.id = l.assigned_to
      ${clause}
      ORDER BY ${order}`;

    const pg = parsePagination(req.query);
    if (pg.paginate) {
      const [[{ total }]] = await pool.query(
        `SELECT COUNT(*) AS total FROM reminders r INNER JOIN leads l ON l.id = r.lead_id ${clause}`,
        params
      );
      const [rows] = await pool.query(`${selectSql} LIMIT ? OFFSET ?`, [...params, pg.limit, pg.offset]);
      return res.json(pageResult(rows, total, pg));
    }
    const [rows] = await pool.query(selectSql, params);
    return res.json(rows);
  })
);

router.post(
  '/',
  authorize('admin', 'sales'),
  body('lead_id').notEmpty().withMessage('Lead is required'),
  body('remind_at').notEmpty().withMessage('Callback date/time is required'),
  body('priority').optional().isIn(PRIORITIES),
  body('title').optional().trim(),
  validate,
  asyncHandler(async (req, res) => {
    const { lead_id: leadId, title, description = null, remind_at: remindAt, user_id: userId, priority = 'normal' } = req.body;
    // Sales users may only schedule callbacks on their own leads.
    const lead = await getLeadForUser(leadId, req.user, pool, { includeArchived: false });
    // A callback is always for the lead's own product.
    const productId = await assertProduct(lead.product_id);
    const ownerId = await resolveOwner(req, userId);
    const reminderTitle = title && title.trim() ? title.trim() : `Callback: ${lead.name}`;

    const [result] = await pool.query(
      `INSERT INTO reminders (lead_id, product_id, user_id, title, description, priority, remind_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [lead.id, productId, ownerId, reminderTitle, emptyToNull(description), priority, remindAt]
    );
    await touchActivity(lead.id);
    return res.status(201).json({ id: result.insertId, message: 'Callback reminder created' });
  })
);

router.put(
  '/:id',
  authorize('admin', 'sales'),
  body('priority').optional().isIn(PRIORITIES),
  validate,
  asyncHandler(async (req, res) => {
    const existing = await getOwnedReminder(req.params.id, req.user);
    if (req.body.lead_id !== undefined && !req.body.lead_id) throw badRequest('Lead is required');

    const changes = {};
    for (const field of ['title', 'description', 'remind_at', 'priority']) {
      if (req.body[field] !== undefined) changes[field] = emptyToNull(req.body[field]);
    }
    if (changes.title === null) throw badRequest('Title is required');
    // The product can't be picked separately: it always follows the lead.
    if (req.body.lead_id !== undefined) {
      const lead = await getLeadForUser(req.body.lead_id, req.user);
      changes.lead_id = lead.id;
      changes.product_id = lead.product_id;
    }
    if (req.body.user_id !== undefined && req.user.role === 'admin') changes.user_id = await resolveOwner(req, req.body.user_id);
    if (req.body.is_completed !== undefined) {
      const done = toBool(req.body.is_completed);
      changes.is_completed = done ? 1 : 0;
      if (done && !existing.is_completed) changes.completed_at = formatMysqlDateTime();
      if (!done) changes.completed_at = null;
    }
    if (!Object.keys(changes).length) throw badRequest('No fields to update');

    await pool.query('UPDATE reminders SET ? WHERE id = ?', [changes, req.params.id]);
    if (changes.is_completed) await touchActivity(existing.lead_id);
    return res.json({ message: 'Reminder updated' });
  })
);

/** Complete a callback, optionally logging what happened on the lead's timeline. */
router.post(
  '/:id/complete',
  authorize('admin', 'sales'),
  asyncHandler(async (req, res) => {
    const reminder = await getOwnedReminder(req.params.id, req.user);
    await pool.query('UPDATE reminders SET is_completed = 1, completed_at = NOW() WHERE id = ?', [reminder.id]);
    const outcome = emptyToNull(req.body.outcome);
    const note = emptyToNull(req.body.note);
    if (outcome || note) {
      const type = ['call', 'message', 'email', 'note', 'whatsapp', 'meeting'].includes(req.body.type) ? req.body.type : 'call';
      await pool.query(
        `INSERT INTO communications (lead_id, user_id, type, direction, subject, content, outcome, occurred_at)
         VALUES (?, ?, ?, 'outbound', ?, ?, ?, NOW())`,
        [reminder.lead_id, req.user.id, type, reminder.title, note, outcome]
      );
    }
    await touchActivity(reminder.lead_id);
    return res.json({ message: 'Callback completed' });
  })
);

/** Push a callback later: { minutes } or { until: 'YYYY-MM-DD HH:mm:ss' }. */
router.post(
  '/:id/snooze',
  authorize('admin', 'sales'),
  asyncHandler(async (req, res) => {
    const reminder = await getOwnedReminder(req.params.id, req.user);
    let until;
    if (req.body.until) {
      const text = String(req.body.until).trim().replace('T', ' ');
      const match = /^(\d{4}-\d{2}-\d{2}) (\d{2}):(\d{2})(?::(\d{2}))?$/.exec(text);
      const parsed = match ? new Date(`${match[1]}T${match[2]}:${match[3]}:${match[4] || '00'}+05:30`) : null;
      if (!parsed || Number.isNaN(parsed.getTime())) throw badRequest('Snooze time must be YYYY-MM-DD HH:mm:ss');
      if (parsed.getTime() <= Date.now()) throw badRequest('Snooze time must be in the future');
      until = formatMysqlDateTime(parsed);
    } else {
      const minutes = Number(req.body.minutes);
      if (!minutes || minutes < 1 || minutes > 60 * 24 * 30) throw badRequest('Choose how long to snooze');
      until = formatMysqlDateTime(new Date(Date.now() + minutes * 60000));
    }
    await pool.query('UPDATE reminders SET remind_at = ?, is_completed = 0, completed_at = NULL WHERE id = ?', [until, reminder.id]);
    return res.json({ message: 'Callback snoozed', remind_at: until });
  })
);

router.delete(
  '/:id',
  authorize('admin', 'sales'),
  asyncHandler(async (req, res) => {
    await getOwnedReminder(req.params.id, req.user);
    await pool.query('DELETE FROM reminders WHERE id = ?', [req.params.id]);
    return res.json({ message: 'Reminder deleted' });
  })
);

module.exports = router;
