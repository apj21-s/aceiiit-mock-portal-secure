const crypto = require("crypto");
const { hashPassword, verifyPassword } = require("../utils/password");
const jwt = require("jsonwebtoken");
const { z } = require("zod");

const AuthToken = require("../models/AuthToken");
const User = require("../models/User");
const { sendActivationEmail, sendPasswordResetEmail } = require("../utils/mailService");
const { normalizeEmail } = require("../utils/normalize");
const { linkPendingPaymentToUser, hasAnyActiveEntitlement } = require("../services/entitlementService");
const { isInsecureDevAuthAllowed } = require("../config/env");
const { logAuditEvent } = require("../services/auditLogService");
const {
  setSessionCookie,
  clearSessionCookie,
  revokeAllSessions,
  shouldRenew,
} = require("../services/sessionService");

const MAX_FAILED_LOGINS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

// One message for every login failure, so responses don't reveal whether an account
// exists, is activated, or has a password.
const INVALID_LOGIN_MESSAGE = "Invalid email or password. If you haven't activated your account yet, use 'Activate Account'.";
const LOCKED_MESSAGE = "Too many login attempts for this account. Please wait 15 minutes or reset your password.";
const ACTIVATION_REQUEST_MESSAGE = "If this email is eligible, an activation link has been sent. Already activated? Log in or use 'Forgot password'.";
const RESET_REQUEST_MESSAGE = "If an account exists for this email address, password reset instructions have been sent.";

class ProviderUnavailableError extends Error {}

let cachedAdminRaw = null;
let cachedAdminSet = new Set();

function isAdminEmail(email) {
  const raw = String(process.env.ADMIN_EMAILS || "").trim();
  if (!raw) return false;
  if (raw !== cachedAdminRaw) {
    cachedAdminRaw = raw;
    cachedAdminSet = new Set(
      raw
        .split(",")
        .map((s) => String(s || "").trim().toLowerCase())
        .filter(Boolean)
    );
  }
  return cachedAdminSet.has(String(email || "").trim().toLowerCase());
}

// =============================================================================
// OAuth identity-token verification (fail closed)
// =============================================================================
const providerKeyCaches = new Map();

async function fetchProviderKeys(url, ttlMs) {
  let res;
  try {
    res = await fetch(url);
  } catch (err) {
    throw new ProviderUnavailableError(`Could not reach identity provider: ${err.message}`);
  }
  if (!res.ok) throw new ProviderUnavailableError(`Identity provider key fetch failed (${res.status})`);
  const data = await res.json();
  const entry = { keys: Array.isArray(data.keys) ? data.keys : [], expiresAt: Date.now() + ttlMs };
  providerKeyCaches.set(url, entry);
  return entry;
}

async function getProviderPublicKey(url, kid, ttlMs) {
  let entry = providerKeyCaches.get(url);
  if (!entry || Date.now() > entry.expiresAt) {
    entry = await fetchProviderKeys(url, ttlMs);
  }
  let jwk = entry.keys.find((k) => k.kid === kid);
  if (!jwk) {
    // Keys rotate; refetch once before rejecting an unknown kid.
    entry = await fetchProviderKeys(url, ttlMs);
    jwk = entry.keys.find((k) => k.kid === kid);
  }
  if (!jwk) return null;
  return crypto.createPublicKey({ key: jwk, format: "jwk" });
}

/**
 * Verifies signature, algorithm, issuer, audience, expiry and subject.
 * Returns the payload, or null when the token is invalid for any reason.
 * Throws ProviderUnavailableError only when the provider's keys can't be fetched.
 */
async function verifyIdentityToken(token, { keysUrl, keysTtlMs, issuer, audience }) {
  const decoded = jwt.decode(token, { complete: true });
  if (!decoded || !decoded.header || !decoded.header.kid) return null;
  const publicKey = await getProviderPublicKey(keysUrl, decoded.header.kid, keysTtlMs);
  if (!publicKey) return null;
  try {
    const payload = jwt.verify(token, publicKey, { algorithms: ["RS256"], issuer, audience });
    if (!payload || !payload.sub) return null;
    return payload;
  } catch (_err) {
    return null;
  }
}

