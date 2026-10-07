// M5/M6: cross-user IDOR matrix, admin-only surfaces, input validation (ids, filters,
// operator/regex injection) and audit coverage with secret redaction.
const request = require("supertest");

const { createApp } = require("../../app");
const AuditLog = require("../../models/AuditLog");
const Reminder = require("../../models/Reminder");
const { logAuditEvent } = require("../../services/auditLogService");
const { startDb, clearDb, stopDb } = require("../helpers/db");
const { createUser, createQuestions, createTest } = require("../helpers/fixtures");
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

async function twoStudentsWithData() {
  await createUser({ email: "a@test.local", name: "A" });
  await createUser({ email: "b@test.local", name: "B" });
  const questions = await createQuestions();
  const test = await createTest({ isFree: true, questions });
  const a = await loginClient(app, "a@test.local");
  const b = await loginClient(app, "b@test.local");

  // A: one finished attempt and one active session, plus a reminder.
  const s1 = await a.agent.post("/api/attempt/start").set("X-CSRF-Token", a.csrf).send({ testId: String(test._id) });
  const submit = await a.agent
    .post("/api/attempt")
    .set("X-CSRF-Token", a.csrf)
    .set("X-Exam-Token", s1.body.examToken)
    .set("Idempotency-Key", "idor-submit-0001")
    .send({ sessionId: s1.body.session.id });
  const s2 = await a.agent.post("/api/attempt/start").set("X-CSRF-Token", a.csrf).send({ testId: String(test._id) });
  const reminder = await Reminder.create({
    userId: a.user.id,
    email: "a@test.local",
    title: "A's plan",
    testId: test._id,
    plannedAt: new Date(Date.now() + 864e5),
    remindAt: new Date(Date.now() + 3600e3),
  });
  return { a, b, test, attemptId: submit.body.attempt.id, sessionId: s2.body.session.id, examToken: s2.body.examToken, reminderId: String(reminder._id) };
}

describe("IDOR: another student's resources are invisible", () => {
  test("results, analysis, exam sessions and reminders all deny cross-user access", async () => {
    const { b, attemptId, sessionId, examToken, reminderId, test } = await twoStudentsWithData();
    const withToken = (req) => req.set("X-CSRF-Token", b.csrf).set("X-Exam-Token", examToken);
    const attempts = [
      ["GET result", await b.get(`/api/result/${attemptId}`)],
      ["GET analysis", await b.get(`/api/analysis/${attemptId}`)],
      ["GET analysis questions", await b.get(`/api/analysis/${attemptId}/questions`)],
      ["GET paper", await b.agent.get(`/api/attempt/session/${sessionId}/paper`).set("X-Exam-Token", examToken)],
      ["PUT answers", await withToken(b.agent.put(`/api/attempt/session/${sessionId}/answers`)).send({ seq: 1, marked: [] })],
      ["POST advance", await withToken(b.agent.post(`/api/attempt/session/${sessionId}/advance`)).send({})],
      ["POST events", await withToken(b.agent.post(`/api/attempt/session/${sessionId}/events`)).send({ events: [{ type: "tab_hidden" }] })],
      ["POST abandon", await withToken(b.agent.post(`/api/attempt/session/${sessionId}/abandon`)).send({})],
      ["POST takeover", await b.post(`/api/attempt/session/${sessionId}/takeover`)],
      ["POST submit", await withToken(b.agent.post("/api/attempt")).set("Idempotency-Key", "idor-submit-b-01").send({ sessionId })],
      ["PUT reminder", await b.put(`/api/reminders/${reminderId}`, { title: "Hijack", remindAt: new Date(Date.now() + 864e5).toISOString(), testId: String(test._id) })],
      ["DELETE reminder", await b.del(`/api/reminders/${reminderId}`)],
      ["POST resend reminder", await b.post(`/api/reminders/${reminderId}/resend`)],
    ];
    attempts.forEach(([label, res]) => {
      expect({ label, status: res.status }).toEqual({ label, status: 404 });
    });
    // B's own lists don't include A's data.
    expect((await b.get("/api/attempts")).body.attempts).toHaveLength(0);
    expect((await b.get("/api/reminders")).body.reminders).toHaveLength(0);
    expect((await b.get("/api/attempt/sessions/active")).body.sessions).toHaveLength(0);
    // A's reminder is untouched.
    expect((await Reminder.findById(reminderId)).cancelledAt).toBeNull();
  });

  test("admin surfaces (users, payments, entitlements, attempts, seasons, audit) are forbidden to students", async () => {
    const { b, attemptId } = await twoStudentsWithData();
    const gets = ["/api/admin/snapshot", "/api/admin/users-list", "/api/admin/payments", "/api/admin/seasons", "/api/admin/audit-logs", "/api/admin/results", `/api/admin/attempts/${attemptId}/integrity`];
    for (const url of gets) {
      expect({ url, status: (await b.get(url)).status }).toEqual({ url, status: 403 });
    }
    const posts = [`/api/admin/attempts/${attemptId}/invalidate`, "/api/admin/payments", "/api/admin/seasons", "/api/admin/questions"];
    for (const url of posts) {
      expect({ url, status: (await b.post(url, {})).status }).toEqual({ url, status: 403 });
    }
  });
});

