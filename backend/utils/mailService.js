const { Resend } = require("resend");
const nodemailer = require("nodemailer");

const { escapeHtml, safeUrl, escapeIcsText, icsValue, foldIcsLine } = require("./escape");
const { logger, errorSummary } = require("./logger");

// Email delivery: Resend (primary) → Brevo (fallback) → SMTP (only if configured).
// Every dynamic value placed into HTML is escaped; ICS text follows RFC 5545.

function resolveFromEmail() {
  if (process.env.OTP_FROM_EMAIL) return process.env.OTP_FROM_EMAIL;
  if (process.env.RESEND_FROM) return process.env.RESEND_FROM;
  const fromEmail = String(process.env.MAIL_FROM_EMAIL || "").trim();
  const fromName = String(process.env.MAIL_FROM_NAME || "").trim();
  if (fromEmail) return fromName ? `${fromName} <${fromEmail}>` : fromEmail;
  return "ACE IIIT <otp@aceiiit.in>";
}

const DEFAULT_FROM = resolveFromEmail();
const PROVIDER_TIMEOUT_MS = 8000;

function portalBaseUrl() {
  return String(process.env.PORTAL_BASE_URL || "https://mock.aceiiit.in").replace(/\/+$/, "");
}

function reminderFromEmail() {
  const explicit = String(process.env.REMINDER_FROM_EMAIL || "").trim();
  return explicit || DEFAULT_FROM;
}

function buildEmailPayload(input) {
  const source = input || {};
  return {
    from: String(source.from || DEFAULT_FROM),
    to: (Array.isArray(source.to) ? source.to : [source.to])
      .map((item) => String(item || "").trim().toLowerCase())
      .filter(Boolean),
    subject: String(source.subject || "").replace(/[\r\n]+/g, " ").trim(),
    html: String(source.html || ""),
    // [{ filename, content (string), contentType }]
    attachments: Array.isArray(source.attachments) ? source.attachments : [],
  };
}

function parseFromAddress(from) {
  const raw = String(from || "").trim();
  const match = raw.match(/^([\s\S]*)<([^>]+)>$/);
  if (!match) return { email: raw };
  return { name: String(match[1] || "").replace(/"/g, "").trim(), email: String(match[2] || "").trim() };
}

let cachedResend = null;
let cachedResendKey = null;

function getResend() {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return null;
  if (!cachedResend || cachedResendKey !== apiKey) {
    cachedResendKey = apiKey;
    cachedResend = new Resend(apiKey);
  }
  return cachedResend;
}

async function sendViaResend(payload) {
  const resend = getResend();
  if (!resend) throw new Error("RESEND_API_KEY is not configured.");
  const { error } = await resend.emails.send({
    from: payload.from,
    to: payload.to,
    subject: payload.subject,
    html: payload.html,
    attachments: payload.attachments.length
      ? payload.attachments.map((a) => ({ filename: a.filename, content: Buffer.from(a.content).toString("base64"), contentType: a.contentType }))
      : undefined,
  });
  if (error) throw new Error(typeof error === "string" ? error : String(error.message || error.name || "Resend failed"));
  return { provider: "resend" };
}

async function sendViaBrevo(payload) {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) throw new Error("BREVO_API_KEY is not configured.");
  const response = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: { accept: "application/json", "api-key": apiKey, "content-type": "application/json" },
    signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    body: JSON.stringify({
      sender: parseFromAddress(payload.from),
      to: payload.to.map((email) => ({ email })),
      subject: payload.subject,
      htmlContent: payload.html,
      attachment: payload.attachments.length
        ? payload.attachments.map((a) => ({ name: a.filename, content: Buffer.from(a.content).toString("base64") }))
        : undefined,
    }),
  });
  if (!response.ok) {
    const bodyText = await response.text();
    throw new Error(`Brevo failed (${response.status}): ${bodyText || response.statusText}`);
  }
  return { provider: "brevo" };
}

