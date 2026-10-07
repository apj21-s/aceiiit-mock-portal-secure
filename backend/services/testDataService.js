const Question = require("../models/Question");
const QotdPick = require("../models/QotdPick");
const Test = require("../models/Test");
const { MemoryCache } = require("../utils/memoryCache");

const cache = new MemoryCache(64);

const TEST_LIST_TTL_MS = 60 * 1000;
const TEST_RUNTIME_TTL_MS = 5 * 60 * 1000;

const TEST_PUBLIC_FIELDS =
  "title subtitle series type isFree status displayOrder durationMinutes sectionDurations instructions benchmarkScores totalMarks negativeMarks questionIds shuffleQuestions shuffleOptions integrity seasonId createdAt updatedAt";

const QUESTION_PUBLIC_FIELDS =
  "section topic difficulty prompt passage imageUrls options marks negativeMarks createdAt updatedAt";

const QUESTION_SCORING_FIELDS =
  "section topic prompt passage imageUrls options marks negativeMarks correctOption explanation";

function integrityOf(test) {
  return {
    mode: (test.integrity && test.integrity.mode) || "warn",
    warnThreshold: Number((test.integrity && test.integrity.warnThreshold) || 1),
    autoSubmitThreshold: Number((test.integrity && test.integrity.autoSubmitThreshold) || 5),
  };
}

/**
 * Catalog metadata. Never includes question ids or questions: those are served only
 * through an exam session's paper. `sectionSummary` (counts/marks) is only shared with
 * students who can access the test.
 */