function isVerifiedEmailClaim(value) {
  return value === true || value === "true";
}

function verifyGoogleIdToken(idToken) {
  return verifyIdentityToken(idToken, {
    keysUrl: "https://www.googleapis.com/oauth2/v3/certs",
    keysTtlMs: 6 * 60 * 60 * 1000,
    issuer: ["accounts.google.com", "https://accounts.google.com"],
    audience: process.env.GOOGLE_CLIENT_ID,
  });
}

function verifyAppleIdentityToken(identityToken) {
  return verifyIdentityToken(identityToken, {
    keysUrl: "https://appleid.apple.com/auth/keys",
    keysTtlMs: 24 * 60 * 60 * 1000,
    issuer: "https://appleid.apple.com",
    audience: process.env.APPLE_CLIENT_ID,
  });
}

/**
 * Finds or creates the account for a verified provider identity.
 * Links by provider subject first; links by email only when the provider itself
 * verified that email. A request-body email is never trusted for identity.
 */
async function resolveProviderUser({ subjectField, subject, email, emailVerified, name }) {
  let user = await User.findOne({ [subjectField]: subject });
  if (!user && email && emailVerified) {
    user = await User.findOne({ email });
    if (user && user[subjectField] && user[subjectField] !== subject) {
      // The email already belongs to a different identity at this provider.
      return { error: { status: 409, message: "This email is linked to a different sign-in account." } };
    }
  }

  if (!user) {
    if (!email || !emailVerified) {
      return { error: { status: 400, message: "A verified email address is required to create an account." } };
    }
    user = await User.create({
      name: (name && String(name).trim().slice(0, 80)) || email.split("@")[0] || "Student",
      email,
      [subjectField]: subject,
      role: isAdminEmail(email) ? "admin" : "student",
      isPaid: false,
      status: "active",
      isActivated: true,
      emailVerified: true,
      lastSeenAt: new Date(),
    });
    return { user };
  }

  if (user.deletedAt || user.status === "disabled") {
    return { error: { status: 403, message: "Account is disabled. Contact portal administrator." } };
  }
  if (!user[subjectField]) user[subjectField] = subject;
  return { user };
}

async function finalizeLogin(res, user) {
  const desiredRole = isAdminEmail(user.email) ? "admin" : user.role;
  if (desiredRole !== user.role) {
    await auditRoleChange(user, user.role, desiredRole);
    user.role = desiredRole;
    // A role change invalidates every existing session.
    user.tokenVersion = Number(user.tokenVersion || 0) + 1;
  }
  user.isActivated = true;
  user.emailVerified = true;
  user.status = "active";
  user.failedLoginCount = 0;
  user.lockedUntil = null;
  user.lastSeenAt = new Date();
  await user.save();
  await linkPendingPaymentToUser(user);
  await syncPaidDisplayFlag(user);
  setSessionCookie(res, user);
  return res.json({ user: user.toJSON() });
}

/** `User.isPaid` is only a display cache of "has an active entitlement"; it never grants access. */
async function syncPaidDisplayFlag(user) {
  const paid = await hasAnyActiveEntitlement(user.email);
  if (Boolean(user.isPaid) !== paid) {
    user.isPaid = paid;
    await User.updateOne({ _id: user._id }, { $set: { isPaid: paid } });
  }
}

function auditRoleChange(user, fromRole, toRole) {
  return logAuditEvent({
    actorUserId: null,
    action: "USER_ROLE_CHANGED",
    entityType: "User",
    entityId: String(user._id || ""),
    before: { role: fromRole },
    after: { role: toRole },
    metadata: { reason: "ADMIN_EMAILS configuration" },
  });
}

function hashToken(rawToken) {
  return crypto.createHash("sha256").update(String(rawToken)).digest("hex");
}

