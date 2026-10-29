const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const { body } = require('express-validator');
const pool = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');
const {
  asyncHandler,
  validate,
  parsePagination,
  pageResult,
  badRequest,
  forbidden,
  notFound,
  conflict,
  toBool,
  emptyToNull,
} = require('../lib/http');
const {
  STATUSES,
  OPEN_STATUSES,
  STAGE_PROBABILITY,
  SORTS,
  LEAD_SELECT,
  scoreSql,
  normalizePhone,
  hydrateLead,
  buildLeadFilters,
  getLeadForUser,
  logStatusChange,
  assertSalesUser,
  assertProduct,
  findDuplicates,
  findPhoneProductLead,
  setLeadTags,
} = require('../services/leads');
const { nextAssignees } = require('../services/assignment');
const { audit, diff } = require('../services/audit');
const settings = require('../services/settings');

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
});

router.use(authenticate);

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

const parseMoney = (value) => {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const n = Number(String(value).replace(/[,\s₹]/g, ''));
  if (!Number.isFinite(n) || n < 0) throw badRequest('Deal value must be a positive number');
  return Math.round(n * 100) / 100;
};

const parseDate = (value) => {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const text = String(value).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw badRequest('Expected close date must be YYYY-MM-DD');
  return text;
};

const parseIds = (raw) => {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [raw];
    } catch {
      return raw.split(',').map((v) => v.trim());
    }
  }
  return [];
};

