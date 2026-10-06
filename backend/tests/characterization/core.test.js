// M0 characterization tests: record current behaviour of the core student flows
// before hardening starts, so later milestones can prove what changed and what didn't.
const request = require("supertest");

const { createApp } = require("../../app");
const { startDb, clearDb, stopDb } = require("../helpers/db");
const { createUser, createQuestions, createTest, grantEntitlementFor, loginAs } = require("../helpers/fixtures");

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

describe("login", () => {
  test("valid email + password returns a token and sets the session cookie", async () => {
    await createUser();
    const res = await request(app).post("/api/auth/login").send({ email: "student1@test.local", password: "Passw0rd!long" });
    expect(res.status).toBe(200);
    expect(typeof res.body.token).toBe("string");
    expect(res.body.user.email).toBe("student1@test.local");
    expect(res.body.user.passwordHash).toBeUndefined();
    expect(String(res.headers["set-cookie"] || "")).toMatch(/aceiiit_session=/);
  });

  test("wrong password returns 401", async () => {
    await createUser();
    const res = await request(app).post("/api/auth/login").send({ email: "student1@test.local", password: "wrong-password" });
    expect(res.status).toBe(401);
  });

  test("unauthenticated API access returns 401", async () => {
    const res = await request(app).get("/api/tests");
    expect(res.status).toBe(401);
  });
});

describe("catalog", () => {
  test("lists live tests; question ids only for accessible tests", async () => {
    await createUser();
    const questions = await createQuestions();
    const free = await createTest({ isFree: true, questions });
    const paid = await createTest({ isFree: false, questions });
    await createTest({ isFree: true, status: "draft", questions });
    const token = await loginAs(request, app, "student1@test.local");

    const res = await request(app).get("/api/tests").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    const ids = res.body.tests.map((t) => t.id);
    expect(ids).toEqual(expect.arrayContaining([String(free._id), String(paid._id)]));
    expect(res.body.tests).toHaveLength(2);
    const freeEntry = res.body.tests.find((t) => t.id === String(free._id));
    const paidEntry = res.body.tests.find((t) => t.id === String(paid._id));
    expect(freeEntry.questionIds).toHaveLength(3);
    expect(paidEntry.questionIds).toHaveLength(0);
    // Public question payloads never include the answer key.
    res.body.questions.forEach((q) => expect(q.correctOption).toBeUndefined());
  });
});

describe("test access", () => {
  test("free test is accessible", async () => {
    await createUser();
    const questions = await createQuestions();
    const free = await createTest({ isFree: true, questions });
    const token = await loginAs(request, app, "student1@test.local");

    const res = await request(app).get(`/api/tests/${free._id}/questions`).set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.questions).toHaveLength(3);
    res.body.questions.forEach((q) => expect(q.correctOption).toBeUndefined());
  });

  test("paid test without entitlement returns 402", async () => {
    await createUser();
    const questions = await createQuestions();
    const paid = await createTest({ isFree: false, questions });
    const token = await loginAs(request, app, "student1@test.local");

    const res = await request(app).get(`/api/tests/${paid._id}`).set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(402);
  });

  test("paid test with active entitlement for its season is accessible", async () => {
    const user = await createUser();
    const questions = await createQuestions();
    const paid = await createTest({ isFree: false, questions });
    await grantEntitlementFor(user, paid.seasonId);
    const token = await loginAs(request, app, "student1@test.local");

    const res = await request(app).get(`/api/tests/${paid._id}`).set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
  });
});

describe("submit and result", () => {
  test("server scores the attempt with negative marking and returns it", async () => {
    await createUser();
    const questions = await createQuestions();
    const free = await createTest({ isFree: true, questions });
    const token = await loginAs(request, app, "student1@test.local");

    // Q1 correct (+4), Q2 wrong (-1), Q3 skipped.
    const answers = { [String(questions[0]._id)]: 1, [String(questions[1]._id)]: 0 };
    const res = await request(app)
      .post("/api/attempt")
      .set("Authorization", `Bearer ${token}`)
      .send({ testId: String(free._id), answers, timeTakenSeconds: 120 });
    expect(res.status).toBe(201);
    expect(res.body.attempt.score).toBe(3);
    expect(res.body.attempt.correctCount).toBe(1);
    expect(res.body.attempt.wrongCount).toBe(1);
    expect(res.body.attempt.attemptNumber).toBe(1);

    const result = await request(app)
      .get(`/api/result/${res.body.attempt.id}`)
      .set("Authorization", `Bearer ${token}`);
    expect(result.status).toBe(200);
    expect(result.body.attempt.score).toBe(3);
  });

  test("a second student cannot read another student's result", async () => {
    await createUser();
    await createUser({ email: "student2@test.local", name: "Student Two" });
    const questions = await createQuestions();
    const free = await createTest({ isFree: true, questions });
    const tokenA = await loginAs(request, app, "student1@test.local");
    const tokenB = await loginAs(request, app, "student2@test.local");

    const submit = await request(app)
      .post("/api/attempt")
      .set("Authorization", `Bearer ${tokenA}`)
      .send({ testId: String(free._id), answers: {} });
    expect(submit.status).toBe(201);

    const res = await request(app)
      .get(`/api/result/${submit.body.attempt.id}`)
      .set("Authorization", `Bearer ${tokenB}`);
    expect(res.status).toBe(404);
  });
});
