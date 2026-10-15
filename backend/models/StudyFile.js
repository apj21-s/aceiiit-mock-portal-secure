const mongoose = require("mongoose");

// A study material file. The bytes live in Cloudinary as an "authenticated" (non-public)
// asset; students reach it only through GET /api/materials/files/:id/download, which hands
// out a short-lived signed link. publicId never leaves the server.
const studyFileSchema = new mongoose.Schema(
  {
    folderId: { type: mongoose.Schema.Types.ObjectId, ref: "StudyFolder", required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 160 },
    mimeType: { type: String, default: "", trim: true, maxlength: 120 },
    bytes: { type: Number, default: 0, min: 0 },
    format: { type: String, default: "", trim: true, maxlength: 16 },
    publicId: { type: String, required: true, trim: true, maxlength: 300 },
    resourceType: { type: String, enum: ["image", "raw"], required: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

studyFileSchema.index({ folderId: 1, name: 1 });

module.exports = mongoose.model("StudyFile", studyFileSchema);
