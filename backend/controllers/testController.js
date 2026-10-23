const { z } = require("zod");

const AppConfig = require("../models/AppConfig");
const Test = require("../models/Test");
const User = require("../models/User");
const Question = require("../models/Question");
const Attempt = require("../models/Attempt");
const { canAccessTest, getEntitledSeasonIds, isTestAccessible, lockedQuestionIds } = require("../services/entitlementService");
const { getActiveSeason } = require("../services/seasonService");
const { heldTestIds } = require("../services/liveEventService");
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
    payload.practiceTests = await listOwnPracticeTests(req.auth.userId);
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
      .select("title subtitle series type isFree status publishAt displayOrder durationMinutes sectionDurations instructions benchmarkScores totalMarks negativeMarks questionIds seasonId shuffleQuestions shuffleOptions integrity updatedAt createdAt")
      .lean();
    if (!test || (!["live", "scheduled"].includes(test.status) && req.auth.role !== "admin")) {
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
  status: z.enum(["draft", "scheduled", "live"]).optional(),
  publishAt: z.union([z.string().datetime({ offset: true }), z.null()]).optional(),
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
  // Live mock event (needs Scheduled publishing): join window and results time.
  event: z
    .object({
      enabled: z.boolean(),
      joinMinutes: z.number().int().min(5).max(180).optional(),
      resultsAt: z.union([z.string().datetime({ offset: true }), z.null()]).optional(),
    })
    .strict()
    .optional(),
});

const eventError = (message, code) => Object.assign(new Error(message), { status: 400, expose: true, code });

/**
 * Live-event rules shared by create and update. An event starts when the test opens (its
 * scheduled time, or now when it's published early), lets students join for `joinMinutes`, and
 * holds results until `resultsAt`, which must leave time for the last joiner to finish.
 * Returns the event to store, or undefined to leave it as it is.
 */
function resolveEvent(input, current, schedule, totalMinutes) {
  const previous = (current && current.event) || {};
  const wanted = input.event !== undefined ? input.event : (previous.enabled ? { enabled: true } : undefined);
  if (wanted === undefined) return undefined;
  if (!wanted.enabled) return { enabled: false, startsAt: null, joinMinutes: previous.joinMinutes || 15, resultsAt: null };
  let startsAt;
  if (schedule.status === "scheduled") startsAt = schedule.publishAt;
  else if (schedule.status === "live") startsAt = previous.enabled && previous.startsAt ? new Date(previous.startsAt) : new Date();
  else throw eventError("A live event needs Scheduled publishing (or an event that's already running).", "EVENT_NEEDS_SCHEDULE");
  const joinMinutes = wanted.joinMinutes !== undefined ? wanted.joinMinutes : previous.joinMinutes || 15;
  const rawResults = wanted.resultsAt !== undefined ? wanted.resultsAt : previous.resultsAt;
  const resultsAt = rawResults ? new Date(rawResults) : null;
  if (!resultsAt || Number.isNaN(resultsAt.getTime())) throw eventError("Pick when the results come out.", "EVENT_RESULTS_REQUIRED");
  const earliest = new Date(startsAt).getTime() + (joinMinutes + totalMinutes) * 60000;
  if (resultsAt.getTime() < earliest) {
    throw eventError(`Results must come out after the last student can finish (${joinMinutes} min to join + ${totalMinutes} min paper).`, "EVENT_RESULTS_TOO_EARLY");
  }
  return { enabled: true, startsAt, joinMinutes, resultsAt };
}

/**
 * Scheduling rules shared by create and update: "scheduled" needs a future publishAt; any other
 * status clears it. Returns { status, publishAt } or throws a 400.
 */
