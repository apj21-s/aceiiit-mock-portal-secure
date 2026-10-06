const mongoose = require("mongoose");

const entitlementSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null, index: true },
    email: { type: String, required: true, trim: true },
    normalizedEmail: { type: String, required: true, lowercase: true, trim: true, index: true },
    seasonId: { type: mongoose.Schema.Types.ObjectId, ref: "Season", required: true, index: true },
    tier: {
      type: String,
      enum: ["free", "paid", "premium"],
      default: "paid",
      index: true,
    },
    status: {
      type: String,
      enum: ["active", "revoked", "expired"],
      default: "active",
      index: true,
    },
    source: {
      type: String,
      enum: ["payment", "admin", "promotion"],
      default: "payment",
    },
    paymentId: { type: mongoose.Schema.Types.ObjectId, ref: "PaymentRecord", default: null },
    grantedAt: { type: Date, default: Date.now },
    revokedAt: { type: Date, default: null },
    expiresAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// Compound unique index per season per normalized email
entitlementSchema.index({ seasonId: 1, normalizedEmail: 1 }, { unique: true });
entitlementSchema.index({ userId: 1, seasonId: 1, status: 1 });

entitlementSchema.set("toJSON", {
  transform: (_doc, ret) => {
    ret.id = String(ret._id);
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

module.exports = mongoose.model("Entitlement", entitlementSchema);
