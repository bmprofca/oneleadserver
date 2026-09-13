const express = require('express');
const { body, validationResult } = require('express-validator');
const pool = require('../config/db');
const { authenticate } = require('../middleware/auth');
const {
  normalizePhone,
  generateOtp,
  hashOtp,
  compareOtp,
  getOtpExpiryDate,
  OTP_MAX_ATTEMPTS,
  OTP_TTL_MINUTES,
} = require('../utils/otp');
const { sendWhatsAppOtp } = require('../utils/whatsappOtp');
const {
  createSessionToken,
  hashToken,
  getSessionExpiryDate,
  summarizeUserAgent,
  getClientIp,
} = require('../utils/session');

const router = express.Router();

async function createUserSession(userId, req) {
  const token = createSessionToken();
  const tokenHash = hashToken(token);
  const expiresAt = getSessionExpiryDate();
  const userAgent = String(req.headers['user-agent'] || '').slice(0, 512) || null;
  const ipAddress = getClientIp(req);

  const [result] = await pool.query(
    `INSERT INTO user_sessions
     (user_id, token_hash, user_agent, ip_address, last_seen_at, expires_at)
     VALUES (?, ?, ?, ?, NOW(), ?)`,
    [userId, tokenHash, userAgent, ipAddress, expiresAt]
  );

  return {
    token,
    sessionId: result.insertId,
    expiresAt,
  };
}

function mapSessionRow(row, currentSessionId) {
  return {
    id: row.id,
    device: summarizeUserAgent(row.user_agent),
    userAgent: row.user_agent,
    ipAddress: row.ip_address,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    expiresAt: row.expires_at,
    current: row.id === currentSessionId,
  };
}

router.post(
  '/send-otp',
  body('phone').trim().notEmpty().withMessage('Mobile number is required'),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const phone = normalizePhone(req.body.phone);
    if (phone.length < 10) {
      return res.status(400).json({ message: 'Enter a valid mobile number' });
    }

    try {
      const [users] = await pool.query(
        `SELECT id, name, email, role, phone, status
         FROM users
         WHERE REPLACE(REPLACE(REPLACE(phone, ' ', ''), '-', ''), '+', '') = ?
            OR phone = ?
         LIMIT 1`,
        [phone, phone]
      );

      if (!users.length) {
        return res.status(404).json({ message: 'No account found for this mobile number' });
      }

      const user = users[0];
      if (user.status !== 'active') {
        return res.status(403).json({ message: 'Account is inactive' });
      }

      await pool.query(
        `UPDATE otp_verifications
         SET is_used = 1
         WHERE phone = ? AND is_used = 0 AND purpose = 'login'`,
        [phone]
      );

      const otp = generateOtp();
      const otpHash = await hashOtp(otp);
      const expiresAt = getOtpExpiryDate();

      await pool.query(
        `INSERT INTO otp_verifications
         (phone, otp_hash, purpose, attempts, max_attempts, is_used, expires_at)
         VALUES (?, ?, 'login', 0, ?, 0, ?)`,
        [phone, otpHash, OTP_MAX_ATTEMPTS, expiresAt]
      );

      const fixed = String(process.env.OTP_FIXED_CODE || '').trim();
      if (fixed) {
        return res.json({
          message: 'OTP sent successfully',
          phone,
          expiresInMinutes: OTP_TTL_MINUTES,
          devHint: `Use OTP ${fixed}`,
        });
      }

      try {
        await sendWhatsAppOtp(phone, otp);
      } catch (sendErr) {
        console.error('WhatsApp OTP send failed:', sendErr.details || sendErr.message);
        await pool.query(
          `UPDATE otp_verifications SET is_used = 1 WHERE phone = ? AND is_used = 0 AND purpose = 'login'`,
          [phone]
        );
        return res
          .status(sendErr.status || 502)
          .json({ message: sendErr.message || 'Failed to send OTP' });
      }

      return res.json({
        message: 'OTP sent successfully',
        phone,
        expiresInMinutes: OTP_TTL_MINUTES,
      });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ message: 'Failed to send OTP' });
    }
  }
);

