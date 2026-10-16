// Custom practice: the builder only offers what exists (to students without revealing how many
// questions there are), the chosen time is split between the sections that have questions, and
// a single-section paper never starts in an empty section (a REAP-only paper used to be
// submitted the instant it opened).
const { createApp } = require("../../app");
const Question = require("../../models/Question");
const { splitPracticeMinutes, PRACTICE_SIZES } = require("../../controllers/testController");
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
const times = (n, make) => Array.from({ length: n }, (_, i) => make(i));

/**
 * A live free test: SUPR has 5 "basic physics" (one written "Basic Physics", one hard) and 5
 * "algebra"; REAP has 5 "logic" (one easy) and 2 "puzzles" (too few to practise on their own).
 */
async function setup({ paid = false } = {}) {
  const user = await createUser();
  const questions = await Question.insertMany([
    ...times(4, () => q("SUPR", "basic physics")), q("SUPR", "Basic Physics", "hard"),
    ...times(5, () => q("SUPR", "algebra")),
    ...times(4, () => q("REAP", "logic")), q("REAP", "logic", "easy"),
    ...times(2, () => q("REAP", "puzzles")),
  ]);
  const test = await createTest({ isFree: true, questions });
  if (paid) await grantEntitlementFor(user, test.seasonId);
  const client = await loginClient(app, "student1@test.local");
  return { client, questions };
}

/** Exactly 5 SUPR + 5 REAP, so a 10-question paper uses all of them (deterministic split). */
async function setupBalanced() {
  const user = await createUser();
  const questions = await Question.insertMany([...times(5, () => q("SUPR", "algebra")), ...times(5, () => q("REAP", "logic"))]);
  const test = await createTest({ isFree: true, questions });
  await grantEntitlementFor(user, test.seasonId);
  return { client: await loginClient(app, "student1@test.local") };
}

function startExam(client, testId) {
  return client.agent.post("/api/attempt/start").set("X-CSRF-Token", client.csrf).send({ testId });
}

describe("practice builder options", () => {
  test("students get subjects and the largest paper size each can fill, never question counts", async () => {
    const { client } = await setup();
    const res = await client.get("/api/tests/practice/options");
    expect(res.status).toBe(200);
    expect(res.body.sizes).toEqual(PRACTICE_SIZES);
    const byValue = Object.fromEntries(res.body.subjects.map((s) => [s.value, s]));
    expect(byValue.all.maxSize).toBe(15); // 17 questions
    expect(byValue.SUPR.maxSize).toBe(10);
    expect(byValue.REAP.maxSize).toBe(5); // 7 questions
    expect(byValue["topic:SUPR:algebra"].maxSize).toBe(5);
    expect(Object.keys(byValue).filter((v) => /basic physics/i.test(v))).toHaveLength(1); // case-insensitive
    expect(byValue["topic:REAP:puzzles"]).toBeUndefined(); // too thin for the smallest paper
    const raw = JSON.stringify(res.body);
    expect(raw).not.toMatch(/"count"|"total"|"sections"|"topics"/);
    res.body.subjects.forEach((s) => expect(s.label).not.toMatch(/\d/));
  });

  test("filtered by difficulty; a level with too few questions offers nothing", async () => {
    const { client } = await setup();
    const medium = await client.get("/api/tests/practice/options?difficulty=medium");
    expect(medium.body.subjects.find((s) => s.value === "all").maxSize).toBe(15); // 15 medium
    const hard = await client.get("/api/tests/practice/options?difficulty=hard");
    expect(hard.body.subjects).toEqual([]);
  });

  test("admins still see the exact counts", async () => {
    await setup();
    await createUser({ email: "admin@test.local", role: "admin", name: "Admin" });
    const admin = await loginClient(app, "admin@test.local");
    const res = await admin.get("/api/tests/practice/options");
    expect(res.body.total).toBe(17);
    expect(res.body.sections).toEqual({ SUPR: 10, REAP: 7 });
    expect(res.body.subjects.find((s) => s.value === "topic:REAP:puzzles")).toMatchObject({ count: 2, maxSize: 0 });
  });
});

