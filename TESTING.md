# Testing

All commands run from `backend/`. Nothing here touches the database in `MONGODB_URI`:
tests and harnesses start their own in-memory MongoDB (`mongodb-memory-server`, data under
`node_modules/.cache/`), and the browser/load harnesses start throwaway servers with
`ACEIIIT_SKIP_DOTENV=1`, so `backend/.env` (which may hold production credentials) is never
loaded.

| Command | What it runs |
|---|---|
| `npm run lint` | ESLint flat config (`eslint.config.js`): correctness rules; `no-console` in server code |
| `npm test` | Jest, 37 suites / 328 tests (unit + HTTP integration via supertest) |
| `npm run test:e2e` | Puppeteer: production boot, student exam flow, custom practice and results, ACEIIIT Mentor, study materials, Admin Studio, responsive audit, mobile flows |
| `npm run load-test` | Concurrent students through the full HTTP flow (20 → 150) |
| `npm audit --omit=dev` | Production dependency advisories (CI fails on high/critical) |

The first test run downloads a MongoDB binary (needs network once).

## Jest suites (`backend/tests`)

| Area | Files | Covers |
|---|---|---|
| Characterization | `characterization/core`, `known-issues` | Baseline login → catalog → access → submit → result behaviour |
| Security | `security/env`, `static`, `oauth`, `session`, `csrf`, `abuse`, `password`, `authz-validation-audit` | Boot env validation; only `public/` served; OAuth audience/issuer/expiry with a local JWKS; immediate session revocation; CSRF on POST/PUT/PATCH/DELETE (missing, mismatched, cookie-less); lockout and enumeration safety (including login timing); cross-user IDOR matrix; input validation and operator/regex injection; audit coverage and redaction |
| Exam integrity | `integrity/exam-session`, `integrity-telemetry`, `repeated-submit` | Server deadlines and clock skew; SUPR lock; one active session (index-enforced), resume/409/takeover; abandoned-session finalize; idempotent submit; scoring and negative marking; ranks on read and tie-breaks; practice; shuffling maps back; telemetry rate limits and server-owned counts; strict auto-submit only past the server threshold; no auto-invalidation; concurrent submits with different idempotency keys finalize one Attempt and one interpretation job |
| Payments | `payments/entitlements`, `data-integrity`, `admin-revoke` | Free / no entitlement / right season / wrong season / revoked / expired / admin; internal provisioning (secret, schema, 422 unmapped, idempotent replay, revoke); catalog leaks no questions; live-question delete → 409; purge cascade; Studio revoke removes all real access (paid tests, practice papers built from paid questions, an exam already open, question review of past paid attempts) and Studio verify grants it |
| Features | `features/qotd`, `email-reminders`, `email-providers`, `uploads-calendar`, `scheduled-tests` | QOTD (no answer leak, free/live only, once per day); HTML/ICS escaping, RFC 5545 UID/SEQUENCE/CANCEL; reminder isolation and backoff; Resend → Brevo → SMTP fallback with a controlled 503; uploads (4 MB, magic bytes, no base64 fallback); calendar token encryption and revoke; scheduled tests listed with their opening time, refused before it (`TEST_NOT_OPEN`), opened by the scheduler job or by the first start after the time, a future time required, publishing now clears it, drafts stay hidden |
| AI | `ai/performance-intelligence` | Deterministic analytics; payload has no PII; schema and typed-number validation; timeout/retry/breaker behaviour; one job per attempt; cache hits make no calls; Attempt never modified; API key never logged; dependency scan for the AI rule (only the AI coach and the mentor's `mentorService` may import the AI layer, and only `mentorController` may import `mentorService`) |
| ACEIIIT Mentor | `mentor/mentor` | Sign-in required; free allowance and IST month reset; a reply charged exactly once (idempotent retry, failures free, last permitted reply then blocked); concurrent sends never exceed the allowance; abandoned reservations expire; enrolled tier only from a verified payment or ACTIVE site entitlement for a configured programme code (pending, revoked, unconfigured or a site outage → free); the browser can't set tier, usage or owner; owner-only conversations and attempts; prompts carry measured results but no name, email or ids, and general doubts carry no personal data; prompt injection changes nothing; malformed input refused; purge deletes mentor data; missing key, refused project, timeout, provider daily quota and the global daily cap fail safely without charging and never leak the key; admin settings validation and stats (Gemini stubbed) |
| Account / admin | `account/account-data`, `account/account-purge`, `admin/question-bank`, `admin/question-images`, `admin/users-list`, `admin/site-orders`, `admin/tests-reorder`, `admin/question-import` | Data export contents (no secrets); deletion (confirmation, password re-check, CSRF, sessions revoked, admins refused) and the 30-day purge; paginated question bank and slim snapshot; question images saved exactly as sent (remove, replace, reorder) with a 0/20–100% display width per image that reaches the exam paper; every user listed (past 500) with true totals, and no internal user fields sent; a student's AceIIIT-site orders fetched for admins only (shared secret), payment screenshots streamed with a safe content type, site outages reported without crashing (site stubbed); admins set the order students see tests in, in one request (students can't; duplicate, unknown or deleted ids change nothing; tests left out keep their place); Excel/CSV import: the template downloads as .xlsx and .csv with the expected columns, the preview saves nothing and reports problems per row (broken LaTeX caught by KaTeX, stray `$`, unknown section, empty topic, missing options, wrong answer letter), CSV quoting, commas and line breaks, duplicate and over-full-section warnings, an all-or-nothing import that re-checks every question and attaches them in sheet order, admin-only, wrong or oversized files refused |
| Practice | `practice/practice-sessions` | Builder options: students get subjects and the largest paper size each can fill (never question counts; topics too thin to practise hidden), admins get counts; students pick a standard size the subject can fill, refusals reveal no numbers; exact topic subjects; time split by question count, untimed cap; a student's practice papers listed with the catalog; REAP-only papers start in REAP; SUPR-only papers get no REAP time |
| Study materials | `materials/study-materials` | Google Drive (faked): connecting needs a matching OAuth state and stores the token encrypted (never returned); existing root folder reused or set by link; disconnect revokes; folders first in natural order with counts; files added directly in Drive appear after a refresh; nothing outside the root folder is reachable (list, stream, thumbnail, search, writes); search with folder paths; streaming with Range, safe inline types only (HTML downloads), Google Docs as PDF; a revoked grant asks for a reconnect; admin-only nested folders, rename, recolour, move (not into itself), delete to trash, resumable upload sessions with a size limit |
| Ops | `ops/observability`, `ops/indexes`, `ops/renumber-attempts` | Request ids, `/health`, `/ready`, error responses without stacks; missing-index detection and recreation; duplicate attempt-number renumbering migration |

