const { Resend } = require("resend");

const OTP_FROM = process.env.OTP_FROM_EMAIL || "ACE IIIT <otp@aceiiit.in>";
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

  throw new Error(`Failed to send OTP email. ${failures.join(" | ")}`);
}

module.exports = { sendOtpEmail, buildOtpEmailHtml };
