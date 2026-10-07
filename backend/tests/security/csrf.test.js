// M1: double-submit CSRF is enforced on every mutating method under /api.
const request = require("supertest");

const { createApp } = require("../../app");
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

describe("CSRF protection", () => {
  test.each([
    ["post", "/api/reminders"],
    ["put", "/api/auth/password"],
    ["patch", "/api/reminders/000000000000000000000000"],
    ["delete", "/api/reminders/000000000000000000000000"],
  ])("%s %s without the CSRF header returns 403", async (method, url) => {
    await createUser();
    const client = await loginClient(app, "student1@test.local");
    const res = await client.agent[method](url).send({});
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("CSRF_FAILED");
  });

  test("correct cookie + matching header succeeds", async () => {
    await createUser();
    const client = await loginClient(app, "student1@test.local");
    const res = await client.put("/api/auth/password", { currentPassword: "Passw0rd!long", newPassword: "An0ther-pass-123" });
    expect(res.status).toBe(200);
  });

  test("cookie/header mismatch returns 403", async () => {
    await createUser();
    const client = await loginClient(app, "student1@test.local");
    const res = await client.agent
      .put("/api/auth/password")
      .set("X-CSRF-Token", "a".repeat(64))
      .send({ currentPassword: "Passw0rd!long", newPassword: "An0ther-pass-123" });
    expect(res.status).toBe(403);
  });

  test("header without a cookie returns 403", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .set("X-CSRF-Token", "b".repeat(64))
      .send({ email: "student1@test.local", password: "Passw0rd!long" });
    expect(res.status).toBe(403);
  });

  test("login itself requires CSRF (blocks login CSRF)", async () => {
    await createUser();
    const res = await request(app).post("/api/auth/login").send({ email: "student1@test.local", password: "Passw0rd!long" });
    expect(res.status).toBe(403);
  });

  test("safe methods don't require CSRF", async () => {
    await createUser();
    const client = await loginClient(app, "student1@test.local");
    expect((await client.agent.get("/api/auth/me")).status).toBe(200);
  });

  test("/api/internal/* is exempt (authenticated by the shared secret instead)", async () => {
    const res = await request(app).post("/api/internal/access/provision").send({});
    expect(res.status).not.toBe(403);
  });
});
