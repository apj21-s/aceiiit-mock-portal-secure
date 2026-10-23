// Live mock events: students join within a window after the test opens (everyone still gets the
// full time from their own start), and scores, ranks, analysis and review are held back until
// the results time. Admins always see everything. Also: time-per-question insights.
const { createApp } = require("../../app");
const Test = require("../../models/Test");
const { startDb, clearDb, stopDb } = require("../helpers/db");
const { createUser, createQuestions } = require("../helpers/fixtures");
const { loginClient } = require("../helpers/session");

let app;
beforeAll(async () => { await startDb(); app = createApp(); });
afterEach(clearDb);
afterAll(stopDb);

const inMinutes = (m) => new Date(Date.now() + m * 60000).toISOString();

async function setup() {
  await createUser({ email: "admin@test.local", role: "admin", name: "Admin" });
  await createUser({ email: "s1@test.local", name: "One" });
  await createUser({ email: "s2@test.local", name: "Two" });
  const questions = await createQuestions();
  return {
    admin: await loginClient(app, "admin@test.local"),
    s1: await loginClient(app, "s1@test.local"),
    s2: await loginClient(app, "s2@test.local"),
    questionIds: questions.map((q) => String(q._id)),
  };
}

const base = (questionIds, extra) => ({ title: "Sunday Live Mock", isFree: true, status: "scheduled", publishAt: inMinutes(60), questionIds, sectionDurations: { SUPR: 60, REAP: 120 }, ...extra });

async function start(client, testId, token) {
  const req = client.agent.post("/api/attempt/start").set("X-CSRF-Token", client.csrf);
  if (token) req.set("X-Exam-Token", token);
  return req.send({ testId });
}

async function submit(client, started, answers, timeSpent) {
  const session = started.body.session.id;
  await client.agent.put(`/api/attempt/session/${session}/answers`).set("X-CSRF-Token", client.csrf).set("X-Exam-Token", started.body.examToken).send({ seq: 1, answers, timeSpent });
  return client.agent.post("/api/attempt").set("X-CSRF-Token", client.csrf).set("X-Exam-Token", started.body.examToken).set("Idempotency-Key", `live-${session}`).send({ sessionId: session });
}

/** Opens the event now-ish: started `minutesAgo` ago, results in `resultsIn` minutes. */
async function openEvent(id, minutesAgo, resultsIn) {
  await Test.updateOne({ _id: id }, { $set: { status: "live", publishAt: null, "event.startsAt": new Date(Date.now() - minutesAgo * 60000), "event.resultsAt": new Date(Date.now() + resultsIn * 60000) } });
}

test("event settings are checked: a schedule, a results time, and enough time for everyone", async () => {
  const { admin, questionIds } = await setup();
  expect((await admin.post("/api/tests", base(questionIds, { event: { enabled: true } }))).body.code).toBe("EVENT_RESULTS_REQUIRED");
  expect((await admin.post("/api/tests", base(questionIds, { event: { enabled: true, joinMinutes: 15, resultsAt: inMinutes(60 + 100) } }))).body.code).toBe("EVENT_RESULTS_TOO_EARLY");
  expect((await admin.post("/api/tests", base(questionIds, { status: "draft", publishAt: null, event: { enabled: true, resultsAt: inMinutes(600) } }))).body.code).toBe("EVENT_NEEDS_SCHEDULE");
  expect((await admin.post("/api/tests", base(questionIds, { event: { enabled: true, joinMinutes: 2, resultsAt: inMinutes(600) } }))).status).toBe(400);
  const ok = await admin.post("/api/tests", base(questionIds, { event: { enabled: true, joinMinutes: 20, resultsAt: inMinutes(60 + 20 + 180 + 1) } }));
  expect(ok.status).toBe(201);
  const saved = await Test.findById(ok.body.test.id).lean();
  expect(saved.event).toMatchObject({ enabled: true, joinMinutes: 20 });
  expect(new Date(saved.event.startsAt).toISOString()).toBe(new Date(saved.publishAt).toISOString());
  // Moving the schedule moves the event start; turning the event off clears it.
  const moved = await admin.put(`/api/tests/${ok.body.test.id}`, { publishAt: inMinutes(30) });
  expect(moved.status).toBe(200);
  expect(new Date((await Test.findById(ok.body.test.id).lean()).event.startsAt).getTime()).toBeLessThan(Date.now() + 31 * 60000);
  await admin.put(`/api/tests/${ok.body.test.id}`, { event: { enabled: false } });
  expect((await Test.findById(ok.body.test.id).lean()).event.enabled).toBe(false);
  // The catalog tells students about the event.
  const again = await admin.post("/api/tests", base(questionIds, { event: { enabled: true, resultsAt: inMinutes(600) } }));
  const listed = (await admin.get("/api/tests")).body.tests.find((t) => t.id === again.body.test.id);
  expect(listed.event).toMatchObject({ joinMinutes: 15, resultsAt: expect.any(String), joinClosesAt: expect.any(String) });
});