function mapCatalogTest(test, accessible, sectionSummary) {
  return {
    id: String(test._id),
    title: test.title,
    subtitle: test.subtitle || "",
    series: test.series || "UGEE 2026",
    type: test.type || "practice",
    isFree: Boolean(test.isFree),
    status: test.status,
    displayOrder: Number.isFinite(Number(test.displayOrder)) ? Number(test.displayOrder) : 100,
    durationMinutes: test.durationMinutes,
    sectionDurations: test.sectionDurations || { SUPR: 60, REAP: 120 },
    instructions: Array.isArray(test.instructions) ? test.instructions : [],
    benchmarkScores: Array.isArray(test.benchmarkScores) ? test.benchmarkScores : [],
    totalMarks: accessible ? test.totalMarks || 0 : 0,
    negativeMarks: test.negativeMarks,
    questionIds: [],
    questionCount: Array.isArray(test.questionIds) ? test.questionIds.length : 0,
    accessible: Boolean(accessible),
    sectionSummary: accessible ? sectionSummary : null,
    shuffleQuestions: Boolean(test.shuffleQuestions),
    shuffleOptions: Boolean(test.shuffleOptions),
    integrity: integrityOf(test),
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

async function getLiveCatalogBase() {
  const cacheKey = "catalog:base";
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const tests = await Test.find({ status: "live", deletedAt: null })
    .select(TEST_PUBLIC_FIELDS)
    .sort({ displayOrder: 1, createdAt: 1 })
    .lean();
  const questionIds = Array.from(new Set(tests.flatMap((t) => (t.questionIds || []).map(String))));
  const questions = questionIds.length
    ? await Question.find({ _id: { $in: questionIds } }).select("_id section marks").lean()
    : [];
  const byId = new Map(questions.map((q) => [String(q._id), q]));
  const entries = tests.map((test) => {
    const summary = { SUPR: { count: 0, marks: 0 }, REAP: { count: 0, marks: 0 } };
    (test.questionIds || []).forEach((id) => {
      const q = byId.get(String(id));
      if (!q) return;
      const section = q.section === "REAP" ? "REAP" : "SUPR";
      summary[section].count += 1;
      summary[section].marks += Number(q.marks || 0);
    });
    return { test, sectionSummary: summary };
  });
  return cache.set(cacheKey, entries, TEST_LIST_TTL_MS);
}

/**
 * Per-request catalog: shared cached metadata + this user's access flags, computed with the
 * same rule as canAccessTest (free OR admin OR active entitlement for the test's season).
 */
async function getCatalogPayload({ isAdmin, entitledSeasonIds, activeSeasonId }) {
  const base = await getLiveCatalogBase();
  const seasonIds = entitledSeasonIds || new Set();
  const tests = base.map(({ test, sectionSummary }) => {
    let accessible = Boolean(test.isFree) || Boolean(isAdmin);
    if (!accessible) {
      const seasonId = test.seasonId ? String(test.seasonId) : activeSeasonId ? String(activeSeasonId) : null;
      accessible = Boolean(seasonId && seasonIds.has(seasonId));
    }
    return mapCatalogTest(test, accessible, sectionSummary);
  });
  return { tests, questions: [] };
}

async function getPublicQuestionsForTest(testId) {
  const cacheKey = `public-questions:${String(testId)}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const test = await Test.findOne({ _id: testId, deletedAt: null })
    .select("questionIds")
    .lean();

  if (!test) return null;

  const questionIds = Array.isArray(test.questionIds) ? test.questionIds.map((id) => String(id)) : [];
  // Referenced questions are loaded even if soft-deleted, so an attached question being
  // trashed can never "brick" a test.
  const questions = questionIds.length
    ? await Question.find({ _id: { $in: questionIds } })
        .select(QUESTION_PUBLIC_FIELDS)
        .lean()
    : [];

  const questionMap = questions.reduce((acc, question) => {
    acc[String(question._id)] = mapPublicQuestion(question);
    return acc;
  }, {});

  const ordered = questionIds.map((id) => questionMap[id]).filter(Boolean);
  return cache.set(cacheKey, ordered, TEST_RUNTIME_TTL_MS);
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
    ? await Question.find({ _id: { $in: questionIds } })
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

/** Calendar date in India (the QOTD rolls over at IST midnight for every student). */
function qotdDateKey(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/**
 * Picks today's question deterministically from questions in live, FREE tests only, so
 * paid or draft content can never leak. Returns the question without the answer; the
 * answer is revealed only by a QOTD submission.
 */
async function getQuestionOfTheDay(now = new Date()) {
  const dateKey = qotdDateKey(now);
  const cacheKey = `qotd:${dateKey}`;
  const cached = cache.get(cacheKey);
  if (cached !== null) return cached.value;

  const freeTests = await Test.find({ status: "live", isFree: true, deletedAt: null }).select("questionIds").lean();
  const ids = Array.from(new Set(freeTests.flatMap((t) => (t.questionIds || []).map(String)))).sort();
  let picked = null;
  if (ids.length) {
    const candidates = await Question.find({ _id: { $in: ids }, deletedAt: null })
      .select("_id section topic prompt options imageUrls")
      .lean();
    const eligible = candidates
      .filter((q) => Array.isArray(q.options) && q.options.length >= 2)
      .filter((q) => !(q.imageUrls && q.imageUrls.length) && String(q.prompt || "").indexOf("<img") === -1)
      .sort((x, y) => String(x._id).localeCompare(String(y._id)));
    if (eligible.length) {
      let hash = 0;
      for (let i = 0; i < dateKey.length; i += 1) hash = (Math.imul(hash, 31) + dateKey.charCodeAt(i)) | 0;
      const proposal = eligible[Math.abs(hash) % eligible.length];
      // First request of the day fixes the pick; later requests reuse it.
      const pick = await QotdPick.findOneAndUpdate(
        { date: dateKey },
        { $setOnInsert: { date: dateKey, questionId: proposal._id } },
        { upsert: true, new: true }
      ).lean();
      // If the stored pick is no longer eligible (deleted/unpublished), fall back to today's proposal.
      const q = eligible.find((c) => String(c._id) === String(pick.questionId)) || proposal;
      picked = { id: String(q._id), date: dateKey, section: q.section, topic: q.topic, prompt: q.prompt, options: q.options };
    }
  }
  cache.set(cacheKey, { value: picked }, 60 * 60 * 1000);
  return picked;
}

function invalidateCatalogCache() {
  cache.deleteByPrefix("catalog:");
}

function invalidateTestRuntimeCache(testId) {
  cache.delete(`runtime:${String(testId)}`);
  cache.delete(`public-questions:${String(testId)}`);
}

function invalidateAllTestCaches() {
  cache.deleteByPrefix("catalog:");
  cache.deleteByPrefix("qotd:");
  cache.deleteByPrefix("runtime:");
  cache.deleteByPrefix("public-questions:");
}

module.exports = {
  getCatalogPayload,
  getPublicQuestionsForTest,
  getTestRuntimeSnapshot,
  invalidateCatalogCache,
  invalidateTestRuntimeCache,
  invalidateAllTestCaches,
  getQuestionOfTheDay,
  qotdDateKey,
};
