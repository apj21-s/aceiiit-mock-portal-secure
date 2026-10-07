// M1: cookie-only sessions validated against the current user record on every request;
// revocation (tokenVersion) takes effect immediately.
const jwt = require("jsonwebtoken");
const request = require("supertest");

const { createApp } = require("../../app");
const User = require("../../models/User");
const { startDb, clearDb, stopDb } = require("../helpers/db");
const { createUser } = require("../helpers/fixtures");
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

function signFor(user, extra = {}) {
  return jwt.sign({ userId: String(user._id), tv: Number(user.tokenVersion || 0), ...extra }, process.env.JWT_SECRET, { expiresIn: "1h" });
}

describe("cookie-only sessions", () => {
  test("a Bearer header is ignored; only the session cookie authenticates", async () => {
    const user = await createUser();
    const token = signFor(user);
    const bearer = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${token}`);
    expect(bearer.status).toBe(401);
    const cookie = await request(app).get("/api/auth/me").set("Cookie", `aceiiit_session=${token}`);
    expect(cookie.status).toBe(200);
  });

  test("role comes from the database, not from JWT claims", async () => {
    const user = await createUser();
    const forgedRole = signFor(user, { role: "admin", isPaid: true });
    const res = await request(app).get("/api/admin/snapshot").set("Cookie", `aceiiit_session=${forgedRole}`);
    expect(res.status).toBe(403);
  });

  test("a token signed with another secret is rejected", async () => {
    const user = await createUser();
    const token = jwt.sign({ userId: String(user._id), tv: 0 }, "not-the-real-secret");
    const res = await request(app).get("/api/auth/me").set("Cookie", `aceiiit_session=${token}`);
    expect(res.status).toBe(401);
  });
});

describe("immediate revocation", () => {
  test("admin revoke-sessions logs the user out immediately", async () => {
    const student = await createUser();
    await createUser({ email: "admin@test.local", name: "Admin", role: "admin" });
    const studentClient = await loginClient(app, "student1@test.local");
    const adminClient = await loginClient(app, "admin@test.local");
    expect((await studentClient.get("/api/auth/me")).status).toBe(200);

    const revoke = await adminClient.post(`/api/admin/users/${student._id}/revoke-sessions`);
    expect(revoke.status).toBe(200);
    expect((await studentClient.get("/api/auth/me")).status).toBe(401);
  });

  test("password change signs out other sessions but keeps the current one", async () => {
    await createUser();
    const deviceA = await loginClient(app, "student1@test.local");
    const deviceB = await loginClient(app, "student1@test.local");

    const change = await deviceA.put("/api/auth/password", { currentPassword: "Passw0rd!long", newPassword: "N3w-password-123" });
    expect(change.status).toBe(200);
    expect((await deviceA.get("/api/auth/me")).status).toBe(200);
    expect((await deviceB.get("/api/auth/me")).status).toBe(401);
  });

  test("logout-all signs out every device", async () => {
    await createUser();
    const deviceA = await loginClient(app, "student1@test.local");
    const deviceB = await loginClient(app, "student1@test.local");
    expect((await deviceA.post("/api/auth/logout-all")).status).toBe(200);
    expect((await deviceA.get("/api/auth/me")).status).toBe(401);
    expect((await deviceB.get("/api/auth/me")).status).toBe(401);
  });

  test("deleted and disabled users lose access immediately", async () => {
    const user = await createUser();
    const client = await loginClient(app, "student1@test.local");
    await User.updateOne({ _id: user._id }, { $set: { status: "disabled" } });
    expect((await client.get("/api/auth/me")).status).toBe(401);

    await User.updateOne({ _id: user._id }, { $set: { status: "active", deletedAt: new Date() } });
    expect((await client.get("/api/auth/me")).status).toBe(401);
  });

  test("admin delete revokes the deleted user's sessions", async () => {
    const student = await createUser();
    await createUser({ email: "admin@test.local", name: "Admin", role: "admin" });
    const studentClient = await loginClient(app, "student1@test.local");
    const adminClient = await loginClient(app, "admin@test.local");
    expect((await adminClient.del(`/api/admin/users/${student._id}`)).status).toBe(200);
    expect((await studentClient.get("/api/auth/me")).status).toBe(401);
  });

  test("losing admin status (ADMIN_EMAILS) revokes admin access immediately", async () => {
    await createUser({ email: "admin@test.local", name: "Admin", role: "admin" });
    const adminClient = await loginClient(app, "admin@test.local");
    expect((await adminClient.get("/api/admin/snapshot")).status).toBe(200);

    const previous = process.env.ADMIN_EMAILS;
    process.env.ADMIN_EMAILS = "someone-else@test.local";
    try {
      await User.updateOne({ email: "admin@test.local" }, { $set: { role: "student" }, $inc: { tokenVersion: 1 } });
      expect((await adminClient.get("/api/admin/snapshot")).status).toBe(401);
    } finally {
      process.env.ADMIN_EMAILS = previous;
    }
  });

  test("password reset revokes existing sessions", async () => {
    await createUser();
    const client = await loginClient(app, "student1@test.local");
    await User.updateOne({ email: "student1@test.local" }, { $inc: { tokenVersion: 1 } });
    expect((await client.get("/api/auth/me")).status).toBe(401);
  });

  test("plain logout clears the session cookie", async () => {
    await createUser();
    const client = await loginClient(app, "student1@test.local");
    const res = await client.post("/api/auth/logout");
    expect(res.status).toBe(200);
    expect((await client.get("/api/auth/me")).status).toBe(401);
  });
});
