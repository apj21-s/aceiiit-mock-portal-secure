const Reminder = require("../models/Reminder");
const Test = require("../models/Test");
const { sendReminderEmail } = require("../utils/mailService");

class ReminderService {
  constructor() {
    this._timer = null;
    this._running = false;
  }

  start() {
    const intervalMs = Math.max(30, Number(process.env.REMINDER_SCAN_INTERVAL_SECONDS || 60)) * 1000;
    this.stop();
    this._timer = setInterval(() => {
      this.flushDueReminders().catch((error) => {
        // eslint-disable-next-line no-console
        console.error("Reminder flush failed:", error);
      });
    }, intervalMs);
    this.flushDueReminders().catch(() => {});
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  async flushDueReminders() {
    if (this._running) return;
    this._running = true;
    try {
      const due = await Reminder.find({
        sentAt: null,
        cancelledAt: null,
        remindAt: { $lte: new Date() },
      })
        .sort({ remindAt: 1 })
        .limit(20)
        .lean();

      for (const reminder of due) {
        await this.sendReminder(reminder);
      }
    } finally {
      this._running = false;
    }
  }

  async sendReminder(reminder) {
    const test = reminder.testId ? await Test.findById(reminder.testId).select("title").lean() : null;
    const title = String(reminder.title || (test && test.title) || "Attempt your mock");
    try {
      await sendReminderEmail({
        to: [reminder.email],
        subject: `Reminder: ${title} is in 5 hours`,
        html: `
          <div style="font-family: Arial, sans-serif; line-height: 1.7;">
            <h2>ACE IIIT Mock Plan Reminder</h2>
            <p>Your planned mock attempt is in <strong>5 hours</strong>.</p>
            <p><strong>${title}</strong></p>
            <p>Planned attempt time: ${new Date(reminder.plannedAt || reminder.remindAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}</p>
            <p>Please keep yourself ready and attempt the mock at your planned time.</p>
          </div>
        `,
      });
      await Reminder.updateOne(
        { _id: reminder._id, sentAt: null },
        { $set: { sentAt: new Date(), failureReason: "" } }
      );
    } catch (error) {
      await Reminder.updateOne(
        { _id: reminder._id },
        { $set: { failureReason: String(error && error.message || "Reminder delivery failed") } }
      );
      throw error;
    }
  }
}

const reminderService = new ReminderService();

module.exports = { reminderService };
