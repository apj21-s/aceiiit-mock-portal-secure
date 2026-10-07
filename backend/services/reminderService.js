const Reminder = require("../models/Reminder");
const Test = require("../models/Test");
const { sendReminderEmail } = require("../utils/mailService");
const { logger, errorSummary } = require("../utils/logger");

// Scheduled reminder delivery. Each due reminder is claimed atomically (safe with several
// server instances), handled in its own try/catch (one failure never blocks the others),
// and retried with backoff: 1m → 5m → 30m → 2h, then marked failed.

const BACKOFF_MS = [60 * 1000, 5 * 60 * 1000, 30 * 60 * 1000, 2 * 60 * 60 * 1000];
const MAX_ATTEMPTS = 5;
const STUCK_SENDING_MS = 5 * 60 * 1000;
const BATCH_SIZE = 20;

function formatReminderLead(reminderMinutes) {
  const safe = Number(reminderMinutes || 300);
  if (safe >= 1440 && safe % 1440 === 0) return `${safe / 1440} day${safe === 1440 ? "" : "s"}`;
  if (safe >= 60 && safe % 60 === 0) return `${safe / 60} hour${safe === 60 ? "" : "s"}`;
  return `${safe} minute${safe === 1 ? "" : "s"}`;
}

function portalBaseUrl() {
  return String(process.env.PORTAL_BASE_URL || "http://localhost:4000").replace(/\/+$/, "");
}

function testLinkFor(reminder) {
  return reminder.testId ? `${portalBaseUrl()}/#instructions/${reminder.testId}` : `${portalBaseUrl()}/#dashboard`;
}

function dueFilter(now) {
  return {
    cancelledAt: null,
    remindAt: { $lte: now },
    $and: [
      // Legacy reminders (before deliveryState existed) count as pending until sent.
      { $or: [{ deliveryState: "pending" }, { deliveryState: { $exists: false }, sentAt: null }] },
      { $or: [{ nextAttemptAt: null }, { nextAttemptAt: { $exists: false } }, { nextAttemptAt: { $lte: now } }] },
    ],
  };
}

async function claimNext(now) {
  return Reminder.findOneAndUpdate(
    dueFilter(now),
    { $set: { deliveryState: "sending", claimedAt: now }, $inc: { attempts: 1 } },
    { sort: { remindAt: 1 }, new: true }
  );
}

async function deliver(reminder) {
  const test = reminder.testId ? await Test.findById(reminder.testId).select("title").lean() : null;
  const title = String(reminder.title || (test && test.title) || "Attempt your mock");
  const planDate = new Date(reminder.plannedAt || reminder.remindAt);
  const endDate = new Date(planDate.getTime() + 3 * 60 * 60 * 1000);
  const subjectFocus = Array.isArray(reminder.subjectFocus) && reminder.subjectFocus.length ? reminder.subjectFocus.join(", ") : "";
  const testLink = testLinkFor(reminder);
  const gDate = (d) => d.toISOString().replace(/-|:|\.\d\d\d/g, "");
  const details = `Subject Focus: ${subjectFocus}\n\nNotes: ${reminder.notes || ""}\n\nLink: ${testLink}`;
  const gCalUrl = `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent(title)}&dates=${gDate(planDate)}/${gDate(endDate)}&details=${encodeURIComponent(details)}&location=${encodeURIComponent(testLink)}`;

  await sendReminderEmail({
    to: reminder.email,
    title,
    leadText: formatReminderLead(reminder.reminderMinutes),
    whenText: planDate.toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }),
    subjectFocus,
    notes: reminder.notes || "",
    testLink,
    gCalUrl,
  });
}

/** Processes one claimed reminder; never throws. */
async function processClaimed(reminder, now) {
  if (reminder.plannedAt && new Date(reminder.plannedAt).getTime() < now.getTime()) {
    // The plan already started (e.g. after downtime); a "starts in X" email would be wrong.
    await Reminder.updateOne(
      { _id: reminder._id, deliveryState: "sending" },
      { $set: { deliveryState: "failed", failedAt: now, failureReason: "Plan time passed before the reminder could be sent." } }
    );
    return "expired";
  }
  try {
    await deliver(reminder);
    await Reminder.updateOne(
      { _id: reminder._id, deliveryState: "sending" },
      { $set: { deliveryState: "sent", sentAt: new Date(), failureReason: "", nextAttemptAt: null } }
    );
    return "sent";
  } catch (error) {
    const reason = String((error && error.message) || "Reminder delivery failed").slice(0, 300);
    const attempts = Number(reminder.attempts || 1);
    const update = attempts >= MAX_ATTEMPTS
      ? { deliveryState: "failed", failedAt: new Date(), failureReason: reason, nextAttemptAt: null }
      : { deliveryState: "pending", failureReason: reason, nextAttemptAt: new Date(Date.now() + BACKOFF_MS[Math.min(attempts - 1, BACKOFF_MS.length - 1)]) };
    await Reminder.updateOne({ _id: reminder._id, deliveryState: "sending" }, { $set: update });
    return update.deliveryState === "failed" ? "failed" : "retry";
  }
}

async function releaseStuck(now) {
  await Reminder.updateMany(
    { deliveryState: "sending", claimedAt: { $lt: new Date(now.getTime() - STUCK_SENDING_MS) } },
    { $set: { deliveryState: "pending" } }
  );
}

async function flushDueReminders(now = new Date()) {
  await releaseStuck(now);
  const outcomes = [];
  for (let i = 0; i < BATCH_SIZE; i += 1) {
    const reminder = await claimNext(now);
    if (!reminder) break;
    outcomes.push(await processClaimed(reminder, now));
  }
  return outcomes;
}

class ReminderService {
  constructor() {
    this._timer = null;
    this._running = false;
    this.lastRunAt = null;
  }

  start() {
    const intervalMs = Math.max(30, Number(process.env.REMINDER_SCAN_INTERVAL_SECONDS || 60)) * 1000;
    this.stop();
    this._timer = setInterval(() => this.tick(), intervalMs);
    this.tick();
  }

  async tick() {
    if (this._running) return;
    this._running = true;
    try {
      await flushDueReminders();
      this.lastRunAt = new Date();
    } catch (error) {
      logger.error({ err: errorSummary(error) }, "reminder flush failed");
    } finally {
      this._running = false;
    }
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }
}

const reminderService = new ReminderService();

module.exports = { reminderService, flushDueReminders, formatReminderLead, BACKOFF_MS, MAX_ATTEMPTS, testLinkFor };
