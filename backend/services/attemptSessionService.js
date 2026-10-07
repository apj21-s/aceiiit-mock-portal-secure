const crypto = require("crypto");
const { z } = require("zod");

const Attempt = require("../models/Attempt");
const AttemptSession = require("../models/AttemptSession");
const IntegrityEvent = require("../models/IntegrityEvent");
const { logAuditEvent } = require("./auditLogService");
const Test = require("../models/Test");
const { canAccessTest } = require("./entitlementService");
const { getTestRuntimeSnapshot, getPublicQuestionsForTest } = require("./testDataService");
const { evaluateAttempt } = require("./evaluationService");
const { buildAttemptAnalysis } = require("./attemptAnalysisService");
const { invalidateRankCache } = require("./rankService");
const { domainEvents, EVENTS } = require("./domainEvents");

// Requests within this window after a deadline are still accepted (network latency).
const GRACE_MS = 60 * 1000;
// A finalization claimed but not completed within this window is considered stuck.
const STUCK_FINALIZE_MS = 30 * 1000;

class ExamError extends Error {
  constructor(status, code, message, extra) {
    super(message);
    this.status = status;
    this.code = code;
    this.expose = true;
    this.extra = extra || {};
  }
}

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token || "")).digest("hex");
}

function newExamToken() {
  return crypto.randomBytes(32).toString("hex");
}

