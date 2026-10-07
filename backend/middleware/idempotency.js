const crypto = require("crypto");

const IdempotencyRecord = require("../models/IdempotencyRecord");

const KEY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const TTL_MS = 24 * 60 * 60 * 1000;

function requestHash(req) {
  const scope = JSON.stringify({ path: req.baseUrl + req.path, sessionId: (req.body && req.body.sessionId) || "" });
  return crypto.createHash("sha256").update(scope).digest("hex");
}

/**
 * Replays the stored response for a repeated `Idempotency-Key`, scoped to
 * user + operation + key. A key reused for a different request returns 422.
 */
function idempotent(operation, { required = true } = {}) {
  return async function idempotencyMiddleware(req, res, next) {
    const key = req.get("Idempotency-Key");
    if (!key) {
      if (required) return res.status(400).json({ error: "Idempotency-Key header is required.", code: "IDEMPOTENCY_KEY_REQUIRED" });
      return next();
    }
    if (!KEY_PATTERN.test(key)) {
      return res.status(400).json({ error: "Invalid Idempotency-Key header.", code: "IDEMPOTENCY_KEY_INVALID" });
    }
    const scope = { userId: req.auth.userId, operation, key };
    const hash = requestHash(req);
    try {
      await IdempotencyRecord.create({ ...scope, requestHash: hash, expiresAt: new Date(Date.now() + TTL_MS) });
    } catch (err) {
      if (!err || err.code !== 11000) return next(err);
      const existing = await IdempotencyRecord.findOne(scope).lean();
      if (existing && existing.requestHash !== hash) {
        return res.status(422).json({ error: "Idempotency-Key was already used for a different request.", code: "IDEMPOTENCY_KEY_REUSED" });
      }
      if (existing && existing.status === "completed") {
        res.set("Idempotent-Replay", "true");
        return res.status(existing.responseStatus).json(existing.responseBody);
      }
      return res.status(409).json({ error: "This request is still being processed. Please retry shortly.", code: "IDEMPOTENCY_IN_PROGRESS" });
    }

    const originalJson = res.json.bind(res);
    res.json = function storeAndSend(body) {
      const status = res.statusCode;
      const write = status < 500
        ? IdempotencyRecord.updateOne(scope, { $set: { status: "completed", responseStatus: status, responseBody: body } })
        : IdempotencyRecord.deleteOne(scope);
      write.catch(() => {});
      return originalJson(body);
    };
    return next();
  };
}

module.exports = { idempotent };
