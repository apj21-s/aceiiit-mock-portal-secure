const { isValidObjectId } = require("mongoose");
const { z } = require("zod");

const Attempt = require("../models/Attempt");
const { evaluateAttempt } = require("../services/evaluationService");
const { computeRankAndPercentile } = require("../services/rankService");
const { paidSheetService } = require("../services/paidSheetService");
const { getTestRuntimeSnapshot } = require("../services/testDataService");
const { buildAttemptAnalysis } = require("../services/attemptAnalysisService");

const submitSchema = z.object({
  testId: z.string().min(1),
  answers: z.record(z.union([z.number(), z.null()])).optional(),
  timeSpent: z.record(z.number().int().min(0).max(60 * 60 * 8)).optional(),
  timeTakenSeconds: z.number().int().min(0).max(60 * 60 * 8).optional(),
});

const analysisQuestionsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

function toAttemptResponse(attempt) {
  return {
    id: String(attempt._id || attempt.id),
    testId: String(attempt.testId),
    attemptNumber: attempt.attemptNumber,
    score: attempt.score,
    accuracy: attempt.accuracy,
    rank: attempt.rank,
    percentile: attempt.percentile,
    correctCount: attempt.correctCount,
    wrongCount: attempt.wrongCount,
    skippedCount: attempt.skippedCount,
    unattemptedCount: attempt.unattemptedCount || attempt.skippedCount,
    timeTakenSeconds: attempt.timeTakenSeconds,
    totalTime: attempt.totalTime || attempt.timeTakenSeconds,
    submittedAt: attempt.submittedAt,
    sectionScores: attempt.sectionScores,
    analysis: attempt.analysis || null,
  };
}

async function listAttempts(req, res, next) {
  try {
    const userId = req.auth.userId;
    const attempts = await Attempt.find({ userId })
      .select("testId attemptNumber score accuracy rank percentile correctCount wrongCount skippedCount unattemptedCount timeTakenSeconds totalTime submittedAt sectionScores analysis")
      .sort({ submittedAt: -1 })
      .limit(200)
      .lean();

    res.json({ attempts: attempts.map(toAttemptResponse) });
  } catch (err) {
    next(err);
  }
}

async function getResult(req, res, next) {
  try {
    if (!isValidObjectId(req.params.id)) {
      return res.status(400).json({ error: "Invalid result id" });
    }

    const query = req.auth.role === "admin"
      ? { _id: req.params.id }
      : { _id: req.params.id, userId: req.auth.userId };

    const attempt = await Attempt.findOne(query)
      .select("testId attemptNumber score accuracy rank percentile correctCount wrongCount skippedCount unattemptedCount timeTakenSeconds totalTime submittedAt sectionScores analysis")
      .lean();

    if (!attempt) return res.status(404).json({ error: "Result not found" });
    if (Number(attempt.rank || 0) === 0 && Number(attempt.percentile || 0) === 0) {
      computeRankAndPercentile({
        testId: attempt.testId,
        attemptNumber: attempt.attemptNumber,
        attemptId: attempt._id,
        score: attempt.score,
        timeTakenSeconds: attempt.timeTakenSeconds,
        submittedAt: attempt.submittedAt,
      })
        .then((repair) => Attempt.updateOne(
          { _id: attempt._id },
          { $set: { rank: repair.rank, percentile: repair.percentile } }
        ))
        .catch(() => {});
    }
    res.json({ attempt: toAttemptResponse(attempt) });
  } catch (err) {
    next(err);
  }
}

