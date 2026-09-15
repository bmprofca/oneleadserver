const express = require('express');
const { body, validationResult } = require('express-validator');
const pool = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');

const router = express.Router();

router.use(authenticate);

const STATUSES = ['scheduled', 'completed', 'cancelled', 'no_show'];
const PLATFORMS = ['meet', 'call', 'zoom', 'teams', 'in_person', 'other'];

async function assertProduct(productId) {
  const id = Number(productId);
  if (!id) {
    const err = new Error('Product is required');
    err.status = 400;
    throw err;
  }
  const [rows] = await pool.query(
    'SELECT id FROM products WHERE id = ? LIMIT 1',
    [id]
  );
  if (!rows.length) {
    const err = new Error('Select a valid product');
    err.status = 400;
    throw err;
  }
  return id;
}

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

    if (req.query.product_id) {
      where.push('a.product_id = ?');
      params.push(req.query.product_id);
    }

    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const paginate = req.query.page !== undefined || req.query.limit !== undefined;
    const pageNum = Math.max(1, Number(req.query.page) || 1);
    const pageSize = [5, 10, 20, 50, 100].includes(Number(req.query.limit))
      ? Number(req.query.limit)
      : 20;
    const offset = (pageNum - 1) * pageSize;

    const selectSql = `SELECT a.*,
              l.name AS lead_name,
              p.name AS product_name,
              u.name AS assigned_name
       FROM appointments a
       LEFT JOIN leads l ON l.id = a.lead_id
       LEFT JOIN products p ON p.id = a.product_id
       LEFT JOIN users u ON u.id = a.user_id
       ${clause}
       ORDER BY a.start_at ASC`;

    if (paginate) {
      const [countRows] = await pool.query(
        `SELECT COUNT(*) AS total FROM appointments a ${clause}`,
        params
      );
      const total = countRows[0].total || 0;
      const [rows] = await pool.query(`${selectSql} LIMIT ? OFFSET ?`, [
        ...params,
        pageSize,
        offset,
      ]);
      return res.json({
        items: rows,
        total,
        page: pageNum,
        limit: pageSize,
        totalPages: Math.max(1, Math.ceil(total / pageSize)),
      });
    }

    const [rows] = await pool.query(selectSql, params);
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
  body('product_id').notEmpty().withMessage('Product is required'),
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
      product_id,
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
      const productId = await assertProduct(product_id);
      const assignee = await resolveAssignee(
        req,
        assigned_to !== undefined ? assigned_to : user_id
      );

      const [result] = await pool.query(
        `INSERT INTO appointments
         (lead_id, product_id, user_id, title, description, location, platform, start_at, end_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          lead_id || null,
          productId,
          assignee,
          title,
          description,
          location,
          platform,
          start_at,
          end_at,
          status,
        ]
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
    if (req.body.product_id !== undefined && !req.body.product_id) {
      return res.status(400).json({ message: 'Product is required' });
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
      'product_id',
    ];
    const updates = [];
    const values = [];

    for (const field of fields) {
      if (req.body[field] === undefined) continue;
      if (field === 'product_id') {
        updates.push('product_id = ?');
        values.push(await assertProduct(req.body.product_id));
        continue;
      }
      updates.push(`${field} = ?`);
      values.push(req.body[field] === '' ? null : req.body[field]);
    }

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
