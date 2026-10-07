// Mobile interaction flows at 390×844 with touch emulation: real taps, keys and lifecycle
// events against a throwaway server + in-memory MongoDB. Usage:
//   node tests/e2e/mobile-flows.e2e.js [flow,flow,...]     (default: all flows)
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const puppeteer = require("puppeteer-core");
const { PredefinedNetworkConditions } = require("puppeteer-core");
const { BACKEND, CHROME_PATH, SHOTS_DIR, serverEnv, newHermeticPage } = require("./helpers");

const ONLY = process.argv[2] ? process.argv[2].split(",") : null;
const PORT = 4983;
const BASE = `http://127.0.0.1:${PORT}`;
const PHONE = { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
const req = (m) => require(path.join(BACKEND, m));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const failures = [];
// SHOTS=1 saves screenshots of key states for manual visual QA.
async function shot(page, name, fullPage = false) {
  if (!process.env.SHOTS) return;
  const dir = path.join(SHOTS_DIR, "mobile");
  fs.mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, `${name}.png`), fullPage });
}
const log = (...a) => console.log("[mobile]", ...a);
function check(cond, msg, extra) {
  if (cond) log("PASS", msg);
  else {
    log("FAIL", msg, extra !== undefined ? JSON.stringify(extra) : "");
    failures.push(msg);
  }
}

