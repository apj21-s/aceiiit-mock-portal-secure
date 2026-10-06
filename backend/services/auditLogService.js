const AuditLog = require("../models/AuditLog");

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
      before: before || null,
      after: after || null,
      metadata: metadata || null,
    });

    return log;
  } catch (err) {
    console.error("[AuditLogService] Failed to record audit log:", err.message);
    return null;
  }
}

module.exports = { logAuditEvent };
