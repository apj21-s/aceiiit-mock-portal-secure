const mongoose = require("mongoose");

// One message in a mentor conversation. A student message carries the client's id
// (clientMessageId), so a retried send never stores or charges twice; its status follows the
// reply: pending → complete, or failed (retryable with the same id).
const mentorMessageSchema = new mongoose.Schema(
  {
    conversationId: { type: mongoose.Schema.Types.ObjectId, ref: "MentorConversation", required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    role: { type: String, enum: ["user", "assistant"], required: true },
    content: { type: String, required: true, maxlength: 12000 },
    status: { type: String, enum: ["pending", "complete", "failed"], default: "complete" },
    clientMessageId: { type: String, default: undefined },
    replyTo: { type: mongoose.Schema.Types.ObjectId, ref: "MentorMessage", default: null },
    model: { type: String, default: "" },
  },
  { timestamps: true }
);

mentorMessageSchema.index({ conversationId: 1, createdAt: 1 });
mentorMessageSchema.index(
  { userId: 1, clientMessageId: 1 },
  { unique: true, partialFilterExpression: { clientMessageId: { $type: "string" } } }
);

module.exports = mongoose.model("MentorMessage", mentorMessageSchema);
