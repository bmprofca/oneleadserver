const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const { body, validationResult } = require('express-validator');
const pool = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
});

router.use(authenticate);

const STATUSES = ['new', 'contacted', 'qualified', 'proposal', 'negotiation', 'won', 'lost'];

const logStatusChange = async (conn, { leadId, fromStatus, toStatus, changedBy }) => {
  if (!toStatus || fromStatus === toStatus) return;
  await conn.query(
    `INSERT INTO lead_status_history (lead_id, from_status, to_status, changed_by)
     VALUES (?, ?, ?, ?)`,
    [leadId, fromStatus || null, toStatus, changedBy || null]
  );
};

const getLeadRelationCounts = async (leadId) => {
  const [[reminders]] = await pool.query(
    'SELECT COUNT(*) AS total FROM reminders WHERE lead_id = ?',
    [leadId]
  );
  const [[appointments]] = await pool.query(
    'SELECT COUNT(*) AS total FROM appointments WHERE lead_id = ?',
    [leadId]
  );
  const [[communications]] = await pool.query(
    'SELECT COUNT(*) AS total FROM communications WHERE lead_id = ?',
    [leadId]
  );
  return {
    reminders: Number(reminders.total) || 0,
    appointments: Number(appointments.total) || 0,
    communications: Number(communications.total) || 0,
  };
};

const assertLeadDeletable = async (leadId) => {
  const counts = await getLeadRelationCounts(leadId);
  const blockers = [];
  if (counts.reminders) blockers.push(`${counts.reminders} reminder(s)`);
  if (counts.appointments) blockers.push(`${counts.appointments} appointment(s)`);
  if (counts.communications) blockers.push(`${counts.communications} communication(s)`);
  if (blockers.length) {
    const err = new Error(
      `Cannot delete this lead because it has ${blockers.join(', ')}. Remove those records first.`
    );
    err.status = 409;
    throw err;
  }
};

const pickFirstEmail = (value) => {
  if (!value || String(value).includes('Waiting for processing')) return null;
  const first = String(value)
    .split(',')
    .map((v) => v.trim())
    .find(Boolean);
  return first || null;
};

const cleanText = (value) => {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  if (!text || text.includes('Waiting for processing')) return null;
  return text;
};

