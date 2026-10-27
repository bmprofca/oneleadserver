const express = require('express');
const pool = require('../config/db');
const { authenticate } = require('../middleware/auth');
const { asyncHandler } = require('../lib/http');

const router = express.Router();
router.use(authenticate);

const REMINDER_SELECT = `SELECT r.*, l.name AS lead_name, l.phone AS lead_phone, l.status AS lead_status,
    l.whatsapp_active AS lead_whatsapp, l.address AS lead_address, l.maps_url AS lead_maps_url,
    l.business_profile_url AS lead_business_profile_url, l.latitude AS lead_latitude, l.longitude AS lead_longitude,
    au.name AS lead_assigned_name, p.name AS product_name, u.name AS user_name
  FROM reminders r
  INNER JOIN leads l ON l.id = r.lead_id
  LEFT JOIN products p ON p.id = r.product_id
  LEFT JOIN users u ON u.id = r.user_id
  LEFT JOIN users au ON au.id = l.assigned_to`;

/**
 * "My day": overdue, due-today and upcoming callbacks plus appointments.
 * Admins may pass ?scope=all or ?user_id= to see the team's work.
 */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const isAdmin = req.user.role === 'admin';
    let userId = req.user.id;
    if (isAdmin && req.query.scope === 'all') userId = null;
    else if (isAdmin && req.query.user_id) userId = Number(req.query.user_id);

    const rScope = userId ? 'AND r.user_id = ?' : '';
    const aScope = userId ? 'AND a.user_id = ?' : '';
    const p = userId ? [userId] : [];
    const base = `WHERE l.archived_at IS NULL AND r.is_completed = 0 ${rScope}`;

    const [overdue] = await pool.query(
      `${REMINDER_SELECT} ${base} AND r.remind_at < NOW() ORDER BY r.remind_at ASC LIMIT 200`,
      p
    );
    const [today] = await pool.query(
      `${REMINDER_SELECT} ${base} AND r.remind_at >= NOW() AND r.remind_at < CURDATE() + INTERVAL 1 DAY
       ORDER BY r.remind_at ASC`,
      p
    );
    const [upcoming] = await pool.query(
      `${REMINDER_SELECT} ${base} AND r.remind_at >= CURDATE() + INTERVAL 1 DAY AND r.remind_at < CURDATE() + INTERVAL 8 DAY
       ORDER BY r.remind_at ASC LIMIT 200`,
      p
    );
    const [completedToday] = await pool.query(
      `${REMINDER_SELECT} WHERE r.is_completed = 1 ${rScope}
       AND r.completed_at >= CURDATE() ORDER BY r.completed_at DESC LIMIT 50`,
      p
    );
    const [appointments] = await pool.query(
      `SELECT a.*, (a.start_at < CURDATE() + INTERVAL 1 DAY) AS is_today, l.name AS lead_name, l.phone AS lead_phone,
         l.whatsapp_active AS lead_whatsapp, l.address AS lead_address, l.maps_url AS lead_maps_url,
         l.business_profile_url AS lead_business_profile_url, l.latitude AS lead_latitude, l.longitude AS lead_longitude,
         p.name AS product_name, u.name AS assigned_name
       FROM appointments a
       LEFT JOIN leads l ON l.id = a.lead_id
       LEFT JOIN products p ON p.id = a.product_id
       LEFT JOIN users u ON u.id = a.user_id
       WHERE a.status = 'scheduled' ${aScope}
         AND a.start_at >= CURDATE() AND a.start_at < CURDATE() + INTERVAL 8 DAY
       ORDER BY a.start_at ASC`,
      p
    );

    const todayAppointments = appointments.filter((a) => Number(a.is_today) === 1);

    return res.json({
      counts: {
        overdue: overdue.length,
        today: today.length,
        upcoming: upcoming.length,
        completed_today: completedToday.length,
        appointments_today: todayAppointments.length,
      },
      overdue,
      today,
      upcoming,
      completed_today: completedToday,
      appointments,
    });
  })
);

module.exports = router;
