const mongoose = require("mongoose");

const attemptSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    userEmail: { type: String, default: "", index: true },
    userRole: { type: String, default: "student", index: true },
    testId: { type: mongoose.Schema.Types.ObjectId, ref: "Test", required: true, index: true },
    attemptNumber: { type: Number, required: true, index: true },
    answers: { type: Map, of: Number, default: {} },
    answerDetails: { type: [mongoose.Schema.Types.Mixed], default: [] },
    score: { type: Number, default: 0, index: true },
    accuracy: { type: Number, default: 0 },
    correctCount: { type: Number, default: 0 },
    wrongCount: { type: Number, default: 0 },
    skippedCount: { type: Number, default: 0 },
    unattemptedCount: { type: Number, default: 0 },
    rank: { type: Number, default: 0 },
    percentile: { type: Number, default: 0 },
    timeTakenSeconds: { type: Number, default: 0 },
    totalTime: { type: Number, default: 0 },
    submittedAt: { type: Date, default: Date.now, index: true },
    analysis: { type: mongoose.Schema.Types.Mixed, default: null },
    topicWise: { type: [mongoose.Schema.Types.Mixed], default: [] },
    questionReview: { type: [mongoose.Schema.Types.Mixed], default: [] },
    sectionScores: {
      SUPR: {
        score: { type: Number, default: 0 },
        correct: { type: Number, default: 0 },
        wrong: { type: Number, default: 0 },
        skipped: { type: Number, default: 0 },
      },
      REAP: {
        score: { type: Number, default: 0 },
        correct: { type: Number, default: 0 },
        wrong: { type: Number, default: 0 },
        skipped: { type: Number, default: 0 },
      },
    },
    sectionWise: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { timestamps: true }
);

attemptSchema.index({ userId: 1, submittedAt: -1 });
attemptSchema.index({ userId: 1, testId: 1, submittedAt: -1 });
attemptSchema.index({ userId: 1, testId: 1, attemptNumber: 1 }, { unique: true });
attemptSchema.index({ testId: 1, score: -1 });
attemptSchema.index({ testId: 1, userEmail: 1 });
attemptSchema.index({ testId: 1, attemptNumber: 1, score: -1, timeTakenSeconds: 1, submittedAt: 1 });

attemptSchema.set("toJSON", {
  transform: (_doc, ret) => {
    ret.id = String(ret._id);
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

module.exports = mongoose.model("Attempt", attemptSchema);
