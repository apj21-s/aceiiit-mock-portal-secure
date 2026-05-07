const jwt = require("jsonwebtoken");
const User = require("../models/User");

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

function requireAuth(req, res, next) {
  const header = String(req.headers.authorization || "");
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  try {
    const payload = jwt.verify(match[1], process.env.JWT_SECRET);
    req.auth = payload;
    touchUserPresence(payload && payload.userId);
    return next();
  } catch (_err) {
    return res.status(401).json({ error: "Unauthorized" });
  }
}

function requireAdmin(req, res, next) {
  if (!req.auth || req.auth.role !== "admin") {
    return res.status(403).json({ error: "Forbidden" });
  }
  return next();
}

module.exports = { requireAuth, requireAdmin };
