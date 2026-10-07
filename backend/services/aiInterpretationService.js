const crypto = require("crypto");
const { z } = require("zod");

const Attempt = require("../models/Attempt");
const AttemptInterpretation = require("../models/AttemptInterpretation");
const { computeAttemptAnalytics, difficultyMapFor } = require("./analyticsService");
const { detectPatterns } = require("./patternDetectionService");
const { buildPerformanceProfile } = require("./performanceProfileService");
const { domainEvents, EVENTS } = require("./domainEvents");
const { logger, errorSummary } = require("../utils/logger");

// ---------------------------------------------------------------------------
// Performance Intelligence: Gemini interprets deterministic evidence.
//
//   Attempt → deterministic analytics → patterns → privacy-safe evidence →
//   Gemini (optional, async) → schema + typed-number validation → stored result
//
// Non-negotiable: AI output is display-only text. It is stored in its own collection and
// is never used for scoring, ranking, eligibility, payments or exam integrity. Submission
// never waits for it, and the deterministic interpretation always exists as a fallback.
// ---------------------------------------------------------------------------

const PAYLOAD_VERSION = 1;
const PROMPT_VERSION = "pi-v1";
const DEFAULT_MODEL = "gemini-3.5-flash-lite";
const MAX_PROVIDER_ATTEMPTS = 3;
const RETRY_BASE_MS = 1000;

function config() {
  return {
    enabled: String(process.env.AI_INTERPRETATION_ENABLED || "").trim().toLowerCase() === "true",
    apiKey: String(process.env.GEMINI_API_KEY || "").trim(),
    model: String(process.env.GEMINI_MODEL || DEFAULT_MODEL).trim(),
    timeoutMs: Math.max(2000, Math.min(60000, Number(process.env.AI_TIMEOUT_MS || 20000))),
    breakerTtlMs: Math.max(60 * 1000, Number(process.env.AI_BREAKER_TTL_MS || 60 * 60 * 1000)),
    breakerMaxMs: Math.max(60 * 1000, Number(process.env.AI_BREAKER_MAX_MS || 24 * 60 * 60 * 1000)),
    minIntervalMs: Math.max(0, Number(process.env.AI_MIN_INTERVAL_MS || 4000)),
  };
}

// ---------------------------------------------------------------------------
// Output schema (one Zod schema → server validation + the JSON schema sent to Gemini)
// ---------------------------------------------------------------------------
const text = (max) => z.string().trim().min(1).max(max);
const InterpretationSchema = z
  .object({
    headline: text(140),
    summary: text(700),
    strengths: z.array(text(220)).max(4),
    priorityAreas: z
      .array(z.object({ topic: text(80), reason: text(260), action: text(260) }).strict())
      .max(4),
    behaviorPatterns: z.array(text(260)).max(4),
    nextTestStrategy: z.array(text(260)).min(1).max(5),
  })
  .strict();

const RESPONSE_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["headline", "summary", "strengths", "priorityAreas", "behaviorPatterns", "nextTestStrategy"],
  properties: {
    headline: { type: "string", maxLength: 140 },
    summary: { type: "string", maxLength: 700 },
    strengths: { type: "array", maxItems: 4, items: { type: "string", maxLength: 220 } },
    priorityAreas: {
      type: "array",
      maxItems: 4,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["topic", "reason", "action"],
        properties: {
          topic: { type: "string", maxLength: 80 },
          reason: { type: "string", maxLength: 260 },
          action: { type: "string", maxLength: 260 },
        },
      },
    },
    behaviorPatterns: { type: "array", maxItems: 4, items: { type: "string", maxLength: 260 } },
    nextTestStrategy: { type: "array", minItems: 1, maxItems: 5, items: { type: "string", maxLength: 260 } },
  },
};

