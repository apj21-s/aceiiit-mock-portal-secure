// M8: liveness/readiness, request ids, and error responses that never leak internals.
const express = require("express");
const request = require("supertest");

const { createApp } = require("../../app");
const { errorHandler } = require("../../middleware/error");
const { REDACT_PATHS } = require("../../utils/logger");
const { startDb, stopDb } = require("../helpers/db");

describe("without a database", () => {
  const app = createApp();

  test("/health is live and /ready reports not ready (503)", async () => {
    const health = await request(app).get("/health");
    expect(health.status).toBe(200);
    expect(health.body.status).toBe("ok");
    const ready = await request(app).get("/ready");
    expect(ready.status).toBe(503);
    expect(ready.body.db.ready).toBe(false);
    expect(JSON.stringify(ready.body)).not.toMatch(/mongodb:\/\/|secret|password/i);
  });

  test("every response carries an X-Request-Id; a well-formed incoming id is honoured", async () => {
    const generated = await request(app).get("/health");
    expect(generated.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
    const echoed = await request(app).get("/health").set("X-Request-Id", "proxy-abc-12345");
    expect(echoed.headers["x-request-id"]).toBe("proxy-abc-12345");
    const rejected = await request(app).get("/health").set("X-Request-Id", "<script>bad id</script>");
    expect(rejected.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("with a database", () => {
  beforeAll(startDb);
  afterAll(stopDb);

  test("/ready is 200 with job and queue status", async () => {
    const res = await request(createApp()).get("/ready");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ready");
    expect(res.body.attemptQueue).toEqual(expect.objectContaining({ max: expect.any(Number) }));
    expect(res.body.jobs.aiInterpretation.breaker).toEqual(expect.objectContaining({ open: false }));
  });
});

describe("error responses", () => {
  test("unexpected errors return a generic message plus the request id, never a stack", async () => {
    const app = express();
    app.use((req, _res, next) => {
      req.id = "req-test-123";
      next();
    });
    app.get("/boom", () => {
      throw new Error("database password=hunter2 exploded at /srv/app.js:10");
    });
    app.use(errorHandler);
    const res = await request(app).get("/boom");
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Internal server error", requestId: "req-test-123" });
  });

  test("the logger redacts credentials and session headers", () => {
    ["req.headers.authorization", "req.headers.cookie", 'req.headers["x-internal-api-secret"]', 'req.headers["x-exam-token"]'].forEach((p) => {
      expect(REDACT_PATHS).toContain(p);
    });
  });
});
