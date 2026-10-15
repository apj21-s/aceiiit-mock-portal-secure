const mongoose = require("mongoose");

// An ACEIIIT Mentor conversation, private to its owner. Kept until the student deletes it or
// the account is purged (accountPurgeService).
const mentorConversationSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    title: { type: String, trim: true, maxlength: 120, default: "New conversation" },
    // Optional mock-test attempt the conversation is about (owner-checked when linked).
    attemptId: { type: mongoose.Schema.Types.ObjectId, ref: "Attempt", default: null },
    messageCount: { type: Number, default: 0, min: 0 },
    lastMessageAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

mentorConversationSchema.index({ userId: 1, lastMessageAt: -1 });

module.exports = mongoose.model("MentorConversation", mentorConversationSchema);
