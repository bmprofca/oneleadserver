const express = require('express');
const { body, validationResult } = require('express-validator');
const pool = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');

const router = express.Router();

router.use(authenticate);

const STATUSES = ['scheduled', 'completed', 'cancelled', 'no_show'];
const PLATFORMS = ['meet', 'call', 'zoom', 'teams', 'in_person', 'other'];

const resolveAssignee = async (req, userId) => {
  if (req.user.role === 'sales') {
    return req.user.id;
  }

  if (userId === '' || userId === null || userId === undefined) {
    return null;
  }

  const id = Number(userId);
  if (!id) return null;

  const [rows] = await pool.query(
    `SELECT id FROM users WHERE id = ? AND role = 'sales' AND status = 'active' LIMIT 1`,
    [id]
  );
  if (!rows.length) {
    const err = new Error('Appointments can only be assigned to sales staff');
    err.status = 400;
    throw err;
  }
  return id;
};

router.get('/', async (req, res) => {
  try {
    const where = [];
    const params = [];

    if (req.user.role === 'sales') {
      where.push('a.user_id = ?');
      params.push(req.user.id);
    }

    if (req.query.status) {
      where.push('a.status = ?');
      params.push(req.query.status);
    }

    if (req.query.lead_id) {
      where.push('a.lead_id = ?');
      params.push(req.query.lead_id);
    }

    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const [rows] = await pool.query(
      `SELECT a.*,
              l.name AS lead_name,
              u.name AS assigned_name
       FROM appointments a
       LEFT JOIN leads l ON l.id = a.lead_id
       LEFT JOIN users u ON u.id = a.user_id
       ${clause}
       ORDER BY a.start_at ASC`,
      params
    );

    return res.json(rows);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: 'Failed to fetch appointments' });
  }
});

router.post(
  '/',
  authorize('admin', 'sales'),
  body('title').trim().notEmpty(),
  body('start_at').notEmpty(),
  body('platform').optional().isIn(PLATFORMS),
  body('status').optional().isIn(STATUSES),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const {
      lead_id = null,
      title,
      description = null,
      location = null,
      platform = 'call',
      start_at,
      end_at = null,
      status = 'scheduled',
      user_id,
      assigned_to,
    } = req.body;

    try {
      const assignee = await resolveAssignee(
        req,
        assigned_to !== undefined ? assigned_to : user_id
      );

      const [result] = await pool.query(
        `INSERT INTO appointments
         (lead_id, user_id, title, description, location, platform, start_at, end_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [lead_id || null, assignee, title, description, location, platform, start_at, end_at, status]
      );
      return res.status(201).json({ id: result.insertId, message: 'Appointment created' });
    } catch (err) {
      console.error(err);
      return res
        .status(err.status || 500)
        .json({ message: err.message || 'Failed to create appointment' });
    }
  }
);

router.put('/:id', authorize('admin', 'sales'), async (req, res) => {
  try {
    const [existing] = await pool.query(
      'SELECT * FROM appointments WHERE id = ? LIMIT 1',
      [req.params.id]
    );
    if (!existing.length) {
      return res.status(404).json({ message: 'Appointment not found' });
    }
    if (req.user.role !== 'admin' && existing[0].user_id !== req.user.id) {
      return res.status(403).json({ message: 'Access denied' });
    }

    if (req.body.status && !STATUSES.includes(req.body.status)) {
      return res.status(400).json({ message: 'Invalid status' });
    }
    if (req.body.platform && !PLATFORMS.includes(req.body.platform)) {
      return res.status(400).json({ message: 'Invalid platform' });
    }

    const fields = [
      'title',
      'description',
      'location',
      'platform',
      'start_at',
      'end_at',
      'status',
      'lead_id',
    ];
    const updates = [];
    const values = [];

    fields.forEach((field) => {
      if (req.body[field] !== undefined) {
        updates.push(`${field} = ?`);
        values.push(req.body[field] === '' ? null : req.body[field]);
      }
    });

    if (req.user.role === 'admin' && (req.body.assigned_to !== undefined || req.body.user_id !== undefined)) {
      const raw =
        req.body.assigned_to !== undefined ? req.body.assigned_to : req.body.user_id;
      const assignee = await resolveAssignee(req, raw);
      updates.push('user_id = ?');
      values.push(assignee);
    }

    if (!updates.length) {
      return res.status(400).json({ message: 'No fields to update' });
    }

    values.push(req.params.id);
    await pool.query(`UPDATE appointments SET ${updates.join(', ')} WHERE id = ?`, values);
    return res.json({ message: 'Appointment updated' });
  } catch (err) {
    console.error(err);
    return res
      .status(err.status || 500)
      .json({ message: err.message || 'Failed to update appointment' });
  }
});

router.delete('/:id', authorize('admin', 'sales'), async (req, res) => {
  try {
    const [existing] = await pool.query(
      'SELECT * FROM appointments WHERE id = ? LIMIT 1',
      [req.params.id]
    );
    if (!existing.length) {
      return res.status(404).json({ message: 'Appointment not found' });
    }
    if (req.user.role !== 'admin' && existing[0].user_id !== req.user.id) {
      return res.status(403).json({ message: 'Access denied' });
    }

    await pool.query('DELETE FROM appointments WHERE id = ?', [req.params.id]);
    return res.json({ message: 'Appointment deleted' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: 'Failed to delete appointment' });
  }
});

module.exports = router;
