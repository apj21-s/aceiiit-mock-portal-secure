const Attempt = require("../models/Attempt");
const { getInterpretationForAttempt, breakerState } = require("../services/aiInterpretationService");
const { buildPerformanceProfile } = require("../services/performanceProfileService");

// Read-only endpoints for Performance Intelligence. This is the only controller that
// touches AI interpretations; scoring, ranking, payments and integrity code never do.

const AI_DISCLOSURE =
  "ACEIIIT may use an external AI service to interpret structured performance evidence. AI does not calculate or alter scores.";

async function getInterpretation(req, res, next) {
  try {
    const query = req.auth.role === "admin" ? { _id: req.params.id } : { _id: req.params.id, userId: req.auth.userId };
    const attempt = await Attempt.findOne(query).lean();
    if (!attempt) return res.status(404).json({ error: "Analysis not found" });
    const [doc, profile] = await Promise.all([getInterpretationForAttempt(attempt), buildPerformanceProfile(attempt)]);
    const pending = doc.status === "pending" || doc.status === "processing";
    return res.json({
      interpretation: {
        status: doc.status,
        source: doc.status === "ready" ? "ai" : "deterministic",
        // While AI is pending (or unavailable), the deterministic interpretation is shown.
        result: doc.status === "ready" && doc.result ? doc.result : doc.deterministic,
        deterministic: doc.deterministic,
        pending,
        fallbackReason: doc.fallbackReason || "",
        model: doc.status === "ready" ? doc.model : "",
        disclosure: AI_DISCLOSURE,
        // Deterministic longitudinal context (verified, not AI).
        profile,
      },
    });
  } catch (err) {
    return next(err);
  }
}

async function getAiStatus(_req, res) {
  return res.json({
    enabled: String(process.env.AI_INTERPRETATION_ENABLED || "").toLowerCase() === "true",
    configured: Boolean(process.env.GEMINI_API_KEY),
    model: process.env.GEMINI_MODEL || "gemini-3.5-flash-lite",
    breaker: breakerState(),
  });
}

module.exports = { getInterpretation, getAiStatus, AI_DISCLOSURE };
