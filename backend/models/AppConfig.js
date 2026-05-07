const mongoose = require("mongoose");

const appConfigSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, default: "global" },
    ugeeExamDate: { type: Date, default: null },
    featuredTestId: { type: mongoose.Schema.Types.ObjectId, ref: "Test", default: null },
    noticeTitle: { type: String, trim: true, maxlength: 120, default: "" },
    noticeBody: { type: String, trim: true, maxlength: 2000, default: "" },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

appConfigSchema.set("toJSON", {
  transform: (_doc, ret) => {
    ret.id = String(ret._id);
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

module.exports = mongoose.model("AppConfig", appConfigSchema);