function resolveSchedule(input, current = {}) {
  const status = input.status !== undefined ? input.status : current.status || "draft";
  if (status !== "scheduled") return { status, publishAt: null };
  const raw = input.publishAt !== undefined ? input.publishAt : current.publishAt;
  const when = raw ? new Date(raw) : null;
  if (!when || Number.isNaN(when.getTime())) throw Object.assign(new Error("Pick the date and time the test should go live."), { status: 400, expose: true, code: "SCHEDULE_REQUIRED" });
  if (when.getTime() <= Date.now() + 30 * 1000) throw Object.assign(new Error("The go-live time must be in the future."), { status: 400, expose: true, code: "SCHEDULE_IN_PAST" });
  return { status, publishAt: when };
}

async function createTest(req, res, next) {
  try {
    const input = testInputSchema.parse(req.body || {});
    const sectionDurations = input.sectionDurations || { SUPR: 60, REAP: 120 };
    const schedule = resolveSchedule(input);
    const event = resolveEvent(input, null, schedule, sectionDurations.SUPR + sectionDurations.REAP);
    const test = await Test.create({
      title: input.title,
      subtitle: input.subtitle || "",
      series: input.series || "UGEE 2026",
      type: input.type || "practice",
      isFree: Boolean(input.isFree),
      status: schedule.status,
      publishAt: schedule.publishAt,
      ...(event ? { event } : {}),
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
    const before = { status: test.status, publishAt: test.publishAt, event: test.event ? test.event.toObject() : {} };
    if (input.status !== undefined || input.publishAt !== undefined) {
      const schedule = resolveSchedule(input, { status: test.status, publishAt: test.publishAt });
      test.status = schedule.status;
      test.publishAt = schedule.publishAt;
    }
    if (input.displayOrder !== undefined) test.displayOrder = input.displayOrder;
    if (input.sectionDurations) {
      test.sectionDurations = input.sectionDurations;
      test.durationMinutes = input.sectionDurations.SUPR + input.sectionDurations.REAP;
    }
    if (input.event !== undefined || input.status !== undefined || input.publishAt !== undefined || input.sectionDurations) {
      // A schedule moved, a draft, or "Publish now" all re-check the event's times.
      const keepRunning = before.status === "live" && test.status === "live";
      const event = resolveEvent(input, { event: keepRunning ? before.event : { ...before.event, startsAt: null } }, { status: test.status, publishAt: test.publishAt }, test.durationMinutes);
      if (event) test.event = event;
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
// Untimed papers show no countdown, but the server still closes them at this cap.
const UNTIMED_PRACTICE_MINUTES = 300;
const FREE_PRACTICE_LIMIT = 1;
const PRACTICE_LIST_LIMIT = 30;
// Students pick a paper size, never see how many questions exist: exact counts make topics look
// thin and give the bank away. A subject is offered only if it can fill the smallest size, and
// each subject reports only the largest size it can fill.
const PRACTICE_SIZES = [5, 10, 15, 20, 25, 30];
const MIN_PRACTICE_POOL = PRACTICE_SIZES[0];

function maxPracticeSize(available) {
  return PRACTICE_SIZES.filter((size) => size <= available).pop() || 0;
}

const practiceSchema = z.object({
  // "all" | "SUPR" | "REAP" | "topic:<SECTION>:<topic>" (older clients sent a bare word)
  subject: z.string().trim().min(1).max(120).default("all"),
  difficulty: z.enum(["all", "easy", "medium", "hard"]).default("all"),
  count: z.coerce.number().int().min(1).max(100).default(10),
  timerMinutes: z.coerce.number().int().min(0).max(300).default(0),
});

const practiceOptionsSchema = z.object({
  difficulty: z.enum(["all", "easy", "medium", "hard"]).default("all"),
});

function shuffleInPlace(items) {
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

const sectionOf = (question) => (question.section === "REAP" ? "REAP" : "SUPR");
const topicKey = (topic) => String(topic || "").trim().toLowerCase();

/** Questions this student may practise: those in live tests they can access. */
async function practicePool(req, difficulty = "all") {
  const isAdmin = req.auth.role === "admin";
  const [entitledSeasonIds, activeSeason] = await Promise.all([getEntitledSeasonIds(req.auth), getActiveSeason()]);
  const liveTests = await Test.find({ status: "live", deletedAt: null }).select("isFree seasonId questionIds").lean();
  const accessibleIds = new Set();
  liveTests
    .filter((test) => isTestAccessible(test, { isAdmin, entitledSeasonIds, activeSeasonId: activeSeason && activeSeason._id }))
    .forEach((test) => (test.questionIds || []).forEach((id) => accessibleIds.add(String(id))));
  const filter = { _id: { $in: Array.from(accessibleIds) }, deletedAt: null };
  if (difficulty !== "all") filter.difficulty = difficulty;
  const pool = await Question.find(filter).select("_id section topic").lean();
  return { pool, isAdmin, entitledSeasonIds };
}

function filterBySubject(pool, subject) {
  if (subject === "all") return pool;
  if (subject === "SUPR" || subject === "REAP") return pool.filter((q) => sectionOf(q) === subject);
  const topicMatch = /^topic:(SUPR|REAP):(.+)$/.exec(subject);
  if (topicMatch) {
    const key = topicKey(topicMatch[2]);
    return pool.filter((q) => sectionOf(q) === topicMatch[1] && topicKey(q.topic) === key);
  }
  const needle = topicKey(subject);
  return pool.filter((q) => topicKey(q.topic).includes(needle));
}

/**
 * Splits a paper's minutes between its sections by question count. A section with no
 * questions gets 0 (the session then skips it); each present section gets at least a minute.
 */
function splitPracticeMinutes(totalMinutes, counts) {
  if (!counts.SUPR) return { SUPR: 0, REAP: totalMinutes };
  if (!counts.REAP) return { SUPR: totalMinutes, REAP: 0 };
  const total = Math.max(2, totalMinutes);
  const supr = Math.min(total - 1, Math.max(1, Math.round((total * counts.SUPR) / (counts.SUPR + counts.REAP))));
  return { SUPR: supr, REAP: total - supr };
}

function practiceTestView(test) {
  return {
    id: String(test._id),
    title: test.title,
    subtitle: test.subtitle,
    series: test.series,
    isPractice: true,
    isFree: true,
    status: "live",
    untimed: Boolean(test.untimed),
    createdBy: String(test.ownerUserId),
    questionIds: [],
    questionCount: Array.isArray(test.questionIds) ? test.questionIds.length : 0,
    sectionDurations: test.sectionDurations,
    durationMinutes: test.durationMinutes,
    createdAt: test.createdAt,
  };
}

/** The student's own practice papers, newest first, so they follow the account across devices. */
async function listOwnPracticeTests(userId) {
  const tests = await Test.find({ ownerUserId: userId, status: "practice", deletedAt: null })
    .sort({ createdAt: -1 })
    .limit(PRACTICE_LIST_LIMIT)
    .select("title subtitle series ownerUserId untimed sectionDurations durationMinutes questionIds createdAt")
    .lean();
  return tests.map(practiceTestView);
}

/**
 * What the practice builder can offer. Students get subjects with the largest paper size each
 * can fill (no question counts; subjects too thin for the smallest size are left out). Admins
 * also get the exact counts.
 */
async function getPracticeOptions(req, res, next) {
  try {
    const { difficulty } = practiceOptionsSchema.parse(req.query || {});
    const { pool, isAdmin } = await practicePool(req, difficulty);
    const sections = { SUPR: 0, REAP: 0 };
    const topics = new Map();
    pool.forEach((question) => {
      const section = sectionOf(question);
      sections[section] += 1;
      const name = String(question.topic || "").trim();
      if (!name) return;
      const key = `${section}|${topicKey(name)}`;
      const entry = topics.get(key) || { topic: name, section, count: 0 };
      entry.count += 1;
      topics.set(key, entry);
    });
    const topicList = Array.from(topics.values()).sort((a, b) => a.section.localeCompare(b.section) || a.topic.localeCompare(b.topic));
    const subject = (value, label, kind, section, count) => ({
      value,
      label,
      kind,
      section,
      maxSize: maxPracticeSize(count),
      ...(isAdmin ? { count } : {}),
    });
    const subjects = [
      subject("all", "All subjects", "all", null, pool.length),
      subject("SUPR", "SUPR – all topics", "section", "SUPR", sections.SUPR),
      subject("REAP", "REAP – all topics", "section", "REAP", sections.REAP),
      ...topicList.map((t) => subject(`topic:${t.section}:${t.topic}`, t.topic, "topic", t.section, t.count)),
    ].filter((entry) => isAdmin || entry.maxSize > 0);
    res.json({
      sizes: PRACTICE_SIZES,
      subjects,
      ...(isAdmin ? { total: pool.length, sections, topics: topicList } : {}),
    });
  } catch (err) {
    next(err);
  }
}

/** Saves a private practice paper: SUPR first, then REAP, minutes split by question count. */
async function createPracticePaper(ownerUserId, selected, label, timerMinutes) {
  selected.sort((a, b) => (sectionOf(a) === sectionOf(b) ? 0 : sectionOf(a) === "SUPR" ? -1 : 1));
  const counts = { SUPR: 0, REAP: 0 };
  selected.forEach((q) => { counts[sectionOf(q)] += 1; });
  const untimed = timerMinutes === 0;
  const totalMinutes = untimed ? UNTIMED_PRACTICE_MINUTES : timerMinutes;
  const sectionDurations = splitPracticeMinutes(totalMinutes, counts);
  const questionWord = selected.length === 1 ? "Question" : "Questions";
  return Test.create({
    title: `Practice: ${label}`.slice(0, 120),
    subtitle: `${selected.length} ${questionWord} • ${untimed ? "Untimed" : `${totalMinutes} Mins`}`,
    series: "Practice",
    type: "practice",
    isFree: true,
    isPractice: true,
    status: "practice",
    untimed,
    ownerUserId,
    sectionDurations,
    durationMinutes: sectionDurations.SUPR + sectionDurations.REAP,
    questionIds: selected.map((q) => q._id),
  });
}

async function freePracticeLimitReached(req, isAdmin, entitledSeasonIds) {
  if (isAdmin || entitledSeasonIds.size > 0) return false;
  const used = await Test.countDocuments({ ownerUserId: req.auth.userId, status: "practice" });
  return used >= FREE_PRACTICE_LIMIT;
}

const PRACTICE_LIMIT_ERROR = { error: "Free accounts include one custom practice session. Buy the test series for unlimited practice.", code: "PRACTICE_LIMIT" };

// ---------------------------------------------------------------------------
// Mistake practice: questions whose latest answer (in any mock or practice paper) was wrong
// or skipped. Getting one right later takes it off the list. Questions the student can no
// longer open (paid access ended) and deleted questions are left out.
// ---------------------------------------------------------------------------
const mistakesSchema = z.object({
  count: z.coerce.number().int().min(1).max(30).default(10),
  section: z.enum(["all", "SUPR", "REAP"]).default("all"),
  timerMinutes: z.coerce.number().int().min(0).max(300).default(0),
}).strict();

async function dueMistakes(req) {
  const attempts = await Attempt.find({ userId: req.auth.userId, invalidatedAt: null })
    .select("testId submittedAt questionReview.questionId questionReview.status")
    .sort({ submittedAt: 1 })
    .lean();
  // Results of a live event aren't out yet: their answers can't count until then.
  const held = await heldTestIds(attempts.map((a) => a.testId));
  const latest = new Map();
  attempts.forEach((attempt) => {
    if (held.has(String(attempt.testId))) return;
    (attempt.questionReview || []).forEach((item) => {
      if (item && item.questionId) latest.set(String(item.questionId), item.status);
    });
  });
  const dueIds = Array.from(latest.entries()).filter(([, status]) => status === "wrong" || status === "skipped").map(([id]) => id);
  if (!dueIds.length) return [];
  const [questions, locked] = await Promise.all([
    Question.find({ _id: { $in: dueIds }, deletedAt: null }).select("_id section topic").lean(),
    lockedQuestionIds(req.auth),
  ]);
  return questions.filter((q) => !locked.has(String(q._id)));
}

async function getMistakeOptions(req, res, next) {
  try {
    const due = await dueMistakes(req);
    const bySection = { SUPR: 0, REAP: 0 };
    due.forEach((q) => { bySection[sectionOf(q)] += 1; });
    res.json({ available: due.length, bySection, sizes: PRACTICE_SIZES });
  } catch (err) {
    next(err);
  }
}

async function createMistakePractice(req, res, next) {
  try {
    const input = mistakesSchema.parse(req.body || {});
    const isAdmin = req.auth.role === "admin";
    const entitledSeasonIds = await getEntitledSeasonIds(req.auth);
    if (await freePracticeLimitReached(req, isAdmin, entitledSeasonIds)) return res.status(402).json(PRACTICE_LIMIT_ERROR);
    const due = (await dueMistakes(req)).filter((q) => input.section === "all" || sectionOf(q) === input.section);
    if (!due.length) {
      return res.status(400).json({ error: "No mistakes to practise right now. Every question you got wrong or skipped has since been answered correctly.", code: "MISTAKES_NONE" });
    }
    const selected = shuffleInPlace(due.slice()).slice(0, Math.min(input.count, due.length));
    const label = input.section === "all" ? "My mistakes" : `My ${input.section} mistakes`;
    const test = await createPracticePaper(req.auth.userId, selected, label, input.timerMinutes);
    return res.status(201).json({ test: practiceTestView(test) });
  } catch (err) {
    next(err);
  }
}

async function createPracticeTest(req, res, next) {
  try {
    const input = practiceSchema.parse(req.body || {});
    const { pool, isAdmin, entitledSeasonIds } = await practicePool(req, input.difficulty);

    if (await freePracticeLimitReached(req, isAdmin, entitledSeasonIds)) return res.status(402).json(PRACTICE_LIMIT_ERROR);

    const subjectPool = filterBySubject(pool, input.subject);
    if (!isAdmin) {
      if (!PRACTICE_SIZES.includes(input.count)) {
        return res.status(400).json({ error: `Choose a paper size of ${PRACTICE_SIZES.join(", ")} questions.`, code: "PRACTICE_SIZE" });
      }
      if (/^topic:/.test(input.subject) && subjectPool.length < MIN_PRACTICE_POOL) {
        return res.status(400).json({ error: "This topic isn't available for practice yet. Try another topic.", code: "PRACTICE_EMPTY" });
      }
      if (subjectPool.length && subjectPool.length < input.count) {
        return res.status(400).json({ error: "Not enough questions for that size yet. Choose a smaller set.", code: "PRACTICE_TOO_LARGE" });
      }
    }
    const selected = shuffleInPlace(subjectPool.slice()).slice(0, input.count);
    if (!selected.length) {
      return res.status(400).json({ error: "No questions match these practice filters yet. Try another subject or difficulty.", code: "PRACTICE_EMPTY" });
    }

    const topicMatch = /^topic:(SUPR|REAP):(.+)$/.exec(input.subject);
    const subjectLabel = input.subject === "all"
      ? "Mixed Subjects"
      : (topicMatch ? topicMatch[2].trim() : input.subject);
    const test = await createPracticePaper(req.auth.userId, selected, subjectLabel, input.timerMinutes);
    return res.status(201).json({ test: practiceTestView(test) });
  } catch (err) {
    next(err);
  }
}

module.exports = { PRACTICE_SIZES, createPracticeTest, getPracticeOptions, getMistakeOptions, createMistakePractice, listOwnPracticeTests, splitPracticeMinutes, listTests, getTestById, getTestQuestions, createTest, updateTest, deleteTest, submitQotdAttempt };