// ---------------------------------------------------------------------------
// Privacy-safe payload: aggregate evidence only. Never: name, email, userId, attemptId,
// question text/options/explanations, session, auth or payment data.
// ---------------------------------------------------------------------------
function buildAIInterpretationPayload({ analytics, patterns, profile }) {
  const pickBucket = (b) => ({
    attempted: b.attempted,
    correct: b.correct,
    wrong: b.wrong,
    skipped: b.skipped,
    accuracyPct: b.accuracyPct,
    avgTimeSec: b.avgTimeSec,
    marksLost: b.marksLost,
  });
  return {
    payloadVersion: PAYLOAD_VERSION,
    overall: {
      questions: analytics.overall.total,
      ...pickBucket(analytics.overall),
      attemptRatePct: analytics.overall.attemptRatePct,
      medianTimeSec: analytics.overall.medianTimeSec,
    },
    sections: analytics.sections.map((s) => ({ section: s.key, ...pickBucket(s) })),
    topics: analytics.topics.slice(0, 12).map((t) => ({ topic: t.topic, section: t.section, ...pickBucket(t) })),
    difficultyBuckets: analytics.difficulty.map((d) => ({ level: d.level, attempted: d.attempted, accuracyPct: d.accuracyPct })),
    timingPatterns: {
      medianTimeSec: analytics.timing.medianTimeSec,
      slowAttempted: analytics.timing.slowAttempted,
      slowWrong: analytics.timing.slowWrong,
      fastAttempted: analytics.timing.fastAttempted,
      fastWrong: analytics.timing.fastWrong,
      timeOnWrongPct: analytics.timing.timeOnWrongPct,
    },
    behaviorPatterns: patterns.map((p) => ({ code: p.code, severity: p.severity, evidence: p.evidence })),
    previousAttemptDelta: profile && profile.previous
      ? { accuracyPctDelta: profile.previous.accuracyPctDelta, attemptRatePctDelta: profile.previous.attemptRatePctDelta }
      : null,
  };
}

// ---------------------------------------------------------------------------
// Typed numeric-claim validation (not a naive regex over all digits)
// ---------------------------------------------------------------------------
function collectNumbers(node, key, sets) {
  if (node === null || node === undefined) return;
  if (Array.isArray(node)) {
    node.forEach((item) => collectNumbers(item, key, sets));
    return;
  }
  if (typeof node === "object") {
    Object.entries(node).forEach(([k, v]) => collectNumbers(v, k, sets));
    return;
  }
  if (typeof node !== "number" || !Number.isFinite(node)) return;
  const k = String(key || "");
  if (/Pct(Delta)?$/i.test(k)) sets.percentages.push(Math.abs(node));
  else if (/Sec$/i.test(k)) sets.durations.push(Math.abs(node));
  else if (/marks/i.test(k)) sets.marks.push(Math.abs(node));
  else sets.counts.push(Math.abs(node));
}

function buildEvidenceNumberSet(payload) {
  const sets = { percentages: [], counts: [], durations: [], marks: [] };
  collectNumbers(payload, "", sets);
  return sets;
}

function knownNamesOf(payload) {
  return [
    ...(payload.topics || []).map((t) => t.topic),
    ...(payload.sections || []).map((s) => s.section),
    "SUPR",
    "REAP",
  ].filter(Boolean);
}

function matches(value, list, tolerance) {
  return list.some((candidate) => Math.abs(candidate - value) <= tolerance);
}

