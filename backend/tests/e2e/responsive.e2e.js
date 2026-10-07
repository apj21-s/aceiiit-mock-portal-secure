// Responsive audit: every key route at 8 widths. Reports horizontal page overflow, the
// elements causing it, and nested vertical scrollers; writes screenshots to the E2E shots dir.
// Usage: node tests/e2e/responsive.e2e.js [route,route...]   (exits 1 on any issue)
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const puppeteer = require("puppeteer-core");
const { BACKEND, CHROME_PATH, SHOTS_DIR, serverEnv, newHermeticPage } = require("./helpers");

const ONLY = process.argv[2] ? process.argv[2].split(",") : null;
// FULL=1 captures full-page screenshots of the student routes (for manual review).
const FULL = !!process.env.FULL;
const PORT = 4979;
const BASE = `http://127.0.0.1:${PORT}`;
// Phones get mobile + touch emulation; landscape phones are their own viewports.
const VIEWPORTS = [
  ...[320, 360, 375, 390, 412, 430, 480].map((w) => ({ name: String(w), width: w, height: 800, isMobile: true, hasTouch: true })),
  { name: "768", width: 768, height: 1024, isMobile: true, hasTouch: true },
  { name: "1024", width: 1024, height: 900 },
  { name: "1280", width: 1280, height: 900 },
  { name: "1440", width: 1440, height: 900 },
  { name: "landscape-667x375", width: 667, height: 375, isMobile: true, hasTouch: true },
  { name: "landscape-812x375", width: 812, height: 375, isMobile: true, hasTouch: true },
  { name: "landscape-844x390", width: 844, height: 390, isMobile: true, hasTouch: true },
];
const LANDSCAPE = (vp) => vp.name.startsWith("landscape");
let crashed = false;
const req = (m) => require(path.join(BACKEND, m));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SHOTS = path.join(SHOTS_DIR, "responsive");
fs.mkdirSync(SHOTS, { recursive: true });

async function login(page, email) {
  await page.goto(`${BASE}/#/login`, { waitUntil: "networkidle2" });
  await page.waitForSelector("#login-email", { timeout: 15000 });
  await page.type("#login-email", email);
  await page.type("#login-password", "Passw0rd!long");
  await page.click("#login-submit-btn");
  await page.waitForFunction(() => location.hash.length > 2 && !/login/.test(location.hash), { timeout: 15000 });
}

async function measure(page) {
  return page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const scrollW = document.scrollingElement.scrollWidth;
    const offenders = [];
    if (scrollW > vw + 1) {
      document.querySelectorAll("body *").forEach((el) => {
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) return;
        const cs = getComputedStyle(el);
        if (cs.position === "fixed" && cs.visibility === "hidden") return;
        if (r.right > vw + 1 && !el.closest(".mobile-nav-drawer")) {
          // Skip descendants of an element that already clips horizontally.
          let p = el.parentElement;
          while (p && p !== document.body) {
            const ps = getComputedStyle(p);
            if (/(auto|scroll|hidden|clip)/.test(ps.overflowX)) return;
            p = p.parentElement;
          }
          const id = el.id ? "#" + el.id : "";
          const cls = typeof el.className === "string" && el.className ? "." + el.className.trim().split(/\s+/).slice(0, 2).join(".") : "";
          let tf = ""; let q = el.parentElement;
          while (q && q !== document.documentElement) { const qs = getComputedStyle(q); if (qs.transform !== "none" || qs.filter !== "none" || qs.contain.indexOf("paint") !== -1) { tf = ` [transformed ancestor: ${q.tagName.toLowerCase()}.${String(q.className).split(/\s+/)[0]} ${qs.transform !== "none" ? qs.transform : qs.filter}]`; break; } q = q.parentElement; }
          offenders.push({ right: r.right, text: `${el.tagName.toLowerCase()}${id}${cls} pos=${cs.position} right=${Math.round(r.right)} w=${Math.round(r.width)}${tf}` });
        }
      });
    }
    // Nested vertical scrollers that are actually scrollable while the page also scrolls.
    const pageScrolls = document.scrollingElement.scrollHeight > window.innerHeight + 1;
    const nested = [];
    document.querySelectorAll("body *").forEach((el) => {
      const cs = getComputedStyle(el);
      if (/(auto|scroll)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 4 && el.clientHeight > window.innerHeight * 0.6) {
        nested.push(`${el.tagName.toLowerCase()}${el.id ? "#" + el.id : ""}.${String(el.className).trim().split(/\s+/).slice(0, 3).join(".")} h=${el.clientHeight}/${window.innerHeight}`);
      }
    });
    return { vw, scrollW, offenders: offenders.sort((a, b) => b.right - a.right).slice(0, 5).map((o) => o.text), doubleScroll: pageScrolls && nested.length ? nested.slice(0, 4) : [] };
  });
}

