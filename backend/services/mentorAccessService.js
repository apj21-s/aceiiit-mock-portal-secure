const MentorUsage = require("../models/MentorUsage");
const PaymentRecord = require("../models/PaymentRecord");
const { hasAnyActiveEntitlement } = require("./entitlementService");
const { getMentorSettings } = require("./mentorSettingsService");
const { getSiteCustomer, isConfigured: siteConfigured } = require("./siteCustomerService");
const { logger, errorSummary } = require("../utils/logger");

// Who may get a mentor reply, and how many this month.
//
// Period: the calendar month in Asia/Kolkata (IST, UTC+5:30). Resets at 00:00 IST on the 1st.
// Tier: "enrolled" only with a verified, active purchase whose resource code an admin listed as
// programme enrolment (Studio → ACEIIIT Mentor): an ACTIVE entitlement on the AceIIIT site, or a
// verified commerce payment recorded here. PAID_MOCK_SERIES is the portal's own paid access, so
// listing it also counts any active, unexpired portal entitlement (including access an admin
// granted in Studio), the same rule that unlocks paid tests. Anything else, including a site lookup that fails,
// is the free tier (fail closed). The browser never decides the tier or the count.
// Usage: see models/MentorUsage.js (reserve → settle on success / release on failure).

const IST_OFFSET_MS = 330 * 60 * 1000;
// Longer than a Gemini call can take (timeout ~20 s), so only truly abandoned ones expire.
const RESERVATION_TTL_MS = 3 * 60 * 1000;

function istNow(now) {
  return new Date(new Date(now || Date.now()).getTime() + IST_OFFSET_MS);
}

/** { period: "2026-10", day: "2026-10-15", startsAt, resetsAt } in IST. */
function usagePeriod(now = new Date()) {
  const ist = istNow(now);
  const year = ist.getUTCFullYear();
  const month = ist.getUTCMonth();
  const pad = (n) => String(n).padStart(2, "0");
  return {
    period: `${year}-${pad(month + 1)}`,
    day: `${year}-${pad(month + 1)}-${pad(ist.getUTCDate())}`,
    startsAt: new Date(Date.UTC(year, month, 1) - IST_OFFSET_MS),
    resetsAt: new Date(Date.UTC(year, month + 1, 1) - IST_OFFSET_MS),
  };
}

/** The verified programme enrolment behind the enrolled tier, or null. */
async function findProgrammeEnrolment(user, settings) {
  const codes = settings.programCodes || [];
  if (!codes.length || !user || !user.email) return null;
  const email = String(user.normalizedEmail || user.email).trim().toLowerCase();
  const payment = await PaymentRecord.findOne({ normalizedEmail: email, status: "verified", "rawPayload.resourceCode": { $in: codes } })
    .select("rawPayload verifiedAt")
    .lean();
  if (payment) return { type: "portal_payment", resourceCode: payment.rawPayload.resourceCode, since: payment.verifiedAt || null };
  if (codes.includes("PAID_MOCK_SERIES") && (await hasAnyActiveEntitlement(email))) {
    return { type: "portal_access", resourceCode: "PAID_MOCK_SERIES", since: null };
  }
  if (!siteConfigured()) return null;
  try {
    const site = await getSiteCustomer(email);
    const active = (site.entitlements || []).find((e) => e && e.status === "ACTIVE" && codes.includes(String(e.resourceCode || "").toUpperCase()));
    return active ? { type: "aceiiit_site", resourceCode: String(active.resourceCode).toUpperCase(), since: active.createdAt || null } : null;
  } catch (err) {
    logger.warn({ err: errorSummary(err) }, "mentor tier: site lookup failed, using the free tier");
    return null;
  }
}

async function readUsage(userId, period) {
  const doc = await MentorUsage.findOne({ userId, period }).lean();
  const fresh = (doc && doc.reservations ? doc.reservations : []).filter((r) => Date.now() - new Date(r.at).getTime() < RESERVATION_TTL_MS);
  return { used: doc ? Number(doc.used || 0) : 0, reserved: fresh.length };
}

/**
 * The student's mentor access right now: tier, monthly limit, used/remaining, reset time and
 * whether a new reply may be generated (availability is added by the mentor service).
 */
async function getMentorAccess(user, { now = new Date(), settings: given } = {}) {
  const settings = given || (await getMentorSettings());
  const p = usagePeriod(now);
  const [enrolment, usage] = await Promise.all([findProgrammeEnrolment(user, settings), readUsage(user._id, p.period)]);
  const tier = enrolment ? "enrolled" : "free";
  const limit = tier === "enrolled" ? settings.enrolledMonthlyReplies : settings.freeMonthlyReplies;
  const remaining = Math.max(0, limit - usage.used - usage.reserved);
  return {
    tier,
    limit,
    used: usage.used,
    remaining,
    period: p.period,
    periodStartsAt: p.startsAt.toISOString(),
    resetsAt: p.resetsAt.toISOString(),
    timezone: "Asia/Kolkata",
    canReply: remaining > 0,
    source: enrolment,
    expiresAt: null,
    ctaUrl: settings.ctaUrl,
  };
}

async function ensureUsageDoc(userId, period) {
  try {
    await MentorUsage.updateOne({ userId, period }, { $setOnInsert: { used: 0, reservations: [] } }, { upsert: true });
  } catch (err) {
    if (err && err.code !== 11000) throw err; // a concurrent upsert created it
  }
}

/**
 * Atomically reserves one reply for `key` within `limit`. Returns { ok, period } or
 * { ok: false, code: "LIMIT" | "IN_PROGRESS" }. Abandoned reservations are dropped first.
 */
async function reserveReply(userId, limit, key, now = new Date()) {
  const { period } = usagePeriod(now);
  await ensureUsageDoc(userId, period);
  await MentorUsage.updateOne({ userId, period }, { $pull: { reservations: { at: { $lt: new Date(now.getTime() - RESERVATION_TTL_MS) } } } });
  const doc = await MentorUsage.findOneAndUpdate(
    {
      userId,
      period,
      "reservations.key": { $ne: key },
      $expr: { $lt: [{ $add: ["$used", { $size: "$reservations" }] }, Number(limit) || 0] },
    },
    { $push: { reservations: { key, at: now } } },
    { new: true }
  ).lean();
  if (doc) return { ok: true, period };
  const inFlight = await MentorUsage.exists({ userId, period, "reservations.key": key });
  return { ok: false, code: inFlight ? "IN_PROGRESS" : "LIMIT", period };
}

/** A reply was stored: the reservation becomes one used reply. */
async function settleReply(userId, period, key) {
  await MentorUsage.updateOne({ userId, period, "reservations.key": key }, { $pull: { reservations: { key } }, $inc: { used: 1 } });
}

/** No reply (failure, refusal): the reservation is returned unused. */
async function releaseReply(userId, period, key) {
  await MentorUsage.updateOne({ userId, period }, { $pull: { reservations: { key } } });
}

module.exports = {
  usagePeriod,
  getMentorAccess,
  findProgrammeEnrolment,
  reserveReply,
  settleReply,
  releaseReply,
  RESERVATION_TTL_MS,
};
