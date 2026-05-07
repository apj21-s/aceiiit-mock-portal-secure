const { z } = require("zod");

const Reminder = require("../models/Reminder");
const Test = require("../models/Test");
const REMINDER_LEAD_HOURS = 5;

const reminderSchema = z.object({
  title: z.string().trim().min(2).max(140),
  remindAt: z.string().datetime(),
  testId: z.string().trim().min(1),
});

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
      reminders: reminders.map((item) => ({
        id: String(item._id),
        title: item.title,
        testId: item.testId ? String(item.testId) : "",
        plannedAt: item.plannedAt,
        remindAt: item.remindAt,
        sentAt: item.sentAt,
        failureReason: item.failureReason || "",
      })),
    });
  } catch (err) {
    next(err);
  }
}

async function createReminder(req, res, next) {
  try {
    const input = reminderSchema.parse(req.body || {});
    const plannedAt = new Date(input.remindAt);
    const remindAt = new Date(plannedAt.getTime() - (REMINDER_LEAD_HOURS * 60 * 60 * 1000));
    if (!Number.isFinite(plannedAt.getTime()) || plannedAt.getTime() <= Date.now()) {
      return res.status(400).json({ error: "Plan time must be in the future." });
    }
    if (remindAt.getTime() <= Date.now()) {
      return res.status(400).json({ error: "Please plan at least 5 hours ahead so the reminder can be sent on time." });
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
    });

    res.status(201).json({
      reminder: {
        id: String(reminder._id),
        title: reminder.title,
        testId: reminder.testId ? String(reminder.testId) : "",
        plannedAt: reminder.plannedAt,
        remindAt: reminder.remindAt,
        sentAt: reminder.sentAt,
        failureReason: reminder.failureReason || "",
      },
    });
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
    const remindAt = new Date(plannedAt.getTime() - (REMINDER_LEAD_HOURS * 60 * 60 * 1000));
    if (!Number.isFinite(plannedAt.getTime()) || plannedAt.getTime() <= Date.now()) {
      return res.status(400).json({ error: "Plan time must be in the future." });
    }
    if (remindAt.getTime() <= Date.now()) {
      return res.status(400).json({ error: "Please plan at least 5 hours ahead so the reminder can be sent on time." });
    }
    const test = await Test.findOne({ _id: input.testId, deletedAt: null, status: "live" }).select("_id title");
    if (!test) {
      return res.status(404).json({ error: "Please choose one of the live mocks." });
    }
    reminder.title = input.title || test.title;
    reminder.testId = test._id;
    reminder.plannedAt = plannedAt;
    reminder.remindAt = remindAt;
    reminder.sentAt = null;
    reminder.failureReason = "";
    await reminder.save();
    res.json({
      reminder: {
        id: String(reminder._id),
        title: reminder.title,
        testId: reminder.testId ? String(reminder.testId) : "",
        plannedAt: reminder.plannedAt,
        remindAt: reminder.remindAt,
        sentAt: reminder.sentAt,
        failureReason: reminder.failureReason || "",
      },
    });
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
    await reminder.save();
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

module.exports = { listReminders, createReminder, updateReminder, deleteReminder };
