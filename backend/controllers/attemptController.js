const { isValidObjectId } = require("mongoose");
const { z } = require("zod");

const Attempt = require("../models/Attempt");
const Test = require("../models/Test");
const { canAccessPaperContent } = require("../services/entitlementService");
const { getRankFor, getRanksForAttempts } = require("../services/rankService");
const { getTestRuntimeSnapshot } = require("../services/testDataService");
const { heldResults } = require("../services/liveEventService");
const {
  sessionView,
  startSession,
  takeoverSession,
  getPaper,
  saveProgress,
  advanceSection,
  submitSession,
  listActiveSessions,
  recordIntegrityEvents,
  sessionOptionCounts,
} = require("../services/attemptSessionService");

const EXAM_TOKEN_HEADER = "X-Exam-Token";

const analysisQuestionsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

const ATTEMPT_SUMMARY_FIELDS =
  "testId sessionId attemptNumber score accuracy correctCount wrongCount skippedCount unattemptedCount timeTakenSeconds totalTime submittedAt sectionScores analysis userRole isPractice invalidatedAt submittedReason";

/** Session view with answers expressed in the student's (possibly shuffled) option order. */
async function viewOf(session) {
  return sessionView(session, Date.now(), await sessionOptionCounts(session));
}

function examToken(req) {
  return req.get(EXAM_TOKEN_HEADER) || "";
}

function toAttemptResponse(attempt, rankInfo) {
  const ranking = rankInfo || { rank: 0, percentile: 0 };
  return {
    id: String(attempt._id || attempt.id),
    testId: String(attempt.testId),
    sessionId: attempt.sessionId ? String(attempt.sessionId) : null,
    attemptNumber: attempt.attemptNumber,
    score: attempt.score,
    accuracy: attempt.accuracy,
    rank: ranking.rank,
    percentile: ranking.percentile,
    rankTotal: ranking.total || 0,
    correctCount: attempt.correctCount,
    wrongCount: attempt.wrongCount,
    skippedCount: attempt.skippedCount,
    unattemptedCount: attempt.unattemptedCount || attempt.skippedCount,
    timeTakenSeconds: attempt.timeTakenSeconds,
    totalTime: attempt.totalTime || attempt.timeTakenSeconds,
    submittedAt: attempt.submittedAt,
    submittedReason: attempt.submittedReason || "submitted",
    isPractice: Boolean(attempt.isPractice),
    invalidated: Boolean(attempt.invalidatedAt),
    sectionScores: attempt.sectionScores,
    analysis: attempt.analysis || null,
  };
}

/**
 * A live event's attempt before its results are out: submitted, but no score, rank, sections,
 * analysis or review yet (admins see everything as usual).
 */
function toPendingResponse(attempt, resultsAt) {
  return {
    id: String(attempt._id || attempt.id),
    testId: String(attempt.testId),
    sessionId: attempt.sessionId ? String(attempt.sessionId) : null,
    attemptNumber: attempt.attemptNumber,
    submittedAt: attempt.submittedAt,
    submittedReason: attempt.submittedReason || "submitted",
    isPractice: Boolean(attempt.isPractice),
    invalidated: Boolean(attempt.invalidatedAt),
    resultsPending: true,
    resultsAt: new Date(resultsAt).toISOString(),
    score: null,
    accuracy: null,
    rank: 0,
    percentile: 0,
    rankTotal: 0,
    correctCount: null,
    wrongCount: null,
    skippedCount: null,
    unattemptedCount: null,
    timeTakenSeconds: attempt.timeTakenSeconds,
    totalTime: attempt.totalTime || attempt.timeTakenSeconds,
    sectionScores: null,
    analysis: null,
  };
}

/** resultsAt when this attempt's results are held for this viewer (never for admins). */
async function heldFor(req, attempt) {
  if (req.auth.role === "admin") return null;
  return (await heldResults([attempt.testId])).get(String(attempt.testId)) || null;
}

const RESULTS_HELD = (resultsAt) => ({ error: "Results for this live mock come out at the announced time.", code: "RESULTS_HELD", resultsAt: new Date(resultsAt).toISOString() });

async function respondWithAttempt(res, status, attempt, req) {
  const held = req ? await heldFor(req, attempt) : null;
  if (held) return res.status(status).json({ attempt: toPendingResponse(attempt, held) });
  const rankInfo = await getRankFor(attempt);
  return res.status(status).json({ attempt: toAttemptResponse(attempt, rankInfo) });
}

