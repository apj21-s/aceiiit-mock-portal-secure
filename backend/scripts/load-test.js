#!/usr/bin/env node
// Load test: concurrent students through the real HTTP flow (CSRF cookie, login, exam start,
// paper, autosave, SUPR→REAP advance, idempotent submit, result).
//
// SAFETY: by default it starts its own in-memory MongoDB and its own server process per
// concurrency level. It never reads backend/.env and never touches MONGODB_URI. Pointing it
// at another deployment requires both --target=<url> and --i-understand-this-is-not-production,
// plus pre-seeded accounts (see TESTING.md).
//
//   node scripts/load-test.js                       # levels 20,40,60,80,100,150 (local)
//   node scripts/load-test.js --levels=20,40        # custom levels
//   node scripts/load-test.js --json=results.json   # also write raw results
//   node scripts/load-test.js --threadpool=8        # server UV_THREADPOOL_SIZE (bcrypt runs there)
const path = require("path");
const fs = require("fs");
const { spawn, execFileSync } = require("child_process");

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...v] = a.replace(/^--/, "").split("=");
    return [k, v.length ? v.join("=") : true];
  })
);
const LEVELS = String(args.levels || "20,40,60,80,100,150").split(",").map(Number).filter(Boolean);
const PASSWORD = "LoadTest!Passw0rd";
const BACKEND = path.join(__dirname, "..");

