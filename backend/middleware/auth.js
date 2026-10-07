const User = require("../models/User");
const { SESSION_COOKIE, verifySessionToken } = require("../services/sessionService");

const PRESENCE_TOUCH_INTERVAL_MS = 60 * 1000;

function touchUserPresence(userId) {
  if (!userId) return;
  const now = new Date();
  const threshold = new Date(Date.now() - PRESENCE_TOUCH_INTERVAL_MS);
  User.updateOne(
    {
      _id: userId,
      deletedAt: null,
      $or: [
        { lastSeenAt: { $exists: false } },
        { lastSeenAt: null },
        { lastSeenAt: { $lt: threshold } },
      ],
    },
    { $set: { lastSeenAt: now } }
  ).catch(function () {});
}

// Sessions are cookie-only. Bearer headers are deliberately ignored so the browser
// never needs to hold a readable token (no localStorage JWTs).
function extractToken(req) {
  const fromParser = req.cookies && req.cookies[SESSION_COOKIE];
  return fromParser ? String(fromParser) : null;
}

const SESSION_USER_FIELDS = "name email role isPaid status deletedAt tokenVersion";

/**
 * Authenticates the session cookie against the *current* user record on every request.
 * Deleted/disabled users and revoked sessions (tokenVersion mismatch) are rejected
 * immediately; role and paid state always come from the database, never the JWT.
 */
async function requireAuth(req, res, next) {
  const token = extractToken(req);
  if (!token) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  let payload;
  try {
    payload = verifySessionToken(token);
  } catch (_err) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  try {
    const user = payload && payload.userId
      ? await User.findById(payload.userId).select(SESSION_USER_FIELDS).lean()
      : null;
    if (
      !user ||
      user.deletedAt ||
      user.status === "disabled" ||
      Number(user.tokenVersion || 0) !== Number(payload.tv)
    ) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    req.auth = {
      userId: String(user._id),
      role: user.role,
      email: user.email,
      isPaid: Boolean(user.isPaid),
      name: user.name,
      tv: Number(user.tokenVersion || 0),
      iat: payload.iat,
    };
    touchUserPresence(user._id);
    return next();
  } catch (err) {
    return next(err);
  }
}

function requireAdmin(req, res, next) {
  if (!req.auth || req.auth.role !== "admin") {
    return res.status(403).json({ error: "Forbidden" });
  }
  return next();
}

module.exports = { requireAuth, requireAdmin };
