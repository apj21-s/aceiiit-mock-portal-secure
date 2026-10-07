const mongoose = require("mongoose");

const testSchema = new mongoose.Schema(
  {
    seasonId: { type: mongoose.Schema.Types.ObjectId, ref: "Season", default: null, index: true },
    title: { type: String, required: true, trim: true, maxlength: 120 },
    subtitle: { type: String, default: "", trim: true, maxlength: 160 },
    series: { type: String, default: "UGEE 2026", index: true },
    type: { type: String, enum: ["practice", "scheduled"], default: "practice", index: true },
    isFree: { type: Boolean, default: false, index: true },
    // "practice" tests are private, student-generated papers; never listed in the catalog.
    status: { type: String, enum: ["draft", "live", "practice"], default: "draft", index: true },
    isPractice: { type: Boolean, default: false },
    ownerUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null, index: true },
    displayOrder: { type: Number, default: 100, index: true },
    durationMinutes: { type: Number, default: 180 },
    sectionDurations: {
      SUPR: { type: Number, default: 60 },
      REAP: { type: Number, default: 120 },
    },
    instructions: { type: [String], default: [] },
    benchmarkScores: { type: [Number], default: [] },
    totalMarks: { type: Number, default: 0 },
    negativeMarks: { type: Number, default: -1 },
    // Per-session seeded shuffling; answers are mapped back to the original order server-side.
    shuffleQuestions: { type: Boolean, default: false },
    shuffleOptions: { type: Boolean, default: false },
    // Exam-integrity policy. Browser signals are telemetry; no mode ever auto-disqualifies.
    integrity: {
      mode: { type: String, enum: ["record", "warn", "strict"], default: "warn" },
      warnThreshold: { type: Number, default: 1, min: 1, max: 100 },
      autoSubmitThreshold: { type: Number, default: 5, min: 1, max: 100 },
    },
    questionIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "Question", default: [] }],
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// TTL: deleted tests are permanently removed 30 days after being moved to trash.
testSchema.index({ deletedAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 30 });
testSchema.index({ status: 1, deletedAt: 1, displayOrder: 1, createdAt: 1 });
testSchema.index({ seasonId: 1, status: 1, deletedAt: 1 });

testSchema.set("toJSON", {
  transform: (_doc, ret) => {
    ret.id = String(ret._id);
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

module.exports = mongoose.model("Test", testSchema);