/** Returns the list of unsupported numeric claims (empty array = OK). */
function findUnsupportedNumbers(textValue, sets, knownNames) {
  let scrubbed = String(textValue || "");
  // Numbers inside known identifiers (topic/section names) are not claims.
  knownNames
    .slice()
    .sort((a, b) => b.length - a.length)
    .forEach((name) => {
      scrubbed = scrubbed.split(name).join(" ");
    });
  // Dates, years and list ordinals are not performance claims.
  scrubbed = scrubbed
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, " ")
    .replace(/\b(19|20)\d{2}\b/g, " ")
    .replace(/(^|\n)\s*\d+[.)]\s/g, "$1 ");

  const problems = [];
  const check = (value, list, tolerance, label) => {
    if (!matches(value, list, tolerance)) problems.push(`${label} ${value}`);
  };
  let m;
  const pctRe = /(\d+(?:\.\d+)?)\s*(?:%|percent\b)/gi;
  while ((m = pctRe.exec(scrubbed))) check(Number(m[1]), sets.percentages, 0.5, "percentage");
  const ratioRe = /\b(\d+)\s*\/\s*(\d+)\b/g;
  while ((m = ratioRe.exec(scrubbed))) {
    check(Number(m[1]), sets.counts, 0, "count");
    check(Number(m[2]), sets.counts, 0, "count");
  }
  const marksRe = /(\d+(?:\.\d+)?)\s*(?:marks?|points?)\b/gi;
  while ((m = marksRe.exec(scrubbed))) check(Number(m[1]), sets.marks.concat(sets.counts), 0.01, "marks");
  const countRe = /\b(\d+)\s*(?:questions?|correct|wrong|incorrect|mistakes?|errors?|skipped|attempts?|answers?)\b/gi;
  while ((m = countRe.exec(scrubbed))) check(Number(m[1]), sets.counts, 0, "count");
  const secRe = /(\d+(?:\.\d+)?)\s*(?:seconds?|secs?|s)\b/gi;
  while ((m = secRe.exec(scrubbed))) check(Number(m[1]), sets.durations, 1, "duration");
  const minRe = /(\d+(?:\.\d+)?)\s*(?:minutes?|mins?)\b/gi;
  while ((m = minRe.exec(scrubbed))) check(Number(m[1]) * 60, sets.durations, 30, "duration");
  const clockRe = /\b(\d{1,2}):(\d{2})\b/g;
  while ((m = clockRe.exec(scrubbed))) check(Number(m[1]) * 60 + Number(m[2]), sets.durations, 1, "duration");
  const rankRe = /\b(?:rank(?:ed)?\s*#?|#)(\d+)\b|\b(\d+)(?:st|nd|rd|th)\s+(?:place|rank)\b/gi;
  while ((m = rankRe.exec(scrubbed))) problems.push(`rank ${m[1] || m[2]}`);
  const percentileRe = /(\d+(?:\.\d+)?)\s*(?:th\s+)?percentile/gi;
  while ((m = percentileRe.exec(scrubbed))) problems.push(`percentile ${m[1]}`);
  return problems;
}

function allText(result) {
  return [
    result.headline,
    result.summary,
    ...(result.strengths || []),
    ...(result.priorityAreas || []).flatMap((p) => [p.topic, p.reason, p.action]),
    ...(result.behaviorPatterns || []),
    ...(result.nextTestStrategy || []),
  ].join("\n");
}

function validateInterpretation(candidate, payload) {
  const parsed = InterpretationSchema.safeParse(candidate);
  if (!parsed.success) return { ok: false, reason: "schema_invalid" };
  const unsupported = findUnsupportedNumbers(allText(parsed.data), buildEvidenceNumberSet(payload), knownNamesOf(payload));
  if (unsupported.length) return { ok: false, reason: "unsupported_numbers", details: unsupported };
  return { ok: true, value: parsed.data };
}

