const Question = require("../models/Question");
const Test = require("../models/Test");
const { MemoryCache } = require("../utils/memoryCache");

const cache = new MemoryCache(64);

const TEST_LIST_TTL_MS = 60 * 1000;
const TEST_RUNTIME_TTL_MS = 5 * 60 * 1000;

const TEST_PUBLIC_FIELDS =
  "title subtitle series type isFree status displayOrder durationMinutes sectionDurations instructions benchmarkScores totalMarks negativeMarks questionIds createdAt updatedAt";

const QUESTION_PUBLIC_FIELDS =
  "section topic difficulty prompt passage imageUrls options marks negativeMarks createdAt updatedAt";

const QUESTION_SCORING_FIELDS =
  "section topic prompt passage imageUrls options marks negativeMarks correctOption explanation";

function mapPublicTest(test, paidOk, isAdmin) {
  const isFree = Boolean(test.isFree);
  const accessible = isFree || paidOk || isAdmin;
  return {
    id: String(test._id),
    title: test.title,
    subtitle: test.subtitle || "",
    series: test.series || "UGEE 2026",
    type: test.type || "practice",
    isFree,
    status: test.status,
    displayOrder: Number.isFinite(Number(test.displayOrder)) ? Number(test.displayOrder) : 100,
    durationMinutes: test.durationMinutes,
    sectionDurations: test.sectionDurations || { SUPR: 60, REAP: 120 },
    instructions: Array.isArray(test.instructions) ? test.instructions : [],
    benchmarkScores: Array.isArray(test.benchmarkScores) ? test.benchmarkScores : [],
    totalMarks: test.totalMarks || 0,
    negativeMarks: test.negativeMarks,
    questionIds: accessible ? (test.questionIds || []).map((id) => String(id)) : [],
    questionCount: Array.isArray(test.questionIds) ? test.questionIds.length : 0,
    updatedAt: test.updatedAt,
    createdAt: test.createdAt,
  };
}

function mapPublicQuestion(question) {
  return {
    id: String(question._id),
    section: question.section,
    topic: question.topic,
    difficulty: question.difficulty,
    prompt: question.prompt,
    passage: question.passage || "",
    imageUrls: Array.isArray(question.imageUrls) ? question.imageUrls : [],
    imageUrl: (Array.isArray(question.imageUrls) && question.imageUrls[0]) || "",
    options: Array.isArray(question.options) ? question.options : [],
    marks: question.marks,
    negativeMarks: question.negativeMarks,
    createdAt: question.createdAt,
    updatedAt: question.updatedAt,
  };
}

async function getCatalogPayload({ paidOk, isAdmin }) {
  const accessKey = paidOk || isAdmin ? "paid" : "free";
  const cacheKey = `catalog:${accessKey}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const tests = await Test.find({ status: "live", deletedAt: null })
    .select(TEST_PUBLIC_FIELDS)
    .sort({ displayOrder: 1, createdAt: 1 })
    .lean();

  const allowedQuestionIds = Array.from(
    new Set(
      tests
        .filter((test) => Boolean(test.isFree) || paidOk || isAdmin)
        .flatMap((test) => (test.questionIds || []).map((id) => String(id)))
    )
  );

  const questions = allowedQuestionIds.length
    ? await Question.find({ _id: { $in: allowedQuestionIds }, deletedAt: null })
        .select(QUESTION_PUBLIC_FIELDS)
        .lean()
    : [];

  const payload = {
    tests: tests.map((test) => mapPublicTest(test, paidOk, isAdmin)),
    questions: questions.map(mapPublicQuestion),
  };

  return cache.set(cacheKey, payload, TEST_LIST_TTL_MS);
}

async function getTestRuntimeSnapshot(testId) {
  const cacheKey = `runtime:${String(testId)}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const test = await Test.findOne({ _id: testId, deletedAt: null })
    .select("status isFree negativeMarks durationMinutes sectionDurations benchmarkScores totalMarks questionIds")
    .lean();

  if (!test) return null;

  const questionIds = Array.isArray(test.questionIds) ? test.questionIds.map((id) => String(id)) : [];
  const questions = questionIds.length
    ? await Question.find({ _id: { $in: questionIds }, deletedAt: null })
        .select(QUESTION_SCORING_FIELDS)
        .lean()
    : [];

  if (!questions.length || questions.length !== questionIds.length) {
    return null;
  }

  const normalizedQuestions = questions.map((question) => ({
    id: String(question._id),
    section: question.section,
    topic: question.topic,
    prompt: question.prompt,
    passage: question.passage || "",
    imageUrls: Array.isArray(question.imageUrls) ? question.imageUrls : [],
    options: Array.isArray(question.options) ? question.options : [],
    marks: question.marks,
    negativeMarks: question.negativeMarks,
    correctOption: question.correctOption,
    explanation: question.explanation || "",
  }));

  const snapshot = { test, questions: normalizedQuestions };
  return cache.set(cacheKey, snapshot, TEST_RUNTIME_TTL_MS);
}

function invalidateCatalogCache() {
  cache.deleteByPrefix("catalog:");
}

function invalidateTestRuntimeCache(testId) {
  cache.delete(`runtime:${String(testId)}`);
}

function invalidateAllTestCaches() {
  cache.deleteByPrefix("catalog:");
  cache.deleteByPrefix("runtime:");
}

module.exports = {
  getCatalogPayload,
  getTestRuntimeSnapshot,
  invalidateCatalogCache,
  invalidateTestRuntimeCache,
  invalidateAllTestCaches,
};