async function submitAttempt(req, res, next) {
  try {
    const startedAtMs = Date.now();
    const userId = req.auth.userId;
    const { testId, answers, timeSpent, timeTakenSeconds } = submitSchema.parse(req.body || {});

    const runtimeSnapshot = await getTestRuntimeSnapshot(testId);
    const test = runtimeSnapshot && runtimeSnapshot.test;
    if (!test || test.status !== "live") return res.status(404).json({ error: "Test not found" });

    const paidOk = Boolean(req.auth.isPaid) || paidSheetService.isVerified(req.auth.email);
    if (!test.isFree && !paidOk && req.auth.role !== "admin") {
      return res.status(402).json({ error: "Buy Test Series" });
    }

    const questions = runtimeSnapshot.questions || [];
    if (!questions.length || questions.length !== (test.questionIds || []).length) {
      return res.status(400).json({ error: "Test questions are missing. Please contact admin." });
    }

    const safeAnswers = answers || {};
    const evalResult = evaluateAttempt({
      test,
      questions,
      answers: safeAnswers,
      timeSpent: timeSpent || {},
    });

    const analysis = buildAttemptAnalysis({
      test,
      questions,
      evalResult,
      answers: safeAnswers,
      timeTakenSeconds: Number(timeTakenSeconds || 0),
    });

    const submittedAt = new Date();
    const basePayload = {
      userId,
      testId,
      answers: safeAnswers,
      score: evalResult.score,
      accuracy: Number(evalResult.accuracy.toFixed(2)),
      correctCount: evalResult.correctCount,
      wrongCount: evalResult.wrongCount,
      skippedCount: evalResult.skippedCount,
      unattemptedCount: evalResult.unattemptedCount,
      userEmail: String(req.auth.email || "").trim().toLowerCase(),
      userRole: String(req.auth.role || "student").trim().toLowerCase(),
      timeTakenSeconds: Number(timeTakenSeconds || evalResult.totalTrackedTimeSeconds || 0),
      totalTime: Number(timeTakenSeconds || evalResult.totalTrackedTimeSeconds || 0),
      answerDetails: evalResult.answerDetails,
      questionReview: evalResult.questionReview,
      sectionScores: evalResult.sectionScores,
      sectionWise: evalResult.sectionWise,
      topicWise: evalResult.topicWise,
      analysis,
      submittedAt,
    };

    let attemptNumber = (await Attempt.countDocuments({ userId, testId })) + 1;
    let attempt = null;

    for (let tries = 0; tries < 3 && !attempt; tries += 1) {
      try {
        attempt = await Attempt.create({
          ...basePayload,
          attemptNumber,
        });
      } catch (err) {
        if (err && err.code === 11000) {
          attemptNumber += 1;
          continue;
        }
        throw err;
      }
    }

    if (!attempt) {
      return res.status(409).json({ error: "Could not save attempt. Please retry once." });
    }

    const rankPayload = await computeRankAndPercentile({
      testId,
      attemptNumber,
      attemptId: attempt._id,
      score: attempt.score,
      timeTakenSeconds: attempt.timeTakenSeconds,
      submittedAt: attempt.submittedAt,
    });

    attempt.rank = rankPayload.rank;
    attempt.percentile = rankPayload.percentile;
    await Attempt.updateOne(
      { _id: attempt._id },
      { $set: { rank: rankPayload.rank, percentile: rankPayload.percentile } }
    );

    const elapsedMs = Date.now() - startedAtMs;
    if (elapsedMs > 500) {
      // eslint-disable-next-line no-console
      console.warn("Slow submitAttempt", {
        userId: String(userId),
        testId: String(testId),
        attemptNumber,
        elapsedMs,
      });
    }

    res.status(201).json({ attempt: toAttemptResponse(attempt) });
  } catch (err) {
    next(err);
  }
}

async function getAnalysisSummary(req, res, next) {
  try {
    if (!isValidObjectId(req.params.id)) {
      return res.status(400).json({ error: "Invalid analysis id" });
    }

    const query = req.auth.role === "admin"
      ? { _id: req.params.id }
      : { _id: req.params.id, userId: req.auth.userId };

    const attempt = await Attempt.findOne(query)
      .select("testId userEmail attemptNumber score correctCount wrongCount skippedCount unattemptedCount accuracy rank percentile timeTakenSeconds totalTime submittedAt sectionWise topicWise analysis")
      .lean();

    if (!attempt) {
      return res.status(404).json({ error: "Analysis not found" });
    }

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
        rank: attempt.rank,
        percentile: attempt.percentile,
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
    const query = req.auth.role === "admin"
      ? { _id: req.params.id }
      : { _id: req.params.id, userId: req.auth.userId };

    const attempt = await Attempt.findOne(query)
      .select("questionReview")
      .lean();

    if (!attempt) {
      return res.status(404).json({ error: "Analysis not found" });
    }

    const allQuestions = Array.isArray(attempt.questionReview) ? attempt.questionReview : [];
    const total = allQuestions.length;
    const start = (page - 1) * limit;
    const items = allQuestions.slice(start, start + limit);

    return res.json({
      questions: items,
      pagination: {
        page,
        limit,
        total,
        pages: total ? Math.ceil(total / limit) : 1,
        hasMore: start + items.length < total,
      },
    });
  } catch (err) {
    next(err);
  }
}

module.exports = { submitAttempt, getResult, listAttempts, getAnalysisSummary, getAnalysisQuestions };
