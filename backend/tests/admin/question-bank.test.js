// M8: the admin question bank is paginated and filtered on the server; the snapshot carries
// only questions attached to tests (plus the bank total) instead of the whole bank.
const Question = require("../../models/Question");
const { createApp } = require("../../app");
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

async function seedBank() {
  const docs = [];
  for (let i = 0; i < 30; i += 1) {
    docs.push({
      section: i % 3 === 0 ? "REAP" : "SUPR",
      topic: i < 5 ? "probability" : "logic",
      difficulty: i % 2 ? "hard" : "easy",
      prompt: i === 7 ? "What is (a+)+ worth?" : `Bank question ${i}`,
      options: ["a", "b", "c", "d"],
      correctOption: 0,
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, i)),
    });
  }
  docs.push({ section: "SUPR", topic: "logic", prompt: "Trashed", options: ["a", "b"], correctOption: 0, deletedAt: new Date() });
  const questions = await Question.insertMany(docs);
  const test = await createTest({ isFree: true, questions: questions.slice(0, 3) });
  await createUser({ email: "admin@test.local", role: "admin", name: "Admin" });
  const admin = await loginClient(app, "admin@test.local");
  return { questions, test, admin };
}

describe("GET /api/admin/questions", () => {
  test("pages through the live bank in a stable order, excluding trashed questions", async () => {
    const { admin } = await seedBank();
    const first = await admin.get("/api/admin/questions?limit=12&page=1");
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ total: 30, page: 1, limit: 12, pages: 3 });
    expect(first.body.questions).toHaveLength(12);
    expect(first.body.questions[0].prompt).toBe("Bank question 0");
    const last = await admin.get("/api/admin/questions?limit=12&page=3");
    expect(last.body.questions).toHaveLength(6);
    const ids = new Set([...first.body.questions, ...last.body.questions].map((q) => q.id));
    expect(ids.size).toBe(18);
    expect(JSON.stringify(first.body)).not.toContain("Trashed");
    // Admin view includes the authoring fields.
    expect(first.body.questions[0]).toHaveProperty("correctOption", 0);
  });

  test("filters by section, difficulty and search (regex-escaped, id match)", async () => {
    const { admin, questions } = await seedBank();
    const reap = await admin.get("/api/admin/questions?section=REAP&limit=100");
    expect(reap.body.total).toBe(10);
    expect(reap.body.questions.every((q) => q.section === "REAP")).toBe(true);
    const hardReap = await admin.get("/api/admin/questions?section=REAP&difficulty=hard&limit=100");
    expect(hardReap.body.questions.every((q) => q.section === "REAP" && q.difficulty === "hard")).toBe(true);
    expect((await admin.get("/api/admin/questions?search=probability")).body.total).toBe(5);
    const literal = await admin.get(`/api/admin/questions?search=${encodeURIComponent("(a+)+")}`);
    expect(literal.status).toBe(200);
    expect(literal.body.total).toBe(1);
    const byId = await admin.get(`/api/admin/questions?search=${questions[12]._id}`);
    expect(byId.body.questions.map((q) => q.id)).toEqual([String(questions[12]._id)]);
  });

  test("excludeTestId hides questions already in that test (the attach drawer)", async () => {
    const { admin, test, questions } = await seedBank();
    const res = await admin.get(`/api/admin/questions?excludeTestId=${test._id}&limit=100`);
    expect(res.body.total).toBe(27);
    const ids = res.body.questions.map((q) => q.id);
    questions.slice(0, 3).forEach((q) => expect(ids).not.toContain(String(q._id)));
  });

  test("rejects bad input and non-admins", async () => {
    const { admin } = await seedBank();
    expect((await admin.get("/api/admin/questions?limit=1000")).status).toBe(400);
    expect((await admin.get("/api/admin/questions?section=MATH")).status).toBe(400);
    expect((await admin.get("/api/admin/questions?excludeTestId=nope")).status).toBe(400);
    expect((await admin.get(`/api/admin/questions?search=${"x".repeat(65)}`)).status).toBe(400);
    expect((await admin.get("/api/admin/questions?search[$ne]=1")).status).toBe(400);
    await createUser();
    const student = await loginClient(app, "student1@test.local");
    expect((await student.get("/api/admin/questions")).status).toBe(403);
  });
});

describe("GET /api/admin/snapshot", () => {
  test("ships only test-attached questions plus the bank total", async () => {
    const { admin, questions } = await seedBank();
    const res = await admin.get("/api/admin/snapshot");
    expect(res.status).toBe(200);
    expect(res.body.questionBankTotal).toBe(30);
    expect(res.body.questions.map((q) => q.id).sort()).toEqual(questions.slice(0, 3).map((q) => String(q._id)).sort());
  });
});
