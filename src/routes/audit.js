const express = require('express');
const pool = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');
const { asyncHandler, parsePagination, pageResult } = require('../lib/http');

const router = express.Router();
router.use(authenticate, authorize('admin'));

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const where = [];
    const params = [];
    if (req.query.entity_type) {
      where.push('a.entity_type = ?');
      params.push(req.query.entity_type);
    }
    if (req.query.entity_id) {
      where.push('a.entity_id = ?');
      params.push(req.query.entity_id);
    }
    if (req.query.user_id) {
      where.push('a.user_id = ?');
      params.push(Number(req.query.user_id));
    }
    if (req.query.action) {
      where.push('a.action = ?');
      params.push(req.query.action);
    }
    if (req.query.from) {
      where.push('a.created_at >= ?');
      params.push(`${req.query.from} 00:00:00`);
    }
    if (req.query.to) {
      where.push('a.created_at <= ?');
      params.push(`${req.query.to} 23:59:59`);
    }
    if (req.query.search) {
      where.push('(a.summary LIKE ? OR a.entity_id LIKE ?)');
      params.push(`%${req.query.search}%`, `%${req.query.search}%`);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const pg = parsePagination({ ...req.query, page: req.query.page || 1 });
    const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM audit_logs a ${clause}`, params);
    const [rows] = await pool.query(
      `SELECT a.*, u.name AS user_name
       FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id
       ${clause}
       ORDER BY a.created_at DESC, a.id DESC
       LIMIT ? OFFSET ?`,
      [...params, pg.limit, pg.offset]
    );
    const items = rows.map((r) => {
      let changes = null;
      try {
        changes = r.changes ? JSON.parse(r.changes) : null;
      } catch {
        changes = null;
      }
      return { ...r, changes };
    });
    return res.json(pageResult(items, total, pg));
  })
);

module.exports = router;
