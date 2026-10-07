// Visual harness: a realistic 90-question UGEE paper, then screenshots of the exam (sidebar
// palette) and the results page at several viewports. Usage:
//   node tests/e2e/ui-shots.e2e.js [outDir]
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const puppeteer = require("puppeteer-core");
const { BACKEND, CHROME_PATH, SHOTS_DIR, serverEnv, newHermeticPage } = require("./helpers");

const OUT = process.argv[2] || path.join(SHOTS_DIR, "ui");
const PORT = 4981;
const BASE = `http://127.0.0.1:${PORT}`;
const req = (m) => require(path.join(BACKEND, m));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const VIEWPORTS = [[1366, 657], [1440, 900], [1024, 700], [390, 800]];

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const { MongoMemoryServer } = req("node_modules/mongodb-memory-server");
  const mongoose = req("node_modules/mongoose");
  const bcrypt = req("node_modules/bcryptjs");
  const dataRoot = path.join(BACKEND, "node_modules/.cache/mongodb-test-data");
  fs.mkdirSync(dataRoot, { recursive: true });
  const dbPath = fs.mkdtempSync(path.join(dataRoot, "ui-"));
  const mongod = await MongoMemoryServer.create({ instance: { dbPath } });
  const uri = mongod.getUri() + "ui";
  await mongoose.connect(uri);
  const Season = req("models/Season");
  const User = req("models/User");
  const Question = req("models/Question");
  const Test = req("models/Test");
  const season = await Season.create({ name: "UGEE 2026", year: 2026, status: "active", isDefaultActive: true });
  await User.create({ name: "Riya Sharma", email: "riya@test.local", status: "active", isActivated: true, emailVerified: true, passwordHash: await bcrypt.hash("Passw0rd!long", 4) });
  const topics = ["electromagnetism", "electrostatics", "3d geometry", "algebra", "vectors", "area under curves", "atomic structure", "basic physics", "trigonometry", "calculus"];
  const qs = await Question.insertMany(Array.from({ length: 90 }, (_, i) => ({
    section: i < 40 ? "SUPR" : "REAP",
    topic: topics[i % topics.length],
    difficulty: ["easy", "medium", "hard"][i % 3],
    prompt: `Question ${i + 1}: If $f(x) = x^2 + ${i}x$, find $f'(1)$.`,
    options: ["A value", "B value", "C value", "D value"],
    correctOption: i % 4,
    marks: i < 40 ? 4 : 1,
    negativeMarks: i < 40 ? -1 : 0,
    explanation: "Differentiate term by term.",
  })));
  const test = await Test.create({ title: "UGEE 2026 Mock Test 1", isFree: true, status: "live", seasonId: season._id, sectionDurations: { SUPR: 60, REAP: 120 }, durationMinutes: 180, questionIds: qs.map((q) => q._id) });
  await mongoose.disconnect();

  const server = spawn(process.execPath, ["server.js"], { cwd: BACKEND, env: serverEnv({ MONGODB_URI: uri, PORT: String(PORT), ADMIN_EMAILS: "nobody@test.local" }) });
  let log = "";
  server.stdout.on("data", (d) => (log += d));
  server.stderr.on("data", (d) => (log += d));
  for (let i = 0; i < 40; i += 1) { try { if ((await fetch(BASE + "/ready")).status === 200) break; } catch (_e) {} await sleep(250); }

  const browser = await puppeteer.launch({ executablePath: CHROME_PATH, headless: true, args: ["--no-sandbox"] });
  const page = await newHermeticPage(browser, { allowFonts: true });
  page.on("dialog", (d) => d.accept());
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    await page.setViewport({ width: 1366, height: 657 });
    await page.goto(`${BASE}/#/login`, { waitUntil: "networkidle2" });
    await page.waitForSelector("#login-email");
    await page.type("#login-email", "riya@test.local");
    await page.type("#login-password", "Passw0rd!long");
    await page.click("#login-submit-btn");
    await page.waitForFunction(() => /dashboard/.test(location.hash), { timeout: 15000 });

    // A finished attempt with a realistic mix, through the API.
    const attemptId = await page.evaluate(async (testId) => {
      const csrf = decodeURIComponent(document.cookie.match(/aceiiit_csrf=([^;]+)/)[1]);
      const h = { "Content-Type": "application/json", "X-CSRF-Token": csrf };
      const s = await (await fetch("/api/attempt/start", { method: "POST", headers: h, body: JSON.stringify({ testId }) })).json();
      const eh = { ...h, "X-Exam-Token": s.examToken };
      const paper = await (await fetch(`/api/attempt/session/${s.session.id}/paper`, { headers: eh })).json();
      const supr = paper.questions.filter((q) => q.section === "SUPR");
      const reap = paper.questions.filter((q) => q.section === "REAP");
      const pick = (list, n) => Object.fromEntries(list.slice(0, n).map((q, i) => [q.id, i % 3]));
      await fetch(`/api/attempt/session/${s.session.id}/answers`, { method: "PUT", headers: eh, body: JSON.stringify({ seq: 1, answers: pick(supr, 22) }) });
      await fetch(`/api/attempt/session/${s.session.id}/advance`, { method: "POST", headers: eh, body: "{}" });
      await fetch(`/api/attempt/session/${s.session.id}/answers`, { method: "PUT", headers: eh, body: JSON.stringify({ seq: 2, answers: pick(reap, 31) }) });
      const sub = await (await fetch("/api/attempt", { method: "POST", headers: { ...eh, "Idempotency-Key": "ui-shots-0001" }, body: JSON.stringify({ sessionId: s.session.id }) })).json();
      return sub.attempt.id;
    }, String(test._id));

    for (const [w, h] of VIEWPORTS) {
      await page.setViewport({ width: w, height: h });
      await page.goto(`${BASE}/#/results/${attemptId}`, { waitUntil: "networkidle2" });
      await sleep(2500);
      await page.screenshot({ path: path.join(OUT, `results-${w}x${h}.png`), fullPage: true });
    }

    // Exam with some palette states.
    await page.setViewport({ width: 1366, height: 657 });
    await page.goto(`${BASE}/#/instructions/${test._id}`, { waitUntil: "networkidle2" });
    await page.waitForSelector("#ready-check");
    await sleep(1200);
    await page.evaluate(() => { const b = document.getElementById("ready-check"); if (!b.checked) b.click(); document.getElementById("begin-test").click(); });
    await page.waitForFunction(() => location.hash.indexOf("#/test/") === 0, { timeout: 15000 });
    await sleep(1500);
    for (let i = 0; i < 6; i += 1) {
      await page.evaluate((i) => {
        const opt = document.querySelectorAll(".option-card, [data-option-index]")[i % 4];
        if (opt) opt.click();
        const btn = document.getElementById(i % 3 === 2 ? "mark-next" : "save-next");
        if (btn) btn.click();
      }, i);
      await sleep(300);
    }
    for (const [w, h] of VIEWPORTS) {
      await page.setViewport({ width: w, height: h });
      await sleep(900);
      await page.screenshot({ path: path.join(OUT, `exam-${w}x${h}.png`) });
    }
  } catch (err) {
    console.error("ERROR", err.message);
    console.error(log.slice(-1500));
  } finally {
    await browser.close();
    server.kill("SIGTERM");
    await sleep(400);
    await mongod.stop();
    fs.rmSync(dbPath, { recursive: true, force: true });
  }
  if (errors.length) console.log("page errors:", errors.slice(0, 5));
  console.log("shots in", OUT, fs.readdirSync(OUT).join(", "));
})();
