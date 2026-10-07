// M2: server-authoritative exam sessions: deadlines, section locking, answer validation,
// idempotent submission, server-side expiry/finalization, rank-on-read and practice.
const { createApp } = require("../../app");
const Attempt = require("../../models/Attempt");
const AttemptSession = require("../../models/AttemptSession");
const { sweepOnce } = require("../../services/attemptSweeper");
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

function exam(client, token) {
  const withHeaders = (req, extra = {}) => {
    let r = req.set("X-CSRF-Token", client.csrf);
    if (token) r = r.set("X-Exam-Token", token);
    Object.entries(extra).forEach(([k, v]) => {
      r = r.set(k, v);
    });
    return r;
  };
  return {
    start: (testId) => withHeaders(client.agent.post("/api/attempt/start")).send({ testId }),
    paper: (id) => client.agent.get(`/api/attempt/session/${id}/paper`).set("X-Exam-Token", token || ""),
    save: (id, body) => withHeaders(client.agent.put(`/api/attempt/session/${id}/answers`)).send(body),
    advance: (id, body) => withHeaders(client.agent.post(`/api/attempt/session/${id}/advance`)).send(body || {}),
    takeover: (id) => withHeaders(client.agent.post(`/api/attempt/session/${id}/takeover`)).send({}),
    abandon: (id) => withHeaders(client.agent.post(`/api/attempt/session/${id}/abandon`)).send({}),
    submit: (body, key = `key-${Math.random().toString(36).slice(2, 12)}`) =>
      withHeaders(client.agent.post("/api/attempt"), key ? { "Idempotency-Key": key } : {}).send(body),
  };
}

async function setupFreeTest() {
  const questions = await createQuestions(); // [SUPR q0 (correct 1), SUPR q1 (correct 2), REAP q2 (correct 0)]
  const test = await createTest({ isFree: true, questions });
  return { questions, test, ids: questions.map((q) => String(q._id)) };
}

async function startFor(email, testId) {
  const client = await loginClient(app, email);
  const res = await exam(client).start(String(testId));
  return { client, res, token: res.body.examToken, sessionId: res.body.session && res.body.session.id };
}

async function backdate(sessionId, minutesAgo, extra = {}) {
  await AttemptSession.updateOne(
    { _id: sessionId },
    { $set: { startedAt: new Date(Date.now() - minutesAgo * 60 * 1000), ...extra } }
  );
}

describe("start / resume / takeover (session binding)", () => {
  test("start creates a session and returns a one-time exam token; deadlines come from the server", async () => {
    await createUser();
    const { test } = await setupFreeTest();
    const { res } = await startFor("student1@test.local", test._id);
    expect(res.status).toBe(201);
    expect(res.body.examToken).toMatch(/^[a-f0-9]{64}$/);
    const s = res.body.session;
    expect(s.activeSection).toBe("SUPR");
    expect(new Date(s.deadlines.SUPR).getTime() - new Date(s.startedAt).getTime()).toBe(60 * 60 * 1000);
    const stored = await AttemptSession.findById(s.id);
    expect(stored.examTokenHash).not.toBe(res.body.examToken);
  });

  test("matching token resumes; no binding → 409 and the original keeps working", async () => {
    await createUser();
    const { test, ids } = await setupFreeTest();
    const { client, token, sessionId } = await startFor("student1@test.local", test._id);

    const resume = await exam(client, token).start(String(test._id));
    expect(resume.status).toBe(200);
    expect(resume.body.session.id).toBe(sessionId);
    expect(resume.body.examToken).toBeUndefined();

    const otherTab = await exam(client).start(String(test._id));
    expect(otherTab.status).toBe(409);
    expect(otherTab.body.code).toBe("EXAM_ACTIVE_ELSEWHERE");
    expect(otherTab.body.sessionId).toBe(sessionId);

    const save = await exam(client, token).save(sessionId, { seq: 1, answers: { [ids[0]]: 1 } });
    expect(save.status).toBe(200);
  });

  test("takeover rotates the token: old token → 409; deadline and answers are kept; audited in session", async () => {
    await createUser();
    const { test, ids } = await setupFreeTest();
    const { client, token, sessionId, res } = await startFor("student1@test.local", test._id);
    await exam(client, token).save(sessionId, { seq: 1, answers: { [ids[0]]: 1 } });

    const takeover = await exam(client).takeover(sessionId);
    expect(takeover.status).toBe(200);
    const newToken = takeover.body.examToken;
    expect(newToken).not.toBe(token);
    expect(takeover.body.session.deadlines).toEqual(res.body.session.deadlines);
    expect(takeover.body.session.answers[ids[0]]).toBe(1);

    expect((await exam(client, token).save(sessionId, { seq: 2, answers: { [ids[1]]: 2 } })).status).toBe(409);
    expect((await exam(client, newToken).save(sessionId, { seq: 2, answers: { [ids[1]]: 2 } })).status).toBe(200);
    expect((await AttemptSession.findById(sessionId)).tokenRotatedAt).toBeTruthy();
  });

  test("concurrent starts without a binding create exactly one active session", async () => {
    await createUser();
    const { test } = await setupFreeTest();
    const client = await loginClient(app, "student1@test.local");
    const results = await Promise.all([exam(client).start(String(test._id)), exam(client).start(String(test._id))]);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([201, 409]);
    expect(await AttemptSession.countDocuments({ status: "active" })).toBe(1);
  });

  test("another student can't touch my session", async () => {
    await createUser();
    await createUser({ email: "student2@test.local", name: "Two" });
    const { test, ids } = await setupFreeTest();
    const { token, sessionId } = await startFor("student1@test.local", test._id);
    const intruder = await loginClient(app, "student2@test.local");
    const res = await exam(intruder, token).save(sessionId, { seq: 1, answers: { [ids[0]]: 1 } });
    expect(res.status).toBe(404);
  });

  test("paid test without entitlement can't be started (402); with entitlement it can", async () => {
    const user = await createUser();
    const questions = await createQuestions();
    const paid = await createTest({ isFree: false, questions });
    const denied = await startFor("student1@test.local", paid._id);
    expect(denied.res.status).toBe(402);
    await grantEntitlementFor(user, paid.seasonId);
    const allowed = await startFor("student1@test.local", paid._id);
    expect(allowed.res.status).toBe(201);
  });
});

