// Browser checks for the Drive-style study materials browser:
// - students: folder tiles with counts, breadcrumbs and Back, a dense list of 60 files that fits
//   phones without sideways scroll, list/grid toggle remembered, search with folder paths, open
//   and download links through the portal, no admin controls, the "not connected" state;
// - admins (Studio → Study Materials): Connect Google Drive, new folder, upload with progress
//   straight to the Drive session, rename / move / colour / delete from the row menu.
// /api/materials is answered by a fake Drive (intercepted); everything else is the real server.
// Usage: node tests/e2e/materials.e2e.js
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const puppeteer = require("puppeteer-core");
const { BACKEND, CHROME_PATH, SHOTS_DIR, serverEnv, newHermeticPage } = require("./helpers");

const PORT = 4988;
const BASE = `http://127.0.0.1:${PORT}`;
const req = (m) => require(path.join(BACKEND, m));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log("[materials-e2e]", ...a);
const SHOTS = path.join(SHOTS_DIR, "materials");
const FOLDER = "application/vnd.google-apps.folder";

function fakeDrive() {
  const items = new Map();
  let n = 0;
  const fake = { items, connected: true, writes: [], uploads: [] };
  const add = (props) => {
    n += 1;
    const item = { id: props.id || `drv${String(n).padStart(6, "0")}xyz`, mimeType: "application/pdf", modifiedTime: "2026-10-15T10:00:00.000Z", size: 245760, ...props };
    items.set(item.id, item);
    return item;
  };
  const root = add({ id: "rootFolderId0001", name: "AceIIIT Study Materials", mimeType: FOLDER, parent: null });
  const physics = add({ name: "Physics", mimeType: FOLDER, parent: root.id, color: "#4285f4" });
  const mech = add({ name: "Mechanics", mimeType: FOLDER, parent: physics.id });
  add({ name: "Chemistry", mimeType: FOLDER, parent: root.id });
  for (let i = 1; i <= 60; i += 1) add({ name: `Physics notes chapter ${i} - a fairly long file name to test truncation.pdf`, parent: physics.id });
  add({ name: "Kinematics formula sheet.pdf", parent: mech.id });
  Object.assign(fake, { root, physics, mech, add });
  const kids = (id) => [...items.values()].filter((i) => i.parent === id);
  const view = (i) => ({ id: i.id, name: i.name, kind: i.mimeType === FOLDER ? "folder" : "file", mimeType: i.mimeType, size: i.mimeType === FOLDER ? null : i.size, modifiedTime: i.modifiedTime, color: i.color || "", hasThumbnail: false, googleType: "", ...(i.mimeType === FOLDER ? { itemCount: kids(i.id).length } : {}) });
  const chain = (id) => {
    const out = [];
    let cur = items.get(id);
    while (cur) { out.unshift(cur); cur = cur.parent ? items.get(cur.parent) : null; }
    return out;
  };
  const listing = (id) => {
    const folder = items.get(id || root.id);
    const list = kids(folder.id).sort((a, b) => (a.mimeType === FOLDER) === (b.mimeType === FOLDER) ? a.name.localeCompare(b.name, undefined, { numeric: true }) : a.mimeType === FOLDER ? -1 : 1);
    return {
      connected: true,
      folder: { id: folder.id, name: folder.id === root.id ? "Study material" : folder.name, isRoot: folder.id === root.id },
      breadcrumbs: chain(folder.id).map((f) => ({ id: f.id, name: f.id === root.id ? "Study material" : f.name })),
      folders: list.filter((i) => i.mimeType === FOLDER).map(view),
      files: list.filter((i) => i.mimeType !== FOLDER).map(view),
      maxBytes: 100 * 1024 * 1024,
    };
  };
  fake.hook = async (request) => {
    const url = new URL(request.url());
    const json = (status, body) => request.respond({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (url.pathname.startsWith("/__fake_drive_upload/")) {
      const body = request.postData() || "";
      const name = decodeURIComponent(url.pathname.split("/").pop());
      const target = fake.uploads[fake.uploads.length - 1];
      const file = add({ name, parent: target.parentId || root.id, size: body.length });
      await sleep(400);
      return json(200, { id: file.id, name: file.name }), true;
    }
    if (url.hostname === "accounts.google.test") return request.respond({ status: 200, contentType: "text/html", body: "<h1>Google consent (fake)</h1>" }), true;
    if (!url.pathname.startsWith("/api/materials")) return false;
    const method = request.method();
    const body = (() => { try { return JSON.parse(request.postData() || "{}"); } catch (_e) { return {}; } })();
    const p = url.pathname.replace("/api/materials", "") || "/";
    if (method !== "GET") fake.writes.push({ method, path: p, body });
    if (p === "/" && method === "GET") return json(200, fake.connected ? listing(url.searchParams.get("folder")) : { connected: false }), true;
    if (p === "/search") {
      const q = (url.searchParams.get("q") || "").toLowerCase();
      const found = [...items.values()].filter((i) => i.id !== root.id && i.name.toLowerCase().includes(q)).map((i) => ({ ...view(i), path: chain(i.parent).map((f) => (f.id === root.id ? "Study material" : f.name)) }));
      return json(200, { connected: true, items: found }), true;
    }
    if (p === "/drive") return json(200, { drive: fake.connected ? { connected: true, accountEmail: "owner@gmail.test", root: { id: root.id, name: root.name, url: `https://drive.google.com/drive/folders/${root.id}` } } : { connected: false } }), true;
    if (p === "/drive/connect") return json(200, { url: "https://accounts.google.test/o/oauth2/auth?state=abc" }), true;
    if (p === "/refresh") return json(200, { ok: true }), true;
    if (p === "/folders") {
      const folder = add({ name: body.name, mimeType: FOLDER, parent: body.parentId || root.id });
      return json(201, { folder: view(folder) }), true;
    }
    const itemMatch = /^\/items\/([A-Za-z0-9_-]+)$/.exec(p);
    if (itemMatch) {
      const item = items.get(itemMatch[1]);
      if (method === "DELETE") { items.delete(item.id); return json(200, { ok: true }), true; }
      if (body.name) item.name = body.name;
      if (body.parentId) item.parent = body.parentId;
      if (body.color !== undefined) item.color = body.color;
      return json(200, { item: view(item) }), true;
    }
    if (p === "/uploads/session") {
      fake.uploads.push(body);
      return json(200, { uploadUrl: `${BASE}/__fake_drive_upload/${encodeURIComponent(body.name)}`, parentId: body.parentId }), true;
    }
    if (p === "/uploads/complete") return json(200, { file: view(items.get(body.fileId)) }), true;
    return json(404, { error: "not faked" }), true;
  };
  return fake;
}

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const { MongoMemoryServer } = req("node_modules/mongodb-memory-server");
  const mongoose = req("node_modules/mongoose");
  const bcrypt = req("node_modules/bcryptjs");
  const dataRoot = path.join(BACKEND, "node_modules/.cache/mongodb-test-data");
  fs.mkdirSync(dataRoot, { recursive: true });
  const dbPath = fs.mkdtempSync(path.join(dataRoot, "materials-e2e-"));
  const mongod = await MongoMemoryServer.create({ instance: { dbPath } });
  const uri = mongod.getUri() + "materialse2e";
  await mongoose.connect(uri);
  const User = req("models/User");
  await req("models/Season").create({ name: "UGEE 2026", year: 2026, status: "active", isDefaultActive: true });
  const hash = await bcrypt.hash("Passw0rd!long", 4);
  await User.create({ name: "riya", email: "riya@test.local", status: "active", isActivated: true, emailVerified: true, passwordHash: hash });
  await User.create({ name: "Admin", email: "admin@test.local", role: "admin", status: "active", isActivated: true, emailVerified: true, passwordHash: hash });
  await mongoose.disconnect();

  const server = spawn(process.execPath, ["server.js"], { cwd: BACKEND, env: serverEnv({ MONGODB_URI: uri, PORT: String(PORT), ADMIN_EMAILS: "admin@test.local" }) });
  let serverLog = "";
  server.stdout.on("data", (d) => (serverLog += d));
  server.stderr.on("data", (d) => (serverLog += d));
  for (let i = 0; i < 40; i += 1) { try { if ((await fetch(`${BASE}/ready`)).status === 200) break; } catch (_e) { /* not up yet */ } await sleep(250); }

  const browser = await puppeteer.launch({ executablePath: CHROME_PATH, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  const failures = [];
  const pageErrors = [];
  const check = (cond, msg) => { (cond ? log("PASS", msg) : (log("FAIL", msg), failures.push(msg))); };
  const answers = [];
  const login = async (page, email) => {
    await page.goto(`${BASE}/#/login`, { waitUntil: "networkidle2" });
    await page.waitForSelector("#login-email");
    await page.type("#login-email", email);
    await page.type("#login-password", "Passw0rd!long");
    await page.click("#login-submit-btn");
    await page.waitForFunction(() => location.hash.length > 2 && !/login/.test(location.hash), { timeout: 15000 });
  };
  const until = (page, fn, arg, timeout = 8000) => page.waitForFunction(fn, { timeout }, arg).then(() => true).catch(() => false);
  try {
    // ---------------- Student ----------------
    let fake = fakeDrive();
    const page = await newHermeticPage(browser);
    await page.setViewport({ width: 1366, height: 900 });
    page.on("pageerror", (e) => pageErrors.push(e.stack || e.message));
    page.on("dialog", async (d) => { const a = answers.shift(); log("dialog:", d.message().split("\n")[0], "→", a === undefined ? "accept" : a); await (a === false ? d.dismiss() : d.accept(a === undefined || a === true ? undefined : a)); });
    page.interceptHook = (r) => fake.hook(r);
    await login(page, "riya@test.local");
    await page.goto(`${BASE}/#/resources/materials`, { waitUntil: "networkidle2" });
    await until(page, () => document.querySelectorAll(".drive-folder").length === 2);
    const top = await page.evaluate(() => ({
      folders: Array.from(document.querySelectorAll(".drive-folder")).map((f) => f.innerText.replace(/\s+/g, " ").trim()),
      crumbs: document.querySelector(".drive-crumbs").innerText.trim(),
      adminControls: document.querySelectorAll("[data-drive-action='upload'], [data-drive-action='new-folder'], .drive-more").length,
      color: getComputedStyle(document.querySelector(".drive-folder:nth-child(2) .drive-folder-icon")).color,
    }));
    check(top.folders[0] === "Chemistry 0 items" && top.folders[1] === "Physics 61 items", `folders first, as tiles with counts (${top.folders.join(" | ")})`);
    check(top.crumbs === "Study material" && top.adminControls === 0, "students see breadcrumbs and no admin controls");
    check(top.color === "rgb(66, 133, 244)", `a folder keeps its Drive colour (${top.color})`);

    await page.click(".drive-folder:nth-child(2) .drive-folder-link");
    await until(page, () => document.querySelectorAll(".drive-file").length === 60);
    const inside = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll(".drive-file"));
      const first = rows[0];
      const open = first.querySelector(".drive-file-name");
      const dl = first.querySelector(".drive-icon-btn");
      return {
        hash: location.hash,
        crumbs: Array.from(document.querySelectorAll(".drive-crumbs li")).map((li) => li.innerText.trim()),
        rows: rows.length,
        rowHeight: Math.round(first.getBoundingClientRect().height),
        listHeight: Math.round(document.querySelector(".drive-files").getBoundingClientRect().height),
        openHref: open.getAttribute("href"), target: open.target, dlHref: dl.getAttribute("href"), dlLabel: dl.getAttribute("aria-label"),
        ellipsis: getComputedStyle(first.querySelector(".drive-file-title")).textOverflow,
        overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
      };
    });
    check(/^#\/?resources\/materials\/drv/.test(inside.hash) && inside.crumbs.join(" > ") === "Study material > Physics", `opening a folder updates the route and breadcrumbs (${inside.crumbs.join(" > ")})`);
    check(inside.rows === 60 && inside.rowHeight <= 64 && inside.listHeight < 60 * 66, `60 files in a dense list (${inside.rowHeight}px rows, ${inside.listHeight}px total)`);
    check(/^\/api\/materials\/files\/drv\w+\/content$/.test(inside.openHref) && inside.target === "_blank" && /\?download=1$/.test(inside.dlHref) && /^Download /.test(inside.dlLabel), "each file opens and downloads through the portal");
    check(inside.ellipsis === "ellipsis" && !inside.overflow, "long names truncate; no sideways scroll");
    await page.screenshot({ path: path.join(SHOTS, "student-list-1366.png") });

    await page.click(".drive-folder .drive-folder-link");
    await until(page, () => /Kinematics formula sheet/.test(document.body.innerText));
    check((await page.evaluate(() => Array.from(document.querySelectorAll(".drive-crumbs li")).map((li) => li.innerText.trim()).join(" > "))) === "Study material > Physics > Mechanics", "subfolders open inside folders (any depth)");
    await page.goBack({ waitUntil: "networkidle2" }).catch(() => null);
    await until(page, () => document.querySelectorAll(".drive-file").length === 60);
    check((await page.$$(".drive-file")).length === 60, "Back returns to the parent folder");

    await page.click('[data-drive-view="grid"]');
    const grid = await page.evaluate(() => ({ view: document.querySelector(".drive").getAttribute("data-view"), cols: getComputedStyle(document.querySelector(".drive-files")).gridTemplateColumns.split(" ").length }));
    check(grid.view === "grid" && grid.cols >= 4, `grid view lays files out in columns (${grid.cols})`);
    await page.screenshot({ path: path.join(SHOTS, "student-grid-1366.png") });
    await page.reload({ waitUntil: "networkidle2" });
    await until(page, () => document.querySelector(".drive"));
    check((await page.$eval(".drive", (d) => d.getAttribute("data-view"))) === "grid", "the chosen view is remembered");
    await page.click('[data-drive-view="list"]');

    await page.type("[data-drive-search]", "kinem");
    await until(page, () => /1 result/.test((document.querySelector(".drive-result-count") || {}).innerText || ""));
    const result = await page.evaluate(() => (document.querySelector(".drive-file") || {}).innerText || "");
    check(/Kinematics formula sheet/.test(result) && /Study material › Physics › Mechanics/.test(result), "search finds files and shows where they are");
    check((await page.evaluate(() => document.activeElement && document.activeElement.hasAttribute("data-drive-search"))), "typing in search keeps focus in the box");

    // Phone width
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
    await page.goto(`${BASE}/#/resources/materials/${fake.physics.id}`, { waitUntil: "networkidle2" });
    await until(page, () => document.querySelectorAll(".drive-file").length === 60);
    const phone = await page.evaluate(() => {
      const row = document.querySelector(".drive-file");
      const dl = row.querySelector(".drive-icon-btn").getBoundingClientRect();
      return { overflow: document.documentElement.scrollWidth > window.innerWidth + 1, date: getComputedStyle(row.querySelector(".drive-file-date")).display, tap: Math.round(Math.min(dl.width, dl.height)) };
    });
    check(!phone.overflow && phone.date === "none" && phone.tap >= 44, `phones: no sideways scroll, date column dropped, 44px targets (${phone.tap}px)`);
    await page.screenshot({ path: path.join(SHOTS, "student-list-390.png") });
    await page.setViewport({ width: 1366, height: 900 });

    fake.connected = false;
    await page.goto(`${BASE}/#/resources/materials`, { waitUntil: "networkidle2" });
    await page.reload({ waitUntil: "networkidle2" });
    check(await until(page, () => /isn't available yet/.test(document.body.innerText)), "not connected: students see that material isn't available yet");

    // ---------------- Admin ----------------
    fake = fakeDrive();
    fake.connected = false;
    await page.evaluate(() => fetch("/api/auth/logout", { method: "POST", headers: { "X-CSRF-Token": decodeURIComponent((document.cookie.match(/aceiiit_csrf=([^;]+)/) || [])[1] || "") } }));
    await login(page, "admin@test.local");
    await page.goto(`${BASE}/#/admin`, { waitUntil: "networkidle2" });
    await page.waitForSelector('.js-studio-tab[data-tab="materials"]', { timeout: 20000 });
    await page.evaluate(() => document.querySelector('.js-studio-tab[data-tab="materials"]').click());
    check(await until(page, () => /Connect Google Drive/.test(document.body.innerText)), "Studio shows Connect Google Drive until a Drive is connected");
    await Promise.all([page.waitForNavigation({ timeout: 8000 }).catch(() => null), page.click('[data-drive-action="connect"]')]);
    check(/accounts\.google\.test/.test(page.url()), "Connect sends the admin to Google's consent screen");

    fake.connected = true;
    await page.goto(`${BASE}/?drive=connected#admin`, { waitUntil: "networkidle2" });
    await page.waitForSelector("#materials-studio .drive", { timeout: 20000 }).catch(() => null);
    const back = await page.evaluate(() => ({ text: (document.getElementById("materials-studio") || {}).innerText || "", url: location.href }));
    check(/Google Drive is connected/.test(back.text) && /owner@gmail\.test/.test(back.text) && !/drive=connected/.test(back.url), "back from Google: the materials tab opens, says it's connected, and cleans the URL");

    answers.push("Biology");
    await page.click('[data-drive-action="new-folder"]');
    check(await until(page, () => Array.from(document.querySelectorAll(".drive-folder-name")).some((n) => n.textContent === "Biology")), "New folder creates it in the open folder");
    await page.evaluate(() => Array.from(document.querySelectorAll(".drive-folder-link")).find((b) => /Physics/.test(b.innerText)).click());
    await until(page, () => document.querySelectorAll(".drive-file").length === 60);

    const input = await page.$("[data-drive-file]");
    const tmp = path.join(SHOTS, "Optics.pdf");
    fs.writeFileSync(tmp, "%PDF-1.4 fake optics notes");
    await input.uploadFile(tmp);
    const progress = await until(page, () => /Uploading|Optics\.pdf/.test((document.getElementById("material-upload-panel") || {}).innerText || ""), null, 4000);
    check(progress, "uploads show in the background panel");
    check(await until(page, () => /Uploaded to Physics/.test((document.getElementById("material-upload-panel") || {}).innerText || "")), "the file goes to the Drive session and is confirmed");
    check(fake.uploads[0] && fake.uploads[0].parentId === fake.physics.id && fake.uploads[0].name === "Optics.pdf", "the upload targets the open folder");
    check(await until(page, () => Array.from(document.querySelectorAll(".drive-file-title")).some((t) => t.textContent === "Optics.pdf")), "the new file appears in the folder");

    const optics = [...fake.items.values()].find((i) => i.name === "Optics.pdf");
    answers.push("Optics (ray).pdf");
    await page.click(`[data-drive-menu="${optics.id}"]`);
    const menu = await page.evaluate(() => ({ items: Array.from(document.querySelectorAll(".drive-menu [role^=menuitem]")).map((m) => m.textContent.trim()), focus: document.activeElement && document.activeElement.getAttribute("role") }));
    check(menu.items.join(",") === "Open,Rename,Move to…,Open in Google Drive,Delete" && menu.focus === "menuitem", `the row menu offers the file actions with focus inside (${menu.items.join(", ")})`);
    await page.keyboard.press("Escape");
    check(await page.evaluate((id) => !document.querySelector(".drive-menu") && document.activeElement && document.activeElement.getAttribute("data-drive-menu") === id, optics.id), "Escape closes the menu and returns focus");
    await page.click(`[data-drive-menu="${optics.id}"]`);
    await page.click('[data-drive-do="rename"]');
    check(await until(page, () => Array.from(document.querySelectorAll(".drive-file-title")).some((t) => t.textContent === "Optics (ray).pdf")), "Rename works");

    await page.click(`[data-drive-menu="${optics.id}"]`);
    await page.click('[data-drive-do="move"]');
    await until(page, () => document.querySelectorAll(".drive-pick").length >= 2);
    await page.evaluate(() => Array.from(document.querySelectorAll(".drive-pick")).find((b) => /Chemistry/.test(b.innerText)).click());
    await until(page, () => /Chemistry/.test((document.querySelector("[data-drive-picker] [aria-current]") || {}).textContent || ""));
    await page.click("[data-pick-move]");
    const chem = [...fake.items.values()].find((i) => i.name === "Chemistry");
    check(await until(page, () => !document.querySelector(".admin-modal-overlay")) && fake.items.get(optics.id).parent === chem.id, "Move to… picks a folder and moves the file there");

    const physicsTileMenu = async () => {
      await page.evaluate(() => Array.from(document.querySelectorAll(".drive-crumb")).find((b) => /Study material/.test(b.innerText)).click());
      await until(page, () => document.querySelectorAll(".drive-folder").length >= 3);
    };
    await physicsTileMenu();
    await page.click(`[data-drive-menu="${fake.physics.id}"]`);
    await page.click('.drive-swatch[aria-label="Green"]');
    await sleep(700);
    check(fake.items.get(fake.physics.id).color === "#0f9d58", "folder colour can be changed");
    const bio = [...fake.items.values()].find((i) => i.name === "Biology");
    answers.push(true);
    await page.click(`[data-drive-menu="${bio.id}"]`);
    await page.click('[data-drive-do="delete"]');
    check(await until(page, () => !Array.from(document.querySelectorAll(".drive-folder-name")).some((n) => n.textContent === "Biology")) && !fake.items.has(bio.id), "Delete (after confirming) removes the folder");
    await page.screenshot({ path: path.join(SHOTS, "studio-1366.png") });

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
