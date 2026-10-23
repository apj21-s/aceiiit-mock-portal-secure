// Mistake practice: a paper of the questions whose latest answer was wrong or skipped. A later
// correct answer takes a question off the list; questions the student can no longer open,
// deleted ones, and answers from live events whose results aren't out yet don't count.
const { createApp } = require("../../app");
const Attempt = require("../../models/Attempt");
const Question = require("../../models/Question");
const Test = require("../../models/Test");
const { startDb, clearDb, stopDb } = require("../helpers/db");
const { createUser, createTest } = require("../helpers/fixtures");
const { loginClient } = require("../helpers/session");

let app;
beforeAll(async () => { await startDb(); app = createApp(); });
afterEach(clearDb);
afterAll(stopDb);

let attemptNo = 0;
async function attempt(user, test, outcomes, minutesAgo) {
  attemptNo += 1;
  return Attempt.create({
    userId: user._id,
    testId: test._id,
    attemptNumber: attemptNo,
    submittedAt: new Date(Date.now() - minutesAgo * 60000),
    questionReview: Object.entries(outcomes).map(([questionId, status]) => ({ questionId, status })),
  });
}

async function setup() {
  const qs = await Question.insertMany(Array.from({ length: 8 }, (_, i) => ({
    section: i < 5 ? "SUPR" : "REAP", topic: "t", prompt: `Q${i}`, options: ["a", "b"], correctOption: 0,
  })));
  const test = await createTest({ isFree: true, questions: qs });
  const user = await createUser({ email: "student1@test.local" });
  const client = await loginClient(app, "student1@test.local");
  return { qs, test, user, client, id: (i) => String(qs[i]._id) };
}

test("the latest outcome decides: a later correct answer drops the question", async () => {
  const { test, user, client, id } = await setup();
  await attempt(user, test, { [id(0)]: "wrong", [id(1)]: "skipped", [id(2)]: "correct", [id(5)]: "wrong" }, 60);
  await attempt(user, test, { [id(0)]: "correct", [id(2)]: "wrong" }, 30);
  const options = await client.get("/api/tests/practice/mistakes");
  expect(options.status).toBe(200);
  expect(options.body).toMatchObject({ available: 3, bySection: { SUPR: 2, REAP: 1 } });
  const made = await client.post("/api/tests/practice/mistakes", { count: 10 });
  expect(made.status).toBe(201);
  expect(made.body.test).toMatchObject({ title: "Practice: My mistakes", isPractice: true, questionCount: 3 });
  const saved = await Test.findById(made.body.test.id).lean();
  expect(saved.questionIds.map(String).sort()).toEqual([id(1), id(2), id(5)].sort());
  // SUPR first, as in the real paper.
  expect(String(saved.questionIds[2])).toBe(id(5));
});

test("section filter, size cap and nothing due", async () => {
  const { test, user, client, id } = await setup();
  expect((await client.post("/api/tests/practice/mistakes", {})).body.code).toBe("MISTAKES_NONE");
  await attempt(user, test, { [id(0)]: "wrong", [id(1)]: "wrong", [id(6)]: "skipped" }, 10);
  const reap = await client.post("/api/tests/practice/mistakes", { section: "REAP" });
  expect(reap.body.test).toMatchObject({ title: "Practice: My REAP mistakes", questionCount: 1 });
  expect((await client.post("/api/tests/practice/mistakes", { count: 31 })).status).toBe(400);
  expect((await client.post("/api/tests/practice/mistakes", { questionIds: [id(0)] })).status).toBe(400);
});

test("deleted questions and paid questions the student can't open are left out", async () => {
  const { qs, test, user, client, id } = await setup();
  const paidQs = await Question.insertMany([{ section: "SUPR", topic: "t", prompt: "Paid", options: ["a", "b"], correctOption: 0 }]);
  const paid = await createTest({ isFree: false, questions: paidQs });
  await attempt(user, paid, { [String(paidQs[0]._id)]: "wrong" }, 20);
  await attempt(user, test, { [id(0)]: "wrong", [id(1)]: "wrong" }, 10);
  await Question.updateOne({ _id: qs[1]._id }, { $set: { deletedAt: new Date() } });
  expect((await client.get("/api/tests/practice/mistakes")).body.available).toBe(1);
});

test("answers from a live event don't count until its results are out", async () => {
  const { test, user, client, id } = await setup();
  await Test.updateOne({ _id: test._id }, { $set: { event: { enabled: true, startsAt: new Date(Date.now() - 3600000), joinMinutes: 15, resultsAt: new Date(Date.now() + 3600000) } } });
  await attempt(user, test, { [id(0)]: "wrong" }, 10);
  expect((await client.get("/api/tests/practice/mistakes")).body.available).toBe(0);
  await Test.updateOne({ _id: test._id }, { $set: { "event.resultsAt": new Date(Date.now() - 1000) } });
  expect((await client.get("/api/tests/practice/mistakes")).body.available).toBe(1);
});

test("free accounts share the one free practice paper", async () => {
  const { test, user, client, id } = await setup();
  await attempt(user, test, { [id(0)]: "wrong", [id(1)]: "wrong" }, 10);
  // createTest's default season makes this student free (no entitlement).
  expect((await client.post("/api/tests/practice/mistakes", { count: 5 })).status).toBe(201);
  const again = await client.post("/api/tests/practice/mistakes", { count: 5 });
  expect(again.status).toBe(402);
  expect(again.body.code).toBe("PRACTICE_LIMIT");
});
