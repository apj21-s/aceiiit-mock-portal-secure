// M2b: seeded shuffling (answers mapped back server-side), integrity telemetry with a
// server-owned violation count, strict-mode auto-submit, and human-only invalidation.
const { createApp } = require("../../app");
const Attempt = require("../../models/Attempt");
const AuditLog = require("../../models/AuditLog");
const IntegrityEvent = require("../../models/IntegrityEvent");
const Question = require("../../models/Question");
const Test = require("../../models/Test");
const { startDb, clearDb, stopDb } = require("../helpers/db");
const { createUser, createQuestions, createTest } = require("../helpers/fixtures");
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

function exam(client, token) {
  const send = (req, body, extra = {}) => {
    let r = req.set("X-CSRF-Token", client.csrf);
    if (token) r = r.set("X-Exam-Token", token);
    Object.entries(extra).forEach(([k, v]) => (r = r.set(k, v)));
    return r.send(body || {});
  };
  return {
    start: (testId) => send(client.agent.post("/api/attempt/start"), { testId: String(testId) }),
    paper: (id) => client.agent.get(`/api/attempt/session/${id}/paper`).set("X-Exam-Token", token || ""),
    save: (id, body) => send(client.agent.put(`/api/attempt/session/${id}/answers`), body),
    events: (id, events) => send(client.agent.post(`/api/attempt/session/${id}/events`), { events }),
    takeover: (id) => send(client.agent.post(`/api/attempt/session/${id}/takeover`), {}),
    submit: (sessionId) => send(client.agent.post("/api/attempt"), { sessionId }, { "Idempotency-Key": `k-${sessionId}` }),
  };
}

async function startOn(testId, email = "student1@test.local") {
  const client = await loginClient(app, email);
  const res = await exam(client).start(testId);
  return { client, token: res.body.examToken, sessionId: res.body.session.id, session: res.body.session };
}

describe("seeded shuffling", () => {
  test("options are shuffled per session and answers are mapped back to the original order", async () => {
    await createUser();
    const questions = await Question.insertMany(
      Array.from({ length: 4 }, (_, i) => ({
        section: "SUPR",
        topic: "t",
        prompt: `Q${i}`,
        options: ["opt-A", "opt-B", "opt-C", "opt-D", "opt-E"],
        correctOption: 3,
        marks: 4,
        negativeMarks: -1,
      }))
    );
    const test = await createTest({ isFree: true, questions });
    await Test.updateOne({ _id: test._id }, { $set: { shuffleOptions: true } });

    const { client, token, sessionId } = await startOn(test._id);
    const paper = await exam(client, token).paper(sessionId);
    expect(paper.status).toBe(200);
    // Every question still has the same option set, but at least one is reordered.
    const reordered = paper.body.questions.some((q) => q.options.join() !== "opt-A,opt-B,opt-C,opt-D,opt-E");
    expect(reordered).toBe(true);
    paper.body.questions.forEach((q) => expect([...q.options].sort()).toEqual(["opt-A", "opt-B", "opt-C", "opt-D", "opt-E"]));

    // Answer each question with the displayed index of the correct text ("opt-D").
    const answers = {};
    paper.body.questions.forEach((q) => (answers[q.id] = q.options.indexOf("opt-D")));
    const saved = await exam(client, token).save(sessionId, { seq: 1, answers });
    expect(saved.status).toBe(200);
    // The session view echoes answers back in the displayed order.
    expect(saved.body.session.answers).toEqual(answers);

    // The paper order is stable for the session (reload-safe).
    const again = await exam(client, token).paper(sessionId);
    expect(again.body.questions.map((q) => q.options.join())).toEqual(paper.body.questions.map((q) => q.options.join()));

    const res = await exam(client, token).submit(sessionId);
    expect(res.status).toBe(201);
    expect(res.body.attempt.score).toBe(16);
    const stored = await Attempt.findById(res.body.attempt.id).lean();
    Object.values(stored.answers).forEach((value) => expect(value).toBe(3));
  });

  test("question order is shuffled within sections; SUPR still comes before REAP", async () => {
    await createUser();
    const supr = Array.from({ length: 8 }, (_, i) => ({ section: "SUPR", topic: "t", prompt: `S${i}`, options: ["a", "b"], correctOption: 0 }));
    const reap = Array.from({ length: 3 }, (_, i) => ({ section: "REAP", topic: "t", prompt: `R${i}`, options: ["a", "b"], correctOption: 0 }));
    const questions = await Question.insertMany([...supr, ...reap]);
    const test = await createTest({ isFree: true, questions });
    await Test.updateOne({ _id: test._id }, { $set: { shuffleQuestions: true } });

    const { client, token, sessionId } = await startOn(test._id);
    const paper = await exam(client, token).paper(sessionId);
    const sections = paper.body.questions.map((q) => q.section);
    expect(sections.slice(0, 8).every((s) => s === "SUPR")).toBe(true);
    expect(sections.slice(8).every((s) => s === "REAP")).toBe(true);
    expect(paper.body.questions.map((q) => q.id).sort()).toEqual(questions.map((q) => String(q._id)).sort());
    const original = questions.slice(0, 8).map((q) => String(q._id)).join();
    expect(paper.body.questions.slice(0, 8).map((q) => q.id).join()).not.toBe(original);
  });
});

