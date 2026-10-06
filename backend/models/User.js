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
    lastQotdAttempt: {
      date: { type: String, default: "" }, // "YYYY-MM-DD"
      answeredOpt: { type: String, default: "" }
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

// TTL: deleted users are permanently removed 30 days after being moved to trash.
userSchema.index({ deletedAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 30 });
userSchema.index({ deletedAt: 1, createdAt: -1 });
userSchema.index({ email: 1, status: 1 });
userSchema.index({ normalizedEmail: 1 });

userSchema.set("toJSON", {
  transform: (_doc, ret) => {
    ret.id = String(ret._id);
    ret.hasPassword = !!ret.passwordHash;
    delete ret._id;
    delete ret.__v;
    delete ret.passwordHash;
    return ret;
  },
});

module.exports = mongoose.model("User", userSchema);
