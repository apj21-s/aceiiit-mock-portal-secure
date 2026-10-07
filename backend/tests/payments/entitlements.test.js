// M3: Entitlement is the only authority for paid access; commerce provisions over an
// authenticated, validated, idempotent internal API; admins add/verify payments manually.
const request = require("supertest");

const { createApp } = require("../../app");
const AuditLog = require("../../models/AuditLog");
const Entitlement = require("../../models/Entitlement");
const PaymentRecord = require("../../models/PaymentRecord");
const Season = require("../../models/Season");
const User = require("../../models/User");
const { startDb, clearDb, stopDb } = require("../helpers/db");
const { createUser, createQuestions, createTest, grantEntitlementFor } = require("../helpers/fixtures");
const { loginClient } = require("../helpers/session");

const SECRET = "internal-secret-for-tests-0123456789abcdef";
let app;

beforeAll(async () => {
  await startDb();
  app = createApp();
});

beforeEach(() => {
  process.env.INTERNAL_API_SECRET = SECRET;
});

afterEach(async () => {
  delete process.env.INTERNAL_API_SECRET;
  await clearDb();
});

afterAll(async () => {
  await stopDb();
});

async function startStatus(client, testId) {
  const res = await client.agent.post("/api/attempt/start").set("X-CSRF-Token", client.csrf).send({ testId: String(testId) });
  return res.status;
}

