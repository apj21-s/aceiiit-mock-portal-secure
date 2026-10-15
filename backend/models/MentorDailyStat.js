const mongoose = require("mongoose");

// Aggregate mentor activity per day (Asia/Kolkata), with no chat content: backs the global
// daily reply cap and the Studio's usage numbers.
const mentorDailyStatSchema = new mongoose.Schema(
  {
    day: { type: String, required: true },
    replies: { type: Number, default: 0, min: 0 },
    failures: { type: Number, default: 0, min: 0 },
    inputChars: { type: Number, default: 0, min: 0 },
    outputChars: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true }
);

mentorDailyStatSchema.index({ day: 1 }, { unique: true });

module.exports = mongoose.model("MentorDailyStat", mentorDailyStatSchema);
