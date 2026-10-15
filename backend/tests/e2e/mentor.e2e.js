// Browser checks for ACEIIIT Mentor (the floating help button):
// - there is one floating button; it opens the mentor panel (no second button), and is hidden
//   on exam screens;
// - with no Gemini key the real server says the mentor isn't set up and offers no composer;
// - the button morphs into the panel and back; a dotted orb greets, flies into the chat and
//   works through stage labels that match the question, then resolves into the reply;
// - with /api/mentor answered by a fake backend (intercepted): suggestions, a safe
//   Markdown reply (no HTML from the model runs), usage line, a failed reply that is retried
//   with the same message id, the upgrade panel after the last free reply, "Maybe Later",
//   history (open, delete), minimise keeps the conversation, and opening from a results page
//   links the conversation to that attempt;
// - phones: a near-full-screen modal sheet (inert background) that Back closes; dark mode;
//   reduced motion; signing out removes the panel.
// Usage: node tests/e2e/mentor.e2e.js
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const puppeteer = require("puppeteer-core");
const { BACKEND, CHROME_PATH, SHOTS_DIR, serverEnv, newHermeticPage } = require("./helpers");

const PORT = 4987;
const BASE = `http://127.0.0.1:${PORT}`;
const req = (m) => require(path.join(BACKEND, m));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log("[mentor-e2e]", ...a);
const SHOTS = path.join(SHOTS_DIR, "mentor");
const CTA = "https://ketc8up.github.io/AceIIIT/registrations.html";
const UPGRADE_MESSAGE = "You've used your free AI Mentor messages for this month. Enrol in the ACEIIIT UGEE preparation programme to continue getting personalized guidance on your performance, mistakes, weak topics, and study strategy.";

const hex = () => Array.from({ length: 24 }, () => "0123456789abcdef"[Math.floor(Math.random() * 16)]).join("");

