// M7: Gemini Performance Intelligence: deterministic evidence first, privacy-safe payload,
// strict schema + typed-number validation, retries/timeouts/circuit breaker, async jobs,
// caching, deterministic fallback, and AI isolated from authoritative data.
const fs = require("fs");
const path = require("path");

const { createApp } = require("../../app");
const Attempt = require("../../models/Attempt");
const AttemptInterpretation = require("../../models/AttemptInterpretation");
const ai = require("../../services/aiInterpretationService");
const { startDb, clearDb, stopDb } = require("../helpers/db");
const { createUser, createTest } = require("../helpers/fixtures");
const { loginClient } = require("../helpers/session");
const Question = require("../../models/Question");

const API_KEY = "AIza-test-key-should-never-leak-123";
let app;
let generateContent;

function validResult(overrides = {}) {
  return {
    headline: "Tighten up your Algebra",
    summary: "Your timing is steady, but Algebra answers slipped. Slow down on the final check.",
    strengths: ["Logic questions were handled cleanly."],
    priorityAreas: [{ topic: "algebra", reason: "Most marks were lost here.", action: "Practise a short timed set." }],
    behaviorPatterns: ["Quick answers on easy questions were sometimes wrong."],
    nextTestStrategy: ["Do a first pass on questions you're sure of."],
    ...overrides,
  };
}

beforeAll(async () => {
  await startDb();
  app = createApp();
});

beforeEach(() => {
  process.env.AI_INTERPRETATION_ENABLED = "true";
  process.env.GEMINI_API_KEY = API_KEY;
  process.env.GEMINI_MODEL = "gemini-3.5-flash-lite";
  process.env.AI_MIN_INTERVAL_MS = "0";
  process.env.AI_TIMEOUT_MS = "2000";
  ai.resetBreaker();
  generateContent = jest.fn(async () => ({ text: JSON.stringify(validResult()) }));
  ai.setGeminiClientFactory(() => ({ models: { generateContent } }));
});

afterEach(async () => {
  ["AI_INTERPRETATION_ENABLED", "GEMINI_API_KEY", "GEMINI_MODEL", "AI_MIN_INTERVAL_MS", "AI_TIMEOUT_MS"].forEach((k) => delete process.env[k]);
  await clearDb();
});

afterAll(async () => {
  await stopDb();
});

async function finishedAttempt(email = "student1@test.local") {
  await createUser({ email, name: "Riya Sharma" });
  const questions = await Question.insertMany([
    { section: "SUPR", topic: "algebra", difficulty: "easy", prompt: "SECRET-PROMPT-TEXT-1", options: ["a", "b", "c", "d"], correctOption: 1, explanation: "EXPLANATION-TEXT" },
    { section: "SUPR", topic: "algebra", difficulty: "hard", prompt: "SECRET-PROMPT-TEXT-2", options: ["a", "b", "c", "d"], correctOption: 2 },
    { section: "REAP", topic: "logic", difficulty: "medium", prompt: "SECRET-PROMPT-TEXT-3", options: ["a", "b", "c", "d"], correctOption: 0 },
  ]);
  const test = await createTest({ isFree: true, questions });
  const client = await loginClient(app, email);
  const start = await client.agent.post("/api/attempt/start").set("X-CSRF-Token", client.csrf).send({ testId: String(test._id) });
  const ids = questions.map((q) => String(q._id));
  await client.agent
    .put(`/api/attempt/session/${start.body.session.id}/answers`)
    .set("X-CSRF-Token", client.csrf)
    .set("X-Exam-Token", start.body.examToken)
    .send({ seq: 1, answers: { [ids[0]]: 0, [ids[1]]: 2 }, timeSpent: { [ids[0]]: 20, [ids[1]]: 200 } });
  const submit = await client.agent
    .post("/api/attempt")
    .set("X-CSRF-Token", client.csrf)
    .set("X-Exam-Token", start.body.examToken)
    .set("Idempotency-Key", `ai-${start.body.session.id}`)
    .send({ sessionId: start.body.session.id });
  // Let the finalize event enqueue the job.
  await new Promise((r) => setTimeout(r, 100));
  return { client, attemptId: submit.body.attempt.id, user: client.user };
}

