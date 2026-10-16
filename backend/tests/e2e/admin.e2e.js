// Browser smoke test of Admin Studio after hardening: every tab renders without page
// errors, the test form saves integrity/shuffle settings, "Add payment" grants access, the
// question image manager adds/replaces/sizes/reorders/removes images (uploads answered by an
// interceptor), and User Payments lists every user with a working Details window.
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
  const qs = await Question.insertMany([{ section: "SUPR", topic: "t", prompt: "Q1 $x^2$", options: ["a", "b", "c", "d"], correctOption: 0, explanation: "Because.", imageUrls: ["/assets/favicon-round.svg"], imageWidths: [0] }]);
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

    for (const tab of ["setup", "questions", "bank", "review", "tests", "payments", "seasons", "audit", "materials", "mentor"]) {
      const before = pageErrors.length;
      await page.evaluate((t) => document.querySelector(`.js-studio-tab[data-tab="${t}"]`).click(), tab);
      await sleep(900);
      check(pageErrors.length === before, `tab "${tab}" renders without page errors`);
    }

    // ACEIIIT Mentor tab: status without a key, settings saved on the server.
    await page.waitForSelector("#mentor-admin-form", { timeout: 10000 }).catch(() => null);
    const mentorTab = await page.evaluate(() => (document.getElementById("mentor-admin-root") || {}).innerText || "");
    check(/No Gemini API key/.test(mentorTab) && /API key on the server: missing/.test(mentorTab) && !/AIza|AQ\./.test(mentorTab), "mentor tab: says no API key is configured (and shows no key)");
    await page.$eval("#mentor-free", (el) => { el.value = "7"; });
    await page.$eval("#mentor-codes", (el) => { el.value = "class_notes, UGEE_PROGRAMME"; });
    await page.click("#mentor-admin-form button[type=submit]");
    await page.waitForFunction(() => /Saved\./.test((document.getElementById("mentor-admin-message") || {}).textContent || ""), { timeout: 10000 }).catch(() => null);
    const savedMentor = await page.evaluate(() => ({ free: document.getElementById("mentor-free").value, codes: document.getElementById("mentor-codes").value }));
    check(savedMentor.free === "7" && savedMentor.codes === "CLASS_NOTES, UGEE_PROGRAMME", `mentor tab: settings save and reload from the server (${JSON.stringify(savedMentor)})`);
    await page.$eval("#mentor-url", (el) => { el.value = "http://insecure.example"; });
    await page.click("#mentor-admin-form button[type=submit]");
    await page.waitForFunction(() => /Not saved/.test((document.getElementById("mentor-admin-message") || {}).textContent || ""), { timeout: 10000 }).catch(() => null);
    check(/Not saved/.test(await page.$eval("#mentor-admin-message", (el) => el.textContent)), "mentor tab: a non-https programme link is refused");

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

    // Question images: add, size, replace (and a failed replace), reorder, remove; Save sends
    // exactly the working copy. Uploads are answered here with the app's own /assets images.
    const figPath = path.join(dbPath, "figure.png");
    fs.writeFileSync(figPath, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));
    const uploadUrls = ["/assets/mascot-wave.svg", "/assets/google-calendar.svg"];
    let failNextUpload = false;
    page.interceptHook = async (request) => {
      if (!/\/api\/upload-image$/.test(new URL(request.url()).pathname) || request.method() !== "POST") return false;
      if (failNextUpload) {
        failNextUpload = false;
        await request.respond({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Image storage is unavailable right now." }) });
        return true;
      }
      const url = uploadUrls.shift() || "/assets/favicon-round.svg";
      await request.respond({ status: 200, contentType: "application/json", body: JSON.stringify({ url, secure_url: url, urls: [url] }) });
      return true;
    };
    const imageState = () => page.evaluate(() => ({
      thumbs: Array.from(document.querySelectorAll("#qimg-root .qimg-thumb img")).map((img) => img.getAttribute("src")),
      busy: document.querySelectorAll("#qimg-root .qimg-item.is-busy").length,
      error: (document.querySelector("#qimg-root .qimg-error") || {}).textContent || "",
      sized: Array.from(document.querySelectorAll("#qimg-root .qimg-preview .question-figure-button")).map((b) => b.getAttribute("style") || ""),
    }));
    const openEditor = async () => {
      await page.evaluate(() => document.querySelector('.js-studio-tab[data-tab="questions"]').click());
      await sleep(800);
      await page.evaluate((id) => document.querySelector(`.js-edit-question-inline[data-id="${id}"]`).click(), String(qs[0]._id));
      await page.waitForSelector("#qimg-root .qimg-item", { timeout: 10000 });
    };
    await openEditor();
    check((await imageState()).thumbs.length === 1, "the image manager lists the question's existing image");
    await (await page.$("#qimg-root .js-qimg-add")).uploadFile(figPath);
    await page.waitForFunction(() => document.querySelectorAll("#qimg-root .qimg-thumb img").length === 2 && !document.querySelector("#qimg-root .is-busy"), { timeout: 10000 }).catch(() => null);
    check((await imageState()).thumbs[1] === "/assets/mascot-wave.svg", "Add images uploads straight away and adds a thumbnail");
    await page.select("#qimg-root .qimg-item:nth-child(1) .js-qimg-preset", "55");
    await sleep(300);
    check(/--fig-w: 55%/.test((await imageState()).sized[0] || ""), "setting image 1 to Medium shows it at 55% in the live preview");
    await (await page.$("#qimg-root .qimg-item:nth-child(2) .js-qimg-replace")).uploadFile(figPath);
    await page.waitForFunction(() => (document.querySelectorAll("#qimg-root .qimg-thumb img")[1] || {}).getAttribute && document.querySelectorAll("#qimg-root .qimg-thumb img")[1].getAttribute("src") === "/assets/google-calendar.svg", { timeout: 10000 }).catch(() => null);
    check((await imageState()).thumbs[1] === "/assets/google-calendar.svg", "Replace swaps the image in place");
    failNextUpload = true;
    await (await page.$("#qimg-root .qimg-item:nth-child(1) .js-qimg-replace")).uploadFile(figPath);
    await page.waitForFunction(() => !!document.querySelector("#qimg-root .qimg-error"), { timeout: 10000 }).catch(() => null);
    const afterFailed = await imageState();
    check(afterFailed.thumbs[0] === "/assets/favicon-round.svg" && /current image is kept/.test(afterFailed.error), "a failed replace keeps the old image and says so");
    await page.evaluate(() => document.querySelector('#qimg-root .qimg-item:nth-child(2) .js-qimg-move[data-dir="-1"]').click());
    await sleep(200);
    check((await imageState()).thumbs.join(",") === "/assets/google-calendar.svg,/assets/favicon-round.svg", "Move reorders the images");
    await page.evaluate(() => document.getElementById("question-save-btn").click());
    await sleep(2500);
    await mongoose.connect(uri);
    let savedQ = await Question.findById(qs[0]._id).lean();
    await mongoose.disconnect();
    check(JSON.stringify(savedQ.imageUrls) === JSON.stringify(["/assets/google-calendar.svg", "/assets/favicon-round.svg"]) && JSON.stringify(savedQ.imageWidths) === JSON.stringify([0, 55]),
      `Save stores exactly the working copy (${JSON.stringify(savedQ.imageUrls)} / ${JSON.stringify(savedQ.imageWidths)})`);
    await openEditor();
    await page.evaluate(() => document.querySelector("#qimg-root .qimg-item:nth-child(1) .js-qimg-remove").click());
    await sleep(200);
    check(!!(await page.$("#qimg-root .js-qimg-undo")), "Remove offers Undo");
    await page.evaluate(() => document.getElementById("question-save-btn").click());
    await sleep(2500);
    await mongoose.connect(uri);
    savedQ = await Question.findById(qs[0]._id).lean();
    await mongoose.disconnect();
    check(JSON.stringify(savedQ.imageUrls) === JSON.stringify(["/assets/favicon-round.svg"]) && JSON.stringify(savedQ.imageWidths) === JSON.stringify([55]), "a removed image stays removed after Save; the other keeps its size");
    page.interceptHook = null;
    await page.evaluate(() => document.getElementById("open-student-preview").click());
    await page.waitForSelector("#student-preview-overlay", { timeout: 10000 });
    check(await page.evaluate(() => !!Array.from(document.querySelectorAll("#student-preview-overlay .question-figure-button")).find((b) => /--fig-w: 55%/.test(b.getAttribute("style") || ""))), "the Studio student preview shows the image at its exam size");
    await page.evaluate(() => document.getElementById("close-student-preview").click());
    await sleep(500);

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

    // Users: every user comes from the server with true totals; Details opens a window.
    await page.evaluate(() => document.querySelector('.js-admin-user-filter[data-filter="all"]').click());
    await page.waitForFunction(() => /Showing 1–2 of 2/.test(document.body.innerText), { timeout: 10000 }).catch(() => null);
    check(/Showing 1–2 of 2/.test(await page.evaluate(() => document.body.innerText)), "All Registered Users lists every user from the server (1–2 of 2)");
    await page.evaluate(() => {
      const row = Array.from(document.querySelectorAll(".users-table .table-row")).find((r) => /buyer@test\.local/.test(r.innerText));
      row.querySelector(".js-view-user-details").click();
    });
    await page.waitForSelector(".admin-modal-overlay .user-detail", { timeout: 10000 }).catch(() => null);
    const detailText = await page.evaluate(() => (document.querySelector(".admin-modal-overlay .user-detail") || {}).innerText || "");
    check(/buyer@test\.local/.test(detailText) && /Paid/.test(detailText) && /Added by an admin/.test(detailText) && /PROFILE/i.test(detailText), "Details opens a window with access, payments and profile");
    await page.keyboard.press("Escape");
    await sleep(300);
    check(!(await page.$(".admin-modal-overlay .user-detail")), "Escape closes the details window");
    await page.goto(`${BASE}/#/admin`, { waitUntil: "networkidle2" });
    await page.waitForSelector('.js-studio-tab[data-tab="setup"]', { timeout: 20000 });
    // Setup: "+ New test" makes a blank form that creates a new test; "Save changes" updates
    // the test being edited instead of creating a copy (it used to always create a copy).
    const countTests = async () => { await mongoose.connect(uri); const n = await Test.countDocuments({ deletedAt: null }); await mongoose.disconnect(); return n; };
    await page.evaluate(() => document.querySelector('.js-studio-tab[data-tab="setup"]').click());
    await page.waitForSelector("#test-form", { timeout: 10000 });
    const before = await countTests();
    const editing = await page.evaluate(() => ({ mode: document.querySelector(".setup-mode").innerText, button: document.querySelector('#test-form button[type="submit"]').textContent }));
    check(/Editing/.test(editing.mode) && editing.button === "Save changes", `with a test selected, the form says it's editing it (${editing.mode.replace(/\s+/g, " ")} / ${editing.button})`);
    await page.$eval("#test-subtitle", (el) => { el.value = "Edited subtitle"; });
    await page.click('#test-form button[type="submit"]');
    await sleep(1500);
    check((await countTests()) === before, "Save changes updates the test and creates no copy");
    await page.waitForSelector("#new-test-btn", { timeout: 10000 });
    await page.click("#new-test-btn");
    await page.waitForFunction(() => /New test/.test((document.querySelector(".setup-mode") || {}).innerText || ""), { timeout: 5000 }).catch(() => null);
    const blank = await page.evaluate(() => ({ title: document.getElementById("test-title").value, button: document.querySelector('#test-form button[type="submit"]').textContent, focus: document.activeElement && document.activeElement.id }));
    check(blank.title === "" && blank.button === "Create test" && blank.focus === "test-title", `+ New test gives a blank form with focus on the title (${JSON.stringify(blank)})`);
    await page.type("#test-title", "Brand New Mock 7");
    await page.type("#test-subtitle", "Created from the e2e");
    await page.click('#test-form button[type="submit"]');
    await page.waitForFunction(() => /Editing\s+Brand New Mock 7/.test((document.querySelector(".setup-mode") || {}).innerText || ""), { timeout: 10000 }).catch(() => null);
    check((await countTests()) === before + 1, "Create test adds exactly one new test");
    check(/Editing\s+Brand New Mock 7/.test(await page.$eval(".setup-mode", (el) => el.innerText)), "the new test is then selected for editing");


    // Existing Tests: admins set the order students see (arrows and drag-and-drop, saved in one request).
    const orderNow = () => page.evaluate(() => Array.from(document.querySelectorAll("[data-tests-order] [data-test-row]")).map((r) => ({ title: r.querySelector("strong").textContent, pos: r.querySelector(".tests-order-pos").textContent })));
    await page.evaluate(() => document.querySelector('.js-studio-tab[data-tab="tests"]').click());
    await page.waitForSelector("[data-tests-order]", { timeout: 10000 });
    const first = await orderNow();
    check(first.length >= 2 && first.map((r) => r.pos).join(",") === first.map((_, i) => String(i + 1)).join(","), `Existing Tests shows each test's position (${first.map((r) => r.pos + ". " + r.title).join(" | ")})`);
    const upDisabled = await page.$eval("[data-tests-order] [data-test-row] .js-move-test-up", (b) => b.disabled);
    check(upDisabled, "the first test can't move further up");
    await page.click("[data-tests-order] [data-test-row] .js-move-test-down");
    await page.waitForFunction(() => /Moved .+ to position 2 of/.test((document.querySelector("[data-tests-order-status]") || {}).textContent || ""), { timeout: 10000 }).catch(() => null);
    const afterDown = await orderNow();
    check(afterDown[0].title === first[1].title && afterDown[1].title === first[0].title, `↓ swaps the first two tests (${afterDown.map((r) => r.title).join(" | ")})`);
    check(/Moved .+ to position 2 of/.test(await page.$eval("[data-tests-order-status]", (el) => el.textContent)), "the move is announced");
    await page.reload({ waitUntil: "networkidle2" });
    await page.waitForSelector('.js-studio-tab[data-tab="tests"]', { timeout: 20000 });
    await page.evaluate(() => document.querySelector('.js-studio-tab[data-tab="tests"]').click());
    await page.waitForSelector("[data-tests-order]", { timeout: 10000 });
    check((await orderNow())[0].title === first[1].title, "the new order is saved (still there after a reload)");
    await page.evaluate(() => {
      const rows = document.querySelectorAll("[data-tests-order] [data-test-row]");
      const handle = rows[1].querySelector("[data-drag-test]");
      const target = rows[0];
      const dt = new DataTransfer();
      const r = target.getBoundingClientRect();
      handle.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: dt }));
      target.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt, clientY: r.top + 2 }));
      target.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt, clientY: r.top + 2 }));
    });
    await page.waitForFunction((title) => (document.querySelector("[data-tests-order] [data-test-row] strong") || {}).textContent === title, { timeout: 10000 }, first[0].title).catch(() => null);
    check((await orderNow())[0].title === first[0].title, "dragging a row onto the first place moves it there");

    // Import from Excel/CSV: the preview renders the maths and flags the broken row; importing
    // saves the ready rows and attaches them to the test being edited, in sheet order.
    const ExcelJS = req("node_modules/exceljs");
    const sheetDir = fs.mkdtempSync(path.join(dataRoot, "import-"));
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Questions");
    ws.addRow(["section", "topic", "difficulty", "question", "option_a", "option_b", "option_c", "option_d", "answer"]);
    ws.addRow(["SUPR", "Kinematics", "medium", "Kinetic energy of mass $m$ at speed $v$", "$mv$", "$\\frac{1}{2}mv^2$", "$mv^2$", "$2mv^2$", "B"]);
    ws.addRow(["SUPR", "Calculus", "medium", "Broken $\\frac{1}{$", "1", "2", "", "", "A"]);
    ws.addRow(["REAP", "Logic", "easy", "Next: 2, 6, 12, 20, ?", "28", "30", "32", "36", "B"]);
    const xlsxPath = path.join(sheetDir, "paper.xlsx");
    await wb.xlsx.writeFile(xlsxPath);
    await page.evaluate(() => document.querySelector('.js-studio-tab[data-tab="questions"]').click());
    await page.waitForSelector(".js-open-question-import", { timeout: 10000 });
    await page.click(".js-open-question-import");
    await page.waitForSelector("[data-import-dialog] #import-file", { timeout: 5000 });
    check(/Brand New Mock 7/.test(await page.$eval(".import-target", (el) => el.innerText)), "import offers to add the questions to the test being edited");
    await (await page.$("#import-file")).uploadFile(xlsxPath);
    await page.click("[data-import-check]");
    await page.waitForSelector("[data-import-summary]", { timeout: 15000 }).catch(() => null);
    await page.waitForFunction(() => document.querySelectorAll(".import-table .katex").length >= 4, { timeout: 10000 }).catch(() => null);
    const pv = await page.evaluate(() => ({
      summary: (document.querySelector("[data-import-summary]") || {}).textContent || "",
      focused: Boolean(document.activeElement && document.activeElement.hasAttribute("data-import-summary")),
      katex: document.querySelectorAll(".import-table .katex").length,
      errorRow: (document.querySelector('[data-import-row="3"]') || {}).innerText || "",
      button: (document.querySelector("[data-import-commit]") || {}).textContent || "",
    }));
    check(/^2 ready · 1 with errors/.test(pv.summary) && pv.focused, `preview summary is focused (${pv.summary})`);
    check(pv.katex >= 4, `preview renders the maths with KaTeX (${pv.katex} formulas)`);
    check(/question: formula/.test(pv.errorRow), "the broken formula is flagged on its row (row 3)");
    check(pv.button === "Import 2 questions", `the import button counts only the ready rows (${pv.button})`);
    await page.click("[data-import-commit]");
    await page.waitForFunction(() => /2 questions added to Brand New Mock 7 \(SUPR 1, REAP 1\)/.test((document.querySelector("[data-import-status]") || {}).textContent || ""), { timeout: 15000 }).catch(() => null);
    check(/2 questions added to Brand New Mock 7 \(SUPR 1, REAP 1\)/.test(await page.$eval("[data-import-status]", (el) => el.textContent)), "import says how many were added and where");
    await mongoose.connect(uri);
    const mock7 = await Test.findOne({ title: "Brand New Mock 7" }).lean();
    const attached = await Question.find({ _id: { $in: mock7.questionIds } }).lean();
    const byId = Object.fromEntries(attached.map((q) => [String(q._id), q.prompt]));
    await mongoose.disconnect();
    check(JSON.stringify(mock7.questionIds.map((id) => byId[String(id)])) === JSON.stringify(["Kinetic energy of mass $m$ at speed $v$", "Next: 2, 6, 12, 20, ?"]), "the questions are attached in sheet order, LaTeX unchanged");
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => /2 \/ 90 Questions Attached/.test((document.querySelector(".studio-question-progress") || {}).innerText || ""), { timeout: 10000 }).catch(() => null);
    check(/2 \/ 90 Questions Attached/.test(await page.$eval(".studio-question-progress", (el) => el.innerText)), "Questions Studio shows the imported questions");

    // CSV into the question bank only (from the Bank tab).
    const csvPath = path.join(sheetDir, "bank.csv");
    fs.writeFileSync(csvPath, "﻿section,topic,question,option_a,option_b,answer\r\nREAP,Series,\"Sum $\\sum_{k=1}^{n} k$, for n = 3\",6,9,A\r\n");
    await page.evaluate(() => document.querySelector('.js-studio-tab[data-tab="bank"]').click());
    await page.waitForSelector("#bank-search", { timeout: 10000 });
    await page.evaluate(() => document.querySelector(".js-open-question-import").click());
    await page.waitForSelector("[data-import-dialog] #import-file", { timeout: 5000 });
    check(!(await page.$(".import-target")), "from the Bank tab the questions go to the bank only");
    await (await page.$("#import-file")).uploadFile(csvPath);
    await page.click("[data-import-check]");
    await page.waitForSelector("[data-import-commit]", { timeout: 15000 }).catch(() => null);
    await page.waitForFunction(() => document.querySelector(".import-table .katex"), { timeout: 10000 }).catch(() => null);
    check(Boolean(await page.$(".import-table .katex")) && /^1 ready/.test(await page.$eval("[data-import-summary]", (el) => el.textContent)), "a CSV previews the same way (1 ready, maths rendered)");
    await page.click("[data-import-commit]");
    await page.waitForFunction(() => /1 question added to the question bank \(REAP 1\)/.test((document.querySelector("[data-import-status]") || {}).textContent || ""), { timeout: 15000 }).catch(() => null);
    check(/1 question added to the question bank/.test(await page.$eval("[data-import-status]", (el) => el.textContent)), "the CSV row is added to the bank");
    await page.keyboard.press("Escape");
    fs.rmSync(sheetDir, { recursive: true, force: true });

    // Scheduled publishing from Setup; students see a countdown and no Start button.
    await page.evaluate(() => document.querySelector('.js-studio-tab[data-tab="setup"]').click());
    await page.waitForSelector("#test-publishing", { timeout: 10000 });
    await page.select("#test-publishing", "scheduled");
    check(await page.$eval(".test-publish-at", (el) => !el.hidden), "choosing Scheduled shows the date-time field");
    await page.$eval("#test-publish-at", (el) => {
      const d = new Date(Date.now() + 2 * 60 * 60 * 1000);
      const pad = (n) => String(n).padStart(2, "0");
      el.value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    });
    await page.click('#test-form button[type="submit"]');
    await sleep(1500);
    await mongoose.connect(uri);
    const scheduled = await Test.findOne({ title: "Brand New Mock 7" }).lean();
    await mongoose.disconnect();
    const inMs = scheduled.publishAt ? new Date(scheduled.publishAt).getTime() - Date.now() : 0;
    check(scheduled.status === "scheduled" && inMs > 100 * 60 * 1000 && inMs < 121 * 60 * 1000, `the test is saved as scheduled about 2 h ahead (${scheduled.status}, ${Math.round(inMs / 60000)} min)`);
    await page.evaluate(() => document.querySelector('.js-studio-tab[data-tab="tests"]').click());
    await page.waitForSelector("[data-tests-order]", { timeout: 10000 });
    check(await page.evaluate(() => Array.from(document.querySelectorAll(".meta-chip.is-scheduled")).some((c) => /scheduled ·/.test(c.textContent))), "Existing Tests shows the scheduled time");

    const studentCtx = await browser.createBrowserContext();
    const student = await newHermeticPage(studentCtx);
    student.on("pageerror", (e) => pageErrors.push(e.stack || e.message));
    await student.setViewport({ width: 1280, height: 900 });
    await student.goto(`${BASE}/#/login`, { waitUntil: "networkidle2" });
    await student.waitForSelector("#login-email");
    await student.type("#login-email", "buyer@test.local");
    await student.type("#login-password", "Passw0rd!long");
    await student.click("#login-submit-btn");
    await student.waitForFunction(() => location.hash.length > 2 && !/login/.test(location.hash), { timeout: 15000 });
    // Page changes no longer cover the screen with the blurred loader.
    await student.evaluate(() => {
      window.__overlaySeen = false;
      new MutationObserver(() => { if (document.querySelector("[data-sync-overlay='true']")) window.__overlaySeen = true; }).observe(document.body, { childList: true, subtree: true });
    });
    await student.evaluate(() => { location.hash = "#/exams"; });
    await student.waitForFunction(() => /Brand New Mock 7/.test(document.body.innerText), { timeout: 15000 }).catch(() => null);
    const card = await student.evaluate(() => {
      // The smallest element around a countdown that also names the test = that test's card.
      let scope = null;
      document.querySelectorAll(".test-opens").forEach((el) => {
        let node = el;
        while (node && node !== document.body && !/Brand New Mock 7/.test(node.innerText)) node = node.parentElement;
        if (node && node !== document.body && !scope) scope = node;
      });
      const opens = scope ? scope.querySelector(".test-opens") : null;
      const button = scope ? scope.querySelector("button") : null;
      return { text: opens ? opens.textContent : "", button: button ? button.textContent.trim() : "", disabled: Boolean(button && button.disabled), start: scope ? /\bStart\b/.test(scope.innerText) : true, page: scope ? "" : document.body.innerText.slice(0, 600), hash: location.hash };
    });
    if (!card.text) log("student page:", card.hash, card.page.replace(/\s+/g, " "));
    check(/^Opens .+ IST · in (1 h 5\d m|2 h)/.test(card.text), `students see when it opens with a countdown (${card.text})`);
    check(card.button === "Opens soon" && card.disabled && !card.start, `no Start button before it opens (${card.button})`);
    await student.evaluate(() => { location.hash = "#/dashboard"; });
    await sleep(1200);
    await student.evaluate(() => { location.hash = "#/exams"; });
    await sleep(1200);
    check(!(await student.evaluate(() => window.__overlaySeen)), "changing pages shows no full-screen loader");
    await studentCtx.close();
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
