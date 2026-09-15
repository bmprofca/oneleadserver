const express = require('express');
const { body, validationResult } = require('express-validator');
const pool = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');

const router = express.Router();

router.use(authenticate);

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

router.get('/', async (req, res) => {
  try {
    const where = [];
    const params = [];

    if (req.user.role !== 'admin') {
      where.push('r.user_id = ?');
      params.push(req.user.id);
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

    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const paginate = req.query.page !== undefined || req.query.limit !== undefined;
    const pageNum = Math.max(1, Number(req.query.page) || 1);
    const pageSize = [5, 10, 20, 50, 100].includes(Number(req.query.limit))
      ? Number(req.query.limit)
      : 20;
    const offset = (pageNum - 1) * pageSize;

    const selectSql = `SELECT r.*,
              l.name AS lead_name,
              l.phone AS lead_phone,
              p.name AS product_name,
              u.name AS user_name
       FROM reminders r
       INNER JOIN leads l ON l.id = r.lead_id
       LEFT JOIN products p ON p.id = r.product_id
       LEFT JOIN users u ON u.id = r.user_id
       ${clause}
       ORDER BY r.remind_at ASC`;

    if (paginate) {
      const [countRows] = await pool.query(
        `SELECT COUNT(*) AS total
         FROM reminders r
         INNER JOIN leads l ON l.id = r.lead_id
         ${clause}`,
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
    return res.status(500).json({ message: 'Failed to fetch reminders' });
  }
});

router.post(
  '/',
  authorize('admin', 'sales'),
  body('lead_id').notEmpty().withMessage('Lead is required'),
  body('product_id').notEmpty().withMessage('Product is required'),
  body('remind_at').notEmpty().withMessage('Callback date/time is required'),
  body('title').optional().trim(),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const {
      lead_id,
      product_id,
      title,
      description = null,
      remind_at,
      user_id,
    } = req.body;

    const ownerId =
      req.user.role === 'admin' && user_id ? user_id : req.user.id;

    try {
      const productId = await assertProduct(product_id);

      const [lead] = await pool.query(
        'SELECT id, name FROM leads WHERE id = ? LIMIT 1',
        [lead_id]
      );
      if (!lead.length) {
        return res.status(400).json({ message: 'Select a valid lead' });
      }

      const reminderTitle =
        title && title.trim()
          ? title.trim()
          : `Callback: ${lead[0].name}`;

      const [result] = await pool.query(
        `INSERT INTO reminders (lead_id, product_id, user_id, title, description, remind_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [lead_id, productId, ownerId, reminderTitle, description, remind_at]
      );
      return res.status(201).json({ id: result.insertId, message: 'Callback reminder created' });
    } catch (err) {
      console.error(err);
      return res
        .status(err.status || 500)
        .json({ message: err.message || 'Failed to create reminder' });
    }
  }
);

router.put('/:id', authorize('admin', 'sales'), async (req, res) => {
  try {
    const [existing] = await pool.query('SELECT * FROM reminders WHERE id = ? LIMIT 1', [
      req.params.id,
    ]);
    if (!existing.length) {
      return res.status(404).json({ message: 'Reminder not found' });
    }
    if (req.user.role !== 'admin' && existing[0].user_id !== req.user.id) {
      return res.status(403).json({ message: 'Access denied' });
    }

    if (req.body.lead_id !== undefined && !req.body.lead_id) {
      return res.status(400).json({ message: 'Lead is required' });
    }
    if (req.body.product_id !== undefined && !req.body.product_id) {
      return res.status(400).json({ message: 'Product is required' });
    }

    const fields = ['title', 'description', 'remind_at', 'lead_id', 'product_id', 'is_completed'];
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
      values.push(req.body[field]);
    }

    if (!updates.length) {
      return res.status(400).json({ message: 'No fields to update' });
    }

    values.push(req.params.id);
    await pool.query(`UPDATE reminders SET ${updates.join(', ')} WHERE id = ?`, values);
    return res.json({ message: 'Reminder updated' });
  } catch (err) {
    console.error(err);
    return res
      .status(err.status || 500)
      .json({ message: err.message || 'Failed to update reminder' });
  }
});

router.delete('/:id', authorize('admin', 'sales'), async (req, res) => {
  try {
    const [existing] = await pool.query('SELECT * FROM reminders WHERE id = ? LIMIT 1', [
      req.params.id,
    ]);
    if (!existing.length) {
      return res.status(404).json({ message: 'Reminder not found' });
    }
    if (req.user.role !== 'admin' && existing[0].user_id !== req.user.id) {
      return res.status(403).json({ message: 'Access denied' });
    }

    await pool.query('DELETE FROM reminders WHERE id = ?', [req.params.id]);
    return res.json({ message: 'Reminder deleted' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: 'Failed to delete reminder' });
  }
});

module.exports = router;
