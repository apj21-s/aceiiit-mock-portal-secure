const AuditLog = require("../models/AuditLog");
const { logger, errorSummary } = require("../utils/logger");

// Keys that must never be written to the audit log, at any depth.
const SECRET_KEY_PATTERN = /pass(word)?|secret|token|hash|apikey|api_key|authorization|cookie|refresh/i;
const MAX_DEPTH = 6;

/** Deep-copies a value, replacing secret-looking fields with "[REDACTED]". */
function redact(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (depth > MAX_DEPTH) return "[TRUNCATED]";
  if (value instanceof Date) return value;
  if (Array.isArray(value)) return value.slice(0, 200).map((item) => redact(item, depth + 1));
  if (typeof value === "object") {
    if (typeof value.toHexString === "function") return String(value);
    const plain = typeof value.toObject === "function" ? value.toObject() : value;
    const out = {};
    Object.keys(plain).forEach((key) => {
      out[key] = SECRET_KEY_PATTERN.test(key) ? "[REDACTED]" : redact(plain[key], depth + 1);
    });
    return out;
  }
  return value;
}

async function logAuditEvent(params) {
  try {
    const {
      actorUserId = null,
      action,
      entityType,
      entityId = "",
      seasonId = null,
      before = null,
      after = null,
      metadata = null,
    } = params || {};

    if (!action || !entityType) {
      return null;
    }

    const log = await AuditLog.create({
      actorUserId: actorUserId || null,
      action,
      entityType,
      entityId: String(entityId || ""),
      seasonId: seasonId || null,
      before: before ? redact(before) : null,
      after: after ? redact(after) : null,
      metadata: metadata ? redact(metadata) : null,
    });

    return log;
  } catch (err) {
    logger.error({ err: errorSummary(err) }, "failed to record audit log");
    return null;
  }
}

module.exports = { logAuditEvent, redact };
