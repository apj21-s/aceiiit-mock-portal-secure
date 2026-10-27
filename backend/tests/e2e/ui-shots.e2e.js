// Visual harness: a realistic 90-question UGEE paper, then screenshots of the exam (sidebar
// palette), the results page, the dashboard and Admin Studio at several viewports. Usage:
//   node tests/e2e/ui-shots.e2e.js [outDir]
// UI_PUBLIC=<dir> serves the frontend (index.html, js, css, assets) from <dir> instead of
// public/, against the same server and data: e.g. a `git archive HEAD backend/public`
// export, for a before/after comparison of a frontend change.
// SWEEP=student|exam|dark|admin (comma-separated, or "all") swaps the standard captures for a
// page-by-page layout review: every student sub-tab and saved bookmarks at three widths; a
// short- and a long-passage exam question; key pages in dark theme; every Admin Studio tab.
// Run the parts as separate processes on slow machines: dozens of tall captures in one
// headless session can exhaust the renderer (net::ERR_INSUFFICIENT_RESOURCES).
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
const VIEWPORTS = [[1280, 800], [1366, 657], [1440, 900], [1024, 700], [390, 800]];
const UI_PUBLIC = process.env.UI_PUBLIC ? path.resolve(process.env.UI_PUBLIC) : null;
const SWEEP_PARTS = String(process.env.SWEEP || "").split(",").map((p) => p.trim()).filter(Boolean);
const SWEEP = SWEEP_PARTS.length > 0;
const sweeping = (part) => SWEEP_PARTS.includes(part) || SWEEP_PARTS.includes("all") || SWEEP_PARTS.includes("1");
// SWEEP_SIZES=390x800,360x780,320x640 overrides the sweep's viewports (e.g. a phone-only pass).
const SWEEP_VIEWPORTS = process.env.SWEEP_SIZES
  ? process.env.SWEEP_SIZES.split(",").map((v) => v.trim().split("x").map(Number)).filter((v) => v[0] > 0 && v[1] > 0)
  : [[1366, 657], [1440, 900], [390, 800]];
const STUDENT_ROUTES = [
  "dashboard", "exams/practice", "exams/mock-tests", "exams/live-tests", "progress/performance", "progress/reports",
  "resources/bookmarks", "resources/materials", "updates/notices", "updates/events", "account/profile", "account/package", "account/security",
];
const STUDIO_TABS = ["setup", "questions", "bank", "review", "tests", "payments", "seasons", "audit", "materials"];
// Pasted-from-PDF text: an instruction passage and hard line breaks mid-sentence (exam Q2).
const MULTILINE_PROMPT = "Choose the incorrect statement:\n(a) The electric lines of force entering into a\nGaussian surface provide negative flux.\n(b) A charge $q$ is placed at the centre of a\ncube. The flux through all the faces will be\nthe same.\n(c) In a uniform electric field net flux through a closed Gaussian surface containing no net charge, is\nzero.\n(d) When an electric field is parallel to a\nGaussian surface, it provides a finite non-zero\nflux.";
const LONG_PASSAGE = Array.from({ length: 6 }, (_, i) => `Paragraph ${i + 1}. A long comprehension passage keeps the split view so that the options stay visible while the candidate reads; it runs well past six hundred characters in total.`).join("\n\n");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".woff2": "font/woff2", ".json": "application/json", ".ico": "image/x-icon" };

// Deterministic captures: no animations/transitions/caret blink, fonts loaded.
async function settle(page, ms) {
  // Injected once per document (repeated tags pile up in the SPA's head and slow every style
  // recalc). .analysis-stage fades in from opacity:0, so with animations off it is pinned visible.
  await page.evaluate(() => {
    if (document.getElementById("ui-shots-settle")) return;
    const style = document.createElement("style");
    style.id = "ui-shots-settle";
    style.textContent = "*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}.analysis-stage{opacity:1!important;transform:none!important}";
    document.head.appendChild(style);
  }).catch(() => {});
  await page.evaluate(() => document.fonts && document.fonts.ready).catch(() => {});
  await sleep(ms);
}

// In-app route change for the sweep: hash navigation re-renders the SPA without waiting on
// network idle (the results page keeps polling its interpretation, which stalls networkidle2).
async function visit(page, route) {
  await page.evaluate((hash) => {
    if (location.hash === hash) window.dispatchEvent(new HashChangeEvent("hashchange"));
    else location.hash = hash;
  }, "#/" + route);
  await sleep(1500);
}

