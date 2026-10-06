const rateLimit = require("express-rate-limit");

function otpLimiter() {
  return rateLimit({
    windowMs: 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many OTP requests. Please try again later." },
  });
}

function authLimiter() {
  return rateLimit({
    windowMs: 10 * 60 * 1000,
    max: 1000, // Elevated to support 200-250+ students logging in concurrently from shared campus IPs
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many authentication requests. Please try again later." },
  });
}

function submissionLimiter() {
  return rateLimit({
    windowMs: 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many submission requests. Please wait a moment." },
  });
}

function readLimiter() {
  return rateLimit({
    windowMs: 60 * 1000,
    max: 500,
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

module.exports = { otpLimiter, authLimiter, submissionLimiter, readLimiter, activationLimiter, passwordResetLimiter };