// ---------------------------------------------------------------------------
// Exam session lifecycle (server-authoritative)
// ---------------------------------------------------------------------------
const startSchema = z.object({ testId: z.string().min(1).max(64) });

async function startAttempt(req, res, next) {
  try {
    const { testId } = startSchema.parse(req.body || {});
    const result = await startSession({ auth: req.auth, testId, examToken: examToken(req), req });
    const body = { session: await viewOf(result.session) };
    if (result.examToken) body.examToken = result.examToken;
    return res.status(result.status).json(body);
  } catch (err) {
    return next(err);
  }
}

async function takeover(req, res, next) {
  try {
    const result = await takeoverSession({ auth: req.auth, sessionId: req.params.id, req });
    return res.json({ session: await viewOf(result.session), examToken: result.examToken });
  } catch (err) {
    return next(err);
  }
}

async function getSessionPaper(req, res, next) {
  try {
    const { session, questions, optionCounts } = await getPaper({ auth: req.auth, sessionId: req.params.id, examToken: examToken(req) });
    return res.json({ session: sessionView(session, Date.now(), session.shuffleOptions ? optionCounts : null), questions });
  } catch (err) {
    return next(err);
  }
}

async function saveSessionProgress(req, res, next) {
  try {
    const { session, stale } = await saveProgress({
      auth: req.auth,
      sessionId: req.params.id,
      examToken: examToken(req),
      payload: req.body,
    });
    return res.json({ session: await viewOf(session), stale });
  } catch (err) {
    return next(err);
  }
}

async function advance(req, res, next) {
  try {
    const { session } = await advanceSection({
      auth: req.auth,
      sessionId: req.params.id,
      examToken: examToken(req),
      payload: req.body,
    });
    return res.json({ session: await viewOf(session) });
  } catch (err) {
    return next(err);
  }
}

async function postIntegrityEvents(req, res, next) {
  try {
    const result = await recordIntegrityEvents({
      auth: req.auth,
      sessionId: req.params.id,
      examToken: examToken(req),
      payload: req.body,
    });
    const integrity = result.session && result.session.integrity ? result.session.integrity : {};
    return res.json({
      integrity: {
        mode: integrity.mode || "warn",
        warnThreshold: Number(integrity.warnThreshold || 1),
        autoSubmitThreshold: Number(integrity.autoSubmitThreshold || 5),
        violations: Number(integrity.violations || 0),
      },
      autoSubmitted: result.autoSubmitted,
      attemptId: result.attemptId,
    });
  } catch (err) {
    return next(err);
  }
}

const submitSchema = z.object({
  sessionId: z.string().min(1).max(64),
  answers: z.record(z.union([z.number().int(), z.null()])).optional(),
  timeSpent: z.record(z.number().min(0).max(24 * 60 * 60)).optional(),
});

async function submitAttempt(req, res, next) {
  try {
    const input = submitSchema.parse(req.body || {});
    const { attempt, replay } = await submitSession({
      auth: req.auth,
      sessionId: input.sessionId,
      examToken: examToken(req),
      payload: input,
    });
    return respondWithAttempt(res, replay ? 200 : 201, attempt, req);
  } catch (err) {
    return next(err);
  }
}

/** Quit/restart: the session is submitted with its saved answers (it still counts as an attempt). */
async function abandonAttempt(req, res, next) {
  try {
    const { attempt } = await submitSession({
      auth: req.auth,
      sessionId: req.params.id,
      examToken: examToken(req),
      payload: req.body,
      reason: "abandoned",
    });
    return respondWithAttempt(res, 200, attempt, req);
  } catch (err) {
    return next(err);
  }
}

async function listActive(req, res, next) {
  try {
    const sessions = await listActiveSessions(req.auth);
    const views = [];
    for (const session of sessions) views.push(await viewOf(session));
    return res.json({ sessions: views });
  } catch (err) {
    return next(err);
  }
}

