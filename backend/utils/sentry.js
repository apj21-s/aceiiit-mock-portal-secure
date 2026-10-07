// Optional error monitoring: enabled only when SENTRY_DSN is set. Never sends request
// bodies, cookies or auth headers.
let Sentry = null;

function initSentry() {
  const dsn = String(process.env.SENTRY_DSN || "").trim();
  if (!dsn || Sentry) return Boolean(Sentry);
  Sentry = require("@sentry/node");
  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV || "development",
    tracesSampleRate: 0,
    sendDefaultPii: false,
    beforeSend(event) {
      if (event.request) {
        delete event.request.cookies;
        delete event.request.data;
        if (event.request.headers) {
          ["authorization", "cookie", "x-internal-api-secret", "x-exam-token", "x-csrf-token"].forEach((h) => delete event.request.headers[h]);
        }
      }
      return event;
    },
  });
  return true;
}

function captureException(error, context) {
  if (!Sentry) return;
  Sentry.captureException(error, context ? { extra: context } : undefined);
}

async function flushSentry(timeoutMs = 2000) {
  if (!Sentry) return;
  try {
    await Sentry.flush(timeoutMs);
  } catch (_err) {
    // ignore
  }
}

module.exports = { initSentry, captureException, flushSentry };
