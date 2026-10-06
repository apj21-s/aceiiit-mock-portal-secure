const { z } = require("zod");

const AppConfig = require("../models/AppConfig");
const Test = require("../models/Test");
const User = require("../models/User");
const { canAccessTest } = require("../services/entitlementService");
const {
  getCatalogPayload,
  getPublicQuestionsForTest,
  invalidateCatalogCache,
  invalidateTestRuntimeCache,
  getQuestionOfTheDay,
} = require("../services/testDataService");

async function checkReqAccess(req, test = null) {
  if (!req || !req.auth) return false;
  if (req.auth.role === "admin") return true;
  if (!test) {
    return req.auth.isPaid || Boolean(req.auth.role === "admin");
  }
  return canAccessTest(req.auth, test);
}

async function listTests(req, res, next) {
  try {
    const paidOk = await checkReqAccess(req);
    const [payload, appConfig] = await Promise.all([
      getCatalogPayload({
        paidOk,
        isAdmin: req.auth && req.auth.role === "admin",
      }),
      AppConfig.findOne({ key: "global" }).lean(),
    ]);
    payload.appConfig = {
      ugeeExamDate: appConfig && appConfig.ugeeExamDate ? appConfig.ugeeExamDate : null,
      featuredTestId: appConfig && appConfig.featuredTestId ? String(appConfig.featuredTestId) : "",
      noticeTitle: appConfig && appConfig.noticeTitle ? appConfig.noticeTitle : "",
      noticeBody: appConfig && appConfig.noticeBody ? appConfig.noticeBody : "",
    };
    payload.qotd = await getQuestionOfTheDay();
    res.json(payload);
  } catch (err) {
    next(err);
  }
}

async function getTestById(req, res, next) {
  try {
    const test = await Test.findOne({ _id: req.params.id, deletedAt: null })
      .select("title subtitle series type isFree status displayOrder durationMinutes sectionDurations instructions benchmarkScores totalMarks negativeMarks questionIds seasonId updatedAt createdAt")
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
        updatedAt: test.updatedAt,
        createdAt: test.createdAt,
      },
    });
  } catch (err) {
    next(err);
  }
}

async function getTestQuestions(req, res, next) {
  try {
    const test = await Test.findOne({ _id: req.params.id, deletedAt: null })
      .select("isFree status seasonId")
      .lean();
    if (!test || (test.status !== "live" && req.auth.role !== "admin")) {
      return res.status(404).json({ error: "Test not found" });
    }
    const hasAccess = await canAccessTest(req.auth, test);
    if (!hasAccess) {
      return res.status(402).json({ error: "Buy Test Series" });
    }

    const questions = await getPublicQuestionsForTest(req.params.id);
    if (!questions) {
      return res.status(404).json({ error: "Test not found" });
    }

    res.json({ questions });
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
    });
    invalidateCatalogCache();
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

async function submitQotdAttempt(req, res, next) {
  try {
    const { date, answeredOpt } = req.body || {};
    if (!date || answeredOpt === undefined) {
      return res.status(400).json({ error: "Missing date or answeredOpt" });
    }
    const user = await User.findById(req.auth.id);
    if (!user) return res.status(404).json({ error: "User not found" });

    user.lastQotdAttempt = {
      date: String(date),
      answeredOpt: String(answeredOpt)
    };
    await user.save();
    
    res.json({ ok: true, lastQotdAttempt: user.lastQotdAttempt });
  } catch (err) {
    next(err);
  }
}

module.exports = { listTests, getTestById, getTestQuestions, createTest, updateTest, deleteTest, submitQotdAttempt };