// ---------------------------------------------------------------------------
// Results (rank and percentile are computed on read)
// ---------------------------------------------------------------------------
async function listAttempts(req, res, next) {
  try {
    const attempts = await Attempt.find({ userId: req.auth.userId })
      .select(ATTEMPT_SUMMARY_FIELDS)
      .sort({ submittedAt: -1 })
      .limit(200)
      .lean();
    const [ranks, held] = await Promise.all([
      getRanksForAttempts(attempts),
      req.auth.role === "admin" ? new Map() : heldResults(attempts.map((a) => a.testId)),
    ]);
    res.json({
      attempts: attempts.map((attempt) => (held.has(String(attempt.testId))
        ? toPendingResponse(attempt, held.get(String(attempt.testId)))
        : toAttemptResponse(attempt, ranks.get(String(attempt._id))))),
    });
  } catch (err) {
    next(err);
  }
}

const REVIEW_LOCKED = { error: "Question review for this paid paper needs an active Pro Test Series. Your score and analysis stay available.", code: "PAYMENT_REQUIRED" };

/** Question-by-question review shows paid questions and answers: it needs current access. */
async function reviewAllowed(req, attempt) {
  if (req.auth.role === "admin") return true;
  const test = await Test.findById(attempt.testId).select("isFree isPractice seasonId status questionIds").lean();
  return !test || canAccessPaperContent(req.auth, test);
}

function ownedQuery(req) {
  return req.auth.role === "admin"
    ? { _id: req.params.id }
    : { _id: req.params.id, userId: req.auth.userId };
}

function paginate(allQuestions, page, limit) {
  const total = allQuestions.length;
  const start = (page - 1) * limit;
  const items = allQuestions.slice(start, start + limit);
  return {
    items,
    pagination: {
      page,
      limit,
      total,
      pages: total ? Math.ceil(total / limit) : 1,
      hasMore: start + items.length < total,
    },
  };
}

/**
 * Full marks for the paper as it was taken: summed from the attempt's own question snapshot
 * (so later edits to questions don't change it), falling back to the test's current paper
 * for very old attempts without a snapshot.
 */
async function maxScoreFor(attempt) {
  const [row] = await Attempt.aggregate([
    { $match: { _id: attempt._id } },
    {
      $project: {
        count: { $size: { $ifNull: ["$questionReview", []] } },
        max: {
          $sum: {
            $map: {
              input: { $ifNull: ["$questionReview", []] },
              as: "q",
              in: { $convert: { input: "$$q.marks", to: "double", onError: 0, onNull: 0 } },
            },
          },
        },
      },
    },
  ]);
  if (row && row.count) return row.max;
  const snapshot = await getTestRuntimeSnapshot(attempt.testId).catch(() => null);
  const questions = snapshot && Array.isArray(snapshot.questions) ? snapshot.questions : [];
  return questions.length ? questions.reduce((sum, q) => sum + Number(q.marks || 0), 0) : null;
}

async function getResult(req, res, next) {
  try {
    if (!isValidObjectId(req.params.id)) {
      return res.status(400).json({ error: "Invalid result id" });
    }
    const includeReview = String(req.query.includeReview || "").trim() === "1";
    const { page, limit } = analysisQuestionsQuerySchema.parse(req.query || {});
    const attempt = await Attempt.findOne(ownedQuery(req))
      .select(includeReview ? `${ATTEMPT_SUMMARY_FIELDS} questionReview` : ATTEMPT_SUMMARY_FIELDS)
      .lean();
    if (!attempt) return res.status(404).json({ error: "Result not found" });
    const held = await heldFor(req, attempt);
    if (held) return res.json({ attempt: toPendingResponse(attempt, held) });

    const payload = { attempt: toAttemptResponse(attempt, await getRankFor(attempt)) };
    payload.attempt.maxScore = await maxScoreFor(attempt);
    if (includeReview) {
      if (!(await reviewAllowed(req, attempt))) return res.status(402).json(REVIEW_LOCKED);
      const { items, pagination } = paginate(Array.isArray(attempt.questionReview) ? attempt.questionReview : [], page, limit);
      payload.questions = items;
      payload.pagination = pagination;
    }
    res.json(payload);
  } catch (err) {
    next(err);
  }
}

/**
 * Where the time went, from the attempt's own per-question snapshot: per section, the share of
 * time spent on wrong answers, the slowest questions, and a strip of [seconds, status] per
 * question in paper order (c = correct, w = wrong, s = skipped). Null without timing data.
 */
