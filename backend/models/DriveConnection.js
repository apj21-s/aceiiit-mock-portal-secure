const mongoose = require("mongoose");

// The Google Drive that holds the study materials (one per portal). Connected by an admin in
// Studio → Study Materials. The refresh token is encrypted at rest (utils/crypto.js) and never
// leaves the server; students reach files only through the portal's own endpoints.
const driveConnectionSchema = new mongoose.Schema(
  {
    key: { type: String, default: "materials", unique: true },
    refreshToken: { type: String, required: true },
    accountEmail: { type: String, default: "", trim: true, maxlength: 254 },
    rootFolderId: { type: String, required: true, trim: true, maxlength: 128 },
    rootFolderName: { type: String, default: "", trim: true, maxlength: 200 },
    connectedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    connectedAt: { type: Date, default: Date.now },
    status: { type: String, enum: ["connected", "needs_reconnect"], default: "connected" },
  },
  { timestamps: true }
);

module.exports = mongoose.model("DriveConnection", driveConnectionSchema);
