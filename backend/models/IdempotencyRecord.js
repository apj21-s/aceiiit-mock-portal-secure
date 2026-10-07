const mongoose = require("mongoose");

// Stored responses for idempotent operations, scoped to user + operation + client key.
const idempotencyRecordSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    operation: { type: String, required: true },
    key: { type: String, required: true },
    requestHash: { type: String, default: "" },
    status: { type: String, enum: ["pending", "completed"], default: "pending" },
    responseStatus: { type: Number, default: 0 },
    responseBody: { type: mongoose.Schema.Types.Mixed, default: null },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true }
);

idempotencyRecordSchema.index({ userId: 1, operation: 1, key: 1 }, { unique: true });
idempotencyRecordSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model("IdempotencyRecord", idempotencyRecordSchema);
