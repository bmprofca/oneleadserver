const express = require('express');
const { body } = require('express-validator');
const pool = require('../config/db');
const { authenticate } = require('../middleware/auth');
const { asyncHandler, validate, parsePagination, pageResult, forbidden, notFound, emptyToNull } = require('../lib/http');
const { getLeadForUser, touchActivity } = require('../services/leads');

const router = express.Router();
router.use(authenticate);

const TYPES = ['call', 'message', 'email', 'note', 'whatsapp', 'meeting'];
const DIRECTIONS = ['inbound', 'outbound'];

async function getOwned(id, user) {
  const [rows] = await pool.query('SELECT * FROM communications WHERE id = ? LIMIT 1', [id]);
  if (!rows.length) throw notFound('Activity not found');
  if (user.role !== 'admin' && rows[0].user_id !== user.id) throw forbidden('You can only change your own activities');
  return rows[0];
}

// Recent activity feed (lead_id optional). Sales users see activity on their own leads.
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const where = ['l.archived_at IS NULL'];
    const params = [];
    if (req.query.lead_id) {
      await getLeadForUser(req.query.lead_id, req.user);
      where.push('c.lead_id = ?');
      params.push(req.query.lead_id);
    }
    if (req.user.role === 'sales') {
      where.push('l.assigned_to = ?');
      params.push(req.user.id);
    } else if (req.query.user_id) {
      where.push('c.user_id = ?');
      params.push(Number(req.query.user_id));
    }
    if (req.query.type && TYPES.includes(req.query.type)) {
      where.push('c.type = ?');
      params.push(req.query.type);
    }
    const clause = `WHERE ${where.join(' AND ')}`;
    const pg = parsePagination({ limit: 20, ...req.query, page: req.query.page || 1 });
    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) AS total FROM communications c INNER JOIN leads l ON l.id = c.lead_id ${clause}`,
      params
    );
    const [rows] = await pool.query(
      `SELECT c.*, COALESCE(c.occurred_at, c.created_at) AS at, u.name AS user_name, l.name AS lead_name
       FROM communications c
       INNER JOIN leads l ON l.id = c.lead_id
       LEFT JOIN users u ON u.id = c.user_id
       ${clause}
       ORDER BY at DESC
       LIMIT ? OFFSET ?`,
      [...params, pg.limit, pg.offset]
    );
    return res.json(pageResult(rows, total, pg));
  })
);

router.post(
  '/',
  body('lead_id').notEmpty().withMessage('Lead is required'),
  body('type').isIn(TYPES).withMessage('Choose an activity type'),
  body('direction').optional().isIn(DIRECTIONS),
  body('duration_seconds').optional({ checkFalsy: true }).isInt({ min: 0, max: 86400 }),
  body('content').optional().isLength({ max: 20000 }),
  validate,
  asyncHandler(async (req, res) => {
    const lead = await getLeadForUser(req.body.lead_id, req.user, pool, { includeArchived: false });
    const { type, direction = 'outbound', subject, content, outcome, duration_seconds: duration, occurred_at: occurredAt } = req.body;
    if (!emptyToNull(subject) && !emptyToNull(content) && !emptyToNull(outcome)) {
      return res.status(400).json({ message: 'Add a summary, outcome or note' });
    }
    const [result] = await pool.query(
      `INSERT INTO communications (lead_id, user_id, type, direction, subject, content, outcome, duration_seconds, occurred_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, NOW()))`,
      [
        lead.id,
        req.user.id,
        type,
        direction,
        emptyToNull(subject),
        emptyToNull(content),
        emptyToNull(outcome),
        duration ? Number(duration) : null,
        emptyToNull(occurredAt),
      ]
    );
    await touchActivity(lead.id);
    return res.status(201).json({ id: result.insertId, message: 'Activity logged' });
  })
);

router.put(
  '/:id',
  body('type').optional().isIn(TYPES),
  body('direction').optional().isIn(DIRECTIONS),
  validate,
  asyncHandler(async (req, res) => {
    await getOwned(req.params.id, req.user);
    const changes = {};
    for (const field of ['type', 'direction', 'subject', 'content', 'outcome', 'duration_seconds', 'occurred_at']) {
      if (req.body[field] !== undefined) changes[field] = emptyToNull(req.body[field]);
    }
    if (!Object.keys(changes).length) return res.status(400).json({ message: 'No fields to update' });
    await pool.query('UPDATE communications SET ? WHERE id = ?', [changes, req.params.id]);
    return res.json({ message: 'Activity updated' });
  })
);

router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    await getOwned(req.params.id, req.user);
    await pool.query('DELETE FROM communications WHERE id = ?', [req.params.id]);
    return res.json({ message: 'Activity deleted' });
  })
);

module.exports = router;
