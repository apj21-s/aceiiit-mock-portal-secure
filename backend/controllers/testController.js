const { z } = require("zod");

const AppConfig = require("../models/AppConfig");
const Test = require("../models/Test");
const User = require("../models/User");
const Question = require("../models/Question");
const { canAccessTest, getEntitledSeasonIds, isTestAccessible } = require("../services/entitlementService");
const { getActiveSeason } = require("../services/seasonService");
const {
  getCatalogPayload,
  getPublicQuestionsForTest,
  invalidateCatalogCache,
  invalidateTestRuntimeCache,
  getQuestionOfTheDay,
  qotdDateKey,
} = require("../services/testDataService");

function integrityPolicyOf(test) {
  const integrity = (test && test.integrity) || {};
  return {
    mode: integrity.mode || "warn",
    warnThreshold: Number(integrity.warnThreshold || 1),
    autoSubmitThreshold: Number(integrity.autoSubmitThreshold || 5),
  };
}

async function listTests(req, res, next) {
  try {
    const isAdmin = req.auth.role === "admin";
    const [entitledSeasonIds, activeSeason] = await Promise.all([getEntitledSeasonIds(req.auth), getActiveSeason()]);
    const [payload, appConfig] = await Promise.all([
      getCatalogPayload({ isAdmin, entitledSeasonIds, activeSeasonId: activeSeason && activeSeason._id }),
      AppConfig.findOne({ key: "global" }).lean(),
    ]);
    payload.appConfig = {
      ugeeExamDate: appConfig && appConfig.ugeeExamDate ? appConfig.ugeeExamDate : null,
      featuredTestId: appConfig && appConfig.featuredTestId ? String(appConfig.featuredTestId) : "",
      noticeTitle: appConfig && appConfig.noticeTitle ? appConfig.noticeTitle : "",
      noticeBody: appConfig && appConfig.noticeBody ? appConfig.noticeBody : "",
    };
    const qotd = await getQuestionOfTheDay();
    payload.qotd = qotd ? { ...qotd, attempt: await qotdAttemptFor(req.auth.userId, qotd) } : null;
    res.json(payload);
  } catch (err) {
    next(err);
  }
}

async function getTestById(req, res, next) {
  try {
    const test = await Test.findOne({ _id: req.params.id, deletedAt: null })
      .select("title subtitle series type isFree status displayOrder durationMinutes sectionDurations instructions benchmarkScores totalMarks negativeMarks questionIds seasonId shuffleQuestions shuffleOptions integrity updatedAt createdAt")
      .lean();
    if (!test || (test.status !== "live" && req.auth.role !== "admin")) {
      return res.status(404).json({ error: "Test not found" });
    }
    const hasAccess = await canAccessTest(req.auth, test);
    if (!hasAccess) {
      return res.status(402).json({ error: "Buy Test Series" });
    }
    res.json({
      test: {
        id: String(test._id),
        title: test.title,
        subtitle: test.subtitle || "",
        series: test.series || "UGEE 2026",
        seasonId: test.seasonId ? String(test.seasonId) : null,
        type: test.type || "practice",
        isFree: Boolean(test.isFree),
        status: test.status,
        displayOrder: Number.isFinite(Number(test.displayOrder)) ? Number(test.displayOrder) : 100,
        durationMinutes: test.durationMinutes,
        sectionDurations: test.sectionDurations || { SUPR: 60, REAP: 120 },
        instructions: Array.isArray(test.instructions) ? test.instructions : [],
        benchmarkScores: Array.isArray(test.benchmarkScores) ? test.benchmarkScores : [],
        totalMarks: test.totalMarks || 0,
        negativeMarks: test.negativeMarks,
        questionIds: (test.questionIds || []).map((id) => String(id)),
        questionCount: Array.isArray(test.questionIds) ? test.questionIds.length : 0,
        shuffleQuestions: Boolean(test.shuffleQuestions),
        shuffleOptions: Boolean(test.shuffleOptions),
        integrity: integrityPolicyOf(test),
        updatedAt: test.updatedAt,
        createdAt: test.createdAt,
      },
    });
  } catch (err) {
    next(err);
  }
}