function tokenMatches(session, token) {
  if (!token || typeof token !== "string" || !session.examTokenHash) return false;
  const left = Buffer.from(hashToken(token), "hex");
  const right = Buffer.from(session.examTokenHash, "hex");
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function fingerprintFor(req) {
  const ua = String((req && req.get && req.get("user-agent")) || "");
  const ip = String((req && req.ip) || "");
  const ipPrefix = ip.includes(":") ? ip.split(":").slice(0, 4).join(":") : ip.split(".").slice(0, 3).join(".");
  return {
    userAgentHash: ua ? crypto.createHash("sha256").update(ua).digest("hex").slice(0, 16) : "",
    ipPrefix,
  };
}

// ---------------------------------------------------------------------------
// Seeded per-session shuffling. The server stores answers in the ORIGINAL option
// order; the browser sees (and answers in) the shuffled order.
// ---------------------------------------------------------------------------
function seededRandom(seed, key) {
  const digest = crypto.createHash("sha256").update(`${seed}:${key}`).digest();
  let state = digest.readUInt32LE(0);
  return function mulberry32() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seededShuffle(items, seed, key) {
  const result = items.slice();
  const random = seededRandom(seed, key);
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

/** perm[displayedIndex] = originalIndex */
function optionPermutation(session, questionId, optionCount) {
  const identity = Array.from({ length: optionCount }, (_, i) => i);
  if (!session.shuffleOptions || !session.shuffleSeed || optionCount < 2) return identity;
  return seededShuffle(identity, session.shuffleSeed, `options:${questionId}`);
}

function orderQuestions(session, questions) {
  const bySection = (section) => questions.filter((q) => (q.section === "REAP" ? "REAP" : "SUPR") === section);
  const arrange = (list, section) =>
    session.shuffleQuestions && session.shuffleSeed ? seededShuffle(list, session.shuffleSeed, `questions:${section}`) : list;
  return arrange(bySection("SUPR"), "SUPR").concat(arrange(bySection("REAP"), "REAP"));
}

/**
 * Derives the authoritative exam timeline from server timestamps only.
 * REAP starts when the student submits SUPR early, or automatically at the SUPR deadline.
 */
function computeTimeline(session, nowMs = Date.now()) {
  const startedAtMs = new Date(session.startedAt).getTime();
  const suprDeadlineMs = startedAtMs + Number(session.suprDurationMs || 0);
  let reapStartMs = session.reapStartedAt ? new Date(session.reapStartedAt).getTime() : null;
  if (reapStartMs === null && nowMs >= suprDeadlineMs) reapStartMs = suprDeadlineMs;
  const reapDeadlineMs = reapStartMs !== null ? reapStartMs + Number(session.reapDurationMs || 0) : null;
  const finalDeadlineMs = reapDeadlineMs !== null ? reapDeadlineMs : suprDeadlineMs + Number(session.reapDurationMs || 0);
  const suprLocked = Boolean(session.suprLockedAt) || nowMs >= suprDeadlineMs;
  const activeSection = reapStartMs !== null && nowMs >= reapStartMs ? "REAP" : "SUPR";
  return {
    startedAtMs,
    suprDeadlineMs,
    reapStartMs,
    reapDeadlineMs,
    finalDeadlineMs,
    suprLocked,
    activeSection,
    expired: nowMs > finalDeadlineMs + GRACE_MS,
  };
}

function mapToObject(value) {
  if (!value) return {};
  if (value instanceof Map) return Object.fromEntries(value.entries());
  return Object.assign({}, value);
}

function toDisplayedAnswers(session, answers, optionCounts) {
  if (!session.shuffleOptions || !optionCounts) return answers;
  const displayed = {};
  Object.entries(answers).forEach(([questionId, original]) => {
    const perm = optionPermutation(session, questionId, optionCounts[questionId] || 0);
    const index = perm.indexOf(Number(original));
    if (index >= 0) displayed[questionId] = index;
  });
  return displayed;
}

function integrityView(session) {
  const integrity = session.integrity || {};
  return {
    mode: integrity.mode || "warn",
    warnThreshold: Number(integrity.warnThreshold || 1),
    autoSubmitThreshold: Number(integrity.autoSubmitThreshold || 5),
    violations: Number(integrity.violations || 0),
  };
}

function sessionView(session, nowMs = Date.now(), optionCounts = null) {
  const t = computeTimeline(session, nowMs);
  const iso = (ms) => (ms === null || ms === undefined ? null : new Date(ms).toISOString());
  return {
    id: String(session._id),
    testId: String(session.testId),
    status: session.status,
    isPractice: Boolean(session.isPractice),
    serverNow: new Date(nowMs).toISOString(),
    startedAt: iso(t.startedAtMs),
    activeSection: t.activeSection,
    suprLocked: t.suprLocked,
    deadlines: {
      SUPR: iso(t.suprDeadlineMs),
      reapStartedAt: iso(t.reapStartMs),
      REAP: iso(t.reapDeadlineMs),
      final: iso(t.finalDeadlineMs),
    },
    durations: { SUPR: session.suprDurationMs, REAP: session.reapDurationMs },
    graceMs: GRACE_MS,
    answers: toDisplayedAnswers(session, mapToObject(session.answers), optionCounts),
    timeSpent: mapToObject(session.timeSpent),
    shuffleOptions: Boolean(session.shuffleOptions),
    shuffleQuestions: Boolean(session.shuffleQuestions),
    integrity: integrityView(session),
    marked: session.marked || [],
    visited: session.visited || [],
    currentQuestionId: session.currentQuestionId || "",
    lastSeq: session.lastSeq || 0,
    attemptId: session.attemptId ? String(session.attemptId) : null,
  };
}

async function loadTestForSession(testId, auth) {
  if (!/^[a-f0-9]{24}$/i.test(String(testId || ""))) {
    throw new ExamError(400, "INVALID_TEST", "Invalid test id.");
  }
  const test = await Test.findOne({ _id: testId, deletedAt: null }).lean();
  if (!test) throw new ExamError(404, "TEST_NOT_FOUND", "Test not found.");
  if (test.status === "practice") {
    if (String(test.ownerUserId) !== String(auth.userId)) {
      throw new ExamError(404, "TEST_NOT_FOUND", "Test not found.");
    }
  } else {
    if (test.status !== "live" && auth.role !== "admin") {
      throw new ExamError(404, "TEST_NOT_FOUND", "Test not found.");
    }
    if (!(await canAccessTest(auth, test))) {
      throw new ExamError(402, "PAYMENT_REQUIRED", "Buy Test Series");
    }
  }
  const snapshot = await getTestRuntimeSnapshot(test._id);
  if (!snapshot || !snapshot.questions.length) {
    throw new ExamError(400, "TEST_EMPTY", "Test questions are missing. Please contact admin.");
  }
  return { test, snapshot };
}

function durationsFor(test) {
  const durations = test.sectionDurations || {};
  const toMs = (minutes, fallback) => {
    const value = Number(minutes);
    return Math.round((Number.isFinite(value) && value > 0 ? value : fallback) * 60 * 1000);
  };
  return { suprDurationMs: toMs(durations.SUPR, 60), reapDurationMs: toMs(durations.REAP, 120) };
}

async function findActiveSession(userId, testId) {
  return AttemptSession.findOne({ userId, testId, status: "active" });
}

/**
 * POST /api/attempt/start semantics:
 * - no active session → create (201, returns a new examToken)
 * - active session + matching token → resume (200)
 * - active session without a valid binding → 409 EXAM_ACTIVE_ELSEWHERE (offer takeover)
 * An active session already past its deadline is finalized first, then a new one starts.
 */
async function startSession({ auth, testId, examToken, req }) {
  const { test } = await loadTestForSession(testId, auth);

  let existing = await findActiveSession(auth.userId, test._id);
  if (existing && computeTimeline(existing).expired) {
    await finalizeSession(existing._id, "deadline_expired");
    existing = null;
  }
  if (existing) {
    if (tokenMatches(existing, examToken)) {
      return { status: 200, session: existing };
    }
    throw new ExamError(409, "EXAM_ACTIVE_ELSEWHERE", "This exam is already open in another tab or device.", {
      sessionId: String(existing._id),
    });
  }

  const token = newExamToken();
  const { suprDurationMs, reapDurationMs } = durationsFor(test);
  try {
    const session = await AttemptSession.create({
      userId: auth.userId,
      testId: test._id,
      seasonId: test.seasonId || null,
      isPractice: test.status === "practice",
      userRole: String(auth.role || "student"),
      userEmail: String(auth.email || "").toLowerCase(),
      startedAt: new Date(),
      suprDurationMs,
      reapDurationMs,
      examTokenHash: hashToken(token),
      fingerprint: fingerprintFor(req),
      shuffleSeed: crypto.randomBytes(16).toString("hex"),
      shuffleQuestions: Boolean(test.shuffleQuestions),
      shuffleOptions: Boolean(test.shuffleOptions),
      integrity: {
        mode: (test.integrity && test.integrity.mode) || (test.status === "practice" ? "record" : "warn"),
        warnThreshold: Number((test.integrity && test.integrity.warnThreshold) || 1),
        autoSubmitThreshold: Number((test.integrity && test.integrity.autoSubmitThreshold) || 5),
      },
    });
    return { status: 201, session, examToken: token };
  } catch (err) {
    if (err && err.code === 11000) {
      // A concurrent start won the race; this caller has no binding to it.
      const winner = await findActiveSession(auth.userId, test._id);
      throw new ExamError(409, "EXAM_ACTIVE_ELSEWHERE", "This exam is already open in another tab or device.", {
        sessionId: winner ? String(winner._id) : null,
      });
    }
    throw err;
  }
}

async function loadOwnedSession(sessionId, auth) {
  if (!/^[a-f0-9]{24}$/i.test(String(sessionId || ""))) {
    throw new ExamError(400, "INVALID_SESSION", "Invalid session id.");
  }
  const session = await AttemptSession.findOne({ _id: sessionId, userId: auth.userId });
  if (!session) throw new ExamError(404, "SESSION_NOT_FOUND", "Exam session not found.");
  return session;
}

function assertBinding(session, examToken) {
  if (!tokenMatches(session, examToken)) {
    throw new ExamError(409, "EXAM_ACTIVE_ELSEWHERE", "This exam is open in another tab or device.", {
      sessionId: String(session._id),
    });
  }
}

/** Explicit "continue here": rotates the token (revoking the old one). Deadline and answers are untouched. */
async function takeoverSession({ auth, sessionId, req }) {
  const session = await loadOwnedSession(sessionId, auth);
  if (session.status !== "active") {
    throw new ExamError(409, "SESSION_CLOSED", "This exam session has already ended.", {
      attemptId: session.attemptId ? String(session.attemptId) : null,
    });
  }
  if (computeTimeline(session).expired) {
    const attempt = await finalizeSession(session._id, "deadline_expired");
    throw new ExamError(409, "EXAM_EXPIRED", "Time is over for this exam.", { attemptId: attempt ? String(attempt._id) : null });
  }
  const token = newExamToken();
  const updated = await AttemptSession.findOneAndUpdate(
    { _id: session._id, status: "active" },
    { $set: { examTokenHash: hashToken(token), tokenRotatedAt: new Date() }, $inc: { "integrity.takeovers": 1 } },
    { new: true }
  );
  if (!updated) throw new ExamError(409, "SESSION_CLOSED", "This exam session has already ended.");
  await IntegrityEvent.create({
    sessionId: updated._id,
    userId: updated.userId,
    testId: updated.testId,
    type: "device_takeover",
    counted: false,
    clientAt: new Date(),
    detail: fingerprintFor(req).ipPrefix,
  }).catch(() => null);
  await logAuditEvent({
    actorUserId: auth.userId,
    action: "EXAM_SESSION_TAKEOVER",
    entityType: "AttemptSession",
    entityId: String(updated._id),
    metadata: { testId: String(updated.testId), takeovers: updated.integrity ? updated.integrity.takeovers : 1 },
  });
  return { session: updated, examToken: token };
}

function optionCountsFor(questions) {
  return (questions || []).reduce((acc, q) => {
    acc[String(q.id)] = Array.isArray(q.options) ? q.options.length : 0;
    return acc;
  }, {});
}

async function sessionOptionCounts(session) {
  if (!session.shuffleOptions) return null;
  const snapshot = await getTestRuntimeSnapshot(session.testId);
  return snapshot ? optionCountsFor(snapshot.questions) : null;
}

async function getPaper({ auth, sessionId, examToken }) {
  const session = await loadOwnedSession(sessionId, auth);
  assertBinding(session, examToken);
  if (session.status !== "active") {
    throw new ExamError(409, "SESSION_CLOSED", "This exam session has already ended.", {
      attemptId: session.attemptId ? String(session.attemptId) : null,
    });
  }
  const questions = await getPublicQuestionsForTest(session.testId);
  const ordered = orderQuestions(session, questions || []).map((question) => {
    if (!session.shuffleOptions) return question;
    const perm = optionPermutation(session, question.id, (question.options || []).length);
    return { ...question, options: perm.map((originalIndex) => question.options[originalIndex]) };
  });
  return { session, questions: ordered, optionCounts: optionCountsFor(questions || []) };
}

const progressSchema = z.object({
  seq: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
  answers: z.record(z.union([z.number().int(), z.null()])).optional(),
  timeSpent: z.record(z.number().min(0).max(24 * 60 * 60)).optional(),
  marked: z.array(z.string().max(64)).max(1000).optional(),
  visited: z.array(z.string().max(64)).max(1000).optional(),
  currentQuestionId: z.string().max(64).optional(),
});

/**
 * Validates a progress payload against the test and the session timeline and returns
 * the Mongo update. Throws ExamError for any invalid or out-of-window answer.
 */
async function buildProgressUpdate(session, payload, nowMs) {
  const input = progressSchema.parse(payload || {});
  const snapshot = await getTestRuntimeSnapshot(session.testId);
  if (!snapshot) throw new ExamError(400, "TEST_EMPTY", "Test questions are missing. Please contact admin.");
  const byId = new Map(snapshot.questions.map((q) => [String(q.id), q]));
  const t = computeTimeline(session, nowMs);

  const set = {};
  const unset = {};
  for (const [questionId, value] of Object.entries(input.answers || {})) {
    const question = byId.get(questionId);
    if (!question) throw new ExamError(400, "INVALID_QUESTION", "Answer references a question that is not in this test.");
    const section = question.section === "REAP" ? "REAP" : "SUPR";
    if (section === "SUPR" && (session.suprLockedAt || nowMs > t.suprDeadlineMs + GRACE_MS)) {
      throw new ExamError(409, "SECTION_LOCKED", "SUPR is locked; its answers can no longer change.");
    }
    if (section === "REAP") {
      if (t.reapStartMs === null) throw new ExamError(409, "SECTION_NOT_STARTED", "REAP has not started yet.");
      if (nowMs > t.reapDeadlineMs + GRACE_MS) throw new ExamError(409, "EXAM_EXPIRED", "Time is over for this exam.");
    }
    if (value === null) {
      unset[`answers.${questionId}`] = "";
      continue;
    }
    const optionCount = Array.isArray(question.options) ? question.options.length : 0;
    if (!Number.isInteger(value) || value < 0 || value >= optionCount) {
      throw new ExamError(400, "INVALID_OPTION", "Selected option is out of range for this question.");
    }
    // Stored in the original option order, whatever the student saw.
    set[`answers.${questionId}`] = optionPermutation(session, questionId, optionCount)[value];
  }

  const maxSeconds = Math.ceil((session.suprDurationMs + session.reapDurationMs) / 1000);
  for (const [questionId, seconds] of Object.entries(input.timeSpent || {})) {
    if (!byId.has(questionId)) continue;
    set[`timeSpent.${questionId}`] = Math.min(Math.round(seconds), maxSeconds);
  }
  const knownIds = (ids) => (ids || []).filter((id) => byId.has(id));
  if (input.marked) set.marked = knownIds(input.marked);
  if (input.visited) set.visited = knownIds(input.visited);
  if (input.currentQuestionId && byId.has(input.currentQuestionId)) set.currentQuestionId = input.currentQuestionId;
  return { input, set, unset };
}

async function saveProgress({ auth, sessionId, examToken, payload }) {
  const nowMs = Date.now();
  const session = await loadOwnedSession(sessionId, auth);
  assertBinding(session, examToken);
  if (session.status !== "active") {
    throw new ExamError(409, "SESSION_CLOSED", "This exam session has already ended.", {
      attemptId: session.attemptId ? String(session.attemptId) : null,
    });
  }
  if (computeTimeline(session, nowMs).expired) {
    const attempt = await finalizeSession(session._id, "deadline_expired");
    throw new ExamError(409, "EXAM_EXPIRED", "Time is over for this exam.", { attemptId: attempt ? String(attempt._id) : null });
  }

  const { input, set, unset } = await buildProgressUpdate(session, payload, nowMs);
  const filter = { _id: session._id, status: "active" };
  if (input.seq) {
    filter.lastSeq = { $lt: input.seq };
    set.lastSeq = input.seq;
  }
  set.lastSavedAt = new Date(nowMs);
  const update = { $set: set };
  if (Object.keys(unset).length) update.$unset = unset;
  const updated = await AttemptSession.findOneAndUpdate(filter, update, { new: true });
  if (!updated) {
    // Stale (out-of-order) batch: nothing applied; report current server state.
    const current = await AttemptSession.findById(session._id);
    return { session: current, stale: true };
  }
  return { session: updated, stale: false };
}

/** Locks SUPR and starts REAP at server time (or at the SUPR deadline, if that already passed). */
async function advanceSection({ auth, sessionId, examToken, payload }) {
  let session = await loadOwnedSession(sessionId, auth);
  assertBinding(session, examToken);
  if (payload && (payload.answers || payload.timeSpent || payload.marked || payload.visited)) {
    session = (await saveProgress({ auth, sessionId, examToken, payload })).session;
  }
  if (session.status !== "active") throw new ExamError(409, "SESSION_CLOSED", "This exam session has already ended.");
  const nowMs = Date.now();
  const t = computeTimeline(session, nowMs);
  if (session.suprLockedAt) return { session };
  const reapStartedAt = new Date(Math.min(nowMs, t.suprDeadlineMs));
  const updated = await AttemptSession.findOneAndUpdate(
    { _id: session._id, status: "active", suprLockedAt: null },
    { $set: { suprLockedAt: new Date(nowMs), reapStartedAt } },
    { new: true }
  );
  return { session: updated || (await AttemptSession.findById(session._id)) };
}

async function nextAttemptNumber(userId, testId) {
  return (await Attempt.countDocuments({ userId, testId })) + 1;
}

/**
 * Idempotent server-side finalization: evaluates the server-saved answers and creates
 * exactly one Attempt per session. Safe to call concurrently (submit, sweeper, takeover).
 */
async function finalizeSession(sessionId, reason) {
  const now = new Date();
  let claimed = await AttemptSession.findOneAndUpdate(
    { _id: sessionId, status: "active" },
    { $set: { status: "finalizing", finalizingAt: now, submittedReason: reason } },
    { new: true }
  );
  if (!claimed) {
    claimed = await AttemptSession.findOneAndUpdate(
      { _id: sessionId, status: "finalizing", finalizingAt: { $lt: new Date(now.getTime() - STUCK_FINALIZE_MS) } },
      { $set: { finalizingAt: now } },
      { new: true }
    );
  }
  if (!claimed) {
    // Someone else finalized (or is finalizing); return their attempt once it exists.
    for (let i = 0; i < 30; i += 1) {
      const current = await AttemptSession.findById(sessionId).lean();
      if (!current) return null;
      if (current.attemptId) return Attempt.findById(current.attemptId);
      const existing = await Attempt.findOne({ sessionId });
      if (existing) return existing;
      if (current.status === "active") return finalizeSession(sessionId, reason);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new ExamError(503, "FINALIZE_BUSY", "Your paper is still being submitted. Please retry.");
  }

  const existing = await Attempt.findOne({ sessionId: claimed._id });
  if (existing) {
    await AttemptSession.updateOne(
      { _id: claimed._id },
      { $set: { status: reason === "deadline_expired" ? "expired" : "submitted", attemptId: existing._id, finalizedAt: now } }
    );
    return existing;
  }

  const snapshot = await getTestRuntimeSnapshot(claimed.testId);
  if (!snapshot) throw new ExamError(400, "TEST_EMPTY", "Test questions are missing. Please contact admin.");
  const t = computeTimeline(claimed, now.getTime());
  const answers = mapToObject(claimed.answers);
  const timeSpent = mapToObject(claimed.timeSpent);
  const timeTakenSeconds = Math.max(0, Math.round((Math.min(now.getTime(), t.finalDeadlineMs) - t.startedAtMs) / 1000));

  const evalResult = evaluateAttempt({ test: snapshot.test, questions: snapshot.questions, answers, timeSpent });
  const analysis = buildAttemptAnalysis({ test: snapshot.test, questions: snapshot.questions, evalResult, answers, timeTakenSeconds });

  const base = {
    userId: claimed.userId,
    testId: claimed.testId,
    sessionId: claimed._id,
    isPractice: Boolean(claimed.isPractice),
    submittedReason: reason,
    answers,
    score: evalResult.score,
    accuracy: Number(evalResult.accuracy.toFixed(2)),
    correctCount: evalResult.correctCount,
    wrongCount: evalResult.wrongCount,
    skippedCount: evalResult.skippedCount,
    unattemptedCount: evalResult.unattemptedCount,
    userEmail: claimed.userEmail,
    userRole: claimed.userRole,
    timeTakenSeconds,
    totalTime: timeTakenSeconds,
    answerDetails: evalResult.answerDetails,
    questionReview: evalResult.questionReview,
    sectionScores: evalResult.sectionScores,
    sectionWise: evalResult.sectionWise,
    topicWise: evalResult.topicWise,
    analysis,
    submittedAt: now,
    integrity: {
      mode: (claimed.integrity && claimed.integrity.mode) || "warn",
      violations: Number((claimed.integrity && claimed.integrity.violations) || 0),
      byType: mapToObject(claimed.integrity && claimed.integrity.byType),
      takeovers: Number((claimed.integrity && claimed.integrity.takeovers) || 0),
    },
  };

  let attempt = null;
  let attemptNumber = await nextAttemptNumber(claimed.userId, claimed.testId);
  for (let tries = 0; tries < 5 && !attempt; tries += 1) {
    try {
      attempt = await Attempt.create({ ...base, attemptNumber });
    } catch (err) {
      if (err && err.code === 11000) {
        const bySession = await Attempt.findOne({ sessionId: claimed._id });
        if (bySession) {
          attempt = bySession;
          break;
        }
        attemptNumber += 1;
        continue;
      }
      throw err;
    }
  }
  if (!attempt) throw new ExamError(409, "FINALIZE_CONFLICT", "Could not save attempt. Please retry once.");

  await AttemptSession.updateOne(
    { _id: claimed._id },
    { $set: { status: reason === "deadline_expired" ? "expired" : "submitted", attemptId: attempt._id, finalizedAt: now } }
  );
  invalidateRankCache(claimed.testId);
  // Fire-and-forget: listeners (e.g. post-exam interpretation) never block or fail finalization.
  try {
    domainEvents.emit(EVENTS.ATTEMPT_FINALIZED, { attemptId: String(attempt._id), userId: String(attempt.userId) });
  } catch (_err) {
    // ignore listener errors
  }
  return attempt;
}

/**
 * Student submit. Final answers in the payload are applied only while the timeline allows;
 * after the deadline the server-saved answers are authoritative and the submit is rejected.
 */
async function submitSession({ auth, sessionId, examToken, payload, reason = "submitted" }) {
  const session = await loadOwnedSession(sessionId, auth);
  if (session.attemptId) {
    return { attempt: await Attempt.findById(session.attemptId), replay: true };
  }
  assertBinding(session, examToken);
  if (session.status === "active" && computeTimeline(session).expired) {
    const attempt = await finalizeSession(session._id, "deadline_expired");
    throw new ExamError(409, "EXAM_EXPIRED", "Time is over. Your saved answers were submitted automatically.", {
      attemptId: attempt ? String(attempt._id) : null,
    });
  }
  if (session.status === "active" && payload && (payload.answers || payload.timeSpent)) {
    await saveProgress({ auth, sessionId, examToken, payload: { answers: payload.answers, timeSpent: payload.timeSpent } });
  }
  const attempt = await finalizeSession(session._id, reason);
  return { attempt, replay: false };
}

async function listActiveSessions(auth) {
  const sessions = await AttemptSession.find({ userId: auth.userId, status: "active" }).sort({ startedAt: -1 }).limit(20);
  const live = [];
  for (const session of sessions) {
    if (computeTimeline(session).expired) {
      await finalizeSession(session._id, "deadline_expired").catch(() => null);
      continue;
    }
    live.push(session);
  }
  return live;
}

const integrityEventsSchema = z.object({
  events: z
    .array(
      z.object({
        type: z.enum(IntegrityEvent.INTEGRITY_EVENT_TYPES.filter((type) => type !== "device_takeover")),
        at: z.string().datetime().optional(),
        durationMs: z.number().int().min(0).max(24 * 60 * 60 * 1000).optional(),
        detail: z.string().max(120).optional(),
      })
    )
    .min(1)
    .max(25),
});

// A counted signal of the same type within this window is recorded but not re-counted,
// so one tab switch that fires several browser events counts once.
const COUNT_DEDUPE_MS = 2000;

/**
 * Records browser integrity telemetry. The server keeps the violation count (the client
 * can only add to it). In "strict" mode, exceeding the threshold auto-submits the saved
 * answers; no mode ever invalidates an attempt automatically.
 */
async function recordIntegrityEvents({ auth, sessionId, examToken, payload }) {
  const { events } = integrityEventsSchema.parse(payload || {});
  const session = await loadOwnedSession(sessionId, auth);
  assertBinding(session, examToken);
  if (session.status !== "active") {
    return { session, autoSubmitted: false, attemptId: session.attemptId ? String(session.attemptId) : null };
  }

  const nowMs = Date.now();
  const lastCounted = mapToObject(session.integrity && session.integrity.lastCountedAt);
  const docs = [];
  const inc = {};
  const setLast = {};
  let counted = 0;
  for (const event of events) {
    let isCounted = IntegrityEvent.COUNTED_EVENT_TYPES.has(event.type);
    const lastAt = lastCounted[event.type] ? new Date(lastCounted[event.type]).getTime() : 0;
    if (isCounted && nowMs - lastAt < COUNT_DEDUPE_MS) isCounted = false;
    if (isCounted) {
      counted += 1;
      lastCounted[event.type] = new Date(nowMs);
      setLast[`integrity.lastCountedAt.${event.type}`] = new Date(nowMs);
      inc[`integrity.byType.${event.type}`] = (inc[`integrity.byType.${event.type}`] || 0) + 1;
    }
    docs.push({
      sessionId: session._id,
      userId: session.userId,
      testId: session.testId,
      type: event.type,
      counted: isCounted,
      clientAt: event.at ? new Date(event.at) : null,
      durationMs: event.durationMs || 0,
      detail: event.detail || "",
    });
  }
  await IntegrityEvent.insertMany(docs);

  let updated = session;
  if (counted) {
    inc["integrity.violations"] = counted;
    updated = await AttemptSession.findOneAndUpdate(
      { _id: session._id, status: "active" },
      { $inc: inc, $set: setLast },
      { new: true }
    ) || (await AttemptSession.findById(session._id));
  }

  const integrity = integrityView(updated);
  if (updated.status === "active" && integrity.mode === "strict" && integrity.violations > integrity.autoSubmitThreshold) {
    const attempt = await finalizeSession(updated._id, "integrity_threshold");
    return { session: updated, autoSubmitted: true, attemptId: attempt ? String(attempt._id) : null };
  }
  return { session: updated, autoSubmitted: false, attemptId: null };
}

module.exports = {
  recordIntegrityEvents,
  sessionOptionCounts,
  GRACE_MS,
  ExamError,
  computeTimeline,
  sessionView,
  startSession,
  takeoverSession,
  getPaper,
  saveProgress,
  advanceSection,
  finalizeSession,
  submitSession,
  listActiveSessions,
  tokenMatches,
  hashToken,
};