function getBaseUrl(req) {
  if (process.env.PORTAL_BASE_URL) {
    return String(process.env.PORTAL_BASE_URL).replace(/\/+$/, "");
  }
  const host = req.get("host") || "localhost:4000";
  const protocol = req.protocol || "http";
  return `${protocol}://${host}`;
}

// =============================================================================
// 1. EMAIL + PASSWORD LOGIN
// =============================================================================
const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1, "Password is required"),
});

async function login(req, res, next) {
  try {
    const { email, password } = loginSchema.parse(req.body || {});
    const normalizedEmail = normalizeEmail(email);

    const user = await User.findOne({ email: normalizedEmail }).select("+passwordHash");
    if (user && user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
      return res.status(429).json({ error: LOCKED_MESSAGE });
    }
    if (!user || user.deletedAt || user.status === "disabled" || !user.passwordHash) {
      await verifyPassword(password, null); // same work as a real check (no timing oracle)
      return res.status(401).json({ error: INVALID_LOGIN_MESSAGE });
    }

    const isValidPassword = await verifyPassword(password, user.passwordHash);
    if (!isValidPassword) {
      const failedLoginCount = Number(user.failedLoginCount || 0) + 1;
      const update = { failedLoginCount };
      if (failedLoginCount >= MAX_FAILED_LOGINS) {
        update.lockedUntil = new Date(Date.now() + LOCKOUT_MS);
        update.failedLoginCount = 0;
      }
      await User.updateOne({ _id: user._id }, { $set: update });
      // The locking attempt itself still answers 401, so existing and unknown accounts
      // behave identically: attempts 1-5 get 401, the 6th onward gets 429.
      return res.status(401).json({ error: INVALID_LOGIN_MESSAGE });
    }

    return finalizeLogin(res, user);
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: "Please enter a valid email and password." });
    }
    return next(err);
  }
}

// =============================================================================
// 2. FIRST-TIME ACCOUNT ACTIVATION (LINK BASED)
// =============================================================================
const requestActivationSchema = z.object({
  email: z.string().email(),
});

/**
 * Always answers with the same message. No User record is created here; the account
 * is created only when the emailed link is completed, so this endpoint can't be used
 * to enumerate or spam-create accounts.
 */
async function requestActivation(req, res, next) {
  try {
    const { email } = requestActivationSchema.parse(req.body || {});
    const normalizedEmail = normalizeEmail(email);

    const user = await User.findOne({ email: normalizedEmail }).select("+passwordHash");
    const eligible = !user || (!user.deletedAt && user.status !== "disabled" && !user.passwordHash);

    if (eligible) {
      const rawToken = crypto.randomBytes(32).toString("hex");
      await AuthToken.deleteMany({ email: normalizedEmail, purpose: "activation" });
      await AuthToken.create({
        userId: user ? user._id : null,
        email: normalizedEmail,
        tokenHash: hashToken(rawToken),
        purpose: "activation",
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      });
      await sendActivationEmail(normalizedEmail, rawToken, getBaseUrl(req));
    }

    return res.json({ ok: true, message: ACTIVATION_REQUEST_MESSAGE });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: "Please enter a valid email address." });
    }
    return next(err);
  }
}

async function findUsableToken(rawToken, purpose) {
  const tokenDoc = await AuthToken.findOne({ tokenHash: hashToken(rawToken), purpose, usedAt: null });
  if (!tokenDoc || tokenDoc.expiresAt.getTime() < Date.now()) return null;
  return tokenDoc;
}

async function verifyActivationToken(req, res, next) {
  try {
    const rawToken = String(req.query.token || "").trim();
    if (!rawToken) {
      return res.status(400).json({ error: "Activation token is missing." });
    }
    const tokenDoc = await findUsableToken(rawToken, "activation");
    if (!tokenDoc) {
      return res.status(400).json({ error: "Activation link is invalid or has expired. Please request a new activation link." });
    }
    return res.json({ ok: true, email: tokenDoc.email });
  } catch (err) {
    return next(err);
  }
}