// Students receive questions only through an exam session's paper (after start, bound to
// the session). This endpoint is for admins previewing a test.
async function getTestQuestions(req, res, next) {
  try {
    if (req.auth.role !== "admin") {
      return res.status(403).json({ error: "Questions are available once the exam starts.", code: "PAPER_VIA_SESSION_ONLY" });
    }
    const test = await Test.findOne({ _id: req.params.id, deletedAt: null }).select("_id").lean();
    if (!test) return res.status(404).json({ error: "Test not found" });
    const questions = await getPublicQuestionsForTest(req.params.id);
    res.json({ questions: questions || [] });
  } catch (err) {
    next(err);
  }
}

const testInputSchema = z.object({
  title: z.string().min(3).max(120),
  subtitle: z.string().max(160).optional().nullable(),
  series: z.string().min(1).max(40).optional(),
  type: z.enum(["practice", "scheduled"]).optional(),
  isFree: z.boolean().optional(),
  status: z.enum(["draft", "live"]).optional(),
  displayOrder: z.number().int().min(0).max(9999).optional(),
  sectionDurations: z
    .object({
      SUPR: z.number().int().min(1).max(600),
      REAP: z.number().int().min(1).max(600),
    })
    .optional(),
  instructions: z.array(z.string().max(240)).optional(),
  benchmarkScores: z.array(z.number()).optional(),
  questionIds: z.array(z.string()).optional(),
  shuffleQuestions: z.boolean().optional(),
  shuffleOptions: z.boolean().optional(),
  integrity: z
    .object({
      mode: z.enum(["record", "warn", "strict"]),
      warnThreshold: z.number().int().min(1).max(100).optional(),
      autoSubmitThreshold: z.number().int().min(1).max(100).optional(),
    })
    .optional(),
});

async function createTest(req, res, next) {
  try {
    const input = testInputSchema.parse(req.body || {});
    const sectionDurations = input.sectionDurations || { SUPR: 60, REAP: 120 };
    const test = await Test.create({
      title: input.title,
      subtitle: input.subtitle || "",
      series: input.series || "UGEE 2026",
      type: input.type || "practice",
      isFree: Boolean(input.isFree),
      status: input.status || "draft",
      displayOrder: input.displayOrder !== undefined ? input.displayOrder : 100,
      sectionDurations,
      durationMinutes: sectionDurations.SUPR + sectionDurations.REAP,
      instructions: input.instructions || [],
      benchmarkScores: input.benchmarkScores || [],
      questionIds: input.questionIds || [],
      shuffleQuestions: Boolean(input.shuffleQuestions),
      shuffleOptions: Boolean(input.shuffleOptions),
      integrity: input.integrity || undefined,
    });
    invalidateCatalogCache();
    res.locals.auditEntityId = test.id;
    res.status(201).json({ test: test.toJSON() });
  } catch (err) {
    next(err);
  }
}

