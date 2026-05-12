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
    sentAt: { type: Date, default: null, index: true },
    cancelledAt: { type: Date, default: null, index: true },
    failureReason: { type: String, default: "" },
  },
  { timestamps: true }
);

reminderSchema.index({ remindAt: 1, sentAt: 1, cancelledAt: 1 });

reminderSchema.set("toJSON", {
  transform: (_doc, ret) => {
    ret.id = String(ret._id);
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

module.exports = mongoose.model("Reminder", reminderSchema);
