const mongoose = require("mongoose");

const seasonSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 80 },
    examName: { type: String, required: true, trim: true, default: "UGEE", maxlength: 40 },
    year: { type: Number, required: true, index: true },
    status: {
      type: String,
      enum: ["draft", "active", "archived"],
      default: "draft",
      index: true,
    },
    isDefaultActive: { type: Boolean, default: false, index: true },
    // Commerce product resource code (e.g. "PAID_MOCK_SERIES") provisioned into this season.
    resourceCode: { type: String, trim: true, default: "", index: true },
    startDate: { type: Date, default: null },
    endDate: { type: Date, default: null },
    createdById: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

seasonSchema.index({ status: 1, isDefaultActive: 1 });

seasonSchema.set("toJSON", {
  transform: (_doc, ret) => {
    ret.id = String(ret._id);
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

module.exports = mongoose.model("Season", seasonSchema);