/* ------------------------------------------------------------------ list */

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { clause, params } = buildLeadFilters(req.query, req.user);
    const order = SORTS[req.query.sort] || SORTS.updated;
    const pg = parsePagination(req.query);

    if (pg.paginate) {
      const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM leads l ${clause}`, params);
      const [rows] = await pool.query(`${LEAD_SELECT} ${clause} ORDER BY ${order} LIMIT ? OFFSET ?`, [
        ...params,
        pg.limit,
        pg.offset,
      ]);
      return res.json(pageResult(rows.map(hydrateLead), total, pg));
    }

    const [rows] = await pool.query(`${LEAD_SELECT} ${clause} ORDER BY ${order} LIMIT 5000`, params);
    return res.json(rows.map(hydrateLead));
  })
);

router.get(
  '/stats',
  asyncHandler(async (req, res) => {
    const { clause, params } = buildLeadFilters(req.query, req.user, { ignore: ['status'] });
    const s = scoreSql('l');
    const [[row]] = await pool.query(
      `SELECT
         COUNT(*) AS total,
         SUM(l.status = 'new') AS new_count,
         SUM(l.status = 'contacted') AS contacted_count,
         SUM(l.status IN ('qualified','proposal','negotiation')) AS in_progress_count,
         SUM(l.status = 'won') AS won_count,
         SUM(l.status = 'lost') AS lost_count,
         SUM(l.status = 'not_interested') AS not_interested_count,
         SUM(l.assigned_to IS NULL) AS unassigned_count,
         SUM(l.status IN ('new','contacted','qualified','proposal','negotiation') AND ${s} >= 60) AS hot_count,
         COALESCE(SUM(CASE WHEN l.status IN ('new','contacted','qualified','proposal','negotiation') THEN l.deal_value END), 0) AS open_value,
         COALESCE(SUM(CASE WHEN l.status = 'won' THEN l.deal_value END), 0) AS won_value,
         SUM(EXISTS (SELECT 1 FROM reminders r WHERE r.lead_id = l.id AND r.is_completed = 0 AND r.remind_at < NOW())) AS overdue_callbacks
       FROM leads l ${clause}`,
      params
    );
    const out = {};
    for (const [k, v] of Object.entries(row || {})) out[k] = Number(v) || 0;
    return res.json(out);
  })
);

router.get(
  '/sources',
  asyncHandler(async (req, res) => {
    const configured = await settings.get('lead_sources');
    const [rows] = await pool.query(
      `SELECT source, COUNT(*) AS total FROM leads WHERE source IS NOT NULL AND source <> '' GROUP BY source ORDER BY total DESC`
    );
    const names = [...new Set([...configured, ...rows.map((r) => r.source)])];
    const counts = Object.fromEntries(rows.map((r) => [r.source, Number(r.total)]));
    return res.json(names.map((name) => ({ name, total: counts[name] || 0 })));
  })
);

/* -------------------------------------------------------------- pipeline */

router.get(
  '/pipeline',
  asyncHandler(async (req, res) => {
    const { clause, params } = buildLeadFilters(req.query, req.user, { ignore: ['status'] });
    const perStage = Math.min(200, Math.max(10, Number(req.query.limit_per_stage) || 50));
    const order = SORTS[req.query.sort] || 'score DESC, l.updated_at DESC';

    const [agg] = await pool.query(
      `SELECT l.status, COUNT(*) AS count, COALESCE(SUM(l.deal_value), 0) AS value
       FROM leads l ${clause} GROUP BY l.status`,
      params
    );
    const byStatus = Object.fromEntries(agg.map((r) => [r.status, r]));
    const and = clause ? `${clause} AND` : 'WHERE';

    const stages = [];
    for (const status of STATUSES) {
      const count = Number(byStatus[status]?.count) || 0;
      const value = Number(byStatus[status]?.value) || 0;
      let leads = [];
      if (count) {
        const [rows] = await pool.query(`${LEAD_SELECT} ${and} l.status = ? ORDER BY ${order} LIMIT ?`, [
          ...params,
          status,
          perStage,
        ]);
        leads = rows.map(hydrateLead);
      }
      stages.push({
        status,
        count,
        value,
        probability: STAGE_PROBABILITY[status],
        weighted_value: Math.round(value * STAGE_PROBABILITY[status] * 100) / 100,
        leads,
      });
    }
    const open = stages.filter((s) => OPEN_STATUSES.includes(s.status));
    return res.json({
      stages,
      totals: {
        open_count: open.reduce((n, s) => n + s.count, 0),
        open_value: open.reduce((n, s) => n + s.value, 0),
        weighted_value: open.reduce((n, s) => n + s.weighted_value, 0),
      },
    });
  })
);

/* ---------------------------------------------------------------- export */

router.get(
  '/export',
  asyncHandler(async (req, res) => {
    const format = req.query.format === 'csv' ? 'csv' : 'xlsx';
    const { clause, params } = buildLeadFilters(req.query, req.user);
    const order = SORTS[req.query.sort] || SORTS.updated;
    const [rows] = await pool.query(`${LEAD_SELECT} ${clause} ORDER BY ${order} LIMIT 50000`, params);

    const fmt = (d) => (d ? new Date(d).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) : '');
    const data = rows.map(hydrateLead).map((l) => ({
      ID: l.id,
      Name: l.name,
      Phone: l.phone || '',
      Email: l.email || '',
      Company: l.company || '',
      Address: l.address || '',
      Product: l.product_name || '',
      Status: l.status,
      Source: l.source || '',
      Score: l.score,
      Temperature: l.temperature || '',
      'Deal value': l.deal_value ?? '',
      'Expected close': l.expected_close_date ? String(l.expected_close_date).slice(0, 10) : '',
      'Lost reason': l.lost_reason || '',
      'Google Maps URL': l.maps_url || '',
      'Business Profile URL': l.business_profile_url || '',
      'Assigned to': l.assigned_name || '',
      Tags: l.tags.map((t) => t.name).join(', '),
      'Next callback': fmt(l.next_callback),
      WhatsApp: l.whatsapp_active ? 'Yes' : 'No',
      Notes: l.notes || '',
      Created: fmt(l.created_at),
      Updated: fmt(l.updated_at),
    }));

    const sheet = XLSX.utils.json_to_sheet(data);
    const stamp = new Date().toISOString().slice(0, 10);
    await audit(req, {
      entityType: 'lead',
      action: 'export',
      summary: `Exported ${data.length} lead(s) as ${format.toUpperCase()}`,
    });

    if (format === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="leads-${stamp}.csv"`);
      return res.send(`﻿${XLSX.utils.sheet_to_csv(sheet)}`);
    }
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, sheet, 'Leads');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="leads-${stamp}.xlsx"`);
    return res.send(XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }));
  })
);

/* ------------------------------------------------------------ duplicates */

router.get(
  '/duplicates/check',
  asyncHandler(async (req, res) => {
    const matches = await findDuplicates({
      phone: req.query.phone,
      email: req.query.email,
      excludeId: req.query.exclude_id || null,
    });
    // Sales users learn that a duplicate exists, but only see details of their own leads.
    const items = matches.map((m) =>
      req.user.role === 'sales' && m.assigned_to !== req.user.id
        ? { id: null, name: m.name, assigned_name: m.assigned_name, status: m.status, product_id: m.product_id, product_name: m.product_name, phone_match: m.phone_match, restricted: true }
        : m
    );
    return res.json({ count: items.length, items });
  })
);

router.get(
  '/duplicates',
  authorize('admin'),
  asyncHandler(async (req, res) => {
    const [groups] = await pool.query(
      `SELECT phone_normalized AS match_value, COUNT(*) AS total
       FROM leads
       WHERE archived_at IS NULL AND phone_normalized IS NOT NULL AND CHAR_LENGTH(phone_normalized) >= 10
       GROUP BY phone_normalized HAVING COUNT(*) > 1
       ORDER BY total DESC, match_value ASC
       LIMIT 200`
    );
    if (!groups.length) return res.json({ groups: [], total_groups: 0 });

    const [rows] = await pool.query(
      `${LEAD_SELECT} WHERE l.archived_at IS NULL AND l.phone_normalized IN (?) ORDER BY l.created_at ASC`,
      [groups.map((g) => g.match_value)]
    );
    const byPhone = {};
    for (const row of rows.map(hydrateLead)) {
      (byPhone[row.phone_normalized] ||= []).push(row);
    }
    return res.json({
      total_groups: groups.length,
      groups: groups.map((g) => ({ match_type: 'phone', match_value: g.match_value, leads: byPhone[g.match_value] || [] })),
    });
  })
);

router.post(
  '/merge',
  authorize('admin'),
  body('primary_id').notEmpty().withMessage('Choose the lead to keep'),
  body('duplicate_ids').isArray({ min: 1 }).withMessage('Choose at least one duplicate'),
  validate,
  asyncHandler(async (req, res) => {
    const primaryId = String(req.body.primary_id);
    const dupIds = [...new Set(req.body.duplicate_ids.map(String))].filter((id) => id !== primaryId);
    if (!dupIds.length) throw badRequest('Choose at least one duplicate other than the primary lead');

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [leads] = await conn.query('SELECT * FROM leads WHERE id IN (?) FOR UPDATE', [[primaryId, ...dupIds]]);
      const primary = leads.find((l) => l.id === primaryId);
      const dups = leads.filter((l) => dupIds.includes(l.id));
      if (!primary) throw badRequest('Primary lead not found');
      if (dups.length !== dupIds.length) throw badRequest('One or more duplicate leads were not found');
      if (primary.archived_at || dups.some((d) => d.archived_at)) throw badRequest('Archived leads cannot be merged');

      // Fill gaps on the primary from duplicates — never overwrite existing values.
      const fillable = ['email', 'phone', 'company', 'address', 'website', 'category', 'deal_value', 'expected_close_date', 'assigned_to', 'product_id'];
      const updates = {};
      for (const field of fillable) {
        if (primary[field] === null || primary[field] === '') {
          const donor = dups.find((d) => d[field] !== null && d[field] !== '');
          if (donor) updates[field] = donor[field];
        }
      }
      const extraNotes = dups.filter((d) => d.notes).map((d) => `[Merged from ${d.name} (${d.id})]\n${d.notes}`);
      if (extraNotes.length) updates.notes = [primary.notes, ...extraNotes].filter(Boolean).join('\n\n');
      if (updates.phone) updates.phone_normalized = normalizePhone(updates.phone);
      if (dups.some((d) => d.whatsapp_active) && !primary.whatsapp_active) updates.whatsapp_active = 1;

      if (Object.keys(updates).length) {
        await conn.query('UPDATE leads SET ? WHERE id = ?', [updates, primaryId]);
      }

      for (const table of ['reminders', 'appointments', 'communications', 'lead_status_history']) {
        await conn.query(`UPDATE ${table} SET lead_id = ? WHERE lead_id IN (?)`, [primaryId, dupIds]);
      }
      await conn.query(
        `INSERT IGNORE INTO lead_tags (lead_id, tag_id) SELECT ?, tag_id FROM lead_tags WHERE lead_id IN (?)`,
        [primaryId, dupIds]
      );
      await conn.query(
        'UPDATE leads SET archived_at = NOW(), archived_by = ?, merged_into = ? WHERE id IN (?)',
        [req.user.id, primaryId, dupIds]
      );
      await conn.query(
        `INSERT INTO communications (lead_id, user_id, type, direction, subject, content, occurred_at)
         VALUES (?, ?, 'note', 'outbound', ?, ?, NOW())`,
        [
          primaryId,
          req.user.id,
          `Merged ${dups.length} duplicate lead(s)`,
          dups.map((d) => `• ${d.name} — ${d.phone || d.email || d.id}`).join('\n'),
        ]
      );
      await conn.query('UPDATE leads SET last_activity_at = NOW() WHERE id = ?', [primaryId]);
      await audit(
        req,
        {
          entityType: 'lead',
          entityId: primaryId,
          action: 'merge',
          summary: `Merged ${dups.length} duplicate(s) into ${primary.name}`,
          changes: { merged_ids: [null, dupIds], ...diff(primary, { ...primary, ...updates }) },
        },
        conn
      );
      await conn.commit();
      return res.json({ message: `Merged ${dups.length} lead(s) into ${primary.name}`, primary_id: primaryId });
    } catch (err) {
      await conn.rollback().catch(() => {});
      throw err;
    } finally {
      conn.release();
    }
  })
);

/** 409 for the "one lead per mobile number per product" rule. */
function phoneProductConflict(req, lead) {
  const visible = req.user.role === 'admin' || lead.assigned_to === req.user.id;
  return conflict(
    `This mobile number already has a lead for ${lead.product_name || 'this product'}${
      lead.assigned_name ? ` (assigned to ${lead.assigned_name})` : ''
    }`,
    {
      code: 'DUPLICATE_PHONE_PRODUCT',
      existing: visible ? lead : { name: lead.name, assigned_name: lead.assigned_name, status: lead.status, restricted: true },
    }
  );
}

/* ---------------------------------------------------------------- create */

router.post(
  '/',
  authorize('admin', 'sales'),
  body('name').trim().notEmpty().withMessage('Name is required'),
  body('product_id').notEmpty().withMessage('Product is required'),
  body('status').optional().isIn(STATUSES),
  body('email').optional({ checkFalsy: true }).isEmail().withMessage('Enter a valid email'),
  validate,
  asyncHandler(async (req, res) => {
    const { name, phone, email, company, address, website, notes, product_id, assigned_to, source } = req.body;
    const status = req.body.status || 'new';
    const dealValue = parseMoney(req.body.deal_value) ?? null;
    const closeDate = parseDate(req.body.expected_close_date) ?? null;
    const productId = await assertProduct(product_id);

    // Hard rule: "Create anyway" cannot override a same-number, same-product lead.
    const sameProduct = await findPhoneProductLead({ phone, productId });
    if (sameProduct) throw phoneProductConflict(req, sameProduct);

    if (!toBool(req.body.force)) {
      const duplicates = await findDuplicates({ phone, email });
      if (duplicates.length) {
        throw conflict('A lead with this phone or email already exists', {
          code: 'DUPLICATE_LEAD',
          duplicates: duplicates.map((d) =>
            req.user.role === 'sales' && d.assigned_to !== req.user.id
              ? { name: d.name, assigned_name: d.assigned_name, status: d.status, restricted: true }
              : d
          ),
        });
      }
    }

    let assignee = null;
    if (req.user.role === 'sales') {
      assignee = req.user.id;
    } else if (assigned_to !== '' && assigned_to != null) {
      assignee = Number(assigned_to);
      await assertSalesUser(assignee);
    } else {
      [assignee] = await nextAssignees(1);
    }

    const leadId = `manual_${crypto.randomBytes(10).toString('hex')}`;
    await pool.query(
      `INSERT INTO leads (
         id, product_id, name, email, phone, phone_normalized, company, address, website,
         source, status, deal_value, expected_close_date, assigned_to, notes, created_by,
         whatsapp_active, stage_changed_at, last_activity_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [
        leadId,
        productId,
        name.trim(),
        emptyToNull(email),
        emptyToNull(phone),
        normalizePhone(phone),
        emptyToNull(company),
        emptyToNull(address),
        emptyToNull(website),
        emptyToNull(source) || 'manual',
        status,
        dealValue,
        closeDate,
        assignee,
        emptyToNull(notes),
        req.user.id,
        toBool(req.body.whatsapp_active) ? 1 : 0,
      ]
    );
    if (Array.isArray(req.body.tag_ids)) await setLeadTags(leadId, req.body.tag_ids);
    await audit(req, { entityType: 'lead', entityId: leadId, action: 'create', summary: `Created lead ${name.trim()}` });

    return res.status(201).json({ id: leadId, assigned_to: assignee, message: 'Lead created' });
  })
);

