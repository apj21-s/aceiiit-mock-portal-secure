// The result API returns the paper's full marks (from the attempt's own question snapshot) and
// the ranking cohort size, so the results page can show "17 / 210" and "rank 3 of 48" without
// the question list (students never receive it).
const { createApp } = require("../../app");
const Question = require("../../models/Question");
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

async function submitAs(client, test, key) {
  const start = await client.post("/api/attempt/start", { testId: String(test._id) });
  const res = await client.agent
    .post("/api/attempt")
    .set("X-CSRF-Token", client.csrf)
    .set("X-Exam-Token", start.body.examToken)
    .set("Idempotency-Key", key)
    .send({ sessionId: start.body.session.id });
  return res.body.attempt.id;
}

test("maxScore comes from the attempt snapshot and rankTotal from the cohort", async () => {
  await createUser({ email: "a@test.local" });
  await createUser({ email: "b@test.local" });
  const questions = await createQuestions(); // 3 questions × 4 marks
  const test = await createTest({ isFree: true, questions });
  const a = await loginClient(app, "a@test.local");
  const b = await loginClient(app, "b@test.local");
  const attemptId = await submitAs(a, test, "result-api-a-0001");
  await submitAs(b, test, "result-api-b-0001");

  const res = await a.get(`/api/result/${attemptId}`);
  expect(res.status).toBe(200);
  expect(res.body.attempt.maxScore).toBe(12);
  expect(res.body.attempt.rankTotal).toBe(2);

  // Editing a question's marks later doesn't change a finished attempt's full marks.
  await Question.updateMany({}, { $set: { marks: 10 } });
  expect((await a.get(`/api/result/${attemptId}`)).body.attempt.maxScore).toBe(12);
});
