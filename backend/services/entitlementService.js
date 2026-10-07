const Entitlement = require("../models/Entitlement");
const PaymentRecord = require("../models/PaymentRecord");
const User = require("../models/User");
const { getActiveSeason } = require("./seasonService");
const { normalizeEmail } = require("../utils/normalize");

/**
 * The single access rule for paid content:
 *   free test  OR  admin  OR  an active, unexpired Entitlement for the test's season
 *   (tests without a season belong to the active season).
 * Read-only: no grants happen here. `User.isPaid` is a display cache and never decides access.
 */
async function canAccessTest(reqUser, test) {
  if (!test || !reqUser) return false;
  if (test.isFree) return true;
  if (reqUser.role === "admin") return true;

  const userEmail = normalizeEmail(reqUser.email);
  if (!userEmail) return false;

  let targetSeasonId = test.seasonId;
  if (!targetSeasonId) {
    const activeSeason = await getActiveSeason();
    targetSeasonId = activeSeason ? activeSeason._id : null;
  }
  if (!targetSeasonId) return false;

  const now = new Date();
  const entitlement = await Entitlement.findOne({
    seasonId: targetSeasonId,
    normalizedEmail: userEmail,
    status: "active",
    $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }],
  })
    .select("_id")
    .lean();
  return Boolean(entitlement);
}

/**
 * Season ids the user holds an active, unexpired entitlement for. Used to evaluate many
 * tests at once (catalog, practice pools) with the same rule as canAccessTest.
 */
async function getEntitledSeasonIds(reqUser) {
  const email = normalizeEmail(reqUser && reqUser.email);
  if (!email) return new Set();
  const now = new Date();
  const rows = await Entitlement.find({
    normalizedEmail: email,
    status: "active",
    $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }],
  })
    .select("seasonId")
    .lean();
  return new Set(rows.map((row) => String(row.seasonId)));
}

function isTestAccessible(test, { isAdmin, entitledSeasonIds, activeSeasonId }) {
  if (!test) return false;
  if (test.isFree) return true;
  if (isAdmin) return true;
  const seasonId = test.seasonId ? String(test.seasonId) : activeSeasonId ? String(activeSeasonId) : null;
  return Boolean(seasonId && entitledSeasonIds.has(seasonId));
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

/**
 * On login: attach the user to entitlements already granted for their email (e.g. paid
 * before the account existed) and create entitlements for verified payments that don't
 * have one yet. Never reactivates an entitlement an admin or the commerce system revoked.
 */
async function linkPendingPaymentToUser(user) {
  if (!user || !user.email) return;
  const normEmail = normalizeEmail(user.email);
  if (!normEmail) return;
  const userId = user._id || user.id;

  await Entitlement.updateMany({ normalizedEmail: normEmail, userId: null }, { $set: { userId } });

  const verifiedPayments = await PaymentRecord.find({ normalizedEmail: normEmail, status: "verified" }).lean();
  for (const payment of verifiedPayments) {
    const existing = await Entitlement.findOne({ seasonId: payment.seasonId, normalizedEmail: normEmail }).select("_id").lean();
    if (existing) continue;
    await grantEntitlement({
      email: normEmail,
      userId,
      seasonId: payment.seasonId,
      tier: "paid",
      source: "payment",
      paymentId: payment._id,
    });
  }
}

/** True when the user holds any active, unexpired entitlement (display cache for User.isPaid). */
async function hasAnyActiveEntitlement(email) {
  const normEmail = normalizeEmail(email);
  if (!normEmail) return false;
  const now = new Date();
  const found = await Entitlement.findOne({
    normalizedEmail: normEmail,
    status: "active",
    $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }],
  })
    .select("_id")
    .lean();
  return Boolean(found);
}

module.exports = {
  canAccessTest,
  getEntitledSeasonIds,
  isTestAccessible,
  grantEntitlement,
  revokeEntitlement,
  linkPendingPaymentToUser,
  hasAnyActiveEntitlement,
};