describe("integrity telemetry", () => {
  test("events require the exam binding", async () => {
    await createUser();
    const test = await createTest({ isFree: true, questions: await createQuestions() });
    const { client, sessionId } = await startOn(test._id);
    const res = await exam(client).events(sessionId, [{ type: "tab_hidden" }]);
    expect(res.status).toBe(409);
  });

  test("warn mode counts violations server-side, dedupes bursts, and never auto-submits", async () => {
    await createUser();
    const test = await createTest({ isFree: true, questions: await createQuestions() });
    const { client, token, sessionId, session } = await startOn(test._id);
    expect(session.integrity.mode).toBe("warn");

    const first = await exam(client, token).events(sessionId, [
      { type: "tab_hidden", at: new Date().toISOString() },
      { type: "tab_hidden" }, // same burst → not counted twice
      { type: "window_blur" }, // telemetry only
      { type: "context_menu" }, // telemetry only
    ]);
    expect(first.status).toBe(200);
    expect(first.body.integrity.violations).toBe(1);
    expect(first.body.autoSubmitted).toBe(false);

    const second = await exam(client, token).events(sessionId, [{ type: "copy_attempt" }, { type: "paste_attempt" }]);
    expect(second.body.integrity.violations).toBe(3);
    expect(await IntegrityEvent.countDocuments({ sessionId })).toBe(6);

    for (let i = 0; i < 4; i += 1) {
      await exam(client, token).events(sessionId, [{ type: "second_tab" }, { type: "print_attempt" }]);
      await new Promise((r) => setTimeout(r, 2100));
    }
    const status = await exam(client, token).events(sessionId, [{ type: "blocked_shortcut" }]);
    expect(status.body.integrity.violations).toBeGreaterThan(5);
    expect(status.body.autoSubmitted).toBe(false);
    expect(await Attempt.countDocuments({})).toBe(0);
  }, 30000);

  test("unknown event types are rejected", async () => {
    await createUser();
    const test = await createTest({ isFree: true, questions: await createQuestions() });
    const { client, token, sessionId } = await startOn(test._id);
    const res = await exam(client, token).events(sessionId, [{ type: "reset_violations" }]);
    expect(res.status).toBe(400);
  });

  test("strict mode auto-submits saved answers only after the server-counted threshold", async () => {
    await createUser();
    const questions = await createQuestions();
    const test = await createTest({ isFree: true, questions });
    await Test.updateOne({ _id: test._id }, { $set: { integrity: { mode: "strict", warnThreshold: 1, autoSubmitThreshold: 2 } } });
    const { client, token, sessionId } = await startOn(test._id);
    await exam(client, token).save(sessionId, { seq: 1, answers: { [String(questions[0]._id)]: 1 } });

    const one = await exam(client, token).events(sessionId, [{ type: "tab_hidden" }, { type: "copy_attempt" }]);
    expect(one.body.integrity.violations).toBe(2);
    expect(one.body.autoSubmitted).toBe(false);

    const over = await exam(client, token).events(sessionId, [{ type: "paste_attempt" }]);
    expect(over.body.autoSubmitted).toBe(true);
    const attempt = await Attempt.findById(over.body.attemptId).lean();
    expect(attempt.submittedReason).toBe("integrity_threshold");
    expect(attempt.score).toBe(4);
    expect(attempt.integrity.violations).toBe(3);
    // Auto-submit is not disqualification.
    expect(attempt.invalidatedAt).toBeNull();
  });

  test("record mode logs but never warns or auto-submits", async () => {
    await createUser();
    const test = await createTest({ isFree: true, questions: await createQuestions() });
    await Test.updateOne({ _id: test._id }, { $set: { integrity: { mode: "record", warnThreshold: 1, autoSubmitThreshold: 1 } } });
    const { client, token, sessionId } = await startOn(test._id);
    const res = await exam(client, token).events(sessionId, [{ type: "tab_hidden" }, { type: "copy_attempt" }, { type: "paste_attempt" }]);
    expect(res.body.autoSubmitted).toBe(false);
    expect(res.body.integrity.mode).toBe("record");
  });

  test("takeover is recorded as telemetry and audited", async () => {
    await createUser();
    const test = await createTest({ isFree: true, questions: await createQuestions() });
    const { client, sessionId } = await startOn(test._id);
    expect((await exam(client).takeover(sessionId)).status).toBe(200);
    expect(await IntegrityEvent.countDocuments({ sessionId, type: "device_takeover" })).toBe(1);
    expect(await AuditLog.countDocuments({ action: "EXAM_SESSION_TAKEOVER", entityId: sessionId })).toBe(1);
  });
});

