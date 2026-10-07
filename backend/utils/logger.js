const pino = require("pino");

// Structured JSON logging. Secrets in headers/bodies are redacted before they are written.
const REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  'req.headers["x-internal-api-secret"]',
  'req.headers["x-exam-token"]',
  'req.headers["x-csrf-token"]',
  'res.headers["set-cookie"]',
  "*.password",
  "*.passwordHash",
  "*.token",
  "*.refreshToken",
  "*.apiKey",
  "*.secret",
];

const logger = pino({
  level: process.env.LOG_LEVEL || (process.env.NODE_ENV === "test" ? "silent" : "info"),
  redact: { paths: REDACT_PATHS, censor: "[REDACTED]" },
  base: { service: "aceiiit-portal" },
  timestamp: pino.stdTimeFunctions.isoTime,
});

/**
 * A safe summary of a (often third-party) error for logs. Google API errors carry the
 * request config, including the Authorization header, so never log the raw object.
 */
function errorSummary(err) {
  if (!err) return undefined;
  return {
    message: String(err.message || err),
    code: err.code,
    status: err.status || (err.response && err.response.status),
  };
}

module.exports = { logger, REDACT_PATHS, errorSummary };
