// Time insights: per-section breakdown, time spent on wrong answers, slowest questions,
// and a compact strip in paper order. Returned on GET /api/analysis/:id summary.
const { createApp } = require("../../app");
const Attempt = require("../../models/Attempt");
const Question = require("../../models/Question");
const Test = require("../../models/Test");
const { startDb, clearDb, stopDb } = require("../helpers/db");
const { createUser, createQuestions } = require("../helpers/fixtures");
const { loginClient } = require("../helpers/session");

let app;
beforeAll(async () => {
  await startDb();
  app = createApp();
});
afterEach(clearDb);
afterAll(stopDb);

async function setup() {
  const user = await createUser({ email: "student@test.local", name: "Student One" });
  const client = await loginClient(app, "student@test.local");
  const questions = await createQuestions(); // SUPR and REAP questions
  const test = await Test.create({
    title: "Time Insights Mock",
    isFree: true,
    status: "live",
    questionIds: questions.map((q) => q._id),
    sectionDurations: { SUPR: 60, REAP: 120 },
  });
  return { user, client, test, questions };
}

describe("features/time-insights", () => {
  test("computes per-section metrics, slowest questions, and strip in paper order", async () => {
    const { user, client, test, questions } = await setup();
    const qids = questions.map((q) => q._id);

    // Q1 (SUPR): correct, 30s
    // Q2 (SUPR): wrong, 90s
    // Q3 (REAP): skipped, 15s
    const attempt = await Attempt.create({
      userId: user._id,
      userEmail: user.email,
      testId: test._id,
      attemptNumber: 1,
      submittedAt: new Date(),
      score: 1.5,
      correctCount: 1,
      wrongCount: 1,
      skippedCount: 1,
      timeTakenSeconds: 135,
      questionReview: [
        { questionId: qids[0], section: "SUPR", topic: "algebra", status: "correct", timeSpent: 30 },
        { questionId: qids[1], section: "SUPR", topic: "algebra", status: "wrong", timeSpent: 90 },
        { questionId: qids[2], section: "REAP", topic: "logic", status: "skipped", timeSpent: 15 },
      ],
    });

    const res = await client.get(`/api/analysis/${attempt._id}`);
    expect(res.status).toBe(200);
    const summary = res.body.summary;
    expect(summary.timeInsights).toBeDefined();
    expect(summary.timeInsights).toMatchObject({
      totalSeconds: 135,
      wrongSeconds: 90,
      wrongTimePct: 67, // 90/135 = 66.6% -> 67%
      sections: {
        SUPR: {
          questions: 2,
          totalSeconds: 120,
          avgCorrectSeconds: 30,
          avgWrongSeconds: 90,
          wrongTimePct: 75, // 90/120 = 75%
        },
        REAP: {
          questions: 1,
          totalSeconds: 15,
          avgCorrectSeconds: null,
          avgWrongSeconds: null,
          wrongTimePct: 0,
        },
      },
      slowest: [
        { number: 2, status: "wrong", seconds: 90, section: "SUPR" },
        { number: 1, status: "correct", seconds: 30, section: "SUPR" },
        { number: 3, status: "skipped", seconds: 15, section: "REAP" },
      ],
      strip: [
        [30, "c", 0],
        [90, "w", 0],
        [15, "s", 1],
      ],
    });
  });

  test("returns null when no timing data was recorded or time spent is all 0", async () => {
    const { user, client, test, questions } = await setup();
    const qids = questions.map((q) => q._id);

    const attempt = await Attempt.create({
      userId: user._id,
      userEmail: user.email,
      testId: test._id,
      attemptNumber: 1,
      submittedAt: new Date(),
      questionReview: [
        { questionId: qids[0], section: "SUPR", status: "correct", timeSpent: 0 },
        { questionId: qids[1], section: "SUPR", status: "wrong", timeSpent: 0 },
      ],
    });

    const res = await client.get(`/api/analysis/${attempt._id}`);
    expect(res.status).toBe(200);
    expect(res.body.summary.timeInsights).toBeNull();
  });

  test("handles empty or missing questionReview gracefully", async () => {
    const { user, client, test } = await setup();

    const attempt = await Attempt.create({
      userId: user._id,
      userEmail: user.email,
      testId: test._id,
      attemptNumber: 1,
      submittedAt: new Date(),
      questionReview: [],
    });

    const res = await client.get(`/api/analysis/${attempt._id}`);
    expect(res.status).toBe(200);
    expect(res.body.summary.timeInsights).toBeNull();
  });

  test("limits slowest questions list to at most 5 items", async () => {
    const { user, client, test } = await setup();
    const qs = await Question.insertMany(
      Array.from({ length: 8 }, (_, i) => ({
        section: "SUPR",
        topic: "algebra",
        prompt: `Q${i + 1}`,
        options: ["a", "b"],
        correctOption: 0,
      }))
    );

    const review = qs.map((q, i) => ({
      questionId: q._id,
      section: "SUPR",
      topic: "algebra",
      status: i % 2 === 0 ? "correct" : "wrong",
      timeSpent: (i + 1) * 10, // 10, 20, 30, 40, 50, 60, 70, 80
    }));

    const attempt = await Attempt.create({
      userId: user._id,
      userEmail: user.email,
      testId: test._id,
      attemptNumber: 1,
      submittedAt: new Date(),
      questionReview: review,
    });

    const res = await client.get(`/api/analysis/${attempt._id}`);
    expect(res.status).toBe(200);
    const insights = res.body.summary.timeInsights;
    expect(insights.slowest.length).toBe(5);
    // Should be sorted descending by seconds: 80, 70, 60, 50, 40
    expect(insights.slowest.map((s) => s.seconds)).toEqual([80, 70, 60, 50, 40]);
  });
});