const completeActivationSchema = z.object({
  token: z.string().min(1),
  password: z.string().min(8, "Password must be at least 8 characters long"),
  name: z.string().trim().min(2).max(80).optional(),
});

async function completeActivation(req, res, next) {
  try {
    const { token: rawToken, password, name } = completeActivationSchema.parse(req.body || {});
    const tokenDoc = await findUsableToken(rawToken, "activation");
    if (!tokenDoc) {
      return res.status(400).json({ error: "Activation link is invalid or has expired. Please request a new activation link." });
    }

    let user = tokenDoc.userId ? await User.findById(tokenDoc.userId) : null;
    if (!user) user = await User.findOne({ email: tokenDoc.email });
    if (user && (user.deletedAt || user.status === "disabled")) {
      return res.status(400).json({ error: "Activation link is invalid or has expired. Please request a new activation link." });
    }

    const passwordHash = await hashPassword(password);
    if (!user) {
      user = new User({
        name: (name && String(name).trim()) || tokenDoc.email.split("@")[0] || "Student",
        email: tokenDoc.email,
        role: isAdminEmail(tokenDoc.email) ? "admin" : "student",
        isPaid: false,
      });
    } else if (name && String(name).trim() && (user.name === "Student" || !user.name)) {
      user.name = String(name).trim();
    }
    user.passwordHash = passwordHash;

    tokenDoc.usedAt = new Date();
    await tokenDoc.save();
    return finalizeLogin(res, user);
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: err.errors[0]?.message || "Invalid inputs." });
    }
    return next(err);
  }
}

// =============================================================================
// 3. FORGOT PASSWORD & RECOVERY (LINK BASED)
// =============================================================================
const requestPasswordResetSchema = z.object({
  email: z.string().email(),
});

async function requestPasswordReset(req, res, next) {
  try {
    const { email } = requestPasswordResetSchema.parse(req.body || {});
    const normalizedEmail = normalizeEmail(email);

    const user = await User.findOne({ email: normalizedEmail });
    if (user && !user.deletedAt && user.status !== "disabled") {
      const rawToken = crypto.randomBytes(32).toString("hex");
      await AuthToken.deleteMany({ email: normalizedEmail, purpose: "password_reset" });
      await AuthToken.create({
        userId: user._id,
        email: normalizedEmail,
        tokenHash: hashToken(rawToken),
        purpose: "password_reset",
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      });
      await sendPasswordResetEmail(normalizedEmail, rawToken, getBaseUrl(req));
    }

    return res.json({ ok: true, message: RESET_REQUEST_MESSAGE });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: "Please enter a valid email address." });
    }
    return next(err);
  }
}

async function verifyResetToken(req, res, next) {
  try {
    const rawToken = String(req.query.token || "").trim();
    if (!rawToken) {
      return res.status(400).json({ error: "Reset token is missing." });
    }
    const tokenDoc = await findUsableToken(rawToken, "password_reset");
    if (!tokenDoc) {
      return res.status(400).json({ error: "Password reset link is invalid or has expired. Please request a new link." });
    }
    return res.json({ ok: true, email: tokenDoc.email });
  } catch (err) {
    return next(err);
  }
}

const completePasswordResetSchema = z.object({
  token: z.string().min(1),
  password: z.string().min(8, "Password must be at least 8 characters long"),
});

async function completePasswordReset(req, res, next) {
  try {
    const { token: rawToken, password } = completePasswordResetSchema.parse(req.body || {});
    const tokenDoc = await findUsableToken(rawToken, "password_reset");
    if (!tokenDoc) {
      return res.status(400).json({ error: "Password reset link is invalid or has expired. Please request a new link." });
    }

    const user = await User.findById(tokenDoc.userId);
    if (!user || user.deletedAt) {
      return res.status(400).json({ error: "Password reset link is invalid or has expired. Please request a new link." });
    }

    user.passwordHash = await hashPassword(password);
    user.isActivated = true;
    user.emailVerified = true;
    user.status = "active";
    user.failedLoginCount = 0;
    user.lockedUntil = null;
    // Resetting a password signs out every existing session.
    user.tokenVersion = Number(user.tokenVersion || 0) + 1;
    await user.save();

    tokenDoc.usedAt = new Date();
    await tokenDoc.save();

    return res.json({ ok: true, message: "Password updated successfully. You can now log in." });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: err.errors[0]?.message || "Invalid inputs." });
    }
    return next(err);
  }
}

