const mongoose = require("mongoose");
const { normalizeEmail } = require("../utils/normalize");

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 80 },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true, index: true },
    normalizedEmail: { type: String, lowercase: true, trim: true, index: true },
    role: { type: String, enum: ["admin", "student"], default: "student", index: true },
    isPaid: { type: Boolean, default: false, index: true },
    passwordHash: { type: String, select: false },
    isActivated: { type: Boolean, default: false, index: true },
    emailVerified: { type: Boolean, default: false },
    status: { type: String, enum: ["active", "pending", "disabled"], default: "pending", index: true },
    googleSubject: { type: String, default: null, index: true, sparse: true },
    appleSubject: { type: String, default: null, index: true, sparse: true },
    lastSeenAt: { type: Date, default: null, index: true },
    deletedAt: { type: Date, default: null },
    // Incremented on any security event (password change, role change, revoke, delete) to
    // invalidate every outstanding session JWT for this user.
    tokenVersion: { type: Number, default: 0 },
    failedLoginCount: { type: Number, default: 0 },
    lockedUntil: { type: Date, default: null },
    // Today's Question of the Day attempt (one per IST day).
    lastQotdAttempt: {
      date: { type: String, default: "" }, // "YYYY-MM-DD" in Asia/Kolkata
      questionId: { type: String, default: "" },
      answeredOpt: { type: String, default: "" },
      correct: { type: Boolean, default: false },
    },
  },
  { timestamps: true }
);

userSchema.pre("save", function (next) {
  if (this.email) {
    this.normalizedEmail = normalizeEmail(this.email);
  }
  next();
});

// No TTL on deletedAt: auto-deleting users orphaned their attempts, entitlements and
// reminders. Trashed users are removed only by an explicit admin purge (which anonymizes
// and cascades). Drop the old TTL index with scripts/migrations/2026-10-drop-user-ttl.js.
userSchema.index({ deletedAt: 1, createdAt: -1 });
userSchema.index({ email: 1, status: 1 });

userSchema.set("toJSON", {
  transform: (_doc, ret) => {
    ret.id = String(ret._id);
    ret.hasPassword = !!ret.passwordHash;
    delete ret._id;
    delete ret.__v;
    delete ret.passwordHash;
    // Internal security state never leaves the server.
    delete ret.tokenVersion;
    delete ret.failedLoginCount;
    delete ret.lockedUntil;
    delete ret.googleSubject;
    delete ret.appleSubject;
    return ret;
  },
});

module.exports = mongoose.model("User", userSchema);
