const Entitlement = require("../models/Entitlement");
const PaymentRecord = require("../models/PaymentRecord");
const User = require("../models/User");
const { getActiveSeason } = require("./seasonService");
const { normalizeEmail } = require("../utils/normalize");
const { paidSheetService } = require("./paidSheetService");

async function canAccessTest(reqUser, test) {
  if (!test) {
    if (!reqUser) return false;
    if (reqUser.role === "admin") return true;
    if (reqUser.isPaid) return true;
    const normEmail = normalizeEmail(reqUser.email);
    if (!normEmail) return false;
    const activeEntitlement = await Entitlement.findOne({
      normalizedEmail: normEmail,
      status: "active",
    }).lean();
    return Boolean(activeEntitlement);
  }

  if (test.isFree) return true;
  if (!reqUser) return false;
  if (reqUser.role === "admin") return true;

  const userEmail = normalizeEmail(reqUser.email);
  if (!userEmail) return false;

  // Determine seasonId for the test
  let targetSeasonId = test.seasonId;
  if (!targetSeasonId) {
    const activeSeason = await getActiveSeason();
    targetSeasonId = activeSeason ? activeSeason._id : null;
  }

  if (targetSeasonId) {
    const entitlementDoc = await Entitlement.findOne({
      seasonId: targetSeasonId,
      normalizedEmail: userEmail,
    }).lean();

    if (entitlementDoc) {
      return entitlementDoc.status === "active";
    }

    // Check if a verified payment record exists for this season
    const verifiedPayment = await PaymentRecord.findOne({
      seasonId: targetSeasonId,
      normalizedEmail: userEmail,
      status: "verified",
    }).lean();

    if (verifiedPayment) {
      await grantEntitlement({
        email: userEmail,
        userId: reqUser._id || reqUser.id,
        seasonId: targetSeasonId,
        tier: "paid",
        source: "payment",
        paymentId: verifiedPayment._id,
      });
      return true;
    }
  }

  return false;
}

async function grantEntitlement({ email, userId = null, seasonId, tier = "paid", source = "payment", paymentId = null }) {
  const normEmail = normalizeEmail(email);
  if (!normEmail || !seasonId) return null;

  let userObj = null;
  if (userId) {
    userObj = await User.findById(userId);
  }
  if (!userObj) {
    userObj = await User.findOne({ normalizedEmail: normEmail });
  }

  const resolvedUserId = userObj ? userObj._id : null;

  const entitlement = await Entitlement.findOneAndUpdate(
    { seasonId, normalizedEmail: normEmail },
    {
      $set: {
        userId: resolvedUserId,
        email: normEmail,
        normalizedEmail: normEmail,
        seasonId,
        tier,
        status: "active",
        source,
        paymentId: paymentId || null,
        grantedAt: new Date(),
        revokedAt: null,
      },
    },
    { upsert: true, new: true }
  );

  // Update user.isPaid flag to true
  await User.findOneAndUpdate(
    { normalizedEmail: normEmail },
    { isPaid: true }
  );

  return entitlement;
}

async function revokeEntitlement({ email, seasonId }) {
  const normEmail = normalizeEmail(email);
  if (!normEmail || !seasonId) return null;

  const entitlement = await Entitlement.findOneAndUpdate(
    { seasonId, normalizedEmail: normEmail },
    {
      $set: {
        status: "revoked",
        revokedAt: new Date(),
      },
    },
    { new: true }
  );

  // Check if any other active entitlements remain for this email across seasons
  const activeRemaining = await Entitlement.findOne({
    normalizedEmail: normEmail,
    status: "active",
  }).lean();

  if (!activeRemaining) {
    await User.findOneAndUpdate(
      { normalizedEmail: normEmail },
      { isPaid: false }
    );
  }

  return entitlement;
}

async function linkPendingPaymentToUser(user) {
  if (!user || !user.email) return;
  const normEmail = normalizeEmail(user.email);
  if (!normEmail) return;

  const verifiedPayments = await PaymentRecord.find({
    normalizedEmail: normEmail,
    status: "verified",
  }).lean();

  for (const payment of verifiedPayments) {
    await grantEntitlement({
      email: normEmail,
      userId: user._id || user.id,
      seasonId: payment.seasonId,
      tier: "paid",
      source: payment.source || "payment",
      paymentId: payment._id,
    });
  }
}

module.exports = {
  canAccessTest,
  grantEntitlement,
  revokeEntitlement,
  linkPendingPaymentToUser,
};