// =============================================================================
// 4. GOOGLE SIGN-IN (SERVER-SIDE VERIFICATION, FAIL CLOSED)
// =============================================================================
const googleAuthSchema = z.object({
  credential: z.string().max(8192).optional(),
  email: z.string().email().optional(),
  name: z.string().max(120).optional(),
});

async function googleAuth(req, res, next) {
  try {
    const { credential, email: bodyEmail, name: bodyName } = googleAuthSchema.parse(req.body || {});
    const devAuth = isInsecureDevAuthAllowed();
    let identity = null;

    if (devAuth && ((credential && credential.startsWith("mock_google_")) || (!credential && bodyEmail))) {
      // Development-only mock identity; refused in production by config/env.js.
      const mockEmail = normalizeEmail(bodyEmail || String(credential).replace("mock_google_", ""));
      identity = { subject: `mock_sub_${mockEmail}`, email: mockEmail, emailVerified: true, name: bodyName };
    } else {
      if (!credential) {
        return res.status(400).json({ error: "Google OAuth credential token is required." });
      }
      if (!process.env.GOOGLE_CLIENT_ID) {
        return res.status(503).json({ error: "Google sign-in is not configured." });
      }
      const payload = await verifyGoogleIdToken(credential);
      if (!payload) {
        return res.status(401).json({ error: "Invalid or expired Google OAuth credential." });
      }
      if (!payload.email || !isVerifiedEmailClaim(payload.email_verified)) {
        return res.status(401).json({ error: "Unverified Google email address." });
      }
      identity = {
        subject: payload.sub,
        email: normalizeEmail(payload.email),
        emailVerified: true,
        name: payload.name || bodyName,
      };
    }

    const resolved = await resolveProviderUser({ subjectField: "googleSubject", ...identity });
    if (resolved.error) {
      return res.status(resolved.error.status).json({ error: resolved.error.message });
    }
    return finalizeLogin(res, resolved.user);
  } catch (err) {
    if (err instanceof ProviderUnavailableError) {
      return res.status(503).json({ error: "Google sign-in is temporarily unavailable. Please try again." });
    }
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: "Invalid Google identity payload." });
    }
    return next(err);
  }
}

// =============================================================================
// 5. APPLE SIGN-IN (SERVER-SIDE VERIFICATION, FAIL CLOSED)
// =============================================================================
const appleAuthSchema = z.object({
  identityToken: z.string().max(8192).optional(),
  email: z.string().email().optional(),
  name: z.string().max(120).optional(),
});

async function appleAuth(req, res, next) {
  try {
    const { identityToken, email: bodyEmail, name: bodyName } = appleAuthSchema.parse(req.body || {});
    const devAuth = isInsecureDevAuthAllowed();
    let identity = null;

    if (devAuth && ((identityToken && identityToken.startsWith("mock_apple_")) || (!identityToken && bodyEmail))) {
      // Development-only mock identity; refused in production by config/env.js.
      const mockEmail = normalizeEmail(bodyEmail || String(identityToken).replace("mock_apple_", ""));
      identity = { subject: `mock_apple_sub_${mockEmail}`, email: mockEmail, emailVerified: true, name: bodyName };
    } else {
      if (!identityToken) {
        return res.status(400).json({ error: "Apple identity token is required." });
      }
      if (!process.env.APPLE_CLIENT_ID) {
        return res.status(503).json({ error: "Apple sign-in is not configured." });
      }
      const payload = await verifyAppleIdentityToken(identityToken);
      if (!payload) {
        return res.status(401).json({ error: "Invalid or expired Apple identity token." });
      }
      // Apple only includes the email on first sign-in; later sign-ins match by subject.
      identity = {
        subject: payload.sub,
        email: payload.email ? normalizeEmail(payload.email) : "",
        emailVerified: isVerifiedEmailClaim(payload.email_verified),
        name: bodyName,
      };
    }

    const resolved = await resolveProviderUser({ subjectField: "appleSubject", ...identity });
    if (resolved.error) {
      return res.status(resolved.error.status).json({ error: resolved.error.message });
    }
    return finalizeLogin(res, resolved.user);
  } catch (err) {
    if (err instanceof ProviderUnavailableError) {
      return res.status(503).json({ error: "Apple sign-in is temporarily unavailable. Please try again." });
    }
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: "Invalid Apple identity payload." });
    }
    return next(err);
  }
}