/* ---------------------------------------------------------------- import */

router.post(
  '/import',
  authorize('admin', 'sales'),
  upload.fields([
    { name: 'file', maxCount: 1 },
    { name: 'files', maxCount: 20 },
  ]),
  asyncHandler(async (req, res) => {
    // Accepts one file (`file`) or several (`files`); rows from all files are merged.
    const files = [...(req.files?.file || []), ...(req.files?.files || [])];
    if (!files.length) throw badRequest('Excel or CSV file is required');
    for (const f of files) {
      const originalName = String(f.originalname || '').toLowerCase();
      if (!['.xlsx', '.xls', '.csv'].some((ext) => originalName.endsWith(ext))) {
        throw badRequest(`Only .xlsx, .xls, or .csv files are supported (${f.originalname})`);
      }
    }

    const productIds = [
      ...new Set(parseIds(req.body.product_ids || req.body.product_id).map(Number).filter(Boolean)),
    ];
    if (!productIds.length) throw badRequest('At least one product is required for import');
    const [products] = await pool.query(`SELECT id FROM products WHERE id IN (?) AND status = 'active'`, [productIds]);
    if (products.length !== productIds.length) throw badRequest('Select valid active products');

    const autoAssign = req.user.role === 'admin' && toBool(req.body.auto_assign);
    const source = cleanText(req.body.source) || 'maps-import';
    const tagIds = parseIds(req.body.tag_ids).map(Number).filter(Boolean);

    const rows = [];
    for (const f of files) {
      const workbook = XLSX.read(f.buffer, { type: 'buffer', raw: false });
      const sheetName = workbook.SheetNames[0];
      if (!sheetName) throw badRequest(`${f.originalname} has no readable sheet or data`);
      rows.push(...XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: '' }));
    }
    if (!rows.length) throw badRequest('File has no rows');

    const multi = productIds.length > 1;
    const candidates = [];
    let skipped = 0;
    for (const productId of productIds) {
      for (const row of rows) {
        const sourceId = cleanText(row.ID || row.Id || row.id);
        const name = cleanText(row.Name || row.name);
        if (!name) {
          skipped += 1;
          continue;
        }
        // Rows without an ID get a stable id derived from their content.
        const baseId =
          sourceId ||
          `imp_${crypto
            .createHash('sha1')
            .update(`${name}|${row.Phone || row.phone || ''}|${row.Address || row.address || ''}`)
            .digest('hex')
            .slice(0, 20)}`;
        const phone = cleanText(row.Phone || row.phone || row.Mobile || row.mobile);
        candidates.push({
          id: multi ? `${baseId}::${productId}` : baseId,
          productId,
          name,
          phone,
          row,
        });
      }
    }

    // Existing ids (one query per 500) instead of one query per row.
    const existingIds = new Set();
    for (let i = 0; i < candidates.length; i += 500) {
      const chunk = candidates.slice(i, i + 500).map((c) => c.id);
      const [found] = await pool.query('SELECT id FROM leads WHERE id IN (?)', [chunk]);
      found.forEach((f) => existingIds.add(f.id));
    }
    // One lead per mobile number per product, always (skip_phone_duplicates is ignored).
    const existingPhones = new Set();
    const phones = [...new Set(candidates.map((c) => normalizePhone(c.phone)).filter((p) => p && p.length >= 10))];
    for (let i = 0; i < phones.length; i += 500) {
      const [found] = await pool.query(
        `SELECT DISTINCT phone_normalized, product_id FROM leads WHERE archived_at IS NULL AND phone_normalized IN (?)`,
        [phones.slice(i, i + 500)]
      );
      found.forEach((f) => existingPhones.add(`${f.phone_normalized}|${f.product_id}`));
    }

    let duplicates = 0;
    let phoneDuplicates = 0;
    const seen = new Set();
    const toInsert = [];
    const linkBackfills = [];
    for (const c of candidates) {
      if (existingIds.has(c.id) || seen.has(c.id)) {
        duplicates += 1;
        const businessProfileUrl = cleanText(c.row['Business Profile URL'] || c.row.business_profile_url);
        const mapsUrl = cleanText(c.row['Google Maps URL'] || c.row['Bing Maps URL'] || c.row.maps_url);
        if (existingIds.has(c.id) && (businessProfileUrl || mapsUrl)) {
          linkBackfills.push({ id: c.id, businessProfileUrl, mapsUrl });
        }
        continue;
      }
      const phoneKey = `${normalizePhone(c.phone)}|${c.productId}`;
      if (normalizePhone(c.phone)?.length >= 10 && existingPhones.has(phoneKey)) {
        phoneDuplicates += 1;
        continue;
      }
      seen.add(c.id);
      if (normalizePhone(c.phone)?.length >= 10) existingPhones.add(phoneKey);
      toInsert.push(c);
    }

    const assignees = autoAssign
      ? await nextAssignees(toInsert.length, { force: true })
      : toInsert.map(() => (req.user.role === 'sales' ? req.user.id : null));

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      for (let i = 0; i < toInsert.length; i += 200) {
        const values = toInsert.slice(i, i + 200).map((c, j) => {
          const r = c.row;
          return [
            c.id,
            c.productId,
            c.name,
            pickFirstEmail(r.Emails || r.Email || r.emails || r.email),
            c.phone,
            normalizePhone(c.phone),
            cleanText(r.Company || r.company),
            cleanText(r.Address || r.address),
            cleanText(r.Website || r.website),
            cleanText(r.Category || r.category),
            cleanText(r['Open Hours'] || r.open_hours),
            cleanText(r.Rating || r.rating),
            cleanText(r['Rating Info'] || r.rating_info),
            r.Latitude || r.latitude || null,
            r.Longitude || r.longitude || null,
            cleanText(r['Google Maps URL'] || r['Bing Maps URL'] || r.maps_url),
            cleanText(r['Business Profile URL'] || r.business_profile_url),
            cleanText(r['Featured image'] || r.featured_image),
            cleanText(r['Social Medias'] || r.social_medias),
            cleanText(r.Facebook || r.facebook),
            cleanText(r.Instagram || r.instagram),
            cleanText(r.Twitter || r.twitter),
            source,
            'new',
            assignees[i + j],
            req.user.id,
            new Date(),
          ];
        });
        await conn.query(
          `INSERT INTO leads (
             id, product_id, name, email, phone, phone_normalized, company, address, website, category,
             open_hours, rating, rating_info, latitude, longitude, maps_url, business_profile_url,
             featured_image, social_medias, facebook, instagram, twitter,
             source, status, assigned_to, created_by, stage_changed_at
           ) VALUES ?`,
          [values]
        );
        if (tagIds.length) {
          const [validTags] = await conn.query('SELECT id FROM tags WHERE id IN (?)', [tagIds]);
          const pairs = [];
          for (const c of toInsert.slice(i, i + 200)) for (const t of validTags) pairs.push([c.id, t.id]);
          if (pairs.length) await conn.query('INSERT IGNORE INTO lead_tags (lead_id, tag_id) VALUES ?', [pairs]);
        }
      }
      await conn.commit();
    } catch (err) {
      await conn.rollback().catch(() => {});
      throw err;
    } finally {
      conn.release();
    }

    // Leads imported earlier (same source ID) get their Google links filled in,
    // but only where the field is still empty — existing values are never overwritten.
    let linksBackfilled = 0;
    for (const b of linkBackfills) {
      const [result] = await pool.query(
        `UPDATE leads
         SET business_profile_url = COALESCE(NULLIF(business_profile_url, ''), ?),
             maps_url = COALESCE(NULLIF(maps_url, ''), ?),
             updated_at = updated_at
         WHERE id = ?
           AND ((business_profile_url IS NULL OR business_profile_url = '') AND ? IS NOT NULL
             OR (maps_url IS NULL OR maps_url = '') AND ? IS NOT NULL)`,
        [b.businessProfileUrl, b.mapsUrl, b.id, b.businessProfileUrl, b.mapsUrl]
      );
      linksBackfilled += result.affectedRows;
    }

    await audit(req, {
      entityType: 'lead',
      action: 'import',
      summary: `Imported ${toInsert.length} lead(s) from ${files.map((f) => f.originalname).join(', ')}${
        linksBackfilled ? `; added Google links to ${linksBackfilled} existing lead(s)` : ''
      }`,
    });

    return res.json({
      message: 'Import completed',
      imported: toInsert.length,
      duplicates,
      phone_duplicates: phoneDuplicates,
      skipped,
      total: rows.length * productIds.length,
      products: productIds.length,
      files: files.length,
      auto_assigned: autoAssign ? toInsert.length : 0,
      links_backfilled: linksBackfilled,
    });
  })
);