## Browser E2E (`backend/tests/e2e`)

Pages are hermetic: requests to anything other than the local test server (Google sign-in script, fonts, CDNs) are blocked, so runs don't hang on the network or DNS; that is why the browser console logs `ERR_FAILED` lines. The screenshot harness (`ui-shots.e2e.js`) still loads Google Fonts. On a machine with little free RAM, run the suites one at a time (`node tests/e2e/<suite>.e2e.js`), because each one starts Chrome, MongoDB and a server.

Uses `puppeteer-core` with a locally installed Chrome (`CHROME_PATH`, default
`/usr/bin/google-chrome`). Screenshots go to `node_modules/.cache/e2e-shots/`
(`SHOTS=1` for the exam suite).

- **`production.e2e.js`** (43 checks): the real `server.js` with `NODE_ENV=production`.
  - Boot is refused for weak config: a short JWT secret, an http base URL, dev auth
    enabled, or no email provider.
  - Security headers are present: CSP, HSTS and nosniff, with no `X-Powered-By`.
  - Nothing outside `public/` is served (`.env`, source and `node_modules` all return 404).
  - `index.html`, SPA routes, `js/app.js` and `css/portal.css` (plain and `?v=` URLs) are
    sent with `Cache-Control: no-store`, so a deploy reaches phones immediately.
  - CSRF is required, and the session cookie is `HttpOnly; Secure; SameSite=Lax`.
  - Mock Google logins, bearer tokens, and internal API calls without the secret are rejected.
  - SIGTERM exits gracefully.
  - The index migration works as a dry run, applies, and is idempotent; the boot warning
    disappears afterwards.
