// M0 baseline of KNOWN DEFECTS (see AGENT_HANDOFF_PRODUCTION_HARDENING.md §5).
// These assertions describe today's insecure or broken behaviour on purpose.
// Each one is flipped into a regression test by the milestone that fixes it.
const request = require("supertest");

const { createApp } = require("../../app");
const { startDb, clearDb, stopDb } = require("../helpers/db");
const { createUser, loginAs } = require("../helpers/fixtures");

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

describe("KNOWN DEFECT baseline (to be fixed)", () => {
  test("[M1] mock_google_ credential logs in as any email, including admins", async () => {
    const res = await request(app)
      .post("/api/auth/google")
      .send({ credential: "mock_google_admin@test.local", email: "admin@test.local" });
    expect(res.status).toBe(200);
    expect(res.body.user.role).toBe("admin");
  });

  test("[M1] backend source files are served publicly", async () => {
    const res = await request(app).get("/backend/server.js");
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/createApp/);
  });

  test("[M3] internal provisioning accepts the default secret 'secret'", async () => {
    const res = await request(app)
      .post("/api/internal/access/provision")
      .set("x-internal-api-secret", "secret")
      .send({ email: "buyer@test.local", resourceCode: "PAID_MOCK_SERIES", entitlementId: "e1" });
    expect(res.status).toBe(200);
  });

  test("[M4] QOTD submission always 404s because it reads req.auth.id", async () => {
    await createUser();
    const token = await loginAs(request, app, "student1@test.local");
    const res = await request(app)
      .post("/api/tests/qotd-attempt")
      .set("Authorization", `Bearer ${token}`)
      .send({ date: "2026-10-06", answeredOpt: "1" });
    expect(res.status).toBe(404);
  });
});