let cachedSmtp = null;
let cachedSmtpKey = null;

function getSmtpTransport() {
  const host = String(process.env.REMINDER_SMTP_HOST || process.env.SMTP_HOST || "").trim();
  const port = Number(process.env.REMINDER_SMTP_PORT || process.env.SMTP_PORT || 587);
  const user = String(process.env.REMINDER_SMTP_USER || process.env.SMTP_USER || "").trim();
  const pass = String(process.env.REMINDER_SMTP_PASS || process.env.SMTP_PASS || "").trim();
  const secure = String(process.env.REMINDER_SMTP_SECURE || process.env.SMTP_SECURE || "").trim().toLowerCase() === "true";
  if (!host || !user || !pass) return null;
  const key = [host, port, user, secure].join("|");
  if (!cachedSmtp || cachedSmtpKey !== key) {
    cachedSmtpKey = key;
    cachedSmtp = nodemailer.createTransport({ host, port, secure, auth: { user, pass } });
  }
  return cachedSmtp;
}

async function sendViaSmtp(payload) {
  const transport = getSmtpTransport();
  if (!transport) throw new Error("SMTP is not configured.");
  await transport.sendMail({
    from: payload.from,
    to: payload.to.join(", "),
    subject: payload.subject,
    html: payload.html,
    attachments: payload.attachments.map((a) => ({ filename: a.filename, content: a.content, contentType: a.contentType })),
  });
  return { provider: "smtp" };
}

const PROVIDERS = [
  { name: "resend", fn: sendViaResend },
  { name: "brevo", fn: sendViaBrevo },
  { name: "smtp", fn: sendViaSmtp },
];

