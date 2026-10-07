// Password hashing: native bcrypt (off the event loop) with bcryptjs-compatible hashes, and
// no timing oracle for unknown accounts at login.
const bcryptjs = require("bcryptjs");
const request = require("supertest");

const { hashPassword, verifyPassword, isNative, ROUNDS } = require("../../utils/password");
const { createApp } = require("../../app");
const { startDb, clearDb, stopDb } = require("../helpers/db");

describe("utils/password", () => {
  test("uses native bcrypt at cost 12, and hashes interoperate with bcryptjs", async () => {
    expect(isNative).toBe(true);
    expect(ROUNDS).toBe(12);
    const legacy = await bcryptjs.hash("legacy-Passw0rd", 4);
    expect(await verifyPassword("legacy-Passw0rd", legacy)).toBe(true);
    expect(await verifyPassword("wrong", legacy)).toBe(false);
    const fresh = await hashPassword("fresh-Passw0rd");
    expect(fresh).toMatch(/^\$2[ab]\$12\$/);
    expect(bcryptjs.compareSync("fresh-Passw0rd", fresh)).toBe(true);
  });

  test("a missing hash is rejected after doing comparable work", async () => {
    await verifyPassword("warm-up", null);
    const started = Date.now();
    expect(await verifyPassword("anything", null)).toBe(false);
    expect(await verifyPassword("", undefined)).toBe(false);
    // Two cost-12 compares: tens of milliseconds at least, never an instant return.
    expect(Date.now() - started).toBeGreaterThan(20);
  });
});

describe("login timing for unknown accounts", () => {
  let app;
  beforeAll(async () => {
    await startDb();
    app = createApp();
  });
  afterEach(clearDb);
  afterAll(stopDb);

  test("an unknown email still costs a full password check", async () => {
    const agent = request.agent(app);
    const csrf = (await agent.get("/api/auth/csrf")).body.csrfToken;
    const login = (email) => agent.post("/api/auth/login").set("X-CSRF-Token", csrf).send({ email, password: "Some-Passw0rd" });
    await login("warmup@test.local");
    const started = Date.now();
    const res = await login("nobody-here@test.local");
    expect(res.status).toBe(401);
    expect(Date.now() - started).toBeGreaterThan(20);
  });
});