// ---------------------------------------------------------------------------
// Deterministic interpretation (always available; used whenever AI is off or fails)
// ---------------------------------------------------------------------------
const PATTERN_TEXT = {
  high_time_low_accuracy: (e) => `Long time spent on some questions didn't pay off: ${e.slowWrong} of ${e.slowQuestions} slow questions were wrong.`,
  fast_low_accuracy: (e) => `Very quick answers were often wrong: ${e.fastWrong} of ${e.fastQuestions} fast answers missed.`,
  accurate_but_slow: (e) => `Accurate but slow in ${e.topics.map((t) => t.topic).join(", ")}; speed there would free time for the rest of the paper.`,
  weak_topics: (e) => `Most marks leaked in ${e.topics.map((t) => t.topic).join(", ")}.`,
  difficulty_sensitivity: (e) => `Accuracy drops sharply on hard questions (${e.hardAccuracyPct}% vs ${e.easyAccuracyPct}% on easy ones).`,
  easy_question_slips: (e) => `Easy questions are costing marks (${e.easyAccuracyPct}% accuracy on easy questions).`,
  low_coverage: (e) => `Only ${e.attemptRatePct}% of the paper was attempted; ${e.skipped} questions were left blank.`,
  time_sunk_into_wrong_answers: (e) => `${e.timeOnWrongPct}% of your time went into answers that turned out wrong.`,
  section_gap: (e) => `${e.weakSection} trails ${e.strongSection} (${e.weakAccuracyPct}% vs ${e.strongAccuracyPct}% accuracy).`,
  improving: (e) => `Accuracy improved by ${e.accuracyPctDelta}% since your previous attempt.`,
  regressing: (e) => `Accuracy dropped by ${Math.abs(e.accuracyPctDelta)}% since your previous attempt.`,
};

function buildDeterministicInterpretation({ analytics, patterns }) {
  const { overall, topics } = analytics;
  const strongTopics = topics.filter((t) => t.attempted >= 2 && t.accuracyPct >= 75).slice(0, 3);
  const weakTopics = topics.filter((t) => t.attempted >= 1 && (t.accuracyPct < 60 || t.marksLost > 0)).slice(0, 3);
  const strategy = [];
  if (patterns.some((p) => p.code === "fast_low_accuracy" || p.code === "easy_question_slips")) {
    strategy.push("Re-read each question and check the chosen option before moving on, especially on easier questions.");
  }
  if (patterns.some((p) => p.code === "high_time_low_accuracy" || p.code === "time_sunk_into_wrong_answers")) {
    strategy.push("Set a per-question time cap; mark long questions for review and come back after a first pass.");
  }
  if (patterns.some((p) => p.code === "low_coverage")) {
    strategy.push("Do a quick first pass that attempts every question you can solve confidently before going deeper.");
  }
  if (weakTopics.length) strategy.push(`Revise ${weakTopics.map((t) => t.topic).join(", ")} with a short timed practice set.`);
  if (!strategy.length) strategy.push("Keep the same approach and take a timed mock to confirm the gains.");

  const headline = weakTopics.length
    ? `Focus next on ${weakTopics[0].topic}`
    : overall.attempted
      ? "Solid attempt: keep building consistency"
      : "Start by attempting the questions you know";
  return {
    headline,
    summary: `You attempted ${overall.attempted} of ${overall.total} questions with ${overall.accuracyPct}% accuracy.` +
      (patterns.length ? ` ${PATTERN_TEXT[patterns[0].code] ? PATTERN_TEXT[patterns[0].code](patterns[0].evidence) : ""}` : ""),
    strengths: strongTopics.map((t) => `${t.topic}: ${t.accuracyPct}% accuracy across ${t.attempted} attempted questions.`),
    priorityAreas: weakTopics.map((t) => ({
      topic: t.topic,
      reason: `${t.accuracyPct}% accuracy with ${t.marksLost} marks lost.`,
      action: `Revisit the core ideas of ${t.topic} and solve a few timed questions before the next mock.`,
    })),
    behaviorPatterns: patterns
      .filter((p) => PATTERN_TEXT[p.code])
      .slice(0, 4)
      .map((p) => PATTERN_TEXT[p.code](p.evidence)),
    nextTestStrategy: strategy.slice(0, 5),
  };
}

// ---------------------------------------------------------------------------
// Gemini client (injectable for tests) + circuit breaker
// ---------------------------------------------------------------------------
let clientFactory = (apiKey) => {
  const { GoogleGenAI } = require("@google/genai");
  return new GoogleGenAI({ apiKey });
};