describe("paper and answer validation", () => {
  test("paper is served only with the exam token and never includes answers", async () => {
    await createUser();
    const { test } = await setupFreeTest();
    const { client, token, sessionId } = await startFor("student1@test.local", test._id);
    expect((await exam(client).paper(sessionId)).status).toBe(409);
    const paper = await exam(client, token).paper(sessionId);
    expect(paper.status).toBe(200);
    expect(paper.body.questions).toHaveLength(3);
    expect(paper.body.questions[0].section).toBe("SUPR");
    paper.body.questions.forEach((q) => {
      expect(q.correctOption).toBeUndefined();
      expect(q.explanation).toBeUndefined();
    });
  });

  test("invalid option, unknown question and not-yet-started REAP are rejected", async () => {
    await createUser();
    const { test, ids } = await setupFreeTest();
    const { client, token, sessionId } = await startFor("student1@test.local", test._id);
    const api = exam(client, token);
    expect((await api.save(sessionId, { seq: 1, answers: { [ids[0]]: 7 } })).body.code).toBe("INVALID_OPTION");
    expect((await api.save(sessionId, { seq: 2, answers: { [ids[0]]: -1 } })).body.code).toBe("INVALID_OPTION");
    expect((await api.save(sessionId, { seq: 3, answers: { ["0".repeat(24)]: 1 } })).body.code).toBe("INVALID_QUESTION");
    const reapEarly = await api.save(sessionId, { seq: 4, answers: { [ids[2]]: 0 } });
    expect(reapEarly.status).toBe(409);
    expect(reapEarly.body.code).toBe("SECTION_NOT_STARTED");
  });

  test("after advancing, SUPR answers are rejected and REAP answers accepted", async () => {
    await createUser();
    const { test, ids } = await setupFreeTest();
    const { client, token, sessionId } = await startFor("student1@test.local", test._id);
    const api = exam(client, token);
    const adv = await api.advance(sessionId, { answers: { [ids[0]]: 1 } });
    expect(adv.status).toBe(200);
    expect(adv.body.session.activeSection).toBe("REAP");
    expect(adv.body.session.answers[ids[0]]).toBe(1);

    const locked = await api.save(sessionId, { seq: 2, answers: { [ids[0]]: 0 } });
    expect(locked.status).toBe(409);
    expect(locked.body.code).toBe("SECTION_LOCKED");
    expect((await api.save(sessionId, { seq: 3, answers: { [ids[2]]: 0 } })).status).toBe(200);
  });

  test("SUPR auto-locks at its server deadline even if the client never advances", async () => {
    await createUser();
    const { test, ids } = await setupFreeTest();
    const { client, token, sessionId } = await startFor("student1@test.local", test._id);
    await backdate(sessionId, 62); // SUPR is 60 min; grace is 1 min
    const res = await exam(client, token).save(sessionId, { seq: 1, answers: { [ids[0]]: 1 } });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("SECTION_LOCKED");
    expect((await exam(client, token).save(sessionId, { seq: 2, answers: { [ids[2]]: 0 } })).status).toBe(200);
  });

  test("out-of-order (stale) autosave batches are ignored", async () => {
    await createUser();
    const { test, ids } = await setupFreeTest();
    const { client, token, sessionId } = await startFor("student1@test.local", test._id);
    const api = exam(client, token);
    await api.save(sessionId, { seq: 5, answers: { [ids[0]]: 1 } });
    const stale = await api.save(sessionId, { seq: 4, answers: { [ids[0]]: 3 } });
    expect(stale.body.stale).toBe(true);
    expect(stale.body.session.answers[ids[0]]).toBe(1);
  });
});

