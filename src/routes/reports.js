const express = require('express');
const pool = require('../config/db');
const { authenticate } = require('../middleware/auth');
const { asyncHandler, badRequest } = require('../lib/http');
const { STAGE_PROBABILITY } = require('../services/leads');

const router = express.Router();
router.use(authenticate);

const FUNNEL = ['new', 'contacted', 'qualified', 'proposal', 'negotiation', 'won'];
const num = (v) => Number(v) || 0;

function dayString(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function parseRange(query) {
  const to = query.to && /^\d{4}-\d{2}-\d{2}$/.test(query.to) ? query.to : dayString(new Date());
  let from = query.from && /^\d{4}-\d{2}-\d{2}$/.test(query.from) ? query.from : null;
  if (!from) {
    const d = new Date(`${to}T00:00:00`);
    d.setDate(d.getDate() - 29);
    from = dayString(d);
  }
  if (from > to) throw badRequest('"From" date must be before "to" date');
  const days = Math.round((new Date(`${to}T00:00:00`) - new Date(`${from}T00:00:00`)) / 86400000) + 1;
  if (days > 731) throw badRequest('Choose a range of two years or less');
  return { from, to, start: `${from} 00:00:00`, end: `${to} 23:59:59`, days };
}

/**
 * GET /api/reports?from=YYYY-MM-DD&to=YYYY-MM-DD&user_id=&product_id=
 * Sales users always get their own numbers.
 */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const range = parseRange(req.query);
    const isAdmin = req.user.role === 'admin';
    const userId = isAdmin ? (req.query.user_id ? Number(req.query.user_id) : null) : req.user.id;
    const productId = req.query.product_id ? Number(req.query.product_id) : null;

    // Scope applied to the leads table (alias l).
    const scope = ['l.archived_at IS NULL'];
    const scopeParams = [];
    if (userId) {
      scope.push('l.assigned_to = ?');
      scopeParams.push(userId);
    }
    if (productId) {
      scope.push('l.product_id = ?');
      scopeParams.push(productId);
    }
    const S = scope.join(' AND ');
    const inRange = [range.start, range.end];

    // Cohort: leads created in the range.
    const [[created]] = await pool.query(
      `SELECT COUNT(*) AS total FROM leads l WHERE ${S} AND l.created_at BETWEEN ? AND ?`,
      [...scopeParams, ...inRange]
    );

    // Outcomes: stage changes that happened in the range.
    const [[outcomes]] = await pool.query(
      `SELECT
         COUNT(DISTINCT CASE WHEN h.to_status = 'won' THEN h.lead_id END) AS won,
         COUNT(DISTINCT CASE WHEN h.to_status = 'lost' THEN h.lead_id END) AS lost,
         COUNT(DISTINCT CASE WHEN h.to_status = 'not_interested' THEN h.lead_id END) AS not_interested,
         COUNT(DISTINCT h.lead_id) AS touched
       FROM lead_status_history h INNER JOIN leads l ON l.id = h.lead_id
       WHERE ${S} AND h.created_at BETWEEN ? AND ?`,
      [...scopeParams, ...inRange]
    );
    const [[wonValue]] = await pool.query(
      `SELECT COALESCE(SUM(l.deal_value), 0) AS value,
              AVG(DATEDIFF(l.stage_changed_at, l.created_at)) AS avg_days
       FROM leads l
       WHERE ${S} AND l.status = 'won' AND l.stage_changed_at BETWEEN ? AND ?`,
      [...scopeParams, ...inRange]
    );
    const [openStages] = await pool.query(
      `SELECT l.status, COUNT(*) AS count, COALESCE(SUM(l.deal_value), 0) AS value,
              AVG(DATEDIFF(NOW(), COALESCE(l.stage_changed_at, l.created_at))) AS avg_days_in_stage
       FROM leads l
       WHERE ${S} AND l.status IN ('new','contacted','qualified','proposal','negotiation')
       GROUP BY l.status`,
      scopeParams
    );

    // Activity volume in range (by the user who logged it when filtering by user).
    const actScope = ['c.created_at BETWEEN ? AND ?'];
    const actParams = [...inRange];
    if (userId) {
      actScope.push('c.user_id = ?');
      actParams.push(userId);
    }
    if (productId) {
      actScope.push('l.product_id = ?');
      actParams.push(productId);
    }
    const [activityTypes] = await pool.query(
      `SELECT c.type, COUNT(*) AS total FROM communications c INNER JOIN leads l ON l.id = c.lead_id
       WHERE ${actScope.join(' AND ')} GROUP BY c.type`,
      actParams
    );

    const remScope = userId ? 'AND r.user_id = ?' : '';
    const remParams = userId ? [userId] : [];
    const [[reminderStats]] = await pool.query(
      `SELECT
         SUM(r.is_completed = 1 AND r.completed_at BETWEEN ? AND ?) AS completed,
         SUM(r.is_completed = 0 AND r.remind_at < NOW()) AS overdue
       FROM reminders r INNER JOIN leads l ON l.id = r.lead_id
       WHERE l.archived_at IS NULL ${remScope}`,
      [...inRange, ...remParams]
    );

    // Funnel for the cohort: a lead "reached" a stage if it is at or past it now,
    // or its history shows it got there (lost leads keep their furthest stage).
    const funnel = [];
    for (let i = 0; i < FUNNEL.length; i += 1) {
      const later = FUNNEL.slice(i);
      const [[row]] = await pool.query(
        `SELECT COUNT(*) AS total FROM leads l
         WHERE ${S} AND l.created_at BETWEEN ? AND ?
           AND (l.status IN (?) OR EXISTS (
             SELECT 1 FROM lead_status_history h WHERE h.lead_id = l.id AND h.to_status IN (?)
           ))`,
        [...scopeParams, ...inRange, later, later]
      );
      funnel.push({ stage: FUNNEL[i], count: i === 0 ? num(created.total) : num(row.total) });
    }

    // Trend: daily up to 62 days, weekly beyond.
    const weekly = range.days > 62;
    const bucket = (col) => (weekly ? `DATE_SUB(DATE(${col}), INTERVAL WEEKDAY(${col}) DAY)` : `DATE(${col})`);
    const [createdTrend] = await pool.query(
      `SELECT ${bucket('l.created_at')} AS bucket, COUNT(*) AS total FROM leads l
       WHERE ${S} AND l.created_at BETWEEN ? AND ? GROUP BY bucket`,
      [...scopeParams, ...inRange]
    );
    const [wonTrend] = await pool.query(
      `SELECT ${bucket('h.created_at')} AS bucket,
              COUNT(DISTINCT CASE WHEN h.to_status = 'won' THEN h.lead_id END) AS won,
              COUNT(DISTINCT CASE WHEN h.to_status = 'lost' THEN h.lead_id END) AS lost
       FROM lead_status_history h INNER JOIN leads l ON l.id = h.lead_id
       WHERE ${S} AND h.created_at BETWEEN ? AND ? GROUP BY bucket`,
      [...scopeParams, ...inRange]
    );
    const key = (v) => (v instanceof Date ? dayString(v) : String(v).slice(0, 10));
    const trendMap = new Map();
    const cursor = new Date(`${range.from}T00:00:00`);
    if (weekly) cursor.setDate(cursor.getDate() - ((cursor.getDay() + 6) % 7));
    const endDate = new Date(`${range.to}T00:00:00`);
    while (cursor <= endDate) {
      trendMap.set(dayString(cursor), { date: dayString(cursor), created: 0, won: 0, lost: 0 });
      cursor.setDate(cursor.getDate() + (weekly ? 7 : 1));
    }
    for (const r of createdTrend) {
      const t = trendMap.get(key(r.bucket));
      if (t) t.created = num(r.total);
    }
    for (const r of wonTrend) {
      const t = trendMap.get(key(r.bucket));
      if (t) {
        t.won = num(r.won);
        t.lost = num(r.lost);
      }
    }

    const [bySource] = await pool.query(
      `SELECT COALESCE(NULLIF(l.source, ''), 'unknown') AS source, COUNT(*) AS total,
              SUM(l.status = 'won') AS won, COALESCE(SUM(CASE WHEN l.status = 'won' THEN l.deal_value END), 0) AS won_value
       FROM leads l WHERE ${S} AND l.created_at BETWEEN ? AND ?
       GROUP BY source ORDER BY total DESC`,
      [...scopeParams, ...inRange]
    );
    const [byProduct] = await pool.query(
      `SELECT COALESCE(p.name, 'No product') AS product, COUNT(*) AS total, SUM(l.status = 'won') AS won,
              SUM(l.status IN ('new','contacted','qualified','proposal','negotiation')) AS open
       FROM leads l LEFT JOIN products p ON p.id = l.product_id
       WHERE ${S} AND l.created_at BETWEEN ? AND ?
       GROUP BY product ORDER BY total DESC LIMIT 20`,
      [...scopeParams, ...inRange]
    );
    const [lostReasons] = await pool.query(
      `SELECT COALESCE(NULLIF(l.lost_reason, ''), 'Not specified') AS reason, COUNT(*) AS total
       FROM leads l WHERE ${S} AND l.status = 'lost' AND l.stage_changed_at BETWEEN ? AND ?
       GROUP BY reason ORDER BY total DESC`,
      [...scopeParams, ...inRange]
    );

    let team = [];
    if (isAdmin) {
      const pScope = productId ? 'AND l.product_id = ?' : '';
      const pParam = productId ? [productId] : [];
      const [rows] = await pool.query(
        `SELECT u.id, u.name, u.status,
           (SELECT COUNT(*) FROM leads l WHERE l.assigned_to = u.id AND l.archived_at IS NULL ${pScope}
              AND l.status IN ('new','contacted','qualified','proposal','negotiation')) AS open_leads,
           (SELECT COALESCE(SUM(l.deal_value), 0) FROM leads l WHERE l.assigned_to = u.id AND l.archived_at IS NULL ${pScope}
              AND l.status IN ('new','contacted','qualified','proposal','negotiation')) AS open_value,
           (SELECT COUNT(*) FROM leads l WHERE l.assigned_to = u.id AND l.archived_at IS NULL ${pScope}
              AND l.created_at BETWEEN ? AND ?) AS new_leads,
           (SELECT COUNT(DISTINCT h.lead_id) FROM lead_status_history h INNER JOIN leads l ON l.id = h.lead_id
              WHERE l.assigned_to = u.id ${pScope} AND h.to_status = 'won' AND h.created_at BETWEEN ? AND ?) AS won,
           (SELECT COUNT(DISTINCT h.lead_id) FROM lead_status_history h INNER JOIN leads l ON l.id = h.lead_id
              WHERE l.assigned_to = u.id ${pScope} AND h.to_status = 'lost' AND h.created_at BETWEEN ? AND ?) AS lost,
           (SELECT COALESCE(SUM(l.deal_value), 0) FROM leads l WHERE l.assigned_to = u.id ${pScope}
              AND l.status = 'won' AND l.stage_changed_at BETWEEN ? AND ?) AS won_value,
           (SELECT COUNT(*) FROM communications c WHERE c.user_id = u.id AND c.created_at BETWEEN ? AND ?) AS activities,
           (SELECT COUNT(*) FROM communications c WHERE c.user_id = u.id AND c.type = 'call' AND c.created_at BETWEEN ? AND ?) AS calls,
           (SELECT COUNT(*) FROM reminders r WHERE r.user_id = u.id AND r.is_completed = 1 AND r.completed_at BETWEEN ? AND ?) AS followups_done,
           (SELECT COUNT(*) FROM reminders r INNER JOIN leads l ON l.id = r.lead_id
              WHERE r.user_id = u.id AND r.is_completed = 0 AND r.remind_at < NOW() AND l.archived_at IS NULL) AS overdue
         FROM users u
         WHERE u.role = 'sales' ${userId ? 'AND u.id = ?' : ''}
         ORDER BY u.status = 'active' DESC, u.name ASC`,
        [
          ...pParam,
          ...pParam,
          ...pParam,
          ...inRange,
          ...pParam,
          ...inRange,
          ...pParam,
          ...inRange,
          ...pParam,
          ...inRange,
          ...inRange,
          ...inRange,
          ...inRange,
          ...(userId ? [userId] : []),
        ]
      );
      team = rows.map((r) => {
        const won = num(r.won);
        const lost = num(r.lost);
        return {
          id: r.id,
          name: r.name,
          status: r.status,
          open_leads: num(r.open_leads),
          open_value: num(r.open_value),
          new_leads: num(r.new_leads),
          won,
          lost,
          win_rate: won + lost ? Math.round((won / (won + lost)) * 1000) / 10 : null,
          won_value: num(r.won_value),
          activities: num(r.activities),
          calls: num(r.calls),
          followups_done: num(r.followups_done),
          overdue: num(r.overdue),
        };
      });
    }

    const won = num(outcomes.won);
    const lost = num(outcomes.lost);
    const openValue = openStages.reduce((n, s) => n + num(s.value), 0);
    const weighted = openStages.reduce((n, s) => n + num(s.value) * (STAGE_PROBABILITY[s.status] || 0), 0);
    const activities = Object.fromEntries(activityTypes.map((a) => [a.type, num(a.total)]));

    return res.json({
      range: { from: range.from, to: range.to, days: range.days, granularity: weekly ? 'week' : 'day' },
      summary: {
        leads_created: num(created.total),
        won,
        lost,
        not_interested: num(outcomes.not_interested),
        win_rate: won + lost ? Math.round((won / (won + lost)) * 1000) / 10 : null,
        won_value: num(wonValue.value),
        avg_days_to_win: wonValue.avg_days === null ? null : Math.round(Number(wonValue.avg_days) * 10) / 10,
        open_leads: openStages.reduce((n, s) => n + num(s.count), 0),
        open_value: openValue,
        weighted_forecast: Math.round(weighted * 100) / 100,
        activities_logged: Object.values(activities).reduce((a, b) => a + b, 0),
        calls: activities.call || 0,
        followups_completed: num(reminderStats.completed),
        overdue_followups: num(reminderStats.overdue),
      },
      funnel: funnel.map((f, i) => ({
        ...f,
        conversion_from_previous: i === 0 || !funnel[i - 1].count ? null : Math.round((f.count / funnel[i - 1].count) * 1000) / 10,
      })),
      stage_aging: ['new', 'contacted', 'qualified', 'proposal', 'negotiation'].map((status) => {
        const s = openStages.find((x) => x.status === status);
        return {
          status,
          count: num(s?.count),
          value: num(s?.value),
          avg_days_in_stage: s?.avg_days_in_stage === undefined || s?.avg_days_in_stage === null ? null : Math.round(Number(s.avg_days_in_stage) * 10) / 10,
        };
      }),
      trend: [...trendMap.values()],
      activities_by_type: activities,
      by_source: bySource.map((r) => ({ source: r.source, total: num(r.total), won: num(r.won), won_value: num(r.won_value) })),
      by_product: byProduct.map((r) => ({ product: r.product, total: num(r.total), won: num(r.won), open: num(r.open) })),
      lost_reasons: lostReasons.map((r) => ({ reason: r.reason, total: num(r.total) })),
      team,
    });
  })
);

module.exports = router;
