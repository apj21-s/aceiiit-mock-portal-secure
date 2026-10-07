// M1: only backend/public is web-served; source, package and env files are never exposed.
const request = require("supertest");

const { createApp } = require("../../app");

const app = createApp();

describe("static file exposure", () => {
  test.each([
    "/backend/server.js",
    "/backend/package.json",
    "/backend/.env",
    "/server.js",
    "/app.js",
    "/package.json",
    "/.env",
    "/controllers/authController.js",
    "/config/env.js",
    "/node_modules/express/package.json",
    "/tests/helpers/env.js",
    "/.git/config",
  ])("%s is not served", async (path) => {
    const res = await request(app).get(path);
    expect(res.status).toBe(404);
    expect(res.text).not.toMatch(/require\(|JWT_SECRET|"dependencies"/);
  });

  test("the SPA shell and public assets are served", async () => {
    const index = await request(app).get("/");
    expect(index.status).toBe(200);
    expect(index.text).toMatch(/<div id="app">/);
    expect((await request(app).get("/js/app.js")).status).toBe(200);
    expect((await request(app).get("/css/portal.css")).status).toBe(200);
    expect((await request(app).get("/vendor/katex/katex.min.js")).status).toBe(200);
  });

  test("extension-less client routes fall back to the SPA shell", async () => {
    const res = await request(app).get("/dashboard");
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/<div id="app">/);
  });

  test("unknown API routes never return the SPA shell", async () => {
    // No DB in this suite, so the readiness gate answers 503 before routing; either way
    // the response is a JSON error, never index.html.
    const res = await request(app).get("/api/does-not-exist");
    expect([404, 503]).toContain(res.status);
    expect(res.text).not.toMatch(/<div id="app">/);
  });
});