- **`exam.e2e.js`** (24 checks): no token in `localStorage`, httpOnly cookie; QOTD answer
  hidden until submit and persisted; paid test locked without an entitlement; server
  timer; A–D options and number keys; watermark; copy attempt recorded; autosave and
  reload recovery; second tab → 409 → takeover (old token revoked); REAP advance; server
  score and rank; the results page's plan for the next mock (1–3 steps; the AI coach card
  appears only when an AI interpretation is ready, so never on this AI-off server).
- **`practice.e2e.js`** (19 checks): the dashboard eyebrow names the next UGEE once the set exam date
  has passed, and the greeting capitalises the name; the practice builder lists real subjects
  with counts and disables Start when nothing matches; a REAP-only paper opens in REAP (it used
  to submit the moment it opened) with only REAP in the section bar; a SUPR-only untimed paper
  shows no countdown and offers "Submit test"; practice results are unranked (four tiles) with no
  AI coach card; dashboard mock stats leave practice out; the AI coach card renders (from an
  intercepted ready interpretation) after the score tiles and before the plan.
- **`mentor.e2e.js`** (47 checks): the button morphs into the panel (a clip-path from its shape) and back; the dotted orb greets in an empty chat, flies into the conversation on send, shows stage labels that fit the question and hands over to the reply; an empty send shakes the box. One floating button, now a `<button>` named "ACEIIIT Mentor /
  Ask about your performance", hidden on exam screens; with no Gemini key the real server's
  "isn't set up yet" state (no composer, WhatsApp link still inside). Then `/api/mentor` is
  answered by an intercepted fake backend: six suggested prompts, the usage line, "Thinking…"
  with Send disabled, a Markdown reply where HTML from the model is shown as text and never
  runs, a failed reply that isn't counted and is retried with the same message id, minimise
  keeps the conversation, the last free reply then the upgrade panel (exact copy, https CTA in
  a new tab, reset date, Maybe Later), history open/delete, a conversation linked to the attempt
  when opened from results, dark mode, reduced motion, the phone sheet (modal, inert page, Back
  closes it) and sign-out removing the panel.
- **`materials.e2e.js`** (32 checks, `/api/materials` faked): students get folder tiles with counts and Drive colours, breadcrumbs, subfolders and Back, a dense list of 60 files (52px rows, truncated names, no sideways scroll; on phones two-line names, no date column, 44px targets), a remembered list/grid toggle, search with paths, open/download through the portal and no admin controls; admins connect Google Drive (and come back to the tab with a notice), make folders, upload into the open folder through the background panel, and rename, move, recolour and delete from the row menu (Escape returns focus).
- **`admin.e2e.js`** (64 checks): all ten Studio tabs render without errors; the ACEIIIT Mentor tab reports a missing key without showing one, saves allowances and programme codes, and refuses a non-https programme link; question bank
  pagination, server search with focus kept, drawer excludes attached questions and
  attaches; the question image manager adds, sizes, replaces (a failed replace keeps the old
  image), reorders and removes images and Save stores exactly that (uploads answered by an
  interceptor), and the Studio preview shows sized images; integrity settings; Add Payment grants
  an entitlement; User Payments lists every user from the server and Details opens a window. Setup's "+ New test" and "Save changes" (no copies); Existing Tests ordering with arrows, drag-and-drop and a reload. Import from Excel/CSV: an .xlsx with LaTeX previews with KaTeX-rendered maths, a broken formula flagged on its row and the summary focused, imports only the ready rows and attaches them to the test in sheet order; a CSV from the Bank tab goes to the bank only. Scheduled publishing from Setup saves the time, Existing Tests shows it, and a student sees "Opens … IST · in …" with no Start button. Changing pages shows no full-screen loader.
