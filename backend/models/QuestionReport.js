const mongoose = require("mongoose");

// A student's "Report a problem" on a question from their own review (wrong answer key, typo,
// broken maths...). Admins work through them in Studio → Reports.
const questionReportSchema = new mongoose.Schema(
  {
    questionId: { type: mongoose.Schema.Types.ObjectId, ref: "Question", required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    attemptId: { type: mongoose.Schema.Types.ObjectId, ref: "Attempt", required: true },
    reason: { type: String, enum: ["wrong_answer", "typo", "maths", "image", "other"], required: true },
    note: { type: String, trim: true, maxlength: 500, default: "" },
    status: { type: String, enum: ["open", "resolved"], default: "open" },
    resolvedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    resolvedAt: { type: Date, default: null },
    resolutionNote: { type: String, trim: true, maxlength: 300, default: "" },
  },
  { timestamps: true }
);

questionReportSchema.index({ status: 1, questionId: 1, createdAt: -1 });
// One open report per student per question (a second report updates it).
questionReportSchema.index({ userId: 1, questionId: 1 }, { unique: true, partialFilterExpression: { status: "open" } });

module.exports = mongoose.model("QuestionReport", questionReportSchema);
