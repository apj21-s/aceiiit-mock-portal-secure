// Custom practice: the builder only offers what exists, the chosen time is split between the
// sections that have questions, and a single-section paper never starts in an empty section
// (a REAP-only paper used to be submitted the instant it opened).
const { createApp } = require("../../app");
const Question = require("../../models/Question");
const { splitPracticeMinutes } = require("../../controllers/testController");
const { startDb, clearDb, stopDb } = require("../helpers/db");
const { createUser, createTest, grantEntitlementFor } = require("../helpers/fixtures");
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

const q = (section, topic, difficulty = "medium") => ({
  section, topic, difficulty, prompt: `${section} ${topic}`, options: ["a", "b", "c", "d"], correctOption: 0, marks: 4, negativeMarks: -1,
});

/** A live free test with 4 SUPR (2 "basic physics", 2 "algebra") and 2 REAP ("logic") questions. */
async function setup({ paid = false } = {}) {
  const user = await createUser();
  const questions = await Question.insertMany([
    q("SUPR", "basic physics"), q("SUPR", "Basic Physics", "hard"), q("SUPR", "algebra"), q("SUPR", "algebra"),
    q("REAP", "logic"), q("REAP", "logic", "easy"),
  ]);
  const test = await createTest({ isFree: true, questions });
  if (paid) await grantEntitlementFor(user, test.seasonId);
  const client = await loginClient(app, "student1@test.local");
  return { client, questions };
}

function startExam(client, testId) {
  return client.agent.post("/api/attempt/start").set("X-CSRF-Token", client.csrf).send({ testId });
}

describe("practice builder options", () => {
  test("lists question counts per section and per topic (case-insensitive), filtered by difficulty", async () => {
    const { client } = await setup();
    const all = await client.get("/api/tests/practice/options");
    expect(all.status).toBe(200);
    expect(all.body.total).toBe(6);
    expect(all.body.sections).toEqual({ SUPR: 4, REAP: 2 });
    const physics = all.body.topics.find((t) => t.section === "SUPR" && t.topic.toLowerCase() === "basic physics");
    expect(physics.count).toBe(2);
    const medium = await client.get("/api/tests/practice/options?difficulty=medium");
    expect(medium.body.total).toBe(4);
    expect(medium.body.sections).toEqual({ SUPR: 3, REAP: 1 });
  });
});

describe("practice paper building", () => {
  test("a topic subject matches that exact topic in that section", async () => {
    const { client } = await setup();
    const res = await client.post("/api/tests/practice", { subject: "topic:SUPR:basic physics", count: 10, timerMinutes: 15 });
    expect(res.status).toBe(201);
    expect(res.body.test.questionCount).toBe(2);
    expect(res.body.test.title).toBe("Practice: basic physics");
    expect(res.body.test.sectionDurations).toEqual({ SUPR: 15, REAP: 0 });
  });

  test("the chosen time is split by question count; untimed papers get the cap and say so", async () => {
    const { client } = await setup({ paid: true });
    const timed = await client.post("/api/tests/practice", { subject: "all", count: 6, timerMinutes: 30 });
    expect(timed.body.test.sectionDurations).toEqual({ SUPR: 20, REAP: 10 });
    expect(timed.body.test.durationMinutes).toBe(30);
    expect(timed.body.test.untimed).toBe(false);
    const untimed = await client.post("/api/tests/practice", { subject: "all", count: 6, timerMinutes: 0 });
    expect(untimed.body.test.untimed).toBe(true);
    expect(untimed.body.test.durationMinutes).toBe(300);
    expect(untimed.body.test.subtitle).toBe("6 Questions • Untimed");
  });

  test("splitPracticeMinutes keeps a minute for each present section", () => {
    expect(splitPracticeMinutes(1, { SUPR: 9, REAP: 1 })).toEqual({ SUPR: 1, REAP: 1 });
    expect(splitPracticeMinutes(45, { SUPR: 0, REAP: 4 })).toEqual({ SUPR: 0, REAP: 45 });
    expect(splitPracticeMinutes(15, { SUPR: 29, REAP: 1 })).toEqual({ SUPR: 14, REAP: 1 });
  });

  test("an empty filter explains itself", async () => {
    const { client } = await setup();
    const res = await client.post("/api/tests/practice", { subject: "topic:REAP:geometry", count: 5 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("PRACTICE_EMPTY");
  });

  test("older clients' bare subject words still match inside topic names", async () => {
    const { client } = await setup();
    const res = await client.post("/api/tests/practice", { subject: "Physics", count: 10 });
    expect(res.status).toBe(201);
    expect(res.body.test.questionCount).toBe(2);
  });

  test("the student's practice papers come back with the catalog (and only theirs)", async () => {
    const { client } = await setup();
    const created = await client.post("/api/tests/practice", { subject: "REAP", count: 2, timerMinutes: 15 });
    const catalog = await client.get("/api/tests");
    expect(catalog.body.practiceTests.map((t) => t.id)).toEqual([created.body.test.id]);
    expect(catalog.body.tests.some((t) => t.id === created.body.test.id)).toBe(false);
    await createUser({ email: "student2@test.local", name: "Two" });
    const other = await loginClient(app, "student2@test.local");
    expect((await other.get("/api/tests")).body.practiceTests).toEqual([]);
  });
});

describe("single-section practice sessions", () => {
  test("a REAP-only paper opens in REAP with the whole time, and REAP answers save", async () => {
    const { client, questions } = await setup();
    const created = await client.post("/api/tests/practice", { subject: "REAP", count: 2, timerMinutes: 15 });
    const start = await startExam(client, created.body.test.id);
    expect(start.status).toBe(201);
    const session = start.body.session;
    expect(session.activeSection).toBe("REAP");
    expect(session.durations).toEqual({ SUPR: 0, REAP: 15 * 60 * 1000 });
    const reapDeadline = new Date(session.deadlines.REAP).getTime();
    expect(reapDeadline - new Date(session.startedAt).getTime()).toBe(15 * 60 * 1000);

    const reapId = String(questions[4]._id);
    const save = await client.agent
      .put(`/api/attempt/session/${session.id}/answers`)
      .set("X-CSRF-Token", client.csrf)
      .set("X-Exam-Token", start.body.examToken)
      .send({ seq: 1, answers: { [reapId]: 0 } });
    expect(save.status).toBe(200);
  });

  test("a SUPR-only paper has no REAP time: it ends at the SUPR deadline", async () => {
    const { client } = await setup();
    const created = await client.post("/api/tests/practice", { subject: "SUPR", count: 4, timerMinutes: 20 });
    const start = await startExam(client, created.body.test.id);
    const session = start.body.session;
    expect(session.activeSection).toBe("SUPR");
    expect(session.durations).toEqual({ SUPR: 20 * 60 * 1000, REAP: 0 });
  });
});