async function login(page, email) {
  await page.goto(`${BASE}/#/login`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#login-email", { timeout: 20000 });
  await page.type("#login-email", email);
  await page.type("#login-password", "Passw0rd!long");
  await page.tap("#login-submit-btn");
  await page.waitForFunction(() => location.hash.length > 2 && !/login/.test(location.hash), { timeout: 20000 });
  await sleep(600);
}

const drawerState = (page) =>
  page.evaluate(() => {
    const drawer = document.getElementById("mobile-nav-drawer");
    const toggle = document.querySelector(".dashboard-header .mobile-drawer-toggle");
    const header = document.querySelector(".dashboard-header");
    return {
      open: !!drawer && drawer.classList.contains("is-open"),
      visibility: drawer ? getComputedStyle(drawer).visibility : null,
      drawerInert: !!drawer && drawer.hasAttribute("inert"),
      expanded: toggle ? toggle.getAttribute("aria-expanded") : null,
      focusInDrawer: !!drawer && drawer.contains(document.activeElement),
      focusOnToggle: document.activeElement === toggle,
      scrollLocked: document.body.classList.contains("is-scroll-locked"),
      headerInert: !!header && header.hasAttribute("inert"),
      backdrops: document.querySelectorAll(".mobile-drawer-backdrop").length,
      hash: location.hash,
      scrollY: Math.round(window.scrollY),
    };
  });

// ---------------------------------------------------------------------------------------
async function flowDrawer(browser) {
  const page = await newHermeticPage(browser);
  await page.emulate({ viewport: PHONE, userAgent: (await browser.userAgent()).replace("Headless", "") + " Mobile" });
  await login(page, "student@test.local");
  await page.goto(`${BASE}/#/dashboard`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".dashboard-header .mobile-drawer-toggle", { visible: true, timeout: 15000 });

  const layout = await page.evaluate(() => ({
    navLinksVisible: getComputedStyle(document.querySelector(".primary-nav-links")).display !== "none",
    headerAccountHidden: [...document.querySelectorAll(".dashboard-header .header-account-control")].every((el) => getComputedStyle(el).display === "none"),
    footerVisible: getComputedStyle(document.querySelector(".mobile-drawer-footer")).display !== "none",
  }));
  check(!layout.navLinksVisible, "phone: desktop nav links are hidden (drawer is the nav)");
  await shot(page, "dashboard-header-390");
  check(layout.headerAccountHidden, "phone: header shows only logo + menu (account controls moved to drawer)");

  let st = await drawerState(page);
  check(!st.open && st.visibility === "hidden" && st.drawerInert && st.expanded === "false", "closed drawer is hidden, inert and aria-expanded=false", st);

  // Open by tap.
  await page.tap(".dashboard-header .mobile-drawer-toggle");
  await sleep(350);
  st = await drawerState(page);
  check(st.open && st.visibility === "visible" && !st.drawerInert && st.expanded === "true", "tap ☰ opens the drawer (visible, not inert, aria-expanded=true)", st);
  check(st.focusInDrawer, "focus moves into the drawer");
  await shot(page, "drawer-open-390");
  check(st.scrollLocked && st.headerInert && st.backdrops === 1, "background locked: scroll lock, header inert, one backdrop", st);
  check(layout.footerVisible || (await page.evaluate(() => getComputedStyle(document.querySelector(".mobile-drawer-footer")).display !== "none")), "drawer footer (name, theme, logout) is visible on phones");

  // Focus trap: Tab 12 times, focus never leaves the drawer.
  let escaped = false;
  for (let i = 0; i < 12; i += 1) {
    await page.keyboard.press("Tab");
    if (!(await page.evaluate(() => document.getElementById("mobile-nav-drawer").contains(document.activeElement)))) escaped = true;
  }
  check(!escaped, "Tab keeps focus trapped inside the open drawer");

  // ESC closes and restores focus.
  await page.keyboard.press("Escape");
  await sleep(350);
  st = await drawerState(page);
  check(!st.open && st.visibility === "hidden" && st.expanded === "false", "ESC closes the drawer", st);
  check(st.focusOnToggle, "focus returns to the ☰ button after closing");
  check(!st.scrollLocked && !st.headerInert && st.backdrops === 0, "background restored after closing (no lock, no inert, no backdrop)", st);

  // Outside tap (backdrop, left edge) closes.
  await page.tap(".dashboard-header .mobile-drawer-toggle");
  await sleep(350);
  await page.touchscreen.tap(20, 400);
  await sleep(350);
  st = await drawerState(page);
  check(!st.open && st.backdrops === 0, "tapping outside the drawer closes it", st);

  // Scroll position is preserved across open/close.
  await page.evaluate(() => window.scrollTo(0, 600));
  await sleep(200);
  const before = await page.evaluate(() => Math.round(window.scrollY));
  // The header auto-hides while scrolling down (it returns on scroll up); trigger the button directly.
  await page.evaluate(() => document.querySelector(".dashboard-header .mobile-drawer-toggle").click());
  await sleep(350);
  await page.keyboard.press("Escape");
  await sleep(350);
  st = await drawerState(page);
  check(before > 0 && Math.abs(st.scrollY - before) <= 2, `scroll position restored after closing (${before} → ${st.scrollY})`);

  // Link tap navigates and closes.
  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(600); // the auto-hiding header slides back in (300ms transition)
  await page.tap(".dashboard-header .mobile-drawer-toggle");
  await sleep(350);
  await page.tap('.mobile-drawer-link[href="#exams"]');
  await page.waitForFunction(() => /exams/.test(location.hash), { timeout: 10000 }).catch(() => null);
  await sleep(500);
  st = await drawerState(page);
  check(/exams/.test(st.hash) && !st.open && !st.scrollLocked && st.backdrops === 0, "drawer link navigates to Exams and the drawer is closed", st);
  check(await page.evaluate(() => !!document.querySelector('.mobile-drawer-link[href="#exams"][aria-current="page"]')), "current route is marked in the drawer (aria-current)");

  // Route change while open (e.g. a hash change from elsewhere) releases everything.
  await page.tap(".dashboard-header .mobile-drawer-toggle");
  await sleep(350);
  await page.evaluate(() => { location.hash = "#progress"; });
  await page.waitForFunction(() => /progress/.test(location.hash), { timeout: 10000 });
  await sleep(600);
  st = await drawerState(page);
  check(!st.open && !st.scrollLocked && st.backdrops === 0 && !st.headerInert, "hash change while open closes the drawer and releases locks", st);

  // Tablet: header keeps account controls; drawer footer hidden (no duplicate controls).
  await page.emulate({ viewport: { width: 768, height: 1024, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }, userAgent: await browser.userAgent() });
  await page.goto(`${BASE}/#/dashboard`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".dashboard-header .mobile-drawer-toggle", { visible: true, timeout: 15000 });
  await sleep(500);
  const tablet = await page.evaluate(() => ({
    headerAccountVisible: [...document.querySelectorAll(".dashboard-header .header-account-control")].some((el) => getComputedStyle(el).display !== "none"),
    footerHidden: getComputedStyle(document.querySelector(".mobile-drawer-footer")).display === "none",
  }));
  check(tablet.headerAccountVisible && tablet.footerHidden, "tablet (768): account controls stay in the header; drawer footer hidden", tablet);

  // Desktop: no drawer toggle, desktop nav visible.
  await page.emulate({ viewport: { width: 1280, height: 900 }, userAgent: await browser.userAgent() });
  await page.goto(`${BASE}/#/dashboard`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".primary-nav-links", { timeout: 15000 });
  await sleep(400);
  const desktop = await page.evaluate(() => ({
    toggleHidden: getComputedStyle(document.querySelector(".dashboard-header .mobile-drawer-toggle")).display === "none",
    navVisible: getComputedStyle(document.querySelector(".primary-nav-links")).display !== "none",
  }));
  check(desktop.toggleHidden && desktop.navVisible, "desktop (1280): desktop nav shown, no drawer toggle", desktop);
  await page.close();
}


// ---------------------------------------------------------------------------------------
async function startExam(page) {
  await page.goto(`${BASE}/#/exams`, { waitUntil: "domcontentloaded" });
  const testId = await page.evaluate(async () => {
    const res = await fetch("/api/tests", { credentials: "same-origin" });
    const body = await res.json();
    return (body.tests || []).find((t) => t.title === "Mobile Mock").id;
  });
  await page.goto(`${BASE}/#/instructions/${testId}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#ready-check", { timeout: 20000 });
  await sleep(1200);
  await page.evaluate(() => { const b = document.getElementById("ready-check"); if (!b.checked) b.click(); });
  await page.evaluate(() => document.getElementById("begin-test").click());
  await page.waitForFunction(() => location.hash.indexOf("#/test/") === 0, { timeout: 20000 });
  await page.waitForSelector(".exam-actionbar", { timeout: 20000 });
  await sleep(1200);
  await dismissFullscreenPrompt(page);
  return testId;
}

// The integrity module asks to return to full screen when it isn't active (as a real student
// would see after a reload). Tap its button like a student; it closes either way.
async function dismissFullscreenPrompt(page) {
  if (await page.$("#integrity-fullscreen-return")) {
    await page.tap("#integrity-fullscreen-return").catch(() => {});
    await page.waitForFunction(() => !document.getElementById("integrity-fullscreen-prompt"), { timeout: 5000 }).catch(() => null);
    await sleep(300);
  }
  return !(await page.$("#integrity-fullscreen-prompt"));
}

const EXAM_VIEWPORTS = [
  { name: "320", width: 320, height: 640, touch: true },
  { name: "360", width: 360, height: 740, touch: true },
  { name: "390", width: 390, height: 844, touch: true },
  { name: "430", width: 430, height: 932, touch: true },
  { name: "landscape-667x375", width: 667, height: 375, touch: true },
  { name: "landscape-812x375", width: 812, height: 375, touch: true },
  { name: "landscape-844x390", width: 844, height: 390, touch: true },
  { name: "768", width: 768, height: 1024, touch: true },
  { name: "1366x657", width: 1366, height: 657, touch: false },
  { name: "1440", width: 1440, height: 900, touch: false },
];

// Selectors for the eight core capabilities, per layout. Phone layout has its own top bar and
// a Submit in the action bar; desktop keeps the tabs and sidebar Submit.
const CAPS_PHONE = {
  Previous: "#prev-question", "Mark & Next": "#mark-next", "Save & Next": "#save-next", Clear: "#clear-response",
  Calculator: ".exam-actionbar [data-calc-toggle]", Palette: "#open-mobile-palette-top", Instructions: ".mobile-exam-topbar .js-open-instructions", Submit: "#actionbar-submit",
};
const CAPS_DESKTOP = {
  Previous: "#prev-question", "Mark & Next": "#mark-next", "Save & Next": "#save-next", Clear: "#clear-response",
  Calculator: ".exam-actionbar [data-calc-toggle]", Palette: ".exam-sidebar .palette-grid", Instructions: ".exam-topbar .js-open-instructions", Submit: "#submit-test",
};

async function measureExam(page, caps, touch) {
  return page.evaluate((caps, touch) => {
    const vw = document.documentElement.clientWidth;
    const vh = window.innerHeight;
    const visible = (el) => {
      if (!el) return false;
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return cs.display !== "none" && cs.visibility !== "hidden" && r.width > 0 && r.height > 0 && r.bottom <= vh + 1 && r.top >= -1 && r.right <= vw + 1 && r.left >= -1;
    };
    const missing = [];
    const small = [];
    Object.entries(caps).forEach(([name, sel]) => {
      const el = document.querySelector(sel);
      if (!visible(el)) missing.push(name);
      else if (touch && name !== "Palette") {
        const r = el.getBoundingClientRect();
        if (r.width < 43.5 || r.height < 43.5) small.push(`${name} ${Math.round(r.width)}×${Math.round(r.height)}`);
      }
    });
    const timer = document.getElementById(document.getElementById("timer-display-mobile") && visible(document.getElementById("timer-display-mobile")) ? "timer-display-mobile" : "timer-display");
    // Last option must be able to sit fully above the action bar (scroll the card to the end).
    const card = document.querySelector(".exam-questioncard");
    if (card) card.scrollTop = card.scrollHeight;
    const options = document.querySelectorAll(".exam-option");
    const last = options[options.length - 1];
    const bar = document.querySelector(".exam-actionbar");
    const clearance = last && bar ? Math.round(bar.getBoundingClientRect().top - last.getBoundingClientRect().bottom) : null;
    if (card) card.scrollTop = 0;
    return {
      overflowX: document.scrollingElement.scrollWidth > vw + 1,
      timerVisible: visible(timer),
      timerText: timer ? timer.textContent : "",
      missing,
      small,
      clearance,
    };
  }, caps, touch);
}

async function flowExamLayout(browser) {
  const page = await newHermeticPage(browser);
  await page.emulate({ viewport: PHONE, userAgent: (await browser.userAgent()) + " Mobile" });
  await login(page, "student@test.local");
  await startExam(page);
  for (const vp of EXAM_VIEWPORTS) {
    await page.emulate({ viewport: { width: vp.width, height: vp.height, isMobile: vp.touch, hasTouch: vp.touch, deviceScaleFactor: 2 }, userAgent: await browser.userAgent() });
    await sleep(700);
    const phoneLayout = await page.evaluate(() => getComputedStyle(document.querySelector(".mobile-exam-topbar")).display !== "none");
    const expectPhone = vp.width <= 780 || (vp.height <= 500 && vp.width > vp.height);
    check(phoneLayout === expectPhone, `${vp.name}: ${expectPhone ? "phone" : "desktop"} exam layout applied`);
    const m = await measureExam(page, phoneLayout ? CAPS_PHONE : CAPS_DESKTOP, vp.touch);
    check(!m.overflowX, `${vp.name}: no horizontal overflow`);
    check(m.timerVisible && /\d+:\d{2}/.test(m.timerText), `${vp.name}: timer visible (${m.timerText})`);
    check(m.missing.length === 0, `${vp.name}: all 8 capabilities visible in the viewport`, m.missing);
    if (vp.touch) check(m.small.length === 0, `${vp.name}: capability tap targets ≥44px`, m.small);
    check(m.clearance !== null && m.clearance >= 0, `${vp.name}: last option clears the action bar (gap ${m.clearance}px)`);
    await shot(page, `exam-${vp.name}`);
  }
  await page.close();
}

// FLOW 1: the whole exam on a phone, by touch.
async function flowExamFull(browser) {
  const page = await newHermeticPage(browser);
  page.on("dialog", (d) => d.accept());
  await page.emulate({ viewport: PHONE, userAgent: (await browser.userAgent()) + " Mobile" });
  await login(page, "student@test.local");

  // Navigate with the drawer, then into the test.
  await page.goto(`${BASE}/#/dashboard`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".dashboard-header .mobile-drawer-toggle", { visible: true, timeout: 15000 });
  await page.tap(".dashboard-header .mobile-drawer-toggle");
  await sleep(350);
  await page.tap('.mobile-drawer-link[href="#exams"]');
  await page.waitForFunction(() => /exams/.test(location.hash), { timeout: 10000 });
  check(true, "reached Exams through the drawer");
  await startExam(page);

  const answerOf = (i) => page.evaluate((i) => { const r = document.querySelectorAll('.exam-option input[type="radio"]')[i]; return !!r && r.checked; }, i);
  // Answer by tapping the option card.
  await page.tap(".exam-option:nth-of-type(2)");
  await sleep(300);
  check(await answerOf(1), "tapping an option card selects it (B)");

  // Clear.
  await page.tap("#clear-response");
  await sleep(400);
  check(!(await answerOf(1)), "Clear removes the selection");

  // Calculator: opens as a sheet that fits, closes.
  await page.tap(".exam-actionbar [data-calc-toggle]");
  await page.waitForSelector(".calculator-popout .calculator-modal", { visible: true, timeout: 5000 });
  await sleep(300);
  const calc = await page.evaluate(() => {
    const r = document.querySelector(".calculator-popout .calculator-modal").getBoundingClientRect();
    const keys = [...document.querySelectorAll(".calculator-key")].map((k) => k.getBoundingClientRect());
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, vw: innerWidth, vh: innerHeight, minKey: Math.min(...keys.map((k) => Math.min(k.width, k.height))) };
  });
  check(calc.left >= 0 && calc.right <= calc.vw && calc.top >= 0 && calc.bottom <= calc.vh, "calculator fits inside the phone viewport", calc);
  check(calc.minKey >= 43.5, `calculator keys ≥44px (${Math.round(calc.minKey)}px)`);
  await page.tap('[data-calc-key="7"]');
  await page.tap('[data-calc-key="+"]');
  await page.tap('[data-calc-key="5"]');
  await page.tap('[data-calc-key="="]');
  await sleep(200);
  check(/12/.test(await page.$eval("[data-calculator-display]", (el) => el.textContent)), "calculator computes 7+5=12 by touch");
  await shot(page, "exam-calculator-390");
  await page.tap('.calculator-popout [data-calc-action="close"]');
  await sleep(300);
  check(!(await page.$(".calculator-popout")), "calculator closes");

  // Answer then Mark & Next.
  await page.tap(".exam-option:nth-of-type(3)");
  await sleep(200);
  await page.tap("#mark-next");
  await sleep(700);
  check(await page.evaluate(() => /Q2/.test(document.querySelector(".mobile-q-indicator").textContent)), "Mark & Next moves to Q2");

  // Palette sheet: open, check, jump to Q4.
  await page.tap("#open-mobile-palette-top");
  await page.waitForSelector("#mobile-palette-sheet", { visible: true, timeout: 5000 });
  await sleep(300);
  const sheet = await page.evaluate(() => {
    const r = document.getElementById("mobile-palette-sheet").getBoundingClientRect();
    const cells = [...document.querySelectorAll("#mobile-palette-sheet .palette-button")].map((b) => b.getBoundingClientRect());
    const actions = document.querySelector(".mobile-palette-actions").getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, vh: innerHeight, minCell: Math.min(...cells.map((c) => Math.min(c.width, c.height))), actionsVisible: actions.bottom <= innerHeight + 1 && actions.top >= r.top, focusInSheet: document.getElementById("mobile-palette-sheet").contains(document.activeElement) };
  });
  check(sheet.top >= 0 && sheet.bottom <= sheet.vh + 1, "palette sheet fits the viewport", sheet);
  check(sheet.minCell >= 43.5, `palette cells ≥44px (${Math.round(sheet.minCell)}px)`);
  check(sheet.actionsVisible, "palette Close/Submit actions are visible");
  check(sheet.focusInSheet, "focus moves into the palette sheet");
  await shot(page, "exam-palette-390");
  const q4 = await page.$$eval("#mobile-palette-sheet .palette-button", (els) => els[3] && els[3].getAttribute("data-question"));
  await page.tap(`#mobile-palette-sheet .palette-button[data-question="${q4}"]`);
  await sleep(700);
  check(await page.evaluate(() => /Q4/.test(document.querySelector(".mobile-q-indicator").textContent)), "tapping palette cell 4 jumps to Q4 (no tap leaks through)");
  check(await page.evaluate(() => { const o = document.getElementById("mobile-palette-overlay"); return !o || getComputedStyle(o).display === "none"; }), "palette closes after jumping");

  // Instructions through the ⓘ button, then close.
  await page.tap(".mobile-exam-topbar .js-open-instructions");
  await page.waitForSelector(".instructions-popup-card", { visible: true, timeout: 8000 });
  await sleep(300);
  const instr = await page.evaluate(() => {
    const r = document.querySelector(".instructions-popup-card").getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, vw: innerWidth, vh: innerHeight };
  });
  check(instr.left >= 0 && instr.right <= instr.vw && instr.top >= 0 && instr.bottom <= instr.vh, "instructions dialog fits inside the viewport (scrolls internally)", instr);
  const instrClose = await page.evaluate(() => { const r = document.querySelector(".instructions-popup-card .calculator-close").getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; });
  check(instrClose, "instructions Close is on screen");
  await shot(page, "exam-instructions-390");
  await page.evaluate(() => document.querySelector(".instructions-popup-card .calculator-close").click());
  await sleep(600);
  check(!(await page.$(".instructions-popup-card")), "instructions dialog closes back to the exam");

  // Submit SUPR from the action bar → section transition dialog → confirm → REAP.
  await page.tap("#actionbar-submit");
  await page.waitForSelector('[data-transition-action="confirm"]', { visible: true, timeout: 8000 });
  await sleep(300);
  const dlg = await page.evaluate(() => {
    const b = document.querySelector('[data-transition-action="confirm"]').getBoundingClientRect();
    return { bottom: b.bottom, vh: innerHeight };
  });
  check(dlg.bottom <= dlg.vh, "section-transition dialog actions are reachable");
  await shot(page, "exam-transition-390");
  await page.tap('[data-transition-action="confirm"]');
  await page.waitForFunction(() => /REAP/.test((document.querySelector(".mobile-section-badge") || {}).textContent || ""), { timeout: 15000 });
  check(true, "section transition confirmed: REAP is active");

  // Answer in REAP, then final submit through the confirmation.
  await page.tap(".exam-option:nth-of-type(1)");
  await sleep(300);
  await page.tap("#actionbar-submit");
  await page.waitForSelector('[data-transition-action="confirm"]', { visible: true, timeout: 8000 });
  await page.tap('[data-transition-action="confirm"]');
  await page.waitForFunction(() => location.hash.indexOf("#/results/") === 0, { timeout: 25000 });
  await sleep(1500);
  check(true, "final submit reached the results page");
  const results = await page.evaluate(() => ({ overflow: document.scrollingElement.scrollWidth > document.documentElement.clientWidth + 1, score: (document.querySelector(".rs-kpi-value") || {}).textContent || "" }));
  check(!results.overflow && /\d/.test(results.score), `results render on the phone without overflow (score ${results.score.trim()})`);
  await page.close();
}