function setGeminiClientFactory(factory) {
  clientFactory = factory;
}

const breaker = { openUntil: 0, reason: "", openedAt: 0 };

function breakerState() {
  return {
    open: Date.now() < breaker.openUntil,
    openUntil: breaker.openUntil ? new Date(breaker.openUntil).toISOString() : null,
    reason: breaker.reason,
  };
}

function openBreaker(reason, retryDelayMs) {
  const cfg = config();
  const duration = Math.min(cfg.breakerMaxMs, Math.max(60 * 1000, retryDelayMs || cfg.breakerTtlMs));
  breaker.openUntil = Date.now() + duration;
  breaker.openedAt = Date.now();
  breaker.reason = reason;
}

function resetBreaker() {
  breaker.openUntil = 0;
  breaker.reason = "";
  breaker.openedAt = 0;
}

function parseRetryDelayMs(error) {
  const textValue = `${error && error.message ? error.message : ""}`;
  const match = textValue.match(/retry(?:Delay|\s+in)["':\s]*([\d.]+)\s*(ms|s)?/i);
  if (!match) return null;
  const value = Number(match[1]);
  return match[2] === "ms" ? value : value * 1000;
}

/** Classifies a provider error: "retry" (transient), "quota" (open breaker), "fatal" (no retry). */
function classifyError(error) {
  if (!error) return "fatal";
  if (error.name === "AbortError" || error.code === "ETIMEDOUT" || /aborted|timeout|timed out/i.test(error.message || "")) return "retry";
  const status = Number(error.status || error.code || 0);
  if (status === 429) {
    return /per\s*day|daily|PerDay|quota exceeded for quota metric.*day/i.test(error.message || "") ? "quota" : "retry";
  }
  if (status >= 500) return "retry";
  if (status >= 400) return "fatal";
  if (/fetch failed|ECONNRESET|ENOTFOUND|EAI_AGAIN|network/i.test(error.message || "")) return "retry";
  return "fatal";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const SYSTEM_INSTRUCTION = [
  "You are a concise exam coach for the UGEE entrance exam. You receive structured, already-computed performance evidence for one mock attempt.",
  "Interpret the evidence for the student in clear, encouraging second-person language and return JSON matching the schema.",
  "Rules:",
  "- Do not calculate or restate scores, ranks or percentiles. The app shows verified metrics separately.",
  "- Avoid numbers unless one is essential; if you use a number, copy it exactly from the evidence.",
  "- Only discuss topics and sections present in the evidence.",
  "- Describe behaviour (timing, accuracy, coverage); never diagnose emotions, anxiety or other psychological states.",
  "- Give specific, actionable next steps.",
].join("\n");

async function callGemini(payload) {
  const cfg = config();
  const client = clientFactory(cfg.apiKey);
  let lastError = null;
  for (let attempt = 1; attempt <= MAX_PROVIDER_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
    try {
      const response = await client.models.generateContent({
        model: cfg.model,
        contents: JSON.stringify(payload),
        config: {
          systemInstruction: SYSTEM_INSTRUCTION,
          responseMimeType: "application/json",
          responseJsonSchema: RESPONSE_JSON_SCHEMA,
          temperature: 0.3,
          maxOutputTokens: 1200,
          abortSignal: controller.signal,
        },
      });
      clearTimeout(timer);
      return { text: response && typeof response.text === "string" ? response.text : String((response && response.text) || "") };
    } catch (error) {
      clearTimeout(timer);
      lastError = error;
      const kind = classifyError(error);
      if (kind === "quota") {
        openBreaker("quota_exhausted", parseRetryDelayMs(error));
        throw Object.assign(new Error("quota_exhausted"), { kind: "quota" });
      }
      if (kind === "fatal") throw Object.assign(new Error(`provider_error_${error.status || "unknown"}`), { kind: "fatal", status: error.status });
      if (attempt < MAX_PROVIDER_ATTEMPTS) {
        const hinted = parseRetryDelayMs(error);
        await sleep(Math.min(hinted || RETRY_BASE_MS * 2 ** (attempt - 1), 10000));
      }
    }
  }
  throw Object.assign(new Error(`provider_unavailable: ${lastError && lastError.message ? lastError.message : "unknown"}`), { kind: "retry_exhausted" });
}

// ---------------------------------------------------------------------------
// Job lifecycle
// ---------------------------------------------------------------------------
async function buildEvidenceForAttempt(attempt) {
  const analytics = computeAttemptAnalytics(attempt, await difficultyMapFor(attempt));
  const profile = await buildPerformanceProfile(attempt);
  const patterns = detectPatterns(analytics, profile);
  const payload = buildAIInterpretationPayload({ analytics, patterns, profile });
  return { analytics, profile, patterns, payload };
}

/** Creates the interpretation job for an attempt (idempotent: one per attempt). */
async function enqueueInterpretation(attemptId) {
  const attempt = await Attempt.findById(attemptId).select("_id userId").lean();
  if (!attempt) return null;
  try {
    return await AttemptInterpretation.findOneAndUpdate(
      { attemptId: attempt._id },
      { $setOnInsert: { attemptId: attempt._id, userId: attempt.userId, status: "pending", payloadVersion: PAYLOAD_VERSION } },
      { upsert: true, new: true }
    );
  } catch (err) {
    if (err && err.code === 11000) return AttemptInterpretation.findOne({ attemptId: attempt._id });
    throw err;
  }
}

async function claimNextJob(now = new Date()) {
  return AttemptInterpretation.findOneAndUpdate(
    {
      $or: [
        { status: "pending" },
        // Fallbacks parked by the breaker are retried with AI once it closes.
        { status: "fallback", retryAfter: { $ne: null, $lte: now } },
        // Recover jobs whose worker died mid-way.
        { status: "processing", claimedAt: { $lt: new Date(now.getTime() - 5 * 60 * 1000) } },
      ],
    },
    { $set: { status: "processing", claimedAt: now }, $inc: { attemptCount: 1 } },
    { sort: { createdAt: 1 }, new: true }
  );
}

/** Processes one claimed job. Never throws; always leaves a deterministic result at minimum. */
async function processJob(job) {
  const cfg = config();
  const attempt = await Attempt.findById(job.attemptId).lean();
  if (!attempt) {
    await AttemptInterpretation.deleteOne({ _id: job._id });
    return "missing_attempt";
  }
  const evidence = await buildEvidenceForAttempt(attempt);
  const deterministic = buildDeterministicInterpretation(evidence);
  const payloadHash = crypto.createHash("sha256").update(JSON.stringify(evidence.payload)).digest("hex");
  const base = { deterministic, payloadHash, payloadVersion: PAYLOAD_VERSION };

  const fallback = async (reason, retryAfter = null) => {
    await AttemptInterpretation.updateOne(
      { _id: job._id },
      { $set: { ...base, status: "fallback", provider: "deterministic", model: "", result: deterministic, fallbackReason: reason, retryAfter, completedAt: new Date() } }
    );
    return `fallback:${reason}`;
  };

  if (!cfg.enabled) return fallback("disabled");
  if (!cfg.apiKey) return fallback("not_configured");
  if (breakerState().open) return fallback("breaker_open", new Date(breaker.openUntil));
  if (job.attemptCount > MAX_PROVIDER_ATTEMPTS + 2) return fallback("gave_up");

  try {
    const { text: raw } = await callGemini(evidence.payload);
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (_err) {
      return fallback("invalid_json");
    }
    const checked = validateInterpretation(parsed, evidence.payload);
    if (!checked.ok) return fallback(checked.reason);
    await AttemptInterpretation.updateOne(
      { _id: job._id },
      { $set: { ...base, status: "ready", provider: "gemini", model: `${cfg.model}#${PROMPT_VERSION}`, result: checked.value, fallbackReason: "", retryAfter: null, completedAt: new Date() } }
    );
    return "ready";
  } catch (error) {
    if (error.kind === "quota") return fallback("quota_exhausted", new Date(breaker.openUntil));
    if (error.kind === "fatal") return fallback(error.message);
    return fallback("provider_unavailable");
  }
}

async function processPendingJobs({ maxJobs = 5 } = {}) {
  const cfg = config();
  const outcomes = [];
  for (let i = 0; i < maxJobs; i += 1) {
    const job = await claimNextJob();
    if (!job) break;
    outcomes.push(await processJob(job));
    if (cfg.enabled && cfg.minIntervalMs && i < maxJobs - 1) await sleep(cfg.minIntervalMs);
  }
  return outcomes;
}

/** Read model for the API. Creates (and immediately computes) a deterministic result for older attempts. */
async function getInterpretationForAttempt(attempt) {
  let doc = await AttemptInterpretation.findOne({ attemptId: attempt._id }).lean();
  if (!doc) {
    await enqueueInterpretation(attempt._id);
    doc = await AttemptInterpretation.findOne({ attemptId: attempt._id }).lean();
  }
  const cfg = config();
  if (doc.status === "pending" && (!cfg.enabled || !cfg.apiKey)) {
    // No AI will run: resolve to the deterministic interpretation right away.
    const claimed = await AttemptInterpretation.findOneAndUpdate(
      { _id: doc._id, status: "pending" },
      { $set: { status: "processing", claimedAt: new Date() }, $inc: { attemptCount: 1 } },
      { new: true }
    );
    if (claimed) await processJob(claimed);
    doc = await AttemptInterpretation.findOne({ attemptId: attempt._id }).lean();
  }
  if (!doc.deterministic) {
    // Always have something to show immediately, even before the worker runs.
    const evidence = await buildEvidenceForAttempt(attempt);
    doc = { ...doc, deterministic: buildDeterministicInterpretation(evidence) };
  }
  return doc;
}

let handlersRegistered = false;
function registerEventHandlers() {
  if (handlersRegistered) return;
  handlersRegistered = true;
  domainEvents.on(EVENTS.ATTEMPT_FINALIZED, ({ attemptId }) => {
    enqueueInterpretation(attemptId).catch((err) => {
      logger.error({ err: errorSummary(err) }, "ai interpretation enqueue failed");
    });
  });
}

class InterpretationWorker {
  constructor() {
    this._timer = null;
    this._running = false;
    this.lastRunAt = null;
  }

  start(intervalMs = Number(process.env.AI_WORKER_INTERVAL_MS || 5000)) {
    this.stop();
    this._timer = setInterval(() => this.tick(), Math.max(1000, intervalMs));
  }

  async tick() {
    if (this._running) return;
    this._running = true;
    try {
      await processPendingJobs();
      this.lastRunAt = new Date();
    } catch (err) {
      logger.error({ err: errorSummary(err) }, "ai interpretation worker tick failed");
    } finally {
      this._running = false;
    }
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }
}

const interpretationWorker = new InterpretationWorker();

module.exports = {
  InterpretationSchema,
  RESPONSE_JSON_SCHEMA,
  PROMPT_VERSION,
  buildAIInterpretationPayload,
  buildEvidenceNumberSet,
  findUnsupportedNumbers,
  validateInterpretation,
  buildDeterministicInterpretation,
  buildEvidenceForAttempt,
  enqueueInterpretation,
  processPendingJobs,
  getInterpretationForAttempt,
  registerEventHandlers,
  interpretationWorker,
  breakerState,
  resetBreaker,
  setGeminiClientFactory,
  classifyError,
};