describe("submission", () => {
  test("server scores the server-saved answers; Idempotency-Key is required; duplicates replay", async () => {
    await createUser();
    const { test, ids } = await setupFreeTest();
    const { client, token, sessionId } = await startFor("student1@test.local", test._id);
    const api = exam(client, token);
    await api.save(sessionId, { seq: 1, answers: { [ids[0]]: 1, [ids[1]]: 0 } }); // +4, -1

    expect((await api.submit({ sessionId }, null)).status).toBe(400);

    const first = await api.submit({ sessionId }, "submit-key-0001");
    expect(first.status).toBe(201);
    expect(first.body.attempt.score).toBe(3);
    const replay = await api.submit({ sessionId }, "submit-key-0001");
    expect(replay.status).toBe(201);
    expect(replay.body.attempt.id).toBe(first.body.attempt.id);
    const newKey = await api.submit({ sessionId }, "submit-key-0002");
    expect(newKey.status).toBe(200);
    expect(newKey.body.attempt.id).toBe(first.body.attempt.id);
    expect(await Attempt.countDocuments({})).toBe(1);
  });

  test("final answers in the submit payload are validated like autosave", async () => {
    await createUser();
    const { test, ids } = await setupFreeTest();
    const { client, token, sessionId } = await startFor("student1@test.local", test._id);
    const bad = await exam(client, token).submit({ sessionId, answers: { [ids[0]]: 9 } });
    expect(bad.status).toBe(400);
    expect(await Attempt.countDocuments({})).toBe(0);
  });

  test("client-supplied timing is ignored; duration comes from server timestamps", async () => {
    await createUser();
    const { test } = await setupFreeTest();
    const { client, token, sessionId } = await startFor("student1@test.local", test._id);
    await backdate(sessionId, 10);
    const res = await exam(client, token).submit({ sessionId, timeTakenSeconds: 1 });
    expect(res.status).toBe(201);
    expect(res.body.attempt.timeTakenSeconds).toBeGreaterThanOrEqual(599);
    expect(res.body.attempt.timeTakenSeconds).toBeLessThanOrEqual(605);
  });

  test("a submit after the deadline is rejected; saved answers are finalized instead", async () => {
    await createUser();
    const { test, ids } = await setupFreeTest();
    const { client, token, sessionId } = await startFor("student1@test.local", test._id);
    await exam(client, token).save(sessionId, { seq: 1, answers: { [ids[0]]: 1 } });
    await backdate(sessionId, 200); // 60 + 120 min paper, well past grace
    const late = await exam(client, token).submit({ sessionId, answers: { [ids[1]]: 2 } });
    expect(late.status).toBe(409);
    expect(late.body.code).toBe("EXAM_EXPIRED");
    const attempt = await Attempt.findById(late.body.attemptId);
    expect(attempt.score).toBe(4); // only the saved answer counted
    expect(attempt.submittedReason).toBe("deadline_expired");
    expect(attempt.timeTakenSeconds).toBe(180 * 60);
  });

  test("abandon (quit) submits the saved answers as an attempt", async () => {
    await createUser();
    const { test, ids } = await setupFreeTest();
    const { client, token, sessionId } = await startFor("student1@test.local", test._id);
    await exam(client, token).save(sessionId, { seq: 1, answers: { [ids[0]]: 1 } });
    const res = await exam(client, token).abandon(sessionId);
    expect(res.status).toBe(200);
    expect(res.body.attempt.submittedReason).toBe("abandoned");
    expect(res.body.attempt.score).toBe(4);
  });
});

