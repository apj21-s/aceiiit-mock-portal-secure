// Production-mode smoke: the real server.js with NODE_ENV=production against an in-memory DB.
// Boot refuses weak config; security headers; nothing outside public/ is served; CSRF;
// cookie flags; mock OAuth / bearer tokens / internal API without secret are rejected;
// graceful shutdown; the index migration (dry run, apply, idempotent) and the boot warning.
const path = require("path");
const fs = require("fs");
const { spawn, execFile } = require("child_process");
// Async on purpose: this process also drains the in-memory mongod's log pipe.
const execAsync = (args, env) => new Promise((resolve, reject) => execFile(process.execPath, args, { cwd: B, env, encoding: "utf8" }, (err, stdout) => (err ? reject(err) : resolve(stdout))));
const { BACKEND: B } = require("./helpers");
const { MongoMemoryServer } = require(B + "/node_modules/mongodb-memory-server");
const mongoose = require(B + "/node_modules/mongoose");
const bcrypt = require(B + "/node_modules/bcryptjs");

const results = [];
const check = (ok, msg, extra) => { results.push([ok, msg]); console.log(ok ? "PASS" : "FAIL", msg, extra !== undefined ? extra : ""); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = 4971;
const BASE = `http://127.0.0.1:${PORT}`;

function prodEnv(uri, overrides = {}) {
  return {
    PATH: process.env.PATH, HOME: process.env.HOME, ACEIIIT_SKIP_DOTENV: "1", NODE_ENV: "production", PORT: String(PORT), LOG_LEVEL: "info",
    MONGODB_URI: uri, JWT_SECRET: "p".repeat(40), INTERNAL_API_SECRET: "i".repeat(40), CALENDAR_TOKEN_KEY: "c".repeat(40),
    PORTAL_BASE_URL: "https://mock.example.test", GOOGLE_CLIENT_ID: "test-client.apps.googleusercontent.com", RESEND_API_KEY: "re_dummy_not_used",
    ADMIN_EMAILS: "nobody@test.local", ...overrides,
  };
}

function boot(env) {
  const child = spawn(process.execPath, ["server.js"], { cwd: B, env });
  child.log = "";
  child.stdout.on("data", (d) => (child.log += d));
  child.stderr.on("data", (d) => (child.log += d));
  child.exited = new Promise((r) => child.on("exit", (code) => r(code)));
  return child;
}

(async () => {
  // CI starts from a clean checkout: the cache folder may not exist yet.
  const dataRoot = path.join(B, "node_modules/.cache/mongodb-test-data");
  fs.mkdirSync(dataRoot, { recursive: true });
  const dbPath = fs.mkdtempSync(path.join(dataRoot, "prod-"));
  const m = await MongoMemoryServer.create({ instance: { dbPath } });
  const uri = m.getUri() + "prodsmoke";

  // 1. Weak config refuses to boot.
  for (const [label, o] of [["short JWT_SECRET", { JWT_SECRET: "short" }], ["http PORTAL_BASE_URL", { PORTAL_BASE_URL: "http://x.test" }], ["ALLOW_INSECURE_DEV_AUTH", { ALLOW_INSECURE_DEV_AUTH: "true" }], ["no email provider", { RESEND_API_KEY: "" }]]) {
    const c = boot(prodEnv(uri, o));
    const code = await Promise.race([c.exited, sleep(5000).then(() => "running")]);
    if (code === "running") c.kill("SIGKILL");
    check(code !== "running" && code !== 0, `production refuses to boot with ${label}`, `(exit ${code})`);
  }

  // 2. Seed one user (bcrypt hash) directly; production runs with autoIndex off.
  await mongoose.connect(uri, { autoIndex: false });
  await mongoose.connection.db.collection("users").insertOne({ name: "Prod Smoke", email: "smoke@test.local", normalizedEmail: "smoke@test.local", role: "student", status: "active", isActivated: true, emailVerified: true, passwordHash: await bcrypt.hash("Passw0rd!long", 4), tokenVersion: 0, createdAt: new Date(), updatedAt: new Date() });
  await mongoose.disconnect();

  let server = boot(prodEnv(uri));
  for (let i = 0; i < 40; i += 1) { try { if ((await fetch(BASE + "/ready")).status === 200) break; } catch (_e) {} await sleep(250); }
  await sleep(1500);
  check(/missing schema indexes/.test(server.log), "boot warns about missing indexes (autoIndex off)");

  const health = await fetch(BASE + "/health");
  check(health.status === 200, "/health 200");
  const ready = await (await fetch(BASE + "/ready")).text();
  check(/"status":"ready"/.test(ready) && !/secret|mongodb:\/\//i.test(ready), "/ready is ready and leaks no secrets or URIs");

  const home = await fetch(BASE + "/");
  const h = home.headers;
  check(home.status === 200, "index served");
  check(/default-src 'self'/.test(h.get("content-security-policy") || ""), "CSP header present");
  check(/max-age=/.test(h.get("strict-transport-security") || ""), "HSTS header present");
  check(h.get("x-content-type-options") === "nosniff", "nosniff header");
  check(!h.get("x-powered-by"), "no X-Powered-By");

  for (const p of ["/.env", "/backend/.env", "/server.js", "/backend/server.js", "/package.json", "/node_modules/katex/package.json", "/controllers/authController.js", "/config/env.js"]) {
    const r = await fetch(BASE + p);
    const body = await r.text();
    check(r.status === 404 && !/JWT_SECRET|require\(/.test(body), `${p} not exposed`, `(${r.status})`);
  }
  for (const p of ["/privacy.html", "/terms.html", "/vendor/katex/katex.min.js"]) {
    check((await fetch(BASE + p)).status === 200, `${p} served`);
  }

  // CSRF + login cookie flags
  const noCsrf = await fetch(BASE + "/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "smoke@test.local", password: "Passw0rd!long" }) });
  check(noCsrf.status === 403, "login without CSRF token → 403", `(${noCsrf.status})`);
  const csrfRes = await fetch(BASE + "/api/auth/csrf");
  const csrfCookie = csrfRes.headers.getSetCookie().find((c) => c.startsWith("aceiiit_csrf="));
  const csrf = (await csrfRes.json()).csrfToken;
  const login = await fetch(BASE + "/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf, Cookie: csrfCookie.split(";")[0] }, body: JSON.stringify({ email: "smoke@test.local", password: "Passw0rd!long" }) });
  const session = login.headers.getSetCookie().find((c) => c.startsWith("aceiiit_session="));
  check(login.status === 200, "login with CSRF → 200", `(${login.status})`);
  check(session && /HttpOnly/i.test(session) && /Secure/i.test(session) && /SameSite=Lax/i.test(session), "session cookie is HttpOnly; Secure; SameSite=Lax", session && session.replace(/=[^;]+/, "=…"));
  const loginBody = await login.json();
  check(!JSON.stringify(loginBody).match(/token|passwordHash|tokenVersion/i), "login response has no token or internal fields");

  const mock = await fetch(BASE + "/api/auth/google", { method: "POST", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf, Cookie: csrfCookie.split(";")[0] }, body: JSON.stringify({ credential: "mock_google_attacker@test.local" }) });
  check(mock.status === 401 || mock.status === 400, "mock Google credential rejected in production", `(${mock.status})`);
  const internal = await fetch(BASE + "/api/internal/access/provision", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  check(internal.status === 401, "internal API without secret → 401", `(${internal.status})`);
  const bearer = await fetch(BASE + "/api/auth/me", { headers: { Authorization: "Bearer " + (session || "").split(";")[0].split("=")[1] } });
  check(bearer.status === 401, "bearer token (instead of cookie) is not accepted", `(${bearer.status})`);
  const notFound = await fetch(BASE + "/api/nope");
  const nfBody = await notFound.text();
  check(notFound.status === 404 && !/at .*\.js:\d+/.test(nfBody), "unknown API → 404 without stack");

  // 3. Graceful shutdown, then the index migration, then a clean boot.
  server.kill("SIGTERM");
  const code = await Promise.race([server.exited, sleep(12000).then(() => "timeout")]);
  check(code === 0, "SIGTERM → graceful exit 0", `(${code})`);

  const migEnv = { PATH: process.env.PATH, MONGODB_URI: uri, NODE_ENV: "production" };
  const dry = await execAsync(["scripts/migrations/2026-10-sync-indexes.js"], migEnv);
  check(/\[dry run\] Would create attemptsessions .* unique partial/.test(dry), "migration dry run lists the one-active-session partial unique index");
  const applied = await execAsync(["scripts/migrations/2026-10-sync-indexes.js", "--apply"], migEnv);
  check(/Created/.test(applied) && !/FAILED/.test(applied), "migration --apply creates indexes without failures");
  const again = await execAsync(["scripts/migrations/2026-10-sync-indexes.js"], migEnv);
  check(/All schema indexes exist/.test(again), "migration is idempotent (second run: nothing to do)");

  server = boot(prodEnv(uri));
  for (let i = 0; i < 40; i += 1) { try { if ((await fetch(BASE + "/ready")).status === 200) break; } catch (_e) {} await sleep(250); }
  await sleep(1500);
  check(!/missing schema indexes/.test(server.log), "after migration, boot has no index warning");
  server.kill("SIGTERM");
  await server.exited;

  await m.stop();
  fs.rmSync(dbPath, { recursive: true, force: true });
  const failed = results.filter((r) => !r[0]);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
