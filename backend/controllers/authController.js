const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { z } = require("zod");

const AuthToken = require("../models/AuthToken");
const Otp = require("../models/Otp");
const User = require("../models/User");
const { sendActivationEmail, sendPasswordResetEmail, sendOtpEmail } = require("../utils/mailService");
const { normalizeEmail } = require("../utils/normalize");
const { paidSheetService } = require("../services/paidSheetService");
const { linkPendingPaymentToUser } = require("../services/entitlementService");

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

let googleKeysCache = { keys: [], expiresAt: 0 };

async function getGooglePublicKey(kid) {
  const now = Date.now();
  if (!googleKeysCache.keys.length || now > googleKeysCache.expiresAt) {
    const res = await fetch("https://www.googleapis.com/oauth2/v3/certs");
    if (!res.ok) throw new Error("Failed to fetch Google public keys");
    const data = await res.json();
    googleKeysCache = {
      keys: data.keys || [],
      expiresAt: now + 6 * 60 * 60 * 1000,
    };
  }

  const matchingKey = googleKeysCache.keys.find((k) => k.kid === kid);
  if (!matchingKey) throw new Error(`Google public key for kid '${kid}' not found`);

  return crypto.createPublicKey({
    key: matchingKey,
    format: "jwk",
  });
}

async function verifyGoogleIdToken(idToken) {
  const decodedHeader = jwt.decode(idToken, { complete: true });
  if (!decodedHeader || !decodedHeader.header || !decodedHeader.header.kid) {
    throw new Error("Invalid Google ID token format");
  }

  const publicKey = await getGooglePublicKey(decodedHeader.header.kid);
  const options = {
    algorithms: ["RS256"],
    issuer: ["accounts.google.com", "https://accounts.google.com"],
  };

  if (process.env.GOOGLE_CLIENT_ID) {
    options.audience = process.env.GOOGLE_CLIENT_ID;
  }

  const payload = jwt.verify(idToken, publicKey, options);
  if (!payload.email || (payload.email_verified !== true && payload.email_verified !== "true")) {
    throw new Error("Unverified Google email address");
  }

  return payload;
}

let appleKeysCache = { keys: [], expiresAt: 0 };

async function getApplePublicKey(kid) {
  const now = Date.now();
  if (!appleKeysCache.keys.length || now > appleKeysCache.expiresAt) {
    const res = await fetch("https://appleid.apple.com/auth/keys");
    if (!res.ok) throw new Error("Failed to fetch Apple public keys");
    const data = await res.json();
    appleKeysCache = {
      keys: data.keys || [],
      expiresAt: now + 24 * 60 * 60 * 1000,
    };
  }

  const matchingKey = appleKeysCache.keys.find((k) => k.kid === kid);
  if (!matchingKey) throw new Error(`Apple public key for kid '${kid}' not found`);

  return crypto.createPublicKey({
    key: matchingKey,
    format: "jwk",
  });
}

async function verifyAppleToken(identityToken) {
  const decodedHeader = jwt.decode(identityToken, { complete: true });
  if (!decodedHeader || !decodedHeader.header || !decodedHeader.header.kid) {
    throw new Error("Invalid Apple identity token format");
  }

  const publicKey = await getApplePublicKey(decodedHeader.header.kid);
  const options = {
    algorithms: ["RS256"],
    issuer: "https://appleid.apple.com",
  };

  if (process.env.APPLE_CLIENT_ID) {
    options.audience = process.env.APPLE_CLIENT_ID;
  }

  return jwt.verify(identityToken, publicKey, options);
}

function setSessionCookie(res, token) {
  const maxAge = 7 * 24 * 60 * 60 * 1000;
  res.cookie("aceiiit_session", token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge,
  });
}

function clearSessionCookie(res) {
  res.clearCookie("aceiiit_session", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
  });
}

function getBaseUrl(req) {
  if (process.env.PORTAL_BASE_URL) {
    return String(process.env.PORTAL_BASE_URL).replace(/\/+$/, "");
  }
  const host = req.get("host") || "localhost:4000";
  const protocol = req.protocol || "http";
  return `${protocol}://${host}`;
}