(async () => {
  const { MongoMemoryServer } = req("node_modules/mongodb-memory-server");
  const mongoose = req("node_modules/mongoose");
  const bcrypt = req("node_modules/bcryptjs");
  const dataRoot = path.join(BACKEND, "node_modules/.cache/mongodb-test-data");
  fs.mkdirSync(dataRoot, { recursive: true });
  const dbPath = fs.mkdtempSync(path.join(dataRoot, "resp-"));
  const mongod = await MongoMemoryServer.create({ instance: { dbPath } });
  const uri = mongod.getUri() + "resp";

  await mongoose.connect(uri);
  const User = req("models/User");
  const Question = req("models/Question");
  const Test = req("models/Test");
  const Season = req("models/Season");
  const season = await Season.create({ name: "UGEE 2026", year: 2026, status: "active", isDefaultActive: true });
  const hash = await bcrypt.hash("Passw0rd!long", 4);
  await User.create({ name: "Responsive Student With A Long Name", email: "student@test.local", status: "active", isActivated: true, emailVerified: true, passwordHash: hash });
  await User.create({ name: "Admin", email: "admin@test.local", role: "admin", status: "active", isActivated: true, emailVerified: true, passwordHash: hash });
  const longPrompt = "A train travels between two stations at a uniform speed of $v = \\frac{d}{t}$ and covers $\\sum_{i=1}^{n} x_i^2 + \\int_0^1 f(x)\\,dx$ kilometres; find the expected arrival given the following long expression $a_1 + a_2 + a_3 + a_4 + a_5 + a_6 + a_7 + a_8 + a_9 + a_{10} + a_{11} + a_{12}$.";
  const qs = await Question.insertMany([
    { section: "SUPR", topic: "patterns", prompt: longPrompt, options: ["Option with $\\sqrt{2}$", "b", "c", "d"], correctOption: 1, marks: 4, negativeMarks: -1, explanation: "Because." },
    { section: "SUPR", topic: "logic", prompt: "SUPR question two", options: ["a", "b", "c", "d"], correctOption: 2, marks: 4, negativeMarks: -1 },
    { section: "REAP", topic: "reading", prompt: "REAP question one", passage: "Passage text. ".repeat(80), options: ["a", "b", "c", "d"], correctOption: 0, marks: 4, negativeMarks: -1 },
  ]);
  const test = await Test.create({ title: "Responsive Free Mock", isFree: true, status: "live", seasonId: season._id, sectionDurations: { SUPR: 30, REAP: 30 }, durationMinutes: 60, questionIds: qs.map((q) => q._id) });
  await mongoose.disconnect();

  const server = spawn(process.execPath, ["server.js"], {
    cwd: BACKEND,
    env: serverEnv({ MONGODB_URI: uri, PORT: String(PORT), ADMIN_EMAILS: "admin@test.local" }),
  });
  let serverLog = "";
  server.stdout.on("data", (d) => (serverLog += d));
  server.stderr.on("data", (d) => (serverLog += d));
  await sleep(3500);

  const browser = await puppeteer.launch({ executablePath: CHROME_PATH, headless: true, args: ["--no-sandbox"] });
  const problems = [];
  try {
    // Student: create one finished attempt for the results page.
    const ctx = await browser.createBrowserContext();
    const page = await newHermeticPage(ctx);
    page.on("dialog", (d) => d.accept());
    await page.setViewport({ width: 1280, height: 900 });
    await login(page, "student@test.local");
    const { attemptId } = await page.evaluate(async (testId) => {
      const csrf = document.cookie.match(/aceiiit_csrf=([^;]+)/)[1];
      const h = { "Content-Type": "application/json", "X-CSRF-Token": decodeURIComponent(csrf) };
      const s = await (await fetch("/api/attempt/start", { method: "POST", headers: h, body: JSON.stringify({ testId }) })).json();
      const sub = await (await fetch("/api/attempt", { method: "POST", headers: { ...h, "X-Exam-Token": s.examToken, "Idempotency-Key": "resp-audit-0001" }, body: JSON.stringify({ sessionId: s.session.id }) })).json();
      return { attemptId: sub.attempt.id };
    }, String(test._id));

    const studentRoutes = [
      ["dashboard", "#/dashboard"],
      ["exams", "#/exams"],
      ["progress", "#/progress"],
      ["account", "#/account"],
      ["resources", "#/resources"],
      ["updates", "#/updates"],
      ["instructions", `#/instructions/${test._id}`],
      ["results", `#/results/${attemptId}`],
    ];
    for (const vp of VIEWPORTS) {
      const width = vp.name;
      await page.setViewport(vp);
      for (const [name, hash] of studentRoutes) {
        if (ONLY && !ONLY.includes(name)) continue;
        // Landscape phones matter for the exam flow (instructions/exam); other pages are portrait.
        if (LANDSCAPE(vp) && name !== "instructions") continue;
        await page.goto(`${BASE}/${hash}`, { waitUntil: "networkidle2" });
        await sleep(900);
        const m = await measure(page);
        await page.screenshot({ path: path.join(SHOTS, `${name}-${width}.png`), fullPage: FULL });
        if (m.offenders.length || m.doubleScroll.length) problems.push({ name, width, ...m });
      }
      // Exam screen
      if (!ONLY || ONLY.includes("exam")) {
        await page.goto(`${BASE}/#/instructions/${test._id}`, { waitUntil: "networkidle2" });
        await page.waitForSelector("#ready-check", { timeout: 15000 });
        await sleep(1200);
        await page.evaluate(() => { const b = document.getElementById("ready-check"); if (!b.checked) b.click(); });
        await page.evaluate(() => document.getElementById("begin-test").click());
        await page.waitForFunction(() => location.hash.indexOf("#/test/") === 0, { timeout: 15000 });
        await sleep(1500);
        const m = await measure(page);
        await page.screenshot({ path: path.join(SHOTS, `exam-${width}.png`) });
        if (m.offenders.length || m.doubleScroll.length) problems.push({ name: "exam", width, ...m });
        // Abandon so the next width can start fresh.
        await page.evaluate(async () => {
          const csrf = decodeURIComponent(document.cookie.match(/aceiiit_csrf=([^;]+)/)[1]);
          const active = await (await fetch("/api/attempt/sessions/active")).json();
          for (const s of active.sessions || []) {
            const tok = sessionStorage.getItem("aceiiit.exam." + s.id) || "";
            await fetch(`/api/attempt/session/${s.id}/abandon`, { method: "POST", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf, "X-Exam-Token": tok }, body: "{}" });
          }
        });
        await page.evaluate(() => window.onbeforeunload = null);
      }
    }
    await ctx.close();

    if (!ONLY || ONLY.includes("admin") || ONLY.includes("login")) {
      const actx = await browser.createBrowserContext();
      const apage = await newHermeticPage(actx);
      apage.on("dialog", (d) => d.accept());
      for (const vp of VIEWPORTS) {
        const width = vp.name;
        await apage.setViewport(vp);
        for (const [name, hash] of [["login", "#/login"], ["forgot-password", "#/forgot-password"]]) {
          if (LANDSCAPE(vp) && name !== "login") continue;
          await apage.goto(`${BASE}/${hash}`, { waitUntil: "networkidle2" });
          await sleep(600);
          const m = await measure(apage);
          await apage.screenshot({ path: path.join(SHOTS, `${name}-${width}.png`) });
          if (m.offenders.length || m.doubleScroll.length) problems.push({ name, width, ...m });
        }
      }
      await apage.setViewport({ width: 1280, height: 900 });
      await login(apage, "admin@test.local");
      for (const vp of VIEWPORTS) {
        if (LANDSCAPE(vp)) continue;
        const width = vp.name;
        await apage.setViewport(vp);
        await apage.goto(`${BASE}/#/admin`, { waitUntil: "networkidle2" });
        await sleep(1200);
        const m = await measure(apage);
        await apage.screenshot({ path: path.join(SHOTS, `admin-${width}.png`) });
        if (m.offenders.length || m.doubleScroll.length) problems.push({ name: "admin", width, ...m });
      }
    }
  } catch (err) {
    crashed = true;
    console.error("audit error", err);
    console.error(serverLog.slice(-3000));
  } finally {
    await browser.close();
    server.kill("SIGTERM");
    await sleep(500);
    await mongod.stop();
    fs.rmSync(dbPath, { recursive: true, force: true });
  }
  console.log(JSON.stringify(problems, null, 1));
  console.log(`${problems.length} route/width combinations with issues`);
  if (crashed) console.log("the audit crashed before finishing (see 'audit error' above)");
  process.exit(problems.length || crashed ? 1 : 0);
})();
