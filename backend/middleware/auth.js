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

function extractToken(req) {
  const header = String(req.headers.authorization || "");
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (match && match[1]) {
    return match[1].trim();
  }
  const cookieHeader = String(req.headers.cookie || "");
  if (cookieHeader) {
    const cookies = cookieHeader.split(";");
    for (const cookie of cookies) {
      const parts = cookie.trim().split("=");
      if (parts[0] === "aceiiit_session" && parts[1]) {
        return decodeURIComponent(parts[1]);
      }
    }
  }
  return null;
}

function requireAuth(req, res, next) {
  const token = extractToken(req);
  if (!token) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
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
