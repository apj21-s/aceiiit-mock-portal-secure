const { Resend } = require("resend");

function resolveFromEmail() {
  if (process.env.OTP_FROM_EMAIL) {
    return process.env.OTP_FROM_EMAIL;
  }
  if (process.env.RESEND_FROM) {
    return process.env.RESEND_FROM;
  }

  const fromEmail = String(process.env.MAIL_FROM_EMAIL || "").trim();
  const fromName = String(process.env.MAIL_FROM_NAME || "").trim();
  if (fromEmail) {
    return fromName ? `${fromName} <${fromEmail}>` : fromEmail;
  }

  return "ACE IIIT <otp@aceiiit.in>";
}

const OTP_FROM = resolveFromEmail();
const OTP_SUBJECT = process.env.OTP_SUBJECT || "ACE IIIT OTP Verification";

let cachedResend = null;
let cachedResendKey = null;

function buildOtpEmailHtml(otp) {
  return `
      <div style="font-family: Arial;">
        <h2>ACE IIIT Mock Portal</h2>
        <p>Your OTP is:</p>
        <h1>${String(otp || "").trim()}</h1>
        <p>This OTP is valid for 5 minutes.</p>
      </div>
    `;
}

function buildOtpPayload(email, otp) {
  return {
    from: OTP_FROM,
    to: [String(email || "").trim().toLowerCase()],
    subject: OTP_SUBJECT,
    html: buildOtpEmailHtml(otp),
  };
}

function getResend() {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    return null;
  }
  if (cachedResend && cachedResendKey === apiKey) {
    return cachedResend;
  }
  cachedResendKey = apiKey;
  cachedResend = new Resend(apiKey);
  return cachedResend;
}

async function sendViaResend(payload) {
  const resend = getResend();
  if (!resend) {
    throw new Error("RESEND_API_KEY is not configured.");
  }

  const { error } = await resend.emails.send(payload);
  if (error) {
    const message = typeof error === "string"
      ? error
      : String(error.message || error.name || "Resend failed");
    throw new Error(message);
  }

  return { provider: "resend" };
}

async function sendViaBrevo(payload) {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) {
    throw new Error("BREVO_API_KEY is not configured.");
  }

  const response = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: {
      "accept": "application/json",
      "api-key": apiKey,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      sender: parseFromAddress(payload.from),
      to: payload.to.map((email) => ({ email })),
      subject: payload.subject,
      htmlContent: payload.html,
    }),
  });

  if (!response.ok) {
    const bodyText = await response.text();
    throw new Error(`Brevo failed (${response.status}): ${bodyText || response.statusText}`);
  }

  return { provider: "brevo" };
}

function parseFromAddress(from) {
  const raw = String(from || "").trim();
  const match = raw.match(/^(.*)<([^>]+)>$/);
  if (!match) {
    return { email: raw };
  }

  return {
    name: String(match[1] || "").replace(/"/g, "").trim(),
    email: String(match[2] || "").trim(),
  };
}

async function sendOtpEmail(email, otp) {
  const payload = buildOtpPayload(email, otp);
  const failures = [];

  try {
    return await sendViaResend(payload);
  } catch (error) {
    failures.push(`resend: ${error.message}`);
    // eslint-disable-next-line no-console
    console.warn("OTP send via Resend failed, trying Brevo.", error);
  }

  try {
    return await sendViaBrevo(payload);
  } catch (error) {
    failures.push(`brevo: ${error.message}`);
    // eslint-disable-next-line no-console
    console.error("OTP send via Brevo failed.", error);
  }

  const error = new Error("OTP delivery is temporarily unavailable. Please try again shortly.");
  error.status = 503;
  error.expose = true;
  error.details = failures;
  throw error;
}

module.exports = { sendOtpEmail, buildOtpEmailHtml };
