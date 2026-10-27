const pool = require('../config/db');
const { badRequest, forbidden, notFound } = require('../lib/http');

const STATUSES = ['new', 'contacted', 'qualified', 'proposal', 'negotiation', 'won', 'lost', 'not_interested'];
const OPEN_STATUSES = ['new', 'contacted', 'qualified', 'proposal', 'negotiation'];
const CLOSED_STATUSES = ['won', 'lost', 'not_interested'];

/** Default win probability per stage, used for the weighted pipeline forecast. */
const STAGE_PROBABILITY = {
  new: 0.05,
  contacted: 0.15,
  qualified: 0.35,
  proposal: 0.55,
  negotiation: 0.75,
  won: 1,
  lost: 0,
  not_interested: 0,
};

function normalizePhone(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/\D/g, '');
  if (!digits) return null;
  return digits.length >= 10 ? digits.slice(-10) : digits;
}

/**
 * Lead score 0–100, evaluated in SQL so it is always current and sortable.
 * Stage sets the base; contactability, deal value and recent activity adjust it.
 */
const scoreSql = (a = 'l') => `LEAST(100, GREATEST(0,
  CASE ${a}.status
    WHEN 'new' THEN 10 WHEN 'contacted' THEN 25 WHEN 'qualified' THEN 45
    WHEN 'proposal' THEN 60 WHEN 'negotiation' THEN 72 WHEN 'won' THEN 100 ELSE 0 END
  + IF(${a}.status IN ('won','lost','not_interested'), 0,
      IF(${a}.phone IS NOT NULL AND ${a}.phone <> '', 8, 0)
    + IF(${a}.email IS NOT NULL AND ${a}.email <> '', 4, 0)
    + IF(${a}.whatsapp_active = 1, 5, 0)
    + IF(COALESCE(${a}.deal_value, 0) > 0, 5, 0)
    + CASE
        WHEN ${a}.last_activity_at >= NOW() - INTERVAL 3 DAY THEN 12
        WHEN ${a}.last_activity_at >= NOW() - INTERVAL 14 DAY THEN 6
        WHEN ${a}.last_activity_at < NOW() - INTERVAL 30 DAY THEN -10
        ELSE 0 END)
))`;

const temperatureOf = (score, status) => {
  if (CLOSED_STATUSES.includes(status)) return null;
  if (score >= 60) return 'hot';
  if (score >= 30) return 'warm';
  return 'cold';
};

const TAGS_SQL = (a = 'l') => `(
  SELECT GROUP_CONCAT(CONCAT(t.id, '\\t', t.color, '\\t', t.name) ORDER BY t.name SEPARATOR '\\n')
  FROM lead_tags lt INNER JOIN tags t ON t.id = lt.tag_id
  WHERE lt.lead_id = ${a}.id
)`;

const NEXT_CALLBACK_SQL = (a = 'l') => `(
  SELECT r.remind_at FROM reminders r
  WHERE r.lead_id = ${a}.id AND r.is_completed = 0
  ORDER BY r.remind_at ASC LIMIT 1
)`;

const LEAD_SELECT = `SELECT l.*,
  u.name AS assigned_name,
  c.name AS created_by_name,
  p.name AS product_name,
  ${NEXT_CALLBACK_SQL('l')} AS next_callback,
  ${TAGS_SQL('l')} AS tag_list,
  ${scoreSql('l')} AS score
FROM leads l
LEFT JOIN users u ON u.id = l.assigned_to
LEFT JOIN users c ON c.id = l.created_by
LEFT JOIN products p ON p.id = l.product_id`;

function hydrateLead(row) {
  if (!row) return row;
  const { tag_list: tagList, ...lead } = row;
  lead.tags = tagList
    ? String(tagList)
        .split('\n')
        .map((entry) => {
          const [id, color, ...name] = entry.split('\t');
          return { id: Number(id), color, name: name.join('\t') };
        })
    : [];
  lead.score = Number(lead.score) || 0;
  lead.temperature = temperatureOf(lead.score, lead.status);
  lead.deal_value = lead.deal_value === null || lead.deal_value === undefined ? null : Number(lead.deal_value);
  return lead;
}

const SORTS = {
  updated: 'l.updated_at DESC',
  created: 'l.created_at DESC',
  oldest: 'l.created_at ASC',
  name: 'l.name ASC',
  score: 'score DESC, l.updated_at DESC',
  deal_value: 'l.deal_value IS NULL, l.deal_value DESC',
  close_date: 'l.expected_close_date IS NULL, l.expected_close_date ASC',
  callback: 'next_callback IS NULL, next_callback ASC',
  activity: 'l.last_activity_at IS NULL, l.last_activity_at DESC',
};

/**
 * Build WHERE fragments shared by list, stats, pipeline, export and reports.
 * Sales users are always scoped to their own leads.
 */
