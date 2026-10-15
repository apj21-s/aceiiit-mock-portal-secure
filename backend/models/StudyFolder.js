const mongoose = require("mongoose");

// Study material folders (Resources → Study material). Free for every signed-in student.
const studyFolderSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 80 },
    icon: { type: String, default: "📁", trim: true, maxlength: 8 },
    color: { type: String, default: "", trim: true, maxlength: 40 },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model("StudyFolder", studyFolderSchema);
