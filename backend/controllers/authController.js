const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { z } = require("zod");

const Otp = require("../models/Otp");
const User = require("../models/User");
const { sendOtpEmail } = require("../utils/mailService");
const { normalizeEmail } = require("../utils/normalize");
const { paidSheetService } = require("../services/paidSheetService");

let cachedAdminRaw = null;
let cachedAdminSet = new Set();

function generateOtp() {
  const n = Math.floor(100000 + Math.random() * 900000);
  return String(n);
}

function isAdminEmail(email) {
  const raw = String(process.env.ADMIN_EMAILS || "").trim();
  if (!raw) return false;
  if (raw !== cachedAdminRaw) {
    cachedAdminRaw = raw;
    cachedAdminSet = new Set(
      raw
        .split(",")
        .map((s) => String(s || "").trim().toLowerCase())
        .filter(Boolean)
    );
  }
  return cachedAdminSet.has(String(email || "").trim().toLowerCase());
}

const sendOtpSchema = z.object({
  email: z.string().email(),
});

const verifyOtpSchema = z.object({
  email: z.string().email(),
  otp: z.string().min(6).max(6),
  name: z.string().trim().min(2).max(80).optional(),
});

async function sendOtp(req, res, next) {
  try {
    const { email } = sendOtpSchema.parse(req.body || {});
    const normalizedEmail = normalizeEmail(email);

    const now = Date.now();
    const existing = await Otp.findOne({ email: normalizedEmail }).select("lastSentAt").lean();
    if (existing && existing.lastSentAt && now - existing.lastSentAt.getTime() < 60 * 1000) {
      return res.status(429).json({ error: "Please wait before requesting another OTP." });
    }

    const otp = generateOtp();
    const otpHash = await bcrypt.hash(otp, 10);
    const expiresAt = new Date(now + 5 * 60 * 1000);
    const lastSentAt = new Date(now);

    await Otp.findOneAndUpdate(
      { email: normalizedEmail },
      { email: normalizedEmail, otpHash, expiresAt, lastSentAt, attempts: 0, verifyAttempts: 0 },
      { upsert: true, new: true }
    );

    await sendOtpEmail(normalizedEmail, otp);
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
}

async function verifyOtp(req, res, next) {
  try {
    const { email, otp, name } = verifyOtpSchema.parse(req.body || {});
    const normalizedEmail = normalizeEmail(email);

    const record = await Otp.findOne({ email: normalizedEmail }).select("otpHash expiresAt attempts verifyAttempts");
    if (!record) {
      return res.status(400).json({ error: "OTP expired or invalid." });
    }
    if (record.expiresAt.getTime() < Date.now()) {
      await Otp.deleteOne({ _id: record._id });
      return res.status(400).json({ error: "OTP expired or invalid." });
    }
    const attempts = Number.isFinite(Number(record.attempts))
      ? Number(record.attempts)
      : Number(record.verifyAttempts || 0);
    if (attempts >= 5) {
      await Otp.deleteOne({ _id: record._id });
      return res.status(429).json({ error: "Too many attempts. Request a new OTP." });
    }

    const ok = await bcrypt.compare(String(otp), record.otpHash);
    if (!ok) {
      record.attempts = attempts + 1;
      record.verifyAttempts = record.attempts;
      await record.save();
      return res.status(400).json({ error: "OTP expired or invalid." });
    }

    await Otp.deleteOne({ _id: record._id });

    let user = await User.findOne({ email: normalizedEmail });
    if (!user) {
      user = await User.create({
        name: (name && String(name).trim()) || "Student",
        email: normalizedEmail,
        role: isAdminEmail(normalizedEmail) ? "admin" : "student",
        isPaid: false,
      });
    } else if (user.deletedAt) {
      return res.status(403).json({ error: "Account is disabled. Contact the admin." });
    } else if (name && String(name).trim() && user.name === "Student") {
      user.name = String(name).trim();
    }

    const desiredRole = isAdminEmail(normalizedEmail) ? "admin" : user.role;
    if (desiredRole !== user.role) {
      user.role = desiredRole;
    }

    const isPaid = paidSheetService.isVerified(normalizedEmail);
    if (isPaid !== Boolean(user.isPaid)) {
      user.isPaid = isPaid;
    }

    if (user.isModified()) {
      await user.save();
    }

    const token = jwt.sign(
      { userId: user.id, role: user.role, email: user.email, isPaid: user.isPaid, name: user.name },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || "7d" }
    );

    return res.json({ token, user: user.toJSON() });
  } catch (err) {
    return next(err);
  }
}

async function me(req, res, next) {
  try {
    const user = await User.findById(req.auth.userId);
    if (!user) return res.status(404).json({ error: "User not found" });
    if (user.deletedAt) return res.status(401).json({ error: "Unauthorized" });

    const desiredRole = isAdminEmail(user.email) ? "admin" : user.role;
    const desiredPaid = paidSheetService.isVerified(user.email);

    if (desiredRole !== user.role) user.role = desiredRole;
    if (desiredPaid !== Boolean(user.isPaid)) user.isPaid = desiredPaid;
    if (user.isModified()) await user.save();

    return res.json({ user: user.toJSON() });
  } catch (err) {
    return next(err);
  }
}

module.exports = { sendOtp, verifyOtp, me };