router.get('/', async (req, res) => {
  try {
    const { status, search, assigned_to, product_id, page, limit } = req.query;
    const where = [];
    const params = [];

    if (req.user.role === 'sales') {
      where.push('l.assigned_to = ?');
      params.push(req.user.id);
    }

    if (status) {
      where.push('l.status = ?');
      params.push(status);
    }

    if (product_id) {
      where.push('l.product_id = ?');
      params.push(product_id);
    }

    if (assigned_to === 'unassigned') {
      where.push('l.assigned_to IS NULL');
    } else if (assigned_to && req.user.role !== 'sales') {
      where.push('l.assigned_to = ?');
      params.push(assigned_to);
    }

    if (search) {
      where.push(
        '(l.name LIKE ? OR l.email LIKE ? OR l.phone LIKE ? OR l.company LIKE ? OR l.id LIKE ? OR l.address LIKE ?)'
      );
      const like = `%${search}%`;
      params.push(like, like, like, like, like, like);
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
        `SELECT COUNT(*) AS total FROM leads l ${clause}`,
        params
      );
      const total = countRows[0].total || 0;

      const [rows] = await pool.query(
        `SELECT l.*,
                u.name AS assigned_name,
                c.name AS created_by_name,
                p.name AS product_name,
                (
                  SELECT r.remind_at
                  FROM reminders r
                  WHERE r.lead_id = l.id AND r.is_completed = 0
                  ORDER BY r.remind_at ASC
                  LIMIT 1
                ) AS next_callback
         FROM leads l
         LEFT JOIN users u ON u.id = l.assigned_to
         LEFT JOIN users c ON c.id = l.created_by
         LEFT JOIN products p ON p.id = l.product_id
         ${clause}
         ORDER BY l.updated_at DESC
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
      `SELECT l.*,
              u.name AS assigned_name,
              c.name AS created_by_name,
              p.name AS product_name,
              (
                SELECT r.remind_at
                FROM reminders r
                WHERE r.lead_id = l.id AND r.is_completed = 0
                ORDER BY r.remind_at ASC
                LIMIT 1
              ) AS next_callback
       FROM leads l
       LEFT JOIN users u ON u.id = l.assigned_to
       LEFT JOIN users c ON c.id = l.created_by
       LEFT JOIN products p ON p.id = l.product_id
       ${clause}
       ORDER BY l.updated_at DESC`,
      params
    );

    return res.json(rows);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: 'Failed to fetch leads' });
  }
});

router.get('/stats', async (req, res) => {
  try {
    const { search, product_id, assigned_to } = req.query;
    const where = [];
    const params = [];

    if (req.user.role === 'sales') {
      where.push('assigned_to = ?');
      params.push(req.user.id);
    }

    if (product_id) {
      where.push('product_id = ?');
      params.push(product_id);
    }

    if (assigned_to === 'unassigned') {
      where.push('assigned_to IS NULL');
    } else if (assigned_to && req.user.role !== 'sales') {
      where.push('assigned_to = ?');
      params.push(assigned_to);
    }

    if (search) {
      where.push(
        '(name LIKE ? OR email LIKE ? OR phone LIKE ? OR company LIKE ? OR id LIKE ? OR address LIKE ?)'
      );
      const like = `%${search}%`;
      params.push(like, like, like, like, like, like);
    }

    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const [rows] = await pool.query(
      `SELECT
         COUNT(*) AS total,
         SUM(status = 'new') AS new_count,
         SUM(status = 'contacted') AS contacted_count,
         SUM(status IN ('qualified','proposal','negotiation')) AS in_progress_count,
         SUM(status = 'won') AS won_count,
         SUM(status = 'lost') AS lost_count,
         SUM(assigned_to IS NULL) AS unassigned_count
       FROM leads
       ${clause}`,
      params
    );

    return res.json(rows[0] || {});
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: 'Failed to fetch lead stats' });
  }
});

router.post(
  '/import',
  authorize('admin', 'sales'),
  upload.single('file'),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ message: 'Excel or CSV file is required' });
      }

      const originalName = String(req.file.originalname || '').toLowerCase();
      const allowedExt = ['.xlsx', '.xls', '.csv'];
      if (!allowedExt.some((ext) => originalName.endsWith(ext))) {
        return res
          .status(400)
          .json({ message: 'Only .xlsx, .xls, or .csv files are supported' });
      }

      const rawProductIds = req.body.product_ids || req.body.product_id;
      let productIds = [];
      if (Array.isArray(rawProductIds)) {
        productIds = rawProductIds;
      } else if (typeof rawProductIds === 'string') {
        try {
          const parsed = JSON.parse(rawProductIds);
          productIds = Array.isArray(parsed) ? parsed : [rawProductIds];
        } catch {
          productIds = rawProductIds.split(',').map((v) => v.trim());
        }
      }

      productIds = [...new Set(productIds.map((id) => Number(id)).filter(Boolean))];
      if (!productIds.length) {
        return res.status(400).json({ message: 'At least one product is required for import' });
      }

      const [products] = await pool.query(
        `SELECT id FROM products WHERE id IN (?) AND status = 'active'`,
        [productIds]
      );
      if (products.length !== productIds.length) {
        return res.status(400).json({ message: 'Select valid active products' });
      }

      const workbook = XLSX.read(req.file.buffer, {
        type: 'buffer',
        raw: false,
      });
      const sheetName = workbook.SheetNames[0];
      if (!sheetName) {
        return res.status(400).json({ message: 'File has no readable sheet or data' });
      }
      const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], {
        defval: '',
      });

      if (!rows.length) {
        return res.status(400).json({ message: 'File has no rows' });
      }

      let imported = 0;
      let skipped = 0;
      let duplicates = 0;
      const multi = productIds.length > 1;

      for (const productId of productIds) {
        for (const row of rows) {
          const sourceId = cleanText(row.ID || row.Id || row.id);
          const name = cleanText(row.Name || row.name);
          if (!sourceId || !name) {
            skipped += 1;
            continue;
          }

          const id = multi ? `${sourceId}::${productId}` : sourceId;

          const [existing] = await pool.query(
            'SELECT id FROM leads WHERE id = ? LIMIT 1',
            [id]
          );

          if (existing.length) {
            duplicates += 1;
            continue;
          }

          await pool.query(
            `INSERT INTO leads (
              id, product_id, name, email, phone, company, address, website, category,
              open_hours, rating, rating_info, latitude, longitude, maps_url,
              featured_image, social_medias, facebook, instagram, twitter,
              source, status, assigned_to, created_by
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              id,
              productId,
              name,
              pickFirstEmail(row.Emails || row.Email || row.emails),
              cleanText(row.Phone || row.phone),
              null,
              cleanText(row.Address || row.address),
              cleanText(row.Website || row.website),
              cleanText(row.Category || row.category),
              cleanText(row['Open Hours'] || row.open_hours),
              cleanText(row.Rating || row.rating),
              cleanText(row['Rating Info'] || row.rating_info),
              row.Latitude || row.latitude || null,
              row.Longitude || row.longitude || null,
              cleanText(row['Bing Maps URL'] || row.maps_url),
              cleanText(row['Featured image'] || row.featured_image),
              cleanText(row['Social Medias'] || row.social_medias),
              cleanText(row.Facebook || row.facebook),
              cleanText(row.Instagram || row.instagram),
              cleanText(row.Twitter || row.twitter),
              'maps-import',
              'new',
              req.user.role === 'sales' ? req.user.id : null,
              req.user.id,
            ]
          );
          imported += 1;
        }
      }

      return res.json({
        message: 'Import completed',
        imported,
        duplicates,
        skipped,
        total: rows.length * productIds.length,
        products: productIds.length,
      });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ message: 'Failed to import leads' });
    }
  }
);

