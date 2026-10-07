// Mobile double-taps can send several submits at once, even with different idempotency keys
// (e.g. a retry after a timeout). Finalization must still happen exactly once, with exactly
// one downstream side effect (one interpretation job).
const Attempt = require("../../models/Attempt");
const AttemptInterpretation = require("../../models/AttemptInterpretation");
const AttemptSession = require("../../models/AttemptSession");
const { createApp } = require("../../app");
const { startDb, clearDb, stopDb } = require("../helpers/db");
const { createUser, createQuestions, createTest } = require("../helpers/fixtures");
const { loginClient } = require("../helpers/session");

let app;
beforeAll(async () => {
  await startDb();
  app = createApp();
});
afterEach(clearDb);
afterAll(stopDb);

test("five concurrent submits with different keys finalize one Attempt and one interpretation job", async () => {
  await createUser();
  const test = await createTest({ isFree: true, questions: await createQuestions() });
  const client = await loginClient(app, "student1@test.local");
  const start = await client.post("/api/attempt/start", { testId: String(test._id) });
  const submit = (key) =>
    client.agent
      .post("/api/attempt")
      .set("X-CSRF-Token", client.csrf)
      .set("X-Exam-Token", start.body.examToken)
      .set("Idempotency-Key", key)
      .send({ sessionId: start.body.session.id });

  const responses = await Promise.all(["tap-0001-key", "tap-0002-key", "tap-0003-key", "tap-0004-key", "tap-0005-key"].map(submit));
  const ok = responses.filter((r) => r.status === 200 || r.status === 201);
  expect(ok.length).toBeGreaterThanOrEqual(1);
  const ids = new Set(ok.map((r) => r.body.attempt.id));
  expect(ids.size).toBe(1); // every successful response points at the same Attempt

  await new Promise((r) => setTimeout(r, 300)); // let the finalized-event handler enqueue
  const sessionId = start.body.session.id;
  expect(await Attempt.countDocuments({ sessionId })).toBe(1);
  const attempt = await Attempt.findOne({ sessionId }).lean();
  expect(await AttemptInterpretation.countDocuments({ attemptId: attempt._id })).toBe(1);
  expect((await AttemptSession.findById(sessionId).lean()).status).not.toBe("active");
});
