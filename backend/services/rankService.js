const Attempt = require("../models/Attempt");
const { MemoryCache } = require("../utils/memoryCache");

const rankCache = new MemoryCache(128);
const RANK_CACHE_TTL_MS = 15 * 1000;
const inflight = new Map();

const NON_ADMIN_FILTER = {
  $or: [
    { userRole: { $exists: false } },
    { userRole: { $ne: "admin" } },
  ],
};

function compareEntries(a, b) {
  if (Number(b.score || 0) !== Number(a.score || 0)) {
    return Number(b.score || 0) - Number(a.score || 0);
  }
  if (Number(a.timeTakenSeconds || 0) !== Number(b.timeTakenSeconds || 0)) {
    return Number(a.timeTakenSeconds || 0) - Number(b.timeTakenSeconds || 0);
  }
  return Number(a.submittedAt || 0) - Number(b.submittedAt || 0);
}

function buildCacheKey(testId, attemptNumber) {
  return `rank:${String(testId)}:${Number(attemptNumber)}`;
}

async function loadRankSnapshot(testId, attemptNumber) {
  const cacheKey = buildCacheKey(testId, attemptNumber);
  const cached = rankCache.get(cacheKey);
  if (cached) return cached;

  const entries = await Attempt.find({ testId, attemptNumber, ...NON_ADMIN_FILTER })
    .select("_id score timeTakenSeconds submittedAt")
    .sort({ score: -1, timeTakenSeconds: 1, submittedAt: 1 })
    .lean();

  const snapshot = entries.map((entry) => ({
    id: String(entry._id),
    score: Number(entry.score || 0),
    timeTakenSeconds: Number(entry.timeTakenSeconds || 0),
    submittedAt: new Date(entry.submittedAt).getTime(),
  }));

  rankCache.set(cacheKey, snapshot, RANK_CACHE_TTL_MS);
  return snapshot;
}

function insertIntoSnapshot(entries, attempt) {
  const id = String(attempt.id || attempt._id || "");
  const alreadyPresent = entries.some((entry) => entry.id === id);
  const nextEntries = alreadyPresent
    ? entries.slice()
    : entries.concat({
        id,
        score: Number(attempt.score || 0),
        timeTakenSeconds: Number(attempt.timeTakenSeconds || 0),
        submittedAt: Number(attempt.submittedAt || 0),
      });

  nextEntries.sort(compareEntries);
  return nextEntries;
}

async function withKeyLock(key, work) {
  const previous = inflight.get(key) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => {
    release = resolve;
  });
  inflight.set(key, previous.then(() => current));

  try {
    await previous;
    return await work();
  } finally {
    release();
    if (inflight.get(key) === current) {
      inflight.delete(key);
    }
  }
}

async function computeRankAndPercentile({ testId, attemptNumber, attemptId, score, timeTakenSeconds, submittedAt }) {
  const cacheKey = buildCacheKey(testId, attemptNumber);
  return withKeyLock(cacheKey, async () => {
    const snapshot = await loadRankSnapshot(testId, attemptNumber);
    const entries = insertIntoSnapshot(snapshot, {
      id: attemptId,
      score,
      timeTakenSeconds,
      submittedAt: new Date(submittedAt).getTime(),
    });

    rankCache.set(cacheKey, entries, RANK_CACHE_TTL_MS);

    const rankIndex = entries.findIndex((entry) => String(entry.id) === String(attemptId));
    const rank = rankIndex === -1 ? entries.length : rankIndex + 1;
    const total = entries.length;
    const percentile = total ? ((total - rank) / total) * 100 : 0;

    return {
      rank,
      percentile: Math.max(0, Math.min(100, Number(percentile.toFixed(2)))),
    };
  });
}

function invalidateRankCache(testId, attemptNumber) {
  rankCache.delete(buildCacheKey(testId, attemptNumber));
}

module.exports = { computeRankAndPercentile, invalidateRankCache };
