// Core student flows (login, catalog, test access, submit, result). Started as M0
// characterization tests; updated in M1 for cookie-only sessions + CSRF.
const request = require("supertest");

const { createApp } = require("../../app");
const { startDb, clearDb, stopDb } = require("../helpers/db");
const { createUser, createQuestions, createTest, grantEntitlementFor } = require("../helpers/fixtures");
const { newClient, loginClient } = require("../helpers/session");

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
  test("valid email + password sets the httpOnly session cookie and returns no token", async () => {
    await createUser();
    const client = await newClient(app);
    const res = await client.post("/api/auth/login", { email: "student1@test.local", password: "Passw0rd!long" });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeUndefined();
    expect(res.body.user.email).toBe("student1@test.local");
    expect(res.body.user.passwordHash).toBeUndefined();
    const cookies = String(res.headers["set-cookie"] || "");
    expect(cookies).toMatch(/aceiiit_session=/);
    expect(cookies).toMatch(/HttpOnly/i);
  });

  test("wrong password returns 401", async () => {
    await createUser();
    const client = await newClient(app);
    const res = await client.post("/api/auth/login", { email: "student1@test.local", password: "wrong-password" });
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
    const client = await loginClient(app, "student1@test.local");

    const res = await client.get("/api/tests");
    expect(res.status).toBe(200);
    const ids = res.body.tests.map((t) => t.id);
    expect(ids).toEqual(expect.arrayContaining([String(free._id), String(paid._id)]));
    expect(res.body.tests).toHaveLength(2);
    const freeEntry = res.body.tests.find((t) => t.id === String(free._id));
    const paidEntry = res.body.tests.find((t) => t.id === String(paid._id));
    // M3: the catalog is metadata only; questions come only via an exam session's paper.
    expect(freeEntry.questionIds).toHaveLength(0);
    expect(paidEntry.questionIds).toHaveLength(0);
    expect(res.body.questions).toHaveLength(0);
    expect(freeEntry.accessible).toBe(true);
    expect(paidEntry.accessible).toBe(false);
    expect(freeEntry.sectionSummary.SUPR.count).toBe(2);
    expect(paidEntry.sectionSummary).toBeNull();
  });
});

describe("test access", () => {
  test("free test is accessible, but questions are never served before the exam starts", async () => {
    await createUser();
    const questions = await createQuestions();
    const free = await createTest({ isFree: true, questions });
    const client = await loginClient(app, "student1@test.local");

    expect((await client.get(`/api/tests/${free._id}`)).status).toBe(200);
    const res = await client.get(`/api/tests/${free._id}/questions`);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("PAPER_VIA_SESSION_ONLY");
  });

  test("paid test without entitlement returns 402", async () => {
    await createUser();
    const questions = await createQuestions();
    const paid = await createTest({ isFree: false, questions });
    const client = await loginClient(app, "student1@test.local");

    const res = await client.get(`/api/tests/${paid._id}`);
    expect(res.status).toBe(402);
  });

  test("paid test with active entitlement for its season is accessible", async () => {
    const user = await createUser();
    const questions = await createQuestions();
    const paid = await createTest({ isFree: false, questions });
    await grantEntitlementFor(user, paid.seasonId);
    const client = await loginClient(app, "student1@test.local");

    const res = await client.get(`/api/tests/${paid._id}`);
    expect(res.status).toBe(200);
  });
});

describe("submit and result", () => {
  async function runExam(client, testId, answers) {
    const start = await client.agent.post("/api/attempt/start").set("X-CSRF-Token", client.csrf).send({ testId: String(testId) });
    const token = start.body.examToken;
    const sessionId = start.body.session.id;
    if (answers) {
      await client.agent
        .put(`/api/attempt/session/${sessionId}/answers`)
        .set("X-CSRF-Token", client.csrf)
        .set("X-Exam-Token", token)
        .send({ seq: 1, answers });
    }
    return client.agent
      .post("/api/attempt")
      .set("X-CSRF-Token", client.csrf)
      .set("X-Exam-Token", token)
      .set("Idempotency-Key", `core-${sessionId}`)
      .send({ sessionId });
  }

  test("server scores the attempt with negative marking and returns it", async () => {
    await createUser();
    const questions = await createQuestions();
    const free = await createTest({ isFree: true, questions });
    const client = await loginClient(app, "student1@test.local");

    // Q1 correct (+4), Q2 wrong (-1), Q3 skipped.
    const res = await runExam(client, free._id, { [String(questions[0]._id)]: 1, [String(questions[1]._id)]: 0 });
    expect(res.status).toBe(201);
    expect(res.body.attempt.score).toBe(3);
    expect(res.body.attempt.correctCount).toBe(1);
    expect(res.body.attempt.wrongCount).toBe(1);
    expect(res.body.attempt.attemptNumber).toBe(1);

    const result = await client.get(`/api/result/${res.body.attempt.id}`);
    expect(result.status).toBe(200);
    expect(result.body.attempt.score).toBe(3);
  });

  test("a second student cannot read another student's result", async () => {
    await createUser();
    await createUser({ email: "student2@test.local", name: "Student Two" });
    const questions = await createQuestions();
    const free = await createTest({ isFree: true, questions });
    const clientA = await loginClient(app, "student1@test.local");
    const clientB = await loginClient(app, "student2@test.local");

    const submit = await runExam(clientA, free._id);
    expect(submit.status).toBe(201);

    const res = await clientB.get(`/api/result/${submit.body.attempt.id}`);
    expect(res.status).toBe(404);
  });

  test("the legacy direct submit (testId + answers, no session) is rejected", async () => {
    await createUser();
    const questions = await createQuestions();
    const free = await createTest({ isFree: true, questions });
    const client = await loginClient(app, "student1@test.local");
    const res = await client.agent
      .post("/api/attempt")
      .set("X-CSRF-Token", client.csrf)
      .set("Idempotency-Key", "legacy-submit-1")
      .send({ testId: String(free._id), answers: {}, timeTakenSeconds: 1 });
    expect(res.status).toBe(400);
  });
});
