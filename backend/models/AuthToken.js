const mongoose = require("mongoose");

const authTokenSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    email: { type: String, required: true, lowercase: true, trim: true, index: true },
    tokenHash: { type: String, required: true, index: true },
    purpose: { type: String, enum: ["activation", "password_reset"], required: true, index: true },
    expiresAt: { type: Date, required: true },
    usedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// TTL index: MongoDB automatically purges token documents after expiresAt
authTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

// Compound indexes for high-concurrency token verification & invalidation queries
authTokenSchema.index({ tokenHash: 1, purpose: 1, usedAt: 1 });
authTokenSchema.index({ email: 1, purpose: 1 });

module.exports = mongoose.model("AuthToken", authTokenSchema);
