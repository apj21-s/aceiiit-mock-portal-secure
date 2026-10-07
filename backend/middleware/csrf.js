const crypto = require("crypto");

// Double-submit CSRF protection for cookie-authenticated mutations.
// The server sets a random, JS-readable `aceiiit_csrf` cookie; the browser echoes it in
// the `X-CSRF-Token` header. A cross-site page can't read the cookie, so it can't forge
// the header.

const CSRF_COOKIE = "aceiiit_csrf";
const CSRF_HEADER = "x-csrf-token";
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

// The only exemptions: routes authenticated independently of the browser session.
// - /api/internal/*: server-to-server, authenticated by INTERNAL_API_SECRET.
const EXEMPT_PREFIXES = ["/api/internal/"];

function cookieOptions() {
  return {
    httpOnly: false,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 7 * 24 * 60 * 60 * 1000,
  };
}

function newToken() {
  return crypto.randomBytes(32).toString("hex");
}

function isWellFormed(token) {
  return typeof token === "string" && /^[a-f0-9]{64}$/.test(token);
}

/** Ensures every visitor has a CSRF cookie. Mount before routes. */
function ensureCsrfCookie(req, res, next) {
  const existing = req.cookies && req.cookies[CSRF_COOKIE];
  if (!isWellFormed(existing)) {
    const token = newToken();
    res.cookie(CSRF_COOKIE, token, cookieOptions());
    req.cookies = Object.assign({}, req.cookies, { [CSRF_COOKIE]: token });
    req.csrfTokenIssued = token;
  }
  next();
}

function tokensMatch(a, b) {
  if (!isWellFormed(a) || !isWellFormed(b)) return false;
  const left = crypto.createHash("sha256").update(a).digest();
  const right = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(left, right);
}

function isExempt(req) {
  const fullPath = String(req.originalUrl || "").split("?")[0];
  return EXEMPT_PREFIXES.some((prefix) => fullPath.startsWith(prefix));
}

/** Rejects state-changing requests whose header doesn't match the cookie. */
function requireCsrf(req, res, next) {
  if (!MUTATING_METHODS.has(req.method) || isExempt(req)) {
    return next();
  }
  // A cookie minted during this same request can't have been echoed by the client.
  const cookieToken = req.csrfTokenIssued ? null : req.cookies && req.cookies[CSRF_COOKIE];
  const headerToken = req.get(CSRF_HEADER);
  if (!tokensMatch(cookieToken, headerToken)) {
    return res.status(403).json({ error: "Security check failed. Please refresh the page and try again.", code: "CSRF_FAILED" });
  }
  return next();
}

/** GET /api/auth/csrf: returns the current token (the cookie is set by ensureCsrfCookie). */
function issueCsrfToken(req, res) {
  res.set("Cache-Control", "no-store");
  res.json({ csrfToken: req.cookies[CSRF_COOKIE] });
}

module.exports = { CSRF_COOKIE, CSRF_HEADER, ensureCsrfCookie, requireCsrf, issueCsrfToken };
