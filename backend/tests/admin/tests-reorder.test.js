// Studio → Existing Tests: admins set the order students see tests in, in one request.
const { createApp } = require("../../app");
const Test = require("../../models/Test");
const { startDb, clearDb, stopDb } = require("../helpers/db");
const { createUser, createTest } = require("../helpers/fixtures");
const { loginClient } = require("../helpers/session");

let app;
beforeAll(async () => { await startDb(); app = createApp(); });
afterEach(clearDb);
afterAll(stopDb);

async function setup() {
  const a = await createTest({ isFree: true });
  const b = await createTest({ isFree: true });
  const c = await createTest({ isFree: true });
  await Test.updateOne({ _id: a._id }, { $set: { title: "Mock A", displayOrder: 10 } });
  await Test.updateOne({ _id: b._id }, { $set: { title: "Mock B", displayOrder: 20 } });
  await Test.updateOne({ _id: c._id }, { $set: { title: "Mock C", displayOrder: 30 } });
  await createUser({ email: "admin@test.local", role: "admin", name: "Admin" });
  await createUser({ email: "student1@test.local", name: "Student" });
  return {
    ids: [String(a._id), String(b._id), String(c._id)],
    admin: await loginClient(app, "admin@test.local"),
    student: await loginClient(app, "student1@test.local"),
  };
}

const studentOrder = async (student) => (await student.get("/api/tests")).body.tests.map((t) => t.title);

test("admins set the order and students see it straight away", async () => {
  const { ids, admin, student } = await setup();
  expect(await studentOrder(student)).toEqual(["Mock A", "Mock B", "Mock C"]);
  const res = await admin.post("/api/admin/tests/reorder", { ids: [ids[2], ids[0], ids[1]] });
  expect(res.status).toBe(200);
  expect(await studentOrder(student)).toEqual(["Mock C", "Mock A", "Mock B"]);
});

test("tests left out keep their place after the listed ones", async () => {
  const { ids, admin, student } = await setup();
  expect((await admin.post("/api/admin/tests/reorder", { ids: [ids[1]] })).status).toBe(200);
  expect(await studentOrder(student)).toEqual(["Mock B", "Mock A", "Mock C"]);
});

test("students can't reorder; bad lists change nothing", async () => {
  const { ids, admin, student } = await setup();
  expect((await student.post("/api/admin/tests/reorder", { ids: [ids[2], ids[1], ids[0]] })).status).toBe(403);
  expect((await admin.post("/api/admin/tests/reorder", { ids: [ids[0], ids[0]] })).status).toBe(400);
  expect((await admin.post("/api/admin/tests/reorder", { ids: [ids[2], "a".repeat(24)] })).status).toBe(400);
  expect((await admin.post("/api/admin/tests/reorder", { ids: [] })).status).toBe(400);
  await Test.updateOne({ _id: ids[2] }, { $set: { deletedAt: new Date() } });
  expect((await admin.post("/api/admin/tests/reorder", { ids: [ids[2], ids[0]] })).status).toBe(400);
  expect(await studentOrder(student)).toEqual(["Mock A", "Mock B"]);
});