describe("human-only invalidation", () => {
  test("admin reviews the timeline and invalidates; the attempt leaves the ranking; audited and reversible", async () => {
    await createUser();
    await createUser({ email: "b@test.local", name: "B" });
    await createUser({ email: "admin@test.local", name: "Admin", role: "admin" });
    const questions = await createQuestions();
    const test = await createTest({ isFree: true, questions });

    const a = await startOn(test._id);
    await exam(a.client, a.token).save(a.sessionId, { seq: 1, answers: { [String(questions[0]._id)]: 1, [String(questions[1]._id)]: 2 } });
    await exam(a.client, a.token).events(a.sessionId, [{ type: "tab_hidden" }, { type: "copy_attempt" }]);
    const attemptA = (await exam(a.client, a.token).submit(a.sessionId)).body.attempt;
    const b = await startOn(test._id, "b@test.local");
    const attemptB = (await exam(b.client, b.token).submit(b.sessionId)).body.attempt;
    expect((await b.client.get(`/api/result/${attemptB.id}`)).body.attempt.rank).toBe(2);

    const admin = await loginClient(app, "admin@test.local");
    const timeline = await admin.get(`/api/admin/attempts/${attemptA.id}/integrity`);
    expect(timeline.status).toBe(200);
    expect(timeline.body.attempt.integrity.violations).toBe(2);
    expect(timeline.body.events.map((e) => e.type)).toEqual(["tab_hidden", "copy_attempt"]);

    expect((await admin.post(`/api/admin/attempts/${attemptA.id}/invalidate`, {})).status).toBe(400);
    const inv = await admin.post(`/api/admin/attempts/${attemptA.id}/invalidate`, { reason: "Copied questions during exam" });
    expect(inv.status).toBe(200);
    expect((await b.client.get(`/api/result/${attemptB.id}`)).body.attempt.rank).toBe(1);
    expect((await a.client.get(`/api/result/${attemptA.id}`)).body.attempt.invalidated).toBe(true);
    expect(await AuditLog.countDocuments({ action: "ATTEMPT_INVALIDATED", entityId: attemptA.id })).toBe(1);

    const flagged = await admin.get(`/api/admin/leaderboard?testId=${test._id}&excludeFlagged=1`);
    expect(flagged.body.leaderboard).toHaveLength(1);

    await admin.post(`/api/admin/attempts/${attemptA.id}/invalidate`, { reason: "Reviewed: false positive", restore: true });
    expect((await b.client.get(`/api/result/${attemptB.id}`)).body.attempt.rank).toBe(2);
  });

  test("students can't invalidate or read integrity timelines", async () => {
    await createUser();
    const test = await createTest({ isFree: true, questions: await createQuestions() });
    const a = await startOn(test._id);
    const attempt = (await exam(a.client, a.token).submit(a.sessionId)).body.attempt;
    expect((await a.client.get(`/api/admin/attempts/${attempt.id}/integrity`)).status).toBe(403);
    expect((await a.client.post(`/api/admin/attempts/${attempt.id}/invalidate`, { reason: "nope nope" })).status).toBe(403);
  });
});
