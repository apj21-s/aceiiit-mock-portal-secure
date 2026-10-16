// Scheduled tests: listed for students with the time they open, can't be started early, and
// open by themselves (the scheduler job, or the first start after the time).
const { createApp } = require("../../app");
const Test = require("../../models/Test");
const { openDueTests } = require("../../services/testScheduler");
const { startDb, clearDb, stopDb } = require("../helpers/db");
const { createUser, createQuestions } = require("../helpers/fixtures");
const { loginClient } = require("../helpers/session");

let app;
beforeAll(async () => { await startDb(); app = createApp(); });
afterEach(clearDb);
afterAll(stopDb);

async function setup() {
  await createUser({ email: "admin@test.local", role: "admin", name: "Admin" });
  await createUser({ email: "student1@test.local", name: "Student" });
  const questions = await createQuestions();
  return { admin: await loginClient(app, "admin@test.local"), student: await loginClient(app, "student1@test.local"), questionIds: questions.map((q) => String(q._id)) };
}

const inMinutes = (m) => new Date(Date.now() + m * 60 * 1000).toISOString();
const start = (client, testId) => client.agent.post("/api/attempt/start").set("X-CSRF-Token", client.csrf).send({ testId });

async function scheduledTest(admin, questionIds, publishAt) {
  const res = await admin.post("/api/tests", { title: "Sunday Mock", isFree: true, status: "scheduled", publishAt, questionIds });
  expect(res.status).toBe(201);
  return res.body.test.id;
}

test("a scheduled test is listed with its opening time and can't be started early", async () => {
  const { admin, student, questionIds } = await setup();
  const when = inMinutes(90);
  const id = await scheduledTest(admin, questionIds, when);
  const listed = (await student.get("/api/tests")).body.tests.find((t) => t.id === id);
  expect(listed).toMatchObject({ status: "scheduled", opensAt: when });
  const early = await start(student, id);
  expect(early.status).toBe(403);
  expect(early.body).toMatchObject({ code: "TEST_NOT_OPEN", opensAt: when });
});

test("it opens by itself when the time comes (scheduler job)", async () => {
  const { admin, student, questionIds } = await setup();
  const id = await scheduledTest(admin, questionIds, inMinutes(60));
  await Test.updateOne({ _id: id }, { $set: { publishAt: new Date(Date.now() - 1000) } });
  expect(await openDueTests()).toBe(1);
  const doc = await Test.findById(id).lean();
  expect(doc).toMatchObject({ status: "live", publishAt: null });
  expect((await student.get("/api/tests")).body.tests.find((t) => t.id === id).status).toBe("live");
  expect((await start(student, id)).status).toBe(201);
});

test("the first start after the time opens it even before the job runs", async () => {
  const { admin, student, questionIds } = await setup();
  const id = await scheduledTest(admin, questionIds, inMinutes(60));
  await Test.updateOne({ _id: id }, { $set: { publishAt: new Date(Date.now() - 1000) } });
  expect((await start(student, id)).status).toBe(201);
  expect((await Test.findById(id).lean()).status).toBe("live");
});

test("scheduling needs a future time; publishing now clears the schedule", async () => {
  const { admin, questionIds } = await setup();
  expect((await admin.post("/api/tests", { title: "No time", status: "scheduled", questionIds })).status).toBe(400);
  expect((await admin.post("/api/tests", { title: "Past time", status: "scheduled", publishAt: inMinutes(-5), questionIds })).status).toBe(400);
  const id = await scheduledTest(admin, questionIds, inMinutes(30));
  const live = await admin.agent.put(`/api/tests/${id}`).set("X-CSRF-Token", admin.csrf).send({ status: "live" });
  expect(live.status).toBe(200);
  expect(await Test.findById(id).lean()).toMatchObject({ status: "live", publishAt: null });
});

test("drafts stay hidden; admins can still start a scheduled test to check it", async () => {
  const { admin, student, questionIds } = await setup();
  const draft = await admin.post("/api/tests", { title: "Hidden draft", status: "draft", questionIds });
  expect((await student.get("/api/tests")).body.tests.some((t) => t.id === draft.body.test.id)).toBe(false);
  const id = await scheduledTest(admin, questionIds, inMinutes(30));
  expect((await start(admin, id)).status).toBe(201);
});
