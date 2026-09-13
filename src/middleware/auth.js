const pool = require('../config/db');
const { hashToken } = require('../utils/session');

const authenticate = async (req, res, next) => {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'Authentication required' });
  }

  const token = header.slice(7).trim();
  if (!token) {
    return res.status(401).json({ message: 'Authentication required' });
  }

  try {
    const tokenHash = hashToken(token);
    const [rows] = await pool.query(
      `SELECT
         s.id AS session_id,
         s.expires_at,
         s.revoked_at,
         u.id,
         u.name,
         u.email,
         u.role,
         u.phone,
         u.status
       FROM user_sessions s
       INNER JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ?
       LIMIT 1`,
      [tokenHash]
    );

    if (!rows.length) {
      return res.status(401).json({ message: 'Invalid or expired session' });
    }

    const row = rows[0];
    if (row.revoked_at) {
      return res.status(401).json({ message: 'Session has been terminated' });
    }
    if (new Date(row.expires_at).getTime() < Date.now()) {
      await pool.query(
        'UPDATE user_sessions SET revoked_at = COALESCE(revoked_at, NOW()) WHERE id = ?',
        [row.session_id]
      );
      return res.status(401).json({ message: 'Invalid or expired session' });
    }
    if (row.status !== 'active') {
      return res.status(403).json({ message: 'Account is inactive' });
    }

    req.user = {
      id: row.id,
      name: row.name,
      email: row.email,
      role: row.role,
      phone: row.phone,
    };
    req.sessionId = row.session_id;

    pool
      .query('UPDATE user_sessions SET last_seen_at = NOW() WHERE id = ?', [row.session_id])
      .catch(() => {});

    return next();
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: 'Authentication failed' });
  }
};

const authorize = (...roles) => (req, res, next) => {
  if (!req.user || !roles.includes(req.user.role)) {
    return res.status(403).json({ message: 'Access denied for this role' });
  }
  next();
};

module.exports = { authenticate, authorize };