// FLOW 8: browser Back and the overlay stack.
async function flowBack(browser) {
  const page = await newHermeticPage(browser);
  let dialogAction = "accept";
  const dialogs = [];
  page.on("dialog", async (d) => { dialogs.push(d.message()); await (dialogAction === "accept" ? d.accept() : d.dismiss()); });
  await page.emulate({ viewport: PHONE, userAgent: (await browser.userAgent()) + " Mobile" });
  await login(page, "student@test.local");
  await startExam(page);
  const back = async () => { await page.evaluate(() => history.back()); await sleep(700); };
  const state = () => page.evaluate(() => ({
    hash: location.hash,
    palette: (() => { const o = document.getElementById("mobile-palette-overlay"); return !!o && getComputedStyle(o).display !== "none"; })(),
    calc: !!document.querySelector(".calculator-popout"),
    instructions: !!document.querySelector(".instructions-popup-card"),
    histLen: history.length,
  }));

  const base = await state();
  // Single overlay.
  await page.tap("#open-mobile-palette-top");
  await sleep(400);
  check((await state()).palette, "palette open");
  await back();
  let st = await state();
  check(!st.palette && /#\/test\//.test(st.hash), "Back closes the palette and stays in the exam", st);

  // Nested: calculator, then palette on top.
  await page.tap(".exam-actionbar [data-calc-toggle]");
  await sleep(500);
  await page.tap("#open-mobile-palette-top");
  await sleep(400);
  st = await state();
  check(st.calc && st.palette, "calculator + palette open (nested)");
  await back();
  st = await state();
  check(!st.palette && st.calc, "first Back closes only the palette (top of stack)", st);
  await back();
  st = await state();
  check(!st.calc && /#\/test\//.test(st.hash), "second Back closes the calculator, still in the exam", st);

  // Repeated open/close through the UI never grows history.
  const lenBefore = (await state()).histLen;
  for (let i = 0; i < 5; i += 1) {
    await page.tap("#open-mobile-palette-top");
    await sleep(300);
    await page.tap("#mobile-palette-close");
    await sleep(400);
  }
  const lenAfter = (await state()).histLen;
  check(lenAfter <= lenBefore + 1, `5 open/close cycles add no history entries (${lenBefore} → ${lenAfter})`);

  // Instructions through ⓘ, then Back.
  await page.tap(".mobile-exam-topbar .js-open-instructions");
  await page.waitForSelector(".instructions-popup-card", { visible: true, timeout: 8000 });
  await back();
  st = await state();
  check(!st.instructions && /#\/test\//.test(st.hash), "Back closes the instructions dialog", st);

  // Back from the exam itself: confirmation; Cancel keeps the exam.
  dialogAction = "dismiss";
  dialogs.length = 0;
  await back();
  await sleep(500);
  st = await state();
  check(dialogs.some((m) => /Leave the exam/.test(m)), "Back from an active exam asks for confirmation");
  check(/#\/test\//.test(st.hash), "Cancel keeps the student in the exam", st);
  const activeSessions = await page.evaluate(async () => (await (await fetch("/api/attempt/sessions/active", { credentials: "same-origin" })).json()).sessions.length);
  check(activeSessions === 1, "server session still active after cancelling");

  // Confirming leaves, and the server session is still active (resumable, not abandoned).
  dialogAction = "accept";
  await back();
  await sleep(800);
  st = await state();
  check(!/#\/test\//.test(st.hash), `confirming leaves the exam (now ${st.hash})`);
  const stillActive = await page.evaluate(async () => (await (await fetch("/api/attempt/sessions/active", { credentials: "same-origin" })).json()).sessions.length);
  check(stillActive === 1, "leaving does not abandon: the server session is still active");

  // Drawer: Back closes it; navigating from it leaves no dead Back press.
  await page.goto(`${BASE}/#/dashboard`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".dashboard-header .mobile-drawer-toggle", { visible: true, timeout: 15000 });
  await sleep(400);
  await page.tap(".dashboard-header .mobile-drawer-toggle");
  await sleep(350);
  await back();
  let open = await page.evaluate(() => document.getElementById("mobile-nav-drawer").classList.contains("is-open"));
  check(!open && /dashboard/.test(await page.evaluate(() => location.hash)), "Back closes the drawer and stays on the dashboard");
  await page.tap(".dashboard-header .mobile-drawer-toggle");
  await sleep(350);
  await page.tap('.mobile-drawer-link[href="#exams"]');
  await page.waitForFunction(() => /exams/.test(location.hash), { timeout: 10000 });
  await sleep(500);
  await back();
  check(/dashboard/.test(await page.evaluate(() => location.hash)), "Back after drawer navigation returns to the dashboard in one press");

  // Reload with an overlay open: Forward never resurrects it.
  await page.goto(`${BASE}/#/dashboard`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".dashboard-header .mobile-drawer-toggle", { visible: true, timeout: 15000 });
  await sleep(400);
  await page.tap(".dashboard-header .mobile-drawer-toggle");
  await sleep(350);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector(".dashboard-header .mobile-drawer-toggle", { visible: true, timeout: 15000 });
  await sleep(600);
  await page.evaluate(() => history.forward());
  await sleep(600);
  open = await page.evaluate(() => document.getElementById("mobile-nav-drawer").classList.contains("is-open"));
  check(!open, "after reload, Forward does not reopen a ghost overlay");
  check(base.histLen > 0, "history available");
  await page.close();
}

// ---------------------------------------------------------------------------------------
// Server truth for the running exam: resume with this tab's exam token (no local mirror).
async function serverSession(page, testId) {
  return page.evaluate(async (testId) => {
    const sid = location.hash.split("/")[2];
    const token = sessionStorage.getItem("aceiiit.exam." + sid) || "";
    const csrf = decodeURIComponent((document.cookie.match(/aceiiit_csrf=([^;]+)/) || [])[1] || "");
    const res = await fetch("/api/attempt/start", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf, "X-Exam-Token": token },
      body: JSON.stringify({ testId }),
    });
    const body = await res.json();
    return body.session || null;
  }, testId);
}

const currentQuestionId = (page) => page.evaluate(() => {
  const cur = document.querySelector(".mobile-palette-grid .palette-button.is-current, .exam-sidebar .palette-button.is-current");
  return cur ? cur.getAttribute("data-question") : null;
});

async function waitSaved(page, timeout = 20000) {
  await page.waitForFunction(() => { const el = document.getElementById("autosave-chip-mobile"); return el && el.dataset.state === "saved"; }, { timeout }).catch(() => null);
  return page.evaluate(() => (document.getElementById("autosave-chip-mobile") || {}).dataset.state);
}

async function waitState(page, wanted, timeout = 20000) {
  await page.waitForFunction((w) => { const el = document.getElementById("autosave-chip-mobile"); return el && w.includes(el.dataset.state); }, { timeout }, wanted).catch(() => null);
  return page.evaluate(() => (document.getElementById("autosave-chip-mobile") || {}).dataset.state);
}

async function freshExam(browser, email) {
  const page = await newHermeticPage(browser);
  page.on("dialog", (d) => d.accept());
  await page.emulate({ viewport: PHONE, userAgent: (await browser.userAgent()) + " Mobile" });
  await login(page, email);
  // Each flow starts clean: abandon any session left by an earlier flow.
  await page.evaluate(async () => {
    const csrf = decodeURIComponent((document.cookie.match(/aceiiit_csrf=([^;]+)/) || [])[1] || "");
    const active = await (await fetch("/api/attempt/sessions/active", { credentials: "same-origin" })).json();
    for (const s of active.sessions || []) {
      await fetch(`/api/attempt/session/${s.id}/takeover`, { method: "POST", credentials: "same-origin", headers: { "X-CSRF-Token": csrf } }).then((r) => r.json()).then((b) =>
        fetch(`/api/attempt/session/${s.id}/abandon`, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf, "X-Exam-Token": b.examToken || "" }, body: "{}" })
      ).catch(() => {});
    }
  });
  const testId = await startExam(page);
  return { page, testId };
}

// FLOW 2 + 9: state survives reload and lifecycle events; the deadline never changes;
// in-app overlays and rotation create no counted integrity events.
async function flowPersistence(browser) {
  const { page, testId } = await freshExam(browser, "student@test.local");
  const before = await serverSession(page, testId);
  check(before && before.deadlines && before.deadlines.final, "server session and deadline available");

  // Answer Q1 (C), Mark & Next → Q2; answer Q2 (A) and stay.
  await page.tap(".exam-option:nth-of-type(3)");
  await sleep(200);
  await page.tap("#mark-next");
  await sleep(700);
  await page.tap(".exam-option:nth-of-type(1)");
  await sleep(300);
  const q2 = await currentQuestionId(page);
  check((await waitSaved(page)) === "saved", "autosave reaches Saved (server acknowledged)");
  let srv = await serverSession(page, testId);
  const answered = Object.values(srv.answers || {}).filter((v) => v !== null && v !== undefined).length;
  check(answered === 2, `server holds both answers (${answered})`);
  check((srv.marked || []).length === 1, "server holds the mark-for-review");
  check(srv.currentQuestionId === q2, "server holds the current question (Q2)");

  // Overlays + rotation: no counted integrity events.
  await page.tap("#open-mobile-palette-top"); await sleep(300); await page.tap("#mobile-palette-close"); await sleep(300);
  await page.tap(".exam-actionbar [data-calc-toggle]"); await sleep(400); await page.tap('.calculator-popout [data-calc-action="close"]'); await sleep(300);
  await page.tap(".mobile-exam-topbar .js-open-instructions"); await page.waitForSelector(".instructions-popup-card", { visible: true }); await page.evaluate(() => document.querySelector(".instructions-popup-card .calculator-close").click()); await sleep(400);
  await page.emulate({ viewport: { width: 844, height: 390, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }, userAgent: await browser.userAgent() });
  await sleep(800);
  await page.emulate({ viewport: PHONE, userAgent: await browser.userAgent() });
  await sleep(800);
  srv = await serverSession(page, testId);
  check(srv.integrity && srv.integrity.violations === 0, `palette, calculator, instructions and rotation record no counted violations (${srv.integrity && srv.integrity.violations})`);
  check(srv.deadlines.final === before.deadlines.final, "deadline unchanged after rotation");

  // Reload: server state restored, deadline identical.
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector(".exam-actionbar", { timeout: 20000 });
  await sleep(1500);
  check(await dismissFullscreenPrompt(page), "after reload, the full-screen prompt can be dismissed with one tap");
  srv = await serverSession(page, testId);
  check(srv.deadlines.final === before.deadlines.final, "deadline unchanged after reload");
  check(await page.evaluate(() => { const r = document.querySelectorAll('.exam-option input[type="radio"]')[0]; return !!r && r.checked; }), "after reload the exam resumes on Q2 with its answer selected");

  // Reloading fires visibilitychange(hidden) on the unloading page; whether that tab_hidden
  // reaches the server races the unload (pre-existing integrity behaviour, unchanged here).
  // Take the baseline after the reload so the next check measures only the tab switch.
  await sleep(2500);
  const afterReload = (await serverSession(page, testId)).integrity.violations;
  console.log(`[mobile] info: counted events after the reload: ${afterReload}`);

  // Background → foreground (tab hidden): pending changes flush; deadline unchanged.
  await page.tap(".exam-option:nth-of-type(4)");
  await sleep(200);

  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await sleep(1500);
  await page.evaluate(() => {
    delete document.hidden; delete document.visibilityState;
    Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await sleep(1500);
  srv = await serverSession(page, testId);
  check(srv.answers[q2] === 3, "hiding the tab flushed the latest answer (D) to the server");
  check(srv.deadlines.final === before.deadlines.final, "deadline unchanged after background/foreground");
  // Counted events flush immediately unless a telemetry batch is already in flight, in which
  // case they go with the next 3 s interval: poll instead of reading once.
  for (let i = 0; i < 16 && srv.integrity.violations < afterReload + 1; i += 1) {
    await sleep(500);
    srv = await serverSession(page, testId);
  }
  await sleep(1000);
  srv = await serverSession(page, testId);
  const counted = (await req("models/IntegrityEvent").find({ sessionId: srv.id, counted: true }).sort({ _id: 1 }).lean()).map((e) => e.type);
  const added = counted.slice(afterReload);
  check(srv.integrity.violations === afterReload + 1 && added.join() === "tab_hidden", `leaving the tab is (correctly) one more counted event (${afterReload} → ${srv.integrity.violations}: ${added.join(", ") || "none"})`, { counted });
  await page.close();
}

// FLOW 3: network resilience and truthful save states.
async function flowNetwork(browser) {
  const { page, testId } = await freshExam(browser, "student@test.local");
  const isSave = (r) => r.method() === "PUT" && /\/answers$/.test(r.url());
  const optionChecked = async (i) => page.evaluate((i) => { const r = document.querySelectorAll('.exam-option input[type="radio"]')[i]; return !!r && r.checked; }, i);
  const q1 = await currentQuestionId(page);

  // Offline → indicator → back online → recovered.
  await page.setOfflineMode(true);
  await page.tap(".exam-option:nth-of-type(1)");
  check((await waitState(page, ["offline"], 15000)) === "offline", "offline: indicator shows Offline");
  await page.setOfflineMode(false);
  check((await waitSaved(page, 25000)) === "saved", "back online: autosave recovers to Saved");
  let srv = await serverSession(page, testId);
  check(srv.answers[q1] === 0, "the answer made offline reached the server");

  // Server error → "Save failed: retrying" → recovers.
  let fail5xx = 1;
  page.interceptHook = async (r) => {
    if (isSave(r) && fail5xx > 0) { fail5xx -= 1; await r.respond({ status: 503, contentType: "application/json", body: '{"error":"busy"}' }); return true; }
    return false;
  };
  await page.tap(".exam-option:nth-of-type(2)");
  check((await waitState(page, ["retrying"], 15000)) === "retrying", "5xx: indicator shows Save failed (retrying), not Offline");
  check((await waitSaved(page, 25000)) === "saved", "after the 5xx the retry succeeds");

  // Slow 3G: still usable; Saving… then Saved.
  page.interceptHook = null;
  await page.emulateNetworkConditions(PredefinedNetworkConditions["Slow 3G"]);
  await page.tap(".exam-option:nth-of-type(3)");
  check((await waitSaved(page, 30000)) === "saved", "Slow 3G: the save completes (Saved)");
  await page.emulateNetworkConditions(null);

  // Stale-response test (a): the save is held; the student changes the answer and marks the
  // question meanwhile; the held save then succeeds. The newer state must win.
  let held = null;
  page.interceptHook = async (r) => {
    if (isSave(r) && !held) { held = r; return true; } // hold the first save
    return false;
  };
  await page.tap(".exam-option:nth-of-type(1)");             // V1: A
  await page.waitForFunction(() => true, { timeout: 100 });
  for (let i = 0; i < 40 && !held; i += 1) await sleep(250); // wait until V1 is in flight
  check(!!held, "first save is in flight (held)");
  await page.tap(".exam-option:nth-of-type(4)");             // V2: D (during flight)
  await sleep(200);
  await page.evaluate(() => {                                  // mark it during flight, too
    const sid = location.hash.split("/")[2];
    window.AceIIIT.__store.patchAttempt(sid, (a) => { a.marked = Object.assign({}, a.marked || {}); a.marked[a.currentQuestionId] = true; });
  });
  await sleep(300);
  page.interceptHook = null;
  try { await held.continue(); } catch (_e) {}
  check((await waitSaved(page, 25000)) === "saved", "after the held save completes, the newer state is saved too");
  srv = await serverSession(page, testId);
  check(srv.answers[q1] === 3, `server has the answer changed during the in-flight save (D=3, got ${srv.answers[q1]})`);
  check((srv.marked || []).includes(q1), "server has the mark made during the in-flight save");

  // Stale-response test (b): two changes while a save is held → final = the last change.
  held = null;
  page.interceptHook = async (r) => { if (isSave(r) && !held) { held = r; return true; } return false; };
  await page.tap(".exam-option:nth-of-type(2)");             // B
  for (let i = 0; i < 40 && !held; i += 1) await sleep(250);
  await page.tap(".exam-option:nth-of-type(3)");             // C
  await sleep(150);
  await page.tap(".exam-option:nth-of-type(1)");             // A (final)
  await sleep(300);
  page.interceptHook = null;
  try { await held.continue(); } catch (_e) {}
  await waitSaved(page, 25000);
  srv = await serverSession(page, testId);
  check(srv.answers[q1] === 0, `two changes during flight: the last one wins (A=0, got ${srv.answers[q1]})`);

  // Stale-response test (c): a save is held when the page reloads; the exit flush (keepalive)
  // must carry the newest answer and supersede the held batch.
  held = null;
  page.interceptHook = async (r) => { if (isSave(r) && !held) { held = r; return true; } return false; };
  await page.tap(".exam-option:nth-of-type(2)");             // B (held)
  for (let i = 0; i < 40 && !held; i += 1) await sleep(250);
  await page.tap(".exam-option:nth-of-type(4)");             // D (newest, unsent)
  await sleep(200);
  page.interceptHook = null;
  await page.reload({ waitUntil: "domcontentloaded" });     // beforeunload → keepalive flush
  try { await held.continue(); } catch (_e) {}               // the old batch may still arrive
  await page.waitForSelector(".exam-actionbar", { timeout: 20000 });
  await sleep(2500);
  await dismissFullscreenPrompt(page);
  srv = await serverSession(page, testId);
  check(srv.answers[q1] === 3, `reload during an in-flight save keeps the newest answer (D=3, got ${srv.answers[q1]})`);
  check(await optionChecked(3) || (await currentQuestionId(page)) !== q1, "UI after reload reflects the server state");

  // Timeout: a hung save is aborted and reported as retrying, then recovers.
  let hang = 1;
  page.interceptHook = async (r) => { if (isSave(r) && hang > 0) { hang -= 1; return true; } return false; }; // never answered
  await page.tap(".exam-option:nth-of-type(1)");
  const timeoutState = await waitState(page, ["retrying"], 25000);
  check(timeoutState === "retrying", "a hung save times out (15s) and shows Save failed (retrying)");
  page.interceptHook = null;
  check((await waitSaved(page, 30000)) === "saved", "after the timeout the retry succeeds");

  // 401: the session ended → "Signed out", not Offline.
  page.interceptHook = async (r) => {
    if (isSave(r)) { await r.respond({ status: 401, contentType: "application/json", body: '{"error":"Unauthorized"}' }); return true; }
    return false;
  };
  await page.tap(".exam-option:nth-of-type(2)");
  check((await waitState(page, ["signed-out"], 15000)) === "signed-out", "401: indicator shows Signed out");
  page.interceptHook = null;
  await page.close();
}

// FLOW 7: repeated Submit taps finalize exactly once.
async function flowSubmit(browser, { uri }) {
  const { page } = await freshExam(browser, "student@test.local");
  await page.tap(".exam-option:nth-of-type(1)");
  await sleep(300);
  // SUPR → REAP first (one confirmation).
  await page.tap("#actionbar-submit");
  await page.waitForSelector('[data-transition-action="confirm"]', { visible: true, timeout: 8000 });
  await page.tap('[data-transition-action="confirm"]');
  await page.waitForFunction(() => /REAP/.test((document.querySelector(".mobile-section-badge") || {}).textContent || ""), { timeout: 15000 });
  await sleep(500);
  // Final submit: open the confirmation, then hammer confirm and the Submit buttons.
  await page.tap("#actionbar-submit");
  await page.waitForSelector('[data-transition-action="confirm"]', { visible: true, timeout: 8000 });
  await page.evaluate(() => {
    for (let i = 0; i < 6; i += 1) {
      const c = document.querySelector('[data-transition-action="confirm"]');
      if (c) c.click();
      const s = document.getElementById("actionbar-submit");
      if (s) s.click();
    }
  });
  const reached = await page.waitForFunction(() => location.hash.indexOf("#/results/") === 0, { timeout: 25000 }).then(() => true).catch(() => false);
  if (!reached) {
    console.log("submit stalled:", JSON.stringify(await page.evaluate(() => ({
      hash: location.hash,
      transition: !!document.querySelector('[data-transition-action="confirm"]'),
      loader: !!document.querySelector("[data-sync-overlay='true']"),
      badge: (document.querySelector(".mobile-section-badge") || {}).textContent,
      prompt: !!document.getElementById("integrity-fullscreen-prompt"),
      body: document.body.innerText.slice(0, 160),
    }))));
  }
  check(reached, "rapid taps still reach the results page");
  await sleep(1500);
  const mongoose = req("node_modules/mongoose");
  const conn = await mongoose.createConnection(uri).asPromise();
  const user = await conn.collection("users").findOne({ email: "student@test.local" });
  const finalizedSessions = await conn.collection("attemptsessions").countDocuments({ userId: user._id, status: { $ne: "active" } });
  const attemptsForLatestSession = await conn.collection("attempts").aggregate([
    { $match: { userId: user._id, sessionId: { $ne: null } } },
    { $group: { _id: "$sessionId", n: { $sum: 1 } } },
    { $match: { n: { $gt: 1 } } },
  ]).toArray();
  const interpretationsPerAttempt = await conn.collection("attemptinterpretations").aggregate([
    { $group: { _id: "$attemptId", n: { $sum: 1 } } },
    { $match: { n: { $gt: 1 } } },
  ]).toArray();
  await conn.close();
  check(finalizedSessions >= 1, "the session was finalized");
  check(attemptsForLatestSession.length === 0, "no session produced more than one Attempt (repeated taps finalize once)");
  check(interpretationsPerAttempt.length === 0, "no Attempt has more than one interpretation job (one finalization side effect)");
  await page.close();
}

// iPhone Safari has no element Fullscreen API: the exam must never be blocked by a prompt.
async function flowNoFullscreenApi(browser) {
  const page = await newHermeticPage(browser);
  page.on("dialog", (d) => d.accept());
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(Document.prototype, "fullscreenEnabled", { configurable: true, get: () => false });
    Element.prototype.requestFullscreen = undefined;
    Element.prototype.webkitRequestFullscreen = undefined;
  });
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  await page.emulate({ viewport: PHONE, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1" });
  try {
    await login(page, "student@test.local");
  } catch (err) {
    console.log("page errors:", pageErrors.slice(0, 3), "body:", (await page.evaluate(() => document.body.innerText)).slice(0, 200));
    throw err;
  }
  await page.evaluate(async () => {
    const csrf = decodeURIComponent((document.cookie.match(/aceiiit_csrf=([^;]+)/) || [])[1] || "");
    const active = await (await fetch("/api/attempt/sessions/active", { credentials: "same-origin" })).json();
    for (const s of active.sessions || []) {
      const t = await (await fetch(`/api/attempt/session/${s.id}/takeover`, { method: "POST", credentials: "same-origin", headers: { "X-CSRF-Token": csrf } })).json();
      await fetch(`/api/attempt/session/${s.id}/abandon`, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf, "X-Exam-Token": t.examToken || "" }, body: "{}" });
    }
  });
  await page.goto(`${BASE}/#/exams`, { waitUntil: "domcontentloaded" });
  const testId = await page.evaluate(async () => ((await (await fetch("/api/tests", { credentials: "same-origin" })).json()).tests || []).find((t) => t.title === "Mobile Mock").id);
  await page.goto(`${BASE}/#/instructions/${testId}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#ready-check", { timeout: 20000 });
  await sleep(1200);
  await page.evaluate(() => { const b = document.getElementById("ready-check"); if (!b.checked) b.click(); });
  await page.tap("#begin-test");
  await page.waitForFunction(() => location.hash.indexOf("#/test/") === 0, { timeout: 20000 });
  await sleep(2000);
  check(!(await page.$("#integrity-fullscreen-prompt")), "no Fullscreen API: no full-screen prompt is shown");
  await page.tap(".exam-option:nth-of-type(2)");
  await sleep(300);
  check(await page.evaluate(() => document.querySelectorAll('.exam-option input[type="radio"]')[1].checked), "no Fullscreen API: answers can be selected (nothing blocks the exam)");
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector(".exam-actionbar", { timeout: 20000 });
  await sleep(1500);
  check(!(await page.$("#integrity-fullscreen-prompt")), "no Fullscreen API: still no prompt after reload");
  await page.close();
}

// FLOW 5: Admin Studio on a phone: bank, question edit + LaTeX preview + save, tables as cards.
// FLOW: auth screens. Their inactive forms start hidden with a !important utility class;
// every mode must actually become visible (Create account, Forgot password, direct links),
// and the feedback banner must show.
async function flowAuthForms(browser) {
  const page = await newHermeticPage(browser);
  await page.emulate({ viewport: PHONE, userAgent: (await browser.userAgent()) + " Mobile" });
  const visible = (sel) => page.evaluate((sel) => { const el = document.querySelector(sel); if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden"; }, sel);

  await page.goto(`${BASE}/#/login`, { waitUntil: "networkidle2" });
  await page.waitForSelector("#login-email");
  await page.type("#login-email", "student@test.local");
  await page.type("#login-password", "wrong-password-123");
  await page.tap("#login-submit-btn");
  await page.waitForFunction(() => { const f = document.getElementById("auth-feedback"); return f && f.getBoundingClientRect().height > 0 && f.textContent.trim(); }, { timeout: 15000 }).catch(() => {});
  check(await visible("#auth-feedback"), "a failed login shows the feedback banner");

  await page.evaluate(() => document.querySelector('[data-auth-switch="forgot-password"]').click());
  await sleep(300);
  check(await visible("#forgot-password-form") && await visible("#forgot-email") && await visible("#forgot-send-btn") && !(await visible("#login-form")), "Forgot password? shows the reset form (email + Send Reset Link)");
  check(await visible("#auth-header-forgot"), "the reset form has its heading");

  await page.evaluate(() => document.querySelector('#auth-toggle-prompt [data-auth-switch="login"]').click());
  await sleep(300);
  check(await visible("#login-form") && !(await visible("#forgot-password-form")), "Sign in returns to the login form");

  await page.evaluate(() => document.querySelector('#auth-toggle-prompt [data-auth-switch="activate"]').click());
  await sleep(300);
  check(await visible("#activate-request-form") && await visible("#activate-email") && await visible("#activate-send-btn"), "Create account shows the account form");

  await page.goto(`${BASE}/#/forgot-password`, { waitUntil: "networkidle2" });
  await page.reload({ waitUntil: "networkidle2" });
  await sleep(500);
  check(await visible("#forgot-password-form") && await visible("#forgot-email"), "a direct #/forgot-password link shows the reset form");
  await shot(page, "auth-forgot-390");
  await page.close();
}

async function flowAdmin(browser, { uri }) {
  const page = await newHermeticPage(browser);
  page.on("dialog", (d) => d.accept());
  await page.emulate({ viewport: PHONE, userAgent: (await browser.userAgent()) + " Mobile" });
  await login(page, "admin@test.local");
  await page.goto(`${BASE}/#/admin`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".js-studio-tab", { timeout: 20000 });
  await sleep(1000);
  const overflow = () => page.evaluate(() => document.scrollingElement.scrollWidth > document.documentElement.clientWidth + 1);
  const tab = async (name) => { await page.evaluate((n) => document.querySelector(`.js-studio-tab[data-tab="${n}"]`).click(), name); await sleep(900); };

  // Question bank: server search.
  await tab("bank");
  await page.waitForFunction(() => /Showing 1–/.test(document.body.innerText), { timeout: 10000 }).catch(() => null);
  check(/Showing 1–12 of 12/.test(await page.evaluate(() => document.body.innerText)), "bank tab lists the bank (server-paginated)");
  await page.tap("#bank-search");
  await page.keyboard.type("vectors");
  await page.waitForFunction(() => /of 4\b/.test(document.body.innerText), { timeout: 10000 }).catch(() => null);
  check(/Showing 1–4 of 4/.test(await page.evaluate(() => document.body.innerText)), "bank search works on the phone (4 vectors questions)");
  check(!(await overflow()), "bank tab: no horizontal overflow");
  await shot(page, "admin-bank-390");

  // Edit a question in the studio: change the prompt (LaTeX), preview, save.
  await tab("questions");
  await page.waitForSelector(".js-edit-question-inline", { timeout: 10000 });
  await page.evaluate(() => document.querySelector(".js-edit-question-inline").click());
  await page.waitForSelector("#question-prompt", { timeout: 10000 });
  await sleep(500);
  const newPrompt = "Edited on a phone: $\\frac{a}{b} + \\sqrt{x^2+1}$";
  await page.evaluate((v) => {
    const t = document.getElementById("question-prompt");
    t.value = v;
    t.dispatchEvent(new Event("input", { bubbles: true }));
    const ex = document.querySelector('#question-form [name="explanation"]');
    if (ex && !ex.value) { ex.value = "Differentiate term by term."; ex.dispatchEvent(new Event("input", { bubbles: true })); }
  }, newPrompt);
  const previewShown = await page.evaluate(() => getComputedStyle(document.getElementById("latex-preview-inline")).display !== "none");
  if (!previewShown) await page.evaluate(() => document.getElementById("latex-preview-toggle").click());
  await sleep(800);
  check(await page.evaluate(() => !!document.querySelector("#latex-preview-inline .katex")), "LaTeX preview renders on the phone");
  check(await page.evaluate(() => !!document.querySelector('#question-form input[type="file"]')), "image upload control is present in the editor");
  check(!(await overflow()), "question editor: no horizontal overflow");
  await shot(page, "admin-editor-390");
  await page.evaluate(() => document.getElementById("question-save-btn").click());
  await sleep(3000);
  const mongoose = req("node_modules/mongoose");
  const conn = await mongoose.createConnection(uri).asPromise();
  const saved = await conn.collection("questions").countDocuments({ prompt: newPrompt });
  await conn.close();
  check(saved === 1, "the edited question was saved on the server");

  // Tables become labelled cards.
  for (const name of ["tests", "payments", "seasons", "audit"]) {
    await tab(name);
    await sleep(800);
    const t = await page.evaluate(() => {
      const tables = [...document.querySelectorAll(".table-like")].filter((el) => el.offsetParent !== null);
      return tables.map((table) => {
        const header = table.querySelector(":scope > .table-row.header");
        const rows = [...table.querySelectorAll(":scope > .table-row:not(.header)")];
        return {
          cls: table.className,
          labelled: table.classList.contains("has-cell-labels"),
          headerHidden: !header || getComputedStyle(header).display === "none",
          rows: rows.length,
          rowsWithLabels: rows.filter((r) => r.querySelector("[data-label]")).length,
        };
      });
    });
    const okTables = t.filter((x) => x.labelled && x.headerHidden && x.rowsWithLabels === x.rows);
    check(t.length === 0 || okTables.length === t.length, `${name} tab: tables render as labelled cards (${okTables.length}/${t.length})`, t);
    check(!(await overflow()), `${name} tab: no horizontal overflow`);
    await shot(page, `admin-${name}-390`, true);
  }
  await page.close();
}

const FLOWS = { drawer: flowDrawer, "exam-layout": flowExamLayout, "exam-full": flowExamFull, back: flowBack, persistence: flowPersistence, network: flowNetwork, submit: flowSubmit, "no-fullscreen-api": flowNoFullscreenApi, admin: flowAdmin, "auth-forms": flowAuthForms };

// ---------------------------------------------------------------------------------------
(async () => {
  const { MongoMemoryServer } = req("node_modules/mongodb-memory-server");
  const mongoose = req("node_modules/mongoose");
  const bcrypt = req("node_modules/bcryptjs");
  const dataRoot = path.join(BACKEND, "node_modules/.cache/mongodb-test-data");
  fs.mkdirSync(dataRoot, { recursive: true });
  const dbPath = fs.mkdtempSync(path.join(dataRoot, "mobile-"));
  const mongod = await MongoMemoryServer.create({ instance: { dbPath } });
  const uri = mongod.getUri() + "mobile";

  await mongoose.connect(uri);
  const Season = req("models/Season");
  const User = req("models/User");
  const Question = req("models/Question");
  const Test = req("models/Test");
  const season = await Season.create({ name: "UGEE 2026", year: 2026, status: "active", isDefaultActive: true });
  const hash = await bcrypt.hash("Passw0rd!long", 4);
  await User.create({ name: "Mobile Student", email: "student@test.local", status: "active", isActivated: true, emailVerified: true, passwordHash: hash });
  await User.create({ name: "Admin", email: "admin@test.local", role: "admin", status: "active", isActivated: true, emailVerified: true, passwordHash: hash });
  const qs = await Question.insertMany(
    Array.from({ length: 12 }, (_, i) => ({
      section: i < 6 ? "SUPR" : "REAP",
      topic: ["algebra", "vectors", "reading"][i % 3],
      prompt: i === 0
        ? "Evaluate $\\displaystyle \\int_0^1 \\frac{x^2 + 2x + 1}{\\sqrt{1 + x^2}}\\,dx + \\sum_{k=1}^{n} \\binom{n}{k} a_k b_{n-k} + \\lim_{x \\to 0} \\frac{\\sin x}{x}$ for the given sequence."
        : `Question ${i + 1}: If $f(x) = x^2 + ${i}x$, find $f'(1)$.`,
      options: ["A value", "B value", "C value with a deliberately long option text that has to wrap on small phones", "D value"],
      correctOption: i % 4,
      marks: i < 6 ? 4 : 1,
      negativeMarks: i < 6 ? -1 : 0,
    }))
  );
  await Test.create({ title: "Mobile Mock", isFree: true, status: "live", seasonId: season._id, sectionDurations: { SUPR: 30, REAP: 30 }, durationMinutes: 60, questionIds: qs.map((q) => q._id) });
  await req("models/PaymentRecord").create({ email: "buyer@test.local", normalizedEmail: "buyer@test.local", seasonId: season._id, status: "pending", source: "admin", amount: 499, name: "Buyer Example" }).catch((e) => console.log("payment seed:", e.message));
  // The connection stays open so flows can read server-side records (integrity events).

  const server = spawn(process.execPath, ["server.js"], { cwd: BACKEND, env: serverEnv({ MONGODB_URI: uri, PORT: String(PORT), ADMIN_EMAILS: "admin@test.local" }) });
  let serverLog = "";
  server.stdout.on("data", (d) => (serverLog += d));
  server.stderr.on("data", (d) => (serverLog += d));
  for (let i = 0; i < 60; i += 1) {
    try { if ((await fetch(BASE + "/ready")).status === 200) break; } catch (_e) {}
    await sleep(250);
  }

  const browser = await puppeteer.launch({ executablePath: CHROME_PATH, headless: true, args: ["--no-sandbox"] });
  try {
    for (const [name, fn] of Object.entries(FLOWS)) {
      if (ONLY && !ONLY.includes(name)) continue;
      log(`--- flow: ${name}`);
      // Each flow gets a fresh incognito context: no cookies/session carried between flows.
      const context = await browser.createBrowserContext();
      context.userAgent = () => browser.userAgent();
      try {
        await fn(context, { uri });
      } catch (err) {
        failures.push(`${name}: exception ${err.message}`);
        log("EXCEPTION", name, err.stack);
      } finally {
        await context.close().catch(() => {});
      }
    }
  } finally {
    await browser.close();
    server.kill("SIGTERM");
    await sleep(500);
    await mongoose.disconnect().catch(() => {});
    await mongod.stop().catch(() => {});
    fs.rmSync(dbPath, { recursive: true, force: true });
  }
  if (failures.length) console.log(serverLog.split("\n").filter((l) => /"level":(50|60)/.test(l)).slice(0, 5).join("\n"));
  log(failures.length ? `FAILED (${failures.length})` : "ALL PASSED");
  process.exit(failures.length ? 1 : 0);
})();
