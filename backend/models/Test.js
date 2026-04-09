const mongoose = require("mongoose");

const testSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 120 },
    subtitle: { type: String, default: "", trim: true, maxlength: 160 },
    series: { type: String, default: "UGEE 2026", index: true },
    type: { type: String, enum: ["practice", "scheduled"], default: "practice", index: true },
    isFree: { type: Boolean, default: false, index: true },
    status: { type: String, enum: ["draft", "live"], default: "draft", index: true },
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
    questionIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "Question", default: [] }],
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// TTL: deleted tests are permanently removed 30 days after being moved to trash.
testSchema.index({ deletedAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 30 });
testSchema.index({ status: 1, deletedAt: 1, displayOrder: 1, createdAt: 1 });

testSchema.set("toJSON", {
  transform: (_doc, ret) => {
    ret.id = String(ret._id);
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

module.exports = mongoose.model("Test", testSchema);
