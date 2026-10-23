const Attempt = require("../models/Attempt");
const AttemptSession = require("../models/AttemptSession");
const Entitlement = require("../models/Entitlement");
const GoogleCalendarConnection = require("../models/GoogleCalendarConnection");
const GoogleCalendarEvent = require("../models/GoogleCalendarEvent");
const MentorConversation = require("../models/MentorConversation");
const MentorMessage = require("../models/MentorMessage");
const MentorUsage = require("../models/MentorUsage");
const QuestionReport = require("../models/QuestionReport");
const Reminder = require("../models/Reminder");
const User = require("../models/User");
const { logAuditEvent } = require("./auditLogService");
const { revokeRefreshToken } = require("./googleCalendarService");
const { logger, errorSummary } = require("../utils/logger");

// Deleted accounts are kept for a 30-day grace period (the privacy policy states this), then
// purged permanently: personal data is removed, exam history is anonymized, and Google
// Calendar access is revoked. Admins can still purge a trashed account early.

const RETENTION_DAYS = 30;
const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;
const BATCH_SIZE = 50;

/** Revoke the user's Google Calendar access at Google (best effort) and drop the stored data. */
async function removeGoogleCalendarData(userId) {
  const connections = await GoogleCalendarConnection.find({ userId });
  for (const connection of connections) {
    await revokeRefreshToken(connection);
  }
  await Promise.all([
    GoogleCalendarConnection.deleteMany({ userId }),
    GoogleCalendarEvent.deleteMany({ userId }),
  ]);
}

/**
 * Explicit, audited user purge. Instead of a silent TTL delete, personal data is removed or
 * anonymized and dependent records are cleaned up so nothing is left orphaned.
 */
async function purgeUserCascade(user, actorUserId, { automatic = false } = {}) {
  const userId = user._id;
  await removeGoogleCalendarData(userId);
  await Promise.all([
    Attempt.updateMany({ userId }, { $set: { userEmail: "" } }),
    Entitlement.updateMany({ userId }, { $set: { userId: null } }),
    AttemptSession.deleteMany({ userId }),
    Reminder.deleteMany({ userId }),
    MentorMessage.deleteMany({ userId }),
    MentorConversation.deleteMany({ userId }),
    MentorUsage.deleteMany({ userId }),
    QuestionReport.deleteMany({ userId }),
  ]);
  await User.deleteOne({ _id: userId });
  await logAuditEvent({
    actorUserId,
    action: "USER_PURGED",
    entityType: "User",
    entityId: String(userId),
    metadata: automatic ? { anonymizedAttempts: true, automatic: true, retentionDays: RETENTION_DAYS } : { anonymizedAttempts: true },
  });
}

/** Purge every account deleted more than RETENTION_DAYS ago. Returns the purged user ids. */
async function purgeExpiredAccounts({ now = new Date(), retentionDays = RETENTION_DAYS } = {}) {
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
  const due = await User.find({ deletedAt: { $ne: null, $lte: cutoff } })
    .sort({ deletedAt: 1 })
    .limit(BATCH_SIZE);
  const purged = [];
  for (const user of due) {
    try {
      await purgeUserCascade(user, null, { automatic: true });
      purged.push(String(user._id));
    } catch (err) {
      logger.error({ err: errorSummary(err), userId: String(user._id) }, "account purge failed");
    }
  }
  return purged;
}

class AccountPurger {
  constructor() {
    this._timer = null;
    this._running = false;
    this.lastRunAt = null;
  }

  start(intervalMs = Number(process.env.ACCOUNT_PURGE_INTERVAL_MS || DEFAULT_INTERVAL_MS)) {
    this.stop();
    this._timer = setInterval(() => this.tick(), Math.max(60 * 1000, intervalMs));
    this.tick();
  }

  async tick() {
    if (this._running) return;
    this._running = true;
    try {
      const purged = await purgeExpiredAccounts();
      if (purged.length) logger.info({ count: purged.length }, "purged accounts past the deletion grace period");
      this.lastRunAt = new Date();
    } catch (err) {
      logger.error({ err: errorSummary(err) }, "account purger failed");
    } finally {
      this._running = false;
    }
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }
}

const accountPurger = new AccountPurger();

module.exports = { accountPurger, purgeExpiredAccounts, purgeUserCascade, removeGoogleCalendarData, RETENTION_DAYS };
