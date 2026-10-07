// M8: self-service data rights. Export returns the user's own data and no secrets;
// deletion needs confirmation (and the password for password accounts), signs out every
// session immediately, cancels reminders, and is refused for admins.
const AuditLog = require("../../models/AuditLog");
const Reminder = require("../../models/Reminder");
const User = require("../../models/User");
const { createApp } = require("../../app");
const { startDb, clearDb, stopDb } = require("../helpers/db");
const { DEFAULT_PASSWORD, createUser, createQuestions, createTest } = require("../helpers/fixtures");
const { loginClient } = require("../helpers/session");

let app;

beforeAll(async () => {
  await startDb();
  app = createApp();
});

afterEach(async () => {
  await clearDb();
});

afterAll(async () => {
  await stopDb();
});

async function studentWithAttempt() {
  const user = await createUser();
  await createUser({ email: "other@test.local", name: "Other" });
  const test = await createTest({ isFree: true, questions: await createQuestions() });
  const client = await loginClient(app, "student1@test.local");
  const start = await client.post("/api/attempt/start", { testId: String(test._id) });
  await client.agent
    .post("/api/attempt")
    .set("X-CSRF-Token", client.csrf)
    .set("X-Exam-Token", start.body.examToken)
    .set("Idempotency-Key", "account-test-submit-1")
    .send({ sessionId: start.body.session.id });
  await Reminder.create({
    userId: user._id,
    email: user.email,
    title: "Mock practice",
    testId: test._id,
    plannedAt: new Date(Date.now() + 864e5),
    remindAt: new Date(Date.now() + 3600e3),
  });
  return { user, client, test };
}

describe("GET /api/account/export", () => {
  test("returns only the caller's data, as a no-store attachment, with no secrets", async () => {
    const { client } = await studentWithAttempt();
    const res = await client.get("/api/account/export");
    expect(res.status).toBe(200);
    expect(res.headers["content-disposition"]).toMatch(/attachment; filename="aceiiit-my-data-/);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body.profile.email).toBe("student1@test.local");
    expect(res.body.profile.signInMethods.password).toBe(true);
    expect(res.body.attempts).toHaveLength(1);
    expect(res.body.reminders).toHaveLength(1);
    const raw = JSON.stringify(res.body);
    for (const secret of ["passwordHash", "tokenVersion", "examTokenHash", "googleSubject", "appleSubject", "failedLoginCount", "other@test.local"]) {
      expect(raw).not.toContain(secret);
    }
  });

  test("requires a session", async () => {
    const request = require("supertest");
    expect((await request(app).get("/api/account/export")).status).toBe(401);
  });
});

describe("DELETE /api/account", () => {
  test("without the confirmation phrase → 400 and nothing changes", async () => {
    const { client, user } = await studentWithAttempt();
    const res = await client.agent.delete("/api/account").set("X-CSRF-Token", client.csrf).send({ password: DEFAULT_PASSWORD });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("CONFIRMATION_REQUIRED");
    expect((await User.findById(user._id)).deletedAt).toBeFalsy();
  });

  test("password accounts must re-enter the correct password", async () => {
    const { client, user } = await studentWithAttempt();
    const noPw = await client.agent.delete("/api/account").set("X-CSRF-Token", client.csrf).send({ confirm: "DELETE MY ACCOUNT" });
    expect(noPw.status).toBe(401);
    const wrong = await client.agent.delete("/api/account").set("X-CSRF-Token", client.csrf).send({ confirm: "DELETE MY ACCOUNT", password: "nope-wrong-1" });
    expect(wrong.status).toBe(401);
    expect(wrong.body.code).toBe("REAUTH_FAILED");
    expect((await User.findById(user._id)).deletedAt).toBeFalsy();
  });

  test("requires the CSRF header", async () => {
    const { client } = await studentWithAttempt();
    const res = await client.agent.delete("/api/account").send({ confirm: "DELETE MY ACCOUNT", password: DEFAULT_PASSWORD });
    expect(res.status).toBe(403);
  });

  test("success: soft-deletes, revokes every session, cancels reminders, audits", async () => {
    const { client, user } = await studentWithAttempt();
    const second = await loginClient(app, "student1@test.local");
    const res = await client.agent
      .delete("/api/account")
      .set("X-CSRF-Token", client.csrf)
      .send({ confirm: "DELETE MY ACCOUNT", password: DEFAULT_PASSWORD });
    expect(res.status).toBe(200);
    expect(res.headers["set-cookie"].join(";")).toMatch(/aceiiit_session=;/);

    const stored = await User.findById(user._id);
    expect(stored.deletedAt).toBeInstanceOf(Date);
    expect(stored.tokenVersion).toBeGreaterThan(0);
    // The other device's cookie is dead immediately.
    expect((await second.get("/api/auth/me")).status).toBe(401);
    expect((await second.get("/api/account/export")).status).toBe(401);
    const reminder = await Reminder.findOne({ userId: user._id });
    expect(reminder.cancelledAt).toBeInstanceOf(Date);
    expect(await AuditLog.countDocuments({ action: "ACCOUNT_DELETION_REQUESTED", entityId: String(user._id) })).toBe(1);
    // Can't log back in.
    const relogin = await second.post("/api/auth/login", { email: "student1@test.local", password: DEFAULT_PASSWORD });
    expect(relogin.status).not.toBe(200);
  });

  test("admins can't self-delete", async () => {
    await createUser({ email: "admin@test.local", role: "admin", name: "Admin" });
    const client = await loginClient(app, "admin@test.local");
    const res = await client.agent
      .delete("/api/account")
      .set("X-CSRF-Token", client.csrf)
      .send({ confirm: "DELETE MY ACCOUNT", password: DEFAULT_PASSWORD });
    expect(res.status).toBe(400);
    expect((await User.findOne({ email: "admin@test.local" })).deletedAt).toBeFalsy();
  });
});
