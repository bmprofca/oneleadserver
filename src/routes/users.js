const express = require('express');
const { body, validationResult } = require('express-validator');
const pool = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');
const { normalizePhone } = require('../utils/otp');

const router = express.Router();

router.use(authenticate);

router.get('/', authorize('admin'), async (req, res) => {
  try {
    const { search, page, limit, status, role } = req.query;
    const where = ['id <> ?'];
    const params = [req.user.id];

    if (status) {
      where.push('status = ?');
      params.push(status);
    }
    if (role) {
      where.push('role = ?');
      params.push(role);
    }
    if (search) {
      where.push('(name LIKE ? OR email LIKE ? OR phone LIKE ?)');
      const like = `%${search}%`;
      params.push(like, like, like);
    }

    const clause = `WHERE ${where.join(' AND ')}`;
    const paginate = page !== undefined || limit !== undefined;
    const pageNum = Math.max(1, Number(page) || 1);
    const pageSize = [5, 10, 20, 50, 100].includes(Number(limit))
      ? Number(limit)
      : 20;
    const offset = (pageNum - 1) * pageSize;

    if (paginate) {
      const [countRows] = await pool.query(
        `SELECT COUNT(*) AS total FROM users ${clause}`,
        params
      );
      const total = countRows[0].total || 0;
      const [rows] = await pool.query(
        `SELECT id, name, email, role, phone, status, created_at
         FROM users
         ${clause}
         ORDER BY created_at DESC
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
      `SELECT id, name, email, role, phone, status, created_at
       FROM users
       ${clause}
       ORDER BY created_at DESC`,
      params
    );
    return res.json(rows);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: 'Failed to fetch users' });
  }
});

router.get('/assignable', async (req, res) => {
  try {
    const { search, page, limit } = req.query;
    const where = [`status = 'active'`, `role = 'sales'`];
    const params = [];

    if (search) {
      where.push('(name LIKE ? OR email LIKE ? OR phone LIKE ?)');
      const like = `%${search}%`;
      params.push(like, like, like);
    }

    const clause = `WHERE ${where.join(' AND ')}`;
    const paginate = page !== undefined || limit !== undefined;
    const pageNum = Math.max(1, Number(page) || 1);
    const pageSize = [5, 10, 20, 50, 100].includes(Number(limit))
      ? Number(limit)
      : 20;
    const offset = (pageNum - 1) * pageSize;

    if (paginate) {
      const [countRows] = await pool.query(
        `SELECT COUNT(*) AS total FROM users ${clause}`,
        params
      );
      const total = countRows[0].total || 0;
      const [rows] = await pool.query(
        `SELECT id, name, email, role, phone FROM users
         ${clause}
         ORDER BY name ASC
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
      `SELECT id, name, email, role, phone FROM users
       ${clause}
       ORDER BY name ASC`,
      params
    );
    return res.json(rows);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: 'Failed to fetch assignable users' });
  }
});

router.post(
  '/',
  authorize('admin'),
  body('name').trim().notEmpty(),
  body('phone').trim().notEmpty(),
  body('email').optional({ checkFalsy: true }).isEmail(),
  body('role').isIn(['admin', 'sales']),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const phone = normalizePhone(req.body.phone);
    if (phone.length < 10) {
      return res.status(400).json({ message: 'Enter a valid mobile number' });
    }

    const { name, email = null, role, status = 'active' } = req.body;

    try {
      const [result] = await pool.query(
        `INSERT INTO users (name, email, role, phone, status)
         VALUES (?, ?, ?, ?, ?)`,
        [name, email || `${phone}@onelead.local`, role, phone, status]
      );

      return res.status(201).json({
        id: result.insertId,
        name,
        email: email || `${phone}@onelead.local`,
        role,
        phone,
        status,
      });
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') {
        return res.status(409).json({ message: 'Phone or email already exists' });
      }
      console.error(err);
      return res.status(500).json({ message: 'Failed to create user' });
    }
  }
);

router.put(
  '/:id',
  authorize('admin'),
  body('name').optional().trim().notEmpty(),
  body('status').optional().isIn(['active', 'inactive']),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    if (Number(req.params.id) === Number(req.user.id)) {
      return res.status(400).json({ message: 'You cannot update your own account here' });
    }

    if (req.body.role !== undefined) {
      return res.status(400).json({ message: 'User role cannot be changed' });
    }

    const { name, phone, status, email } = req.body;
    const fields = [];
    const values = [];

    if (name !== undefined) {
      fields.push('name = ?');
      values.push(name);
    }
    if (email !== undefined) {
      fields.push('email = ?');
      values.push(email);
    }
    if (phone !== undefined) {
      const normalized = normalizePhone(phone);
      if (normalized.length < 10) {
        return res.status(400).json({ message: 'Enter a valid mobile number' });
      }
      fields.push('phone = ?');
      values.push(normalized);
    }
    if (status !== undefined) {
      fields.push('status = ?');
      values.push(status);
    }

    if (!fields.length) {
      return res.status(400).json({ message: 'No fields to update' });
    }

    values.push(req.params.id);

    try {
      await pool.query(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`, values);
      return res.json({ message: 'User updated' });
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') {
        return res.status(409).json({ message: 'Phone or email already exists' });
      }
      console.error(err);
      return res.status(500).json({ message: 'Failed to update user' });
    }
  }
);

module.exports = router;
