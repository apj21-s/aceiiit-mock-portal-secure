const crypto = require("crypto");
const express = require("express");
const rateLimit = require("express-rate-limit");
const { z } = require("zod");

const { provisionFromCommerce, revokeFromCommerce } = require("../services/paymentSyncService");

// Server-to-server API for the AceIIIT commerce backend. Authenticated by a shared secret
// (INTERNAL_API_SECRET, required in production); exempt from browser CSRF.
const router = express.Router();

router.use(
  rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many internal requests." },
  })
);

function secretsMatch(provided, expected) {
  // Hash both sides so the comparison is constant-time and length-safe.
  const a = crypto.createHash("sha256").update(String(provided || "")).digest();
  const b = crypto.createHash("sha256").update(String(expected || "")).digest();
  return crypto.timingSafeEqual(a, b);
}

function requireInternalSecret(req, res, next) {
  const expected = String(process.env.INTERNAL_API_SECRET || "");
  const provided = req.get("x-internal-api-secret");
  // No default secret: an unset secret means the internal API is closed.
  if (!expected || !provided || !secretsMatch(provided, expected)) {
    return res.status(401).json({ error: "Unauthorized internal access" });
  }
  return next();
}

const accessSchema = z.object({
  commerceUserId: z.string().trim().min(1).max(128),
  email: z.string().trim().email().max(254),
  resourceCode: z.string().trim().regex(/^[A-Z0-9_]{2,64}$/, "resourceCode must be UPPER_SNAKE_CASE"),
  entitlementId: z.string().trim().min(1).max(128),
  idempotencyKey: z.string().trim().min(8).max(128),
});

function parseBody(req, res) {
  const parsed = accessSchema.safeParse(req.body || {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0].message, code: "INVALID_BODY" });
    return null;
  }
  return parsed.data;
}

router.post("/access/provision", requireInternalSecret, async (req, res, next) => {
  const input = parseBody(req, res);
  if (!input) return undefined;
  try {
    const { entitlement, payment, season, replay } = await provisionFromCommerce(input);
    return res.json({
      success: true,
      replay,
      entitlement: {
        id: String(entitlement._id),
        status: entitlement.status,
        seasonId: String(season._id),
        email: entitlement.normalizedEmail,
      },
      paymentRecordId: String(payment._id),
      mockUserId: entitlement.userId ? String(entitlement.userId) : null,
    });
  } catch (err) {
    return next(err);
  }
});

router.post("/access/revoke", requireInternalSecret, async (req, res, next) => {
  const input = parseBody(req, res);
  if (!input) return undefined;
  try {
    const { entitlement, season } = await revokeFromCommerce(input);
    return res.json({
      success: true,
      entitlement: entitlement
        ? { id: String(entitlement._id), status: entitlement.status, seasonId: String(season._id) }
        : null,
    });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