- **`responsive.e2e.js`**: login, forgot-password, every student page and sub-tab (dashboard;
  exams, `exams-practice`, `exams-live`; progress, `progress-reports`; resources,
  `resources-materials`; updates, `updates-events`; account, `account-package`,
  `account-security`), instructions, exam, results and Admin Studio at 320, 360, 375, 390, 412,
  430, 480, 768 (phones and tablet with mobile + touch emulation), 1024, 1280 and 1440 px, plus
  landscape phones 667×375, 812×375 and 844×390 (login, instructions, exam). The student pages
  run again in the dark theme at 320, 390, 430 and 768 (`<route>-<width>-dark.png`). It fails on
  horizontal page overflow (it reports the elements causing it), on nested scrollers that
  double-scroll, when the dashboard's right rail overlaps the main column instead of stacking
  under it (≤992px), or when a card's content is wider than the card (test rows, Next Up,
  progress, account, bookmark, practice and Micro-Quiz cards). A seeded notice renders the
  Notice Board. `node tests/e2e/responsive.e2e.js progress,account` limits the routes;
  `FULL=1` takes full-page screenshots for manual review; `UI_PUBLIC=<dir>` serves the frontend
  from another directory (e.g. a `git archive HEAD backend/public` export) for a before/after
  comparison. The current result is 0 issues.
- **`mobile-flows.e2e.js`** (~170 checks, 390×844 touch emulation unless stated; run one flow
  with `node tests/e2e/mobile-flows.e2e.js <flow>[,<flow>]`, `SHOTS=1` for screenshots):
  - `drawer`: ☰ opens a modal drawer (aria-expanded, inert background, scroll lock, focus
    trap); ESC, outside tap, link tap and route change close it; focus and scroll restored.
  - `exam-layout`: 320–768, three landscape phones, 1366×657 and 1440. Timer, all eight exam
    capabilities reachable, last option clears the action bar, ≥44 px targets, no overflow;
    desktop keeps the sidebar layout.
  - `exam-full`: login → drawer → instructions → answer, clear, calculator, mark, palette
    jump, section transition, submit → results.
  - `back`: Back closes palette → calculator → … in order, no duplicate history entries,
    no ghost overlays after reload, leaving an active exam asks first.
  - `persistence`: reload, rotation and background keep answer, mark, current question and
    the exact server deadline; in-app overlays record no counted integrity events.
  - `network`: offline, Slow 3G, 5xx, a hung save (15 s timeout), 401, and stale or
    out-of-order save responses (the newer answer and mark always win).
  - `submit`: rapid repeated taps finalize exactly one attempt.
  - `no-fullscreen-api`: a browser without the Fullscreen API (iPhone Safari) is not
    blocked by the full-screen prompt.
  - `auth-forms`: Create account, Forgot password (via the link and a direct URL) and the
    feedback banner actually become visible.
  - `admin`: Admin Studio at 390 px: bank, editor with LaTeX preview and save, tables
    as labelled cards, no overflow.
- **`ui-shots.e2e.js`**: screenshots (not assertions) of dashboard, exam, results and Admin
  Studio at 1280, 1366, 1440, 1024 and 390 px, with animations off and fonts loaded.
  `UI_PUBLIC=<dir>` serves another frontend copy against the same server and data, for a
  before/after comparison:
  `git archive HEAD backend/public | tar -x -C /tmp/head && UI_PUBLIC=/tmp/head/backend/public node tests/e2e/ui-shots.e2e.js /tmp/before`.

## Load test (`backend/scripts/load-test.js`)

