// Ask Mentor about one question: owner-only access, respects paid lock, no IDs in the prompt,
// and .strict validation refuses junk.
process.env.MENTOR_SENDS_PER_MINUTE = "1000";
const { createApp } = require("../../app");
const ai = require("../../services/aiInterpretationService");
const Entitlement = require("../../models/Entitlement");
const Question = require("../../models/Question");
const { getActiveSeason } = require("../../services/seasonService");
const { clearMentorSettingsCache } = require("../../services/mentorSettingsService");
const { clearSiteCustomerCache } = require("../../services/siteCustomerService");
const { _testing } = require("../../services/mentorService");
const { startDb, clearDb, stopDb } = require("../helpers/db");
const { createUser, createTest } = require("../helpers/fixtures");
const { loginClient } = require("../helpers/session");

const KEY = "AIza-mentor-test-key-never-shown-0001";
let app;
let generateContent;
let seq = 0;
const cid = () => `qc-${Date.now().toString(36)}-${(seq += 1)}`;

beforeAll(async () => {
  await startDb();
  app = createApp();
});

beforeEach(() => {
  process.env.GEMINI_API_KEY = KEY;
  process.env.GEMINI_MODEL = "gemini-test-model";
  process.env.AI_TIMEOUT_MS = "2000";
  ai.resetBreaker();
  clearMentorSettingsCache();
  clearSiteCustomerCache();
  _testing.resetInFlight();
  generateContent = jest.fn(async () => ({ text: "Here is why your answer was incorrect." }));
  ai.setGeminiClientFactory(() => ({ models: { generateContent } }));
});

afterEach(async () => {
  ["GEMINI_API_KEY", "GEMINI_MODEL", "AI_TIMEOUT_MS"].forEach((k) => delete process.env[k]);
  await clearDb();
});

afterAll(async () => {
  await stopDb();
});

async function student(email = "student@test.local", name = "Student One") {
  await createUser({ email, name });
  return loginClient(app, email);
}

async function createQuestionsAndTest({ isFree = true } = {}) {
  const questions = await Question.insertMany([
    { section: "SUPR", topic: "algebra", difficulty: "easy", prompt: "Solve 2x = 4", options: ["1", "2", "3", "4"], correctOption: 1 },
    { section: "SUPR", topic: "algebra", difficulty: "hard", prompt: "Solve x^2 = 9", options: ["1", "2", "3", "4"], correctOption: 2, explanation: "x is +3 or -3" },
    { section: "REAP", topic: "logic", difficulty: "medium", prompt: "Odd one out", options: ["a", "b", "c", "d"], correctOption: 0 },
  ]);
  const test = await createTest({ isFree, questions });
  return { questions, test };
}

async function submittedAttempt(client, test, questions) {
  const start = await client.agent.post("/api/attempt/start").set("X-CSRF-Token", client.csrf).send({ testId: String(test._id) });
  const ids = questions.map((q) => String(q._id));
  await client.agent.put(`/api/attempt/session/${start.body.session.id}/answers`)
    .set("X-CSRF-Token", client.csrf)
    .set("X-Exam-Token", start.body.examToken)
    .send({ seq: 1, answers: { [ids[0]]: 1, [ids[1]]: 0 }, timeSpent: { [ids[0]]: 30, [ids[1]]: 200 } });
  const submit = await client.agent.post("/api/attempt")
    .set("X-CSRF-Token", client.csrf)
    .set("X-Exam-Token", start.body.examToken)
    .set("Idempotency-Key", `qc-${start.body.session.id}`)
    .send({ sessionId: start.body.session.id });
  expect(submit.status).toBe(201);
  return submit.body.attempt.id;
}