// Long-page capture for the sweep: grow the viewport to the document height and take a plain
// screenshot. Headless Chrome's fullPage capture intermittently stalls on these long pages.
async function shoot(page, file) {
  const vp = page.viewport();
  const height = await page.evaluate(() => Math.min(9000, Math.ceil(document.documentElement.scrollHeight)));
  await page.setViewport({ ...vp, height: Math.max(vp.height, height) });
  await sleep(250);
  await page.screenshot({ path: file });
  await page.setViewport(vp);
}

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
  await User.create({ name: "Admin", email: "admin@test.local", role: "admin", status: "active", isActivated: true, emailVerified: true, passwordHash: await bcrypt.hash("Passw0rd!long", 4) });
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
  if (SWEEP) {
    await Question.updateOne({ _id: qs[1]._id }, { prompt: MULTILINE_PROMPT, passage: "Choose the most appropriate answer:", options: ["(a) and (b) Only", "(b) and (d) Only", "(c) Only", "(d) Only"] });
    await Question.updateOne({ _id: qs[2]._id }, { passage: LONG_PASSAGE });
  }
  const test = await Test.create({ title: "UGEE 2026 Mock Test 1", isFree: true, status: "live", seasonId: season._id, sectionDurations: { SUPR: 60, REAP: 120 }, durationMinutes: 180, questionIds: qs.map((q) => q._id) });
  if (SWEEP) {
    await Test.create({ title: "AceIIIT All-India Live Mock 01", type: "scheduled", isFree: true, status: "live", seasonId: season._id, sectionDurations: { SUPR: 60, REAP: 120 }, durationMinutes: 180, questionIds: qs.map((q) => q._id) });
  }
  await mongoose.disconnect();

  const server = spawn(process.execPath, ["server.js"], { cwd: BACKEND, env: serverEnv({ MONGODB_URI: uri, PORT: String(PORT), ADMIN_EMAILS: "admin@test.local" }) });
  let log = "";
  server.stdout.on("data", (d) => (log += d));
  server.stderr.on("data", (d) => (log += d));
  for (let i = 0; i < 40; i += 1) { try { if ((await fetch(BASE + "/ready")).status === 200) break; } catch (_e) {} await sleep(250); }

  // Tall sweep captures exhaust /dev/shm in headless Chrome; keep shared memory on disk.
  const browser = await puppeteer.launch({ executablePath: CHROME_PATH, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  const page = await newHermeticPage(browser, { allowFonts: true });
  page.on("dialog", (d) => d.accept());
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
  if (UI_PUBLIC) {
    page.interceptHook = async (request) => {
      const url = new URL(request.url());
      if (url.origin !== BASE || request.method() !== "GET" || /^\/(api|health|ready)(\/|$)/.test(url.pathname)) return false;
      let rel = decodeURIComponent(url.pathname).replace(/^\/+/, "") || "index.html";
      if (!path.extname(rel)) rel = "index.html";
      const file = path.join(UI_PUBLIC, rel);
      if (!file.startsWith(UI_PUBLIC + path.sep) || !fs.existsSync(file)) return false;
      await request.respond({ status: 200, contentType: MIME[path.extname(file)] || "application/octet-stream", headers: { "Cache-Control": "no-store" }, body: fs.readFileSync(file) });
      return true;
    };
    console.log("frontend served from", UI_PUBLIC);
  }
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

    for (const [w, h] of SWEEP ? [] : VIEWPORTS) {
      await page.setViewport({ width: w, height: h });
      await page.goto(`${BASE}/#/results/${attemptId}`, { waitUntil: "networkidle2" });
      await settle(page, 2500);
      await page.screenshot({ path: path.join(OUT, `results-${w}x${h}.png`), fullPage: true });
    }

    for (const [w, h] of SWEEP ? [] : VIEWPORTS) {
      await page.setViewport({ width: w, height: h });
      await page.goto(`${BASE}/#/dashboard`, { waitUntil: "networkidle2" });
      await settle(page, 1500);
      await page.screenshot({ path: path.join(OUT, `dashboard-${w}x${h}.png`) });
    }

    if (sweeping("student")) {
      // Bookmark three questions from the review so Resources → Bookmarks has real cards.
      await page.setViewport({ width: 1366, height: 657 });
      await visit(page, `results/${attemptId}`);
      await page.waitForSelector("#load-question-review:not([disabled])", { timeout: 15000 }).catch(() => null);
      await page.evaluate(() => { const b = document.getElementById("load-question-review"); if (b) b.click(); });
      await page.waitForSelector(".js-bookmark-toggle", { timeout: 15000 }).catch(() => null);
      await page.evaluate(() => [...document.querySelectorAll(".js-bookmark-toggle")].slice(0, 3).forEach((b) => b.click()));
      await sleep(300);
      for (const route of STUDENT_ROUTES.concat([`results/${attemptId}`])) {
        for (const [w, h] of SWEEP_VIEWPORTS) {
          await page.setViewport({ width: w, height: h });
          await visit(page, route);
          await settle(page, route.indexOf("results/") === 0 ? 1500 : 300);
          await shoot(page, path.join(OUT, `sweep-${route.replace(attemptId, "latest").replace(/\//g, "-")}-${w}x${h}.png`));
        }
      }
      await page.setViewport({ width: 1366, height: 657 });
      await visit(page, "resources/bookmarks");
      await settle(page, 300);
      await page.evaluate(() => { const d = document.querySelector(".bookmark-solution"); if (d) d.open = true; });
      await shoot(page, path.join(OUT, "sweep-resources-bookmarks-open-1366x657.png"));
    }

    if (sweeping("dark")) {
      // Dark theme through the app's own toggle, in its own context.
      const dctx = await browser.createBrowserContext();
      const dpage = await newHermeticPage(dctx, { allowFonts: true });
      dpage.interceptHook = page.interceptHook;
      dpage.on("pageerror", (e) => errors.push("dark: " + e.message));
      await dpage.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
      await dpage.setViewport({ width: 1366, height: 657 });
      await dpage.goto(`${BASE}/#/login`, { waitUntil: "networkidle2" });
      await dpage.waitForSelector("#login-email");
      await dpage.type("#login-email", "riya@test.local");
      await dpage.type("#login-password", "Passw0rd!long");
      await dpage.click("#login-submit-btn");
      await dpage.waitForFunction(() => /dashboard/.test(location.hash), { timeout: 15000 });
      await dpage.evaluate(() => { const t = document.querySelector("[data-theme-toggle='true']"); if (t) t.click(); });
      const darkSizes = process.env.SWEEP_SIZES ? SWEEP_VIEWPORTS : [[1366, 657]];
      for (const route of ["dashboard", "results/" + attemptId, "account/security", "progress/performance", "progress/reports", "exams/practice"]) {
        for (const [w, h] of darkSizes) {
          await dpage.setViewport({ width: w, height: h });
          await visit(dpage, route);
          await settle(dpage, 600);
          await shoot(dpage, path.join(OUT, `sweep-dark-${route.replace(attemptId, "latest").replace(/\//g, "-")}-${w}x${h}.png`));
        }
      }
      await dctx.close();
    }

    // Exam with some palette states.
    if (!SWEEP || sweeping("exam")) {
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
      for (const [w, h] of SWEEP ? [] : VIEWPORTS) {
        await page.setViewport({ width: w, height: h });
        await settle(page, 900);
        await page.screenshot({ path: path.join(OUT, `exam-${w}x${h}.png`) });
      }
      if (SWEEP) {
        // Q2: short instruction passage + hard line breaks; Q3: long passage (split view).
        await page.setViewport({ width: 1366, height: 657 });
        for (const n of [2, 3]) {
          await page.evaluate((n) => { const b = document.querySelectorAll(".palette-button[data-question]")[n - 1]; if (b) b.click(); }, n);
          await settle(page, 900);
          await page.screenshot({ path: path.join(OUT, `sweep-exam-q${n}-1366x657.png`) });
        }
      }
    }

    // Admin Studio (question bank workspace), as the admin.
    if (!SWEEP || sweeping("admin")) {
      const actx = await browser.createBrowserContext();
      const apage = await newHermeticPage(actx, { allowFonts: true });
      apage.interceptHook = page.interceptHook;
      apage.on("pageerror", (e) => errors.push("admin: " + e.message));
      await apage.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
      await apage.setViewport({ width: 1366, height: 657 });
      await apage.goto(`${BASE}/#/login`, { waitUntil: "networkidle2" });
      await apage.waitForSelector("#login-email");
      await apage.type("#login-email", "admin@test.local");
      await apage.type("#login-password", "Passw0rd!long");
      await apage.click("#login-submit-btn");
      await apage.waitForFunction(() => !/login/.test(location.hash), { timeout: 15000 });
      for (const [w, h] of SWEEP ? [] : VIEWPORTS) {
        await apage.setViewport({ width: w, height: h });
        await apage.goto(`${BASE}/#/admin`, { waitUntil: "networkidle2" });
        await settle(apage, 1500);
        await apage.screenshot({ path: path.join(OUT, `admin-${w}x${h}.png`) });
      }
      if (SWEEP) {
        await settle(apage, 1200);
        for (const [w, h] of [[1366, 657], [1440, 900]]) {
          await apage.setViewport({ width: w, height: h });
          for (const tab of STUDIO_TABS) {
            await visit(apage, "admin");
            await settle(apage, 300);
            await apage.evaluate((tab) => { const b = document.querySelector(`.js-studio-tab[data-tab="${tab}"]`); if (b) b.click(); }, tab);
            await settle(apage, 1200);
            await shoot(apage, path.join(OUT, `sweep-admin-${tab}-${w}x${h}.png`));
          }
          await visit(apage, "admin-activity");
          await settle(apage, 600);
          await shoot(apage, path.join(OUT, `sweep-admin-activity-${w}x${h}.png`));
        }
      }
      await actx.close();
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