/* ------------------------------------------------------------------ bulk */

router.post(
  '/bulk',
  authorize('admin', 'sales'),
  body('ids').isArray({ min: 1 }),
  body('action').isIn(['assign', 'auto_assign', 'status', 'delete', 'archive', 'restore', 'whatsapp', 'tag_add', 'tag_remove']),
  validate,
  asyncHandler(async (req, res) => {
    const { action } = req.body;
    const ids = [...new Set(req.body.ids.map(String))];
    const isAdmin = req.user.role === 'admin';
    const adminOnly = ['assign', 'auto_assign', 'delete', 'archive', 'restore'];
    if (adminOnly.includes(action) && !isAdmin) throw forbidden(`Only admin can ${action.replace('_', ' ')} leads`);

    // Scope to leads the user may touch.
    const scope = ['id IN (?)'];
    const scopeParams = [ids];
    if (!isAdmin) {
      scope.push('assigned_to = ?');
      scopeParams.push(req.user.id);
    }
    const [current] = await pool.query(`SELECT id, name, status, assigned_to FROM leads WHERE ${scope.join(' AND ')}`, scopeParams);
    const allowed = current.map((r) => r.id);
    if (!allowed.length) throw badRequest('None of the selected leads can be updated');
    const n = allowed.length;

    if (action === 'delete' || action === 'archive') {
      await pool.query('UPDATE leads SET archived_at = NOW(), archived_by = ? WHERE id IN (?) AND archived_at IS NULL', [
        req.user.id,
        allowed,
      ]);
      await audit(req, { entityType: 'lead', action: 'archive', summary: `Archived ${n} lead(s)`, changes: { ids: [null, allowed] } });
      return res.json({ message: `${n} lead(s) archived` });
    }

    if (action === 'restore') {
      // Skip any lead whose number already has an active lead for the same product.
      const [rows] = await pool.query('SELECT id, phone, product_id FROM leads WHERE id IN (?)', [allowed]);
      const taken = new Set();
      const restorable = [];
      for (const row of rows) {
        const key = `${normalizePhone(row.phone)}|${row.product_id}`;
        const checkable = normalizePhone(row.phone)?.length >= 10;
        if (checkable && (taken.has(key) || (await findPhoneProductLead({ phone: row.phone, productId: row.product_id, excludeId: row.id })))) continue;
        if (checkable) taken.add(key);
        restorable.push(row.id);
      }
      const blocked = rows.length - restorable.length;
      if (restorable.length) {
        await pool.query('UPDATE leads SET archived_at = NULL, archived_by = NULL, merged_into = NULL WHERE id IN (?)', [restorable]);
        await audit(req, { entityType: 'lead', action: 'restore', summary: `Restored ${restorable.length} lead(s)`, changes: { ids: [null, restorable] } });
      }
      return res.json({
        message: `${restorable.length} lead(s) restored${blocked ? `, ${blocked} skipped (same number already active for that product)` : ''}`,
        restored: restorable.length,
        skipped: blocked,
      });
    }

    if (action === 'assign') {
      const assignee = req.body.assigned_to === '' || req.body.assigned_to == null ? null : Number(req.body.assigned_to);
      if (assignee) await assertSalesUser(assignee);
      await pool.query('UPDATE leads SET assigned_to = ? WHERE id IN (?)', [assignee, allowed]);
      await audit(req, {
        entityType: 'lead',
        action: 'assign',
        summary: `Assigned ${n} lead(s) to user #${assignee || 'none'}`,
        changes: { assigned_to: [null, assignee], ids: [null, allowed] },
      });
      return res.json({ message: `${n} lead(s) assigned` });
    }

    if (action === 'auto_assign') {
      const assignees = await nextAssignees(n, { force: true });
      if (!assignees[0]) throw badRequest('No active sales users are enabled for auto-assignment');
      for (let i = 0; i < n; i += 1) {
        await pool.query('UPDATE leads SET assigned_to = ? WHERE id = ?', [assignees[i], allowed[i]]);
      }
      await audit(req, { entityType: 'lead', action: 'assign', summary: `Auto-assigned ${n} lead(s) round-robin` });
      return res.json({ message: `${n} lead(s) distributed across ${new Set(assignees).size} user(s)` });
    }

    if (action === 'status') {
      const { status, note } = req.body;
      if (!STATUSES.includes(status)) throw badRequest('Invalid status');
      const lostReason = status === 'lost' ? emptyToNull(req.body.lost_reason) : undefined;
      await pool.query(
        `UPDATE leads SET status = ?${lostReason !== undefined ? ', lost_reason = ?' : ''} WHERE id IN (?)`,
        lostReason !== undefined ? [status, lostReason, allowed] : [status, allowed]
      );
      for (const row of current) {
        await logStatusChange(pool, { leadId: row.id, fromStatus: row.status, toStatus: status, changedBy: req.user.id, note });
      }
      await audit(req, { entityType: 'lead', action: 'status', summary: `Moved ${n} lead(s) to ${status}` });
      return res.json({ message: `${n} lead(s) updated` });
    }

    if (action === 'whatsapp') {
      const active = toBool(req.body.whatsapp_active);
      await pool.query('UPDATE leads SET whatsapp_active = ? WHERE id IN (?)', [active ? 1 : 0, allowed]);
      return res.json({ message: `${n} lead(s) marked WhatsApp ${active ? 'active' : 'inactive'}` });
    }

    if (action === 'tag_add' || action === 'tag_remove') {
      const tagIds = (req.body.tag_ids || []).map(Number).filter(Boolean);
      if (!tagIds.length) throw badRequest('Choose at least one tag');
      if (action === 'tag_add') {
        const pairs = [];
        for (const id of allowed) for (const t of tagIds) pairs.push([id, t]);
        await pool.query('INSERT IGNORE INTO lead_tags (lead_id, tag_id) VALUES ?', [pairs]);
      } else {
        await pool.query('DELETE FROM lead_tags WHERE lead_id IN (?) AND tag_id IN (?)', [allowed, tagIds]);
      }
      return res.json({ message: `Tags updated on ${n} lead(s)` });
    }

    throw badRequest('Invalid action');
  })
);

