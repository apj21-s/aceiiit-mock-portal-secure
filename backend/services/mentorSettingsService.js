const { z } = require("zod");

const AppConfig = require("../models/AppConfig");

// ACEIIIT Mentor settings: stored on the global AppConfig, edited in the Studio (ACEIIIT
// Mentor tab), validated here. Read through a short cache so every message doesn't hit
// MongoDB; an update clears it.

const DEFAULTS = Object.freeze({
  enabled: true,
  freeMonthlyReplies: 10,
  enrolledMonthlyReplies: 100,
  programCodes: [],
  programUrl: "",
  dailyGlobalReplies: 1000,
  maxInputChars: 2000,
  maxOutputTokens: 900,
});

// The portal's existing purchase link (the same one the "Buy test series" buttons use).
const DEFAULT_PROGRAM_URL = "https://ketc8up.github.io/AceIIIT/registrations.html";
const CACHE_TTL_MS = 30 * 1000;
let cached = null;

const resourceCode = z.string().trim().toUpperCase().regex(/^[A-Z0-9_]{2,64}$/, "Use codes like CLASS_NOTES");
const settingsSchema = z
  .object({
    enabled: z.boolean(),
    freeMonthlyReplies: z.number().int().min(0).max(1000),
    enrolledMonthlyReplies: z.number().int().min(0).max(10000),
    programCodes: z.array(resourceCode).max(20),
    programUrl: z.union([z.literal(""), z.string().trim().url().max(300).refine((v) => /^https:\/\//i.test(v), "Use an https:// link")]),
    dailyGlobalReplies: z.number().int().min(0).max(1000000),
    maxInputChars: z.number().int().min(200).max(8000),
    maxOutputTokens: z.number().int().min(200).max(4000),
  })
  .partial()
  .strict();

function normalize(stored) {
  const raw = (stored && typeof stored.toObject === "function" ? stored.toObject() : stored) || {};
  const out = { ...DEFAULTS };
  Object.keys(DEFAULTS).forEach((key) => {
    if (raw[key] !== undefined && raw[key] !== null) out[key] = raw[key];
  });
  out.programCodes = Array.from(new Set((out.programCodes || []).map((c) => String(c).trim().toUpperCase()).filter(Boolean)));
  out.ctaUrl = out.programUrl || DEFAULT_PROGRAM_URL;
  return out;
}

async function getMentorSettings({ fresh = false } = {}) {
  if (!fresh && cached && cached.expiresAt > Date.now()) return cached.value;
  const config = await AppConfig.findOne({ key: "global" }).select("mentor").lean();
  const value = normalize(config && config.mentor);
  cached = { value, expiresAt: Date.now() + CACHE_TTL_MS };
  return value;
}

async function updateMentorSettings(input, actorUserId) {
  const patch = settingsSchema.parse(input || {});
  const $set = { updatedBy: actorUserId || null };
  Object.entries(patch).forEach(([key, value]) => {
    $set[`mentor.${key}`] = value;
  });
  const config = await AppConfig.findOneAndUpdate(
    { key: "global" },
    { $set, $setOnInsert: { key: "global" } },
    { upsert: true, new: true }
  ).lean();
  cached = null;
  return normalize(config && config.mentor);
}

function clearMentorSettingsCache() {
  cached = null;
}

module.exports = { getMentorSettings, updateMentorSettings, clearMentorSettingsCache, MENTOR_DEFAULTS: DEFAULTS, DEFAULT_PROGRAM_URL };
