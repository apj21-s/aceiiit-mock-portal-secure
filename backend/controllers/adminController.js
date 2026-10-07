const mongoose = require("mongoose");
const { isValidObjectId } = mongoose;
const { z } = require("zod");

const Attempt = require("../models/Attempt");
const AppConfig = require("../models/AppConfig");
const Question = require("../models/Question");
const Test = require("../models/Test");
const User = require("../models/User");
const Entitlement = require("../models/Entitlement");
const PaymentRecord = require("../models/PaymentRecord");
const AuditLog = require("../models/AuditLog");
const Season = require("../models/Season");
const { invalidateAllTestCaches, invalidateCatalogCache, invalidateTestRuntimeCache } = require("../services/testDataService");
const { extractUploadedFiles, uploadImages } = require("../services/imageUploadService");
const { sendPaymentConfirmationEmail } = require("../utils/mailService");
const { logAuditEvent } = require("../services/auditLogService");
const { revokeAllSessions } = require("../services/sessionService");
const { getRanksForAttempts, invalidateRankCache } = require("../services/rankService");
const { escapeRegex } = require("../utils/escapeRegex");
const IntegrityEvent = require("../models/IntegrityEvent");
const { getActiveSeason } = require("../services/seasonService");
const { logger, errorSummary } = require("../utils/logger");

