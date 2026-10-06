const mongoose = require("mongoose");

const googleCalendarEventSchema = new mongoose.Schema(
  {
    reminderId: { type: mongoose.Schema.Types.ObjectId, ref: "Reminder", required: true, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    googleEventId: { type: String, required: true },
    syncStatus: { type: String, enum: ["synced", "pending", "failed"], default: "synced", index: true },
    lastSyncedAt: { type: Date, default: Date.now },
    lastError: { type: String, default: "" },
  },
  { timestamps: true }
);

// A reminder can only have one active Google event mapping
googleCalendarEventSchema.index({ reminderId: 1 }, { unique: true });

googleCalendarEventSchema.set("toJSON", {
  transform: (_doc, ret) => {
    ret.id = String(ret._id);
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

module.exports = mongoose.model("GoogleCalendarEvent", googleCalendarEventSchema);