describe("mentor/question-context", () => {
  test("owner-only: cannot start a conversation on another student's attempt, question must belong to attempt", async () => {
    const { questions, test } = await createQuestionsAndTest({ isFree: true });
    const s1 = await student("s1@test.local", "Student 1");
    const s2 = await student("s2@test.local", "Student 2");
    const attemptId = await submittedAttempt(s1, test, questions);
    const q0 = String(questions[0]._id);
    const fakeId = "a".repeat(24);

    // Another student cannot access s1's attempt
    const otherRes = await s2.post("/api/mentor/conversations", { attemptId, questionId: q0 });
    expect(otherRes.status).toBe(404);

    // Question not in attempt
    const wrongQRes = await s1.post("/api/mentor/conversations", { attemptId, questionId: fakeId });
    expect(wrongQRes.status).toBe(404);

    // Question without attemptId is rejected
    const noAttemptRes = await s1.post("/api/mentor/conversations", { questionId: q0 });
    expect(noAttemptRes.status).toBe(400);
  });

  test(".strict still refuses junk in createConversation", async () => {
    const { questions, test } = await createQuestionsAndTest({ isFree: true });
    const s1 = await student("s1@test.local", "Student 1");
    const attemptId = await submittedAttempt(s1, test, questions);
    const q0 = String(questions[0]._id);

    // Extra unknown property triggers zod .strict() error
    const junkRes = await s1.post("/api/mentor/conversations", { attemptId, questionId: q0, prompt: "junk", extraField: 123 });
    expect(junkRes.status).toBe(400);

    // Invalid ObjectId format is refused
    const invalidIdRes = await s1.post("/api/mentor/conversations", { attemptId: "not-an-id", questionId: q0 });
    expect(invalidIdRes.status).toBe(400);
  });

  test("no ids in the prompt: sends question, student's choice and answer without ids or personal info", async () => {
    const { questions, test } = await createQuestionsAndTest({ isFree: true });
    const s1 = await student("riya@test.local", "Riya Sharma");
    const attemptId = await submittedAttempt(s1, test, questions);
    const q1 = String(questions[1]._id);

    const created = await s1.post("/api/mentor/conversations", { attemptId, questionId: q1 });
    expect(created.status).toBe(201);
    expect(created.body.conversation.question).toEqual({ label: "Q2 · algebra" });
    expect(created.body.conversation.title).toMatch(/^Q2 · algebra/);

    // Calling again returns the existing empty conversation
    const reused = await s1.post("/api/mentor/conversations", { attemptId, questionId: q1 });
    expect(reused.body.conversation.id).toBe(created.body.conversation.id);

    // Send a message
    const msgRes = await s1.post(`/api/mentor/conversations/${created.body.conversation.id}/messages`, {
      content: "Why is option A wrong for this question?",
      clientMessageId: cid(),
    });
    expect(msgRes.status).toBe(201);

    expect(generateContent).toHaveBeenCalledTimes(1);
    const sent = JSON.stringify(generateContent.mock.calls[0][0].contents);
    expect(sent).toMatch(/Solve x\^2 = 9/);
    expect(sent).toMatch(/\\"chosen\\":\\"A\\"/);
    expect(sent).toMatch(/\\"correct\\":\\"C\\"/);
    expect(sent).toMatch(/x is \+3 or -3/);
    // Crucially: no internal database IDs or student personal details
    expect(sent).not.toMatch(new RegExp(q1));
    expect(sent).not.toMatch(new RegExp(attemptId));
    expect(sent).not.toMatch(/riya@test\.local|Riya Sharma/);
  });

  test("the paid lock respected: question details withheld when access has ended", async () => {
    const { questions, test } = await createQuestionsAndTest({ isFree: false });
    const s1 = await student("paiduser@test.local", "Paid Student");
    const season = await getActiveSeason();

    // First, grant entitlement so user can start and submit the attempt
    const ent = await Entitlement.create({
      seasonId: season._id,
      email: "paiduser@test.local",
      normalizedEmail: "paiduser@test.local",
      tier: "paid",
      status: "active",
      source: "payment",
      grantedAt: new Date(),
    });

    const attemptId = await submittedAttempt(s1, test, questions);
    const q1 = String(questions[1]._id);

    // Create the conversation while still entitled
    const created = await s1.post("/api/mentor/conversations", { attemptId, questionId: q1 });
    expect(created.status).toBe(201);

    // Now revoke or deactivate the entitlement (access ended)
    await Entitlement.updateOne({ _id: ent._id }, { $set: { status: "revoked", revokedAt: new Date() } });

    // Send a question message to mentor
    const msgRes = await s1.post(`/api/mentor/conversations/${created.body.conversation.id}/messages`, {
      content: "Please explain this question to me.",
      clientMessageId: cid(),
    });
    expect(msgRes.status).toBe(201);

    expect(generateContent).toHaveBeenCalledTimes(1);
    const sent = JSON.stringify(generateContent.mock.calls[0][0].contents);
    // Question text and options are NOT sent because paid lock is respected
    expect(sent).not.toMatch(/Solve x\^2 = 9/);
    expect(sent).toMatch(/Question details are locked: the student's Pro Test Series access has ended\./);
  });
});
