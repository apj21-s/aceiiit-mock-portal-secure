const { z } = require("zod");

const { sendCalendarInviteEmail } = require("../utils/mailService");
const { syncReminderToCalendar } = require("../services/googleCalendarService");
const Reminder = require("../models/Reminder");
const Test = require("../models/Test");
const { testLinkFor } = require("../services/reminderService");
const { logger, errorSummary } = require("../utils/logger");
const DEFAULT_REMINDER_MINUTES = 5 * 60;
const ALLOWED_REMINDER_MINUTES = [10, 30, 60, 24 * 60];
const ALLOWED_SUBJECTS = ["Physics", "Maths", "Logical"];

const reminderSchema = z.object({
  title: z.string().trim().min(2).max(140),
  remindAt: z.string().datetime(),
  testId: z.string().trim().min(1),
  reminderMinutes: z.coerce.number().int().optional(),
  subjectFocus: z.array(z.string().trim()).max(3).optional(),
  notes: z.string().trim().max(500).optional(),
});

function resetDelivery(reminder) {
  reminder.deliveryState = "pending";
  reminder.attempts = 0;
  reminder.nextAttemptAt = null;
  reminder.sentAt = null;
  reminder.failedAt = null;
  reminder.failureReason = "";
}

async function recordInviteResult(reminderId, result) {
  const ok = Boolean(result && result.success);
  await Reminder.updateOne(
    { _id: reminderId },
    { $set: ok ? { inviteSentAt: new Date(), inviteError: "" } : { inviteError: String((result && result.error) || "Invite email failed").slice(0, 300) } }
  );
}

function normalizeReminderMinutes(value) {
  return ALLOWED_REMINDER_MINUTES.includes(Number(value))
    ? Number(value)
    : DEFAULT_REMINDER_MINUTES;
}

function normalizeSubjectFocus(subjectFocus) {
  const items = Array.isArray(subjectFocus) ? subjectFocus : [];
  return items
    .map((item) => String(item || "").trim())
    .filter((item, index, arr) => item && ALLOWED_SUBJECTS.includes(item) && arr.indexOf(item) === index)
    .slice(0, 3);
}

function toReminderResponse(item) {
  return {
    id: String(item._id),
    title: item.title,
    testId: item.testId ? String(item.testId) : "",
    plannedAt: item.plannedAt,
    remindAt: item.remindAt,
    reminderMinutes: Number(item.reminderMinutes || DEFAULT_REMINDER_MINUTES),
    subjectFocus: Array.isArray(item.subjectFocus) ? item.subjectFocus : [],
    notes: item.notes || "",
    sentAt: item.sentAt,
    deliveryState: item.deliveryState || (item.sentAt ? "sent" : "pending"),
    failureReason: item.failureReason || "",
    inviteSentAt: item.inviteSentAt || null,
  };
}

async function listReminders(req, res, next) {
  try {
    const reminders = await Reminder.find({
      userId: req.auth.userId,
      cancelledAt: null,
    })
      .sort({ remindAt: 1 })
      .limit(100)
      .lean();

    res.json({
      reminders: reminders.map(toReminderResponse),
    });
  } catch (err) {
    next(err);
  }
}

async function createReminder(req, res, next) {
  try {
    const input = reminderSchema.parse(req.body || {});
    const plannedAt = new Date(input.remindAt);
    const reminderMinutes = normalizeReminderMinutes(input.reminderMinutes);
    const remindAt = new Date(plannedAt.getTime() - (reminderMinutes * 60 * 1000));
    const subjectFocus = normalizeSubjectFocus(input.subjectFocus);
    const notes = String(input.notes || "").trim();
    if (!Number.isFinite(plannedAt.getTime()) || plannedAt.getTime() <= Date.now()) {
      return res.status(400).json({ error: "Plan time must be in the future." });
    }
    if (remindAt.getTime() <= Date.now()) {
      return res.status(400).json({ error: "Please choose a future reminder window so the notification can still be sent on time." });
    }

    const test = await Test.findOne({ _id: input.testId, deletedAt: null, status: "live" }).select("_id title");
    if (!test) {
      return res.status(404).json({ error: "Please choose one of the live mocks." });
    }

    const reminder = await Reminder.create({
      userId: req.auth.userId,
      email: String(req.auth.email || "").trim().toLowerCase(),
      title: input.title || test.title,
      plannedAt,
      remindAt,
      testId: test._id,
      reminderMinutes,
      subjectFocus,
      notes,
    });

    res.status(201).json({
      reminder: toReminderResponse(reminder),
    });

    // Automatically send the calendar invite asynchronously
    const testLink = testLinkFor(reminder);
    sendCalendarInviteEmail(reminder, testLink)
      .then((result) => recordInviteResult(reminder._id, result))
      .catch((err) => {
        logger.error({ err: errorSummary(err) }, "email calendar invite dispatch failed");
      });
    syncReminderToCalendar(reminder, "CREATE").catch(() => {});
  } catch (err) {
    next(err);
  }
}

