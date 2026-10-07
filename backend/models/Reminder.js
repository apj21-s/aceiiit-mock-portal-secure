const mongoose = require("mongoose");

const reminderSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    email: { type: String, required: true, lowercase: true, trim: true, index: true },
    title: { type: String, required: true, trim: true, maxlength: 140 },
    testId: { type: mongoose.Schema.Types.ObjectId, ref: "Test", default: null, index: true },
    plannedAt: { type: Date, required: true, index: true },
    remindAt: { type: Date, required: true, index: true },
    reminderMinutes: { type: Number, default: 300, min: 10, max: 7 * 24 * 60 },
    subjectFocus: [{ type: String, trim: true, maxlength: 40 }],
    notes: { type: String, trim: true, maxlength: 500, default: "" },
    // Scheduled reminder email delivery (the "starts in X" email before the plan).
    deliveryState: {
      type: String,
      enum: ["pending", "sending", "sent", "failed", "cancelled"],
      default: "pending",
      index: true,
    },
    attempts: { type: Number, default: 0 },
    nextAttemptAt: { type: Date, default: null },
    claimedAt: { type: Date, default: null },
    sentAt: { type: Date, default: null, index: true },
    failedAt: { type: Date, default: null },
    failureReason: { type: String, default: "" },
    cancelledAt: { type: Date, default: null, index: true },
    // Calendar invite (ICS) email: tracked separately so it never marks the reminder as sent.
    inviteSentAt: { type: Date, default: null },
    inviteError: { type: String, default: "" },
    sequence: { type: Number, default: 0 },
  },
  { timestamps: true }
);

reminderSchema.index({ remindAt: 1, sentAt: 1, cancelledAt: 1 });
reminderSchema.index({ deliveryState: 1, remindAt: 1, nextAttemptAt: 1 });

reminderSchema.set("toJSON", {
  transform: (_doc, ret) => {
    ret.id = String(ret._id);
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

module.exports = mongoose.model("Reminder", reminderSchema);