async function updateTest(req, res, next) {
  try {
    const input = testInputSchema.partial().parse(req.body || {});
    const test = await Test.findById(req.params.id);
    if (!test) return res.status(404).json({ error: "Test not found" });

    if (input.title !== undefined) test.title = input.title;
    if (input.subtitle !== undefined) test.subtitle = input.subtitle || "";
    if (input.series !== undefined) test.series = input.series || "UGEE 2026";
    if (input.type !== undefined) test.type = input.type;
    if (input.isFree !== undefined) test.isFree = Boolean(input.isFree);
    if (input.status !== undefined) test.status = input.status;
    if (input.displayOrder !== undefined) test.displayOrder = input.displayOrder;
    if (input.sectionDurations) {
      test.sectionDurations = input.sectionDurations;
      test.durationMinutes = input.sectionDurations.SUPR + input.sectionDurations.REAP;
    }
    if (input.instructions) test.instructions = input.instructions;
    if (input.benchmarkScores) test.benchmarkScores = input.benchmarkScores;
    if (Array.isArray(input.questionIds)) test.questionIds = input.questionIds;
    if (input.shuffleQuestions !== undefined) test.shuffleQuestions = input.shuffleQuestions;
    if (input.shuffleOptions !== undefined) test.shuffleOptions = input.shuffleOptions;
    if (input.integrity) {
      test.integrity = {
        mode: input.integrity.mode,
        warnThreshold: input.integrity.warnThreshold || (test.integrity && test.integrity.warnThreshold) || 1,
        autoSubmitThreshold: input.integrity.autoSubmitThreshold || (test.integrity && test.integrity.autoSubmitThreshold) || 5,
      };
    }

    await test.save();
    invalidateCatalogCache();
    invalidateTestRuntimeCache(test.id);
    res.json({ test: test.toJSON() });
  } catch (err) {
    next(err);
  }
}

