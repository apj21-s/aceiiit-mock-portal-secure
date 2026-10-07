const { verifyPassword } = require("../utils/password");
const { z } = require("zod");

const Attempt = require("../models/Attempt");
const Entitlement = require("../models/Entitlement");
const IntegrityEvent = require("../models/IntegrityEvent");
const PaymentRecord = require("../models/PaymentRecord");
const Reminder = require("../models/Reminder");
const User = require("../models/User");
const { logAuditEvent } = require("../services/auditLogService");
const { clearSessionCookie } = require("../services/sessionService");

// Self-service data rights: download your data, and delete your account.

async function exportMyData(req, res, next) {
  try {
    const userId = req.auth.userId;
    // passwordHash is select:false; it is read only to report "password sign-in: yes/no".
    const user = await User.findById(userId).select("+passwordHash").lean();
    if (!user) return res.status(404).json({ error: "User not found" });
    const email = String(user.normalizedEmail || user.email || "").toLowerCase();
    const [attempts, reminders, entitlements, payments, integrityEvents] = await Promise.all([
      Attempt.find({ userId })
        .select("testId attemptNumber score accuracy correctCount wrongCount skippedCount timeTakenSeconds submittedAt submittedReason isPractice integrity sectionWise topicWise")
        .sort({ submittedAt: -1 })
        .lean(),
      Reminder.find({ userId }).select("title testId plannedAt remindAt reminderMinutes subjectFocus notes deliveryState sentAt cancelledAt").lean(),
      Entitlement.find({ normalizedEmail: email }).select("seasonId tier status source grantedAt revokedAt expiresAt").lean(),
      PaymentRecord.find({ normalizedEmail: email }).select("seasonId status source verifiedAt revokedAt createdAt").lean(),
      IntegrityEvent.find({ userId }).select("sessionId testId type counted clientAt receivedAt durationMs").sort({ receivedAt: 1 }).limit(5000).lean(),
    ]);
    const exportDoc = {
      exportedAt: new Date().toISOString(),
      profile: {
        name: user.name,
        email: user.email,
        role: user.role,
        status: user.status,
        createdAt: user.createdAt,
        lastSeenAt: user.lastSeenAt,
        signInMethods: { password: Boolean(user.passwordHash), google: Boolean(user.googleSubject), apple: Boolean(user.appleSubject) },
      },
      attempts,
      reminders,
      entitlements,
      payments,
      examIntegrityEvents: integrityEvents,
    };
    res.set("Cache-Control", "no-store");
    res.set("Content-Disposition", `attachment; filename="aceiiit-my-data-${new Date().toISOString().slice(0, 10)}.json"`);
    return res.json(exportDoc);
  } catch (err) {
    return next(err);
  }
}

const deleteSchema = z.object({
  password: z.string().max(200).optional(),
  confirm: z.literal("DELETE MY ACCOUNT"),
});

/**
 * Deletes the account: signs out every session immediately and moves the account to trash.
 * An admin purge then anonymizes attempts and removes reminders/calendar data (see
 * purgeUserCascade). Password accounts must re-enter their password.
 */
async function deleteMyAccount(req, res, next) {
  try {
    const parsed = deleteSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'Type "DELETE MY ACCOUNT" to confirm.', code: "CONFIRMATION_REQUIRED" });
    }
    const user = await User.findById(req.auth.userId).select("+passwordHash");
    if (!user || user.deletedAt) return res.status(404).json({ error: "User not found" });
    if (user.role === "admin") {
      return res.status(400).json({ error: "Admin accounts can't be self-deleted. Ask another admin to remove the account." });
    }
    if (user.passwordHash) {
      const ok = parsed.data.password ? await verifyPassword(parsed.data.password, user.passwordHash) : false;
      if (!ok) return res.status(401).json({ error: "Incorrect password.", code: "REAUTH_FAILED" });
    }
    user.deletedAt = new Date();
    user.tokenVersion = Number(user.tokenVersion || 0) + 1;
    await user.save();
    await Reminder.updateMany({ userId: user._id, cancelledAt: null }, { $set: { cancelledAt: new Date(), deliveryState: "cancelled" } });
    await logAuditEvent({
      actorUserId: user._id,
      action: "ACCOUNT_DELETION_REQUESTED",
      entityType: "User",
      entityId: String(user._id),
      metadata: { selfService: true },
    });
    clearSessionCookie(res);
    return res.json({ ok: true, message: "Your account has been deleted and you have been signed out." });
  } catch (err) {
    return next(err);
  }
}

module.exports = { exportMyData, deleteMyAccount };
