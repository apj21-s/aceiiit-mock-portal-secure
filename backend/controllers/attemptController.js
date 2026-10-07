const { isValidObjectId } = require("mongoose");
const { z } = require("zod");

const Attempt = require("../models/Attempt");
const { getRankFor, getRanksForAttempts } = require("../services/rankService");
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

async function respondWithAttempt(res, status, attempt) {
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
    return respondWithAttempt(res, replay ? 200 : 201, attempt);
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
    return respondWithAttempt(res, 200, attempt);
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
    const ranks = await getRanksForAttempts(attempts);
    res.json({ attempts: attempts.map((attempt) => toAttemptResponse(attempt, ranks.get(String(attempt._id)))) });
  } catch (err) {
    next(err);
  }
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

    const payload = { attempt: toAttemptResponse(attempt, await getRankFor(attempt)) };
    if (includeReview) {
      const { items, pagination } = paginate(Array.isArray(attempt.questionReview) ? attempt.questionReview : [], page, limit);
      payload.questions = items;
      payload.pagination = pagination;
    }
    res.json(payload);
  } catch (err) {
    next(err);
  }
}

async function getAnalysisSummary(req, res, next) {
  try {
    if (!isValidObjectId(req.params.id)) {
      return res.status(400).json({ error: "Invalid analysis id" });
    }
    const attempt = await Attempt.findOne(ownedQuery(req))
      .select(`${ATTEMPT_SUMMARY_FIELDS} userEmail sectionWise topicWise`)
      .lean();
    if (!attempt) {
      return res.status(404).json({ error: "Analysis not found" });
    }
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
    const attempt = await Attempt.findOne(ownedQuery(req)).select("questionReview").lean();
    if (!attempt) {
      return res.status(404).json({ error: "Analysis not found" });
    }
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