function buildTimeInsights(review) {
  const items = (Array.isArray(review) ? review : []).map((q, i) => ({
    number: i + 1,
    section: q && q.section === "REAP" ? "REAP" : "SUPR",
    topic: (q && q.topic) || "",
    status: q && (q.status === "correct" || q.status === "wrong") ? q.status : "skipped",
    seconds: Math.max(0, Math.round(Number(q && q.timeSpent) || 0)),
  }));
  if (!items.some((i) => i.seconds > 0)) return null;
  const avg = (list) => (list.length ? Math.round(list.reduce((s, i) => s + i.seconds, 0) / list.length) : null);
  const sections = {};
  ["SUPR", "REAP"].forEach((key) => {
    const list = items.filter((i) => i.section === key);
    if (!list.length) return;
    const total = list.reduce((s, i) => s + i.seconds, 0);
    const onWrong = list.filter((i) => i.status === "wrong").reduce((s, i) => s + i.seconds, 0);
    sections[key] = {
      questions: list.length,
      totalSeconds: total,
      avgCorrectSeconds: avg(list.filter((i) => i.status === "correct")),
      avgWrongSeconds: avg(list.filter((i) => i.status === "wrong")),
      wrongTimePct: total ? Math.round((onWrong / total) * 100) : 0,
    };
  });
  const total = items.reduce((s, i) => s + i.seconds, 0);
  const onWrong = items.filter((i) => i.status === "wrong").reduce((s, i) => s + i.seconds, 0);
  return {
    totalSeconds: total,
    wrongSeconds: onWrong,
    wrongTimePct: total ? Math.round((onWrong / total) * 100) : 0,
    sections,
    slowest: items.filter((i) => i.seconds > 0).sort((a, b) => b.seconds - a.seconds).slice(0, 5),
    strip: items.map((i) => [i.seconds, i.status.charAt(0), i.section === "REAP" ? 1 : 0]),
  };
}

async function getAnalysisSummary(req, res, next) {
  try {
    if (!isValidObjectId(req.params.id)) {
      return res.status(400).json({ error: "Invalid analysis id" });
    }
    const attempt = await Attempt.findOne(ownedQuery(req))
      .select(`${ATTEMPT_SUMMARY_FIELDS} userEmail sectionWise topicWise questionReview.section questionReview.topic questionReview.status questionReview.timeSpent`)
      .lean();
    if (!attempt) {
      return res.status(404).json({ error: "Analysis not found" });
    }
    const held = await heldFor(req, attempt);
    if (held) return res.status(403).json(RESULTS_HELD(held));
    const rankInfo = await getRankFor(attempt);
    return res.json({
      summary: {
        id: String(attempt._id),
        testId: String(attempt.testId),
        userEmail: attempt.userEmail || "",
        attemptNumber: attempt.attemptNumber,
        score: attempt.score,
        correctCount: attempt.correctCount,
        wrongCount: attempt.wrongCount,
        skippedCount: attempt.skippedCount,
        unattemptedCount: attempt.unattemptedCount || attempt.skippedCount,
        accuracy: attempt.accuracy,
        rank: rankInfo.rank,
        percentile: rankInfo.percentile,
        totalTime: attempt.totalTime || attempt.timeTakenSeconds,
        submittedAt: attempt.submittedAt,
        sectionWise: attempt.sectionWise || null,
        topicWise: attempt.topicWise || [],
        analysis: attempt.analysis || null,
        timeInsights: buildTimeInsights(attempt.questionReview),
      },
    });
  } catch (err) {
    next(err);
  }
}

async function getAnalysisQuestions(req, res, next) {
  try {
    if (!isValidObjectId(req.params.id)) {
      return res.status(400).json({ error: "Invalid analysis id" });
    }
    const { page, limit } = analysisQuestionsQuerySchema.parse(req.query || {});
    const attempt = await Attempt.findOne(ownedQuery(req)).select("questionReview testId").lean();
    if (!attempt) {
      return res.status(404).json({ error: "Analysis not found" });
    }
    const held = await heldFor(req, attempt);
    if (held) return res.status(403).json(RESULTS_HELD(held));
    if (!(await reviewAllowed(req, attempt))) return res.status(402).json(REVIEW_LOCKED);
    const { items, pagination } = paginate(Array.isArray(attempt.questionReview) ? attempt.questionReview : [], page, limit);
    return res.json({ questions: items, pagination });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  startAttempt,
  takeover,
  getSessionPaper,
  saveSessionProgress,
  advance,
  submitAttempt,
  abandonAttempt,
  listActive,
  postIntegrityEvents,
  getResult,
  listAttempts,
  getAnalysisSummary,
  getAnalysisQuestions,
  toAttemptResponse,
};