router.post(
  '/verify-otp',
  body('phone').trim().notEmpty(),
  body('otp').trim().isLength({ min: 4, max: 8 }),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const phone = normalizePhone(req.body.phone);
    const otp = String(req.body.otp).trim();

    try {
      const [otpRows] = await pool.query(
        `SELECT * FROM otp_verifications
         WHERE phone = ? AND purpose = 'login' AND is_used = 0
         ORDER BY id DESC
         LIMIT 1`,
        [phone]
      );

      if (!otpRows.length) {
        return res.status(400).json({ message: 'No active OTP found. Please request a new one.' });
      }

      const record = otpRows[0];

      if (new Date(record.expires_at).getTime() < Date.now()) {
        await pool.query('UPDATE otp_verifications SET is_used = 1 WHERE id = ?', [record.id]);
        return res.status(400).json({ message: 'OTP expired. Please request a new one.' });
      }

      if (record.attempts >= record.max_attempts) {
        await pool.query('UPDATE otp_verifications SET is_used = 1 WHERE id = ?', [record.id]);
        return res.status(429).json({ message: 'Too many invalid attempts. Request a new OTP.' });
      }

      const valid = await compareOtp(otp, record.otp_hash);
      if (!valid) {
        await pool.query(
          'UPDATE otp_verifications SET attempts = attempts + 1 WHERE id = ?',
          [record.id]
        );
        return res.status(401).json({ message: 'Invalid OTP' });
      }

      await pool.query(
        `UPDATE otp_verifications
         SET is_used = 1, verified_at = NOW(), attempts = attempts + 1
         WHERE id = ?`,
        [record.id]
      );

      const [users] = await pool.query(
        `SELECT id, name, email, role, phone, status
         FROM users
         WHERE REPLACE(REPLACE(REPLACE(phone, ' ', ''), '-', ''), '+', '') = ?
            OR phone = ?
         LIMIT 1`,
        [phone, phone]
      );

      if (!users.length || users[0].status !== 'active') {
        return res.status(403).json({ message: 'Account unavailable' });
      }

      const user = users[0];
      const session = await createUserSession(user.id, req);

      return res.json({
        token: session.token,
        sessionId: session.sessionId,
        expiresAt: session.expiresAt,
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role,
          phone: user.phone,
        },
      });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ message: 'OTP verification failed' });
    }
  }
);

router.post('/logout', authenticate, async (req, res) => {
  try {
    await pool.query(
      'UPDATE user_sessions SET revoked_at = NOW() WHERE id = ? AND user_id = ? AND revoked_at IS NULL',
      [req.sessionId, req.user.id]
    );
    return res.json({ message: 'Logged out' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: 'Failed to log out' });
  }
});

router.get('/sessions', authenticate, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT id, user_agent, ip_address, last_seen_at, expires_at, created_at
       FROM user_sessions
       WHERE user_id = ?
         AND revoked_at IS NULL
         AND expires_at > NOW()
       ORDER BY last_seen_at DESC`,
      [req.user.id]
    );
    return res.json(rows.map((row) => mapSessionRow(row, req.sessionId)));
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: 'Failed to load sessions' });
  }
});

router.delete('/sessions/:id', authenticate, async (req, res) => {
  const sessionId = Number(req.params.id);
  if (!Number.isInteger(sessionId) || sessionId <= 0) {
    return res.status(400).json({ message: 'Invalid session id' });
  }

  try {
    const [result] = await pool.query(
      `UPDATE user_sessions
       SET revoked_at = NOW()
       WHERE id = ? AND user_id = ? AND revoked_at IS NULL`,
      [sessionId, req.user.id]
    );

    if (!result.affectedRows) {
      return res.status(404).json({ message: 'Session not found' });
    }

    return res.json({
      message: 'Session terminated',
      currentEnded: sessionId === req.sessionId,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: 'Failed to terminate session' });
  }
});

router.post('/sessions/revoke-others', authenticate, async (req, res) => {
  try {
    const [result] = await pool.query(
      `UPDATE user_sessions
       SET revoked_at = NOW()
       WHERE user_id = ?
         AND id <> ?
         AND revoked_at IS NULL`,
      [req.user.id, req.sessionId]
    );
    return res.json({
      message: 'Other sessions terminated',
      count: result.affectedRows || 0,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: 'Failed to terminate other sessions' });
  }
});

router.get('/me', authenticate, async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT id, name, email, role, phone, status, created_at FROM users WHERE id = ? LIMIT 1',
      [req.user.id]
    );
    if (!rows.length) {
      return res.status(404).json({ message: 'User not found' });
    }
    return res.json(rows[0]);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: 'Failed to fetch profile' });
  }
});

router.put(
  '/me',
  authenticate,
  body('name').optional().trim().notEmpty(),
  body('email').optional({ checkFalsy: true }).isEmail(),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const fields = [];
    const values = [];

    if (req.body.name !== undefined) {
      fields.push('name = ?');
      values.push(req.body.name);
    }
    if (req.body.email !== undefined) {
      fields.push('email = ?');
      values.push(req.body.email || null);
    }

    if (!fields.length) {
      return res.status(400).json({ message: 'No fields to update' });
    }

    values.push(req.user.id);

    try {
      await pool.query(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`, values);
      const [rows] = await pool.query(
        'SELECT id, name, email, role, phone, status, created_at FROM users WHERE id = ? LIMIT 1',
        [req.user.id]
      );
      return res.json(rows[0]);
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') {
        return res.status(409).json({ message: 'Email already exists' });
      }
      console.error(err);
      return res.status(500).json({ message: 'Failed to update profile' });
    }
  }
);

module.exports = router;
