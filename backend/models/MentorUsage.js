const mongoose = require("mongoose");

// Mentor replies per student per calendar month (Asia/Kolkata), e.g. period "2026-10".
// `used` counts successful replies; `reservations` hold in-flight requests so concurrent sends
// can never exceed the allowance (used + reservations ≤ limit). A reservation is settled
// (→ used + 1) only when a reply is stored, released on failure, and dropped if abandoned.
const mentorUsageSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    period: { type: String, required: true },
    used: { type: Number, default: 0, min: 0 },
    reservations: {
      type: [{ _id: false, key: { type: String, required: true }, at: { type: Date, required: true } }],
      default: [],
    },
  },
  { timestamps: true }
);

mentorUsageSchema.index({ userId: 1, period: 1 }, { unique: true });
mentorUsageSchema.index({ period: 1 });

module.exports = mongoose.model("MentorUsage", mentorUsageSchema);
