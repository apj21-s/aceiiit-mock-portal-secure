const mongoose = require("mongoose");

// Server-authoritative exam session. The browser timer is display-only; deadlines,
// section locking, saved answers and finalization all live here.
const attemptSessionSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    testId: { type: mongoose.Schema.Types.ObjectId, ref: "Test", required: true, index: true },
    seasonId: { type: mongoose.Schema.Types.ObjectId, ref: "Season", default: null },
    isPractice: { type: Boolean, default: false },
    userRole: { type: String, default: "student" },
    userEmail: { type: String, default: "" },

    startedAt: { type: Date, required: true },
    suprDurationMs: { type: Number, required: true },
    reapDurationMs: { type: Number, required: true },
    // Set when the student submits SUPR early; otherwise REAP starts at the SUPR deadline.
    reapStartedAt: { type: Date, default: null },
    suprLockedAt: { type: Date, default: null },

    status: {
      type: String,
      enum: ["active", "finalizing", "submitted", "expired"],
      default: "active",
      index: true,
    },

    // Session binding: only the hash of the exam token is stored.
    examTokenHash: { type: String, required: true },
    tokenRotatedAt: { type: Date, default: null },
    // Telemetry only; never a security boundary.
    fingerprint: {
      userAgentHash: { type: String, default: "" },
      ipPrefix: { type: String, default: "" },
    },

    // Server autosave (authoritative answers at finalization).
    answers: { type: Map, of: Number, default: {} },
    timeSpent: { type: Map, of: Number, default: {} },
    marked: { type: [String], default: [] },
    visited: { type: [String], default: [] },
    currentQuestionId: { type: String, default: "" },
    lastSeq: { type: Number, default: 0 },
    lastSavedAt: { type: Date, default: null },

    // Per-session shuffle (copied from the test at start).
    shuffleSeed: { type: String, default: "" },
    shuffleQuestions: { type: Boolean, default: false },
    shuffleOptions: { type: Boolean, default: false },

    // Integrity policy snapshot + server-side violation count (never lowered by the client).
    integrity: {
      mode: { type: String, enum: ["record", "warn", "strict"], default: "warn" },
      warnThreshold: { type: Number, default: 1 },
      autoSubmitThreshold: { type: Number, default: 5 },
      violations: { type: Number, default: 0 },
      byType: { type: Map, of: Number, default: {} },
      lastCountedAt: { type: Map, of: Date, default: {} },
      takeovers: { type: Number, default: 0 },
    },

    finalizingAt: { type: Date, default: null },
    finalizedAt: { type: Date, default: null },
    submittedReason: {
      type: String,
      enum: ["", "submitted", "deadline_expired", "abandoned", "integrity_threshold"],
      default: "",
    },
    attemptId: { type: mongoose.Schema.Types.ObjectId, ref: "Attempt", default: null },
  },
  { timestamps: true }
);

// One active session per user per test, enforced by the database (not application logic).
attemptSessionSchema.index(
  { userId: 1, testId: 1 },
  { unique: true, partialFilterExpression: { status: "active" }, name: "one_active_session_per_user_test" }
);
attemptSessionSchema.index({ status: 1, startedAt: 1 });

module.exports = mongoose.model("AttemptSession", attemptSessionSchema);