describe("practice paper building", () => {
  test("a topic subject matches that exact topic in that section", async () => {
    const { client } = await setup();
    const res = await client.post("/api/tests/practice", { subject: "topic:SUPR:basic physics", count: 5, timerMinutes: 15 });
    expect(res.status).toBe(201);
    expect(res.body.test.questionCount).toBe(5);
    expect(res.body.test.title).toBe("Practice: basic physics");
    expect(res.body.test.sectionDurations).toEqual({ SUPR: 15, REAP: 0 });
  });

  test("the chosen time is split by question count; untimed papers get the cap and say so", async () => {
    const { client } = await setupBalanced();
    const timed = await client.post("/api/tests/practice", { subject: "all", count: 10, timerMinutes: 30 });
    expect(timed.body.test.sectionDurations).toEqual({ SUPR: 15, REAP: 15 });
    expect(timed.body.test.durationMinutes).toBe(30);
    expect(timed.body.test.untimed).toBe(false);
    const untimed = await client.post("/api/tests/practice", { subject: "all", count: 10, timerMinutes: 0 });
    expect(untimed.body.test.untimed).toBe(true);
    expect(untimed.body.test.durationMinutes).toBe(300);
    expect(untimed.body.test.subtitle).toBe("10 Questions • Untimed");
  });

  test("splitPracticeMinutes keeps a minute for each present section", () => {
    expect(splitPracticeMinutes(1, { SUPR: 9, REAP: 1 })).toEqual({ SUPR: 1, REAP: 1 });
    expect(splitPracticeMinutes(45, { SUPR: 0, REAP: 4 })).toEqual({ SUPR: 0, REAP: 45 });
    expect(splitPracticeMinutes(15, { SUPR: 29, REAP: 1 })).toEqual({ SUPR: 14, REAP: 1 });
  });

  test("students pick a standard size that the subject can fill; refusals don't reveal counts", async () => {
    const { client } = await setup();
    const odd = await client.post("/api/tests/practice", { subject: "all", count: 7 });
    expect(odd.status).toBe(400);
    expect(odd.body.code).toBe("PRACTICE_SIZE");
    const tooBig = await client.post("/api/tests/practice", { subject: "SUPR", count: 15 });
    expect(tooBig.status).toBe(400);
    expect(tooBig.body.code).toBe("PRACTICE_TOO_LARGE");
    expect(tooBig.body.error).not.toMatch(/\d/);
    const thin = await client.post("/api/tests/practice", { subject: "topic:REAP:puzzles", count: 5 });
    expect(thin.status).toBe(400);
    expect(thin.body.code).toBe("PRACTICE_EMPTY");
    expect(thin.body.error).not.toMatch(/\d/);
  });

  test("an empty filter explains itself", async () => {
    const { client } = await setup();
    const res = await client.post("/api/tests/practice", { subject: "topic:REAP:geometry", count: 5 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("PRACTICE_EMPTY");
  });

  test("admins can still build any size from any topic", async () => {
    await setup();
    await createUser({ email: "admin@test.local", role: "admin", name: "Admin" });
    const admin = await loginClient(app, "admin@test.local");
    const res = await admin.post("/api/tests/practice", { subject: "topic:REAP:puzzles", count: 7 });
    expect(res.status).toBe(201);
    expect(res.body.test.questionCount).toBe(2);
  });

  test("older clients' bare subject words still match inside topic names", async () => {
    const { client } = await setup();
    const res = await client.post("/api/tests/practice", { subject: "Physics", count: 5 });
    expect(res.status).toBe(201);
    expect(res.body.test.questionCount).toBe(5);
  });

  test("the student's practice papers come back with the catalog (and only theirs)", async () => {
    const { client } = await setup();
    const created = await client.post("/api/tests/practice", { subject: "REAP", count: 5, timerMinutes: 15 });
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
    const created = await client.post("/api/tests/practice", { subject: "topic:REAP:logic", count: 5, timerMinutes: 15 });
    const start = await startExam(client, created.body.test.id);
    expect(start.status).toBe(201);
    const session = start.body.session;
    expect(session.activeSection).toBe("REAP");
    expect(session.durations).toEqual({ SUPR: 0, REAP: 15 * 60 * 1000 });
    const reapDeadline = new Date(session.deadlines.REAP).getTime();
    expect(reapDeadline - new Date(session.startedAt).getTime()).toBe(15 * 60 * 1000);

    const reapId = String(questions.find((x) => x.topic === "logic")._id);
    const save = await client.agent
      .put(`/api/attempt/session/${session.id}/answers`)
      .set("X-CSRF-Token", client.csrf)
      .set("X-Exam-Token", start.body.examToken)
      .send({ seq: 1, answers: { [reapId]: 0 } });
    expect(save.status).toBe(200);
  });

  test("a SUPR-only paper has no REAP time: it ends at the SUPR deadline", async () => {
    const { client } = await setup();
    const created = await client.post("/api/tests/practice", { subject: "SUPR", count: 10, timerMinutes: 20 });
    const start = await startExam(client, created.body.test.id);
    const session = start.body.session;
    expect(session.activeSection).toBe("SUPR");
    expect(session.durations).toEqual({ SUPR: 20 * 60 * 1000, REAP: 0 });
  });
});
