const mongoose = require("mongoose");

const appConfigSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, default: "global" },
    ugeeExamDate: { type: Date, default: null },
    featuredTestId: { type: mongoose.Schema.Types.ObjectId, ref: "Test", default: null },
    noticeTitle: { type: String, trim: true, maxlength: 120, default: "" },
    noticeBody: { type: String, trim: true, maxlength: 2000, default: "" },
    // ACEIIIT Mentor (admin Studio → Setup). Defaults live in services/mentorSettingsService.js.
    mentor: {
      enabled: { type: Boolean, default: true },
      freeMonthlyReplies: { type: Number, default: 10, min: 0, max: 1000 },
      enrolledMonthlyReplies: { type: Number, default: 100, min: 0, max: 10000 },
      // Site entitlement / portal payment resource codes that count as programme enrolment.
      programCodes: { type: [String], default: [] },
      programUrl: { type: String, trim: true, maxlength: 300, default: "" },
      dailyGlobalReplies: { type: Number, default: 1000, min: 0, max: 1000000 },
      maxInputChars: { type: Number, default: 2000, min: 200, max: 8000 },
      maxOutputTokens: { type: Number, default: 900, min: 200, max: 4000 },
    },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

appConfigSchema.set("toJSON", {
  transform: (_doc, ret) => {
    ret.id = String(ret._id);
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

module.exports = mongoose.model("AppConfig", appConfigSchema);
