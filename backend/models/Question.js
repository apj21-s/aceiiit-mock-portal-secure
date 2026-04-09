const mongoose = require("mongoose");

const questionSchema = new mongoose.Schema(
  {
    section: { type: String, enum: ["REAP", "SUPR"], required: true, index: true },
    topic: { type: String, required: true, trim: true, maxlength: 80 },
    difficulty: { type: String, enum: ["easy", "medium", "hard"], default: "medium", index: true },
    prompt: { type: String, required: true, trim: true },
    passage: { type: String, default: "" },
    imageUrls: { type: [String], default: [] },
    options: { type: [String], default: [] },
    marks: { type: Number, default: 4 },
    negativeMarks: { type: Number, default: -1 },
    correctOption: { type: Number, required: true },
    explanation: { type: String, default: "" },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// TTL: deleted questions are permanently removed 30 days after being moved to trash.
questionSchema.index({ deletedAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 30 });
questionSchema.index({ deletedAt: 1, createdAt: 1 });

questionSchema.set("toJSON", {
  transform: (_doc, ret) => {
    ret.id = String(ret._id);
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

module.exports = mongoose.model("Question", questionSchema);