// Student exam attempts only: excludes admin test runs and private practice papers.
const NON_ADMIN_ATTEMPT_FILTER = {
  userRole: { $ne: "admin" },
  isPractice: { $ne: true },
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
  const isAllowedUrl = (url) =>
    /^https?:\/\//i.test(url) ||
    /^data:image\//i.test(url) ||
    /^\/\//.test(url) ||
    /^\/assets\//i.test(url) ||
    /^blob:/i.test(url);

  const parsed = parseMaybeJson(body.imageUrls, null);
  if (Array.isArray(parsed)) {
    return parsed
      .map((v) => String(v ?? "").trim())
      .filter(Boolean)
      .filter(isAllowedUrl);
  }
  if (typeof body.imageUrls === "string") {
    return String(body.imageUrls)
      .split(/[\r\n,]/)
      .map((s) => s.trim())
      .filter(Boolean)
      .filter(isAllowedUrl);
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

async function uploadQuestionImages(req) {
  const files = extractUploadedFiles(req);
  if (!files.length) return [];
  return uploadImages(files);
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

const ADMIN_QUESTION_FIELDS = "section topic difficulty prompt passage imageUrls options marks negativeMarks correctOption explanation createdAt updatedAt";

function serializeAdminQuestion(q) {
  return {
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
  };
}

/**
 * GET /admin/questions: the question bank, paginated and filtered on the server (the
 * snapshot only carries questions attached to tests). Query is validated by the route.
 */
async function listQuestions(req, res, next) {
  try {
    const { page, limit, section, difficulty, search, excludeTestId } = req.query;
    const filter = { deletedAt: null };
    if (section) filter.section = section;
    if (difficulty) filter.difficulty = difficulty;
    if (search) {
      const q = escapeRegex(search);
      const or = [{ prompt: { $regex: q, $options: "i" } }, { topic: { $regex: q, $options: "i" } }];
      if (/^[a-f0-9]{24}$/i.test(search)) or.push({ _id: search });
      filter.$or = or;
    }
    if (excludeTestId) {
      const test = await Test.findById(excludeTestId).select("questionIds").lean();
      if (test && Array.isArray(test.questionIds) && test.questionIds.length) {
        filter._id = Object.assign({}, filter._id, { $nin: test.questionIds });
      }
    }
    const [questions, total] = await Promise.all([
      Question.find(filter).select(ADMIN_QUESTION_FIELDS).sort({ createdAt: 1, _id: 1 }).skip((page - 1) * limit).limit(limit).lean(),
      Question.countDocuments(filter),
    ]);
    return res.json({
      questions: questions.map(serializeAdminQuestion),
      total,
      page,
      limit,
      pages: Math.max(1, Math.ceil(total / limit)),
    });
  } catch (err) {
    return next(err);
  }
}

async function snapshot(req, res, next) {
  try {
    const [tests, questions, attempts, users, userCount, appConfig] = await Promise.all([
      Test.find({ deletedAt: null, status: { $ne: "practice" } })
        .select("title subtitle series type isFree status displayOrder durationMinutes sectionDurations instructions benchmarkScores questionIds shuffleQuestions shuffleOptions integrity seasonId createdAt updatedAt")
        .sort({ displayOrder: 1, createdAt: 1 })
        .lean(),
      // Only questions attached to a test; the full bank is paginated via GET /admin/questions.
      Test.distinct("questionIds", { deletedAt: null, status: { $ne: "practice" } }).then((ids) =>
        Question.find({ _id: { $in: ids }, deletedAt: null }).select(ADMIN_QUESTION_FIELDS).sort({ createdAt: 1 }).lean()
      ),
      Attempt.find(NON_ADMIN_ATTEMPT_FILTER)
        .select("userId testId attemptNumber score accuracy submittedAt timeTakenSeconds correctCount wrongCount skippedCount userRole isPractice invalidatedAt")
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
    const questionBankTotal = await Question.countDocuments({ deletedAt: null });

    const snapshotRanks = await getRanksForAttempts(attempts);
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
        shuffleQuestions: Boolean(t.shuffleQuestions),
        shuffleOptions: Boolean(t.shuffleOptions),
        integrity: {
          mode: (t.integrity && t.integrity.mode) || "warn",
          warnThreshold: Number((t.integrity && t.integrity.warnThreshold) || 1),
          autoSubmitThreshold: Number((t.integrity && t.integrity.autoSubmitThreshold) || 5),
        },
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
      })),
      questions: questions.map(serializeAdminQuestion),
      questionBankTotal,
      attempts: attempts.map((a) => ({
        id: String(a._id),
        userId: String(a.userId),
        testId: String(a.testId),
        attemptNumber: a.attemptNumber,
        score: a.score,
        accuracy: a.accuracy,
        rank: (snapshotRanks.get(String(a._id)) || {}).rank || 0,
        percentile: (snapshotRanks.get(String(a._id)) || {}).percentile || 0,
        invalidated: Boolean(a.invalidatedAt),
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
        isPaid: Boolean(u.isPaid),
        createdAt: u.createdAt,
        lastSeenAt: u.lastSeenAt || null,
        isOnline: Boolean(u.lastSeenAt && (Date.now() - new Date(u.lastSeenAt).getTime() < 5 * 60 * 1000)),
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
      Test.find({ deletedAt: { $ne: null }, status: { $ne: "practice" } }).select("title subtitle series isFree status sectionDurations deletedAt").sort({ deletedAt: -1 }).limit(500).lean(),
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
    res.locals.auditEntityId = question.id;
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

// A question in a live test must never be destroyed: students may be mid-exam and
// historical attempts reference it.
function liveTestsUsingQuestion(questionId) {
  return Test.find({ questionIds: questionId, status: "live", deletedAt: null }).select("_id title").lean();
}

/**
 * Explicit, audited user purge. Instead of a silent TTL delete, personal data is removed or
 * anonymized and dependent records are cleaned up so nothing is left orphaned.
 */
async function purgeUserCascade(user, actorUserId) {
  const userId = user._id;
  const AttemptSession = require("../models/AttemptSession");
  const Reminder = require("../models/Reminder");
  const GoogleCalendarConnection = require("../models/GoogleCalendarConnection");
  const GoogleCalendarEvent = require("../models/GoogleCalendarEvent");
  await Promise.all([
    Attempt.updateMany({ userId }, { $set: { userEmail: "" } }),
    Entitlement.updateMany({ userId }, { $set: { userId: null } }),
    AttemptSession.deleteMany({ userId }),
    Reminder.deleteMany({ userId }),
    GoogleCalendarConnection.deleteMany({ userId }),
    GoogleCalendarEvent.deleteMany({ userId }),
  ]);
  await User.deleteOne({ _id: userId });
  await logAuditEvent({
    actorUserId,
    action: "USER_PURGED",
    entityType: "User",
    entityId: String(userId),
    metadata: { anonymizedAttempts: true },
  });
}

async function deleteQuestion(req, res, next) {
  try {
    const question = await Question.findById(req.params.id);
    if (!question) return res.status(404).json({ error: "Question not found" });
    const liveTests = await liveTestsUsingQuestion(question._id);
    if (liveTests.length) {
      return res.status(409).json({
        error: `This question is part of live test(s): ${liveTests.map((t) => t.title).join(", ")}. Unpublish the test or detach the question first.`,
        code: "QUESTION_IN_LIVE_TEST",
      });
    }
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
    user.tokenVersion = Number(user.tokenVersion || 0) + 1;
    await user.save();
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

async function revokeUserSessions(req, res, next) {
  try {
    if (!isValidObjectId(req.params.id)) {
      return res.status(400).json({ error: "Invalid user id" });
    }
    const tokenVersion = await revokeAllSessions(req.params.id);
    if (tokenVersion === null) return res.status(404).json({ error: "User not found" });
    await logAuditEvent({
      actorUserId: req.auth.userId,
      action: "USER_SESSIONS_REVOKED",
      entityType: "User",
      entityId: req.params.id,
      metadata: { tokenVersion },
    });
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
    if (!isValidObjectId(id)) return res.status(400).json({ error: "Invalid id" });
    let affectedTests = [];
    if (kind === "questions") {
      const liveTests = await liveTestsUsingQuestion(id);
      if (liveTests.length) {
        return res.status(409).json({ error: "This question is part of a live test and can't be purged.", code: "QUESTION_IN_LIVE_TEST" });
      }
      affectedTests = await Test.find({ questionIds: id, deletedAt: null }).select("_id").lean();
      await Test.updateMany({ questionIds: id }, { $pull: { questionIds: id } });
    }
    if (kind === "users") {
      const user = await User.findById(id);
      if (!user) return res.status(404).json({ error: "Not found" });
      if (!user.deletedAt) return res.status(409).json({ error: "Move the user to trash before purging.", code: "NOT_IN_TRASH" });
      await purgeUserCascade(user, req.auth.userId);
      return res.json({ ok: true });
    }
    const model = kind === "tests" ? Test : Question;
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
      .select("submittedAt score accuracy attemptNumber timeTakenSeconds userId testId userRole isPractice invalidatedAt submittedReason integrity sessionId")
      .sort({ submittedAt: -1 })
      .limit(500)
      .populate("userId", "name email")
      .populate("testId", "title series")
      .lean();
    const ranks = await getRanksForAttempts(
      attempts.map((a) => ({ ...a, testId: a.testId && a.testId._id ? a.testId._id : a.testId }))
    );
    res.json({
      results: attempts.map((a) => ({
        id: String(a._id),
        submittedAt: a.submittedAt,
        score: a.score,
        accuracy: a.accuracy,
        rank: (ranks.get(String(a._id)) || {}).rank || 0,
        percentile: (ranks.get(String(a._id)) || {}).percentile || 0,
        invalidated: Boolean(a.invalidatedAt),
        submittedReason: a.submittedReason || "submitted",
        integrity: {
          mode: (a.integrity && a.integrity.mode) || "warn",
          violations: Number((a.integrity && a.integrity.violations) || 0),
          takeovers: Number((a.integrity && a.integrity.takeovers) || 0),
          byType: (a.integrity && a.integrity.byType) || {},
        },
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
    const filter = { testId, attemptNumber: 1, invalidatedAt: null, ...NON_ADMIN_ATTEMPT_FILTER };
    if (String(req.query.excludeFlagged || "") === "1") {
      filter["integrity.violations"] = { $in: [0, null] };
    }
    const attempts = await Attempt.find(filter)
      .select("score timeTakenSeconds submittedAt userId integrity")
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
        integrityViolations: Number((a.integrity && a.integrity.violations) || 0),
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

async function attachQuestionsBulk(req, res, next) {
  try {
    const schema = z.object({
      testId: z.string().min(1),
      questionIds: z.array(z.string().min(1)).min(1),
    });
    const { testId, questionIds } = schema.parse(req.body || {});
    const test = await Test.findById(testId);
    if (!test) return res.status(404).json({ error: "Test not found" });
    if (test.deletedAt) return res.status(400).json({ error: "Test is in recycle bin" });

    const validQuestions = await Question.find({ _id: { $in: questionIds }, deletedAt: null }).select("_id").lean();
    const validObjectIds = validQuestions.map((q) => q._id);

    await Test.updateOne(
      { _id: testId, deletedAt: null },
      { $addToSet: { questionIds: { $each: validObjectIds } } }
    );
    await recalculateTestsMetadata([testId]);
    invalidateCatalogCache();
    invalidateTestRuntimeCache(testId);
    res.json({ ok: true, count: validObjectIds.length });
  } catch (err) {
    next(err);
  }
}

async function detachQuestionsBulk(req, res, next) {
  try {
    const schema = z.object({
      testId: z.string().min(1),
      questionIds: z.array(z.string().min(1)).min(1),
    });
    const { testId, questionIds } = schema.parse(req.body || {});
    const test = await Test.findById(testId);
    if (!test) return res.status(404).json({ error: "Test not found" });
    if (test.deletedAt) return res.status(400).json({ error: "Test is in recycle bin" });

    await Test.updateOne(
      { _id: testId, deletedAt: null },
      { $pullAll: { questionIds: questionIds } }
    );
    await recalculateTestsMetadata([testId]);
    invalidateCatalogCache();
    invalidateTestRuntimeCache(testId);
    res.json({ ok: true, count: questionIds.length });
  } catch (err) {
    next(err);
  }
}

async function reorderTestQuestions(req, res, next) {
  try {
    const schema = z.object({
      testId: z.string().min(1),
      questionIds: z.array(z.string()),
    });
    const { testId, questionIds } = schema.parse(req.body || {});
    const test = await Test.findById(testId);
    if (!test) return res.status(404).json({ error: "Test not found" });
    if (test.deletedAt) return res.status(400).json({ error: "Test is in recycle bin" });

    test.questionIds = questionIds;
    await test.save();
    await recalculateTestsMetadata([testId]);
    invalidateCatalogCache();
    invalidateTestRuntimeCache(testId);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

async function duplicateTest(req, res, next) {
  try {
    const testId = req.params.id;
    const originalTest = await Test.findById(testId).lean();
    if (!originalTest || originalTest.deletedAt) {
      return res.status(404).json({ error: "Test not found" });
    }

    const newTitle = (originalTest.title || "Untitled Test") + " (Copy)";
    const newTest = await Test.create({
      title: newTitle,
      subtitle: originalTest.subtitle || "",
      series: originalTest.series || "UGEE 2026",
      type: originalTest.type || "practice",
      isFree: Boolean(originalTest.isFree),
      status: "draft",
      displayOrder: (originalTest.displayOrder || 100) + 1,
      sectionDurations: originalTest.sectionDurations || { SUPR: 60, REAP: 120 },
      durationMinutes: originalTest.durationMinutes || 180,
      instructions: originalTest.instructions || [],
      benchmarkScores: originalTest.benchmarkScores || [],
      questionIds: originalTest.questionIds || [],
      totalMarks: originalTest.totalMarks || 0,
      negativeMarks: originalTest.negativeMarks || -0.25,
    });

    await recalculateTestsMetadata([newTest._id]);
    invalidateCatalogCache();
    res.status(201).json({ test: newTest.toJSON() });
  } catch (err) {
    next(err);
  }
}

async function generateQuestionsRandom(req, res, next) {
  try {
    const schema = z.object({
      testId: z.string().optional(),
      suprCount: z.number().int().min(0).max(100).optional().default(30),
      reapCount: z.number().int().min(0).max(100).optional().default(30),
      difficulty: z.string().optional(),
      excludeExisting: z.boolean().optional().default(true),
    });
    const { testId, suprCount, reapCount, difficulty, excludeExisting } = schema.parse(req.body || {});

    let excludeIds = [];
    if (excludeExisting && testId) {
      const test = await Test.findById(testId).select("questionIds").lean();
      if (test && test.questionIds) {
        excludeIds = test.questionIds.map((id) => String(id));
      }
    }

    const baseMatch = { deletedAt: null };
    if (excludeIds.length) {
      baseMatch._id = { $nin: excludeIds.map((id) => mongoose.Types.ObjectId.createFromHexString(id)) };
    }
    if (difficulty && ["easy", "medium", "hard"].includes(difficulty)) {
      baseMatch.difficulty = difficulty;
    }

    const suprMatch = { ...baseMatch, section: "SUPR" };
    const reapMatch = { ...baseMatch, section: "REAP" };

    const [suprQuestions, reapQuestions] = await Promise.all([
      suprCount > 0
        ? Question.aggregate([{ $match: suprMatch }, { $sample: { size: suprCount } }, { $project: { _id: 1 } }])
        : [],
      reapCount > 0
        ? Question.aggregate([{ $match: reapMatch }, { $sample: { size: reapCount } }, { $project: { _id: 1 } }])
        : [],
    ]);

    const generatedIds = [...suprQuestions, ...reapQuestions].map((q) => String(q._id));
    res.json({
      questionIds: generatedIds,
      suprFound: suprQuestions.length,
      reapFound: reapQuestions.length,
      suprRequested: suprCount,
      reapRequested: reapCount,
    });
  } catch (err) {
    next(err);
  }
}

async function verifyUserPayment(req, res, next) {
  try {
    const user = await User.findById(req.params.id);
    if (!user || user.deletedAt) return res.status(404).json({ error: "User not found" });
    user.isPaid = true;
    await user.save();
    try {
      await sendPaymentConfirmationEmail(user.email, user.name);
    } catch (mailErr) {
      logger.warn({ err: errorSummary(mailErr) }, "payment confirmation email failed");
    }
    res.json({ ok: true, user: user.toJSON() });
  } catch (err) {
    next(err);
  }
}

async function revokeUserPayment(req, res, next) {
  try {
    const user = await User.findById(req.params.id);
    if (!user || user.deletedAt) return res.status(404).json({ error: "User not found" });
    user.isPaid = false;
    await user.save();
    res.json({ ok: true, user: user.toJSON() });
  } catch (err) {
    next(err);
  }
}

async function listUsersExtended(req, res, next) {
  try {
    const page = Math.max(1, Number(req.query.page || 1));
    const limit = Math.min(100, Math.max(1, Number(req.query.limit || 20)));
    const { search, role, isPaid, isEnrolledOnly } = req.query || {};

    const filter = { deletedAt: null };
    if (role) filter.role = role;
    if (isPaid === "true" || isPaid === "1") filter.isPaid = true;
    if (isPaid === "false" || isPaid === "0") filter.isPaid = false;

    if (search) {
      const q = escapeRegex(String(search).trim().toLowerCase());
      filter.$or = [
        { name: { $regex: q, $options: "i" } },
        { email: { $regex: q, $options: "i" } },
        { normalizedEmail: { $regex: q, $options: "i" } },
      ];
    }

    if (isEnrolledOnly === "true" || isEnrolledOnly === "1") {
      const verifiedPayments = await PaymentRecord.find({ status: "verified" }).distinct("normalizedEmail");
      const activeEntitlements = await Entitlement.find({ status: "active" }).distinct("normalizedEmail");

      const enrolledEmailSet = new Set([
        ...verifiedPayments,
        ...activeEntitlements,
      ]);

      // Enrolled = paid flag or a verified payment/active entitlement; the search (if any) still applies.
      const enrolledClause = { $or: [{ isPaid: true }, { normalizedEmail: { $in: Array.from(enrolledEmailSet) } }] };
      if (filter.$or) {
        filter.$and = [{ $or: filter.$or }, enrolledClause];
        delete filter.$or;
      } else {
        filter.$or = enrolledClause.$or;
      }
    }

    const total = await User.countDocuments(filter);
    const users = await User.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();

    const normEmails = users.map((u) => u.normalizedEmail || String(u.email || "").toLowerCase().trim());
    const entitlements = await Entitlement.find({
      normalizedEmail: { $in: normEmails },
      status: "active",
    }).populate("seasonId", "name year").lean();

    const entMap = new Map();
    for (const ent of entitlements) {
      const list = entMap.get(ent.normalizedEmail) || [];
      list.push(ent);
      entMap.set(ent.normalizedEmail, list);
    }

    const mappedUsers = users.map((u) => {
      const nEmail = u.normalizedEmail || String(u.email || "").toLowerCase().trim();
      const userEnts = entMap.get(nEmail) || [];
      return {
        ...u,
        id: String(u._id),
        entitlements: userEnts.map((e) => ({
          id: String(e._id),
          seasonName: e.seasonId ? e.seasonId.name : "Active Season",
          tier: e.tier,
          status: e.status,
          grantedAt: e.grantedAt,
        })),
      };
    });

    res.json({
      users: mappedUsers,
      pagination: {
        page,
        limit,
        total,
        pages: total ? Math.ceil(total / limit) : 1,
      },
    });
  } catch (err) {
    next(err);
  }
}

async function getUserDetailExtended(req, res, next) {
  try {
    const user = await User.findById(req.params.id).lean();
    if (!user || user.deletedAt) {
      return res.status(404).json({ error: "User not found" });
    }

    const normEmail = user.normalizedEmail || String(user.email || "").toLowerCase().trim();

    const [attempts, entitlements, payments] = await Promise.all([
      Attempt.find({ userId: user._id })
        .select("testId attemptNumber score accuracy submittedAt timeTakenSeconds userRole isPractice invalidatedAt submittedReason")
        .sort({ submittedAt: -1 })
        .limit(50)
        .lean(),
      Entitlement.find({ normalizedEmail: normEmail })
        .populate("seasonId", "name year")
        .sort({ createdAt: -1 })
        .lean(),
      PaymentRecord.find({ normalizedEmail: normEmail })
        .populate("seasonId", "name year")
        .sort({ createdAt: -1 })
        .lean(),
    ]);

    res.json({
      user: {
        ...user,
        id: String(user._id),
      },
      attempts: await (async () => {
        const ranks = await getRanksForAttempts(attempts);
        return attempts.map((a) => ({ ...a, id: String(a._id), ...(ranks.get(String(a._id)) || { rank: 0, percentile: 0 }) }));
      })(),
      entitlements: entitlements.map((e) => ({ ...e, id: String(e._id) })),
      payments: payments.map((p) => ({ ...p, id: String(p._id) })),
    });
  } catch (err) {
    next(err);
  }
}

async function publishTest(req, res, next) {
  try {
    const test = await Test.findById(req.params.id);
    if (!test || test.deletedAt) {
      return res.status(404).json({ error: "Test not found" });
    }

    // Validation checks prior to publishing
    const validationErrors = [];
    if (!test.title || test.title.trim().length < 3) {
      validationErrors.push("Test title must be at least 3 characters long.");
    }
    if (!Array.isArray(test.questionIds) || test.questionIds.length === 0) {
      validationErrors.push("Test must contain at least 1 question before publishing.");
    }
    if (!test.durationMinutes || test.durationMinutes <= 0) {
      validationErrors.push("Test duration must be greater than 0 minutes.");
    }

    if (validationErrors.length > 0) {
      return res.status(422).json({
        error: "Test validation failed",
        validationErrors,
      });
    }

    const before = test.toJSON();
    test.status = "live";
    await test.save();

    invalidateCatalogCache();
    invalidateTestRuntimeCache(test.id);

    await logAuditEvent({
      actorUserId: req.auth ? req.auth.userId : null,
      action: "TEST_PUBLISHED",
      entityType: "Test",
      entityId: test.id,
      seasonId: test.seasonId,
      before,
      after: test.toJSON(),
    });

    res.json({ ok: true, test: test.toJSON() });
  } catch (err) {
    next(err);
  }
}

async function getDashboardMetrics(req, res, next) {
  try {
    const activeSeason = await getActiveSeason();

    const [
      totalUsers,
      paidUsers,
      totalTests,
      liveTests,
      totalQuestions,
      totalAttempts,
      totalPayments,
      verifiedPayments,
    ] = await Promise.all([
      User.countDocuments({ deletedAt: null, role: "student" }),
      User.countDocuments({ deletedAt: null, role: "student", isPaid: true }),
      Test.countDocuments({ deletedAt: null, status: { $ne: "practice" } }),
      Test.countDocuments({ deletedAt: null, status: "live" }),
      Question.countDocuments({ deletedAt: null }),
      Attempt.countDocuments(NON_ADMIN_ATTEMPT_FILTER),
      PaymentRecord.countDocuments(activeSeason ? { seasonId: activeSeason._id } : {}),
      PaymentRecord.countDocuments(activeSeason ? { seasonId: activeSeason._id, status: "verified" } : { status: "verified" }),
    ]);

    res.json({
      metrics: {
        activeSeason: activeSeason ? activeSeason.toJSON() : null,
        totalUsers,
        paidUsers,
        totalTests,
        liveTests,
        totalQuestions,
        totalAttempts,
        totalPayments,
        verifiedPayments,
      },
    });
  } catch (err) {
    next(err);
  }
}

async function getAuditLogsController(req, res, next) {
  try {
    const page = Math.max(1, Number(req.query.page || 1));
    const limit = Math.min(100, Math.max(1, Number(req.query.limit || 20)));
    const { action, entityType, seasonId } = req.query || {};

    const filter = {};
    if (action) filter.action = action;
    if (entityType) filter.entityType = entityType;
    if (seasonId) filter.seasonId = seasonId;

    const total = await AuditLog.countDocuments(filter);
    const logs = await AuditLog.find(filter)
      .populate("actorUserId", "name email role")
      .populate("seasonId", "name year")
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();

    res.json({
      logs: logs.map((l) => ({ ...l, id: String(l._id) })),
      pagination: {
        page,
        limit,
        total,
        pages: total ? Math.ceil(total / limit) : 1,
      },
    });
  } catch (err) {
    next(err);
  }
}

// ---------------------------------------------------------------------------
// Exam integrity review. Browser telemetry is evidence, never proof: invalidation is
// always an explicit, audited admin decision.
// ---------------------------------------------------------------------------
async function getAttemptIntegrity(req, res, next) {
  try {
    if (!isValidObjectId(req.params.id)) return res.status(400).json({ error: "Invalid attempt id" });
    const attempt = await Attempt.findById(req.params.id)
      .select("userId testId sessionId integrity invalidatedAt invalidatedReason submittedReason submittedAt")
      .populate("userId", "name email")
      .lean();
    if (!attempt) return res.status(404).json({ error: "Attempt not found" });
    const events = attempt.sessionId
      ? await IntegrityEvent.find({ sessionId: attempt.sessionId }).sort({ receivedAt: 1 }).limit(500).lean()
      : [];
    res.json({
      attempt: {
        id: String(attempt._id),
        user: attempt.userId ? { id: String(attempt.userId._id), name: attempt.userId.name, email: attempt.userId.email } : null,
        submittedReason: attempt.submittedReason,
        submittedAt: attempt.submittedAt,
        integrity: attempt.integrity || { violations: 0 },
        invalidated: Boolean(attempt.invalidatedAt),
        invalidatedReason: attempt.invalidatedReason || "",
      },
      events: events.map((event) => ({
        type: event.type,
        counted: event.counted,
        clientAt: event.clientAt,
        receivedAt: event.receivedAt,
        durationMs: event.durationMs,
        detail: event.detail,
      })),
    });
  } catch (err) {
    next(err);
  }
}

const invalidateSchema = z.object({
  reason: z.string().trim().min(3, "A reason is required").max(500),
  restore: z.boolean().optional(),
});

async function invalidateAttempt(req, res, next) {
  try {
    if (!isValidObjectId(req.params.id)) return res.status(400).json({ error: "Invalid attempt id" });
    const { reason, restore } = invalidateSchema.parse(req.body || {});
    const attempt = await Attempt.findById(req.params.id);
    if (!attempt) return res.status(404).json({ error: "Attempt not found" });
    const before = { invalidatedAt: attempt.invalidatedAt, invalidatedReason: attempt.invalidatedReason };
    if (restore) {
      attempt.invalidatedAt = null;
      attempt.invalidatedReason = "";
      attempt.invalidatedBy = null;
    } else {
      attempt.invalidatedAt = new Date();
      attempt.invalidatedReason = reason;
      attempt.invalidatedBy = req.auth.userId;
    }
    await attempt.save();
    invalidateRankCache(attempt.testId);
    await logAuditEvent({
      actorUserId: req.auth.userId,
      action: restore ? "ATTEMPT_RESTORED" : "ATTEMPT_INVALIDATED",
      entityType: "Attempt",
      entityId: String(attempt._id),
      before,
      after: { invalidatedAt: attempt.invalidatedAt, invalidatedReason: attempt.invalidatedReason },
      metadata: { reason, testId: String(attempt.testId), userId: String(attempt.userId) },
    });
    res.json({ ok: true, invalidated: Boolean(attempt.invalidatedAt) });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  getAttemptIntegrity,
  invalidateAttempt,
  snapshot,
  listQuestions,
  trash,
  createQuestion,
  updateQuestion,
  deleteQuestion,
  deleteUser,
  revokeUserSessions,
  restoreTrashItem,
  purgeTrashItem,
  attachQuestion,
  detachQuestion,
  attachQuestionsBulk,
  detachQuestionsBulk,
  reorderTestQuestions,
  duplicateTest,
  generateQuestionsRandom,
  results,
  leaderboard,
  testAnalytics,
  updateAppConfig,
  verifyUserPayment,
  revokeUserPayment,
  listUsersExtended,
  getUserDetailExtended,
  publishTest,
  getDashboardMetrics,
  getAuditLogsController,
};
