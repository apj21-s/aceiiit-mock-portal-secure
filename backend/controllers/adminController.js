const mongoose = require("mongoose");
const { z } = require("zod");

const Attempt = require("../models/Attempt");
const AppConfig = require("../models/AppConfig");
const Question = require("../models/Question");
const Test = require("../models/Test");
const User = require("../models/User");
const { invalidateAllTestCaches, invalidateCatalogCache, invalidateTestRuntimeCache } = require("../services/testDataService");
const { uploadBufferToCloudinary } = require("../utils/uploadToCloudinary");

const NON_ADMIN_ATTEMPT_FILTER = {
  $or: [
    { userRole: { $exists: false } },
    { userRole: { $ne: "admin" } },
  ],
};

const questionInputSchema = z.object({
  section: z.enum(["REAP", "SUPR"]),
  topic: z.string().min(1).max(80),
  difficulty: z.enum(["easy", "medium", "hard"]).optional(),
  prompt: z.string().min(1),
  passage: z.string().optional(),
  imageUrls: z.array(z.string()).optional(),
  options: z.array(z.string()).min(2).max(8),
  correctOption: z.number().int().min(0).max(7),
  explanation: z.string().optional(),
  marks: z.number().optional(),
  negativeMarks: z.number().optional(),
});

function parseMaybeJson(value, fallback) {
  try {
    if (value === undefined || value === null) return fallback;
    if (typeof value === "object") return value;
    const text = String(value).trim();
    if (!text) return fallback;
    return JSON.parse(text);
  } catch (_err) {
    return fallback;
  }
}

function normalizeOptions(body) {
  const parsed = parseMaybeJson(body.options, null);
  if (Array.isArray(parsed)) {
    return parsed.map((v) => String(v ?? ""));
  }
  const options = [];
  for (let i = 0; i < 8; i += 1) {
    const key = `option${i}`;
    if (body[key] !== undefined) options.push(String(body[key] ?? ""));
  }
  return options.filter((v) => String(v).trim().length);
}