/* ---------------------------------------------------------- single lead */

router.get(
  '/:id/status-history',
  asyncHandler(async (req, res) => {
    await getLeadForUser(req.params.id, req.user);
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
  })
);

router.get(
  '/:id/timeline',
  asyncHandler(async (req, res) => {
    const lead = await getLeadForUser(req.params.id, req.user);
    const id = lead.id;
    const [activities] = await pool.query(
      `SELECT c.*, u.name AS user_name FROM communications c
       LEFT JOIN users u ON u.id = c.user_id WHERE c.lead_id = ?`,
      [id]
    );
    const [history] = await pool.query(
      `SELECT h.*, u.name AS user_name FROM lead_status_history h
       LEFT JOIN users u ON u.id = h.changed_by WHERE h.lead_id = ?`,
      [id]
    );
    const [reminders] = await pool.query(
      `SELECT r.*, u.name AS user_name FROM reminders r
       LEFT JOIN users u ON u.id = r.user_id WHERE r.lead_id = ?`,
      [id]
    );
    const [appointments] = await pool.query(
      `SELECT a.*, u.name AS user_name FROM appointments a
       LEFT JOIN users u ON u.id = a.user_id WHERE a.lead_id = ?`,
      [id]
    );
    const [audits] = await pool.query(
      `SELECT a.id, a.action, a.summary, a.created_at, u.name AS user_name FROM audit_logs a
       LEFT JOIN users u ON u.id = a.user_id
       WHERE a.entity_type = 'lead' AND a.entity_id = ? AND a.action IN ('create','assign','archive','restore','merge')`,
      [id]
    );

    const items = [
      ...activities.map((a) => ({
        kind: 'activity',
        id: `a${a.id}`,
        ref_id: a.id,
        at: a.occurred_at || a.created_at,
        type: a.type,
        direction: a.direction,
        subject: a.subject,
        content: a.content,
        outcome: a.outcome,
        duration_seconds: a.duration_seconds,
        user_id: a.user_id,
        user_name: a.user_name,
      })),
      ...history.map((h) => ({
        kind: 'status',
        id: `s${h.id}`,
        at: h.created_at,
        from_status: h.from_status,
        to_status: h.to_status,
        note: h.note,
        user_name: h.user_name,
      })),
      ...reminders.map((r) => ({
        kind: 'reminder',
        id: `r${r.id}`,
        ref_id: r.id,
        at: r.is_completed ? r.completed_at || r.updated_at : r.created_at,
        due_at: r.remind_at,
        title: r.title,
        description: r.description,
        priority: r.priority,
        is_completed: !!r.is_completed,
        user_name: r.user_name,
      })),
      ...appointments.map((a) => ({
        kind: 'appointment',
        id: `p${a.id}`,
        ref_id: a.id,
        at: a.created_at,
        start_at: a.start_at,
        title: a.title,
        platform: a.platform,
        status: a.status,
        location: a.location,
        user_name: a.user_name,
      })),
      ...audits.map((a) => ({
        kind: 'system',
        id: `x${a.id}`,
        at: a.created_at,
        action: a.action,
        summary: a.summary,
        user_name: a.user_name,
      })),
    ].sort((x, y) => new Date(y.at) - new Date(x.at));

    return res.json({ items });
  })
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const lead = await getLeadForUser(req.params.id, req.user);
    const [[counts]] = await pool.query(
      `SELECT
         (SELECT COUNT(*) FROM reminders WHERE lead_id = ? AND is_completed = 0) AS open_reminders,
         (SELECT COUNT(*) FROM appointments WHERE lead_id = ?) AS appointments,
         (SELECT COUNT(*) FROM communications WHERE lead_id = ?) AS activities`,
      [lead.id, lead.id, lead.id]
    );
    lead.counts = {
      open_reminders: Number(counts.open_reminders) || 0,
      appointments: Number(counts.appointments) || 0,
      activities: Number(counts.activities) || 0,
    };
    return res.json(lead);
  })
);