async function deleteTest(req, res, next) {
  try {
    const test = await Test.findById(req.params.id);
    if (!test) return res.status(404).json({ error: "Test not found" });
    test.deletedAt = new Date();
    await test.save();
    invalidateCatalogCache();
    invalidateTestRuntimeCache(test.id);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

// ---------------------------------------------------------------------------
// Question of the Day: one attempt per IST day; the answer is revealed only after it.
// ---------------------------------------------------------------------------
async function qotdResult(questionId, attempt) {
  const question = await Question.findById(questionId).select("correctOption explanation").lean();
  if (!question) return null;
  return {
    date: attempt.date,
    questionId: String(questionId),
    selectedOption: Number(attempt.answeredOpt),
    correct: Number(attempt.answeredOpt) === Number(question.correctOption),
    correctOption: Number(question.correctOption),
    explanation: question.explanation || "",
  };
}

async function qotdAttemptFor(userId, qotd) {
  const user = await User.findById(userId).select("lastQotdAttempt").lean();
  const attempt = user && user.lastQotdAttempt;
  if (!attempt || attempt.date !== qotd.date || attempt.questionId !== qotd.id) return null;
  return qotdResult(qotd.id, attempt);
}

const qotdSchema = z.object({
  questionId: z.string().regex(/^[a-f0-9]{24}$/i, "Invalid question"),
  selectedOption: z.number().int().min(0).max(25),
});

async function submitQotdAttempt(req, res, next) {
  try {
    const { questionId, selectedOption } = qotdSchema.parse(req.body || {});
    const qotd = await getQuestionOfTheDay();
    if (!qotd || qotd.id !== questionId) {
      return res.status(409).json({ error: "This is no longer today's question. Refresh to see the new one.", code: "QOTD_STALE" });
    }
    if (selectedOption >= qotd.options.length) {
      return res.status(400).json({ error: "Selected option is out of range.", code: "INVALID_OPTION" });
    }
    const date = qotdDateKey();
    const question = await Question.findById(questionId).select("correctOption").lean();
    const attempt = {
      date,
      questionId,
      answeredOpt: String(selectedOption),
      correct: Number(selectedOption) === Number(question.correctOption),
    };
    // Atomic one-per-day: only writes if today's attempt isn't recorded yet.
    const update = await User.updateOne(
      { _id: req.auth.userId, "lastQotdAttempt.date": { $ne: date } },
      { $set: { lastQotdAttempt: attempt } }
    );
    if (!update.modifiedCount) {
      const existing = await qotdAttemptFor(req.auth.userId, qotd);
      return res.status(409).json({ error: "You've already answered today's question.", code: "QOTD_ALREADY_ATTEMPTED", result: existing });
    }
    return res.json({ result: await qotdResult(questionId, attempt) });
  } catch (err) {
    next(err);
  }
}

// ---------------------------------------------------------------------------
// Custom practice: a private, server-built paper drawn only from questions the
// student can already access. Scored by the same server-authoritative session flow,
// and excluded from ranks and leaderboards.
// ---------------------------------------------------------------------------
const UNTIMED_SECTION_MINUTES = 600;
const FREE_PRACTICE_LIMIT = 1;

const practiceSchema = z.object({
  subject: z.string().trim().min(1).max(60).default("all"),
  difficulty: z.enum(["all", "easy", "medium", "hard"]).default("all"),
  count: z.coerce.number().int().min(1).max(100).default(10),
  timerMinutes: z.coerce.number().int().min(0).max(300).default(0),
});

function shuffleInPlace(items) {
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

async function createPracticeTest(req, res, next) {
  try {
    const input = practiceSchema.parse(req.body || {});
    const isAdmin = req.auth.role === "admin";
    const [entitledSeasonIds, activeSeason] = await Promise.all([getEntitledSeasonIds(req.auth), getActiveSeason()]);

    if (!isAdmin && entitledSeasonIds.size === 0) {
      const used = await Test.countDocuments({ ownerUserId: req.auth.userId, status: "practice" });
      if (used >= FREE_PRACTICE_LIMIT) {
        return res.status(402).json({ error: "Free accounts include one custom practice session. Buy the test series for unlimited practice.", code: "PRACTICE_LIMIT" });
      }
    }

    const liveTests = await Test.find({ status: "live", deletedAt: null }).select("isFree seasonId questionIds").lean();
    const accessibleIds = new Set();
    liveTests
      .filter((test) => isTestAccessible(test, { isAdmin, entitledSeasonIds, activeSeasonId: activeSeason && activeSeason._id }))
      .forEach((test) => (test.questionIds || []).forEach((id) => accessibleIds.add(String(id))));

    const filter = { _id: { $in: Array.from(accessibleIds) }, deletedAt: null };
    if (input.difficulty !== "all") filter.difficulty = input.difficulty;
    if (input.subject === "SUPR" || input.subject === "REAP") filter.section = input.subject;
    const pool = await Question.find(filter).select("_id section topic").lean();
    const subjectNeedle = input.subject.toLowerCase();
    const matching = input.subject === "all" || input.subject === "SUPR" || input.subject === "REAP"
      ? pool
      : pool.filter((q) => String(q.topic || "").toLowerCase().includes(subjectNeedle));
    const selected = shuffleInPlace(matching.slice()).slice(0, input.count);
    if (!selected.length) {
      return res.status(400).json({ error: "No questions match these practice filters yet.", code: "PRACTICE_EMPTY" });
    }

    const minutes = input.timerMinutes > 0 ? input.timerMinutes : UNTIMED_SECTION_MINUTES;
    const subjectLabel = input.subject === "all" ? "Mixed Subjects" : input.subject;
    const test = await Test.create({
      title: `Practice: ${subjectLabel}`.slice(0, 120),
      subtitle: `${selected.length} Questions • ${input.timerMinutes > 0 ? `${input.timerMinutes} Mins` : "Untimed"}`,
      series: "Practice",
      type: "practice",
      isFree: true,
      isPractice: true,
      status: "practice",
      ownerUserId: req.auth.userId,
      sectionDurations: { SUPR: minutes, REAP: minutes },
      durationMinutes: minutes * 2,
      questionIds: selected.map((q) => q._id),
    });

    return res.status(201).json({
      test: {
        id: String(test._id),
        title: test.title,
        subtitle: test.subtitle,
        series: test.series,
        isPractice: true,
        isFree: true,
        status: "live",
        createdBy: String(req.auth.userId),
        questionIds: [],
        questionCount: selected.length,
        sectionDurations: test.sectionDurations,
        durationMinutes: test.durationMinutes,
        createdAt: test.createdAt,
      },
    });
  } catch (err) {
    next(err);
  }
}

module.exports = { createPracticeTest, listTests, getTestById, getTestQuestions, createTest, updateTest, deleteTest, submitQotdAttempt };