async function sendEmailThroughProviders(input) {
  const payload = buildEmailPayload(input);
  if (!payload.to.length) throw new Error("Email has no recipients.");
  const failures = [];
  for (const provider of PROVIDERS) {
    try {
      return await provider.fn(payload);
    } catch (error) {
      failures.push(`${provider.name}: ${error.message}`);
    }
  }
  logger.warn({ failures }, "email delivery failed on every provider");
  const error = new Error("Email delivery is temporarily unavailable. Please try again shortly.");
  error.status = 503;
  error.expose = true;
  error.details = failures;
  throw error;
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------
function layout(bodyHtml) {
  return `
    <div style="font-family: Arial, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px; color: #14110f; background: #fff;">
      <h2 style="color: #14110f; border-bottom: 2px solid #c5a028; padding-bottom: 8px;">ACE IIIT Mock Portal</h2>
      ${bodyHtml}
    </div>`;
}

function buttonHtml(href, label, color) {
  return `<div style="margin: 28px 0; text-align: center;"><a href="${safeUrl(href)}" style="background-color: ${color}; color: #fff; text-decoration: none; padding: 14px 28px; border-radius: 8px; font-weight: bold; display: inline-block;">${escapeHtml(label)}</a></div>`;
}

function linkFallbackHtml(href) {
  return `<p style="font-size: 13px; color: #666;">Or copy and paste this link into your browser:</p>
      <p style="font-size: 12px; color: #888; word-break: break-all;"><a href="${safeUrl(href)}">${escapeHtml(href)}</a></p>`;
}

async function sendActivationEmail(email, token, baseUrl) {
  const link = `${String(baseUrl || portalBaseUrl()).replace(/\/+$/, "")}/#activate?token=${encodeURIComponent(token)}`;
  return sendEmailThroughProviders({
    to: [email],
    subject: "Activate your ACE IIIT Portal Account",
    html: layout(`
      <p style="font-size: 15px; line-height: 1.5;">Welcome to ACE IIIT! Click the button below to activate your account and create your password:</p>
      ${buttonHtml(link, "Activate Account & Set Password", "#14110f")}
      ${linkFallbackHtml(link)}
      <p style="font-size: 12px; color: #999; margin-top: 24px;">This link expires in 24 hours. If you did not request this, you can ignore this email.</p>`),
  });
}

async function sendPasswordResetEmail(email, token, baseUrl) {
  const link = `${String(baseUrl || portalBaseUrl()).replace(/\/+$/, "")}/#reset-password?token=${encodeURIComponent(token)}`;
  return sendEmailThroughProviders({
    to: [email],
    subject: "Reset your ACE IIIT Portal Password",
    html: layout(`
      <p style="font-size: 15px; line-height: 1.5;">We received a request to reset your ACE IIIT portal password. Click the button below to set a new password:</p>
      ${buttonHtml(link, "Reset Password", "#8f2d1f")}
      ${linkFallbackHtml(link)}
      <p style="font-size: 12px; color: #999; margin-top: 24px;">This link is valid for 1 hour. If you did not request a password reset, you can safely ignore this message.</p>`),
  });
}

async function sendPaymentConfirmationEmail(email, name) {
  return sendEmailThroughProviders({
    to: [email],
    subject: "Payment Verified — Paid Access Activated for ACE IIIT Mock Series",
    html: layout(`
      <p style="font-size: 16px; line-height: 1.5;">Dear ${escapeHtml(name || "Student")},</p>
      <div style="background: rgba(21, 115, 71, 0.08); border-left: 4px solid #157347; padding: 16px; border-radius: 6px; margin: 20px 0;">
        <strong style="color: #157347; font-size: 16px;">✓ Payment verified, paid access activated</strong>
        <p style="margin: 8px 0 0 0; font-size: 14px;">Full access to the ACE IIIT mock test series and detailed solution analytics is now active on your account.</p>
      </div>
      ${buttonHtml(portalBaseUrl(), "Log In & Take Mock Test", "#157347")}`),
  });
}

/** Planned-mock reminder email. `details` are user-provided and are escaped here. */
async function sendReminderEmail({ to, title, leadText, whenText, subjectFocus, notes, testLink, gCalUrl }) {
  return sendEmailThroughProviders({
    from: reminderFromEmail(),
    to: [to],
    subject: `Reminder: ${title} is in ${leadText}`,
    html: layout(`
      <p style="font-size: 16px; margin-top: 0;">Your planned mock attempt starts in <strong>${escapeHtml(leadText)}</strong>.</p>
      <div style="background-color: #f9f9f9; border-left: 4px solid #d7b34a; padding: 16px; margin: 24px 0;">
        <h3 style="margin: 0 0 8px 0; font-size: 18px;">${escapeHtml(title)}</h3>
        <p style="margin: 0 0 4px 0; font-size: 14px; color: #555;"><strong>Time:</strong> ${escapeHtml(whenText)}</p>
        ${subjectFocus ? `<p style="margin: 0 0 4px 0; font-size: 14px; color: #555;"><strong>Focus:</strong> ${escapeHtml(subjectFocus)}</p>` : ""}
        ${notes ? `<p style="margin: 0; font-size: 14px; color: #555;"><strong>Notes:</strong> ${escapeHtml(notes)}</p>` : ""}
      </div>
      ${buttonHtml(testLink, "Start Mock Exam Now", "#d7b34a")}
      ${gCalUrl ? `<p style="text-align: center;"><a href="${safeUrl(gCalUrl)}" style="font-size: 14px; color: #b08d2b; font-weight: bold;">📅 Add to Google Calendar</a></p>` : ""}
      <p style="font-size: 12px; color: #888;">You are receiving this because you scheduled a plan on ACE IIIT Mock Portal.</p>`),
  });
}

function formatIcsDate(date) {
  return new Date(date).toISOString().replace(/[-:]|\.\d{3}/g, "");
}

/**
 * Builds an RFC 5545 invite. UID is stable per reminder (`<reminderId>@aceiiit.in`), times
 * are UTC, and SEQUENCE must increase on every update/cancel so clients replace the event.
 */
function buildReminderIcs(reminder, testLink, method = "REQUEST", status = "CONFIRMED") {
  const planDate = new Date(reminder.plannedAt || reminder.remindAt);
  const endDate = new Date(planDate.getTime() + 3 * 60 * 60 * 1000);
  const subjectFocus = Array.isArray(reminder.subjectFocus) && reminder.subjectFocus.length ? reminder.subjectFocus.join(", ") : "";
  let description = `Subject Focus: ${subjectFocus}\n\nLink: ${testLink}`;
  if (reminder.notes) description += `\n\nNotes: ${reminder.notes}`;
  const sender = parseFromAddress(reminderFromEmail());
  const organizer = sender.email || "no-reply@aceiiit.in";
  // RFC 5545 parameter value: quoted, so drop double quotes and control characters
  // (code points below 0x20, which include CR/LF, plus DEL).
  const organizerName =
    Array.from(String(sender.name || ""))
      .filter((ch) => ch !== '"' && ch.charCodeAt(0) >= 0x20 && ch.charCodeAt(0) !== 0x7f)
      .join("")
      .trim() || "ACEIIIT Mock Portal";
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//ACE IIIT//Mock Portal//EN",
    "CALSCALE:GREGORIAN",
    `METHOD:${method === "CANCEL" ? "CANCEL" : "REQUEST"}`,
    "BEGIN:VEVENT",
    `UID:${icsValue(reminder._id)}@aceiiit.in`,
    `SEQUENCE:${Number(reminder.sequence) || 0}`,
    `DTSTAMP:${formatIcsDate(new Date())}`,
    `DTSTART:${formatIcsDate(planDate)}`,
    `DTEND:${formatIcsDate(endDate)}`,
    `SUMMARY:${escapeIcsText(reminder.title || "ACE IIIT Mock Plan")}`,
    `DESCRIPTION:${escapeIcsText(description)}`,
    `URL:${icsValue(testLink)}`,
    `ORGANIZER;CN="${organizerName}":mailto:${icsValue(organizer)}`,
    `ATTENDEE;RSVP=TRUE:mailto:${icsValue(reminder.email)}`,
    `STATUS:${status === "CANCELLED" ? "CANCELLED" : "CONFIRMED"}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return lines.map(foldIcsLine).join("\r\n");
}

async function sendCalendarInviteEmail(reminder, testLink, method = "REQUEST", status = "CONFIRMED") {
  try {
    const title = String(reminder.title || "ACE IIIT Mock Plan");
    const planDate = new Date(reminder.plannedAt || reminder.remindAt);
    const ics = buildReminderIcs(reminder, testLink, method, status);
    const cancelled = method === "CANCEL";
    const result = await sendEmailThroughProviders({
      from: reminderFromEmail(),
      to: [reminder.email],
      subject: cancelled ? `Cancelled: ${title}` : `Mock Scheduled: ${title}`,
      html: layout(
        cancelled
          ? `<h3>Mock exam schedule cancelled</h3><p>Your scheduled mock exam <strong>${escapeHtml(title)}</strong> has been cancelled. The attached calendar update removes it from your calendar.</p>`
          : `<h3>Your mock exam is scheduled</h3><p>You scheduled <strong>${escapeHtml(title)}</strong> for ${escapeHtml(planDate.toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }))}.</p><p>The attached calendar invitation adds it to Google Calendar or your email client.</p>${buttonHtml(testLink, "View Mock on Portal", "#14110f")}`
      ),
      attachments: [{ filename: "invite.ics", content: ics, contentType: `text/calendar; charset=utf-8; method=${cancelled ? "CANCEL" : "REQUEST"}` }],
    });
    return { provider: result.provider, success: true };
  } catch (err) {
    logger.error({ err: errorSummary(err) }, "failed to send calendar invite");
    return { provider: null, success: false, error: err.message };
  }
}

module.exports = {
  sendEmailThroughProviders,
  sendReminderEmail,
  sendCalendarInviteEmail,
  buildReminderIcs,
  sendActivationEmail,
  sendPasswordResetEmail,
  sendPaymentConfirmationEmail,
};