// =============================================================================
// 6. SESSION & LOGOUT
// =============================================================================
async function logout(_req, res) {
  clearSessionCookie(res);
  return res.json({ ok: true });
}

/** Signs out every device by invalidating all sessions for the current user. */
async function logoutAll(req, res, next) {
  try {
    await revokeAllSessions(req.auth.userId);
    clearSessionCookie(res);
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
}

async function me(req, res, next) {
  try {
    const user = await User.findById(req.auth.userId).select("+passwordHash");
    if (!user || user.deletedAt || user.status === "disabled") {
      clearSessionCookie(res);
      return res.status(401).json({ error: "Unauthorized" });
    }

    const desiredRole = isAdminEmail(user.email) ? "admin" : user.role;
    if (desiredRole !== user.role) {
      await auditRoleChange(user, user.role, desiredRole);
      user.role = desiredRole;
      user.tokenVersion = Number(user.tokenVersion || 0) + 1;
      await user.save();
      setSessionCookie(res, user);
    } else if (shouldRenew(req.auth.iat)) {
      // Sliding renewal: active users keep a fresh session without re-login.
      setSessionCookie(res, user);
    }
    await linkPendingPaymentToUser(user);
    await syncPaidDisplayFlag(user);

    return res.json({ user: user.toJSON() });
  } catch (err) {
    return next(err);
  }
}

const updatePasswordSchema = z.object({
  currentPassword: z.string().optional(),
  newPassword: z.string().min(8, "Password must be at least 8 characters long"),
});

async function updatePassword(req, res, next) {
  try {
    const { currentPassword, newPassword } = updatePasswordSchema.parse(req.body || {});
    const user = await User.findById(req.auth.userId).select("+passwordHash");
    if (!user) return res.status(404).json({ error: "User not found" });

    if (user.passwordHash) {
      if (!currentPassword) return res.status(400).json({ error: "Current password is required." });
      const isValid = await verifyPassword(currentPassword, user.passwordHash);
      if (!isValid) return res.status(401).json({ error: "Incorrect current password." });
    }

    user.passwordHash = await hashPassword(newPassword);
    if (!user.isActivated) user.isActivated = true;
    // Sign out other sessions; keep this device signed in with a fresh cookie.
    user.tokenVersion = Number(user.tokenVersion || 0) + 1;
    await user.save();
    setSessionCookie(res, user);

    return res.json({ message: "Password updated successfully" });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: err.errors[0].message });
    }
    return next(err);
  }
}

// =============================================================================
// 7. OAUTH CONFIGURATION ENDPOINT
// =============================================================================
async function getAuthConfig(_req, res) {
  return res.json({
    googleClientId: process.env.GOOGLE_CLIENT_ID || "",
    appleClientId: process.env.APPLE_CLIENT_ID || "",
    appleRedirectUri: process.env.APPLE_REDIRECT_URI || "",
  });
}

module.exports = {
  login,
  requestActivation,
  verifyActivationToken,
  completeActivation,
  requestPasswordReset,
  verifyResetToken,
  completePasswordReset,
  googleAuth,
  appleAuth,
  getAuthConfig,
  logout,
  logoutAll,
  me,
  updatePassword,
};
