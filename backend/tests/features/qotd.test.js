// M4: Question of the Day: free/live questions only, no answer before submission, one
// attempt per IST day, persisted for the authenticated user, answer revealed afterwards.
const { createApp } = require("../../app");
const Question = require("../../models/Question");
const QotdPick = require("../../models/QotdPick");
const Test = require("../../models/Test");
const User = require("../../models/User");
const { startDb, clearDb, stopDb } = require("../helpers/db");
const { createUser, createTest } = require("../helpers/fixtures");
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

async function seed() {
  const free = await Question.insertMany([
    { section: "SUPR", topic: "free", prompt: "FREE-Q", options: ["a", "b", "c", "d"], correctOption: 2, explanation: "Because c." },
  ]);
  const paid = await Question.insertMany([
    { section: "SUPR", topic: "paid", prompt: "PAID-Q", options: ["a", "b"], correctOption: 0 },
  ]);
  const draft = await Question.insertMany([
    { section: "SUPR", topic: "draft", prompt: "DRAFT-Q", options: ["a", "b"], correctOption: 0 },
  ]);
  await createTest({ isFree: true, questions: free });
  await createTest({ isFree: false, questions: paid });
  await createTest({ isFree: true, status: "draft", questions: draft });
  return { free: free[0] };
}

describe("QOTD", () => {
  test("served from free live tests only, without the answer", async () => {
    await createUser();
    const { free } = await seed();
    const client = await loginClient(app, "student1@test.local");
    const res = await client.get("/api/tests");
    expect(res.body.qotd.id).toBe(String(free._id));
    expect(res.body.qotd.correctOption).toBeUndefined();
    expect(res.body.qotd.explanation).toBeUndefined();
    expect(res.body.qotd.attempt).toBeNull();
    expect(JSON.stringify(res.body)).not.toMatch(/PAID-Q|DRAFT-Q/);
  });

  test("submission persists for the authenticated user and reveals the answer; one per day", async () => {
    const user = await createUser();
    const { free } = await seed();
    const client = await loginClient(app, "student1@test.local");
    await client.get("/api/tests");

    const res = await client.post("/api/tests/qotd-attempt", { questionId: String(free._id), selectedOption: 1 });
    expect(res.status).toBe(200);
    expect(res.body.result).toEqual(expect.objectContaining({ correct: false, correctOption: 2, selectedOption: 1, explanation: "Because c." }));
    const stored = await User.findById(user._id).lean();
    expect(stored.lastQotdAttempt.questionId).toBe(String(free._id));
    expect(stored.lastQotdAttempt.correct).toBe(false);

    const again = await client.post("/api/tests/qotd-attempt", { questionId: String(free._id), selectedOption: 2 });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe("QOTD_ALREADY_ATTEMPTED");
    expect(again.body.result.selectedOption).toBe(1);

    const catalog = await client.get("/api/tests");
    expect(catalog.body.qotd.attempt.correctOption).toBe(2);
  });

  test("wrong question id or out-of-range option is rejected", async () => {
    await createUser();
    const { free } = await seed();
    const client = await loginClient(app, "student1@test.local");
    await client.get("/api/tests");
    expect((await client.post("/api/tests/qotd-attempt", { questionId: "0".repeat(24), selectedOption: 0 })).status).toBe(409);
    expect((await client.post("/api/tests/qotd-attempt", { questionId: String(free._id), selectedOption: 9 })).status).toBe(400);
    expect((await client.post("/api/tests/qotd-attempt", { date: "2026-10-06", answeredOpt: "1" })).status).toBe(400);
  });

  test("the daily pick is persisted and stays stable when tests change", async () => {
    await createUser();
    const { free } = await seed();
    const client = await loginClient(app, "student1@test.local");
    expect((await client.get("/api/tests")).body.qotd.id).toBe(String(free._id));
    expect(await QotdPick.countDocuments({})).toBe(1);
    const more = await Question.insertMany(
      Array.from({ length: 5 }, (_, i) => ({ section: "SUPR", topic: "t", prompt: `NEW-${i}`, options: ["a", "b"], correctOption: 0 }))
    );
    await Test.updateOne({ isFree: true, status: "live" }, { $push: { questionIds: { $each: more.map((q) => q._id) } } });
    require("../../services/testDataService").invalidateAllTestCaches();
    expect((await client.get("/api/tests")).body.qotd.id).toBe(String(free._id));
  });
});
