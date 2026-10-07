const AttemptSession = require("../models/AttemptSession");
const { computeTimeline, finalizeSession } = require("./attemptSessionService");
const { logger, errorSummary } = require("../utils/logger");

// The server deadline runs independently of the browser. If a student closes the tab,
// loses power or never submits, this job expires the session at its deadline and
// finalizes the result from the server-saved answers. Each finalization is an atomic
// claim, so running several instances (or overlapping ticks) is safe.

const DEFAULT_INTERVAL_MS = 30 * 1000;
const BATCH_SIZE = 200;

async function sweepOnce(nowMs = Date.now()) {
  const finalized = [];
  const candidates = await AttemptSession.find({
    $or: [
      { status: "active" },
      { status: "finalizing", finalizingAt: { $lt: new Date(nowMs - 30 * 1000) } },
    ],
  })
    .sort({ startedAt: 1 })
    .limit(BATCH_SIZE);

  for (const session of candidates) {
    const due = session.status === "finalizing" || computeTimeline(session, nowMs).expired;
    if (!due) continue;
    try {
      const attempt = await finalizeSession(session._id, session.submittedReason || "deadline_expired");
      if (attempt) finalized.push(String(attempt._id));
    } catch (err) {
      logger.error({ err: errorSummary(err), sessionId: String(session._id) }, "attempt sweeper finalize failed");
    }
  }
  return finalized;
}

class AttemptSweeper {
  constructor() {
    this._timer = null;
    this._running = false;
    this.lastRunAt = null;
  }

  start(intervalMs = Number(process.env.ATTEMPT_SWEEP_INTERVAL_MS || DEFAULT_INTERVAL_MS)) {
    this.stop();
    this._timer = setInterval(() => this.tick(), Math.max(5000, intervalMs));
    this.tick();
  }

  async tick() {
    if (this._running) return;
    this._running = true;
    try {
      await sweepOnce();
      this.lastRunAt = new Date();
    } catch (err) {
      logger.error({ err: errorSummary(err) }, "attempt sweeper failed");
    } finally {
      this._running = false;
    }
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }
}

const attemptSweeper = new AttemptSweeper();

module.exports = { attemptSweeper, sweepOnce };