/** A stand-in for the mentor API, so the UI can be driven through every state. */
function fakeMentor() {
  const fake = { remaining: 10, limit: 10, available: true, reason: "", conversations: [], messages: {}, sends: [], creates: [], failNext: null, delayMs: 700 };
  fake.usage = () => ({
    tier: "free", limit: fake.limit, used: fake.limit - fake.remaining, remaining: fake.remaining, period: "2026-10",
    periodStartsAt: "2026-09-30T18:30:00.000Z", resetsAt: "2026-10-31T18:30:00.000Z", timezone: "Asia/Kolkata",
    canReply: fake.available && fake.remaining > 0, source: null, expiresAt: null, ctaUrl: CTA,
    available: fake.available, reason: fake.reason, maxInputChars: 2000,
  });
  fake.hook = async (request) => {
    const url = new URL(request.url());
    if (!url.pathname.startsWith("/api/mentor/")) return false;
    const method = request.method();
    const json = (status, body) => request.respond({ status, contentType: "application/json", body: JSON.stringify(body) });
    const body = (() => { try { return JSON.parse(request.postData() || "{}"); } catch (_e) { return {}; } })();
    const conv = /^\/api\/mentor\/conversations\/([a-f0-9]{24})(\/messages)?$/.exec(url.pathname);
    if (url.pathname === "/api/mentor/usage") return json(200, { usage: fake.usage() }), true;
    if (url.pathname === "/api/mentor/conversations" && method === "GET") return json(200, { conversations: fake.conversations }), true;
    if (url.pathname === "/api/mentor/conversations" && method === "POST") {
      fake.creates.push(body);
      const c = { id: hex(), title: "New conversation", attempt: body.attemptId ? { id: body.attemptId, test: "UGEE 2026 Mock Test 1", attemptNumber: 1 } : null, messageCount: 0, lastMessageAt: new Date().toISOString(), createdAt: new Date().toISOString() };
      fake.conversations.unshift(c);
      fake.messages[c.id] = [];
      return json(201, { conversation: c }), true;
    }
    if (conv && !conv[2] && method === "GET") {
      const c = fake.conversations.find((x) => x.id === conv[1]);
      return (c ? json(200, { conversation: c, messages: fake.messages[c.id] || [] }) : json(404, { error: "Conversation not found", code: "MENTOR_NOT_FOUND" })), true;
    }
    if (conv && !conv[2] && method === "DELETE") {
      fake.conversations = fake.conversations.filter((x) => x.id !== conv[1]);
      return json(200, { ok: true }), true;
    }
    if (conv && conv[2] && method === "POST") {
      fake.sends.push(body);
      await sleep(fake.delayMs);
      if (fake.failNext) {
        const failure = fake.failNext;
        fake.failNext = null;
        return json(503, { error: failure, code: "MENTOR_PROVIDER_ERROR", retryable: true, usage: fake.usage() }), true;
      }
      if (fake.remaining <= 0) return json(429, { error: "You've used this month's mentor replies.", code: "MENTOR_LIMIT", retryable: false, usage: fake.usage() }), true;
      fake.remaining -= 1;
      const c = fake.conversations.find((x) => x.id === conv[1]);
      if (c && c.title === "New conversation") c.title = body.content.slice(0, 60);
      const userMessage = { id: hex(), role: "user", content: body.content, status: "complete", clientMessageId: body.clientMessageId, createdAt: new Date().toISOString() };
      const assistantMessage = {
        id: hex(), role: "assistant", status: "complete", createdAt: new Date().toISOString(),
        content: "**Accuracy** is your main lever.\n\n- Review wrong answers first\n- Skip pure guesses\n\n1. Redo 10 algebra questions\n2. Time each one\n\n<img src=x onerror=\"window.__mentorXss=1\"><script>window.__mentorXss=2</script>",
      };
      fake.messages[conv[1]] = (fake.messages[conv[1]] || []).concat([userMessage, assistantMessage]);
      return json(201, { duplicate: false, userMessage, assistantMessage, usage: fake.usage() }), true;
    }
    return false;
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
  const dbPath = fs.mkdtempSync(path.join(dataRoot, "mentor-e2e-"));
  const mongod = await MongoMemoryServer.create({ instance: { dbPath } });
  const uri = mongod.getUri() + "mentore2e";
  await mongoose.connect(uri);
  const User = req("models/User");
  const Question = req("models/Question");
  const Test = req("models/Test");
  const Season = req("models/Season");
  const season = await Season.create({ name: "UGEE 2026", year: 2026, status: "active", isDefaultActive: true });
  const hash = await bcrypt.hash("Passw0rd!long", 4);
  await User.create({ name: "asha verma", email: "asha@test.local", status: "active", isActivated: true, emailVerified: true, passwordHash: hash });
  const qs = await Question.insertMany([
    ...Array.from({ length: 4 }, (_, i) => ({ section: "SUPR", topic: "algebra", difficulty: "medium", prompt: `SUPR algebra ${i + 1}`, options: ["a", "b", "c", "d"], correctOption: 0, marks: 4, negativeMarks: -1 })),
    ...Array.from({ length: 3 }, (_, i) => ({ section: "REAP", topic: "logic", difficulty: "medium", prompt: `REAP logic ${i + 1}`, options: ["a", "b", "c", "d"], correctOption: 1, marks: 4, negativeMarks: -1 })),
  ]);
  const mock = await Test.create({ title: "UGEE 2026 Mock Test 1", isFree: true, status: "live", seasonId: season._id, sectionDurations: { SUPR: 60, REAP: 120 }, durationMinutes: 180, questionIds: qs.map((q) => q._id) });
  await mongoose.disconnect();

  // No GEMINI_API_KEY: the real server reports the mentor as not set up.
  const server = spawn(process.execPath, ["server.js"], { cwd: BACKEND, env: serverEnv({ MONGODB_URI: uri, PORT: String(PORT) }) });
  let serverLog = "";
  server.stdout.on("data", (d) => (serverLog += d));
  server.stderr.on("data", (d) => (serverLog += d));
  for (let i = 0; i < 40; i += 1) { try { if ((await fetch(`${BASE}/ready`)).status === 200) break; } catch (_e) { /* not up yet */ } await sleep(250); }

  const browser = await puppeteer.launch({ executablePath: CHROME_PATH, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  const failures = [];
  const pageErrors = [];
  const check = (cond, msg) => { (cond ? log("PASS", msg) : (log("FAIL", msg), failures.push(msg))); };
  const panelState = (page) => page.evaluate(() => {
    const panel = document.getElementById("mentor-panel");
    const toggle = document.querySelector(".js-mentor-toggle");
    if (!panel) return { exists: false, toggleExpanded: toggle && toggle.getAttribute("aria-expanded") };
    const r = panel.getBoundingClientRect();
    const composer = panel.querySelector("[data-mentor-composer]");
    return {
      exists: true,
      open: panel.getAttribute("data-state") === "open" && !panel.hidden,
      hidden: panel.hidden,
      modal: panel.getAttribute("aria-modal"),
      sheet: panel.classList.contains("is-sheet"),
      text: panel.innerText,
      composerHidden: !composer || composer.hidden,
      usage: (panel.querySelector("[data-mentor-usage]") || {}).textContent || "",
      rect: { top: r.top, height: r.height, width: r.width, right: window.innerWidth - r.right },
      toggleExpanded: toggle && toggle.getAttribute("aria-expanded"),
      focusInPanel: panel.contains(document.activeElement),
    };
  });
  const waitText = (page, re, timeout = 8000) => page.waitForFunction((source) => {
    const panel = document.getElementById("mentor-panel");
    return panel && new RegExp(source).test(panel.innerText);
  }, { timeout }, re.source).then(() => true).catch(() => false);
  try {
    const page = await newHermeticPage(browser);
    await page.setViewport({ width: 1366, height: 900 });
    page.on("pageerror", (e) => pageErrors.push(e.stack || e.message));
    page.on("dialog", async (d) => { log("dialog:", d.message().split("\n")[0]); await d.accept(); });
    await page.goto(`${BASE}/#/login`, { waitUntil: "networkidle2" });
    await page.waitForSelector("#login-email");
    await page.type("#login-email", "asha@test.local");
    await page.type("#login-password", "Passw0rd!long");
    await page.click("#login-submit-btn");
    await page.waitForFunction(() => /dashboard/.test(location.hash), { timeout: 15000 });
    await page.waitForSelector(".js-mentor-toggle", { timeout: 15000 });

    // ---- One floating button, now the mentor ----
    const button = await page.evaluate(() => {
      const all = document.querySelectorAll(".support-chat-button");
      const b = all[0];
      return { count: all.length, tag: b.tagName, text: b.innerText.replace(/\s+/g, " ").trim(), label: b.getAttribute("aria-label"), expanded: b.getAttribute("aria-expanded"), fixed: getComputedStyle(b).position, waFloating: document.querySelectorAll("a.support-chat-button, a[href*='wa.me'][class*='float']").length };
    });
    check(button.count === 1 && button.tag === "BUTTON" && button.waFloating === 0, `exactly one floating button, and it's a button (${button.count}, ${button.tag})`);
    check(/ACEIIIT Mentor/.test(button.text) && /Ask about your performance/.test(button.text), `it reads "ACEIIIT Mentor / Ask about your performance" (${button.text})`);
    check(/ACEIIIT Mentor/.test(button.label || "") && button.expanded === "false" && button.fixed === "fixed", "it has an accessible name with the visible text and aria-expanded=false");

    // ---- Real server, no Gemini key: not set up, nothing to send ----
    await page.click(".js-mentor-toggle");
    const morph = await page.evaluate(() => {
      const panel = document.getElementById("mentor-panel");
      const anims = panel.getAnimations().map((a) => a.effect && a.effect.getKeyframes()).filter(Boolean);
      const clip = anims.find((k) => k[0] && k[0].clipPath);
      return { clipFrom: clip ? clip[0].clipPath : "", skin: !!panel.querySelector(".mentor-skin"), hidden: document.querySelector(".js-mentor-toggle").classList.contains("is-morphed") };
    });
    check(/^inset\(/.test(morph.clipFrom) && /round/.test(morph.clipFrom) && morph.skin && morph.hidden, `the button morphs into the panel (clip from the button's shape: ${morph.clipFrom})`);
    await waitText(page, /isn't set up yet/);
    let st = await panelState(page);
    check(st.open && st.modal === "false" && !st.sheet && st.toggleExpanded === "true", "desktop: the panel opens as a non-modal panel and the button reports expanded");
    check(/isn't set up yet/.test(st.text) && st.composerHidden, "no API key: the panel says the mentor isn't set up and shows no composer");
    check(await page.$eval("#mentor-panel", (p) => !!p.querySelector("a[href^='https://wa.me/']")), "WhatsApp support is still reachable inside the panel");
    check(st.rect.width <= 400 && st.rect.right >= 16 && st.rect.top > 0, `desktop panel floats bottom-right (${Math.round(st.rect.width)}px wide)`);
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => { const p = document.getElementById("mentor-panel"); return p && p.hidden; }, { timeout: 3000 }).catch(() => null);
    st = await panelState(page);
    const toggleFocused = await page.evaluate(() => document.activeElement && document.activeElement.classList.contains("js-mentor-toggle"));
    check(!st.open && st.hidden && st.toggleExpanded === "false" && toggleFocused, "Escape closes it and focus returns to the button");
    check(!(await page.$eval(".js-mentor-toggle", (b) => b.classList.contains("is-morphed"))), "the panel shrinks back into the button, which is shown again");

    // ---- Fake mentor backend from here on ----
    const fake = fakeMentor();
    page.interceptHook = fake.hook;
    await page.click(".js-mentor-toggle");
    await waitText(page, /what should we look at/);
    st = await panelState(page);
    const suggestions = await page.$$eval(".mentor-suggestion", (els) => els.map((e) => e.textContent));
    check(suggestions.length === 6 && suggestions[0] === "Analyse my latest mock test." && suggestions.indexOf("Create a personalised revision plan.") !== -1, `six suggested prompts (${suggestions.length})`);
    check(/Hi Asha/.test(st.text) && st.usage === "10 of 10 free replies remaining this month." && /not words|however long/.test(st.text), `greeting, usage line and "replies, not tokens" note (${st.usage})`);
    check(st.focusInPanel && (await page.evaluate(() => document.activeElement.id)) === "mentor-input", "desktop: focus moves to the message box");
    await page.keyboard.press("Enter");
    const shook = await page.$eval("[data-mentor-composer]", (f) => f.getAnimations().length > 0);
    check(shook && fake.sends.length === 0, "an empty send shakes the message box and sends nothing");

    await sleep(900);
    const introOrb = await page.evaluate(() => {
      const c = document.querySelector(".mentor-intro-orb .mentor-orb canvas");
      if (!c) return null;
      const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
      let ink = 0;
      for (let i = 3; i < d.length; i += 4) ink += d[i];
      return { ink };
    });
    check(introOrb && introOrb.ink > 0, "an empty chat greets with the dotted orb (drawn on its canvas)");
    await page.screenshot({ path: path.join(SHOTS, "intro-1366.png") });

    await page.click(".mentor-suggestion");
    await sleep(150);
    const thinkingOrb = await page.evaluate(() => {
      const li = document.querySelector(".mentor-msg.is-thinking");
      return li ? { orb: !!li.querySelector(".mentor-orb canvas"), label: li.innerText.trim(), intro: !!document.querySelector(".mentor-intro") } : null;
    });
    check(thinkingOrb && thinkingOrb.orb && !thinkingOrb.intro, "sending moves the orb into the conversation, where the reply will appear");
    const staged = await waitText(page, /Reading your results/, 3000);
    check(staged, `the orb's stage label fits the question ("Reading your results" for a mock analysis; saw "${thinkingOrb && thinkingOrb.label}")`);
    await page.screenshot({ path: path.join(SHOTS, "thinking-1366.png") });
    const stagesSeen = await page.waitForFunction(() => /Checking accuracy and time|Looking for patterns|Done/.test((document.querySelector(".mentor-msg.is-thinking") || {}).innerText || ""), { timeout: 3000 }).then(() => true).catch(() => false);
    check(stagesSeen, "it works through further stages, then says Done");
    check(await page.$eval("[data-mentor-send]", (b) => b.disabled), "Send is disabled while a reply is being written");
    await waitText(page, /main lever/);
    const reply = await page.evaluate(() => {
      const bubble = Array.from(document.querySelectorAll(".mentor-msg.is-assistant .mentor-bubble")).pop();
      return { html: bubble.innerHTML.slice(0, 300), strong: !!bubble.querySelector("strong"), ul: bubble.querySelectorAll(":scope > ul > li").length, ol: bubble.querySelectorAll(":scope > ol > li").length, scripts: bubble.querySelectorAll("script, img").length, xss: window.__mentorXss || 0, raw: /<script>/.test(bubble.textContent) };
    });
    check(reply.strong && reply.ul === 2 && reply.ol === 2, `the reply renders bold text and lists (${JSON.stringify(reply)})`);
    check(reply.scripts === 0 && reply.xss === 0 && reply.raw, "HTML in a reply is shown as text, never run");
    await sleep(800);
    check(!(await page.$(".mentor-msg.is-thinking")) && !(await page.$(".mentor-orb")) && (await page.$$eval(".mentor-msg.is-assistant .mentor-bubble > *", (els) => els.every((e) => getComputedStyle(e).opacity === "1"))), "the orb hands over to the reply, which ends fully shown");
    st = await panelState(page);
    check(st.usage === "9 of 10 free replies remaining this month." && fake.creates.length === 1 && fake.creates[0].attemptId === undefined, `usage updates after the reply; the first send created the conversation (${st.usage})`);

    // A failed reply: not counted, retried with the same message id.
    fake.failNext = "ACEIIIT Mentor couldn't answer this time. It wasn't counted; please try again.";
    await page.type("#mentor-input", "Why am I losing marks?");
    await page.keyboard.press("Enter");
    const failedShown = await page.waitForSelector("[data-mentor-retry]", { timeout: 8000 }).then(() => true).catch(() => false);
    st = await panelState(page);
    check(failedShown && /Try again/.test(st.text) && st.usage === "9 of 10 free replies remaining this month.", "a failed reply says it wasn't counted and offers Try again");
    await page.click("[data-mentor-retry]");
    await page.waitForFunction(() => document.querySelectorAll(".mentor-msg.is-assistant:not(.is-thinking)").length === 2, { timeout: 8000 }).catch(() => null);
    const lastTwo = fake.sends.slice(-2);
    check(lastTwo.length === 2 && lastTwo[0].clientMessageId === lastTwo[1].clientMessageId && lastTwo[0].content === "Why am I losing marks?", "Try again resends the same message id (no double charge)");
    check((await page.$$(".mentor-msg.is-user")).length === 2 && !(await page.$(".mentor-msg.is-failed")), "the retried message appears once, with its reply");

    // Minimise keeps the conversation.
    await page.click('[data-mentor-action="close"]');
    await sleep(400);
    await page.click(".js-mentor-toggle");
    await sleep(300);
    check((await page.$$(".mentor-msg.is-assistant:not(.is-thinking)")).length === 2, "minimise and reopen: the conversation is still there");

    // The last free reply, then the upgrade panel.
    fake.remaining = 1;
    await page.type("#mentor-input", "Identify my weakest topics.");
    await page.keyboard.press("Enter");
    await waitText(page, /Ready to take your preparation further\?/);
    st = await panelState(page);
    const upgrade = await page.evaluate(() => {
      const card = document.querySelector(".mentor-upgrade");
      const cta = card && card.querySelector(".mentor-upgrade-cta");
      return card ? { text: card.innerText, href: cta && cta.href, target: cta && cta.target, later: !!card.querySelector(".mentor-upgrade-later") } : null;
    });
    check((await page.$$(".mentor-msg.is-assistant:not(.is-thinking)")).length === 3, "the last permitted reply is delivered");
    check(upgrade && upgrade.text.indexOf(UPGRADE_MESSAGE) !== -1 && /Explore the Preparation Programme/.test(upgrade.text) && upgrade.later, "the upgrade panel shows the exact message, the CTA and Maybe Later");
    check(upgrade && upgrade.href === CTA && upgrade.target === "_blank", "the CTA opens the programme page in a new tab");
    check(upgrade && /reset on 1 November 2026/.test(upgrade.text) && st.composerHidden, "it shows the reset date and hides the composer");
    await page.screenshot({ path: path.join(SHOTS, "upgrade-1366.png") });
    await page.click(".mentor-upgrade-later");
    st = await panelState(page);
    check(!/Ready to take your preparation/.test(st.text) && /used all 10 free replies this month/.test(st.text) && st.composerHidden, "Maybe Later folds it into one line; sending stays off");

    // History: open another conversation, delete one.
    fake.remaining = 5;
    const older = { id: hex(), title: "Older chat about timing", attempt: null, messageCount: 2, lastMessageAt: "2026-10-01T10:00:00.000Z", createdAt: "2026-10-01T10:00:00.000Z" };
    fake.conversations.push(older);
    fake.messages[older.id] = [
      { id: hex(), role: "user", content: "How should I pace REAP?", status: "complete", clientMessageId: "m-older-0001" },
      { id: hex(), role: "assistant", content: "Spend about **2 minutes** per question.", status: "complete" },
    ];
    await page.click('[data-mentor-action="history"]');
    await waitText(page, /Older chat about timing/);
    const items = await page.$$eval(".mentor-history-item", (els) => els.map((e) => e.innerText));
    check(items.length === 2 && /Analyse my latest mock test/.test(items[0]), `history lists conversations, newest first (${items.length})`);
    await page.click(`[data-mentor-open="${older.id}"]`);
    await waitText(page, /2 minutes/);
    check(/How should I pace REAP\?/.test((await panelState(page)).text), "opening a past conversation shows its messages");
    await page.click('[data-mentor-action="history"]');
    await waitText(page, /Older chat about timing/);
    await page.click(`[data-mentor-delete="${older.id}"]`);
    await page.waitForFunction(() => document.querySelectorAll(".mentor-history-item").length === 1, { timeout: 5000 }).catch(() => null);
    check((await page.$$(".mentor-history-item")).length === 1 && !fake.conversations.some((c) => c.id === older.id), "deleting asks first, then removes the conversation");
    await page.click('[data-mentor-action="close"]');
    await sleep(400);

    // ---- Opened from a results page: linked to that attempt ----
    const attemptId = await page.evaluate(async (testId) => {
      const csrf = decodeURIComponent(document.cookie.match(/aceiiit_csrf=([^;]+)/)[1]);
      const h = { "Content-Type": "application/json", "X-CSRF-Token": csrf };
      const s = await (await fetch("/api/attempt/start", { method: "POST", headers: h, body: JSON.stringify({ testId }) })).json();
      const eh = { ...h, "X-Exam-Token": s.examToken };
      const paper = await (await fetch(`/api/attempt/session/${s.session.id}/paper`, { headers: eh })).json();
      const supr = paper.questions.filter((q) => q.section === "SUPR");
      await fetch(`/api/attempt/session/${s.session.id}/answers`, { method: "PUT", headers: eh, body: JSON.stringify({ seq: 1, answers: Object.fromEntries(supr.map((q) => [q.id, 0])) }) });
      const out = await (await fetch("/api/attempt", { method: "POST", headers: { ...eh, "Idempotency-Key": "mentor-e2e-1" }, body: JSON.stringify({ sessionId: s.session.id }) })).json();
      return out.attempt.id;
    }, String(mock._id));
    await page.goto(`${BASE}/#/results/${attemptId}`, { waitUntil: "networkidle2" });
    await page.waitForSelector(".rs-kpis", { timeout: 20000 }).catch(() => null);
    await page.waitForSelector(".js-mentor-toggle", { timeout: 10000 });
    await page.click(".js-mentor-toggle");
    await waitText(page, /About/i);
    st = await panelState(page);
    check(/About\s+(UGEE 2026 Mock Test 1|the result on screen)/i.test(st.text) && /what should we look at/.test(st.text), "opened from results: a new conversation about that attempt");
    await page.click(".mentor-suggestion");
    await waitText(page, /main lever/);
    check(fake.creates.length >= 2 && fake.creates[fake.creates.length - 1].attemptId === attemptId, "the conversation is created with the attempt id");
    check(/About\s+UGEE 2026 Mock Test 1/i.test((await panelState(page)).text), "the chip names the test");
    await page.click('[data-mentor-action="close"]');
    await sleep(400);

    // ---- Exam screens hide it ----
    await page.goto(`${BASE}/#/instructions/${mock._id}`, { waitUntil: "networkidle2" });
    await sleep(800);
    check(!(await page.$(".js-mentor-toggle")), "no mentor button on the exam instructions screen");
    await page.goto(`${BASE}/#/dashboard`, { waitUntil: "networkidle2" });
    await page.waitForSelector(".js-mentor-toggle", { timeout: 10000 });

    // ---- Dark mode ----
    await page.evaluate(() => document.body.setAttribute("data-theme", "dark"));
    await page.click(".js-mentor-toggle");
    await sleep(400);
    const dark = await page.$eval("#mentor-panel", (p) => getComputedStyle(p).backgroundColor);
    const lum = (dark.match(/\d+/g) || [255, 255, 255]).slice(0, 3).map(Number).reduce((a, b) => a + b, 0) / 3;
    check(lum < 60, `dark mode: the panel uses the dark surface (${dark})`);
    await page.screenshot({ path: path.join(SHOTS, "panel-dark-1366.png") });
    await page.click('[data-mentor-action="close"]');
    await sleep(400);
    await page.evaluate(() => document.body.setAttribute("data-theme", "light"));

    // ---- Reduced motion: no movement ----
    await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
    await page.click(".js-mentor-toggle");
    await sleep(50);
    const transform = await page.$eval("#mentor-panel", (p) => getComputedStyle(p).transform);
    check(transform === "none", `reduced motion: the panel fades without moving (${transform})`);
    await page.click('[data-mentor-action="close"]');
    await sleep(400);
    await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "no-preference" }]);

    // ---- Phone: modal sheet, Back closes ----
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
    await page.reload({ waitUntil: "networkidle2" });
    await page.waitForSelector(".js-mentor-toggle", { timeout: 15000 });
    const hashBefore = await page.evaluate(() => location.hash);
    await page.tap(".js-mentor-toggle");
    await sleep(500);
    st = await panelState(page);
    const phone = await page.evaluate(() => ({
      appInert: document.getElementById("app").hasAttribute("inert"),
      overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
      locked: document.body.classList.contains("is-scroll-locked"),
    }));
    check(st.open && st.sheet && st.modal === "true" && st.rect.height >= 844 * 0.9, `phone: a near-full-screen modal sheet (${Math.round(st.rect.height)}px)`);
    check(phone.appInert && phone.locked && !phone.overflow, "phone: the page behind is inert and doesn't scroll; no sideways overflow");
    check(st.focusInPanel, "phone: focus moves into the sheet");
    await page.screenshot({ path: path.join(SHOTS, "sheet-390.png") });
    await page.evaluate(() => history.back());
    await sleep(600);
    st = await panelState(page);
    const after = await page.evaluate(() => ({ hash: location.hash, appInert: document.getElementById("app").hasAttribute("inert"), locked: document.body.classList.contains("is-scroll-locked") }));
    check(!st.open && after.hash === hashBefore && !after.appInert && !after.locked, "phone: Back closes the sheet and stays on the page");

    // ---- Sign out: nothing of the conversation stays in the page ----
    await page.setViewport({ width: 1366, height: 900 });
    await page.reload({ waitUntil: "networkidle2" });
    await page.waitForSelector(".js-mentor-toggle", { timeout: 15000 });
    await page.click(".js-mentor-toggle");
    await sleep(400);
    await page.click('[data-mentor-action="close"]');
    await sleep(400);
    await page.click("#logout-button");
    await page.waitForSelector("#logout-confirm-btn", { timeout: 5000 });
    await page.click("#logout-confirm-btn");
    await page.waitForFunction(() => /login/.test(location.hash), { timeout: 15000 });
    await sleep(300);
    check(!(await page.$(".mentor-root")) && !(await page.$(".js-mentor-toggle")), "signing out removes the mentor panel and button");

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