async function updateReminder(req, res, next) {
  try {
    const input = reminderSchema.parse(req.body || {});
    const reminder = await Reminder.findOne({
      _id: req.params.id,
      userId: req.auth.userId,
      cancelledAt: null,
    });
    if (!reminder) {
      return res.status(404).json({ error: "Reminder not found." });
    }
    const plannedAt = new Date(input.remindAt);
    const reminderMinutes = normalizeReminderMinutes(input.reminderMinutes);
    const remindAt = new Date(plannedAt.getTime() - (reminderMinutes * 60 * 1000));
    const subjectFocus = normalizeSubjectFocus(input.subjectFocus);
    const notes = String(input.notes || "").trim();
    if (!Number.isFinite(plannedAt.getTime()) || plannedAt.getTime() <= Date.now()) {
      return res.status(400).json({ error: "Plan time must be in the future." });
    }
    if (remindAt.getTime() <= Date.now()) {
      return res.status(400).json({ error: "Please choose a future reminder window so the notification can still be sent on time." });
    }
    const test = await Test.findOne({ _id: input.testId, deletedAt: null, status: "live" }).select("_id title");
    if (!test) {
      return res.status(404).json({ error: "Please choose one of the live mocks." });
    }
    reminder.title = input.title || test.title;
    reminder.testId = test._id;
    reminder.plannedAt = plannedAt;
    reminder.remindAt = remindAt;
    reminder.reminderMinutes = reminderMinutes;
    reminder.subjectFocus = subjectFocus;
    reminder.notes = notes;
    resetDelivery(reminder);
    reminder.sequence = (reminder.sequence || 0) + 1;
    await reminder.save();
    res.json({
      reminder: toReminderResponse(reminder),
    });

    const testLink = testLinkFor(reminder);
    sendCalendarInviteEmail(reminder, testLink, "REQUEST", "CONFIRMED").then(async (result) => {
      await recordInviteResult(reminder._id, result);
    }).catch((err) => {
      logger.error({ err: errorSummary(err) }, "email calendar invite dispatch failed");
    });
    syncReminderToCalendar(reminder, "UPDATE").catch(() => {});
  } catch (err) {
    next(err);
  }
}

async function deleteReminder(req, res, next) {
  try {
    const reminder = await Reminder.findOne({
      _id: req.params.id,
      userId: req.auth.userId,
      cancelledAt: null,
    });
    if (!reminder) {
      return res.status(404).json({ error: "Reminder not found." });
    }
    reminder.cancelledAt = new Date();
    reminder.deliveryState = "cancelled";
    reminder.sequence = (reminder.sequence || 0) + 1;
    await reminder.save();
    res.json({ success: true });

    const testLink = testLinkFor(reminder);
    sendCalendarInviteEmail(reminder, testLink, "CANCEL", "CANCELLED").then(async (result) => {
      await recordInviteResult(reminder._id, result);
    }).catch((err) => {
      logger.error({ err: errorSummary(err) }, "email calendar invite dispatch failed");
    });
    syncReminderToCalendar(reminder, "DELETE").catch(() => {});
  } catch (err) {
    next(err);
  }
}

async function resendReminder(req, res, next) {
  try {
    const reminder = await Reminder.findOne({
      _id: req.params.id,
      userId: req.auth.userId,
      cancelledAt: null,
    });
    if (!reminder) {
      return res.status(404).json({ error: "Reminder not found." });
    }
    
    // Resend only re-sends the calendar invite; it doesn't change the event (same SEQUENCE)
    // and doesn't touch the scheduled reminder's delivery state.
    reminder.inviteError = "";
    await reminder.save();
    
    res.json({ success: true, reminder: toReminderResponse(reminder) });

    const testLink = testLinkFor(reminder);
    sendCalendarInviteEmail(reminder, testLink, "REQUEST", "CONFIRMED").then(async (result) => {
      await recordInviteResult(reminder._id, result);
    }).catch((err) => {
      logger.error({ err: errorSummary(err) }, "email calendar invite dispatch failed");
    });
    syncReminderToCalendar(reminder, "UPDATE").catch(() => {});
  } catch (err) {
    next(err);
  }
}

module.exports = {
  listReminders,
  createReminder,
  updateReminder,
  deleteReminder,
  resendReminder,
};
