const { Resend } = require("resend");
const nodemailer = require("nodemailer");

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
let cachedReminderTransport = null;
let cachedReminderTransportKey = null;

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

function buildEmailPayload(input) {
  const source = input || {};
  return {
    from: String(source.from || OTP_FROM),
    to: Array.isArray(source.to) ? source.to.map((item) => String(item || "").trim().toLowerCase()).filter(Boolean) : [],
    subject: String(source.subject || "").trim(),
    html: String(source.html || ""),
  };
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
    signal: AbortSignal.timeout(5000),
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
  return sendEmailThroughProviders(payload);
}

function getReminderTransport() {
  const host = String(process.env.REMINDER_SMTP_HOST || "").trim();
  const port = Number(process.env.REMINDER_SMTP_PORT || 587);
  const user = String(process.env.REMINDER_SMTP_USER || "").trim();
  const pass = String(process.env.REMINDER_SMTP_PASS || "").trim();
  const secure = String(process.env.REMINDER_SMTP_SECURE || "").trim().toLowerCase() === "true";
  if (!host || !user || !pass) {
    throw new Error("Reminder SMTP is not configured.");
  }
  const cacheKey = [host, port, user, secure].join("|");
  if (cachedReminderTransport && cachedReminderTransportKey === cacheKey) {
    return cachedReminderTransport;
  }
  cachedReminderTransportKey = cacheKey;
  cachedReminderTransport = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user, pass },
  });
  return cachedReminderTransport;
}

function getReminderFromEmail() {
  const explicit = String(process.env.REMINDER_FROM_EMAIL || "").trim();
  if (explicit) return explicit;
  const email = String(process.env.MAIL_FROM_EMAIL || "").trim();
  const name = String(process.env.MAIL_FROM_NAME || "ACE IIIT Reminders").trim();
  if (email) {
    return `${name} <${email}>`;
  }
  throw new Error("Reminder sender email is not configured.");
}

async function sendReminderEmail(input) {
  const payload = buildEmailPayload(Object.assign({}, input || {}, { from: (input && input.from) || getReminderFromEmail() }));
  const transport = getReminderTransport();
  await transport.sendMail({
    from: payload.from,
    to: payload.to.join(", "),
    subject: payload.subject,
    html: payload.html,
  });
  return { provider: "reminder-smtp" };
}

async function sendCalendarInviteEmail(reminder, testLink, method = "REQUEST", status = "CONFIRMED") {
  try {
    const transport = getReminderTransport();
    const planDate = new Date(reminder.plannedAt || reminder.remindAt);
    const endDate = new Date(planDate.getTime() + 3 * 60 * 60 * 1000); // 3 hours duration
    const formatIcsDate = (d) => d.toISOString().replace(/[-:]|\.\d{3}/g, "");
    
    const subjectFocus = Array.isArray(reminder.subjectFocus) && reminder.subjectFocus.length
      ? reminder.subjectFocus.join(", ") : "";
    const title = String(reminder.title || "ACE IIIT Mock Plan");
    
    let description = `Subject Focus: ${subjectFocus}\n\nLink: ${testLink}`;
    if (reminder.notes) description += `\n\nNotes: ${reminder.notes}`;

    const sequence = Number(reminder.sequence) || 0;

    const icsContent = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//ACE IIIT//Mock Portal//EN",
      "CALSCALE:GREGORIAN",
      `METHOD:${method}`,
      "BEGIN:VEVENT",
      `UID:${reminder._id}@aceiiit.in`,
      `SEQUENCE:${sequence}`,
      `DTSTAMP:${formatIcsDate(new Date())}`,
      `DTSTART:${formatIcsDate(planDate)}`,
      `DTEND:${formatIcsDate(endDate)}`,
      `SUMMARY:${title}`,
      `DESCRIPTION:${description.replace(/\n/g, "\\n")}`,
      `URL:${testLink}`,
      "ORGANIZER;CN=ACE IIIT:mailto:" + (getReminderFromEmail().match(/<([^>]+)>/) ? getReminderFromEmail().match(/<([^>]+)>/)[1] : "no-reply@aceiiit.in"),
      `ATTENDEE;RSVP=TRUE:mailto:${reminder.email}`,
      `STATUS:${status}`,
      "END:VEVENT",
      "END:VCALENDAR"
    ].join("\r\n");

    let htmlContent = "";
    let emailSubject = "";
    if (method === "CANCEL") {
      emailSubject = `Cancelled: ${title}`;
      htmlContent = `
        <div style="font-family: Arial, sans-serif;">
          <h2>Mock Exam Schedule Cancelled</h2>
          <p>Your scheduled mock exam <strong>${title}</strong> has been cancelled.</p>
          <p>This email contains a calendar update to automatically remove it from your calendar.</p>
        </div>
      `;
    } else {
      emailSubject = `Mock Scheduled: ${title}`;
      htmlContent = `
        <div style="font-family: Arial, sans-serif;">
          <h2>Your Mock Exam is Scheduled</h2>
          <p>You have successfully scheduled <strong>${title}</strong> for ${planDate.toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}.</p>
          <p>This email contains a calendar invitation so it will automatically sync with your Google Calendar or email client!</p>
          <a href="${testLink}">View Mock on Portal</a>
        </div>
      `;
    }

    const payload = buildEmailPayload({
      from: getReminderFromEmail(),
      to: [reminder.email],
      subject: emailSubject,
      html: htmlContent
    });

    await transport.sendMail({
      from: payload.from,
      to: payload.to.join(", "),
      subject: payload.subject,
      html: payload.html,
      icalEvent: {
        filename: "invitation.ics",
        method: "request",
        content: icsContent
      }
    });
    return { provider: "reminder-smtp", success: true };
  } catch (err) {
    console.error("Failed to send calendar invite:", err.message || err);
    return { provider: "reminder-smtp", success: false, error: err.message };
  }
}


