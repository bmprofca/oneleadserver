const express = require('express');
const { body, validationResult } = require('express-validator');
const pool = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');

const router = express.Router();

router.use(authenticate);

router.get('/', async (req, res) => {
  try {
    const { status, search, page, limit } = req.query;
    const where = [];
    const params = [];

    if (status) {
      where.push('p.status = ?');
      params.push(status);
    }

    if (search) {
      where.push('(p.name LIKE ? OR p.description LIKE ?)');
      const like = `%${search}%`;
      params.push(like, like);
    }

    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const paginate = page !== undefined || limit !== undefined;
    const pageNum = Math.max(1, Number(page) || 1);
    const pageSize = [5, 10, 20, 50, 100].includes(Number(limit))
      ? Number(limit)
      : 20;
    const offset = (pageNum - 1) * pageSize;

    if (paginate) {
      const [countRows] = await pool.query(
        `SELECT COUNT(*) AS total FROM products p ${clause}`,
        params
      );
      const total = countRows[0].total || 0;
      const [rows] = await pool.query(
        `SELECT p.*,
                u.name AS created_by_name,
                (SELECT COUNT(*) FROM leads l WHERE l.product_id = p.id) AS lead_count
         FROM products p
         LEFT JOIN users u ON u.id = p.created_by
         ${clause}
         ORDER BY p.name ASC
         LIMIT ? OFFSET ?`,
        [...params, pageSize, offset]
      );
      return res.json({
        items: rows,
        total,
        page: pageNum,
        limit: pageSize,
        totalPages: Math.max(1, Math.ceil(total / pageSize)),
      });
    }

    const [rows] = await pool.query(
      `SELECT p.*,
              u.name AS created_by_name,
              (SELECT COUNT(*) FROM leads l WHERE l.product_id = p.id) AS lead_count
       FROM products p
       LEFT JOIN users u ON u.id = p.created_by
       ${clause}
       ORDER BY p.name ASC`,
      params
    );

    return res.json(rows);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: 'Failed to fetch products' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT p.*,
              (SELECT COUNT(*) FROM leads l WHERE l.product_id = p.id) AS lead_count
       FROM products p
       WHERE p.id = ?
       LIMIT 1`,
      [req.params.id]
    );
    if (!rows.length) {
      return res.status(404).json({ message: 'Product not found' });
    }
    return res.json(rows[0]);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: 'Failed to fetch product' });
  }
});

router.post(
  '/',
  authorize('admin'),
  body('name').trim().notEmpty(),
  body('status').optional().isIn(['active', 'inactive']),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { name, description = null, status = 'active' } = req.body;

    try {
      const [result] = await pool.query(
        `INSERT INTO products (name, description, status, created_by)
         VALUES (?, ?, ?, ?)`,
        [name, description, status, req.user.id]
      );
      return res.status(201).json({ id: result.insertId, message: 'Product created' });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ message: 'Failed to create product' });
    }
  }
);

router.put(
  '/:id',
  authorize('admin'),
  body('status').optional().isIn(['active', 'inactive']),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const fields = ['name', 'description', 'status'];
    const updates = [];
    const values = [];

    fields.forEach((field) => {
      if (req.body[field] !== undefined) {
        updates.push(`${field} = ?`);
        values.push(req.body[field] === '' ? null : req.body[field]);
      }
    });

    if (!updates.length) {
      return res.status(400).json({ message: 'No fields to update' });
    }

    values.push(req.params.id);

    try {
      await pool.query(`UPDATE products SET ${updates.join(', ')} WHERE id = ?`, values);
      return res.json({ message: 'Product updated' });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ message: 'Failed to update product' });
    }
  }
);

router.delete('/:id', authorize('admin'), async (req, res) => {
  try {
    const [[leadCount]] = await pool.query(
      'SELECT COUNT(*) AS total FROM leads WHERE product_id = ?',
      [req.params.id]
    );
    const linked = Number(leadCount.total) || 0;
    if (linked > 0) {
      return res.status(409).json({
        message: `Cannot delete this product because it has ${linked} linked lead(s). Reassign or remove those leads first.`,
      });
    }

    const [existing] = await pool.query('SELECT id FROM products WHERE id = ? LIMIT 1', [
      req.params.id,
    ]);
    if (!existing.length) {
      return res.status(404).json({ message: 'Product not found' });
    }

    await pool.query('DELETE FROM products WHERE id = ?', [req.params.id]);
    return res.json({ message: 'Product deleted' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: 'Failed to delete product' });
  }
});

module.exports = router;
