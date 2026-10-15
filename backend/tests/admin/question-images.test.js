// Question images in the Studio: Save sends the exact image list (so images can be removed,
// replaced and reordered) with a display width per image (0 = Auto, else 20–100% of the
// question column). Widths stay paired with their images and reach the exam paper and review.
const { createApp } = require("../../app");
const Question = require("../../models/Question");
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

const A = "https://res.cloudinary.com/demo/image/upload/a.png";
const B = "https://res.cloudinary.com/demo/image/upload/b.png";
const C = "https://res.cloudinary.com/demo/image/upload/c.png";

function questionBody(overrides = {}) {
  return {
    section: "SUPR",
    topic: "geometry",
    prompt: "Find the angle in the figure.",
    options: ["10", "20", "30", "40"],
    correctOption: 2,
    marks: 4,
    negativeMarks: -1,
    ...overrides,
  };
}

async function adminClient() {
  await createUser({ email: "admin@test.local", role: "admin", name: "Admin" });
  return loginClient(app, "admin@test.local");
}

test("create stores widths paired with images; bad widths become Auto or are clamped", async () => {
  const admin = await adminClient();
  const res = await admin.post("/api/admin/questions", questionBody({ imageUrls: [A, B, C], imageWidths: [55, 5, 500] }));
  expect(res.status).toBe(201);
  const saved = await Question.findById(res.body.question.id).lean();
  expect(saved.imageUrls).toEqual([A, B, C]);
  expect(saved.imageWidths).toEqual([55, 20, 100]);

  const missing = await admin.post("/api/admin/questions", questionBody({ imageUrls: [A, B] }));
  expect((await Question.findById(missing.body.question.id).lean()).imageWidths).toEqual([0, 0]);
});

test("update replaces the list exactly: remove all, reorder, replace keep their widths", async () => {
  const admin = await adminClient();
  const created = await admin.post("/api/admin/questions", questionBody({ imageUrls: [A, B], imageWidths: [55, 0] }));
  const id = created.body.question.id;

  const reordered = await admin.put(`/api/admin/questions/${id}`, questionBody({ imageUrls: [B, A], imageWidths: [0, 55] }));
  expect(reordered.status).toBe(200);
  let saved = await Question.findById(id).lean();
  expect(saved.imageUrls).toEqual([B, A]);
  expect(saved.imageWidths).toEqual([0, 55]);

  await admin.put(`/api/admin/questions/${id}`, questionBody({ imageUrls: [C, A], imageWidths: [0, 55] }));
  saved = await Question.findById(id).lean();
  expect(saved.imageUrls).toEqual([C, A]);
  expect(saved.imageWidths).toEqual([0, 55]);

  await admin.put(`/api/admin/questions/${id}`, questionBody({ imageUrls: [], imageWidths: [] }));
  saved = await Question.findById(id).lean();
  expect(saved.imageUrls).toEqual([]);
  expect(saved.imageWidths).toEqual([]);
});

test("widths reach the student's exam paper", async () => {
  const admin = await adminClient();
  const created = await admin.post("/api/admin/questions", questionBody({ imageUrls: [A], imageWidths: [75] }));
  const question = await Question.findById(created.body.question.id);
  const reap = await Question.create({ ...questionBody({ section: "REAP", topic: "logic" }) });
  const test = await createTest({ isFree: true, questions: [question, reap] });
  await createUser();
  const student = await loginClient(app, "student1@test.local");
  const start = await student.agent.post("/api/attempt/start").set("X-CSRF-Token", student.csrf).send({ testId: String(test._id) });
  const paper = await student.agent.get(`/api/attempt/session/${start.body.session.id}/paper`).set("X-Exam-Token", start.body.examToken);
  const served = paper.body.questions.find((q) => q.id === String(question._id));
  expect(served.imageUrls).toEqual([A]);
  expect(served.imageWidths).toEqual([75]);
});
