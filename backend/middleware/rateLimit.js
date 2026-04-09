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
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many requests. Please try again later." },
  });
}

function submissionLimiter() {
  return rateLimit({
    windowMs: 60 * 1000,
    max: 12,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many submission requests. Please wait a moment." },
  });
}

function readLimiter() {
  return rateLimit({
    windowMs: 60 * 1000,
    max: 240,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many requests. Please slow down slightly." },
  });
}

module.exports = { otpLimiter, authLimiter, submissionLimiter, readLimiter };
