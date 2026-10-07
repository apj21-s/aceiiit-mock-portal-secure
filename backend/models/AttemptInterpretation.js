const mongoose = require("mongoose");

// AI (or deterministic fallback) interpretation of an attempt. Deliberately isolated from
// Attempt: the AI layer has no write path to scores, ranks, timing or correctness.
const attemptInterpretationSchema = new mongoose.Schema(
  {
    attemptId: { type: mongoose.Schema.Types.ObjectId, ref: "Attempt", required: true, unique: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    status: { type: String, enum: ["pending", "processing", "ready", "fallback"], default: "pending", index: true },
    provider: { type: String, enum: ["gemini", "deterministic"], default: "deterministic" },
    model: { type: String, default: "" },
    payloadVersion: { type: Number, default: 1 },
    payloadHash: { type: String, default: "" },
    result: { type: mongoose.Schema.Types.Mixed, default: null },
    deterministic: { type: mongoose.Schema.Types.Mixed, default: null },
    fallbackReason: { type: String, default: "" },
    attemptCount: { type: Number, default: 0 },
    retryAfter: { type: Date, default: null },
    claimedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    expiresAt: { type: Date, default: () => new Date(Date.now() + 365 * 24 * 60 * 60 * 1000) },
  },
  { timestamps: true }
);

attemptInterpretationSchema.index({ status: 1, retryAfter: 1, createdAt: 1 });
attemptInterpretationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model("AttemptInterpretation", attemptInterpretationSchema);
