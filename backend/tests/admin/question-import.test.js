// Bulk question import (Excel/CSV): exact (cells become questions as typed), every formula
// checked with KaTeX, problems reported by row before anything is saved, and an all-or-nothing
// import that attaches the questions to a test in sheet order.
const ExcelJS = require("exceljs");
const { createApp } = require("../../app");
const Question = require("../../models/Question");
const Test = require("../../models/Test");
const { startDb, clearDb, stopDb } = require("../helpers/db");
const { createUser, createTest } = require("../helpers/fixtures");
const { loginClient } = require("../helpers/session");

let app;
beforeAll(async () => { await startDb(); app = createApp(); });
afterEach(clearDb);
afterAll(stopDb);

const HEADERS = ["section", "topic", "difficulty", "question", "option_a", "option_b", "option_c", "option_d", "answer", "marks", "negative_marks", "explanation"];

async function xlsx(rows) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Questions");
  ws.addRow(HEADERS);
  rows.forEach((r) => ws.addRow(r));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

function csv(rows) {
  const cell = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  return Buffer.from([HEADERS].concat(rows).map((r) => r.map(cell).join(",")).join("\r\n"), "utf8");
}

async function people() {
  await createUser({ email: "admin@test.local", role: "admin", name: "Admin" });
  await createUser({ email: "student1@test.local", name: "Student" });
  return { admin: await loginClient(app, "admin@test.local"), student: await loginClient(app, "student1@test.local") };
}

function preview(client, buffer, name, testId) {
  const req = client.agent.post("/api/admin/questions/import/preview").set("X-CSRF-Token", client.csrf).attach("file", buffer, name);
  return testId ? req.field("testId", testId) : req;
}

const good = [
  ["SUPR", "Kinematics", "medium", "A ball of mass $m$ moves at $v$. Its kinetic energy is", "$mv$", "$\\frac{1}{2}mv^2$", "$mv^2$", "$2mv^2$", "B", "", "", "It is $\\frac{1}{2}mv^2$."],
  ["REAP", "Logic", "easy", "Next: 2, 6, 12, 20, ?", "28", "30", "32", "36", "B", "2", "-0.5", ""],
];

test("the template downloads as .xlsx (with the expected columns) and as .csv", async () => {
  const { admin } = await people();
  const x = await admin.agent.get("/api/admin/questions/import-template?format=xlsx").buffer(true).parse((res, cb) => { const chunks = []; res.on("data", (c) => chunks.push(c)); res.on("end", () => cb(null, Buffer.concat(chunks))); });
  expect(x.status).toBe(200);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(x.body);
  const headers = wb.getWorksheet("Questions").getRow(1).values.filter(Boolean);
  expect(headers.slice(0, 5)).toEqual(["section", "topic", "difficulty", "question", "option_a"]);
  expect(wb.getWorksheet("How to fill")).toBeTruthy();
  const c = await admin.get("/api/admin/questions/import-template?format=csv");
  expect(c.headers["content-type"]).toMatch(/text\/csv/);
  expect(c.text.split(/\r?\n/)[0]).toMatch(/^\ufeff?section,topic,difficulty,question,option_a/);
});

test("a clean sheet previews without saving, then imports and attaches in order", async () => {
  const { admin } = await people();
  const target = await createTest({ isFree: true });
  const res = await preview(admin, await xlsx(good), "paper.xlsx", String(target._id));
  expect(res.status).toBe(200);
  expect(res.body.summary).toMatchObject({ total: 2, ready: 2, withErrors: 0, adding: { SUPR: 1, REAP: 1 } });
  expect(res.body.rows[0]).toMatchObject({ row: 2, errors: [], question: { section: "SUPR", correctOption: 1, options: ["$mv$", "$\\frac{1}{2}mv^2$", "$mv^2$", "$2mv^2$"] } });
  expect(await Question.countDocuments({})).toBe(0); // preview saves nothing
  const commit = await admin.post("/api/admin/questions/import/commit", { testId: String(target._id), questions: res.body.rows.map((r) => r.question) });
  expect(commit.status).toBe(201);
  expect(commit.body).toMatchObject({ imported: 2, bySection: { SUPR: 1, REAP: 1 } });
  const saved = await Question.find({}).sort({ _id: 1 }).lean();
  expect(saved.map((q) => [q.section, q.marks, q.negativeMarks])).toEqual([["SUPR", 1, -0.25], ["REAP", 2, -0.5]]);
  const t = await Test.findById(target._id).lean();
  expect(t.questionIds.map(String)).toEqual(commit.body.questionIds);
});

