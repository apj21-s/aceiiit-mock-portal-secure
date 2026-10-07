const PaymentRecord = require("../models/PaymentRecord");
const User = require("../models/User");
const { getActiveSeason } = require("./seasonService");
const { grantEntitlement, revokeEntitlement } = require("./entitlementService");
const { logAuditEvent } = require("./auditLogService");
const Entitlement = require("../models/Entitlement");
const Season = require("../models/Season");
const { sendPaymentConfirmationEmail } = require("../utils/mailService");
const { normalizeEmail } = require("../utils/normalize");
const { logger, errorSummary } = require("../utils/logger");

function httpError(status, message, code) {
  const err = new Error(message);
  err.status = status;
  err.expose = true;
  if (code) err.code = code;
  return err;
}

async function verifyPaymentManually(options = {}) {
  const { paymentId, actorUserId = null, sendEmail = true } = options;
  const payment = await PaymentRecord.findById(paymentId);
  if (!payment) {
    throw httpError(404, "Payment record not found", "PAYMENT_NOT_FOUND");
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
      logger.warn({ err: errorSummary(mailErr) }, "manual verification email failed");
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
    throw httpError(404, "Payment record not found", "PAYMENT_NOT_FOUND");
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
    throw httpError(404, "Payment record not found", "PAYMENT_NOT_FOUND");
  }
  if (payment.status !== "verified") {
    throw httpError(409, "Cannot resend email for unverified payment", "PAYMENT_NOT_VERIFIED");
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

/**
 * Admin "Add payment": records a pending payment for an email + season. Access is granted
 * only when an admin verifies it (verifyPaymentManually).
 */
async function createManualPayment({ email, name = "", seasonId = null, note = "", actorUserId = null }) {
  const normalizedEmail = normalizeEmail(email);
  let season = seasonId ? await Season.findById(seasonId) : await getActiveSeason();
  if (!season) throw httpError(404, "Season not found", "SEASON_NOT_FOUND");
  const existing = await PaymentRecord.findOne({ seasonId: season._id, normalizedEmail });
  if (existing) {
    throw httpError(409, "A payment record already exists for this email in this season.", "PAYMENT_EXISTS");
  }
  const payment = await PaymentRecord.create({
    seasonId: season._id,
    email: normalizedEmail,
    normalizedEmail,
    name,
    status: "pending",
    source: "admin",
    rawPayload: note ? { note } : null,
  });
  await logAuditEvent({
    actorUserId,
    action: "PAYMENT_CREATED",
    entityType: "PaymentRecord",
    entityId: payment.id,
    seasonId: season._id,
    after: payment.toJSON(),
  });
  return payment;
}

// ---------------------------------------------------------------------------
// Commerce provisioning (server-to-server from the AceIIIT commerce backend)
// ---------------------------------------------------------------------------
const DEFAULT_ACTIVE_SEASON_RESOURCE_CODES = ["PAID_MOCK_SERIES"];

/**
 * Maps a commerce resource code to a season: a season explicitly tagged with that
 * `resourceCode` wins; otherwise the generic paid-series codes map to the current active
 * season. Never creates a season.
 */
async function resolveSeasonForResource(resourceCode) {
  const tagged = await Season.findOne({ resourceCode, status: { $ne: "archived" } }).sort({ createdAt: -1 });
  if (tagged) return tagged;
  const generic = String(process.env.COMMERCE_ACTIVE_SEASON_RESOURCE_CODES || DEFAULT_ACTIVE_SEASON_RESOURCE_CODES.join(","))
    .split(",")
    .map((code) => code.trim())
    .filter(Boolean);
  if (generic.includes(resourceCode)) {
    return Season.findOne({ status: "active" }).sort({ isDefaultActive: -1, createdAt: -1 });
  }
  return null;
}

/**
 * Idempotent provisioning: PaymentRecord (verified, source "commerce") → Entitlement → AuditLog.
 * The commerce entitlement id is stored as `sourceRecordId`; replays return the same records.
 */
async function provisionFromCommerce({ commerceUserId, email, resourceCode, entitlementId, idempotencyKey }) {
  const normalizedEmail = normalizeEmail(email);
  const season = await resolveSeasonForResource(resourceCode);
  if (!season) {
    throw httpError(422, `No season is mapped to resource code "${resourceCode}".`, "RESOURCE_NOT_MAPPED");
  }

  const now = new Date();
  const payment = await PaymentRecord.findOneAndUpdate(
    { seasonId: season._id, normalizedEmail },
    {
      $set: {
        email: normalizedEmail,
        normalizedEmail,
        status: "verified",
        source: "commerce",
        sourceRecordId: String(entitlementId),
        verifiedAt: now,
        revokedAt: null,
        rawPayload: { commerceUserId: String(commerceUserId), resourceCode, entitlementId: String(entitlementId), idempotencyKey: String(idempotencyKey) },
      },
      $setOnInsert: { seasonId: season._id, name: "" },
    },
    { upsert: true, new: true }
  );

  let user = await User.findOne({ normalizedEmail });
  if (!user) {
    // A buyer who hasn't signed up yet gets a pending account; they activate normally.
    user = await User.create({
      name: normalizedEmail.split("@")[0] || "Student",
      email: normalizedEmail,
      status: "pending",
      isActivated: false,
      emailVerified: false,
    });
  }

  const before = await Entitlement.findOne({ seasonId: season._id, normalizedEmail }).lean();
  const entitlement = await grantEntitlement({
    email: normalizedEmail,
    userId: user._id,
    seasonId: season._id,
    tier: "paid",
    source: "payment",
    paymentId: payment._id,
  });

  const replay = Boolean(before && before.status === "active" && String(before.paymentId) === String(payment._id));
  if (!replay) {
    await logAuditEvent({
      actorUserId: null,
      action: "INTERNAL_PROVISION",
      entityType: "Entitlement",
      entityId: String(entitlement._id),
      seasonId: season._id,
      before: before || null,
      after: entitlement.toJSON(),
      metadata: { source: "commerce", commerceUserId: String(commerceUserId), resourceCode, entitlementId: String(entitlementId), idempotencyKey: String(idempotencyKey) },
    });
  }
  return { entitlement, payment, season, replay };
}

async function revokeFromCommerce({ commerceUserId, email, resourceCode, entitlementId, idempotencyKey }) {
  const normalizedEmail = normalizeEmail(email);
  const season = await resolveSeasonForResource(resourceCode);
  if (!season) {
    throw httpError(422, `No season is mapped to resource code "${resourceCode}".`, "RESOURCE_NOT_MAPPED");
  }
  const before = await Entitlement.findOne({ seasonId: season._id, normalizedEmail }).lean();
  await PaymentRecord.updateOne(
    { seasonId: season._id, normalizedEmail },
    { $set: { status: "revoked", revokedAt: new Date() } }
  );
  const entitlement = await revokeEntitlement({ email: normalizedEmail, seasonId: season._id });
  if (before && before.status !== "revoked") {
    await logAuditEvent({
      actorUserId: null,
      action: "INTERNAL_REVOKE",
      entityType: "Entitlement",
      entityId: String(before._id),
      seasonId: season._id,
      before,
      after: entitlement ? entitlement.toJSON() : null,
      metadata: { source: "commerce", commerceUserId: String(commerceUserId), resourceCode, entitlementId: String(entitlementId), idempotencyKey: String(idempotencyKey) },
    });
  }
  return { entitlement, season };
}

module.exports = {
  createManualPayment,
  provisionFromCommerce,
  revokeFromCommerce,
  resolveSeasonForResource,
  verifyPaymentManually,
  revokePaymentManually,
  resendConfirmationEmail,
};
