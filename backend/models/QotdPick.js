const mongoose = require("mongoose");

// The question chosen for each IST day. Persisting the pick keeps the QOTD stable for the
// whole day across restarts, cache expiry, test publishing and multiple server instances.
const qotdPickSchema = new mongoose.Schema(
  {
    date: { type: String, required: true, unique: true }, // YYYY-MM-DD (Asia/Kolkata)
    questionId: { type: mongoose.Schema.Types.ObjectId, ref: "Question", required: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model("QotdPick", qotdPickSchema);