test("CSV works too, with commas, quotes and line breaks inside cells", async () => {
  const { admin } = await people();
  const res = await preview(admin, csv([["SUPR", "Algebra", "", 'Solve "x" if $x^2 = 4$, x > 0', "1", "2", "", "", "B", "", "", "Line one\nline two"]]), "paper.csv");
  expect(res.status).toBe(200);
  expect(res.body.rows[0].errors).toEqual([]);
  expect(res.body.rows[0].question).toMatchObject({ prompt: 'Solve "x" if $x^2 = 4$, x > 0', difficulty: "medium", explanation: "Line one\nline two", options: ["1", "2"] });
});

test("problems are reported per row with the reason; broken LaTeX is caught", async () => {
  const { admin } = await people();
  const res = await preview(admin, await xlsx([
    ["SUPR", "Calculus", "medium", "Evaluate $\\frac{1}{$", "1", "2", "3", "4", "A"],
    ["MATHS", "", "medium", "Q", "1", "2", "", "", "C"],
    ["REAP", "Logic", "medium", "Pick one", "only", "", "", "", "A"],
    ["SUPR", "Algebra", "medium", "Cost is $5", "1", "2", "", "", "E"],
    ...good,
  ]), "paper.xlsx");
  const byRow = Object.fromEntries(res.body.rows.map((r) => [r.row, r.errors.join(" | ")]));
  expect(byRow[2]).toMatch(/question: formula .*\\frac/);
  expect(byRow[3]).toMatch(/section must be SUPR or REAP/);
  expect(byRow[3]).toMatch(/topic is empty/);
  expect(byRow[3]).toMatch(/answer "C" isn't one of the filled options \(A, B\)/);
  expect(byRow[4]).toMatch(/needs at least 2 options/);
  expect(byRow[5]).toMatch(/a \$ without its closing \$/);
  expect(byRow[5]).toMatch(/answer "E"/);
  expect(res.body.summary).toMatchObject({ total: 6, ready: 2, withErrors: 4 });
});

test("duplicates and over-full sections are warnings, not errors", async () => {
  const { admin } = await people();
  const target = await createTest({ isFree: true });
  const first = await preview(admin, await xlsx(good), "a.xlsx");
  await admin.post("/api/admin/questions/import/commit", { questions: first.body.rows.map((r) => r.question) });
  const again = await preview(admin, await xlsx([good[0], good[0]]), "a.xlsx", String(target._id));
  expect(again.body.rows[0].warnings).toContain("already in the question bank");
  expect(again.body.rows[1].warnings.join()).toMatch(/same question as row 2/);
  const many = Array.from({ length: 41 }, (_, i) => ["SUPR", "Algebra", "medium", `Question ${i + 1}`, "1", "2", "", "", "A"]);
  const full = await preview(admin, await xlsx(many), "full.xlsx", String(target._id));
  expect(full.body.notes.join()).toMatch(/would have 41 SUPR questions/);
});

test("import is all or nothing and re-checks every question on the server", async () => {
  const { admin } = await people();
  const res = await preview(admin, await xlsx(good), "paper.xlsx");
  const questions = res.body.rows.map((r) => r.question);
  questions[1].prompt = "Tampered $\\frac{";
  const commit = await admin.post("/api/admin/questions/import/commit", { questions });
  expect(commit.status).toBe(400);
  expect(commit.body.problems[0]).toMatchObject({ index: 1 });
  expect(await Question.countDocuments({})).toBe(0);
});

test("only admins; wrong files and oversized sheets are refused", async () => {
  const { admin, student } = await people();
  expect((await preview(student, await xlsx(good), "paper.xlsx")).status).toBe(403);
  expect((await student.post("/api/admin/questions/import/commit", { questions: [{}] })).status).toBe(403);
  expect((await preview(admin, Buffer.from("hello"), "notes.txt")).status).toBe(400);
  expect((await preview(admin, Buffer.from("not a zip"), "paper.xlsx")).status).toBe(400);
  const missing = await preview(admin, Buffer.from("topic,question\nA,B"), "paper.csv");
  expect(missing.status).toBe(400);
  expect(missing.body.error).toMatch(/Missing columns: section/);
  const tooMany = Array.from({ length: 501 }, (_, i) => ["SUPR", "Algebra", "medium", `Q${i}`, "1", "2", "", "", "A"]);
  const big = await preview(admin, csv(tooMany), "big.csv");
  expect(big.status).toBe(400);
  expect(big.body.error).toMatch(/Up to 500 questions/);
});
