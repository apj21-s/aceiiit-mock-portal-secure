// M4: email escaping, RFC 5545 invites, reliable reminder delivery (per-item isolation,
// backoff, max attempts) and invites never marking the scheduled reminder as sent.
jest.mock("resend", () => {
  const send = jest.fn(async () => ({ error: null }));
  return { Resend: jest.fn(() => ({ emails: { send } })), __send: send };
});

const resendModule = require("resend");
const { createApp } = require("../../app");
const Reminder = require("../../models/Reminder");
const { buildReminderIcs, sendReminderEmail } = require("../../utils/mailService");
const { escapeHtml, escapeIcsText } = require("../../utils/escape");
const { flushDueReminders, BACKOFF_MS, MAX_ATTEMPTS } = require("../../services/reminderService");
const { startDb, clearDb, stopDb } = require("../helpers/db");
const { createUser, createQuestions, createTest } = require("../helpers/fixtures");
const { loginClient } = require("../helpers/session");

let app;
const send = resendModule.__send;

beforeAll(async () => {
  await startDb();
  app = createApp();
});

beforeEach(() => {
  process.env.RESEND_API_KEY = "re_test";
  send.mockReset();
  send.mockImplementation(async () => ({ error: null }));
});

afterEach(async () => {
  delete process.env.RESEND_API_KEY;
  await clearDb();
});

afterAll(async () => {
  await stopDb();
});

async function makeReminder(overrides = {}) {
  const user = overrides.user || (await createUser({ email: `r${Math.random().toString(36).slice(2, 8)}@test.local` }));
  return Reminder.create({
    userId: user._id,
    email: user.email,
    title: "Mock <b>1</b>",
    plannedAt: new Date(Date.now() + 60 * 60 * 1000),
    remindAt: new Date(Date.now() - 1000),
    notes: '<script>alert("x")</script>',
    ...overrides,
    user: undefined,
  });
}

describe("escaping", () => {
  test("HTML and ICS escaping helpers", () => {
    expect(escapeHtml(`<img src=x onerror="1">'&`)).toBe("&lt;img src=x onerror=&quot;1&quot;&gt;&#39;&amp;");
    expect(escapeIcsText("a;b,c\\d\ne")).toBe("a\\;b\\,c\\\\d\\ne");
  });

  test("reminder email escapes user-controlled title and notes", async () => {
    await sendReminderEmail({ to: "x@test.local", title: "<b>T</b>", leadText: "1 hour", whenText: "now", subjectFocus: "", notes: "<script>x</script>", testLink: "https://mock.aceiiit.in/#dashboard" });
    const html = send.mock.calls[0][0].html;
    expect(html).not.toMatch(/<script>|<b>T<\/b>/);
    expect(html).toMatch(/&lt;script&gt;x&lt;\/script&gt;/);
  });

  test("javascript: links are neutralised", async () => {
    await sendReminderEmail({ to: "x@test.local", title: "T", leadText: "1 hour", whenText: "now", testLink: "javascript:alert(1)" });
    expect(send.mock.calls[0][0].html).not.toMatch(/javascript:/);
  });
});

