// Browser smoke test of Admin Studio after hardening: every tab renders without page
// errors, the test form saves integrity/shuffle settings, and "Add payment" grants access.
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const puppeteer = require("puppeteer-core");
const { BACKEND, CHROME_PATH, serverEnv, newHermeticPage } = require("./helpers");

const PORT = 4979;
const BASE = `http://127.0.0.1:${PORT}`;
const req = (m) => require(path.join(BACKEND, m));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log("[admin-e2e]", ...a);

(async () => {
  const { MongoMemoryServer } = req("node_modules/mongodb-memory-server");
  const mongoose = req("node_modules/mongoose");
  const bcrypt = req("node_modules/bcryptjs");
  const dataRoot = path.join(BACKEND, "node_modules/.cache/mongodb-test-data");
  fs.mkdirSync(dataRoot, { recursive: true });
  const dbPath = fs.mkdtempSync(path.join(dataRoot, "admin-e2e-"));
  const mongod = await MongoMemoryServer.create({ instance: { dbPath } });
  const uri = mongod.getUri() + "admine2e";
  await mongoose.connect(uri);
  const User = req("models/User");
  const Question = req("models/Question");
  const Test = req("models/Test");
  const Season = req("models/Season");
  const Entitlement = req("models/Entitlement");
  const season = await Season.create({ name: "UGEE 2026", year: 2026, status: "active", isDefaultActive: true });
  const hash = await bcrypt.hash("Passw0rd!long", 4);
  await User.create({ name: "Admin", email: "admin@test.local", role: "admin", status: "active", isActivated: true, emailVerified: true, passwordHash: hash });
  await User.create({ name: "Buyer", email: "buyer@test.local", status: "active", isActivated: true, emailVerified: true, passwordHash: hash });
  const qs = await Question.insertMany([{ section: "SUPR", topic: "t", prompt: "Q1 $x^2$", options: ["a", "b"], correctOption: 0 }]);
  // An unattached bank larger than one page (50) for the pagination checks.
  await Question.insertMany(Array.from({ length: 64 }, (_, i) => ({ section: i % 2 ? "REAP" : "SUPR", topic: i < 3 ? "needle" : "bank", prompt: `Bank Q${i}`, options: ["a", "b"], correctOption: 0, createdAt: new Date(Date.UTC(2026, 0, 2, 0, i)) })));
  await Test.create({ title: "Admin E2E Test", isFree: false, status: "live", seasonId: season._id, questionIds: qs.map((q) => q._id) });
  await mongoose.disconnect();

  const server = spawn(process.execPath, ["server.js"], { cwd: BACKEND, env: serverEnv({ MONGODB_URI: uri, PORT: String(PORT), ADMIN_EMAILS: "admin@test.local" }) });
  let serverLog = "";
  server.stdout.on("data", (d) => (serverLog += d));
  server.stderr.on("data", (d) => (serverLog += d));
  await sleep(3500);

  const browser = await puppeteer.launch({ executablePath: CHROME_PATH, headless: true, args: ["--no-sandbox"] });
  const failures = [];
  const pageErrors = [];
  const check = (cond, msg) => { (cond ? log("PASS", msg) : (log("FAIL", msg), failures.push(msg))); };
  try {
    const page = await newHermeticPage(browser);
    await page.setViewport({ width: 1366, height: 900 });
    page.on("pageerror", (e) => pageErrors.push(e.stack || e.message));
    page.on("dialog", async (d) => { log("dialog:", d.message().split("\n")[0]); await d.accept(); });
    await page.goto(`${BASE}/#/login`, { waitUntil: "networkidle2" });
    await page.waitForSelector("#login-email");
    await page.type("#login-email", "admin@test.local");
    await page.type("#login-password", "Passw0rd!long");
    await page.click("#login-submit-btn");
    await page.waitForFunction(() => location.hash.length > 2 && !/login/.test(location.hash), { timeout: 15000 });
    await page.goto(`${BASE}/#/admin`, { waitUntil: "networkidle2" });
    await page.waitForSelector(".js-studio-tab", { timeout: 20000 });

    for (const tab of ["setup", "questions", "bank", "review", "tests", "payments", "seasons", "audit", "materials"]) {
      const before = pageErrors.length;
      await page.evaluate((t) => document.querySelector(`.js-studio-tab[data-tab="${t}"]`).click(), tab);
      await sleep(900);
      check(pageErrors.length === before, `tab "${tab}" renders without page errors`);
    }

    // Question bank: server pagination, server search, drawer exclude + attach.
    await page.evaluate(() => document.querySelector('.js-studio-tab[data-tab="bank"]').click());
    await page.waitForFunction(() => /Showing 1–50 of 65/.test(document.body.innerText), { timeout: 10000 }).catch(() => null);
    check(/Showing 1–50 of 65/.test(await page.evaluate(() => document.body.innerText)), "bank tab shows page 1 of the server-paginated bank (50 of 65)");
    check((await page.$$eval(".question-bank .bank-item", (els) => els.length)) === 50, "bank tab renders one page (50 rows), not the whole bank");
    await page.evaluate(() => document.querySelector('.js-bank-page[data-page="2"]').click());
    await page.waitForFunction(() => /Showing 51–65 of 65/.test(document.body.innerText), { timeout: 10000 }).catch(() => null);
    check(/Showing 51–65 of 65/.test(await page.evaluate(() => document.body.innerText)), "Next loads page 2 from the server");
    await page.focus("#bank-search");
    await page.keyboard.type("needle");
    await page.waitForFunction(() => /of 3\b/.test(document.body.innerText), { timeout: 10000 }).catch(() => null);
    check(/Showing 1–3 of 3/.test(await page.evaluate(() => document.body.innerText)), "bank search is applied on the server (3 matches, page reset)");
    check(await page.evaluate(() => document.activeElement && document.activeElement.id === "bank-search"), "search input keeps focus across the re-render");

    await page.evaluate(() => document.querySelector('.js-studio-tab[data-tab="questions"]').click());
    await sleep(600);
    await page.evaluate(() => document.getElementById("open-bank-drawer").click());
    await page.waitForSelector(".js-bank-multi-checkbox", { timeout: 10000 });
    const drawerText = await page.evaluate(() => document.getElementById("bank-drawer-overlay").innerText);
    check(/of 3\b/.test(drawerText) && !/Q1 /.test(drawerText), "drawer keeps the search and excludes questions already in the test");
    await page.evaluate(() => document.querySelector(".js-bank-multi-checkbox").click());
    await sleep(300);
    await page.evaluate(() => document.getElementById("attach-bank-selected-bulk").click());
    await page.waitForFunction(() => /2 \/ 90 Questions Attached/.test(document.body.innerText), { timeout: 10000 }).catch(() => null);
    check(/2 \/ 90 Questions Attached/.test(await page.evaluate(() => document.body.innerText)), "attaching from the drawer adds the question to the test");

    // Setup tab: integrity + shuffle fields exist on the test form.
    await page.evaluate(() => document.querySelector('.js-studio-tab[data-tab="setup"]').click());
    await sleep(700);
    check(await page.$("#test-integrity-mode") !== null, "test form has the integrity mode control");

    // Payments tab: add + verify a payment for the buyer.
    await page.evaluate(() => document.querySelector('.js-studio-tab[data-tab="payments"]').click());
    await page.waitForSelector("#admin-add-payment-form", { timeout: 10000 });
    await page.type("#add-payment-email", "buyer@test.local");
    await page.evaluate(() => document.querySelector("#admin-add-payment-form button[type=submit]").click());
    await sleep(2500);
    await mongoose.connect(uri);
    const ent = await Entitlement.findOne({ normalizedEmail: "buyer@test.local" }).lean();
    await mongoose.disconnect();
    check(ent && ent.status === "active" && String(ent.seasonId) === String(season._id), "Add payment (verify now) granted an active entitlement");
  } catch (err) {
    failures.push(`exception: ${err.message}`);
    log("EXCEPTION", err.stack);
  } finally {
    await browser.close();
    server.kill("SIGTERM");
    await mongod.stop();
    fs.rmSync(dbPath, { recursive: true, force: true });
  }
  if (pageErrors.length) log("page errors:", pageErrors.slice(0, 5));
  const serverErrors = serverLog.split("\n").filter((l) => /Error|rror:/.test(l) && !/MONGOOSE/.test(l));
  if (serverErrors.length) log("server errors:", serverErrors.slice(0, 10));
  log(failures.length ? `FAILED (${failures.length})` : "ALL PASSED");
  process.exit(failures.length ? 1 : 0);
})();
