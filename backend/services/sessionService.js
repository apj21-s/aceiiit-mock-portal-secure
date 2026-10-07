const jwt = require("jsonwebtoken");

const User = require("../models/User");

const SESSION_COOKIE = "aceiiit_session";
const DEFAULT_SESSION_TTL_HOURS = 24;
// /auth/me re-issues the cookie once a session is older than this (sliding renewal).
const RENEW_AFTER_SECONDS = 15 * 60;

function sessionTtlSeconds() {
  const hours = Number(process.env.SESSION_TTL_HOURS || DEFAULT_SESSION_TTL_HOURS);
  const safeHours = Number.isFinite(hours) && hours > 0 ? Math.min(hours, 24 * 7) : DEFAULT_SESSION_TTL_HOURS;
  return Math.round(safeHours * 60 * 60);
}

function cookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
  };
}

/** The JWT only identifies the user and session generation; role/paid state is read from the DB. */
function signSession(user) {
  return jwt.sign(
    { userId: String(user._id || user.id), tv: Number(user.tokenVersion || 0) },
    process.env.JWT_SECRET,
    { expiresIn: sessionTtlSeconds() }
  );
}

function setSessionCookie(res, user) {
  res.cookie(SESSION_COOKIE, signSession(user), Object.assign(cookieOptions(), { maxAge: sessionTtlSeconds() * 1000 }));
}

function clearSessionCookie(res) {
  res.clearCookie(SESSION_COOKIE, cookieOptions());
}

function verifySessionToken(token) {
  return jwt.verify(token, process.env.JWT_SECRET);
}

/** Invalidates every outstanding session for the user. Returns the new token version. */
async function revokeAllSessions(userId) {
  const updated = await User.findByIdAndUpdate(userId, { $inc: { tokenVersion: 1 } }, { new: true }).select("tokenVersion");
  return updated ? updated.tokenVersion : null;
}

function shouldRenew(issuedAtSeconds) {
  if (!issuedAtSeconds) return true;
  return Math.floor(Date.now() / 1000) - Number(issuedAtSeconds) >= RENEW_AFTER_SECONDS;
}

module.exports = {
  SESSION_COOKIE,
  sessionTtlSeconds,
  signSession,
  setSessionCookie,
  clearSessionCookie,
  verifySessionToken,
  revokeAllSessions,
  shouldRenew,
};
