const { normalizePhone } = require('../utils/otp');

/**
 * India WhatsApp number: 91 + 10-digit mobile.
 */
function toWhatsAppNumber(phone) {
  let digits = normalizePhone(phone);
  if (!digits) return '';
  if (digits.startsWith('91') && digits.length >= 12) {
    return digits.slice(0, 12);
  }
  if (digits.length > 10) {
    digits = digits.slice(-10);
  }
  return `91${digits}`;
}

/**
 * Send login OTP via OneChatting WhatsApp AUTHENTICATION template.
 */
async function sendWhatsAppOtp(phone, otp) {
  const url =
    process.env.WHATSAPP_OTP_URL ||
    'https://server.onechatting.com/developer/message/send-template';
  const token = process.env.WHATSAPP_OTP_TOKEN;
  const templateId = process.env.WHATSAPP_OTP_TEMPLATE_ID;

  if (!token || !templateId) {
    const err = new Error('WhatsApp OTP is not configured on the server');
    err.status = 500;
    throw err;
  }

  const number = toWhatsAppNumber(phone);
  if (number.length < 12) {
    const err = new Error('Invalid mobile number for WhatsApp OTP');
    err.status = 400;
    throw err;
  }

  const otpText = String(otp);
  const body = {
    number,
    template_id: templateId,
    // AUTHENTICATION COPY_CODE: body OTP only — API adds the button automatically.
    component: [
      {
        type: 'body',
        parameters: [{ type: 'text', text: otpText }],
      },
    ],
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      token,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }

  if (!response.ok) {
    const message =
      data?.message ||
      data?.error ||
      `WhatsApp OTP send failed (${response.status})`;
    const err = new Error(message);
    err.status = 502;
    err.details = data;
    throw err;
  }

  if (data?.status && String(data.status).toLowerCase() !== 'sent') {
    const err = new Error(data?.message || 'WhatsApp OTP was not sent');
    err.status = 502;
    err.details = data;
    throw err;
  }

  return data;
}

module.exports = {
  toWhatsAppNumber,
  sendWhatsAppOtp,
};
