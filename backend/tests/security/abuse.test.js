// M1: login lockout, enumeration-safe responses, no account creation before activation,
// and removal of the legacy OTP endpoints.
jest.mock("../../utils/mailService", () => ({
  sendActivationEmail: jest.fn(async () => ({ provider: "test" })),
  sendPasswordResetEmail: jest.fn(async () => ({ provider: "test" })),
  sendReminderEmail: jest.fn(),
  sendCalendarInviteEmail: jest.fn(async () => ({ ok: true })),
  sendPaymentConfirmationEmail: jest.fn(),
  sendEmailThroughProviders: jest.fn(),
}));

const mailService = require("../../utils/mailService");
const { createApp } = require("../../app");
const User = require("../../models/User");
const { startDb, clearDb, stopDb } = require("../helpers/db");
const { createUser } = require("../helpers/fixtures");
const { newClient } = require("../helpers/session");

let app;

beforeAll(async () => {
  await startDb();
  app = createApp();
});

afterEach(async () => {
  jest.clearAllMocks();
  await clearDb();
});

afterAll(async () => {
  await stopDb();
});

async function attemptLogins(email, password, count) {
  const client = await newClient(app);
  const statuses = [];
  for (let i = 0; i < count; i += 1) {
    const res = await client.post("/api/auth/login", { email, password });
    statuses.push(res.status);
  }
  return { client, statuses };
}

describe("login lockout", () => {
  test("an account locks after 5 failures, even for the correct password", async () => {
    await createUser({ email: "lock@test.local" });
    const { client, statuses } = await attemptLogins("lock@test.local", "wrong-password", 5);
    expect(statuses).toEqual([401, 401, 401, 401, 401]);
    const correct = await client.post("/api/auth/login", { email: "lock@test.local", password: "Passw0rd!long" });
    expect(correct.status).toBe(429);
    const user = await User.findOne({ email: "lock@test.local" });
    expect(user.lockedUntil.getTime()).toBeGreaterThan(Date.now());
  });

  test("existing and unknown accounts behave identically", async () => {
    await createUser({ email: "known@test.local" });
    const known = await attemptLogins("known@test.local", "wrong-password", 6);
    const unknown = await attemptLogins("ghost@test.local", "wrong-password", 6);
    expect(known.statuses).toEqual(unknown.statuses);
    expect(known.statuses[5]).toBe(429);
  });

  test("a successful login resets the failure counter", async () => {
    await createUser({ email: "reset@test.local" });
    const client = await newClient(app);
    await client.post("/api/auth/login", { email: "reset@test.local", password: "wrong" });
    await client.post("/api/auth/login", { email: "reset@test.local", password: "wrong" });
    const ok = await client.post("/api/auth/login", { email: "reset@test.local", password: "Passw0rd!long" });
    expect(ok.status).toBe(200);
    expect((await User.findOne({ email: "reset@test.local" })).failedLoginCount).toBe(0);
  });
});

describe("enumeration-safe responses", () => {
  test("login failure message is identical for unknown, unactivated and wrong-password cases", async () => {
    await createUser({ email: "active@test.local" });
    await User.create({ name: "Pending", email: "pending@test.local", status: "pending" });
    const client = await newClient(app);
    const a = await client.post("/api/auth/login", { email: "ghost2@test.local", password: "x" });
    const b = await client.post("/api/auth/login", { email: "pending@test.local", password: "x" });
    const c = await client.post("/api/auth/login", { email: "active@test.local", password: "x" });
    expect([a.status, b.status, c.status]).toEqual([401, 401, 401]);
    expect(a.body).toEqual(b.body);
    expect(b.body).toEqual(c.body);
    expect(b.body.requiresActivation).toBeUndefined();
  });

  test("activation request answers identically and creates no account", async () => {
    await createUser({ email: "done@test.local" });
    const client = await newClient(app);
    const fresh = await client.post("/api/auth/activate/request", { email: "new@test.local" });
    const activated = await client.post("/api/auth/activate/request", { email: "done@test.local" });
    expect(fresh.status).toBe(200);
    expect(activated.status).toBe(200);
    expect(fresh.body).toEqual(activated.body);
    expect(await User.countDocuments({ email: "new@test.local" })).toBe(0);
    // Only the eligible (new) address gets an email.
    expect(mailService.sendActivationEmail).toHaveBeenCalledTimes(1);
    expect(mailService.sendActivationEmail.mock.calls[0][0]).toBe("new@test.local");
  });

  test("completing activation creates the account and signs in", async () => {
    const client = await newClient(app);
    await client.post("/api/auth/activate/request", { email: "new2@test.local" });
    const rawToken = mailService.sendActivationEmail.mock.calls[0][1];
    const res = await client.post("/api/auth/activate/complete", { token: rawToken, password: "Activat3d-pass", name: "New Student" });
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe("new2@test.local");
    expect((await client.get("/api/auth/me")).status).toBe(200);
    // Single use.
    const again = await client.post("/api/auth/activate/complete", { token: rawToken, password: "Activat3d-pass" });
    expect(again.status).toBe(400);
  });

  test("password reset request answers identically for unknown emails", async () => {
    await createUser({ email: "real@test.local" });
    const client = await newClient(app);
    const known = await client.post("/api/auth/forgot-password/request", { email: "real@test.local" });
    const unknown = await client.post("/api/auth/forgot-password/request", { email: "nobody@test.local" });
    expect(known.body).toEqual(unknown.body);
    expect(mailService.sendPasswordResetEmail).toHaveBeenCalledTimes(1);
  });
});

describe("legacy OTP endpoints are removed", () => {
  test.each(["/api/auth/send-otp", "/api/auth/verify-otp"])("%s returns 404", async (url) => {
    const client = await newClient(app);
    const res = await client.post(url, { email: "x@test.local" });
    expect(res.status).toBe(404);
  });
});