Each virtual student performs the real browser sequence: CSRF cookie → login → start
exam → paper → 40 SUPR autosaves → advance → REAP autosave → idempotent submit → result.
The paper has 90 questions (40 SUPR + 50 REAP); passwords use the production bcrypt cost
(12). Each concurrency level gets a fresh server process. The harness only runs
locally against its own in-memory database; `--target` (remote) is refused.

```bash
npm run load-test                          # levels 20,40,60,80,100,150
node scripts/load-test.js --levels=20,60 --threadpool=8 --json=results.json
```

### Results (2026-10-07)

The machine was an Intel i3-1215U laptop (8 threads, 6 GB RAM) on Node 22.22. The load
generator, MongoDB and the server shared that machine. AI was disabled. These numbers
compare configurations against each other; they **are not a production capacity claim**.

**Current build** (native `bcrypt`, default `UV_THREADPOOL_SIZE=4`). All runs had 0 errors.

| Students | Login p95 | Autosave p95 | Submit p50 / p95 / p99 | Full flow p95 | CPU peak | RSS peak |
|---|---|---|---|---|---|---|
| 20 | 1.1 s | 78 ms | 170 / 209 / 219 ms | 4.1 s | 270 % | 305 MB |
| 40 | 1.9 s | 137 ms | 304 / 361 / 381 ms | 7.8 s | 332 % | 408 MB |
| 60 | 2.9 s | 196 ms | 456 / 650 / 665 ms | 10.5 s | 357 % | 453 MB |
| 80 | 3.7 s | 243 ms | 546 / 813 / 817 ms | 13.9 s | 375 % | 464 MB |
| 100 | 5.3 s | 330 ms | 701 / 898 / 959 ms | 18.0 s | 391 % | 473 MB |
| 150 | 7.8 s | 423 ms | 984 / 1439 / 1493 ms | 25.7 s | 407 % | 546 MB |

**Before the change** (pure-JS `bcryptjs`, which hashes on the event loop):

| Students | Login p95 | Autosave p95 | Submit p95 | Full flow p95 | CPU peak |
|---|---|---|---|---|---|
| 20 | 4.9 s | 88 ms | 197 ms | 8.2 s | 121 % |
| 60 | 6.6 s | 207 ms | 552 ms | 22.0 s | 117 % |
| 100 | 8.0 s | 1641 ms | 1267 ms | 36.8 s | 115 % |
| 150 | 8.2 s | 2669 ms | 2425 ms | 54.3 s | 113 % |

With `--threadpool=8` at 150 students: login p95 5.2 s, submit p95 1.36 s, full flow p95 22.9 s.

**Reading the numbers:**
- A login burst is dominated by bcrypt (cost 12, about 100–250 ms per hash per core).
  Native bcrypt moved that work off the event loop, which halved end-to-end latency and
  cut autosave p95 at 150 students from 2.7 s to 0.42 s. On a real host, logins spread
  over minutes rather than arriving in one instant.
- The submit queue (`ATTEMPT_QUEUE_CONCURRENCY=8`) peaked at 21 / 41 / 55 / 82 / 130
  waiting submissions at 40 / 60 / 80 / 100 / 150 students. All submissions returned
  201 within `ATTEMPT_QUEUE_MAX_WAIT_MS` (20 s). Past `ATTEMPT_QUEUE_MAX_SIZE` (default
  180), extra submits get a 503. The client retries with the same idempotency key, so no
  answers are lost, but for a cohort that may all submit at the same instant, set
  `ATTEMPT_QUEUE_MAX_SIZE` above the cohort size (e.g. 300 for 250 students). Sessions
  that simply run out of time are finalized by the sweeper, not through this queue.
- Set `UV_THREADPOOL_SIZE` to the host's vCPU count (minimum 4). A 1-vCPU host will log
  in a burst of N students roughly N × 0.15 s apart, but the exam path stays responsive.
- **Before a large live exam:** run this harness against a staging deployment sized like
  production, with a production-tier Atlas cluster. That is the capacity test; the table
  above is not.
