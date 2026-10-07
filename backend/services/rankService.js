const Attempt = require("../models/Attempt");
const { MemoryCache } = require("../utils/memoryCache");

// Rank and percentile are computed on read from the current attempt population, so they
// stay correct as more students submit. They are never frozen onto the attempt document.
// Ordering: higher score first, then shorter *server-measured* duration, then earlier
// submission. Admin, practice and invalidated attempts are excluded from the cohort.

const rankCache = new MemoryCache(256);
const RANK_CACHE_TTL_MS = 15 * 1000;

const COHORT_FILTER = {
  userRole: { $ne: "admin" },
  isPractice: { $ne: true },
  invalidatedAt: null,
};

function isRankable(attempt) {
  if (!attempt) return false;
  if (String(attempt.userRole || "student").toLowerCase() === "admin") return false;
  if (attempt.isPractice) return false;
  if (attempt.invalidatedAt) return false;
  return true;
}

function cacheKey(testId, attemptNumber) {
  return `rank:${String(testId)}:${Number(attemptNumber)}`;
}

function compareEntries(a, b) {
  if (b.score !== a.score) return b.score - a.score;
  if (a.time !== b.time) return a.time - b.time;
  return a.submittedAt - b.submittedAt;
}

async function loadCohort(testId, attemptNumber) {
  const key = cacheKey(testId, attemptNumber);
  const cached = rankCache.get(key);
  if (cached) return cached;
  const rows = await Attempt.find({ testId, attemptNumber, ...COHORT_FILTER })
    .select("_id score timeTakenSeconds submittedAt")
    .lean();
  const entries = rows
    .map((row) => ({
      id: String(row._id),
      score: Number(row.score || 0),
      time: Number(row.timeTakenSeconds || 0),
      submittedAt: new Date(row.submittedAt).getTime(),
    }))
    .sort(compareEntries);
  const index = new Map(entries.map((entry, i) => [entry.id, i]));
  const cohort = { entries, index };
  rankCache.set(key, cohort, RANK_CACHE_TTL_MS);
  return cohort;
}

function percentileFor(rank, total) {
  if (!total || !rank) return 0;
  if (total === 1) return 100;
  const value = ((total - rank) / (total - 1)) * 100;
  return Math.max(0, Math.min(100, Number(value.toFixed(2))));
}

async function getRankFor(attempt) {
  if (!isRankable(attempt)) return { rank: 0, percentile: 0, total: 0 };
  const cohort = await loadCohort(attempt.testId, attempt.attemptNumber);
  const position = cohort.index.get(String(attempt._id || attempt.id));
  if (position === undefined) return { rank: 0, percentile: 0, total: cohort.entries.length };
  const rank = position + 1;
  const total = cohort.entries.length;
  return { rank, percentile: percentileFor(rank, total), total };
}

/** Batch variant for lists; loads each (test, attemptNumber) cohort at most once. */
async function getRanksForAttempts(attempts) {
  const result = new Map();
  for (const attempt of attempts || []) {
    result.set(String(attempt._id || attempt.id), await getRankFor(attempt));
  }
  return result;
}

function invalidateRankCache(testId) {
  rankCache.deleteByPrefix(`rank:${String(testId)}:`);
}

module.exports = { getRankFor, getRanksForAttempts, invalidateRankCache, percentileFor, COHORT_FILTER };
