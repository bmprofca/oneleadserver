const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { addMinutesMysql } = require('./timezone');

const OTP_TTL_MINUTES = Number(process.env.OTP_TTL_MINUTES || 10);
const OTP_MAX_ATTEMPTS = Number(process.env.OTP_MAX_ATTEMPTS || 5);

/** Normalize to digits-only mobile number (prefer last 10 for India). */
function normalizePhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length >= 10) return digits.slice(-10);
  return digits;
}

/** WhatsApp destination: 91 + 10-digit Indian mobile. */
function toWhatsAppNumber(phone) {
  const local = normalizePhone(phone);
  if (!local) return '';
  if (local.length === 10) return `91${local}`;
  if (local.startsWith('91') && local.length === 12) return local;
  return `91${local.slice(-10)}`;
}

/**
 * Generate a 6-digit OTP.
 * Set OTP_FIXED_CODE in .env only for local/dev bypass.
 */
function generateOtp() {
  const fixed = String(process.env.OTP_FIXED_CODE || '').trim();
  if (fixed) return fixed;
  return String(crypto.randomInt(100000, 999999));
}

async function hashOtp(otp) {
  return bcrypt.hash(String(otp), 10);
}

async function compareOtp(otp, otpHash) {
  return bcrypt.compare(String(otp), otpHash);
}

function getOtpExpiryDate() {
  return addMinutesMysql(OTP_TTL_MINUTES);
}

module.exports = {
  normalizePhone,
  toWhatsAppNumber,
  generateOtp,
  hashOtp,
  compareOtp,
  getOtpExpiryDate,
  OTP_TTL_MINUTES,
  OTP_MAX_ATTEMPTS,
};