describe("input validation", () => {
  async function admin() {
    await createUser({ email: "admin@test.local", role: "admin", name: "Admin" });
    return loginClient(app, "admin@test.local");
  }

  test("malformed ids → 400 everywhere", async () => {
    await createUser();
    const client = await loginClient(app, "student1@test.local");
    for (const url of ["/api/result/not-an-id", "/api/analysis/123", "/api/tests/xyz", "/api/attempt/session/bad/paper"]) {
      expect({ url, status: (await client.get(url)).status }).toEqual({ url, status: 400 });
    }
    expect((await client.del("/api/reminders/%24ne")).status).toBe(400);
  });

  test("admin filters reject operator injection and escape regex input", async () => {
    const client = await admin();
    await createUser({ email: "student1@test.local" });
    expect((await client.get("/api/admin/users-list?role[$ne]=admin")).status).toBe(400);
    expect((await client.get("/api/admin/users-list?role=superuser")).status).toBe(400);
    expect((await client.get("/api/admin/users-list?limit=100000")).status).toBe(400);
    const regex = await client.get(`/api/admin/users-list?search=${encodeURIComponent("(a+)+$.*")}`);
    expect(regex.status).toBe(200);
    expect(regex.body.users).toHaveLength(0);
    const plain = await client.get("/api/admin/users-list?search=student1");
    expect(plain.body.users).toHaveLength(1);
    expect((await client.get("/api/admin/payments?status[$gt]=")).status).toBe(400);
    expect((await client.get("/api/admin/leaderboard")).status).toBe(400);
    expect((await client.del("/api/admin/trash/everything/000000000000000000000000/purge")).status).toBe(400);
  });

  test("season creation and calendar toggles are schema-validated", async () => {
    const client = await admin();
    expect((await client.post("/api/admin/seasons", { name: "X" })).status).toBe(400);
    expect((await client.post("/api/admin/seasons", { name: "UGEE 2027", year: 2027, status: "bogus" })).status).toBe(400);
    expect((await client.post("/api/admin/seasons", { name: "UGEE 2027", year: 2027, resourceCode: "CRASH_2027" })).status).toBe(201);
    expect((await client.put("/api/calendar/google/auto-add", { enabled: "yes" })).status).toBe(400);
  });
});

describe("audit coverage", () => {
  test("question and test lifecycle, config and attach are audited", async () => {
    await createUser({ email: "admin@test.local", role: "admin", name: "Admin" });
    const client = await loginClient(app, "admin@test.local");
    const q = await client.post("/api/admin/questions", { section: "SUPR", topic: "t", prompt: "P", options: ["a", "b"], correctOption: 0 });
    expect(q.status).toBe(201);
    const t = await client.post("/api/tests", { title: "Audited test" });
    expect(t.status).toBe(201);
    await client.post("/api/admin/attach", { testId: t.body.test.id, questionId: q.body.question.id });
    await client.put(`/api/admin/questions/${q.body.question.id}`, { prompt: "P2" });
    await client.put("/api/admin/config", { noticeTitle: "Hello" });
    await new Promise((r) => setTimeout(r, 150));
    const actions = (await AuditLog.find({}).lean()).map((l) => l.action);
    expect(actions).toEqual(expect.arrayContaining(["QUESTION_CREATED", "TEST_CREATED", "TEST_QUESTION_ATTACHED", "QUESTION_UPDATED", "CONFIG_UPDATED"]));
    const created = await AuditLog.findOne({ action: "QUESTION_CREATED" }).lean();
    expect(created.entityId).toBe(q.body.question.id);
    expect(String(created.actorUserId)).toBe(client.user.id);
  });

  test("failed mutations are not audited", async () => {
    await createUser({ email: "admin@test.local", role: "admin", name: "Admin" });
    const client = await loginClient(app, "admin@test.local");
    await client.post("/api/admin/questions", { section: "NOPE" });
    await new Promise((r) => setTimeout(r, 100));
    expect(await AuditLog.countDocuments({ action: "QUESTION_CREATED" })).toBe(0);
  });

  test("secrets are redacted at any depth", async () => {
    await logAuditEvent({
      action: "TEST_EVENT",
      entityType: "Test",
      metadata: { password: "p", nested: { refreshToken: "rt", apiKey: "k", ok: "visible" }, list: [{ tokenHash: "h" }] },
    });
    const log = await AuditLog.findOne({ action: "TEST_EVENT" }).lean();
    expect(log.metadata.password).toBe("[REDACTED]");
    expect(log.metadata.nested.refreshToken).toBe("[REDACTED]");
    expect(log.metadata.nested.apiKey).toBe("[REDACTED]");
    expect(log.metadata.nested.ok).toBe("visible");
    expect(log.metadata.list[0].tokenHash).toBe("[REDACTED]");
  });

  test("role changes from ADMIN_EMAILS are audited", async () => {
    await createUser({ email: "admin@test.local", name: "Promoted", role: "student" });
    await loginClient(app, "admin@test.local");
    const log = await AuditLog.findOne({ action: "USER_ROLE_CHANGED" }).lean();
    expect(log.before.role).toBe("student");
    expect(log.after.role).toBe("admin");
  });

  test("unauthenticated callers can't reach audit-relevant endpoints", async () => {
    expect((await request(app).get("/api/admin/audit-logs")).status).toBe(401);
  });
});
