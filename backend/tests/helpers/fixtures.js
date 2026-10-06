const bcrypt = require("bcryptjs");

const Entitlement = require("../../models/Entitlement");
const Question = require("../../models/Question");
const Test = require("../../models/Test");
const User = require("../../models/User");
const { getActiveSeason } = require("../../services/seasonService");

const DEFAULT_PASSWORD = "Passw0rd!long";

async function createUser(overrides = {}) {
  const passwordHash = await bcrypt.hash(overrides.password || DEFAULT_PASSWORD, 4);
  const doc = {
    name: "Student One",
    email: "student1@test.local",
    role: "student",
    status: "active",
    isActivated: true,
    emailVerified: true,
    passwordHash,
    ...overrides,
  };
  delete doc.password;
  return User.create(doc);
}

async function createQuestions() {
  return Question.insertMany([
    { section: "SUPR", topic: "patterns", difficulty: "easy", prompt: "Q1", options: ["a", "b", "c", "d"], correctOption: 1, marks: 4, negativeMarks: -1 },
    { section: "SUPR", topic: "logic", difficulty: "medium", prompt: "Q2", options: ["a", "b", "c", "d"], correctOption: 2, marks: 4, negativeMarks: -1 },
    { section: "REAP", topic: "comprehension", difficulty: "hard", prompt: "Q3", options: ["a", "b", "c", "d"], correctOption: 0, marks: 4, negativeMarks: -1 },
  ]);
}

async function createTest({ isFree = true, status = "live", questions, seasonId } = {}) {
  const season = seasonId ? { _id: seasonId } : await getActiveSeason();
  return Test.create({
    title: isFree ? "Free Mock" : "Paid Mock",
    isFree,
    status,
    seasonId: season._id,
    sectionDurations: { SUPR: 60, REAP: 120 },
    durationMinutes: 180,
    questionIds: (questions || []).map((q) => q._id),
  });
}

async function grantEntitlementFor(user, seasonId, status = "active") {
  return Entitlement.create({
    userId: user._id,
    email: user.email,
    normalizedEmail: user.email.toLowerCase(),
    seasonId,
    tier: "paid",
    status,
    source: "admin",
  });
}

async function loginAs(request, app, email, password = DEFAULT_PASSWORD) {
  const res = await request(app).post("/api/auth/login").send({ email, password });
  if (res.status !== 200) {
    throw new Error(`login failed for ${email}: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.token;
}

module.exports = { DEFAULT_PASSWORD, createUser, createQuestions, createTest, grantEntitlementFor, loginAs };
