const mongoose = require("mongoose");

const googleCalendarConnectionSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, unique: true, index: true },
    googleAccountId: { type: String, required: true }, // The Google 'sub' claim
    refreshToken: { type: String, required: true }, // Encrypting this at rest would be ideal
    tokenExpiry: { type: Date, default: null }, // Optional cache for access token expiry
    autoAddEnabled: { type: Boolean, default: true },
    status: { type: String, enum: ["connected", "revoked", "error", "disconnected"], default: "connected", index: true },
  },
  { timestamps: true }
);

googleCalendarConnectionSchema.set("toJSON", {
  transform: (_doc, ret) => {
    ret.id = String(ret._id);
    delete ret._id;
    delete ret.__v;
    delete ret.refreshToken; // NEVER expose refresh token to the client
    return ret;
  },
});

module.exports = mongoose.model("GoogleCalendarConnection", googleCalendarConnectionSchema);
