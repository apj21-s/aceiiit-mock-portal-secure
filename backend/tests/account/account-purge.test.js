// Deleted accounts are purged automatically once the 30-day grace period (stated in the privacy
// policy) has passed: personal data removed, exam history anonymized, Google Calendar data
// dropped. Accounts inside the grace period, and active accounts, are left alone.
const Attempt = require("../../models/Attempt");
const AuditLog = require("../../models/AuditLog");
const GoogleCalendarConnection = require("../../models/GoogleCalendarConnection");
const GoogleCalendarEvent = require("../../models/GoogleCalendarEvent");
const Reminder = require("../../models/Reminder");
const User = require("../../models/User");
const { purgeExpiredAccounts, RETENTION_DAYS } = require("../../services/accountPurgeService");
const { encryptSecret } = require("../../utils/crypto");
const { startDb, clearDb, stopDb } = require("../helpers/db");
const { createUser, createQuestions, createTest } = require("../helpers/fixtures");

const DAY = 24 * 60 * 60 * 1000;

beforeAll(async () => {
  await startDb();
});

afterEach(async () => {
  await clearDb();
});

afterAll(async () => {
  await stopDb();
});

async function studentWithHistory(email, deletedDaysAgo) {
  const user = await createUser({ email, name: email.split("@")[0] });
  const test = await createTest({ isFree: true, questions: await createQuestions() });
  await Attempt.create({ userId: user._id, testId: test._id, attemptNumber: 1, userEmail: user.email, score: 4 });
  const reminder = await Reminder.create({ userId: user._id, email: user.email, title: "Mock", testId: test._id, remindAt: new Date(), plannedAt: new Date() });
  await GoogleCalendarConnection.create({ userId: user._id, googleAccountId: "sub-" + email, refreshToken: "" });
  await GoogleCalendarEvent.create({ reminderId: reminder._id, userId: user._id, googleEventId: "evt-" + email });
  if (deletedDaysAgo !== null) {
    await User.updateOne({ _id: user._id }, { $set: { deletedAt: new Date(Date.now() - deletedDaysAgo * DAY) } });
  }
  return user;
}

test("the grace period is 30 days", () => {
  expect(RETENTION_DAYS).toBe(30);
});

test("accounts deleted more than 30 days ago are purged, anonymized and audited", async () => {
  const expired = await studentWithHistory("expired@test.local", 31);
  const purged = await purgeExpiredAccounts();
  expect(purged).toEqual([String(expired._id)]);

  expect(await User.countDocuments({ _id: expired._id })).toBe(0);
  const attempt = await Attempt.findOne({ userId: expired._id });
  expect(attempt.userEmail).toBe("");
  expect(attempt.score).toBe(4);
  expect(await Reminder.countDocuments({ userId: expired._id })).toBe(0);
  expect(await GoogleCalendarConnection.countDocuments({ userId: expired._id })).toBe(0);
  expect(await GoogleCalendarEvent.countDocuments({ userId: expired._id })).toBe(0);
  const audit = await AuditLog.findOne({ action: "USER_PURGED", entityId: String(expired._id) }).lean();
  expect(audit).toBeTruthy();
  expect(audit.actorUserId == null).toBe(true);
  expect(audit.metadata).toMatchObject({ automatic: true, retentionDays: 30 });
});

test("accounts inside the grace period and active accounts are untouched", async () => {
  const recent = await studentWithHistory("recent@test.local", 5);
  const active = await studentWithHistory("active@test.local", null);
  expect(await purgeExpiredAccounts()).toEqual([]);
  for (const user of [recent, active]) {
    expect(await User.countDocuments({ _id: user._id })).toBe(1);
    expect((await Attempt.findOne({ userId: user._id })).userEmail).toBe(user.email);
    expect(await GoogleCalendarConnection.countDocuments({ userId: user._id })).toBe(1);
  }
});

test("a calendar token that no longer decrypts does not block the purge", async () => {
  const expired = await studentWithHistory("rotated@test.local", 31);
  await GoogleCalendarConnection.updateOne({ userId: expired._id }, { $set: { refreshToken: encryptSecret("old-refresh-token", "a-retired-calendar-token-key-0000") } });
  expect(await purgeExpiredAccounts()).toEqual([String(expired._id)]);
  expect(await User.countDocuments({ _id: expired._id })).toBe(0);
  expect(await GoogleCalendarConnection.countDocuments({ userId: expired._id })).toBe(0);
});
