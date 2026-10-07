const Attempt = require("../models/Attempt");
const { round } = require("./analyticsService");

// Small longitudinal view (V1): the change since the student's previous attempt and a
// short trajectory of recent accuracy. Deterministic, computed from stored attempts.

async function buildPerformanceProfile(attempt) {
  const recent = await Attempt.find({
    userId: attempt.userId,
    _id: { $ne: attempt._id },
    submittedAt: { $lt: attempt.submittedAt || new Date() },
    invalidatedAt: null,
  })
    .sort({ submittedAt: -1 })
    .limit(5)
    .select("score accuracy correctCount wrongCount skippedCount testId submittedAt")
    .lean();

  const previous = recent[0] || null;
  const total = (a) => Number(a.correctCount || 0) + Number(a.wrongCount || 0) + Number(a.skippedCount || 0);
  const attemptRate = (a) => (total(a) ? ((Number(a.correctCount || 0) + Number(a.wrongCount || 0)) / total(a)) * 100 : 0);

  return {
    previous: previous
      ? {
          sameTest: String(previous.testId) === String(attempt.testId),
          accuracyPctDelta: round(Number(attempt.accuracy || 0) - Number(previous.accuracy || 0), 1),
          scoreDelta: String(previous.testId) === String(attempt.testId) ? round(Number(attempt.score || 0) - Number(previous.score || 0), 2) : null,
          attemptRatePctDelta: round(attemptRate(attempt) - attemptRate(previous), 1),
        }
      : null,
    trajectory: recent
      .slice()
      .reverse()
      .map((a) => round(Number(a.accuracy || 0), 1))
      .concat([round(Number(attempt.accuracy || 0), 1)]),
  };
}

module.exports = { buildPerformanceProfile };