function buildLeadFilters(query = {}, user, { a = 'l', ignore = [] } = {}) {
  const where = [];
  const params = [];
  const use = (key) => !ignore.includes(key) && query[key] !== undefined && query[key] !== '';

  if (query.archived === 'only') where.push(`${a}.archived_at IS NOT NULL`);
  else if (query.archived !== 'all') where.push(`${a}.archived_at IS NULL`);

  if (user.role === 'sales') {
    where.push(`${a}.assigned_to = ?`);
    params.push(user.id);
  }

  if (use('status')) {
    const list = String(query.status).split(',').filter((s) => STATUSES.includes(s));
    if (list.length) {
      where.push(`${a}.status IN (?)`);
      params.push(list);
    }
  }
  if (use('product_id')) {
    where.push(`${a}.product_id = ?`);
    params.push(Number(query.product_id));
  }
  if (use('assigned_to') && user.role !== 'sales') {
    if (query.assigned_to === 'unassigned') where.push(`${a}.assigned_to IS NULL`);
    else if (query.assigned_to === 'me') {
      where.push(`${a}.assigned_to = ?`);
      params.push(user.id);
    } else {
      where.push(`${a}.assigned_to = ?`);
      params.push(Number(query.assigned_to));
    }
  }
  if (use('source')) {
    where.push(`${a}.source = ?`);
    params.push(query.source);
  }
  if (use('tag_id')) {
    where.push(`EXISTS (SELECT 1 FROM lead_tags ltf WHERE ltf.lead_id = ${a}.id AND ltf.tag_id = ?)`);
    params.push(Number(query.tag_id));
  }
  if (use('temperature')) {
    const s = scoreSql(a);
    const open = `${a}.status NOT IN ('won','lost','not_interested')`;
    if (query.temperature === 'hot') where.push(`${open} AND ${s} >= 60`);
    if (query.temperature === 'warm') where.push(`${open} AND ${s} >= 30 AND ${s} < 60`);
    if (query.temperature === 'cold') where.push(`${open} AND ${s} < 30`);
  }
  if (use('created_from')) {
    where.push(`${a}.created_at >= ?`);
    params.push(`${query.created_from} 00:00:00`);
  }
  if (use('created_to')) {
    where.push(`${a}.created_at <= ?`);
    params.push(`${query.created_to} 23:59:59`);
  }
  if (use('callback')) {
    if (query.callback === 'overdue') {
      where.push(`EXISTS (SELECT 1 FROM reminders rf WHERE rf.lead_id = ${a}.id AND rf.is_completed = 0 AND rf.remind_at < NOW())`);
    } else if (query.callback === 'today') {
      where.push(`EXISTS (SELECT 1 FROM reminders rf WHERE rf.lead_id = ${a}.id AND rf.is_completed = 0 AND DATE(rf.remind_at) = CURDATE())`);
    } else if (query.callback === 'none') {
      where.push(`NOT EXISTS (SELECT 1 FROM reminders rf WHERE rf.lead_id = ${a}.id AND rf.is_completed = 0)`);
    }
  }
  if (use('search')) {
    const like = `%${String(query.search).trim()}%`;
    const digits = String(query.search).replace(/\D/g, '');
    const parts = [
      `${a}.name LIKE ?`,
      `${a}.email LIKE ?`,
      `${a}.phone LIKE ?`,
      `${a}.company LIKE ?`,
      `${a}.id LIKE ?`,
      `${a}.address LIKE ?`,
    ];
    params.push(like, like, like, like, like, like);
    if (digits.length >= 4) {
      parts.push(`${a}.phone_normalized LIKE ?`);
      params.push(`%${digits}%`);
    }
    where.push(`(${parts.join(' OR ')})`);
  }

  return { clause: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

/** Load a lead the current user may access, or throw 404/403. */
async function getLeadForUser(id, user, conn = pool, { includeArchived = true } = {}) {
  const [rows] = await conn.query(`${LEAD_SELECT} WHERE l.id = ? LIMIT 1`, [id]);
  if (!rows.length) throw notFound('Lead not found');
  const lead = rows[0];
  if (user.role === 'sales' && lead.assigned_to !== user.id) throw forbidden();
  if (!includeArchived && lead.archived_at) throw badRequest('This lead is archived');
  return hydrateLead(lead);
}

async function logStatusChange(conn, { leadId, fromStatus, toStatus, changedBy, note }) {
  if (!toStatus || fromStatus === toStatus) return;
  const noteText = note === undefined || note === null || String(note).trim() === '' ? null : String(note).trim();
  await conn.query(
    `INSERT INTO lead_status_history (lead_id, from_status, to_status, note, changed_by)
     VALUES (?, ?, ?, ?, ?)`,
    [leadId, fromStatus || null, toStatus, noteText, changedBy || null]
  );
  await conn.query('UPDATE leads SET stage_changed_at = NOW(), last_activity_at = NOW() WHERE id = ?', [leadId]);
}

async function touchActivity(leadId, conn = pool) {
  if (!leadId) return;
  await conn.query('UPDATE leads SET last_activity_at = NOW() WHERE id = ?', [leadId]);
}

async function assertSalesUser(userId, conn = pool) {
  const [rows] = await conn.query(
    `SELECT id FROM users WHERE id = ? AND role = 'sales' AND status = 'active' LIMIT 1`,
    [userId]
  );
  if (!rows.length) throw badRequest('Leads can only be assigned to active sales users');
}

async function assertProduct(productId, conn = pool, { activeOnly = false } = {}) {
  const id = Number(productId);
  if (!id) throw badRequest('Product is required');
  const [rows] = await conn.query(
    `SELECT id FROM products WHERE id = ? ${activeOnly ? "AND status = 'active'" : ''} LIMIT 1`,
    [id]
  );
  if (!rows.length) throw badRequest('Select a valid product');
  return id;
}

/** Leads that share a phone number or email with the given values. */
async function findDuplicates({ phone, email, excludeId = null }, conn = pool) {
  const phoneNorm = normalizePhone(phone);
  const mail = email ? String(email).trim().toLowerCase() : null;
  if (!phoneNorm && !mail) return [];
  const conds = [];
  const params = [];
  if (phoneNorm && phoneNorm.length >= 10) {
    conds.push('l.phone_normalized = ?');
    params.push(phoneNorm);
  }
  if (mail) {
    conds.push('LOWER(l.email) = ?');
    params.push(mail);
  }
  if (!conds.length) return [];
  const phoneMatch = phoneNorm && phoneNorm.length >= 10 ? 'l.phone_normalized = ?' : '0';
  if (phoneNorm && phoneNorm.length >= 10) params.unshift(phoneNorm);
  let sql = `SELECT l.id, l.name, l.phone, l.email, l.status, l.created_at, l.assigned_to, l.product_id,
                    (${phoneMatch}) AS phone_match,
                    u.name AS assigned_name, p.name AS product_name
             FROM leads l
             LEFT JOIN users u ON u.id = l.assigned_to
             LEFT JOIN products p ON p.id = l.product_id
             WHERE l.archived_at IS NULL AND (${conds.join(' OR ')})`;
  if (excludeId) {
    sql += ' AND l.id <> ?';
    params.push(excludeId);
  }
  sql += ' ORDER BY l.created_at ASC LIMIT 10';
  const [rows] = await conn.query(sql, params);
  return rows;
}

/**
 * Rule: one active lead per mobile number per product. Returns the lead that
 * already holds this phone for the product, or null.
 */
async function findPhoneProductLead({ phone, productId, excludeId = null }, conn = pool) {
  const phoneNorm = normalizePhone(phone);
  if (!phoneNorm || phoneNorm.length < 10 || !productId) return null;
  const params = [phoneNorm, Number(productId)];
  let sql = `SELECT l.id, l.name, l.phone, l.status, l.assigned_to, u.name AS assigned_name, p.name AS product_name
             FROM leads l
             LEFT JOIN users u ON u.id = l.assigned_to
             LEFT JOIN products p ON p.id = l.product_id
             WHERE l.archived_at IS NULL AND l.phone_normalized = ? AND l.product_id = ?`;
  if (excludeId) {
    sql += ' AND l.id <> ?';
    params.push(excludeId);
  }
  const [rows] = await conn.query(`${sql} ORDER BY l.created_at ASC LIMIT 1`, params);
  return rows[0] || null;
}

async function setLeadTags(leadId, tagIds, conn = pool) {
  const ids = [...new Set((tagIds || []).map(Number).filter(Boolean))];
  await conn.query('DELETE FROM lead_tags WHERE lead_id = ?', [leadId]);
  if (!ids.length) return;
  const [valid] = await conn.query('SELECT id FROM tags WHERE id IN (?)', [ids]);
  if (!valid.length) return;
  await conn.query('INSERT IGNORE INTO lead_tags (lead_id, tag_id) VALUES ?', [valid.map((t) => [leadId, t.id])]);
}

module.exports = {
  STATUSES,
  OPEN_STATUSES,
  CLOSED_STATUSES,
  STAGE_PROBABILITY,
  SORTS,
  LEAD_SELECT,
  scoreSql,
  normalizePhone,
  hydrateLead,
  temperatureOf,
  buildLeadFilters,
  getLeadForUser,
  logStatusChange,
  touchActivity,
  assertSalesUser,
  assertProduct,
  findDuplicates,
  findPhoneProductLead,
  setLeadTags,
};
