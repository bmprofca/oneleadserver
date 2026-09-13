const crypto = require('crypto');

function getSessionTtlDays() {
  const days = Number(process.env.SESSION_TTL_DAYS || 30);
  return Number.isFinite(days) && days > 0 ? days : 30;
}

function createSessionToken() {
  return crypto.randomBytes(32).toString('hex');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function getSessionExpiryDate(from = new Date()) {
  const expires = new Date(from);
  expires.setDate(expires.getDate() + getSessionTtlDays());
  return expires;
}

function summarizeUserAgent(ua = '') {
  const value = String(ua || '').trim();
  if (!value) return 'Unknown device';

  let browser = 'Browser';
  if (/edg\//i.test(value)) browser = 'Edge';
  else if (/chrome\//i.test(value) && !/edg\//i.test(value)) browser = 'Chrome';
  else if (/safari\//i.test(value) && !/chrome\//i.test(value)) browser = 'Safari';
  else if (/firefox\//i.test(value)) browser = 'Firefox';

  let os = 'Unknown OS';
  if (/windows nt/i.test(value)) os = 'Windows';
  else if (/android/i.test(value)) os = 'Android';
  else if (/iphone|ipad|ipod/i.test(value)) os = 'iOS';
  else if (/mac os x/i.test(value)) os = 'macOS';
  else if (/linux/i.test(value)) os = 'Linux';

  return `${browser} on ${os}`;
}

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim().slice(0, 64);
  }
  return (req.ip || req.socket?.remoteAddress || '').slice(0, 64) || null;
}

module.exports = {
  createSessionToken,
  hashToken,
  getSessionExpiryDate,
  getSessionTtlDays,
  summarizeUserAgent,
  getClientIp,
};
