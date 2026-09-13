const { toWhatsAppNumber } = require('./otp');

const WHATSAPP_API_URL =
  process.env.WHATSAPP_OTP_API_URL ||
  'https://server.onechatting.com/developer/message/send-template';
const WHATSAPP_TOKEN = process.env.WHATSAPP_OTP_TOKEN || '';
const WHATSAPP_TEMPLATE_ID = process.env.WHATSAPP_OTP_TEMPLATE_ID || '';

/**
 * Send login OTP via OneChatting WhatsApp AUTHENTICATION template.
 * Docs: body.parameters[0].text = OTP; button is added by the API for COPY_CODE.
 */
async function sendWhatsAppOtp(phone, otp) {
  if (!WHATSAPP_TOKEN || !WHATSAPP_TEMPLATE_ID) {
    const err = new Error('WhatsApp OTP is not configured on the server');
    err.status = 503;
    throw err;
  }

  const number = toWhatsAppNumber(phone);
  if (!number || number.length < 12) {
    const err = new Error('Invalid mobile number for WhatsApp');
    err.status = 400;
    throw err;
  }

  const response = await fetch(WHATSAPP_API_URL, {
    method: 'POST',
    headers: {
      token: WHATSAPP_TOKEN,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      number,
      template_id: WHATSAPP_TEMPLATE_ID,
      component: [
        {
          type: 'body',
          parameters: [
            {
              type: 'text',
              text: String(otp),
            },
          ],
        },
      ],
    }),
  });

  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }

  if (!response.ok) {
    const err = new Error(
      data?.message || data?.error || 'Failed to send OTP via WhatsApp'
    );
    err.status = response.status >= 400 ? response.status : 502;
    err.details = data;
    throw err;
  }

  if (data?.status && String(data.status).toLowerCase() !== 'sent') {
    const err = new Error(data?.message || 'WhatsApp OTP was not accepted');
    err.status = 502;
    err.details = data;
    throw err;
  }

  return data;
}

module.exports = {
  sendWhatsAppOtp,
};