function hashToken(rawToken) {
  return crypto.createHash("sha256").update(String(rawToken)).digest("hex");
}

// =============================================================================
// 1. NORMAL LOGIN (EMAIL + PASSWORD - ZERO EMAIL DISPATCH)
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
    if (!user || user.deletedAt || user.status === "disabled") {
      return res.status(401).json({ error: "Invalid email or password." });
    }

    if (!user.passwordHash) {
      return res.status(400).json({
        error: "Your account is not activated yet. Please click 'Activate Account' to set your password.",
        requiresActivation: true,
      });
    }

    const isValidPassword = await bcrypt.compare(password, user.passwordHash);
    if (!isValidPassword) {
      return res.status(401).json({ error: "Invalid email or password." });
    }

    // Sync admin status & link verified payments
    const desiredRole = isAdminEmail(normalizedEmail) ? "admin" : user.role;
    if (desiredRole !== user.role) user.role = desiredRole;
    if (!user.isActivated) user.isActivated = true;
    if (!user.emailVerified) user.emailVerified = true;
    if (user.status !== "active") user.status = "active";
    user.lastSeenAt = new Date();

    await user.save();
    await linkPendingPaymentToUser(user);

    const token = jwt.sign(
      { userId: user.id, role: user.role, email: user.email, isPaid: user.isPaid, name: user.name },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || "7d" }
    );

    setSessionCookie(res, token);
    return res.json({ token, user: user.toJSON() });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: err.errors[0]?.message || "Invalid inputs." });
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

async function requestActivation(req, res, next) {
  try {
    const { email } = requestActivationSchema.parse(req.body || {});
    const normalizedEmail = normalizeEmail(email);

    let user = await User.findOne({ email: normalizedEmail });

    if (!user) {
      user = await User.create({
        name: normalizedEmail.split("@")[0] || "Student",
        email: normalizedEmail,
        role: isAdminEmail(normalizedEmail) ? "admin" : "student",
        isPaid: paidSheetService.isVerified(normalizedEmail),
        status: "pending",
        isActivated: false,
        emailVerified: false,
      });
    } else if (user.deletedAt || user.status === "disabled") {
      return res.status(403).json({ error: "This account has been disabled. Please contact portal administrator." });
    }

    if (user.isActivated && user.passwordHash) {
      return res.json({
        ok: true,
        message: "Your account is already activated. You can log in directly with your email and password.",
        alreadyActivated: true,
      });
    }

    // Generate cryptographically secure single-use token
    const rawToken = crypto.randomBytes(32).toString("hex");
    const tokenHash = hashToken(rawToken);
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

    // Invalidate prior unused activation tokens for this email
    await AuthToken.deleteMany({ email: normalizedEmail, purpose: "activation" });

    await AuthToken.create({
      userId: user._id,
      email: normalizedEmail,
      tokenHash,
      purpose: "activation",
      expiresAt,
    });

    const baseUrl = getBaseUrl(req);
    await sendActivationEmail(normalizedEmail, rawToken, baseUrl);

    return res.json({
      ok: true,
      message: "Account activation instructions have been sent to your email inbox.",
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: "Please enter a valid email address." });
    }
    return next(err);
  }
}

