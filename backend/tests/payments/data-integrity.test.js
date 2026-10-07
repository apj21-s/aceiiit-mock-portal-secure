// M3 (database integrity): live-test questions can't be destroyed, trashed questions
// can't brick a test, and users are only purged explicitly with an anonymizing cascade.
const { createApp } = require("../../app");
const Attempt = require("../../models/Attempt");
const AuditLog = require("../../models/AuditLog");
const Entitlement = require("../../models/Entitlement");
const Question = require("../../models/Question");
const Reminder = require("../../models/Reminder");
const Test = require("../../models/Test");
const User = require("../../models/User");
const { startDb, clearDb, stopDb } = require("../helpers/db");
const { createUser, createQuestions, createTest, grantEntitlementFor } = require("../helpers/fixtures");
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

async function admin() {
  await createUser({ email: "admin@test.local", role: "admin", name: "Admin" });
  return loginClient(app, "admin@test.local");
}

describe("question lifecycle", () => {
  test("deleting a question attached to a live test → 409; a draft test's question can be trashed", async () => {
    const client = await admin();
    const questions = await createQuestions();
    await createTest({ isFree: true, questions });
    const res = await client.del(`/api/admin/questions/${questions[0]._id}`);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("QUESTION_IN_LIVE_TEST");
    expect((await Question.findById(questions[0]._id)).deletedAt).toBeNull();

    await Test.updateMany({}, { $set: { status: "draft" } });
    expect((await client.del(`/api/admin/questions/${questions[0]._id}`)).status).toBe(200);
  });

  test("purging a question used by a live test → 409", async () => {
    const client = await admin();
    const questions = await createQuestions();
    await createTest({ isFree: true, questions });
    await Question.updateOne({ _id: questions[0]._id }, { $set: { deletedAt: new Date() } });
    const res = await client.del(`/api/admin/trash/questions/${questions[0]._id}/purge`);
    expect(res.status).toBe(409);
    expect(await Question.countDocuments({ _id: questions[0]._id })).toBe(1);
  });

  test("a soft-deleted question still attached to a test doesn't brick the exam", async () => {
    await createUser();
    const questions = await createQuestions();
    const test = await createTest({ isFree: true, questions });
    await Question.updateOne({ _id: questions[2]._id }, { $set: { deletedAt: new Date() } });
    const client = await loginClient(app, "student1@test.local");
    const start = await client.agent.post("/api/attempt/start").set("X-CSRF-Token", client.csrf).send({ testId: String(test._id) });
    expect(start.status).toBe(201);
    const paper = await client.agent.get(`/api/attempt/session/${start.body.session.id}/paper`).set("X-Exam-Token", start.body.examToken);
    expect(paper.body.questions).toHaveLength(3);
  });
});

describe("user purge", () => {
  test("users are never auto-deleted (no TTL index on deletedAt)", async () => {
    const indexes = await User.collection.indexes();
    const ttl = indexes.filter((idx) => idx.key && idx.key.deletedAt === 1 && idx.expireAfterSeconds !== undefined);
    expect(ttl).toHaveLength(0);
  });

  test("purge requires the user to be in trash, then anonymizes and cascades, audited", async () => {
    const client = await admin();
    const student = await createUser();
    const questions = await createQuestions();
    const test = await createTest({ isFree: true, questions });
    await grantEntitlementFor(student, test.seasonId);
    await Attempt.create({ userId: student._id, testId: test._id, attemptNumber: 1, userEmail: student.email, score: 4 });
    await Reminder.create({ userId: student._id, email: student.email, title: "Mock", testId: test._id, remindAt: new Date(), plannedAt: new Date() });

    expect((await client.del(`/api/admin/trash/users/${student._id}/purge`)).status).toBe(409);
    expect((await client.del(`/api/admin/users/${student._id}`)).status).toBe(200);
    expect((await client.del(`/api/admin/trash/users/${student._id}/purge`)).status).toBe(200);

    expect(await User.countDocuments({ _id: student._id })).toBe(0);
    const attempt = await Attempt.findOne({ userId: student._id });
    expect(attempt.userEmail).toBe("");
    expect(attempt.score).toBe(4);
    expect((await Entitlement.findOne({ normalizedEmail: student.email })).userId).toBeNull();
    expect(await Reminder.countDocuments({ userId: student._id })).toBe(0);
    expect(await AuditLog.countDocuments({ action: "USER_PURGED", entityId: String(student._id) })).toBe(1);
  });
});
