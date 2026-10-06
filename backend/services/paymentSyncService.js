const PaymentRecord = require("../models/PaymentRecord");
const User = require("../models/User");
const { getActiveSeason } = require("./seasonService");
const { grantEntitlement, revokeEntitlement } = require("./entitlementService");
const { logAuditEvent } = require("./auditLogService");
const { paidSheetService } = require("./paidSheetService");
const { sendPaymentConfirmationEmail } = require("../utils/mailService");
const { normalizeEmail } = require("../utils/normalize");

async function syncGoogleSheetPayments(options = {}) {
  // Execute Google Sheet sync to memory cache only
  await paidSheetService.syncOnce({ throwOnError: true });
  const entries = paidSheetService.entries || [];

  return {
    newRecords: 0,
    linkedUsers: 0,
    emailsSent: 0,
    errors: 0,
    newlyVerifiedCount: entries.length,
  };
}

async function verifyPaymentManually(options = {}) {
  const { paymentId, actorUserId = null, sendEmail = true } = options;
  const payment = await PaymentRecord.findById(paymentId);
  if (!payment) {
    throw new Error("Payment record not found");
  }

  const beforeState = payment.toJSON();
  payment.status = "verified";
  payment.verifiedAt = new Date();
  payment.verifiedByUserId = actorUserId;
  await payment.save();

  const user = await User.findOne({ normalizedEmail: payment.normalizedEmail });

  await grantEntitlement({
    email: payment.normalizedEmail,
    userId: user ? user._id : null,
    seasonId: payment.seasonId,
    tier: "paid",
    source: "admin",
    paymentId: payment._id,
  });

  let mailDispatched = false;
  if (sendEmail && !payment.confirmationEmailSentAt) {
    try {
      await sendPaymentConfirmationEmail(payment.email, (user && user.name) || payment.name || "Student");
      payment.confirmationEmailSentAt = new Date();
      await payment.save();
      mailDispatched = true;
    } catch (mailErr) {
      console.warn("[PaymentSyncService] Manual verification email failed:", mailErr.message);
    }
  }

  await logAuditEvent({
    actorUserId,
    action: "PAYMENT_VERIFIED",
    entityType: "PaymentRecord",
    entityId: payment.id,
    seasonId: payment.seasonId,
    before: beforeState,
    after: payment.toJSON(),
    metadata: { mailDispatched },
  });

  return payment;
}

async function revokePaymentManually(options = {}) {
  const { paymentId, actorUserId = null } = options;
  const payment = await PaymentRecord.findById(paymentId);
  if (!payment) {
    throw new Error("Payment record not found");
  }

  const beforeState = payment.toJSON();
  payment.status = "revoked";
  payment.revokedAt = new Date();
  await payment.save();

  await revokeEntitlement({
    email: payment.normalizedEmail,
    seasonId: payment.seasonId,
  });

  await logAuditEvent({
    actorUserId,
    action: "PAYMENT_REVOKED",
    entityType: "PaymentRecord",
    entityId: payment.id,
    seasonId: payment.seasonId,
    before: beforeState,
    after: payment.toJSON(),
  });

  return payment;
}

async function resendConfirmationEmail(options = {}) {
  const { paymentId, actorUserId = null } = options;
  const payment = await PaymentRecord.findById(paymentId);
  if (!payment) {
    throw new Error("Payment record not found");
  }
  if (payment.status !== "verified") {
    throw new Error("Cannot resend email for unverified payment");
  }

  const user = await User.findOne({ normalizedEmail: payment.normalizedEmail });
  await sendPaymentConfirmationEmail(payment.email, (user && user.name) || payment.name || "Student");

  payment.confirmationEmailSentAt = new Date();
  await payment.save();

  await logAuditEvent({
    actorUserId,
    action: "EMAIL_RESENT",
    entityType: "PaymentRecord",
    entityId: payment.id,
    seasonId: payment.seasonId,
    metadata: { recipientEmail: payment.email },
  });

  return payment;
}

module.exports = {
  syncGoogleSheetPayments,
  verifyPaymentManually,
  revokePaymentManually,
  resendConfirmationEmail,
};