describe("server-side expiry (no client involvement)", () => {
  test("the sweeper expires an abandoned session at its deadline and finalizes saved answers", async () => {
    await createUser();
    const { test, ids } = await setupFreeTest();
    const { client, token, sessionId } = await startFor("student1@test.local", test._id);
    await exam(client, token).save(sessionId, { seq: 1, answers: { [ids[0]]: 1, [ids[1]]: 2 } });
    // The browser goes away; no further requests.
    await backdate(sessionId, 185);
    const finalized = await sweepOnce();
    expect(finalized).toHaveLength(1);
    const session = await AttemptSession.findById(sessionId);
    expect(session.status).toBe("expired");
    const attempt = await Attempt.findById(session.attemptId);
    expect(attempt.score).toBe(8);
    expect(attempt.submittedReason).toBe("deadline_expired");
    // Running again is a no-op.
    expect(await sweepOnce()).toHaveLength(0);
    expect(await Attempt.countDocuments({})).toBe(1);
  });

  test("sessions still within their deadline are left alone", async () => {
    await createUser();
    const { test } = await setupFreeTest();
    await startFor("student1@test.local", test._id);
    expect(await sweepOnce()).toHaveLength(0);
  });

  test("returning after expiry finds the result and can start a fresh attempt", async () => {
    await createUser();
    const { test } = await setupFreeTest();
    const { client, token, sessionId } = await startFor("student1@test.local", test._id);
    await backdate(sessionId, 200);
    const again = await exam(client, token).start(String(test._id));
    expect(again.status).toBe(201);
    expect(again.body.session.id).not.toBe(sessionId);
    expect(await Attempt.countDocuments({ submittedReason: "deadline_expired" })).toBe(1);
  });
});

describe("rank and percentile on read", () => {
  async function finishWith(email, testId, answers, minutesAgo) {
    const { client, token, sessionId } = await startFor(email, testId);
    if (answers) await exam(client, token).save(sessionId, { seq: 1, answers });
    if (minutesAgo) await backdate(sessionId, minutesAgo);
    const res = await exam(client, token).submit({ sessionId });
    return { client, attemptId: res.body.attempt.id };
  }

  test("ranks update as others submit; ties break on server duration", async () => {
    await createUser({ email: "a@test.local", name: "A" });
    await createUser({ email: "b@test.local", name: "B" });
    await createUser({ email: "c@test.local", name: "C" });
    const { test, ids } = await setupFreeTest();

    const a = await finishWith("a@test.local", test._id, { [ids[0]]: 1 }, 30); // 4 pts, 30 min
    let resA = await a.client.get(`/api/result/${a.attemptId}`);
    expect(resA.body.attempt.rank).toBe(1);
    expect(resA.body.attempt.percentile).toBe(100);

    const b = await finishWith("b@test.local", test._id, { [ids[0]]: 1, [ids[1]]: 2 }, 40); // 8 pts
    resA = await a.client.get(`/api/result/${a.attemptId}`);
    expect(resA.body.attempt.rank).toBe(2);
    expect((await b.client.get(`/api/result/${b.attemptId}`)).body.attempt.rank).toBe(1);

    const c = await finishWith("c@test.local", test._id, { [ids[0]]: 1 }, 20); // 4 pts but faster than A
    expect((await c.client.get(`/api/result/${c.attemptId}`)).body.attempt.rank).toBe(2);
    resA = await a.client.get(`/api/result/${a.attemptId}`);
    expect(resA.body.attempt.rank).toBe(3);
    expect(resA.body.attempt.percentile).toBe(0);
  });
});

describe("custom practice (server-built, server-scored)", () => {
  test("practice is built from accessible questions, scored with negative marking, and unranked", async () => {
    await createUser();
    const { ids } = await setupFreeTest();
    const client = await loginClient(app, "student1@test.local");
    const created = await client.post("/api/tests/practice", { subject: "SUPR", difficulty: "all", count: 5, timerMinutes: 10 });
    expect(created.status).toBe(201);
    expect(created.body.test.questionCount).toBe(2);

    const { token, sessionId } = await (async () => {
      const r = await exam(client).start(created.body.test.id);
      return { token: r.body.examToken, sessionId: r.body.session.id };
    })();
    await exam(client, token).save(sessionId, { seq: 1, answers: { [ids[0]]: 1, [ids[1]]: 0 } });
    const res = await exam(client, token).submit({ sessionId });
    expect(res.status).toBe(201);
    expect(res.body.attempt.score).toBe(3);
    expect(res.body.attempt.isPractice).toBe(true);
    expect(res.body.attempt.rank).toBe(0);
  });

  test("free accounts get one practice paper; it never appears in the catalog", async () => {
    await createUser();
    await setupFreeTest();
    const client = await loginClient(app, "student1@test.local");
    expect((await client.post("/api/tests/practice", { count: 2 })).status).toBe(201);
    const second = await client.post("/api/tests/practice", { count: 2 });
    expect(second.status).toBe(402);
    expect(second.body.code).toBe("PRACTICE_LIMIT");
    const catalog = await client.get("/api/tests");
    expect(catalog.body.tests.every((t) => !t.isPractice)).toBe(true);
  });

  test("another student can't start my practice paper", async () => {
    await createUser();
    await createUser({ email: "student2@test.local", name: "Two" });
    await setupFreeTest();
    const owner = await loginClient(app, "student1@test.local");
    const created = await owner.post("/api/tests/practice", { count: 2 });
    const other = await loginClient(app, "student2@test.local");
    expect((await exam(other).start(created.body.test.id)).status).toBe(404);
  });
});