describe("ICS invites", () => {
  test("stable UID, UTC times, escaped text, sequence and cancel", () => {
    const reminder = { _id: "abc123", title: "Mock; Test, 1", plannedAt: new Date("2026-11-01T10:00:00Z"), email: "s@test.local", sequence: 3, notes: "line1\nline2" };
    const ics = buildReminderIcs(reminder, "https://mock.aceiiit.in/#dashboard");
    expect(ics).toMatch(/UID:abc123@aceiiit\.in/);
    expect(ics).toMatch(/SEQUENCE:3/);
    expect(ics).toMatch(/DTSTART:20261101T100000Z/);
    expect(ics).toMatch(/SUMMARY:Mock\\; Test\\, 1/);
    expect(ics).toMatch(/METHOD:REQUEST/);
    expect(ics.split("\r\n").every((line) => Buffer.byteLength(line) <= 75)).toBe(true);
    const cancel = buildReminderIcs({ ...reminder, sequence: 4 }, "https://x", "CANCEL", "CANCELLED");
    expect(cancel).toMatch(/METHOD:CANCEL/);
    expect(cancel).toMatch(/STATUS:CANCELLED/);
    expect(cancel).toMatch(/SEQUENCE:4/);
  });

  test("CRLF in an attendee can't inject extra ICS properties", () => {
    const ics = buildReminderIcs({ _id: "x", title: "T", plannedAt: new Date(), email: "a@b.c\r\nATTACH:evil", sequence: 0 }, "https://x");
    expect(ics.split("\r\n").some((line) => line.startsWith("ATTACH:"))).toBe(false);
  });

  test("update and delete increase SEQUENCE; invite results never mark the reminder sent", async () => {
    await createUser();
    const questions = await createQuestions();
    const test = await createTest({ isFree: true, questions });
    const client = await loginClient(app, "student1@test.local");
    const remindAt = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();
    const created = await client.post("/api/reminders", { title: "Plan", remindAt, testId: String(test._id), reminderMinutes: 60 });
    expect(created.status).toBe(201);
    const id = created.body.reminder.id;
    await new Promise((r) => setTimeout(r, 200));
    let doc = await Reminder.findById(id);
    expect(doc.inviteSentAt).toBeTruthy();
    expect(doc.sentAt).toBeNull();
    expect(doc.deliveryState).toBe("pending");

    await client.put(`/api/reminders/${id}`, { title: "Plan 2", remindAt, testId: String(test._id), reminderMinutes: 60 });
    await new Promise((r) => setTimeout(r, 200));
    doc = await Reminder.findById(id);
    expect(doc.sequence).toBe(1);
    expect(doc.sentAt).toBeNull();

    await client.del(`/api/reminders/${id}`);
    await new Promise((r) => setTimeout(r, 200));
    doc = await Reminder.findById(id);
    expect(doc.sequence).toBe(2);
    expect(doc.deliveryState).toBe("cancelled");
    const cancelCall = send.mock.calls.find((c) => /^Cancelled:/.test(c[0].subject));
    expect(Buffer.from(cancelCall[0].attachments[0].content, "base64").toString()).toMatch(/METHOD:CANCEL/);
  });
});

describe("reminder delivery", () => {
  test("one failing reminder doesn't block the others", async () => {
    const bad = await makeReminder({ email: "fail@test.local" });
    const good = await makeReminder();
    send.mockImplementation(async (payload) => (payload.to.includes("fail@test.local") ? { error: { message: "rejected" } } : { error: null }));
    const outcomes = await flushDueReminders();
    expect(outcomes.sort()).toEqual(["retry", "sent"]);
    expect((await Reminder.findById(good._id)).deliveryState).toBe("sent");
    const failed = await Reminder.findById(bad._id);
    expect(failed.deliveryState).toBe("pending");
    expect(failed.attempts).toBe(1);
    expect(failed.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + BACKOFF_MS[0] - 5000);
  });

  test("backoff schedule then permanent failure after the max attempts", async () => {
    const r = await makeReminder({ email: "fail@test.local" });
    send.mockImplementation(async () => ({ error: { message: "down" } }));
    // Also make the SMTP/Brevo fallbacks unavailable (not configured in tests).
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      await Reminder.updateOne({ _id: r._id }, { $set: { nextAttemptAt: null } });
      await flushDueReminders();
      const doc = await Reminder.findById(r._id);
      expect(doc.attempts).toBe(attempt);
      if (attempt < MAX_ATTEMPTS) {
        expect(doc.deliveryState).toBe("pending");
        const expected = BACKOFF_MS[Math.min(attempt - 1, BACKOFF_MS.length - 1)];
        expect(doc.nextAttemptAt.getTime() - Date.now()).toBeGreaterThan(expected - 5000);
      } else {
        expect(doc.deliveryState).toBe("failed");
        expect(doc.failedAt).toBeTruthy();
      }
    }
    expect(await flushDueReminders()).toEqual([]);
  });

  test("not-yet-due, cancelled and already-sent reminders are skipped; legacy rows still send", async () => {
    await makeReminder({ remindAt: new Date(Date.now() + 60 * 60 * 1000) });
    await makeReminder({ cancelledAt: new Date(), deliveryState: "cancelled" });
    await makeReminder({ deliveryState: "sent", sentAt: new Date() });
    const legacy = await makeReminder();
    await Reminder.collection.updateOne({ _id: legacy._id }, { $unset: { deliveryState: "", attempts: "", nextAttemptAt: "" } });
    const outcomes = await flushDueReminders();
    expect(outcomes).toEqual(["sent"]);
    expect((await Reminder.findById(legacy._id)).deliveryState).toBe("sent");
  });

  test("a reminder whose plan time already passed is not sent", async () => {
    const r = await makeReminder({ plannedAt: new Date(Date.now() - 1000), remindAt: new Date(Date.now() - 60 * 60 * 1000) });
    expect(await flushDueReminders()).toEqual(["expired"]);
    expect((await Reminder.findById(r._id)).deliveryState).toBe("failed");
    expect(send).not.toHaveBeenCalled();
  });
});