test("join window: new starts close after it, resuming still works, admins can always start", async () => {
  const { admin, s1, s2, questionIds } = await setup();
  const id = (await admin.post("/api/tests", base(questionIds, { event: { enabled: true, joinMinutes: 15, resultsAt: inMinutes(600) } }))).body.test.id;
  await openEvent(id, 5, 300);
  const first = await start(s1, id);
  expect(first.status).toBe(201);
  await openEvent(id, 20, 300);
  const late = await start(s2, id);
  expect(late.status).toBe(403);
  expect(late.body).toMatchObject({ code: "EVENT_CLOSED", closedAt: expect.any(String), resultsAt: expect.any(String) });
  expect((await start(s1, id, first.body.examToken)).status).toBe(200);
  expect((await start(admin, id)).status).toBe(201);
});

test("results are held until the results time, everywhere but Studio, then shown", async () => {
  const { admin, s1, questionIds } = await setup();
  const id = (await admin.post("/api/tests", base(questionIds, { event: { enabled: true, joinMinutes: 15, resultsAt: inMinutes(600) } }))).body.test.id;
  await openEvent(id, 1, 300);
  const started = await start(s1, id);
  const submitted = await submit(s1, started, { [questionIds[0]]: 1 }, { [questionIds[0]]: 40 });
  expect(submitted.status).toBe(201);
  const pending = submitted.body.attempt;
  expect(pending).toMatchObject({ resultsPending: true, score: null, rank: 0, sectionScores: null, analysis: null });
  const attemptId = pending.id;
  expect((await s1.get("/api/attempts")).body.attempts[0]).toMatchObject({ id: attemptId, resultsPending: true, score: null });
  expect((await s1.get(`/api/result/${attemptId}?includeReview=1`)).body).toEqual({ attempt: expect.objectContaining({ resultsPending: true, score: null }) });
  expect((await s1.get(`/api/analysis/${attemptId}`)).body.code).toBe("RESULTS_HELD");
  expect((await s1.get(`/api/analysis/${attemptId}/questions`)).body.code).toBe("RESULTS_HELD");
  expect((await s1.get(`/api/analysis/${attemptId}/interpretation`)).body.code).toBe("RESULTS_HELD");
  const board = await admin.get(`/api/admin/leaderboard?testId=${id}`);
  expect(board.body.leaderboard[0].score).toEqual(expect.any(Number));
  expect((await admin.get(`/api/result/${attemptId}`)).body.attempt.score).toEqual(expect.any(Number));
  // Results time passes: everything is back.
  await Test.updateOne({ _id: id }, { $set: { "event.resultsAt": new Date(Date.now() - 1000) } });
  const result = (await s1.get(`/api/result/${attemptId}`)).body.attempt;
  expect(result.resultsPending).toBeUndefined();
  expect(result.score).toEqual(expect.any(Number));
  expect(result.rank).toBe(1);
  expect((await s1.get(`/api/analysis/${attemptId}`)).status).toBe(200);
});

test("time insights: per section, slowest questions and a strip in paper order", async () => {
  const { admin, s1, questionIds } = await setup();
  const id = (await admin.post("/api/tests", { title: "Plain Mock", isFree: true, status: "live", questionIds })).body.test.id;
  const started = await start(s1, id);
  // Q1 correct (fixture answer 1), Q2 wrong, Q3 skipped.
  const done = await submit(s1, started, { [questionIds[0]]: 1, [questionIds[1]]: 0 }, { [questionIds[0]]: 30, [questionIds[1]]: 90, [questionIds[2]]: 10 });
  const summary = (await s1.get(`/api/analysis/${done.body.attempt.id}`)).body.summary;
  expect(summary.timeInsights).toMatchObject({
    totalSeconds: 130,
    wrongSeconds: 90,
    wrongTimePct: 69,
    sections: { SUPR: { questions: 2, totalSeconds: 120, avgCorrectSeconds: 30, avgWrongSeconds: 90, wrongTimePct: 75 }, REAP: { questions: 1, totalSeconds: 10 } },
  });
  expect(summary.timeInsights.slowest[0]).toMatchObject({ number: 2, status: "wrong", seconds: 90, section: "SUPR" });
  expect(summary.timeInsights.strip).toEqual([[30, "c", 0], [90, "w", 0], [10, "s", 1]]);
});