if (args.target && !args["i-understand-this-is-not-production"]) {
  console.error("Refusing to run against --target without --i-understand-this-is-not-production.");
  process.exit(2);
}
if (args.target) {
  console.error("Remote targets need pre-seeded accounts; this script currently seeds only its own in-memory DB.");
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

/** Minimal cookie-jar HTTP client that behaves like the SPA (cookie session + CSRF header). */
function client(base) {
  const jar = {};
  let csrf = "";
  async function call(method, url, { body, headers = {} } = {}) {
    const h = { ...headers, Cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ") };
    if (body !== undefined) h["Content-Type"] = "application/json";
    if (method !== "GET" && csrf) h["X-CSRF-Token"] = csrf;
    const started = performance.now();
    const res = await fetch(base + url, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    const ms = performance.now() - started;
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(";");
      const idx = pair.indexOf("=");
      jar[pair.slice(0, idx)] = pair.slice(idx + 1);
    }
    let data = null;
    try {
      data = await res.json();
    } catch (_e) {}
    if (data && data.csrfToken) csrf = data.csrfToken;
    if (jar.aceiiit_csrf) csrf = decodeURIComponent(jar.aceiiit_csrf);
    return { status: res.status, data, ms };
  }
  return { call };
}

async function runStudent(base, email, testId, metrics) {
  const c = client(base);
  const step = async (name, method, url, opts, expectOk = true) => {
    const r = await c.call(method, url, opts);
    (metrics[name] = metrics[name] || { ms: [], errors: 0, statuses: {} }).ms.push(r.ms);
    metrics[name].statuses[r.status] = (metrics[name].statuses[r.status] || 0) + 1;
    if (expectOk && (r.status < 200 || r.status >= 300)) {
      metrics[name].errors += 1;
      throw new Error(`${name} → ${r.status} ${JSON.stringify(r.data).slice(0, 160)}`);
    }
    return r;
  };
  const flowStart = performance.now();
  await step("csrf", "GET", "/api/auth/csrf");
  await step("login", "POST", "/api/auth/login", { body: { email, password: PASSWORD } });
  const start = await step("start", "POST", "/api/attempt/start", { body: { testId } });
  const sessionId = start.data.session.id;
  const exam = { "X-Exam-Token": start.data.examToken };
  const paper = await step("paper", "GET", `/api/attempt/session/${sessionId}/paper`, { headers: exam });
  const suprQs = paper.data.questions.filter((q) => q.section === "SUPR");
  const reapQs = paper.data.questions.filter((q) => q.section === "REAP");
  let seq = 0;
  const answers = {};
  for (const q of suprQs) {
    answers[q.id] = Math.floor(Math.random() * Math.max(1, (q.options || []).length));
    seq += 1;
    await step("autosave", "PUT", `/api/attempt/session/${sessionId}/answers`, { headers: exam, body: { seq, answers: { ...answers } } });
  }
  await step("advance", "POST", `/api/attempt/session/${sessionId}/advance`, { headers: exam, body: {} });
  for (const q of reapQs) {
    answers[q.id] = Math.floor(Math.random() * Math.max(1, (q.options || []).length));
  }
  seq += 1;
  await step("autosave", "PUT", `/api/attempt/session/${sessionId}/answers`, {
    headers: exam,
    body: { seq, answers: Object.fromEntries(reapQs.map((q) => [q.id, answers[q.id]])) },
  });
  const submit = await step("submit", "POST", "/api/attempt", {
    headers: { ...exam, "Idempotency-Key": `load-${sessionId}` },
    body: { sessionId },
  });
  await step("result", "GET", `/api/result/${submit.data.attempt.id}`);
  (metrics.flow = metrics.flow || { ms: [], errors: 0, statuses: {} }).ms.push(performance.now() - flowStart);
}

function sampleProcess(pid) {
  try {
    const out = execFileSync("ps", ["-o", "%cpu=,rss=", "-p", String(pid)]).toString().trim().split(/\s+/);
    return { cpu: Number(out[0]), rssMb: Number(out[1]) / 1024 };
  } catch (_e) {
    return null;
  }
}

(async () => {
  const req = (m) => require(path.join(BACKEND, m));
  const { MongoMemoryServer } = req("node_modules/mongodb-memory-server");
  const mongoose = req("node_modules/mongoose");
  const bcrypt = req("node_modules/bcryptjs");
  const dataRoot = path.join(BACKEND, "node_modules/.cache/mongodb-test-data");
  fs.mkdirSync(dataRoot, { recursive: true });
  const dbPath = fs.mkdtempSync(path.join(dataRoot, "load-"));
  const mongod = await MongoMemoryServer.create({ instance: { dbPath } });
  const uri = mongod.getUri() + "loadtest";
  const maxUsers = Math.max(...LEVELS);

  // Seed: production bcrypt cost (12), a 90-question paper (40 SUPR + 50 REAP) like UGEE.
  await mongoose.connect(uri);
  const User = req("models/User");
  const Question = req("models/Question");
  const Test = req("models/Test");
  const Season = req("models/Season");
  const season = await Season.create({ name: "UGEE Load", year: 2026, status: "active", isDefaultActive: true });
  const hash = await bcrypt.hash(PASSWORD, 12);
  await User.insertMany(
    Array.from({ length: maxUsers }, (_, i) => ({
      name: `Load ${i}`,
      email: `load${i}@test.local`,
      status: "active",
      isActivated: true,
      emailVerified: true,
      passwordHash: hash,
    }))
  );
  const questions = await Question.insertMany(
    Array.from({ length: 90 }, (_, i) => ({
      section: i < 40 ? "SUPR" : "REAP",
      topic: ["patterns", "logic", "spatial", "reading", "data"][i % 5],
      difficulty: ["easy", "medium", "hard"][i % 3],
      prompt: `Load question ${i} with some $x^2$ maths`,
      options: ["a", "b", "c", "d"],
      correctOption: i % 4,
      marks: i < 40 ? 4 : 1,
      negativeMarks: i < 40 ? -1 : 0,
    }))
  );
  const test = await Test.create({
    title: "Load Mock",
    isFree: true,
    status: "live",
    seasonId: season._id,
    sectionDurations: { SUPR: 60, REAP: 120 },
    durationMinutes: 180,
    questionIds: questions.map((q) => q._id),
  });
  await mongoose.disconnect();

  const results = [];
  let port = 4990;
  for (const level of LEVELS) {
    port += 1;
    const base = `http://127.0.0.1:${port}`;
    const server = spawn(process.execPath, ["server.js"], {
      cwd: BACKEND,
      // A clean env, and backend/.env is never loaded (ACEIIIT_SKIP_DOTENV).
      env: { PATH: process.env.PATH, HOME: process.env.HOME, ACEIIIT_SKIP_DOTENV: "1", NODE_ENV: "development", MONGODB_URI: uri, PORT: String(port), LOG_LEVEL: "warn", JWT_SECRET: "load-test-jwt-secret-0123456789abcdef", ADMIN_EMAILS: "nobody@test.local", AI_INTERPRETATION_ENABLED: "false", ...(args.threadpool ? { UV_THREADPOOL_SIZE: String(args.threadpool) } : {}) },
    });
    let serverLog = "";
    server.stdout.on("data", (d) => (serverLog += d));
    server.stderr.on("data", (d) => (serverLog += d));
    for (let i = 0; i < 60; i += 1) {
      try {
        if ((await fetch(base + "/ready")).status === 200) break;
      } catch (_e) {}
      await sleep(250);
    }

    const metrics = {};
    const samples = [];
    let maxQueue = { active: 0, queued: 0 };
    const sampler = setInterval(async () => {
      const s = sampleProcess(server.pid);
      if (s) samples.push(s);
      try {
        const ready = await (await fetch(base + "/ready")).json();
        const q = (ready.checks && ready.checks.attemptQueue) || ready.attemptQueue || {};
        maxQueue = { active: Math.max(maxQueue.active, q.active || 0), queued: Math.max(maxQueue.queued, q.queued || q.queueSize || 0) };
      } catch (_e) {}
    }, 250);

    const started = performance.now();
    const outcomes = await Promise.allSettled(
      Array.from({ length: level }, (_, i) => runStudent(base, `load${i}@test.local`, String(test._id), metrics))
    );
    const wallMs = performance.now() - started;
    clearInterval(sampler);
    const failures = outcomes.filter((o) => o.status === "rejected");
    const summary = { level, wallMs: Math.round(wallMs), completed: level - failures.length, failed: failures.length, steps: {} };
    for (const [name, m] of Object.entries(metrics)) {
      summary.steps[name] = {
        n: m.ms.length,
        p50: Math.round(percentile(m.ms, 50)),
        p95: Math.round(percentile(m.ms, 95)),
        p99: Math.round(percentile(m.ms, 99)),
        errors: m.errors,
        statuses: m.statuses,
      };
    }
    summary.cpuPeak = samples.length ? Math.max(...samples.map((s) => s.cpu)) : null;
    summary.rssPeakMb = samples.length ? Math.round(Math.max(...samples.map((s) => s.rssMb))) : null;
    summary.queuePeak = maxQueue;
    summary.sampleErrors = failures.slice(0, 3).map((f) => String(f.reason && f.reason.message).slice(0, 200));
    results.push(summary);

    const s = summary.steps;
    console.log(
      `level=${level} ok=${summary.completed}/${level} wall=${summary.wallMs}ms ` +
        `login p95=${(s.login || {}).p95}ms submit p50/p95/p99=${(s.submit || {}).p50}/${(s.submit || {}).p95}/${(s.submit || {}).p99}ms ` +
        `flow p95=${(s.flow || {}).p95}ms cpu≤${summary.cpuPeak}% rss≤${summary.rssPeakMb}MB queue≤${JSON.stringify(maxQueue)}`
    );
    if (failures.length) console.log("  sample failures:", summary.sampleErrors);
    server.kill("SIGTERM");
    await sleep(800);
    if (/FATAL|uncaught/i.test(serverLog)) console.log("  server log:", serverLog.slice(-800));
  }

  await mongod.stop();
  fs.rmSync(dbPath, { recursive: true, force: true });
  if (args.json) fs.writeFileSync(String(args.json), JSON.stringify({ node: process.version, cpus: require("os").cpus().length, results }, null, 2));
  console.log("\nlevel | ok | login p95 | autosave p95 | submit p50 / p95 / p99 | full flow p95 | CPU peak | RSS peak");
  for (const r of results) {
    const s = r.steps;
    console.log(
      `${r.level} | ${r.completed}/${r.level} | ${(s.login || {}).p95} ms | ${(s.autosave || {}).p95} ms | ${(s.submit || {}).p50} / ${(s.submit || {}).p95} / ${(s.submit || {}).p99} ms | ${(s.flow || {}).p95} ms | ${r.cpuPeak}% | ${r.rssPeakMb} MB`
    );
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
