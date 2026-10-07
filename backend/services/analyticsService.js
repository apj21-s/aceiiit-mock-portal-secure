const Question = require("../models/Question");

// Deterministic, authoritative performance analytics computed from a finalized Attempt.
// Everything here is plain arithmetic over server-stored data; the AI layer only ever
// *interprets* these numbers and can never change them.

function round(value, digits = 1) {
  const factor = 10 ** digits;
  return Math.round(Number(value || 0) * factor) / factor;
}

function pct(part, whole) {
  return whole ? round((Number(part) / Number(whole)) * 100, 1) : 0;
}

function median(values) {
  const list = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!list.length) return 0;
  const mid = Math.floor(list.length / 2);
  return list.length % 2 ? list[mid] : round((list[mid - 1] + list[mid]) / 2, 1);
}

function bucketStats(items) {
  const attempted = items.filter((q) => q.status !== "skipped");
  const correct = items.filter((q) => q.status === "correct");
  const wrong = items.filter((q) => q.status === "wrong");
  const time = items.reduce((sum, q) => sum + Number(q.timeSpent || 0), 0);
  const marksLost = wrong.reduce((sum, q) => sum + Math.abs(Number(q.negativeMarks || 0)), 0);
  const marksGained = correct.reduce((sum, q) => sum + Number(q.marks || 0), 0);
  return {
    total: items.length,
    attempted: attempted.length,
    correct: correct.length,
    wrong: wrong.length,
    skipped: items.length - attempted.length,
    accuracyPct: pct(correct.length, attempted.length),
    attemptRatePct: pct(attempted.length, items.length),
    avgTimeSec: attempted.length ? round(attempted.reduce((s, q) => s + Number(q.timeSpent || 0), 0) / attempted.length, 0) : 0,
    totalTimeSec: Math.round(time),
    marksGained: round(marksGained, 2),
    marksLost: round(marksLost, 2),
  };
}

function groupBy(items, keyFn) {
  return items.reduce((acc, item) => {
    const key = keyFn(item);
    (acc[key] = acc[key] || []).push(item);
    return acc;
  }, {});
}

/**
 * Builds the evidence object for one attempt. `difficultyById` maps questionId → difficulty.
 */
function computeAttemptAnalytics(attempt, difficultyById = {}) {
  const review = (Array.isArray(attempt.questionReview) ? attempt.questionReview : []).map((q) => ({
    questionId: String(q.questionId),
    section: q.section === "REAP" ? "REAP" : "SUPR",
    topic: String(q.topic || "General").trim() || "General",
    status: q.status || (q.selectedOption === null || q.selectedOption === undefined ? "skipped" : q.isCorrect ? "correct" : "wrong"),
    timeSpent: Math.max(0, Number(q.timeSpent || 0)),
    marks: Number.isFinite(Number(q.marks)) ? Number(q.marks) : 4,
    negativeMarks: Number.isFinite(Number(q.negativeMarks)) ? Number(q.negativeMarks) : -1,
    difficulty: difficultyById[String(q.questionId)] || "medium",
  }));

  const overall = bucketStats(review);
  const attemptedTimes = review.filter((q) => q.status !== "skipped").map((q) => q.timeSpent);
  const medianTimeSec = median(attemptedTimes);

  const sections = Object.entries(groupBy(review, (q) => q.section)).map(([key, items]) => ({ key, ...bucketStats(items) }));
  const topics = Object.entries(groupBy(review, (q) => `${q.section}::${q.topic}`))
    .map(([key, items]) => {
      const [section, topic] = key.split("::");
      return { topic, section, ...bucketStats(items) };
    })
    .sort((a, b) => b.marksLost - a.marksLost || b.attempted - a.attempted);
  const difficulty = ["easy", "medium", "hard"]
    .map((level) => ({ level, ...bucketStats(review.filter((q) => q.difficulty === level)) }))
    .filter((b) => b.total > 0);

  // Timing relative to this student's own median (no external benchmark needed).
  const slowThreshold = medianTimeSec ? medianTimeSec * 1.75 : Infinity;
  const fastThreshold = medianTimeSec ? medianTimeSec * 0.4 : 0;
  const wrongItems = review.filter((q) => q.status === "wrong");
  const timeOnWrong = wrongItems.reduce((s, q) => s + q.timeSpent, 0);
  const timing = {
    medianTimeSec: Math.round(medianTimeSec),
    slowAttempted: review.filter((q) => q.status !== "skipped" && q.timeSpent > slowThreshold).length,
    slowWrong: wrongItems.filter((q) => q.timeSpent > slowThreshold).length,
    fastAttempted: review.filter((q) => q.status !== "skipped" && q.timeSpent > 0 && q.timeSpent < fastThreshold).length,
    fastWrong: wrongItems.filter((q) => q.timeSpent > 0 && q.timeSpent < fastThreshold).length,
    timeOnWrongSec: Math.round(timeOnWrong),
    timeOnWrongPct: pct(timeOnWrong, overall.totalTimeSec),
  };

  return {
    score: Number(attempt.score || 0),
    durationSec: Number(attempt.timeTakenSeconds || 0),
    overall: { ...overall, medianTimeSec: Math.round(medianTimeSec) },
    sections,
    topics,
    difficulty,
    timing,
  };
}

async function difficultyMapFor(attempt) {
  const ids = (attempt.questionReview || []).map((q) => q.questionId).filter(Boolean);
  if (!ids.length) return {};
  const rows = await Question.find({ _id: { $in: ids } }).select("_id difficulty").lean();
  return rows.reduce((acc, row) => {
    acc[String(row._id)] = row.difficulty || "medium";
    return acc;
  }, {});
}

module.exports = { computeAttemptAnalytics, difficultyMapFor, round, pct };