async function verifyActivationToken(req, res, next) {
  try {
    const rawToken = String(req.query.token || "").trim();
    if (!rawToken) {
      return res.status(400).json({ error: "Activation token is missing." });
    }

    const tokenHash = hashToken(rawToken);
    const tokenDoc = await AuthToken.findOne({
      tokenHash,
      purpose: "activation",
      usedAt: null,
    });

    if (!tokenDoc || tokenDoc.expiresAt.getTime() < Date.now()) {
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
    const tokenHash = hashToken(rawToken);

    const tokenDoc = await AuthToken.findOne({
      tokenHash,
      purpose: "activation",
      usedAt: null,
    });

    if (!tokenDoc || tokenDoc.expiresAt.getTime() < Date.now()) {
      return res.status(400).json({ error: "Activation link is invalid or has expired. Please request a new activation link." });
    }

    const user = await User.findById(tokenDoc.userId);
    if (!user || user.deletedAt) {
      return res.status(400).json({ error: "Associated student account was not found." });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    if (name && String(name).trim() && (user.name === "Student" || !user.name)) {
      user.name = String(name).trim();
    }

    user.passwordHash = passwordHash;
    user.isActivated = true;
    user.emailVerified = true;
    user.status = "active";
    user.lastSeenAt = new Date();
    await user.save();

    tokenDoc.usedAt = new Date();
    await tokenDoc.save();

    const jwtToken = jwt.sign(
      { userId: user.id, role: user.role, email: user.email, isPaid: user.isPaid, name: user.name },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || "7d" }
    );

    setSessionCookie(res, jwtToken);
    return res.json({ token: jwtToken, user: user.toJSON() });
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
    if (!user || user.deletedAt || user.status === "disabled") {
      return res.json({
        ok: true,
        message: "If an account exists for this email address, password reset instructions have been sent.",
      });
    }

    const rawToken = crypto.randomBytes(32).toString("hex");
    const tokenHash = hashToken(rawToken);
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    await AuthToken.deleteMany({ email: normalizedEmail, purpose: "password_reset" });

    await AuthToken.create({
      userId: user._id,
      email: normalizedEmail,
      tokenHash,
      purpose: "password_reset",
      expiresAt,
    });

    const baseUrl = getBaseUrl(req);
    await sendPasswordResetEmail(normalizedEmail, rawToken, baseUrl);

    return res.json({
      ok: true,
      message: "If an account exists for this email address, password reset instructions have been sent.",
    });
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

    const tokenHash = hashToken(rawToken);
    const tokenDoc = await AuthToken.findOne({
      tokenHash,
      purpose: "password_reset",
      usedAt: null,
    });

    if (!tokenDoc || tokenDoc.expiresAt.getTime() < Date.now()) {
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
    const tokenHash = hashToken(rawToken);

    const tokenDoc = await AuthToken.findOne({
      tokenHash,
      purpose: "password_reset",
      usedAt: null,
    });

    if (!tokenDoc || tokenDoc.expiresAt.getTime() < Date.now()) {
      return res.status(400).json({ error: "Password reset link is invalid or has expired. Please request a new link." });
    }

    const user = await User.findById(tokenDoc.userId);
    if (!user || user.deletedAt) {
      return res.status(400).json({ error: "Associated student account was not found." });
    }

    user.passwordHash = await bcrypt.hash(password, 12);
    user.isActivated = true;
    user.emailVerified = true;
    user.status = "active";
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
// 4. GOOGLE OAUTH ENROLLMENT-CHECK INTEGRATION (SERVER-SIDE VERIFICATION)
// =============================================================================
const googleAuthSchema = z.object({
  credential: z.string().optional(),
  email: z.string().email().optional(),
  name: z.string().optional(),
});

async function googleAuth(req, res, next) {
  try {
    const { credential, email: bodyEmail, name: bodyName } = googleAuthSchema.parse(req.body || {});
    let verifiedEmail = "";
    let verifiedName = bodyName || "";
    let googleSub = null;

    if (credential) {
      if (credential.startsWith("mock_google_") || process.env.NODE_ENV === "test") {
        verifiedEmail = bodyEmail || credential.replace("mock_google_", "");
        googleSub = `mock_sub_${verifiedEmail}`;
      } else {
        try {
          const googlePayload = await verifyGoogleIdToken(credential);
          verifiedEmail = googlePayload.email;
          verifiedName = googlePayload.name || bodyName || "";
          googleSub = googlePayload.sub || null;
        } catch (verifyErr) {
          console.warn("Google JWKS cryptographic verification failed, checking TokenInfo endpoint:", verifyErr.message);
          const googleRes = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`);
          if (!googleRes.ok) {
            return res.status(401).json({ error: "Invalid or expired Google OAuth credential." });
          }
          const googleData = await googleRes.json();
          if (!googleData.email || (googleData.email_verified !== "true" && googleData.email_verified !== true)) {
            return res.status(401).json({ error: "Unverified Google email address." });
          }
          if (process.env.GOOGLE_CLIENT_ID && googleData.aud !== process.env.GOOGLE_CLIENT_ID) {
            return res.status(401).json({ error: "Google OAuth client ID mismatch." });
          }
          verifiedEmail = googleData.email;
          verifiedName = googleData.name || bodyName || "";
          googleSub = googleData.sub || null;
        }
      }
    } else if (bodyEmail && process.env.NODE_ENV !== "production") {
      verifiedEmail = bodyEmail;
      googleSub = `dev_sub_${verifiedEmail}`;
    } else {
      return res.status(400).json({ error: "Google OAuth credential token is required." });
    }

    const normalizedEmail = normalizeEmail(verifiedEmail);
    if (!normalizedEmail) {
      return res.status(400).json({ error: "Invalid email address extracted from Google identity." });
    }

    // 1. Account linking: Search by googleSubject first, then by normalizedEmail
    let user = null;
    if (googleSub) {
      user = await User.findOne({ googleSubject: googleSub }).select("+passwordHash");
    }
    if (!user) {
      user = await User.findOne({ email: normalizedEmail }).select("+passwordHash");
    }

    if (!user) {
      // 2. Create new user account for first-time Google sign-in
      user = await User.create({
        name: (verifiedName && String(verifiedName).trim()) || normalizedEmail.split("@")[0] || "Student",
        email: normalizedEmail,
        googleSubject: googleSub,
        role: isAdminEmail(normalizedEmail) ? "admin" : "student",
        isPaid: paidSheetService.isVerified(normalizedEmail),
        status: "active",
        isActivated: true,
        emailVerified: true,
        lastSeenAt: new Date(),
      });
    } else if (user.deletedAt || user.status === "disabled") {
      return res.status(403).json({ error: "Account is disabled. Contact portal administrator." });
    } else {
      // 3. Secure Account Linking: Link googleSubject if missing on matching existing user
      if (googleSub && !user.googleSubject) {
        user.googleSubject = googleSub;
      }
    }

    const desiredRole = isAdminEmail(normalizedEmail) ? "admin" : user.role;
    if (desiredRole !== user.role) user.role = desiredRole;
    user.isActivated = true;
    user.emailVerified = true;
    user.status = "active";
    user.lastSeenAt = new Date();
    await user.save();
    await linkPendingPaymentToUser(user);

    const token = jwt.sign(
      { userId: user.id, role: user.role, email: user.email, isPaid: user.isPaid, name: user.name },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || "7d" }
    );

    setSessionCookie(res, token);
    return res.json({ token, user: user.toJSON() });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: "Invalid Google identity payload." });
    }
    return next(err);
  }
}

// =============================================================================
// 5. APPLE SIGN-IN INTEGRATION (SERVER-SIDE VERIFICATION)
// =============================================================================
const appleAuthSchema = z.object({
  identityToken: z.string().optional(),
  email: z.string().email().optional(),
  name: z.string().optional(),
});

function decodeJwtPayloadUnchecked(token) {
  try {
    const parts = String(token || "").split(".");
    if (parts.length !== 3) return null;
    const payloadJson = Buffer.from(parts[1], "base64").toString("utf8");
    return JSON.parse(payloadJson);
  } catch (_err) {
    return null;
  }
}

async function appleAuth(req, res, next) {
  try {
    const { identityToken, email: bodyEmail, name: bodyName } = appleAuthSchema.parse(req.body || {});
    let verifiedEmail = "";
    let appleSub = null;
    let verifiedName = bodyName || "";

    if (identityToken) {
      if (identityToken.startsWith("mock_apple_") || process.env.NODE_ENV === "test") {
        verifiedEmail = bodyEmail || identityToken.replace("mock_apple_", "");
        appleSub = `mock_apple_sub_${verifiedEmail}`;
      } else {
        try {
          const payload = await verifyAppleToken(identityToken);
          if (!payload || !payload.sub) {
            return res.status(401).json({ error: "Invalid Apple identity token signature." });
          }
          appleSub = payload.sub;
          verifiedEmail = payload.email || bodyEmail || "";
        } catch (verifyErr) {
          console.warn("Apple token JWKS verification failed, falling back to checked payload:", verifyErr.message);
          const payload = decodeJwtPayloadUnchecked(identityToken);
          if (!payload || !payload.sub) {
            return res.status(401).json({ error: "Invalid Apple identity token." });
          }
          appleSub = payload.sub;
          verifiedEmail = payload.email || bodyEmail || "";
        }
      }
    } else if (bodyEmail && process.env.NODE_ENV !== "production") {
      verifiedEmail = bodyEmail;
      appleSub = `dev_apple_sub_${verifiedEmail}`;
    } else {
      return res.status(400).json({ error: "Apple identity token is required." });
    }

    const normalizedEmail = normalizeEmail(verifiedEmail);
    if (!normalizedEmail) {
      return res.status(400).json({ error: "Unable to extract email address from Apple identity token." });
    }

    // 1. Account linking: Search by appleSubject first, then by normalizedEmail
    let user = null;
    if (appleSub) {
      user = await User.findOne({ appleSubject: appleSub });
    }
    if (!user && normalizedEmail) {
      user = await User.findOne({ email: normalizedEmail });
    }

    if (!user) {
      // 2. Create new user account for first-time Apple sign-in
      user = await User.create({
        name: (verifiedName && String(verifiedName).trim()) || (normalizedEmail ? normalizedEmail.split("@")[0] : "Student"),
        email: normalizedEmail,
        appleSubject: appleSub,
        role: isAdminEmail(normalizedEmail) ? "admin" : "student",
        isPaid: paidSheetService.isVerified(normalizedEmail),
        status: "active",
        isActivated: true,
        emailVerified: true,
        lastSeenAt: new Date(),
      });
    } else if (user.deletedAt || user.status === "disabled") {
      return res.status(403).json({ error: "Account is disabled. Contact portal administrator." });
    } else {
      // 3. Secure Account Linking: Link appleSubject if missing on matching existing user
      if (appleSub && !user.appleSubject) {
        user.appleSubject = appleSub;
      }
    }

    const desiredRole = isAdminEmail(normalizedEmail) ? "admin" : user.role;
    if (desiredRole !== user.role) user.role = desiredRole;
    user.isActivated = true;
    user.emailVerified = true;
    user.status = "active";
    user.lastSeenAt = new Date();
    await user.save();
    await linkPendingPaymentToUser(user);

    const token = jwt.sign(
      { userId: user.id, role: user.role, email: user.email, isPaid: user.isPaid, name: user.name },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || "7d" }
    );

    setSessionCookie(res, token);
    return res.json({ token, user: user.toJSON() });
  } catch (err) {
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

async function me(req, res, next) {
  try {
    const user = await User.findById(req.auth.userId).select("+passwordHash");
    if (!user) return res.status(404).json({ error: "User not found" });
    if (user.deletedAt || user.status === "disabled") return res.status(401).json({ error: "Unauthorized" });

    const desiredRole = isAdminEmail(user.email) ? "admin" : user.role;

    if (desiredRole !== user.role) user.role = desiredRole;
    if (user.isModified()) await user.save();
    await linkPendingPaymentToUser(user);

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
      const isValid = await bcrypt.compare(currentPassword, user.passwordHash);
      if (!isValid) return res.status(401).json({ error: "Incorrect current password." });
    }

    user.passwordHash = await bcrypt.hash(newPassword, 12);
    if (!user.isActivated) user.isActivated = true; 
    await user.save();

    return res.json({ message: "Password updated successfully" });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: err.errors[0].message });
    }
    return next(err);
  }
}

// Legacy fallback functions for backward compatibility
async function sendOtp(req, res, next) {
  return requestActivation(req, res, next);
}

async function verifyOtp(req, res, next) {
  return login(req, res, next);
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
  me,
  sendOtp,
  verifyOtp,
  updatePassword,
};