async function sendViaSender(payload) {
  const apiKey = process.env.SENDER_API_KEY || process.env.SENDER_TOKEN;
  if (!apiKey) {
    throw new Error("SENDER_API_KEY is not configured.");
  }

  const senderObj = parseFromAddress(payload.from);
  const response = await fetch("https://api.sender.net/v2/email/send", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Accept": "application/json",
      "Content-Type": "application/json",
    },
    signal: AbortSignal.timeout(5000),
    body: JSON.stringify({
      from: { email: senderObj.email, name: senderObj.name || "ACE IIIT" },
      to: payload.to.map((email) => ({ email })),
      subject: payload.subject,
      html: payload.html,
    }),
  });

  if (!response.ok) {
    const bodyText = await response.text();
    throw new Error(`Sender.net failed (${response.status}): ${bodyText || response.statusText}`);
  }

  return { provider: "sender" };
}

async function sendViaSendPulse(payload) {
  const apiKey = process.env.SENDPULSE_API_KEY || process.env.SENDPULSE_CLIENT_SECRET;
  if (!apiKey) {
    throw new Error("SENDPULSE_API_KEY is not configured.");
  }

  const senderObj = parseFromAddress(payload.from);
  const response = await fetch("https://api.sendpulse.com/smtp/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Accept": "application/json",
      "Content-Type": "application/json",
    },
    signal: AbortSignal.timeout(5000),
    body: JSON.stringify({
      email: {
        html: payload.html,
        subject: payload.subject,
        from: { name: senderObj.name || "ACE IIIT", email: senderObj.email },
        to: payload.to.map((email) => ({ email })),
      },
    }),
  });

  if (!response.ok) {
    const bodyText = await response.text();
    throw new Error(`SendPulse failed (${response.status}): ${bodyText || response.statusText}`);
  }

  return { provider: "sendpulse" };
}

async function sendEmailThroughProviders(input) {
  const payload = buildEmailPayload(input);
  const failures = [];

  // Try providers in priority order: Resend -> Sender -> SendPulse -> Brevo -> Reminder SMTP
  const providers = [
    { name: "Resend", fn: sendViaResend },
    { name: "Sender", fn: sendViaSender },
    { name: "SendPulse", fn: sendViaSendPulse },
    { name: "Brevo", fn: sendViaBrevo },
  ];

  for (const p of providers) {
    try {
      return await p.fn(payload);
    } catch (error) {
      failures.push(`${p.name.toLowerCase()}: ${error.message}`);
      // eslint-disable-next-line no-console
      console.warn(`OTP send via ${p.name} failed, trying next provider.`, error.message);
    }
  }

  // Fallback to reminder SMTP if available
  try {
    const smtpTransport = getReminderTransport();
    await smtpTransport.sendMail({
      from: payload.from,
      to: payload.to.join(", "),
      subject: payload.subject,
      html: payload.html,
    });
    return { provider: "smtp-fallback" };
  } catch (error) {
    failures.push(`smtp: ${error.message}`);
  }

  const error = new Error("Email delivery is temporarily unavailable. Please try again shortly.");
  error.status = 503;
  error.expose = true;
  error.details = failures;
  throw error;
}

function buildActivationEmailHtml(link) {
  return `
    <div style="font-family: Arial, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px; color: #14110f; background: #fff;">
      <h2 style="color: #14110f; border-bottom: 2px solid #c5a028; padding-bottom: 8px;">ACE IIIT Mock Portal</h2>
      <p style="font-size: 15px; line-height: 1.5;">Welcome to ACE IIIT! Please click the button below to activate your account and create your password:</p>
      <div style="margin: 28px 0; text-align: center;">
        <a href="${link}" style="background-color: #14110f; color: #fdfbf7; text-decoration: none; padding: 14px 28px; border-radius: 8px; font-weight: bold; display: inline-block;">Activate Account & Set Password</a>
      </div>
      <p style="font-size: 13px; color: #666;">Or copy and paste this link into your browser:</p>
      <p style="font-size: 12px; color: #888; word-break: break-all;"><a href="${link}">${link}</a></p>
      <p style="font-size: 12px; color: #999; margin-top: 24px;">This link will expire in 24 hours. If you did not request this, please ignore this email.</p>
    </div>
  `;
}

