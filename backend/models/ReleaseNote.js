const mongoose = require("mongoose");

// "What's new" notes: written and published from Studio, shown once to each student as a
// pop-up the first time they open the portal after it is published.
const itemSchema = new mongoose.Schema(
  {
    icon: { type: String, trim: true, maxlength: 16, default: "" },
    title: { type: String, trim: true, required: true, maxlength: 60 },
    body: { type: String, trim: true, maxlength: 240, default: "" },
  },
  { _id: false }
);

const releaseNoteSchema = new mongoose.Schema(
  {
    title: { type: String, trim: true, required: true, maxlength: 80 },
    summary: { type: String, trim: true, maxlength: 280, default: "" },
    items: { type: [itemSchema], default: [] },
    imageUrl: { type: String, trim: true, maxlength: 500, default: "" },
    ctaLabel: { type: String, trim: true, maxlength: 30, default: "" },
    ctaHref: { type: String, trim: true, maxlength: 300, default: "" },
    audience: { type: String, enum: ["all", "free", "paid"], default: "all" },
    status: { type: String, enum: ["draft", "published"], default: "draft" },
    publishedAt: { type: Date, default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

releaseNoteSchema.index({ status: 1, publishedAt: -1 });

module.exports = mongoose.model("ReleaseNote", releaseNoteSchema);
