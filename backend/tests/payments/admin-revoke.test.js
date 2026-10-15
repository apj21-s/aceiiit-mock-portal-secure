// Studio "Revoke Paid Access" must remove real access (entitlements), not just the isPaid flag.
const { createApp } = require("../../app");
const Entitlement = require("../../models/Entitlement");
const PaymentRecord = require("../../models/PaymentRecord");
const User = require("../../models/User");
const { getActiveSeason } = require("../../services/seasonService");
const { startDb, clearDb, stopDb } = require("../helpers/db");
const { createUser, createTest } = require("../helpers/fixtures");
const { loginClient } = require("../helpers/session");

let app;
beforeAll(async () => { await startDb(); app = createApp(); });
afterEach(clearDb);
afterAll(stopDb);

test("revoking in Studio closes every paid test, and logging in again doesn't re-grant", async () => {
  const season = await getActiveSeason();
  const student = await createUser({ email: "pro@test.local" });
  await Entitlement.create({ email: "pro@test.local", normalizedEmail: "pro@test.local", seasonId: season._id, tier: "paid", status: "active", source: "admin" });
  await PaymentRecord.create({ seasonId: season._id, email: "pro@test.local", normalizedEmail: "pro@test.local", status: "verified", source: "commerce" });
  const paid = await createTest({ isFree: false });
  let s = await loginClient(app, "pro@test.local");
  expect((await s.get(`/api/tests/${paid._id}`)).status).toBe(200);

  await createUser({ email: "admin@test.local", role: "admin" });
  const a = await loginClient(app, "admin@test.local");
  expect((await a.post(`/api/admin/users/${student._id}/revoke-payment`, {})).status).toBe(200);

  expect((await s.get(`/api/tests/${paid._id}`)).status).not.toBe(200);
  s = await loginClient(app, "pro@test.local");
  expect((await s.get(`/api/tests/${paid._id}`)).status).not.toBe(200);
  expect(await Entitlement.countDocuments({ status: "active" })).toBe(0);
  expect((await User.findById(student._id).lean()).isPaid).toBe(false);
});

describe("after access is revoked, nothing paid stays open", () => {
  const Question = require("../../models/Question");
  async function setup() {
    const season = await getActiveSeason();
    const student = await createUser({ email: "pro@test.local" });
    await Entitlement.create({ email: "pro@test.local", normalizedEmail: "pro@test.local", seasonId: season._id, tier: "paid", status: "active", source: "admin" });
    const qs = await Question.insertMany(Array.from({ length: 3 }, (_, i) => ({ section: "SUPR", topic: "algebra", difficulty: "medium", prompt: `Paid Q${i + 1}`, options: ["a", "b", "c", "d"], correctOption: 0 })));
    const paid = await createTest({ isFree: false, questions: qs });
    await createUser({ email: "admin@test.local", role: "admin" });
    const admin = await loginClient(app, "admin@test.local");
    const s = await loginClient(app, "pro@test.local");
    const revoke = async () => expect((await admin.post(`/api/admin/users/${student._id}/revoke-payment`, {})).status).toBe(200);
    return { student, paid, admin, s, revoke };
  }
  const start = (s, testId) => s.agent.post("/api/attempt/start").set("X-CSRF-Token", s.csrf).send({ testId: String(testId) });

  test("a practice paper built from paid questions can't be started", async () => {
    const { s, revoke } = await setup();
    const practice = await s.post("/api/tests/practice", { subject: "all", count: 3, timerMinutes: 10 });
    expect(practice.status).toBe(201);
    await revoke();
    expect((await start(s, practice.body.test.id)).status).toBe(402);
  });

  test("an exam opened before the revoke can't load its paper or be taken over", async () => {
    const { s, paid, revoke } = await setup();
    const started = await start(s, paid._id);
    expect(started.status).toBe(201);
    const paper = () => s.agent.get(`/api/attempt/session/${started.body.session.id}/paper`).set("X-Exam-Token", started.body.examToken);
    expect((await paper()).status).toBe(200);
    await revoke();
    expect((await paper()).status).toBe(402);
    const take = await s.agent.post(`/api/attempt/session/${started.body.session.id}/takeover`).set("X-CSRF-Token", s.csrf).send({});
    expect(take.status).toBe(402);
  });

  test("question review of a past paid attempt is locked; the score stays", async () => {
    const { s, paid, revoke } = await setup();
    const started = await start(s, paid._id);
    const submit = await s.agent.post("/api/attempt").set("X-CSRF-Token", s.csrf).set("X-Exam-Token", started.body.examToken)
      .set("Idempotency-Key", `rv-${started.body.session.id}`).send({ sessionId: started.body.session.id });
    const id = submit.body.attempt.id;
    expect((await s.get(`/api/result/${id}?includeReview=1`)).status).toBe(200);
    await revoke();
    expect((await s.get(`/api/result/${id}?includeReview=1`)).status).toBe(402);
    expect((await s.get(`/api/analysis/${id}/questions`)).status).toBe(402);
    expect((await s.get(`/api/result/${id}`)).status).toBe(200);
    expect(JSON.stringify((await s.get(`/api/result/${id}`)).body)).not.toMatch(/Paid Q1/);
  });

  test("Studio Verify grants real access again after a revoke", async () => {
    const { student, paid, admin, s, revoke } = await setup();
    await revoke();
    expect((await s.get(`/api/tests/${paid._id}`)).status).not.toBe(200);
    expect((await admin.post(`/api/admin/users/${student._id}/verify-payment`, {})).status).toBe(200);
    expect((await s.get(`/api/tests/${paid._id}`)).status).toBe(200);
  });
});