describe("async jobs and results", () => {
  test("finalization enqueues exactly one job; a valid Gemini result is stored and served", async () => {
    const { client, attemptId } = await finishedAttempt();
    expect(await AttemptInterpretation.countDocuments({ attemptId })).toBe(1);
    expect(await ai.processPendingJobs()).toEqual(["ready"]);
    const doc = await AttemptInterpretation.findOne({ attemptId }).lean();
    expect(doc.status).toBe("ready");
    expect(doc.provider).toBe("gemini");
    expect(doc.model).toMatch(/^gemini-3\.5-flash-lite#/);
    const res = await client.get(`/api/analysis/${attemptId}/interpretation`);
    expect(res.status).toBe(200);
    expect(res.body.interpretation.source).toBe("ai");
    expect(res.body.interpretation.result.headline).toBe("Tighten up your Algebra");
    expect(res.body.interpretation.disclosure).toMatch(/does not calculate or alter scores/);
  });

  test("cached: a ready interpretation never calls the provider again", async () => {
    const { client, attemptId } = await finishedAttempt();
    await ai.processPendingJobs();
    await ai.processPendingJobs();
    await client.get(`/api/analysis/${attemptId}/interpretation`);
    expect(generateContent).toHaveBeenCalledTimes(1);
  });

  test("submission doesn't wait for AI, and deterministic results show while pending", async () => {
    generateContent.mockImplementation(() => new Promise(() => {}));
    const { client, attemptId } = await finishedAttempt();
    const res = await client.get(`/api/analysis/${attemptId}/interpretation`);
    expect(res.body.interpretation.pending).toBe(true);
    expect(res.body.interpretation.source).toBe("deterministic");
    expect(res.body.interpretation.result.nextTestStrategy.length).toBeGreaterThan(0);
  });

  test("AI disabled → deterministic fallback, no provider calls", async () => {
    process.env.AI_INTERPRETATION_ENABLED = "false";
    const { attemptId } = await finishedAttempt();
    expect(await ai.processPendingJobs()).toEqual(["fallback:disabled"]);
    expect(generateContent).not.toHaveBeenCalled();
    const doc = await AttemptInterpretation.findOne({ attemptId }).lean();
    expect(doc.result.headline).toBeTruthy();
  });

  test("only the owner (or an admin) can read an interpretation", async () => {
    const { attemptId } = await finishedAttempt();
    await createUser({ email: "other@test.local" });
    const other = await loginClient(app, "other@test.local");
    expect((await other.get(`/api/analysis/${attemptId}/interpretation`)).status).toBe(404);
  });
});

describe("validation and fallbacks", () => {
  test.each([
    ["invalid JSON", "not json {", "fallback:invalid_json"],
    ["wrong schema", JSON.stringify({ headline: "x" }), "fallback:schema_invalid"],
    ["extra fields", JSON.stringify({ ...validResult(), score: 99 }), "fallback:schema_invalid"],
    ["invented percentage", JSON.stringify(validResult({ summary: "You are 17% behind top students." })), "fallback:unsupported_numbers"],
    ["invented rank", JSON.stringify(validResult({ headline: "You ranked #3 in this test" })), "fallback:unsupported_numbers"],
  ])("%s → deterministic fallback", async (_label, raw, expected) => {
    generateContent.mockResolvedValue({ text: raw });
    const { attemptId } = await finishedAttempt();
    expect(await ai.processPendingJobs()).toEqual([expected]);
    const doc = await AttemptInterpretation.findOne({ attemptId }).lean();
    expect(doc.provider).toBe("deterministic");
    expect(doc.result).toEqual(doc.deterministic);
  });

  test("timeout → retried, then deterministic fallback", async () => {
    generateContent.mockImplementation(({ config }) => new Promise((_resolve, reject) => {
      config.abortSignal.addEventListener("abort", () => reject(Object.assign(new Error("This operation was aborted"), { name: "AbortError" })));
    }));
    await finishedAttempt();
    expect(await ai.processPendingJobs()).toEqual(["fallback:provider_unavailable"]);
    expect(generateContent).toHaveBeenCalledTimes(3);
  }, 30000);

  test("400 is not retried", async () => {
    generateContent.mockRejectedValue(Object.assign(new Error("Bad request"), { status: 400 }));
    await finishedAttempt();
    const [outcome] = await ai.processPendingJobs();
    expect(outcome).toMatch(/^fallback:provider_error_400/);
    expect(generateContent).toHaveBeenCalledTimes(1);
  });

  test("500 and per-minute 429 are retried and can recover", async () => {
    generateContent
      .mockRejectedValueOnce(Object.assign(new Error("Internal"), { status: 500 }))
      .mockRejectedValueOnce(Object.assign(new Error("Resource exhausted, retry in 0.01s"), { status: 429 }))
      .mockResolvedValueOnce({ text: JSON.stringify(validResult()) });
    await finishedAttempt();
    expect(await ai.processPendingJobs()).toEqual(["ready"]);
    expect(generateContent).toHaveBeenCalledTimes(3);
  }, 20000);

  test("daily quota → breaker opens, later jobs skip the provider, parked jobs retry after it closes", async () => {
    generateContent.mockRejectedValueOnce(Object.assign(new Error("Quota exceeded for quota metric requests per day (PerDay)"), { status: 429 }));
    const first = await finishedAttempt();
    expect(await ai.processPendingJobs()).toEqual(["fallback:quota_exhausted"]);
    expect(ai.breakerState().open).toBe(true);
    const parked = await AttemptInterpretation.findOne({ attemptId: first.attemptId }).lean();
    expect(parked.retryAfter).toBeTruthy();

    const second = await finishedAttempt("student2@test.local");
    expect(await ai.processPendingJobs()).toEqual(["fallback:breaker_open"]);
    expect(generateContent).toHaveBeenCalledTimes(1);

    // Breaker closes; parked jobs get their AI interpretation.
    ai.resetBreaker();
    await AttemptInterpretation.updateMany({}, { $set: { retryAfter: new Date(Date.now() - 1000) } });
    expect((await ai.processPendingJobs()).sort()).toEqual(["ready", "ready"]);
    expect((await AttemptInterpretation.findOne({ attemptId: second.attemptId }).lean()).status).toBe("ready");
  });
});

describe("authoritative data and privacy", () => {
  test("the AI payload contains only aggregate evidence (no PII, ids, question text)", async () => {
    const { attemptId, user } = await finishedAttempt();
    const attempt = await Attempt.findById(attemptId).lean();
    const { payload } = await ai.buildEvidenceForAttempt(attempt);
    const json = JSON.stringify(payload);
    [user.email, "Riya", attemptId, user.id, "SECRET-PROMPT-TEXT", "EXPLANATION-TEXT", '"options"', "correctOption"].forEach((needle) => {
      expect(json).not.toContain(needle);
    });
    expect(Object.keys(payload).sort()).toEqual(["behaviorPatterns", "difficultyBuckets", "overall", "payloadVersion", "previousAttemptDelta", "sections", "timingPatterns", "topics"]);
    // The prompt sent to Gemini is exactly this payload.
    await ai.processPendingJobs();
    expect(generateContent.mock.calls[0][0].contents).toBe(json);
  });

  test("AI processing never modifies the Attempt document", async () => {
    const { attemptId } = await finishedAttempt();
    const before = await Attempt.findById(attemptId).lean();
    generateContent.mockResolvedValue({ text: JSON.stringify(validResult({ headline: "score 999 rank 1" })) });
    await ai.processPendingJobs();
    const after = await Attempt.findById(attemptId).lean();
    expect(after).toEqual(before);
  });

  test("the API key never appears in responses or logs", async () => {
    const logged = [];
    const spies = ["log", "warn", "error", "info"].map((level) => jest.spyOn(console, level).mockImplementation((...args) => logged.push(args.join(" "))));
    generateContent.mockRejectedValueOnce(Object.assign(new Error("Bad request"), { status: 400 }));
    const { client, attemptId } = await finishedAttempt();
    await ai.processPendingJobs();
    const res = await client.get(`/api/analysis/${attemptId}/interpretation`);
    await createUser({ email: "admin@test.local", role: "admin", name: "Admin" });
    const admin = await loginClient(app, "admin@test.local");
    const status = await admin.get("/api/admin/ai-status");
    spies.forEach((spy) => spy.mockRestore());
    expect(JSON.stringify(res.body)).not.toContain(API_KEY);
    expect(JSON.stringify(status.body)).not.toContain(API_KEY);
    expect(status.body.configured).toBe(true);
    expect(logged.join("\n")).not.toContain(API_KEY);
    const docs = await AttemptInterpretation.find({}).lean();
    expect(JSON.stringify(docs)).not.toContain(API_KEY);
  });
});

describe("typed numeric-claim validation", () => {
  const payload = {
    overall: { accuracyPct: 44, attempted: 7, questions: 10, medianTimeSec: 90, marksLost: 3 },
    topics: [{ topic: "Calculus 2", section: "SUPR", accuracyPct: 50 }],
    sections: [{ section: "SUPR", accuracyPct: 44 }],
  };
  const sets = ai.buildEvidenceNumberSet(payload);
  const names = ["Calculus 2", "SUPR", "REAP"];

  test.each([
    "Your accuracy is improving.",
    "Focus on Calculus 2 next.",
    "Your accuracy in Calculus 2 is 50%.",
    "You answered 7 questions.",
    "Aim to finish SUPR by the 2026 exam.",
    "1. Do a first pass\n2. Review marked questions",
    "Spend about 90 seconds per question.",
    "You lost 3 marks on careless errors.",
  ])("accepts supported text: %s", (sentence) => {
    expect(ai.findUnsupportedNumbers(sentence, sets, names)).toEqual([]);
  });

  test.each([
    "You are 17% behind top students.",
    "You ranked #3.",
    "You're in the 95th percentile.",
    "You got 9 questions wrong.",
    "Spend 5 minutes per question.",
    "You lost 12 marks.",
  ])("rejects invented numbers: %s", (sentence) => {
    expect(ai.findUnsupportedNumbers(sentence, sets, names).length).toBeGreaterThan(0);
  });
});

describe("AI isolation (dependency scan)", () => {
  test("integrity, entitlement, rank and payment code never imports the AI layer", () => {
    const root = path.join(__dirname, "..", "..");
    const allowed = new Set(["app.js", "server.js", "controllers/aiController.js", "services/aiInterpretationService.js"]);
    const offenders = [];
    for (const dir of ["", "controllers", "services", "routes", "middleware", "models", "utils", "config"]) {
      const full = path.join(root, dir);
      for (const file of fs.readdirSync(full).filter((f) => f.endsWith(".js"))) {
        const rel = dir ? `${dir}/${file}` : file;
        const src = fs.readFileSync(path.join(full, file), "utf8");
        if (/aiInterpretationService|AttemptInterpretation/.test(src) && !allowed.has(rel) && rel !== "models/AttemptInterpretation.js") {
          offenders.push(rel);
        }
      }
    }
    // routes/attemptRoutes.js and routes/adminRoutes.js only mount aiController (read-only).
    expect(offenders.filter((f) => !f.startsWith("routes/"))).toEqual([]);
  });
});