function normalizeImageUrls(body) {
  const parsed = parseMaybeJson(body.imageUrls, null);
  if (Array.isArray(parsed)) {
    return parsed
      .map((v) => String(v ?? "").trim())
      .filter(Boolean)
      .filter((url) => /^https?:\/\//i.test(url));
  }
  if (typeof body.imageUrls === "string") {
    return String(body.imageUrls)
      .split(/[\r\n,]/)
      .map((s) => s.trim())
      .filter(Boolean)
      .filter((url) => /^https?:\/\//i.test(url));
  }
  return [];
}

function normalizeQuestionPayload(body) {
  const source = body || {};
  const mapped = {};
  if (Object.prototype.hasOwnProperty.call(source, "section")) {
    mapped.section = String(source.section || "").toUpperCase();
  }
  if (Object.prototype.hasOwnProperty.call(source, "topic")) {
    mapped.topic = source.topic;
  }
  if (Object.prototype.hasOwnProperty.call(source, "difficulty")) {
    mapped.difficulty = source.difficulty;
  }
  if (Object.prototype.hasOwnProperty.call(source, "prompt")) {
    mapped.prompt = source.prompt;
  }
  if (Object.prototype.hasOwnProperty.call(source, "passage")) {
    mapped.passage = source.passage;
  }
  if (Object.prototype.hasOwnProperty.call(source, "imageUrls")) {
    mapped.imageUrls = normalizeImageUrls(source);
  }
  const hasOptions =
    Object.prototype.hasOwnProperty.call(source, "options") ||
    Object.keys(source).some((k) => /^option\d+$/.test(k));
  if (hasOptions) {
    mapped.options = normalizeOptions(source);
  }
  if (Object.prototype.hasOwnProperty.call(source, "correctOption")) {
    mapped.correctOption = Number(source.correctOption);
  }
  if (Object.prototype.hasOwnProperty.call(source, "explanation")) {
    mapped.explanation = source.explanation;
  }
  if (Object.prototype.hasOwnProperty.call(source, "marks")) {
    mapped.marks = Number(source.marks);
  }
  if (Object.prototype.hasOwnProperty.call(source, "negativeMarks")) {
    mapped.negativeMarks = Number(source.negativeMarks);
  }
  // Remove NaN values so zod partial parses won't choke.
  Object.keys(mapped).forEach((key) => {
    if (Number.isNaN(mapped[key])) delete mapped[key];
  });
  return mapped;
}

function getSectionDefaultMarking(section) {
  const normalized = String(section || "SUPR").trim().toUpperCase() === "REAP" ? "REAP" : "SUPR";
  return normalized === "REAP"
    ? { marks: 2, negativeMarks: -0.5 }
    : { marks: 1, negativeMarks: -0.25 };
}

function extractUploadedQuestionFiles(req) {
  const files = [];
  if (req && req.file && req.file.buffer) {
    files.push(req.file);
  }
  if (req && req.files) {
    if (Array.isArray(req.files)) {
      req.files.forEach((file) => {
        if (file && file.buffer) files.push(file);
      });
    } else {
      ["image", "images"].forEach((fieldName) => {
        const fieldFiles = req.files[fieldName];
        if (Array.isArray(fieldFiles)) {
          fieldFiles.forEach((file) => {
            if (file && file.buffer) files.push(file);
          });
        }
      });
    }
  }
  return files;
}

async function uploadQuestionImages(req) {
  const files = extractUploadedQuestionFiles(req);
  if (!files.length) return [];

  const uploadedUrls = [];
  for (const file of files) {
    const uploaded = await uploadBufferToCloudinary(file.buffer, {
      folder: "ugee-questions",
      resource_type: "image",
    });
    if (uploaded && uploaded.secure_url) {
      uploadedUrls.push(uploaded.secure_url);
    }
  }
  return uploadedUrls;
}

async function recalculateTestsMetadata(testIds) {
  const uniqueIds = Array.from(new Set((testIds || []).map((id) => String(id || "")).filter(Boolean)));
  if (!uniqueIds.length) return;

  const tests = await Test.find({ _id: { $in: uniqueIds }, deletedAt: null })
    .select("_id questionIds")
    .lean();
  if (!tests.length) return;

  const allQuestionIds = Array.from(
    new Set(
      tests.flatMap((test) => (Array.isArray(test.questionIds) ? test.questionIds.map((id) => String(id)) : []))
    )
  );

  const questions = allQuestionIds.length
    ? await Question.find({ _id: { $in: allQuestionIds }, deletedAt: null })
        .select("marks")
        .lean()
    : [];

  const marksById = questions.reduce((acc, question) => {
    acc[String(question._id)] = Number.isFinite(Number(question.marks)) ? Number(question.marks) : 0;
    return acc;
  }, {});

  await Promise.all(
    tests.map((test) => {
      const totalMarks = (test.questionIds || []).reduce((sum, id) => sum + Number(marksById[String(id)] || 0), 0);
      return Test.updateOne(
        { _id: test._id, deletedAt: null },
        { $set: { totalMarks, updatedAt: new Date() } }
      );
    })
  );
}

async function snapshot(req, res, next) {
  try {
    const [tests, questions, attempts, users, userCount, appConfig] = await Promise.all([
      Test.find({ deletedAt: null })
        .select("title subtitle series type isFree status displayOrder durationMinutes sectionDurations instructions benchmarkScores questionIds createdAt updatedAt")
        .sort({ displayOrder: 1, createdAt: 1 })
        .lean(),
      Question.find({ deletedAt: null })
        .select("section topic difficulty prompt passage imageUrls options marks negativeMarks correctOption explanation createdAt updatedAt")
        .sort({ createdAt: 1 })
        .lean(),
      Attempt.find(NON_ADMIN_ATTEMPT_FILTER)
        .select("userId testId attemptNumber score accuracy rank percentile submittedAt timeTakenSeconds correctCount wrongCount skippedCount")
        .sort({ submittedAt: -1 })
        .limit(500)
        .lean(),
      User.find({ deletedAt: null })
        .select("name email role isPaid createdAt lastSeenAt")
        .sort({ createdAt: -1 })
        .limit(500)
        .lean(),
      User.countDocuments({ deletedAt: null }),
      AppConfig.findOne({ key: "global" }).lean(),
    ]);

    res.json({
      tests: tests.map((t) => ({
        id: String(t._id),
        title: t.title,
        subtitle: t.subtitle || "",
        series: t.series || "UGEE 2026",
        type: t.type || "practice",
        isFree: Boolean(t.isFree),
        status: t.status,
        displayOrder: Number.isFinite(Number(t.displayOrder)) ? Number(t.displayOrder) : 100,
        durationMinutes: t.durationMinutes,
        sectionDurations: t.sectionDurations || { SUPR: 60, REAP: 120 },
        instructions: Array.isArray(t.instructions) ? t.instructions : [],
        benchmarkScores: Array.isArray(t.benchmarkScores) ? t.benchmarkScores : [],
        questionIds: (t.questionIds || []).map((id) => String(id)),
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
      })),
      questions: questions.map((q) => ({
        id: String(q._id),
        section: q.section,
        topic: q.topic,
        difficulty: q.difficulty,
        prompt: q.prompt,
        passage: q.passage || "",
        imageUrls: Array.isArray(q.imageUrls) ? q.imageUrls : [],
        imageUrl: (Array.isArray(q.imageUrls) && q.imageUrls[0]) || "",
        options: Array.isArray(q.options) ? q.options : [],
        marks: q.marks,
        negativeMarks: q.negativeMarks,
        correctOption: q.correctOption,
        explanation: q.explanation || "",
        createdAt: q.createdAt,
        updatedAt: q.updatedAt,
      })),
      attempts: attempts.map((a) => ({
        id: String(a._id),
        userId: String(a.userId),
        testId: String(a.testId),
        attemptNumber: a.attemptNumber,
        score: a.score,
        accuracy: a.accuracy,
        rank: a.rank,
        percentile: a.percentile,
        submittedAt: a.submittedAt,
        timeTakenSeconds: a.timeTakenSeconds,
        correctCount: a.correctCount,
        wrongCount: a.wrongCount,
        skippedCount: a.skippedCount,
      })),
      users: users.map((u) => ({
        id: String(u._id),
        name: u.name,
        email: u.email,
        role: u.role,
        isPaid: u.isPaid,
        createdAt: u.createdAt,
        lastSeenAt: u.lastSeenAt || null,
      })),
      userCount,
      appConfig: {
        ugeeExamDate: appConfig && appConfig.ugeeExamDate ? appConfig.ugeeExamDate : null,
        featuredTestId: appConfig && appConfig.featuredTestId ? String(appConfig.featuredTestId) : "",
        noticeTitle: appConfig && appConfig.noticeTitle ? appConfig.noticeTitle : "",
        noticeBody: appConfig && appConfig.noticeBody ? appConfig.noticeBody : "",
      },
    });
  } catch (err) {
    next(err);
  }
}

async function updateAppConfig(req, res, next) {
  try {
    const schema = z.object({
      ugeeExamDate: z.string().datetime().nullable().optional(),
      featuredTestId: z.string().trim().nullable().optional(),
      noticeTitle: z.string().max(120).nullable().optional(),
      noticeBody: z.string().max(2000).nullable().optional(),
    });
    const input = schema.parse(req.body || {});
    const payload = {};
    if (Object.prototype.hasOwnProperty.call(input, "ugeeExamDate")) {
      payload.ugeeExamDate = input.ugeeExamDate ? new Date(input.ugeeExamDate) : null;
    }
    if (Object.prototype.hasOwnProperty.call(input, "featuredTestId")) {
      payload.featuredTestId = input.featuredTestId ? input.featuredTestId : null;
    }
    if (Object.prototype.hasOwnProperty.call(input, "noticeTitle")) {
      payload.noticeTitle = input.noticeTitle ? String(input.noticeTitle).trim() : "";
    }
    if (Object.prototype.hasOwnProperty.call(input, "noticeBody")) {
      payload.noticeBody = input.noticeBody ? String(input.noticeBody).trim() : "";
    }
    payload.updatedBy = req.auth.userId;

    const config = await AppConfig.findOneAndUpdate(
      { key: "global" },
      { $set: payload, $setOnInsert: { key: "global" } },
      { upsert: true, new: true }
    );

    res.json({
      appConfig: {
        ugeeExamDate: config && config.ugeeExamDate ? config.ugeeExamDate : null,
        featuredTestId: config && config.featuredTestId ? String(config.featuredTestId) : "",
        noticeTitle: config && config.noticeTitle ? config.noticeTitle : "",
        noticeBody: config && config.noticeBody ? config.noticeBody : "",
      },
    });
  } catch (err) {
    next(err);
  }
}

async function trash(req, res, next) {
  try {
    const [tests, questions, users] = await Promise.all([
      Test.find({ deletedAt: { $ne: null } }).select("title subtitle series isFree status sectionDurations deletedAt").sort({ deletedAt: -1 }).limit(500).lean(),
      Question.find({ deletedAt: { $ne: null } }).select("section topic prompt deletedAt").sort({ deletedAt: -1 }).limit(500).lean(),
      User.find({ deletedAt: { $ne: null } }).select("name email role isPaid deletedAt createdAt").sort({ deletedAt: -1 }).limit(500).lean(),
    ]);

    res.json({
      tests: tests.map((t) => ({
        id: String(t._id),
        title: t.title,
        subtitle: t.subtitle || "",
        series: t.series || "UGEE 2026",
        isFree: Boolean(t.isFree),
        status: t.status,
        sectionDurations: t.sectionDurations || { SUPR: 60, REAP: 120 },
        deletedAt: t.deletedAt,
      })),
      questions: questions.map((q) => ({
        id: String(q._id),
        section: q.section,
        topic: q.topic,
        prompt: q.prompt,
        deletedAt: q.deletedAt,
      })),
      users: users.map((u) => ({
        id: String(u._id),
        name: u.name,
        email: u.email,
        role: u.role,
        isPaid: u.isPaid,
        deletedAt: u.deletedAt,
        createdAt: u.createdAt,
      })),
    });
  } catch (err) {
    next(err);
  }
}

async function createQuestion(req, res, next) {
  try {
    const input = questionInputSchema.parse(normalizeQuestionPayload(req.body || {}));
    const uploadedImageUrls = await uploadQuestionImages(req);
    const imageUrls = (input.imageUrls || []).slice().concat(uploadedImageUrls);
    const sectionDefaults = getSectionDefaultMarking(input.section);

    const question = await Question.create({
      section: input.section,
      topic: input.topic,
      difficulty: input.difficulty || "medium",
      prompt: input.prompt,
      passage: input.passage || "",
      imageUrls,
      options: input.options,
      correctOption: input.correctOption,
      explanation: input.explanation || "",
      marks: Number.isFinite(Number(input.marks)) ? Number(input.marks) : sectionDefaults.marks,
      negativeMarks: Number.isFinite(Number(input.negativeMarks)) ? Number(input.negativeMarks) : sectionDefaults.negativeMarks,
    });
    invalidateAllTestCaches();
    res.status(201).json({ question: question.toJSON() });
  } catch (err) {
    next(err);
  }
}

async function updateQuestion(req, res, next) {
  try {
    const input = questionInputSchema.partial().parse(normalizeQuestionPayload(req.body || {}));
    const question = await Question.findById(req.params.id);
    if (!question) return res.status(404).json({ error: "Question not found" });
    const attachedTests = await Test.find({ questionIds: question._id, deletedAt: null }).select("_id").lean();
    const uploadedImageUrls = await uploadQuestionImages(req);

    for (const key of Object.keys(input)) {
      question[key] = input[key];
    }
    if (input.imageUrls) {
      question.imageUrls = input.imageUrls;
    }
    if (uploadedImageUrls.length) {
      question.imageUrls = Array.isArray(question.imageUrls) ? question.imageUrls : [];
      question.imageUrls = question.imageUrls.concat(uploadedImageUrls);
    }
    await question.save();
    await recalculateTestsMetadata(attachedTests.map((test) => test._id));
    invalidateAllTestCaches();
    res.json({ question: question.toJSON() });
  } catch (err) {
    next(err);
  }
}

async function deleteQuestion(req, res, next) {
  try {
    const question = await Question.findById(req.params.id);
    if (!question) return res.status(404).json({ error: "Question not found" });
    const attachedTests = await Test.find({ questionIds: question._id, deletedAt: null }).select("_id").lean();
    question.deletedAt = new Date();
    await question.save();
    await Test.updateMany({ questionIds: question._id }, { $pull: { questionIds: question._id } });
    await recalculateTestsMetadata(attachedTests.map((test) => test._id));
    invalidateAllTestCaches();
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

async function deleteUser(req, res, next) {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: "User not found" });
    if (user.role === "admin") return res.status(400).json({ error: "Admin users cannot be deleted." });
    user.deletedAt = new Date();
    await user.save();
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

async function restoreTrashItem(req, res, next) {
  try {
    const { kind, id } = req.params;
    if (!["tests", "questions", "users"].includes(kind)) {
      return res.status(400).json({ error: "Invalid kind" });
    }
    const model = kind === "tests" ? Test : kind === "questions" ? Question : User;
    const doc = await model.findById(id);
    if (!doc) return res.status(404).json({ error: "Not found" });
    doc.deletedAt = null;
    await doc.save();
    if (kind === "tests" || kind === "questions") {
      if (kind === "tests") {
        await recalculateTestsMetadata([doc._id]);
      }
      invalidateAllTestCaches();
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

async function purgeTrashItem(req, res, next) {
  try {
    const { kind, id } = req.params;
    if (!["tests", "questions", "users"].includes(kind)) {
      return res.status(400).json({ error: "Invalid kind" });
    }
    let affectedTests = [];
    if (kind === "questions") {
      affectedTests = await Test.find({ questionIds: id, deletedAt: null }).select("_id").lean();
      await Test.updateMany({ questionIds: id }, { $pull: { questionIds: id } });
    }
    const model = kind === "tests" ? Test : kind === "questions" ? Question : User;
    await model.deleteOne({ _id: id });
    if (kind === "tests" || kind === "questions") {
      if (kind === "questions" && affectedTests.length) {
        await recalculateTestsMetadata(affectedTests.map((test) => test._id));
      }
      invalidateAllTestCaches();
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

async function attachQuestion(req, res, next) {
  try {
    const schema = z.object({ testId: z.string().min(1), questionId: z.string().min(1) });
    const { testId, questionId } = schema.parse(req.body || {});
    const [test, question] = await Promise.all([Test.findById(testId), Question.findById(questionId)]);
    if (!test) return res.status(404).json({ error: "Test not found" });
    if (!question) return res.status(404).json({ error: "Question not found" });
    if (test.deletedAt) return res.status(400).json({ error: "Test is in recycle bin" });
    if (question.deletedAt) return res.status(400).json({ error: "Question is in recycle bin" });
    await Test.updateOne({ _id: testId, deletedAt: null }, { $addToSet: { questionIds: question._id } });
    await recalculateTestsMetadata([testId]);
    invalidateCatalogCache();
    invalidateTestRuntimeCache(testId);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

async function detachQuestion(req, res, next) {
  try {
    const schema = z.object({ testId: z.string().min(1), questionId: z.string().min(1) });
    const { testId, questionId } = schema.parse(req.body || {});
    const test = await Test.findById(testId).select("_id deletedAt");
    if (!test) return res.status(404).json({ error: "Test not found" });
    if (test.deletedAt) return res.status(400).json({ error: "Test is in recycle bin" });
    await Test.updateOne({ _id: testId, deletedAt: null }, { $pull: { questionIds: questionId } });
    await recalculateTestsMetadata([testId]);
    invalidateCatalogCache();
    invalidateTestRuntimeCache(testId);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

async function results(req, res, next) {
  try {
    const attempts = await Attempt.find(NON_ADMIN_ATTEMPT_FILTER)
      .select("submittedAt score accuracy rank percentile attemptNumber timeTakenSeconds userId testId")
      .sort({ submittedAt: -1 })
      .limit(500)
      .populate("userId", "name email")
      .populate("testId", "title series")
      .lean();
    res.json({
      results: attempts.map((a) => ({
        id: String(a._id),
        submittedAt: a.submittedAt,
        score: a.score,
        accuracy: a.accuracy,
        rank: a.rank,
        percentile: a.percentile,
        attemptNumber: a.attemptNumber,
        timeTakenSeconds: a.timeTakenSeconds,
        user: a.userId ? { id: String(a.userId._id), name: a.userId.name, email: a.userId.email } : null,
        test: a.testId ? { id: String(a.testId._id), title: a.testId.title, series: a.testId.series } : null,
      })),
    });
  } catch (err) {
    next(err);
  }
}

async function leaderboard(req, res, next) {
  try {
    const testId = String(req.query.testId || "").trim();
    if (!testId) return res.status(400).json({ error: "testId is required" });
    const attempts = await Attempt.find({ testId, attemptNumber: 1, ...NON_ADMIN_ATTEMPT_FILTER })
      .select("score timeTakenSeconds submittedAt userId")
      .sort({ score: -1, timeTakenSeconds: 1, submittedAt: 1 })
      .limit(50)
      .populate("userId", "name email")
      .lean();
    res.json({
      leaderboard: attempts.map((a, index) => ({
        rank: index + 1,
        score: a.score,
        timeTakenSeconds: a.timeTakenSeconds,
        submittedAt: a.submittedAt,
        user: a.userId ? { id: String(a.userId._id), name: a.userId.name, email: a.userId.email } : null,
      })),
    });
  } catch (err) {
    next(err);
  }
}

async function testAnalytics(req, res, next) {
  try {
    const testId = req.params.id;
    const agg = await Attempt.aggregate([
      {
        $match: {
          testId: mongoose.Types.ObjectId.createFromHexString(testId),
          ...NON_ADMIN_ATTEMPT_FILTER,
        },
      },
      {
        $group: {
          _id: "$testId",
          count: { $sum: 1 },
          avgScore: { $avg: "$score" },
          avgAccuracy: { $avg: "$accuracy" },
          maxScore: { $max: "$score" },
        },
      },
    ]);
    res.json({ analytics: agg[0] || { count: 0, avgScore: 0, avgAccuracy: 0, maxScore: 0 } });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  snapshot,
  trash,
  createQuestion,
  updateQuestion,
  deleteQuestion,
  deleteUser,
  restoreTrashItem,
  purgeTrashItem,
  attachQuestion,
  detachQuestion,
  results,
  leaderboard,
  testAnalytics,
  updateAppConfig,
};
