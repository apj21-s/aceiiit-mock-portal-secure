const Test = require("../models/Test");
const { logger, errorSummary } = require("../utils/logger");

// Scheduled tests open by themselves: every 30 s, tests whose go-live time has passed become
// live (the catalog cache is refreshed so students see Start at once). Starting a test whose
// time has passed also opens it on the spot, so the 30 s tick is never a delay for students.
const DEFAULT_INTERVAL_MS = 30 * 1000;

async function openDueTests(now = new Date()) {
  const res = await Test.updateMany(
    { status: "scheduled", publishAt: { $ne: null, $lte: now }, deletedAt: null },
    { $set: { status: "live", publishAt: null } }
  );
  const opened = res.modifiedCount || 0;
  if (opened) {
    // Required lazily: testDataService pulls in models that require this file's callers.
    const { invalidateCatalogCache } = require("./testDataService");
    invalidateCatalogCache();
    logger.info({ opened }, "scheduled tests opened");
  }
  return opened;
}

let timer = null;

const testScheduler = {
  start(intervalMs = Number(process.env.TEST_SCHEDULER_INTERVAL_MS || DEFAULT_INTERVAL_MS)) {
    if (timer) return;
    timer = setInterval(() => {
      openDueTests().catch((err) => logger.warn({ err: errorSummary(err) }, "test scheduler tick failed"));
    }, Math.max(5000, intervalMs));
    if (timer.unref) timer.unref();
    openDueTests().catch(() => {});
  },
  stop() {
    if (timer) clearInterval(timer);
    timer = null;
  },
};

module.exports = { openDueTests, testScheduler };
