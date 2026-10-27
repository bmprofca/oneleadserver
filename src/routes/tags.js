const express = require('express');
const { body } = require('express-validator');
const pool = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');
const { asyncHandler, validate, notFound, conflict } = require('../lib/http');
const { audit } = require('../services/audit');

const router = express.Router();
router.use(authenticate);

const COLORS = ['slate', 'indigo', 'blue', 'sky', 'teal', 'emerald', 'lime', 'amber', 'orange', 'rose', 'pink', 'violet'];

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const scope = req.user.role === 'sales' ? 'AND l.assigned_to = ?' : '';
    const [rows] = await pool.query(
      `SELECT t.id, t.name, t.color, t.created_at,
              (SELECT COUNT(*) FROM lead_tags lt INNER JOIN leads l ON l.id = lt.lead_id
               WHERE lt.tag_id = t.id AND l.archived_at IS NULL ${scope}) AS lead_count
       FROM tags t ORDER BY t.name ASC`,
      req.user.role === 'sales' ? [req.user.id] : []
    );
    return res.json(rows.map((r) => ({ ...r, lead_count: Number(r.lead_count) || 0 })));
  })
);

// Any signed-in user can create tags; editing and deleting is admin-only.
router.post(
  '/',
  body('name').trim().notEmpty().withMessage('Tag name is required').isLength({ max: 60 }),
  body('color').optional().isIn(COLORS),
  validate,
  asyncHandler(async (req, res) => {
    const name = req.body.name.trim();
    const [existing] = await pool.query('SELECT id FROM tags WHERE name = ? LIMIT 1', [name]);
    if (existing.length) throw conflict('A tag with this name already exists', { id: existing[0].id });
    const [result] = await pool.query('INSERT INTO tags (name, color, created_by) VALUES (?, ?, ?)', [
      name,
      req.body.color || 'slate',
      req.user.id,
    ]);
    await audit(req, { entityType: 'tag', entityId: result.insertId, action: 'create', summary: `Created tag ${name}` });
    return res.status(201).json({ id: result.insertId, name, color: req.body.color || 'slate' });
  })
);

router.put(
  '/:id',
  authorize('admin'),
  body('name').optional().trim().notEmpty().isLength({ max: 60 }),
  body('color').optional().isIn(COLORS),
  validate,
  asyncHandler(async (req, res) => {
    const [rows] = await pool.query('SELECT * FROM tags WHERE id = ?', [req.params.id]);
    if (!rows.length) throw notFound('Tag not found');
    const changes = {};
    if (req.body.name !== undefined) changes.name = req.body.name.trim();
    if (req.body.color !== undefined) changes.color = req.body.color;
    if (!Object.keys(changes).length) return res.status(400).json({ message: 'No fields to update' });
    try {
      await pool.query('UPDATE tags SET ? WHERE id = ?', [changes, req.params.id]);
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') throw conflict('A tag with this name already exists');
      throw err;
    }
    await audit(req, { entityType: 'tag', entityId: req.params.id, action: 'update', summary: `Updated tag ${rows[0].name}` });
    return res.json({ message: 'Tag updated' });
  })
);

router.delete(
  '/:id',
  authorize('admin'),
  asyncHandler(async (req, res) => {
    const [rows] = await pool.query('SELECT * FROM tags WHERE id = ?', [req.params.id]);
    if (!rows.length) throw notFound('Tag not found');
    await pool.query('DELETE FROM tags WHERE id = ?', [req.params.id]);
    await audit(req, { entityType: 'tag', entityId: req.params.id, action: 'delete', summary: `Deleted tag ${rows[0].name}` });
    return res.json({ message: 'Tag deleted' });
  })
);

module.exports = router;
module.exports.COLORS = COLORS;
