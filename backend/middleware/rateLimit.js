const rateLimit = require("express-rate-limit");

function authLimiter() {
  return rateLimit({
    windowMs: 10 * 60 * 1000,
    // Per-IP ceiling. Kept generous for shared campus IPs (200-250 students); per-account
    // brute force is handled by loginAccountLimiter + the DB lockout in authController.
    max: 600,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many authentication requests. Please try again later." },
  });
}

// Authenticated routes are limited per user, not per IP: hundreds of students commonly
// share one campus NAT address. Unauthenticated routes fall back to the client IP.
function userOrIpKey(req) {
  return req.auth && req.auth.userId ? `user:${req.auth.userId}` : `ip:${req.ip}`;
}

function submissionLimiter() {
  return rateLimit({
    windowMs: 60 * 1000,
    max: 20,
    keyGenerator: userOrIpKey,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many submission requests. Please wait a moment." },
  });
}

function readLimiter() {
  return rateLimit({
    windowMs: 60 * 1000,
    max: 500,
    keyGenerator: userOrIpKey,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many requests. Please slow down slightly." },
  });
}

function activationLimiter() {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    keyGenerator: (req) => {
      const email = req.body && req.body.email ? String(req.body.email).toLowerCase().trim() : "";
      return email ? `${req.ip}_${email}` : req.ip;
    },
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many account activation requests for this email. Please wait a few minutes before trying again." },
  });
}

function passwordResetLimiter() {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    keyGenerator: (req) => {
      const email = req.body && req.body.email ? String(req.body.email).toLowerCase().trim() : "";
      return email ? `${req.ip}_${email}` : req.ip;
    },
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many password reset requests for this email. Please wait a few minutes before trying again." },
  });
}

function emailKey(req) {
  const email = req.body && req.body.email ? String(req.body.email).toLowerCase().trim() : "";
  return email ? `email:${email}` : `ip:${req.ip}`;
}

// Counts only failed logins per email, for existing and non-existent accounts alike,
// so the 429 response can't be used to tell whether an account exists.
function loginAccountLimiter() {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    skipSuccessfulRequests: true,
    keyGenerator: emailKey,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many login attempts for this account. Please wait 15 minutes or reset your password." },
  });
}

module.exports = { authLimiter, loginAccountLimiter, submissionLimiter, readLimiter, activationLimiter, passwordResetLimiter };