router.post(
  '/bulk',
  authorize('admin', 'sales'),
  body('ids').isArray({ min: 1 }),
  body('action').isIn(['assign', 'status', 'delete']),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { ids, action, assigned_to, status } = req.body;

    try {
      if (action === 'delete') {
        if (req.user.role !== 'admin') {
          return res.status(403).json({ message: 'Only admin can delete leads' });
        }
        for (const id of ids) {
          await assertLeadDeletable(id);
        }
        await pool.query(`DELETE FROM leads WHERE id IN (?)`, [ids]);
        return res.json({ message: `${ids.length} lead(s) deleted` });
      }

      if (action === 'assign') {
        if (req.user.role !== 'admin') {
          return res.status(403).json({ message: 'Only admin can assign leads' });
        }
        const assignee =
          assigned_to === '' || assigned_to === null ? null : Number(assigned_to);
        if (assignee) {
          const [salesUser] = await pool.query(
            `SELECT id FROM users WHERE id = ? AND role = 'sales' AND status = 'active' LIMIT 1`,
            [assignee]
          );
          if (!salesUser.length) {
            return res.status(400).json({ message: 'Leads can only be assigned to sales users' });
          }
        }
        await pool.query(`UPDATE leads SET assigned_to = ? WHERE id IN (?)`, [
          assignee,
          ids,
        ]);
        return res.json({ message: `${ids.length} lead(s) assigned` });
      }

      if (action === 'status') {
        if (!STATUSES.includes(status)) {
          return res.status(400).json({ message: 'Invalid status' });
        }

        const where = ['id IN (?)'];
        const params = [ids];
        if (req.user.role === 'sales') {
          where.push('assigned_to = ?');
          params.push(req.user.id);
        }

        const [current] = await pool.query(
          `SELECT id, status FROM leads WHERE ${where.join(' AND ')}`,
          params
        );

        if (req.user.role === 'sales') {
          await pool.query(
            `UPDATE leads SET status = ? WHERE id IN (?) AND assigned_to = ?`,
            [status, ids, req.user.id]
          );
        } else {
          await pool.query(`UPDATE leads SET status = ? WHERE id IN (?)`, [status, ids]);
        }

        for (const row of current) {
          await logStatusChange(pool, {
            leadId: row.id,
            fromStatus: row.status,
            toStatus: status,
            changedBy: req.user.id,
          });
        }

        return res.json({ message: `${ids.length} lead(s) updated` });
      }

      return res.status(400).json({ message: 'Invalid action' });
    } catch (err) {
      console.error(err);
      return res
        .status(err.status || 500)
        .json({ message: err.message || 'Bulk action failed' });
    }
  }
);

