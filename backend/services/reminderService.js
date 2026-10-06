const Reminder = require("../models/Reminder");
const Test = require("../models/Test");
const { sendReminderEmail } = require("../utils/mailService");

function formatReminderLead(reminderMinutes) {
  const safe = Number(reminderMinutes || 300);
  if (safe >= 1440 && safe % 1440 === 0) {
    return `${safe / 1440} day${safe === 1440 ? "" : "s"}`;
  }
  if (safe >= 60 && safe % 60 === 0) {
    return `${safe / 60} hour${safe === 60 ? "" : "s"}`;
  }
  return `${safe} minute${safe === 1 ? "" : "s"}`;
}

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
        if (!error || !error.message || !error.message.includes("Reminder SMTP is not configured")) {
          // eslint-disable-next-line no-console
          console.error("Reminder flush failed:", error.message || error);
        }
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
    const reminderLead = formatReminderLead(reminder.reminderMinutes);
    const subjectFocus = Array.isArray(reminder.subjectFocus) && reminder.subjectFocus.length
      ? reminder.subjectFocus.join(", ")
      : "";
    const planDate = new Date(reminder.plannedAt || reminder.remindAt);
    const endDate = new Date(planDate.getTime() + 3 * 60 * 60 * 1000); // 3 hours duration
    const formatGCalDate = (d) => d.toISOString().replace(/-|:|\.\d\d\d/g, "");
    
    const origin = process.env.CLIENT_ORIGIN || "http://localhost:10000";
    const testLink = reminder.testId ? `${origin}/#instructions/${reminder.testId}` : `${origin}/#dashboard`;
    
    const detailsText = `Subject Focus: ${subjectFocus}\n\nNotes: ${reminder.notes || ""}\n\nLink: ${testLink}`;
    const gCalUrl = `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent(title)}&dates=${formatGCalDate(planDate)}/${formatGCalDate(endDate)}&details=${encodeURIComponent(detailsText)}&location=${encodeURIComponent(testLink)}`;

    try {
      await sendReminderEmail({
        to: [reminder.email],
        subject: `Reminder: ${title} is in ${reminderLead}`,
        html: `
          <div style="font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #e0e0e0; border-radius: 8px; overflow: hidden; color: #333;">
            <div style="background-color: #d7b34a; padding: 24px; text-align: center; color: #fff;">
              <h2 style="margin: 0; font-size: 24px;">ACE IIIT Mock Reminder</h2>
            </div>
            <div style="padding: 32px 24px; background-color: #fff;">
              <p style="font-size: 16px; margin-top: 0;">Your planned mock attempt is starting in <strong>${reminderLead}</strong>.</p>
              <div style="background-color: #f9f9f9; border-left: 4px solid #d7b34a; padding: 16px; margin: 24px 0;">
                <h3 style="margin: 0 0 8px 0; font-size: 18px;">${title}</h3>
                <p style="margin: 0 0 4px 0; font-size: 14px; color: #555;"><strong>Time:</strong> ${planDate.toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}</p>
                ${subjectFocus ? `<p style="margin: 0 0 4px 0; font-size: 14px; color: #555;"><strong>Focus:</strong> ${subjectFocus}</p>` : ""}
                ${reminder.notes ? `<p style="margin: 0; font-size: 14px; color: #555;"><strong>Notes:</strong> ${String(reminder.notes)}</p>` : ""}
              </div>
              <div style="text-align: center; margin: 32px 0;">
                <a href="${testLink}" style="display: inline-block; background-color: #d7b34a; color: #fff; text-decoration: none; padding: 14px 32px; font-size: 16px; font-weight: bold; border-radius: 4px;">Start Mock Exam Now</a>
              </div>
              <div style="text-align: center;">
                <a href="${gCalUrl}" target="_blank" style="font-size: 14px; color: #d7b34a; text-decoration: none; font-weight: bold;">📅 Add to Google Calendar</a>
              </div>
            </div>
            <div style="background-color: #f0f0f0; padding: 16px; text-align: center; font-size: 12px; color: #888;">
              You are receiving this because you scheduled a plan on ACE IIIT Mock Portal.
            </div>
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
