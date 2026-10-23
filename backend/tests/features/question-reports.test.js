// "Report a problem": students report questions from their own results (one open report per
// question, updated if sent again); admins see them grouped by question and resolve them.
const { createApp } = require("../../app");
const Attempt = require("../../models/Attempt");
const Question = require("../../models/Question");
const QuestionReport = require("../../models/QuestionReport");
const { startDb, clearDb, stopDb } = require("../helpers/db");
const { createUser, createTest } = require("../helpers/fixtures");
const { loginClient } = require("../helpers/session");
const { purgeUserCascade } = require("../../services/accountPurgeService");

let app;
beforeAll(async () => { await startDb(); app = createApp(); });
afterEach(clearDb);
afterAll(stopDb);

async function setup() {
  const qs = await Question.insertMany([
    { section: "SUPR", topic: "algebra", prompt: "2 + 2 = ?", options: ["3", "4"], correctOption: 0 },
    { section: "REAP", topic: "logic", prompt: "Odd one out", options: ["a", "b"], correctOption: 1 },
  ]);
  const test = await createTest({ isFree: true, questions: qs });
  await createUser({ email: "admin@test.local", role: "admin", name: "Admin" });
  const s1 = await createUser({ email: "s1@test.local", name: "Riya" });
  const s2 = await createUser({ email: "s2@test.local", name: "Arjun" });
  const review = qs.map((q) => ({ questionId: q._id, status: "wrong" }));
  const a1 = await Attempt.create({ userId: s1._id, testId: test._id, attemptNumber: 1, submittedAt: new Date(), questionReview: review });
  const a2 = await Attempt.create({ userId: s2._id, testId: test._id, attemptNumber: 1, submittedAt: new Date(), questionReview: review.slice(0, 1) });
  return {
    qs, test, s1,
    a1: String(a1._id), a2: String(a2._id),
    admin: await loginClient(app, "admin@test.local"),
    c1: await loginClient(app, "s1@test.local"),
    c2: await loginClient(app, "s2@test.local"),
  };
}

test("students report questions from their own results; a second report updates the first", async () => {
  const { qs, a1, c1 } = await setup();
  const q = String(qs[0]._id);
  const first = await c1.post(`/api/questions/${q}/report`, { attemptId: a1, reason: "wrong_answer", note: "4 is correct, not 3" });
  expect(first.status).toBe(201);
  const again = await c1.post(`/api/questions/${q}/report`, { attemptId: a1, reason: "typo", note: "" });
  expect(again.body.report.id).toBe(first.body.report.id);
  expect(await QuestionReport.countDocuments({})).toBe(1);
  expect((await QuestionReport.findOne({}).lean()).reason).toBe("typo");
});

test("you can't report someone else's attempt, a question you didn't get, or junk", async () => {
  const { qs, a1, a2, c1, c2 } = await setup();
  expect((await c2.post(`/api/questions/${qs[0]._id}/report`, { attemptId: a1, reason: "typo" })).status).toBe(404);
  expect((await c2.post(`/api/questions/${qs[1]._id}/report`, { attemptId: a2, reason: "typo" })).status).toBe(404);
  expect((await c1.post(`/api/questions/${qs[0]._id}/report`, { attemptId: a1, reason: "spam" })).status).toBe(400);
  expect((await c1.post(`/api/questions/${qs[0]._id}/report`, { attemptId: a1, reason: "typo", note: "x".repeat(501) })).status).toBe(400);
  expect((await c1.post(`/api/questions/${qs[0]._id}/report`, { attemptId: a1, reason: "typo", userId: "x" })).status).toBe(400);
  expect((await c1.post("/api/questions/not-an-id/report", { attemptId: a1, reason: "typo" })).status).toBe(400);
});

test("admins see reports grouped by question (names only), resolve them, and students can report again", async () => {
  const { qs, a1, a2, c1, c2, admin } = await setup();
  const q = String(qs[0]._id);
  await c1.post(`/api/questions/${q}/report`, { attemptId: a1, reason: "wrong_answer", note: "Key says 3" });
  await c2.post(`/api/questions/${q}/report`, { attemptId: a2, reason: "wrong_answer" });
  await c1.post(`/api/questions/${qs[1]._id}/report`, { attemptId: a1, reason: "maths" });
  expect((await c1.get("/api/admin/reports")).status).toBe(403);
  const list = await admin.get("/api/admin/reports");
  expect(list.status).toBe(200);
  expect(list.body.openTotal).toBe(3);
  expect(list.body.items[0]).toMatchObject({ questionId: q, count: 2, reasons: { wrong_answer: 2 }, question: { prompt: "2 + 2 = ?", tests: [{ title: "Free Mock" }] } });
  expect(list.body.items[0].reports.map((r) => r.student).sort()).toEqual(["Arjun", "Riya"]);
  expect(JSON.stringify(list.body)).not.toMatch(/@test\.local/);
  expect((await admin.get("/api/admin/reports/counts")).body.counts).toEqual({ [q]: 2, [String(qs[1]._id)]: 1 });
  expect((await c1.post(`/api/admin/reports/${q}/resolve`, {})).status).toBe(403);
  const resolved = await admin.post(`/api/admin/reports/${q}/resolve`, { note: "Answer key fixed" });
  expect(resolved.body.resolved).toBe(2);
  expect((await admin.get("/api/admin/reports")).body.items.map((i) => i.questionId)).toEqual([String(qs[1]._id)]);
  expect((await admin.get("/api/admin/reports?status=resolved")).body.items[0].reports[0].resolutionNote).toBe("Answer key fixed");
  // A fresh report after a fix is a new open report.
  expect((await c1.post(`/api/questions/${q}/report`, { attemptId: a1, reason: "typo" })).status).toBe(201);
  expect(await QuestionReport.countDocuments({ questionId: q })).toBe(3);
});

test("deleting an account deletes its reports", async () => {
  const { qs, a1, c1, s1 } = await setup();
  await c1.post(`/api/questions/${qs[0]._id}/report`, { attemptId: a1, reason: "typo" });
  await purgeUserCascade(s1._id);
  expect(await QuestionReport.countDocuments({})).toBe(0);
});

test("rate limiting prevents report spam", async () => {
  const { qs, a1, c1 } = await setup();
  const q = String(qs[0]._id);
  for (let i = 0; i < 20; i += 1) {
    const res = await c1.post(`/api/questions/${q}/report`, { attemptId: a1, reason: "typo", note: `note ${i}` });
    expect([200, 201]).toContain(res.status);
  }
  const blocked = await c1.post(`/api/questions/${q}/report`, { attemptId: a1, reason: "typo", note: "blocked" });
  expect(blocked.status).toBe(429);
  expect(blocked.body.error).toMatch(/Too many submission requests/);
});