function buildPasswordResetEmailHtml(link) {
  return `
    <div style="font-family: Arial, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px; color: #14110f; background: #fff;">
      <h2 style="color: #14110f; border-bottom: 2px solid #c5a028; padding-bottom: 8px;">ACE IIIT Mock Portal</h2>
      <p style="font-size: 15px; line-height: 1.5;">We received a request to reset your ACE IIIT portal password. Click the button below to set a new password:</p>
      <div style="margin: 28px 0; text-align: center;">
        <a href="${link}" style="background-color: #8f2d1f; color: #fff; text-decoration: none; padding: 14px 28px; border-radius: 8px; font-weight: bold; display: inline-block;">Reset Password</a>
      </div>
      <p style="font-size: 13px; color: #666;">Or copy and paste this link into your browser:</p>
      <p style="font-size: 12px; color: #888; word-break: break-all;"><a href="${link}">${link}</a></p>
      <p style="font-size: 12px; color: #999; margin-top: 24px;">This link is valid for 1 hour. If you did not request a password reset, you can safely ignore this message.</p>
    </div>
  `;
}

async function sendActivationEmail(email, token, baseUrl) {
  const cleanBase = String(baseUrl || "").replace(/\/+$/, "");
  const link = `${cleanBase}/#activate?token=${encodeURIComponent(token)}`;
  const payload = {
    from: OTP_FROM,
    to: [String(email).trim().toLowerCase()],
    subject: "Activate your ACE IIIT Portal Account",
    html: buildActivationEmailHtml(link),
  };
  return sendEmailThroughProviders(payload);
}

async function sendPasswordResetEmail(email, token, baseUrl) {
  const cleanBase = String(baseUrl || "").replace(/\/+$/, "");
  const link = `${cleanBase}/#reset-password?token=${encodeURIComponent(token)}`;
  const payload = {
    from: OTP_FROM,
    to: [String(email).trim().toLowerCase()],
    subject: "Reset your ACE IIIT Portal Password",
    html: buildPasswordResetEmailHtml(link),
  };
  return sendEmailThroughProviders(payload);
}

function buildPaymentConfirmationEmailHtml(name) {
  return `
    <div style="font-family: Arial, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px; color: #14110f; background: #fff; border: 1px solid #e5dfd5; border-radius: 12px;">
      <h2 style="color: #14110f; border-bottom: 2px solid #157347; padding-bottom: 8px; margin-top: 0;">ACE IIIT Mock Portal</h2>
      <p style="font-size: 16px; line-height: 1.5; color: #14110f;">Dear ${String(name || "Student").replace(/</g, "&lt;")},</p>
      <div style="background: rgba(21, 115, 71, 0.08); border-left: 4px solid #157347; padding: 16px; border-radius: 6px; margin: 20px 0;">
        <strong style="color: #157347; font-size: 16px;">✓ Payment Verified & Paid Access Activated!</strong>
        <p style="margin: 8px 0 0 0; font-size: 14px; color: #2b2623;">Your payment has been successfully verified by our admissions team. Full access to all ACE IIIT UGEE 2026 Mock Test Series and detailed solution analytics is now active on your account.</p>
      </div>
      <p style="font-size: 14px; line-height: 1.6; color: #524c46;">You can log into your account to access all locked mock papers immediately:</p>
      <div style="margin: 24px 0; text-align: center;">
        <a href="https://mock.aceiiit.in" style="background-color: #157347; color: #ffffff; text-decoration: none; padding: 14px 28px; border-radius: 8px; font-weight: bold; display: inline-block;">Log In & Take Mock Test</a>
      </div>
      <p style="font-size: 12px; color: #888; margin-top: 24px; border-top: 1px solid #eee; padding-top: 12px;">ACE IIIT UGEE Prep Series • Official Portal</p>
    </div>
  `;
}

async function sendPaymentConfirmationEmail(email, name) {
  const payload = {
    from: OTP_FROM,
    to: [String(email).trim().toLowerCase()],
    subject: "Payment Verified — Paid Access Activated for ACE IIIT Mock Series",
    html: buildPaymentConfirmationEmailHtml(name),
  };
  return sendEmailThroughProviders(payload);
}

module.exports = {
  sendOtpEmail,
  buildOtpEmailHtml,
  sendEmailThroughProviders,
  sendReminderEmail,
  sendCalendarInviteEmail,
  sendViaSender,
  sendViaSendPulse,
  sendActivationEmail,
  sendPasswordResetEmail,
  sendPaymentConfirmationEmail,
};