router.get('/:id/status-history', async (req, res) => {
  try {
    const [leadRows] = await pool.query('SELECT id, assigned_to FROM leads WHERE id = ? LIMIT 1', [
      req.params.id,
    ]);
    if (!leadRows.length) {
      return res.status(404).json({ message: 'Lead not found' });
    }
    if (req.user.role === 'sales' && leadRows[0].assigned_to !== req.user.id) {
      return res.status(403).json({ message: 'Access denied' });
    }

    const [rows] = await pool.query(
      `SELECT h.*, u.name AS changed_by_name
       FROM lead_status_history h
       LEFT JOIN users u ON u.id = h.changed_by
       WHERE h.lead_id = ?
       ORDER BY h.created_at DESC
       LIMIT 50`,
      [req.params.id]
    );
    return res.json(rows);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: 'Failed to fetch status history' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT l.*,
              u.name AS assigned_name,
              c.name AS created_by_name,
              p.name AS product_name
       FROM leads l
       LEFT JOIN users u ON u.id = l.assigned_to
       LEFT JOIN users c ON c.id = l.created_by
       LEFT JOIN products p ON p.id = l.product_id
       WHERE l.id = ? LIMIT 1`,
      [req.params.id]
    );

    if (!rows.length) {
      return res.status(404).json({ message: 'Lead not found' });
    }

    const lead = rows[0];
    if (req.user.role === 'sales' && lead.assigned_to !== req.user.id) {
      return res.status(403).json({ message: 'Access denied' });
    }

    return res.json(lead);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: 'Failed to fetch lead' });
  }
});

router.put(
  '/:id',
  authorize('admin', 'sales'),
  body('status').optional().isIn(STATUSES),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    try {
      const [existing] = await pool.query('SELECT * FROM leads WHERE id = ? LIMIT 1', [
        req.params.id,
      ]);
      if (!existing.length) {
        return res.status(404).json({ message: 'Lead not found' });
      }

      if (req.user.role === 'sales' && existing[0].assigned_to !== req.user.id) {
        return res.status(403).json({ message: 'Access denied' });
      }

      const previousStatus = existing[0].status;
      const fields = [
        'status',
        'notes',
        'product_id',
        'assigned_to',
        'phone',
        'email',
        'address',
        'website',
        'name',
      ];
      const updates = [];
      const values = [];

      for (const field of fields) {
        if (req.body[field] === undefined) continue;
        if (field === 'assigned_to') {
          if (req.user.role !== 'admin') continue;
          const assignee =
            req.body.assigned_to === '' || req.body.assigned_to === null
              ? null
              : Number(req.body.assigned_to);
          if (assignee) {
            const [salesUser] = await pool.query(
              `SELECT id FROM users WHERE id = ? AND role = 'sales' AND status = 'active' LIMIT 1`,
              [assignee]
            );
            if (!salesUser.length) {
              return res
                .status(400)
                .json({ message: 'Leads can only be assigned to sales users' });
            }
          }
          updates.push('assigned_to = ?');
          values.push(assignee);
          continue;
        }
        updates.push(`${field} = ?`);
        values.push(req.body[field] === '' ? null : req.body[field]);
      }

      if (!updates.length) {
        return res.status(400).json({ message: 'No fields to update' });
      }

      values.push(req.params.id);
      await pool.query(`UPDATE leads SET ${updates.join(', ')} WHERE id = ?`, values);

      if (req.body.status !== undefined) {
        await logStatusChange(pool, {
          leadId: req.params.id,
          fromStatus: previousStatus,
          toStatus: req.body.status,
          changedBy: req.user.id,
        });
      }

      return res.json({ message: 'Lead updated' });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ message: 'Failed to update lead' });
    }
  }
);

router.delete('/:id', authorize('admin'), async (req, res) => {
  try {
    const [existing] = await pool.query('SELECT id FROM leads WHERE id = ? LIMIT 1', [
      req.params.id,
    ]);
    if (!existing.length) {
      return res.status(404).json({ message: 'Lead not found' });
    }

    await assertLeadDeletable(req.params.id);
    await pool.query('DELETE FROM leads WHERE id = ?', [req.params.id]);
    return res.json({ message: 'Lead deleted' });
  } catch (err) {
    console.error(err);
    return res
      .status(err.status || 500)
      .json({ message: err.message || 'Failed to delete lead' });
  }
});

module.exports = router;