router.put(
  '/:id',
  authorize('admin', 'sales'),
  body('status').optional().isIn(STATUSES),
  body('email').optional({ checkFalsy: true }).isEmail().withMessage('Enter a valid email'),
  body('name').optional().trim().notEmpty().withMessage('Name is required'),
  validate,
  asyncHandler(async (req, res) => {
    const [existingRows] = await pool.query('SELECT * FROM leads WHERE id = ? LIMIT 1', [req.params.id]);
    if (!existingRows.length) throw notFound('Lead not found');
    const existing = existingRows[0];
    if (req.user.role === 'sales' && existing.assigned_to !== req.user.id) throw forbidden();

    const text = ['notes', 'phone', 'email', 'address', 'website', 'name', 'company', 'source', 'lost_reason', 'maps_url', 'business_profile_url'];
    const changes = {};
    for (const field of text) {
      if (req.body[field] !== undefined) changes[field] = emptyToNull(typeof req.body[field] === 'string' ? req.body[field].trim() : req.body[field]);
    }
    if (changes.name === null) throw badRequest('Name is required');
    if (req.body.status !== undefined) changes.status = req.body.status;
    if (req.body.deal_value !== undefined) changes.deal_value = parseMoney(req.body.deal_value);
    if (req.body.expected_close_date !== undefined) changes.expected_close_date = parseDate(req.body.expected_close_date);
    // The product is fixed once a lead exists (its reminders, appointments and the
    // phone-per-product rule all hang off it). Re-sending the same product is fine.
    if (req.body.product_id !== undefined && req.body.product_id !== null && req.body.product_id !== '' &&
        Number(req.body.product_id) !== Number(existing.product_id)) {
      throw badRequest("A lead's product can't be changed after it is created");
    }
    if (req.body.whatsapp_active !== undefined) changes.whatsapp_active = toBool(req.body.whatsapp_active) ? 1 : 0;
    if (changes.phone !== undefined) {
      changes.phone_normalized = normalizePhone(changes.phone);
      if (changes.phone_normalized !== existing.phone_normalized && !existing.archived_at) {
        const clash = await findPhoneProductLead({ phone: changes.phone, productId: existing.product_id, excludeId: existing.id });
        if (clash) throw phoneProductConflict(req, clash);
      }
    }
    if (req.body.assigned_to !== undefined && req.user.role === 'admin') {
      const assignee = req.body.assigned_to === '' || req.body.assigned_to === null ? null : Number(req.body.assigned_to);
      if (assignee) await assertSalesUser(assignee);
      changes.assigned_to = assignee;
    }
    // Moving out of "lost" clears the stale reason unless a new one was sent.
    if (changes.status && changes.status !== 'lost' && existing.status === 'lost' && req.body.lost_reason === undefined) {
      changes.lost_reason = null;
    }

    const hasTags = Array.isArray(req.body.tag_ids);
    if (!Object.keys(changes).length && !hasTags) throw badRequest('No fields to update');

    if (Object.keys(changes).length) {
      await pool.query('UPDATE leads SET ? WHERE id = ?', [changes, req.params.id]);
    }
    if (hasTags) await setLeadTags(req.params.id, req.body.tag_ids);

    if (changes.status !== undefined) {
      await logStatusChange(pool, {
        leadId: req.params.id,
        fromStatus: existing.status,
        toStatus: changes.status,
        changedBy: req.user.id,
        note: req.body.status_note,
      });
    }

    const changed = diff(existing, changes);
    if (Object.keys(changed).length || hasTags) {
      await audit(req, {
        entityType: 'lead',
        entityId: req.params.id,
        action: changed.assigned_to ? 'assign' : 'update',
        summary: changed.assigned_to
          ? `Reassigned ${existing.name}`
          : `Updated ${Object.keys(changed).join(', ') || 'tags'} on ${existing.name}`,
        changes: changed,
      });
    }

    return res.json({ message: 'Lead updated' });
  })
);

router.post(
  '/:id/restore',
  authorize('admin'),
  asyncHandler(async (req, res) => {
    const lead = await getLeadForUser(req.params.id, req.user);
    const clash = await findPhoneProductLead({ phone: lead.phone, productId: lead.product_id, excludeId: lead.id });
    if (clash) throw phoneProductConflict(req, clash);
    await pool.query('UPDATE leads SET archived_at = NULL, archived_by = NULL, merged_into = NULL WHERE id = ?', [lead.id]);
    await audit(req, { entityType: 'lead', entityId: lead.id, action: 'restore', summary: `Restored ${lead.name}` });
    return res.json({ message: 'Lead restored' });
  })
);

// "Delete" archives the lead so no history is ever lost; admins can restore it.
router.delete(
  '/:id',
  authorize('admin'),
  asyncHandler(async (req, res) => {
    const lead = await getLeadForUser(req.params.id, req.user);
    await pool.query('UPDATE leads SET archived_at = NOW(), archived_by = ? WHERE id = ?', [req.user.id, lead.id]);
    await audit(req, { entityType: 'lead', entityId: lead.id, action: 'archive', summary: `Archived ${lead.name}` });
    return res.json({ message: 'Lead archived' });
  })
);

module.exports = router;
