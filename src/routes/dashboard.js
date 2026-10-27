const express = require('express');
const pool = require('../config/db');
const { authenticate } = require('../middleware/auth');
const { formatMysqlDateTime } = require('../utils/timezone');
const { LEAD_SELECT, hydrateLead, scoreSql } = require('../services/leads');

const router = express.Router();

router.use(authenticate);

router.get('/', async (req, res) => {
  try {
    const isSales = req.user.role === 'sales';
    const leadFilter = isSales ? 'WHERE archived_at IS NULL AND assigned_to = ?' : 'WHERE archived_at IS NULL';
    const leadParams = isSales ? [req.user.id] : [];

    const [leadStats] = await pool.query(
      `SELECT
         COUNT(*) AS total_leads,
         SUM(status = 'new') AS new_leads,
         SUM(status = 'contacted') AS contacted_leads,
         SUM(status IN ('qualified','proposal','negotiation')) AS in_progress_leads,
         SUM(status = 'won') AS won_leads,
         SUM(status = 'lost') AS lost_leads,
         SUM(assigned_to IS NULL) AS unassigned_leads,
         SUM(status IN ('new','contacted','qualified','proposal','negotiation')) AS open_leads,
         COALESCE(SUM(CASE WHEN status IN ('new','contacted','qualified','proposal','negotiation') THEN deal_value END), 0) AS open_value,
         COALESCE(SUM(CASE WHEN status = 'won' THEN deal_value END), 0) AS won_value,
         SUM(created_at >= CURDATE() - INTERVAL 6 DAY) AS created_last_7_days,
         SUM(status = 'won' AND stage_changed_at >= DATE_FORMAT(CURDATE(), '%Y-%m-01')) AS won_this_month
       FROM leads ${leadFilter}`,
      leadParams
    );

    const [leadByStatus] = await pool.query(
      `SELECT status, COUNT(*) AS total
       FROM leads ${leadFilter}
       GROUP BY status
       ORDER BY FIELD(status, 'new','contacted','qualified','proposal','negotiation','won','lost','not_interested')`,
      leadParams
    );

    const reminderFilter = isSales
      ? 'WHERE user_id = ? AND lead_id IN (SELECT id FROM leads WHERE archived_at IS NULL)'
      : 'WHERE lead_id IN (SELECT id FROM leads WHERE archived_at IS NULL)';
    const reminderParams = isSales ? [req.user.id] : [];

    const [reminderStats] = await pool.query(
      `SELECT
         COUNT(*) AS total_reminders,
         SUM(is_completed = 0 AND remind_at >= NOW()) AS upcoming_reminders,
         SUM(is_completed = 0 AND remind_at < NOW()) AS overdue_reminders,
         SUM(is_completed = 1) AS completed_reminders,
         SUM(is_completed = 0 AND remind_at >= CURDATE() AND remind_at < CURDATE() + INTERVAL 1 DAY) AS due_today_reminders
       FROM reminders ${reminderFilter}`,
      reminderParams
    );

    const appointmentFilter = isSales ? 'WHERE user_id = ?' : '';
    const appointmentParams = isSales ? [req.user.id] : [];

    const [appointmentStats] = await pool.query(
      `SELECT
         COUNT(*) AS total_appointments,
         SUM(status = 'scheduled') AS scheduled_appointments,
         SUM(status = 'completed') AS completed_appointments,
         SUM(status = 'cancelled') AS cancelled_appointments,
         SUM(status = 'no_show') AS no_show_appointments
       FROM appointments ${appointmentFilter}`,
      appointmentParams
    );

    const [appointmentByStatus] = await pool.query(
      `SELECT status, COUNT(*) AS total
       FROM appointments ${appointmentFilter}
       GROUP BY status`,
      appointmentParams
    );

    const calendarStart = new Date();
    calendarStart.setHours(0, 0, 0, 0);
    calendarStart.setDate(calendarStart.getDate() - 14);
    const calendarEnd = new Date();
    calendarEnd.setHours(0, 0, 0, 0);
    calendarEnd.setDate(calendarEnd.getDate() + 22);
    const calendarStartSql = formatMysqlDateTime(calendarStart);
    const calendarEndSql = formatMysqlDateTime(calendarEnd);

    const calendarWhere = isSales
      ? 'WHERE a.user_id = ? AND a.start_at >= ? AND a.start_at < ?'
      : 'WHERE a.start_at >= ? AND a.start_at < ?';
    const calendarParams = isSales
      ? [req.user.id, calendarStartSql, calendarEndSql]
      : [calendarStartSql, calendarEndSql];

    const [calendarAppointments] = await pool.query(
      `SELECT a.id, a.title, a.start_at, a.end_at, a.status, a.platform,
              l.name AS lead_name, u.name AS assigned_name
       FROM appointments a
       LEFT JOIN leads l ON l.id = a.lead_id
       LEFT JOIN users u ON u.id = a.user_id
       ${calendarWhere}
       ORDER BY a.start_at ASC`,
      calendarParams
    );

    const [productLeadCounts] = await pool.query(
      isSales
        ? `SELECT p.name, COUNT(l.id) AS total
           FROM products p
           LEFT JOIN leads l ON l.product_id = p.id AND l.archived_at IS NULL AND l.assigned_to = ?
           WHERE p.status = 'active'
           GROUP BY p.id, p.name
           ORDER BY total DESC
           LIMIT 6`
        : `SELECT p.name, COUNT(l.id) AS total
           FROM products p
           LEFT JOIN leads l ON l.product_id = p.id AND l.archived_at IS NULL
           WHERE p.status = 'active'
           GROUP BY p.id, p.name
           ORDER BY total DESC
           LIMIT 6`,
      isSales ? [req.user.id] : []
    );

    const scope = isSales ? 'AND l.assigned_to = ?' : '';
    const scopeParams = isSales ? [req.user.id] : [];
    const [hotLeads] = await pool.query(
      `${LEAD_SELECT}
       WHERE l.archived_at IS NULL ${scope}
         AND l.status IN ('new','contacted','qualified','proposal','negotiation')
       ORDER BY ${scoreSql('l')} DESC, l.updated_at DESC
       LIMIT 6`,
      scopeParams
    );
    const [recentActivity] = await pool.query(
      `SELECT c.id, c.lead_id, c.type, c.direction, c.subject, c.content, c.outcome,
              COALESCE(c.occurred_at, c.created_at) AS at, u.name AS user_name, l.name AS lead_name
       FROM communications c
       INNER JOIN leads l ON l.id = c.lead_id
       LEFT JOIN users u ON u.id = c.user_id
       WHERE l.archived_at IS NULL ${scope}
       ORDER BY at DESC
       LIMIT 8`,
      scopeParams
    );

    const numeric = (row) =>
      Object.fromEntries(Object.entries(row || {}).map(([k, v]) => [k, Number(v) || 0]));

    return res.json({
      hotLeads: hotLeads.map(hydrateLead),
      recentActivity,
      leads: numeric(leadStats[0]),
      leadByStatus,
      reminders: numeric(reminderStats[0]),
      appointments: numeric(appointmentStats[0]),
      appointmentByStatus,
      calendarAppointments,
      productLeadCounts,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: 'Failed to load dashboard' });
  }
});

module.exports = router;
