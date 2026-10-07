const mongoose = require("mongoose");

// Browser-reported exam-integrity signals. These are evidence for human review, not proof:
// they can be missing, spoofed or innocent. Enforcement lives on the server (AttemptSession).
const INTEGRITY_EVENT_TYPES = [
  "tab_hidden",
  "window_blur",
  "fullscreen_exit",
  "fullscreen_return",
  "copy_attempt",
  "cut_attempt",
  "paste_attempt",
  "context_menu",
  "blocked_shortcut",
  "print_attempt",
  "second_tab",
  "offline",
  "viewport_shrink",
  "device_takeover",
];

// Signals that count toward the session's violation total (others are telemetry only).
const COUNTED_EVENT_TYPES = new Set([
  "tab_hidden",
  "fullscreen_exit",
  "copy_attempt",
  "cut_attempt",
  "paste_attempt",
  "blocked_shortcut",
  "print_attempt",
  "second_tab",
]);

const integrityEventSchema = new mongoose.Schema(
  {
    sessionId: { type: mongoose.Schema.Types.ObjectId, ref: "AttemptSession", required: true, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    testId: { type: mongoose.Schema.Types.ObjectId, ref: "Test", required: true },
    type: { type: String, enum: INTEGRITY_EVENT_TYPES, required: true },
    counted: { type: Boolean, default: false },
    clientAt: { type: Date, default: null },
    durationMs: { type: Number, default: 0 },
    detail: { type: String, default: "", maxlength: 120 },
  },
  { timestamps: { createdAt: "receivedAt", updatedAt: false } }
);

integrityEventSchema.index({ sessionId: 1, receivedAt: 1 });

module.exports = mongoose.model("IntegrityEvent", integrityEventSchema);
module.exports.INTEGRITY_EVENT_TYPES = INTEGRITY_EVENT_TYPES;
module.exports.COUNTED_EVENT_TYPES = COUNTED_EVENT_TYPES;
