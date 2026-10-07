// Browser E2E for the M1/M2 client: cookie login, server exam session, autosave, reload
// recovery, second-tab 409 + takeover, section advance, submit, result.
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const puppeteer = require("puppeteer-core");
const { BACKEND, CHROME_PATH, SHOTS_DIR, serverEnv } = require("./helpers");

const PORT = 4978;
const BASE = `http://127.0.0.1:${PORT}`;
const req = (m) => require(path.join(BACKEND, m));

const log = (...a) => console.log("[e2e]", ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// The SPA re-renders views; click by selector inside the page to avoid detached handles.
async function clickSel(page, selector, timeout = 15000) {
  await page.waitForFunction((sel) => {
    const el = document.querySelector(sel);
    return el && !el.disabled;
  }, { timeout }, selector);
  await page.evaluate((sel) => document.querySelector(sel).click(), selector);
}
async function beginExam(page) {
  await page.waitForSelector("#ready-check", { timeout: 15000 });
  await sleep(1500);
  await page.evaluate(() => {
    const box = document.getElementById("ready-check");
    if (!box.checked) box.click();
  });
  await clickSel(page, "#begin-test");
}

(async () => {
  const { MongoMemoryServer } = req("node_modules/mongodb-memory-server");
  const mongoose = req("node_modules/mongoose");
  const bcrypt = req("node_modules/bcryptjs");
  const dataRoot = path.join(BACKEND, "node_modules/.cache/mongodb-test-data");
  fs.mkdirSync(dataRoot, { recursive: true });
  const dbPath = fs.mkdtempSync(path.join(dataRoot, "e2e-"));
  const mongod = await MongoMemoryServer.create({ instance: { dbPath } });
  const uri = mongod.getUri() + "e2e";

  // Seed
  await mongoose.connect(uri);
  const User = req("models/User");
  const Question = req("models/Question");
  const Test = req("models/Test");
  const Season = req("models/Season");
  const season = await Season.create({ name: "UGEE 2026", year: 2026, status: "active", isDefaultActive: true });
  await User.create({ name: "E2E Student", email: "e2e@test.local", status: "active", isActivated: true, emailVerified: true, passwordHash: await bcrypt.hash("Passw0rd!long", 4) });
  const qs = await Question.insertMany([
    { section: "SUPR", topic: "patterns", prompt: "SUPR question one", options: ["a", "b", "c", "d"], correctOption: 1, marks: 4, negativeMarks: -1 },
    { section: "SUPR", topic: "logic", prompt: "SUPR question two", options: ["a", "b", "c", "d"], correctOption: 2, marks: 4, negativeMarks: -1 },
    { section: "REAP", topic: "reading", prompt: "REAP question one", options: ["a", "b", "c", "d"], correctOption: 0, marks: 4, negativeMarks: -1 },
  ]);
  const test = await Test.create({ title: "E2E Free Mock", isFree: true, status: "live", seasonId: season._id, sectionDurations: { SUPR: 30, REAP: 30 }, durationMinutes: 60, questionIds: qs.map((q) => q._id) });
  const paidTest = await Test.create({ title: "E2E Paid Mock", isFree: false, status: "live", seasonId: season._id, sectionDurations: { SUPR: 30, REAP: 30 }, durationMinutes: 60, questionIds: qs.map((q) => q._id) });
  await mongoose.disconnect();

  const server = spawn(process.execPath, ["server.js"], {
    cwd: BACKEND,
    env: serverEnv({ MONGODB_URI: uri, PORT: String(PORT), ADMIN_EMAILS: "nobody@test.local" }),
  });
  let serverLog = "";
  server.stdout.on("data", (d) => (serverLog += d));
  server.stderr.on("data", (d) => (serverLog += d));
  await sleep(3500);

  const browser = await puppeteer.launch({ executablePath: CHROME_PATH, headless: true, args: ["--no-sandbox"] });
  const failures = [];
  const consoleErrors = [];
  const check = (cond, msg) => {
    if (cond) log("PASS", msg);
    else {
      log("FAIL", msg);
      failures.push(msg);
    }
  };
  try {
    const context = await browser.createBrowserContext();
    const page = await context.newPage();
    page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(`tab1: ${m.text()}`); });
    page.on("pageerror", (e) => consoleErrors.push(`tab1 pageerror: ${e.stack}`));
    page.on("dialog", async (d) => { log("tab1 dialog:", d.message().split("\n")[0]); await d.accept(); });

    // 1. Login (cookie session + CSRF)
    await page.goto(`${BASE}/#/login`, { waitUntil: "networkidle2" });
    await page.waitForSelector("#login-email", { timeout: 15000 });
    await page.type("#login-email", "e2e@test.local");
    await page.type("#login-password", "Passw0rd!long");
    await page.click("#login-submit-btn");
    await page.waitForFunction(() => location.hash.indexOf("dashboard") !== -1, { timeout: 15000 });
    const stored = await page.evaluate(() => localStorage.getItem("ugee.portal.session.v1") || "");
    check(!/"token"|tokenVersion|Bearer/.test(stored), "no auth token or internal session state in localStorage");
    const cookies = await page.cookies();
    const sessionCookie = cookies.find((c) => c.name === "aceiiit_session");
    check(sessionCookie && sessionCookie.httpOnly, "session cookie is httpOnly");

    // 1a. QOTD: answer comes from the server after submitting; persists across reload
    await page.waitForSelector(".js-qotd-option", { timeout: 15000 }).catch(() => null);
    const qotdHasAnswerAttr = await page.evaluate(() => !!document.querySelector("[data-correct]"));
    check(!qotdHasAnswerAttr, "QOTD answer is not embedded in the page before answering");
    await clickSel(page, ".js-qotd-option");
    await page.waitForFunction(() => /Correct|Incorrect/.test((document.querySelector(".js-qotd-result") || {}).textContent || ""), { timeout: 10000 }).catch(() => null);
    const qotdText = await page.evaluate(() => (document.querySelector(".js-qotd-result") || {}).textContent || "");
    check(/Correct|Incorrect/.test(qotdText), `QOTD result shown after server submit (${qotdText.trim()})`);
    await page.reload({ waitUntil: "networkidle2" });
    await page.waitForSelector(".js-qotd-option", { timeout: 15000 }).catch(() => null);
    check(await page.evaluate(() => { const b = document.querySelector(".js-qotd-option"); return !!b && b.disabled; }), "QOTD stays answered after reload (persisted server-side)");

    // 1b. Paid test without entitlement is locked (server-computed `accessible`)
    await page.goto(`${BASE}/#/instructions/${paidTest._id}`, { waitUntil: "networkidle2" });
    await page.waitForFunction(() => /Buy Test Series to unlock/.test(document.body.innerText), { timeout: 15000 }).catch(() => null);
    check(/Buy Test Series to unlock/.test(await page.evaluate(() => document.body.innerText)), "paid test shows the locked/buy screen without an entitlement");
    const paidQuestions = await page.evaluate(async (id) => (await fetch(`/api/tests/${id}/questions`, { credentials: "same-origin" })).status, String(paidTest._id));
    check(paidQuestions === 403, "students can't fetch question lists directly (403)");

    // 2. Start exam
    await page.goto(`${BASE}/#/instructions/${test._id}`, { waitUntil: "networkidle2" });
    await beginExam(page);
    await page.waitForFunction(() => location.hash.indexOf("#/test/") === 0, { timeout: 15000 });
    await page.waitForSelector('input[name="answer"]', { timeout: 15000 });
    const sessionId = await page.evaluate(() => location.hash.split("/")[2]);
    check(/^[a-f0-9]{24}$/.test(sessionId), "exam route uses the server session id");
    const timerText = await page.$eval("#timer-display", (el) => el.textContent);
    check(/^(29|30):/.test(timerText) || /^00:(29|30)/.test(timerText) || /29|30/.test(timerText), `timer shows ~30 minutes from server (${timerText})`);

    // 2b. Formatting + integrity telemetry
    const letters = await page.$$eval(".option-letter", (els) => els.map((e) => e.textContent).join(""));
    check(letters === "ABCD", `options labelled A-D (${letters})`);
    check(await page.$("#integrity-watermark") !== null, "watermark rendered during exam");
    await page.keyboard.press("3");
    await sleep(300);
    const keySelected = await page.$eval('input[name="answer"][value="2"]', (el) => el.checked);
    check(keySelected, "pressing 3 selects option C");
    await page.evaluate(() => document.dispatchEvent(new Event("copy", { bubbles: true, cancelable: true })));
    await page.waitForSelector("#integrity-notice", { timeout: 10000 }).catch(() => null);
    const noticeText = await page.$eval("#integrity-notice", (el) => el.textContent).catch(() => "");
    check(/Recorded 1 time/.test(noticeText), "copy attempt recorded by the server and a notice shown");
    await page.evaluate(() => { const b = document.getElementById("integrity-notice-ok"); if (b) b.click(); });

    if (process.env.SHOTS) {
      fs.mkdirSync(SHOTS_DIR, { recursive: true });
      for (const w of [390, 1280]) {
        await page.setViewport({ width: w, height: 860 });
        await sleep(600);
        await page.screenshot({ path: path.join(SHOTS_DIR, `exam-${w}.png`) });
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
        check(!overflow, `no horizontal overflow at ${w}px`);
      }
      await page.setViewport({ width: 1280, height: 860 });
    }

    // 3. Answer + autosave
    await clickSel(page, 'input[name="answer"][value="1"]');
    await page.waitForFunction(() => (document.getElementById("autosave-chip") || {}).textContent === "Saved to server ✓", { timeout: 15000 });
    const serverAnswers = await page.evaluate(async () => {
      const r = await fetch("/api/attempt/sessions/active", { credentials: "same-origin" });
      const d = await r.json();
      return d.sessions[0] && d.sessions[0].answers;
    });
    check(serverAnswers && Object.values(serverAnswers).includes(1), "answer autosaved to the server");

    // 4. Reload recovery
    await page.reload({ waitUntil: "networkidle2" });
    await page.waitForSelector('input[name="answer"]', { timeout: 15000 });
    const stillChecked = await page.$eval('input[name="answer"][value="1"]', (el) => el.checked).catch(() => false);
    check(stillChecked, "answer restored after reload");

    // 5. Second tab → 409 → takeover (tab has its own sessionStorage, so no exam token)
    const page2 = await context.newPage();
    page2.on("console", (m) => { if (m.type() === "error") consoleErrors.push(`tab2: ${m.text()}`); });
    page2.on("pageerror", (e) => consoleErrors.push(`tab2 pageerror: ${e.stack}`));
    let sawElsewhere = false;
    page2.on("dialog", async (d) => {
      if (/another tab or device/.test(d.message())) sawElsewhere = true;
      log("tab2 dialog:", d.message().split("\n")[0]);
      await d.accept();
    });
    await page2.goto(`${BASE}/#/instructions/${test._id}`, { waitUntil: "networkidle2" });
    await beginExam(page2);
    await page2.waitForSelector('input[name="answer"]', { timeout: 15000 });
    check(sawElsewhere, "second tab was told the exam is open elsewhere (409) and offered takeover");
    const page2Session = await page2.evaluate(() => location.hash.split("/")[2]);
    check(page2Session === sessionId, "takeover kept the same session (deadline/answers carried over)");
    const restored2 = await page2.$eval('input[name="answer"][value="1"]', (el) => el.checked).catch(() => false);
    check(restored2, "taken-over tab shows the saved answer");

    // Old tab: its next save must be rejected (binding revoked).
    const oldTabSave = await page.evaluate(async (id) => {
      const csrf = document.cookie.split("; ").find((c) => c.startsWith("aceiiit_csrf=")).split("=")[1];
      const token = sessionStorage.getItem("aceiiit.exam." + id);
      const r = await fetch(`/api/attempt/session/${id}/answers`, {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf, "X-Exam-Token": token },
        body: JSON.stringify({ seq: 99, marked: [] }),
      });
      return r.status;
    }, sessionId);
    check(oldTabSave === 409, "old tab's exam token was revoked (409)");
    await page.close();

    // 6. Advance to REAP and submit from tab 2
    await clickSel(page2, "#submit-test");
    await clickSel(page2, '[data-transition-action="confirm"]');
    await page2.waitForFunction(() => /REAP question one/.test(document.body.innerText), { timeout: 15000 });
    check(true, "advanced to REAP via server");
    await clickSel(page2, 'input[name="answer"][value="0"]');
    await sleep(500);
    await clickSel(page2, "#submit-test");
    await clickSel(page2, '[data-transition-action="confirm"]');
    await page2.waitForFunction(() => location.hash.indexOf("#/results/") === 0, { timeout: 20000 });
    await sleep(2500);
    const resultText = await page2.evaluate(() => document.body.innerText);
    const attemptId = await page2.evaluate(() => location.hash.split("/")[2]);
    const apiResult = await page2.evaluate(async (id) => (await fetch(`/api/result/${id}`, { credentials: "same-origin" })).json(), attemptId);
    check(apiResult.attempt && apiResult.attempt.score === 8, `server scored 8 (SUPR q1 + REAP q1) → ${apiResult.attempt && apiResult.attempt.score}`);
    check(apiResult.attempt && apiResult.attempt.rank === 1, "rank computed on read");
    check(/8/.test(resultText), "result page renders the score");
    await page2.waitForFunction(() => /Where Marks Leak/.test((document.getElementById("performance-intelligence-root") || {}).textContent || ""), { timeout: 15000 }).catch(() => null);
    const piText = await page2.evaluate(() => (document.getElementById("performance-intelligence-root") || {}).textContent || "");
    check(/Where Marks Leak/.test(piText) && /verified metrics/i.test(piText) && /does not calculate or alter scores/.test(piText), "Performance Intelligence card renders with verified-vs-interpretation labelling and disclosure");
    if (process.env.SHOTS) {
      await page2.evaluate(() => document.getElementById("performance-intelligence-root").scrollIntoView());
      await sleep(400);
      await page2.screenshot({ path: path.join(SHOTS_DIR, "performance-intelligence.png") });
    }
  } catch (err) {
    failures.push(`exception: ${err.message}`);
    log("EXCEPTION", err.stack);
  } finally {
    await browser.close();
    server.kill("SIGTERM");
    await mongod.stop();
    fs.rmSync(dbPath, { recursive: true, force: true });
  }
  const relevantErrors = consoleErrors.filter((e) => !/favicon|accounts\.google|appleid|Failed to load resource.*(gsi|apple)/i.test(e));
  if (relevantErrors.length) log("console errors:", relevantErrors);
  if (/Error|error/.test(serverLog.split("\n").filter((l) => !/MONGOOSE|trace-warnings|Duplicate schema/.test(l)).join("\n"))) {
    log("server log:", serverLog.split("\n").filter((l) => /rror/.test(l)).slice(0, 10));
  }
  log(failures.length ? `FAILED (${failures.length})` : "ALL PASSED");
  process.exit(failures.length ? 1 : 0);
})();