describe("entitlement access matrix (test detail + exam start)", () => {
  test("free test → allowed", async () => {
    await createUser();
    const test = await createTest({ isFree: true, questions: await createQuestions() });
    const client = await loginClient(app, "student1@test.local");
    expect((await client.get(`/api/tests/${test._id}`)).status).toBe(200);
    expect(await startStatus(client, test._id)).toBe(201);
  });

  test("paid test without entitlement → 402, even with User.isPaid set", async () => {
    await createUser({ isPaid: true });
    const test = await createTest({ isFree: false, questions: await createQuestions() });
    const client = await loginClient(app, "student1@test.local");
    expect((await client.get(`/api/tests/${test._id}`)).status).toBe(402);
    expect(await startStatus(client, test._id)).toBe(402);
  });

  test("entitlement for the test's season → allowed", async () => {
    const user = await createUser();
    const test = await createTest({ isFree: false, questions: await createQuestions() });
    await grantEntitlementFor(user, test.seasonId);
    const client = await loginClient(app, "student1@test.local");
    expect((await client.get(`/api/tests/${test._id}`)).status).toBe(200);
    expect(await startStatus(client, test._id)).toBe(201);
  });

  test("entitlement for a different season → 402", async () => {
    const user = await createUser();
    const test = await createTest({ isFree: false, questions: await createQuestions() });
    const other = await Season.create({ name: "UGEE 2025", year: 2025, status: "archived" });
    await grantEntitlementFor(user, other._id);
    const client = await loginClient(app, "student1@test.local");
    expect((await client.get(`/api/tests/${test._id}`)).status).toBe(402);
    expect(await startStatus(client, test._id)).toBe(402);
  });

  test("revoked entitlement → 402", async () => {
    const user = await createUser();
    const test = await createTest({ isFree: false, questions: await createQuestions() });
    await grantEntitlementFor(user, test.seasonId, "revoked");
    const client = await loginClient(app, "student1@test.local");
    expect((await client.get(`/api/tests/${test._id}`)).status).toBe(402);
  });

  test("expired entitlement → 402", async () => {
    const user = await createUser();
    const test = await createTest({ isFree: false, questions: await createQuestions() });
    const ent = await grantEntitlementFor(user, test.seasonId);
    await Entitlement.updateOne({ _id: ent._id }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    const client = await loginClient(app, "student1@test.local");
    expect((await client.get(`/api/tests/${test._id}`)).status).toBe(402);
  });

  test("admin → allowed", async () => {
    await createUser({ email: "admin@test.local", role: "admin", name: "Admin" });
    const test = await createTest({ isFree: false, questions: await createQuestions() });
    const client = await loginClient(app, "admin@test.local");
    expect((await client.get(`/api/tests/${test._id}`)).status).toBe(200);
  });

  test("login does not reactivate a revoked entitlement from a verified payment", async () => {
    const user = await createUser();
    const test = await createTest({ isFree: false, questions: await createQuestions() });
    await PaymentRecord.create({ seasonId: test.seasonId, email: user.email, normalizedEmail: user.email, status: "verified", source: "admin" });
    await grantEntitlementFor(user, test.seasonId, "revoked");
    const client = await loginClient(app, "student1@test.local");
    expect((await client.get(`/api/tests/${test._id}`)).status).toBe(402);
    expect((await Entitlement.findOne({ normalizedEmail: user.email })).status).toBe("revoked");
  });
});

describe("catalog isolation", () => {
  test("no questions or question ids are shipped; access flags follow entitlements", async () => {
    const user = await createUser();
    const questions = await createQuestions();
    const free = await createTest({ isFree: true, questions });
    const paid = await createTest({ isFree: false, questions });
    const client = await loginClient(app, "student1@test.local");
    let res = await client.get("/api/tests");
    expect(res.body.questions).toEqual([]);
    res.body.tests.forEach((t) => expect(t.questionIds).toEqual([]));
    expect(res.body.tests.find((t) => t.id === String(paid._id)).accessible).toBe(false);
    expect(res.body.tests.find((t) => t.id === String(free._id)).accessible).toBe(true);

    await grantEntitlementFor(user, paid.seasonId);
    res = await client.get("/api/tests");
    expect(res.body.tests.find((t) => t.id === String(paid._id)).accessible).toBe(true);
  });
});

describe("internal provisioning API", () => {
  const body = (overrides = {}) => ({
    commerceUserId: "cu_123",
    email: "Buyer@Test.local",
    resourceCode: "PAID_MOCK_SERIES",
    entitlementId: "ent_1",
    idempotencyKey: "idem-key-0001",
    ...overrides,
  });
  const provision = (payload, secret = SECRET) => {
    const req = request(app).post("/api/internal/access/provision");
    return (secret ? req.set("x-internal-api-secret", secret) : req).send(payload);
  };

  test("missing secret → 401; wrong secret → 401; unset server secret → 401", async () => {
    await createTest({ isFree: false, questions: await createQuestions() });
    expect((await provision(body(), null)).status).toBe(401);
    expect((await provision(body(), "secret")).status).toBe(401);
    delete process.env.INTERNAL_API_SECRET;
    expect((await provision(body(), "secret")).status).toBe(401);
  });

  test("invalid body → 400", async () => {
    expect((await provision({ email: "x" })).status).toBe(400);
    expect((await provision(body({ resourceCode: "lower case" }))).status).toBe(400);
  });

  test("unmapped resource → 422 and no season is created", async () => {
    await Season.deleteMany({});
    const res = await provision(body({ resourceCode: "UNKNOWN_PRODUCT" }));
    expect(res.status).toBe(422);
    expect(await Season.countDocuments({})).toBe(0);
  });

  test("valid request → verified commerce PaymentRecord + active Entitlement + audit; buyer can open paid test", async () => {
    const test = await createTest({ isFree: false, questions: await createQuestions() });
    const res = await provision(body());
    expect(res.status).toBe(200);
    expect(res.body.entitlement.status).toBe("active");
    const payment = await PaymentRecord.findOne({ normalizedEmail: "buyer@test.local" });
    expect(payment.source).toBe("commerce");
    expect(payment.status).toBe("verified");
    expect(payment.sourceRecordId).toBe("ent_1");
    expect(await AuditLog.countDocuments({ action: "INTERNAL_PROVISION" })).toBe(1);
    // Unknown buyer gets a pending account (activates normally), no password.
    const user = await User.findOne({ email: "buyer@test.local" }).select("+passwordHash");
    expect(user.status).toBe("pending");
    expect(user.passwordHash).toBeUndefined();

    // Once activated, the buyer can open the paid test.
    await User.updateOne({ _id: user._id }, { $set: { status: "active", isActivated: true, passwordHash: require("bcryptjs").hashSync("Passw0rd!long", 4) } });
    const client = await loginClient(app, "buyer@test.local");
    expect((await client.get(`/api/tests/${test._id}`)).status).toBe(200);
  });

  test("replay is idempotent: one payment, one entitlement, one audit entry", async () => {
    await createTest({ isFree: false, questions: await createQuestions() });
    expect((await provision(body())).status).toBe(200);
    const again = await provision(body());
    expect(again.status).toBe(200);
    expect(again.body.replay).toBe(true);
    expect(await PaymentRecord.countDocuments({})).toBe(1);
    expect(await Entitlement.countDocuments({})).toBe(1);
    expect(await AuditLog.countDocuments({ action: "INTERNAL_PROVISION" })).toBe(1);
  });

  test("a season tagged with the resource code wins over the active season", async () => {
    const tagged = await Season.create({ name: "Crash Course", year: 2026, status: "draft", resourceCode: "CRASH_COURSE" });
    await createTest({ isFree: false, questions: await createQuestions() });
    const res = await provision(body({ resourceCode: "CRASH_COURSE" }));
    expect(res.status).toBe(200);
    expect(res.body.entitlement.seasonId).toBe(String(tagged._id));
  });

  test("revoke removes access and is audited", async () => {
    const user = await createUser({ email: "buyer@test.local" });
    const test = await createTest({ isFree: false, questions: await createQuestions() });
    await provision(body());
    const client = await loginClient(app, "buyer@test.local");
    expect((await client.get(`/api/tests/${test._id}`)).status).toBe(200);

    const res = await request(app).post("/api/internal/access/revoke").set("x-internal-api-secret", SECRET).send(body());
    expect(res.status).toBe(200);
    expect(res.body.entitlement.status).toBe("revoked");
    expect((await client.get(`/api/tests/${test._id}`)).status).toBe(402);
    expect(await AuditLog.countDocuments({ action: "INTERNAL_REVOKE" })).toBe(1);
    expect((await User.findById(user._id)).isPaid).toBe(false);
  });
});

describe("admin manual payments", () => {
  test("add payment creates a pending record; verifying it grants access", async () => {
    await createUser();
    await createUser({ email: "admin@test.local", role: "admin", name: "Admin" });
    const test = await createTest({ isFree: false, questions: await createQuestions() });
    const admin = await loginClient(app, "admin@test.local");
    const created = await admin.post("/api/admin/payments", { email: "student1@test.local", name: "Student One" });
    expect(created.status).toBe(201);
    expect(created.body.payment.status).toBe("pending");
    const student = await loginClient(app, "student1@test.local");
    expect((await student.get(`/api/tests/${test._id}`)).status).toBe(402);

    const verify = await admin.post(`/api/admin/payments/${created.body.payment.id}/verify`, { sendEmail: false });
    expect(verify.status).toBe(200);
    expect((await student.get(`/api/tests/${test._id}`)).status).toBe(200);

    expect((await admin.post("/api/admin/payments", { email: "student1@test.local" })).status).toBe(409);
    expect((await admin.post("/api/admin/payments", { email: "not-an-email" })).status).toBe(400);
  });

  test("students can't create payments", async () => {
    await createUser();
    const student = await loginClient(app, "student1@test.local");
    expect((await student.post("/api/admin/payments", { email: "student1@test.local" })).status).toBe(403);
  });
});
