// Browser checks for custom practice and the results page:
// - the builder lists real subjects; a REAP-only paper opens in REAP (it used to submit the
//   moment it opened) and a SUPR-only untimed paper offers "Submit test", no countdown;
// - practice results are unranked; mock stats on the dashboard leave practice out;
// - the dashboard eyebrow names the next UGEE once the set exam date has passed, and the
//   greeting capitalises the name;
// - the AI coach card renders from a ready AI interpretation (intercepted here).
// Usage: node tests/e2e/practice.e2e.js
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const puppeteer = require("puppeteer-core");
const { BACKEND, CHROME_PATH, SHOTS_DIR, serverEnv, newHermeticPage } = require("./helpers");

const PORT = 4986;
const BASE = `http://127.0.0.1:${PORT}`;
const req = (m) => require(path.join(BACKEND, m));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log("[practice-e2e]", ...a);
const SHOTS = path.join(SHOTS_DIR, "practice");

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const { MongoMemoryServer } = req("node_modules/mongodb-memory-server");
  const mongoose = req("node_modules/mongoose");
  const bcrypt = req("node_modules/bcryptjs");
  const dataRoot = path.join(BACKEND, "node_modules/.cache/mongodb-test-data");
  fs.mkdirSync(dataRoot, { recursive: true });
  const dbPath = fs.mkdtempSync(path.join(dataRoot, "practice-e2e-"));
  const mongod = await MongoMemoryServer.create({ instance: { dbPath } });
  const uri = mongod.getUri() + "practicee2e";
  await mongoose.connect(uri);
  const User = req("models/User");
  const Question = req("models/Question");
  const Test = req("models/Test");
  const Season = req("models/Season");
  const Entitlement = req("models/Entitlement");
  const AppConfig = req("models/AppConfig");
  const season = await Season.create({ name: "UGEE 2026", year: 2026, status: "active", isDefaultActive: true });
  const hash = await bcrypt.hash("Passw0rd!long", 4);
  const student = await User.create({ name: "marco rossi", email: "marco@test.local", status: "active", isActivated: true, emailVerified: true, passwordHash: hash });
  // Paid, so more than one custom practice session is allowed.
  await Entitlement.create({ userId: student._id, email: student.email, normalizedEmail: student.email, seasonId: season._id, tier: "paid", status: "active", source: "admin" });
  const qs = await Question.insertMany([
    ...Array.from({ length: 8 }, (_, i) => ({ section: "SUPR", topic: "algebra", difficulty: "medium", prompt: `SUPR algebra ${i + 1}`, options: ["a", "b", "c", "d"], correctOption: 0, marks: 4, negativeMarks: -1 })),
    // "puzzles" has too few questions for the smallest practice paper, so students don't see it.
    ...Array.from({ length: 2 }, (_, i) => ({ section: "REAP", topic: "puzzles", difficulty: "medium", prompt: `REAP puzzle ${i + 1}`, options: ["a", "b", "c", "d"], correctOption: 1, marks: 4, negativeMarks: -1 })),
    ...Array.from({ length: 5 }, (_, i) => ({ section: "REAP", topic: "logic", difficulty: "medium", prompt: `REAP logic ${i + 1}`, options: ["a", "b", "c", "d"], correctOption: 1, marks: 4, negativeMarks: -1 })),
  ]);
  const mock = await Test.create({ title: "UGEE 2026 Mock Test 1", isFree: true, status: "live", seasonId: season._id, sectionDurations: { SUPR: 60, REAP: 120 }, durationMinutes: 180, questionIds: qs.map((q) => q._id) });
  // The set exam date is past (170 days ago): students now prepare for the next one.
  const examDate = new Date(Date.now() - 170 * 24 * 60 * 60 * 1000);
  const nextExam = new Date(examDate.getTime());
  while (nextExam < new Date()) nextExam.setFullYear(nextExam.getFullYear() + 1);
  await AppConfig.updateOne({ key: "global" }, { $set: { ugeeExamDate: examDate } }, { upsert: true });
  await mongoose.disconnect();

  const server = spawn(process.execPath, ["server.js"], { cwd: BACKEND, env: serverEnv({ MONGODB_URI: uri, PORT: String(PORT) }) });
  let serverLog = "";
  server.stdout.on("data", (d) => (serverLog += d));
  server.stderr.on("data", (d) => (serverLog += d));
  for (let i = 0; i < 40; i += 1) { try { if ((await fetch(`${BASE}/ready`)).status === 200) break; } catch (_e) { /* not up yet */ } await sleep(250); }

  const browser = await puppeteer.launch({ executablePath: CHROME_PATH, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  const failures = [];
  const pageErrors = [];
  const check = (cond, msg) => { (cond ? log("PASS", msg) : (log("FAIL", msg), failures.push(msg))); };
  const text = (page) => page.evaluate(() => document.body.innerText);
  try {
    const page = await newHermeticPage(browser);
    await page.setViewport({ width: 1366, height: 900 });
    page.on("pageerror", (e) => pageErrors.push(e.stack || e.message));
    page.on("dialog", async (d) => { log("dialog:", d.message().split("\n")[0]); await d.accept(); });
    await page.goto(`${BASE}/#/login`, { waitUntil: "networkidle2" });
    await page.waitForSelector("#login-email");
    await page.type("#login-email", "marco@test.local");
    await page.type("#login-password", "Passw0rd!long");
    await page.click("#login-submit-btn");
    await page.waitForFunction(() => /dashboard/.test(location.hash), { timeout: 15000 });
    await page.waitForSelector(".hero-eyebrow-row", { timeout: 15000 });

    // ---- Dashboard header ----
    const header = await page.evaluate(() => {
      const row = document.querySelector(".hero-eyebrow-row");
      const label = row.querySelector(".section-label");
      return {
        eyebrow: row.innerText,
        title: document.querySelector(".hero-title").innerText,
        align: getComputedStyle(row).alignItems,
        labelMargin: getComputedStyle(label).marginBottom,
      };
    });
    check(header.eyebrow.indexOf(`UGEE ${nextExam.getFullYear()} PREPARATION`) !== -1, `eyebrow names the next UGEE after the exam date passed (${header.eyebrow.replace(/\s+/g, " ")})`);
    check(/\nMarco$/.test(header.title), `greeting capitalises the name (${header.title.replace(/\n/g, " / ")})`);
    check(header.align === "baseline" && header.labelMargin === "0px", "eyebrow label shares the date line's baseline (no stray bottom margin)");

    // ---- A mock attempt, through the API, for the results checks ----
    const mockAttemptId = await page.evaluate(async (testId) => {
      const csrf = decodeURIComponent(document.cookie.match(/aceiiit_csrf=([^;]+)/)[1]);
      const h = { "Content-Type": "application/json", "X-CSRF-Token": csrf };
      const s = await (await fetch("/api/attempt/start", { method: "POST", headers: h, body: JSON.stringify({ testId }) })).json();
      const eh = { ...h, "X-Exam-Token": s.examToken };
      const paper = await (await fetch(`/api/attempt/session/${s.session.id}/paper`, { headers: eh })).json();
      const supr = paper.questions.filter((q) => q.section === "SUPR"); // 8 of 15: not "ended early"
      await fetch(`/api/attempt/session/${s.session.id}/answers`, { method: "PUT", headers: eh, body: JSON.stringify({ seq: 1, answers: Object.fromEntries(supr.map((q) => [q.id, 0])) }) });
      const out = await (await fetch("/api/attempt", { method: "POST", headers: { ...eh, "Idempotency-Key": "practice-e2e-mock-1" }, body: JSON.stringify({ sessionId: s.session.id }) })).json();
      return out.attempt.id;
    }, String(mock._id));

    // ---- Practice builder: real subjects ----
    await page.goto(`${BASE}/#/exams/practice`, { waitUntil: "networkidle2" });
    await page.waitForFunction(() => /Algebra/.test((document.getElementById("prac-subject") || {}).innerText || ""), { timeout: 15000 }).catch(() => null);
    const subjects = await page.$$eval("#prac-subject option", (opts) => opts.map((o) => o.textContent));
    check(subjects.includes("REAP – all topics") && subjects.includes("Algebra") && subjects.includes("Logic"), `practice subjects come from real topics (${subjects.join(", ")})`);
    check(subjects.every((s) => !/\d/.test(s)) && !subjects.includes("Puzzles"), "students see no question counts, and topics too thin to practise are hidden");
    await page.select("#prac-subject", "REAP");
    const sizes = await page.evaluate(() => ({
      enabled: Array.from(document.querySelectorAll("#prac-count option")).filter((o) => !o.disabled).map((o) => o.value),
      value: document.getElementById("prac-count").value,
      note: document.getElementById("practice-availability").textContent,
    }));
    check(sizes.enabled.join(",") === "5" && sizes.value === "5" && /aren't available/.test(sizes.note) && !/\d/.test(sizes.note), `sizes a subject can't fill are greyed out, with a reason and no numbers (${sizes.enabled.join(",")}; "${sizes.note}")`);
    await page.select("#prac-difficulty", "hard");
    await page.waitForFunction(() => /No practice questions/.test((document.getElementById("practice-availability") || {}).textContent || ""), { timeout: 10000 }).catch(() => null);
    check(await page.$eval("#start-practice-btn", (b) => b.disabled), "a difficulty with no questions disables Start and says why");
    await page.select("#prac-difficulty", "all");
    await page.waitForFunction(() => !document.getElementById("start-practice-btn").disabled, { timeout: 10000 }).catch(() => null);

    // ---- REAP-only practice: opens in REAP, is not submitted ----
    await page.select("#prac-subject", "REAP");
    await page.select("#prac-timer", "15");
    await page.click("#start-practice-btn");
    await page.waitForFunction(() => /#\/instructions\//.test(location.hash), { timeout: 15000 });
    await page.waitForSelector("#ready-check", { timeout: 15000 });
    const reapInstructions = await text(page);
    check(/SECTION 1: REAP \| Duration: 15 minutes/.test(reapInstructions) && !/SECTION \d: SUPR/.test(reapInstructions), "instructions list only REAP, with all 15 minutes");
    await page.evaluate(() => { const b = document.getElementById("ready-check"); if (!b.checked) b.click(); });
    await page.evaluate(() => document.getElementById("begin-test").click());
    await page.waitForFunction(() => location.hash.indexOf("#/test/") === 0, { timeout: 15000 });
    await sleep(3500);
    const reapExam = await page.evaluate(() => ({
      hash: location.hash,
      tabs: Array.from(document.querySelectorAll(".exam-sectionbar [data-section]")).map((b) => b.dataset.section),
      body: document.body.innerText,
    }));
    check(reapExam.hash.indexOf("#/test/") === 0 && /REAP (logic|puzzle)/.test(reapExam.body), "REAP-only practice opens on its REAP questions and is not submitted");
    check(reapExam.tabs.join(",") === "REAP", `the section bar shows only REAP (${reapExam.tabs.join(",")})`);
    await page.evaluate(() => document.getElementById("submit-test").click());
    await page.waitForSelector('[data-transition-action="confirm"]', { timeout: 10000 });
    check(/Submit test/.test(await text(page)), "Submit on the REAP-only paper submits the paper");
    await page.evaluate(() => document.querySelector('[data-transition-action="confirm"]').click());
    await page.waitForFunction(() => location.hash.indexOf("#/results/") === 0, { timeout: 20000 });
    await page.waitForSelector(".rs-kpis", { timeout: 15000 });
    await sleep(1500);
    const practiceResult = await page.evaluate(() => ({
      eyebrow: document.querySelector(".rs-hero .section-label").innerText,
      labels: Array.from(document.querySelectorAll(".rs-kpi-label")).map((l) => l.innerText.toUpperCase()),
      coach: !!document.querySelector("#rs-coach-root, .rs-coach"),
    }));
    check(/^PRACTICE SESSION/i.test(practiceResult.eyebrow), "practice results say Practice session");
    check(practiceResult.labels.indexOf("RANK") === -1 && practiceResult.labels.indexOf("PERCENTILE") === -1 && practiceResult.labels.length === 4, `practice results have no rank or percentile tiles (${practiceResult.labels.join(", ")})`);
    check(!practiceResult.coach, "no AI coach card for practice");

    // ---- SUPR-only untimed practice: no countdown, "Submit test" ----
    await page.goto(`${BASE}/#/exams/practice`, { waitUntil: "networkidle2" });
    await page.waitForFunction(() => /SUPR – all topics/.test((document.getElementById("prac-subject") || {}).innerText || ""), { timeout: 15000 }).catch(() => null);
    await page.select("#prac-subject", "SUPR");
    await page.select("#prac-timer", "0");
    await page.click("#start-practice-btn");
    await page.waitForSelector("#ready-check", { timeout: 15000 });
    check(/has no time limit/.test(await text(page)), "untimed instructions say there is no time limit");
    await page.evaluate(() => { const b = document.getElementById("ready-check"); if (!b.checked) b.click(); });
    await page.evaluate(() => document.getElementById("begin-test").click());
    await page.waitForFunction(() => location.hash.indexOf("#/test/") === 0, { timeout: 15000 });
    await page.waitForFunction(() => /SUPR algebra/.test(document.body.innerText), { timeout: 15000 });
    check(/Untimed practice/.test(await text(page)) && !(await page.$("#timer-display")), "untimed practice shows no countdown");
    await page.evaluate(() => document.getElementById("submit-test").click());
    await page.waitForSelector('[data-transition-action="confirm"]', { timeout: 10000 });
    const modal = await text(page);
    check(/Submit test/.test(modal) && !/move to REAP/.test(modal), "a SUPR-only paper offers Submit test, not Submit SUPR");
    await page.evaluate(() => document.querySelector('[data-transition-action="confirm"]').click());
    await page.waitForFunction(() => location.hash.indexOf("#/results/") === 0, { timeout: 20000 });

    // ---- Dashboard mock stats leave practice out ----
    await page.goto(`${BASE}/#/dashboard`, { waitUntil: "networkidle2" });
    await page.waitForSelector(".hero-progress", { timeout: 15000 });
    const mocksCompleted = await page.evaluate(() => {
      const stat = Array.from(document.querySelectorAll(".hero-stat")).find((s) => /Mocks completed/i.test(s.innerText));
      return stat ? stat.querySelector("strong").innerText : "";
    });
    check(mocksCompleted === "1", `dashboard counts 1 mock, not the 2 practice sessions (${mocksCompleted})`);

    // ---- Progress: section accuracy as donuts ----
    await page.goto(`${BASE}/#/progress/performance`, { waitUntil: "networkidle2" });
    await page.waitForSelector(".progress-donut", { timeout: 15000 }).catch(() => null);
    const donuts = await page.evaluate(() => Array.from(document.querySelectorAll(".progress-donut")).map((d) => ({
      name: d.querySelector("figcaption").textContent,
      center: d.querySelector(".donut-center strong").textContent,
      label: d.querySelector(".donut").getAttribute("aria-label"),
      legend: Array.from(d.querySelectorAll(".progress-donut-legend li")).map((li) => li.innerText.replace(/\s+/g, " ").trim()),
      slices: d.querySelectorAll(".donut-seg").length,
      note: d.querySelector(".progress-donut-note").textContent,
      overflow: d.getBoundingClientRect().right > document.documentElement.clientWidth,
    })));
    check(donuts.length >= 1 && donuts.every((d) => (/^\d+(\.\d+)?%$/.test(d.center) || (d.center === "—" && /^0 of/.test(d.note))) && d.slices >= 1 && /accuracy|no questions answered/.test(d.label)), `section accuracy shows a donut per section with the accuracy in the middle (${donuts.map((d) => d.name + " " + d.center).join(", ")})`);
    check(donuts.every((d) => d.legend.length === 3 && /^Correct \d+$/.test(d.legend[0]) && /attempted$/.test(d.note) && !d.overflow), "each donut has a numbered legend and an attempted count, inside the page");

    // ---- AI coach card (intercepted ready interpretation) ----
    page.interceptHook = async (request) => {
      if (!request.url().endsWith(`/api/analysis/${mockAttemptId}/interpretation`)) return false;
      await request.respond({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ interpretation: {
          status: "ready", source: "ai", pending: false,
          result: {
            headline: "Steady SUPR start; REAP is the gap",
            summary: "You answered SUPR questions with care. REAP was left untouched, so the next mock should open it early.",
            strengths: ["Calm, accurate SUPR answers."],
            priorityAreas: [{ topic: "logic", reason: "No REAP answers yet.", action: "Do a short timed REAP set." }],
            behaviorPatterns: ["You stopped before REAP."],
            nextTestStrategy: ["Start REAP with 40 minutes left.", "Mark and move on when stuck."],
          },
        } }),
      });
      return true;
    };
    await page.goto(`${BASE}/#/results/${mockAttemptId}`, { waitUntil: "networkidle2" });
    await page.waitForSelector(".rs-coach", { timeout: 15000 }).catch(() => null);
    const coach = await page.evaluate(() => {
      const card = document.querySelector(".rs-coach");
      if (!card) return null;
      const kpis = document.querySelector(".rs-kpis");
      return {
        text: card.innerText,
        afterKpis: !!(kpis && (kpis.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING)),
        beforePlan: !!(document.querySelector(".rs-plan") && (card.compareDocumentPosition(document.querySelector(".rs-plan")) & Node.DOCUMENT_POSITION_FOLLOWING)),
      };
    });
    check(coach && /Steady SUPR start/.test(coach.text) && /Focus next/i.test(coach.text) && /Strategy for your next mock/i.test(coach.text) && /AI-assisted/i.test(coach.text), "the AI coach card shows the headline, focus areas and strategy");
    check(coach && coach.afterKpis && coach.beforePlan, "the coach card sits after the score tiles and before the plan");
    if (coach) {
      await page.evaluate(() => document.querySelector(".rs-coach").scrollIntoView({ block: "start" }));
      await sleep(300);
      await page.screenshot({ path: path.join(SHOTS, "results-coach-1366.png") });
    }
    page.interceptHook = null;
    check(pageErrors.length === 0, `no page errors (${pageErrors.length})`);
  } catch (err) {
    failures.push(`exception: ${err.message}`);
    log("EXCEPTION", err.stack);
  } finally {
    await browser.close();
    server.kill("SIGTERM");
    await sleep(300);
    await mongod.stop();
    fs.rmSync(dbPath, { recursive: true, force: true });
  }
  if (pageErrors.length) log("page errors:", pageErrors.slice(0, 5));
  const serverErrors = serverLog.split("\n").filter((l) => /Error|rror:/.test(l) && !/MONGOOSE/.test(l));
  if (serverErrors.length) log("server errors:", serverErrors.slice(0, 10));
  log(failures.length ? `FAILED (${failures.length})` : "ALL PASSED");
  process.exit(failures.length ? 1 : 0);
})();
