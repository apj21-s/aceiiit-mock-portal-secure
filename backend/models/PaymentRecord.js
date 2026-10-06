const mongoose = require("mongoose");

const paymentRecordSchema = new mongoose.Schema(
  {
    seasonId: { type: mongoose.Schema.Types.ObjectId, ref: "Season", required: true, index: true },
    email: { type: String, required: true, trim: true },
    normalizedEmail: { type: String, required: true, lowercase: true, trim: true, index: true },
    name: { type: String, default: "", trim: true, maxlength: 120 },
    status: {
      type: String,
      enum: ["pending", "verified", "revoked", "refunded"],
      default: "pending",
      index: true,
    },
    source: {
      type: String,
      enum: ["google_sheet", "admin"],
      default: "google_sheet",
      index: true,
    },
    sourceRecordId: { type: String, default: "", trim: true },
    rawPayload: { type: mongoose.Schema.Types.Mixed, default: null },
    verifiedAt: { type: Date, default: null },
    revokedAt: { type: Date, default: null },
    confirmationEmailSentAt: { type: Date, default: null },
    verifiedByUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

// Compound unique index per season per normalized email
paymentRecordSchema.index({ seasonId: 1, normalizedEmail: 1 }, { unique: true });
paymentRecordSchema.index({ status: 1, seasonId: 1 });

paymentRecordSchema.set("toJSON", {
  transform: (_doc, ret) => {
    ret.id = String(ret._id);
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

module.exports = mongoose.model("PaymentRecord", paymentRecordSchema);
