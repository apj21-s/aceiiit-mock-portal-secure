# ACEIIIT Mock Portal: Production Hardening, Agent Handoff & Execution Plan

> **First action once this plan is approved:** write this document verbatim to the repo root as `AGENT_HANDOFF_PRODUCTION_HARDENING.md`, so any agent can pick it up. Writing it doesn't require git; the owner commits it.

**Prepared:** 2026-10-06
**Repos:**
- Portal: `/home/arco/Documents/aceiiit-mock-portal-secure`
- Commerce: `/home/arco/Documents/AceIIIT`

**Companion docs in the portal repo root (read both before starting):**
- `ACEIIIT_Production_Hardening_Specification.md`: the original 23-phase spec.
- `PRODUCTION_HARDENING.md`: the owner's review. **Where it conflicts with anything below, it wins, unless the decision log (§2) says otherwise.**

---

## 0. How to use this document (for the executing agent)

1. Read §1 (rules) and §2 (decisions) in full. These are owner instructions, not suggestions.
2. Read §3 (project facts) to build context. **Line numbers come from an audit taken on 2026-10-06 and will drift**, so re-grep every anchor before you edit.
3. Run milestones **in order**: M0 → M1 → M2 → M2b → M3 → M4 → M5/M6 → M7 → M8. Don't start one until the previous one's exit tests pass.
4. Each milestone follows the same loop: **AUDIT** the current code (re-confirm the §5 classification) → **PLAN** → **IMPLEMENT** → **TEST** → **REVIEW DIFF** → **VERIFY** → **REPORT** (template in §11) → **STOP** and wait for the owner to commit.
5. Update the progress tracker (§10) in the repo copy of this file at the end of every milestone.
6. If the repo no longer matches a finding, classify it as FIXED, OPEN, PARTIAL, OBSOLETE or NOT VERIFIED. Don't apply an old fix blindly.

---

## 1. Operating rules (non-negotiable)

**Git and files**
- **Make no git commits, pushes, branch changes, stashes, resets or any other git write.** The owner does all git work by hand. Read-only git (`status`, `diff`, `log`) is fine.
- **Never read, print, modify or commit `backend/.env`.** `.env.example` may be updated. Refer to env variables by *name* only.
- Never delete `.agents/`, `.ralph/`, `scratch/`, `$null` or user data without explicit approval.
- **Never run destructive scripts or smoke tests against the database in `MONGODB_URI`.** It may be production. Tests must use mongodb-memory-server.
- Don't change the cross-repo AceIIIT project except for the M3 edits listed here. Leave them as working-tree changes only.

**Security and correctness**
- Never weaken security to make a test pass. Never claim something is fixed without a test or direct verification.
- Never put secrets or API keys in frontend code or logs.
- Never trust client timing, client entitlement state, or AI JSON without server-side validation.
- **AI rule:** AI interpretation must never be used in authorization, ranking, scoring, test eligibility, payment state, or exam-integrity enforcement. It is display-only text.
  - Integrity, entitlement, rank and payment code must not import or read `aiInterpretationService` or `AttemptInterpretation`.
  - A test enforces this with a dependency scan.
- Never put Gemini on the submission path; submit must succeed with AI fully off.
- Never make payment or access depend on Google Sheets.
- Never automatically disqualify an attempt based on browser signals. Invalidation is always a human admin action.

**Engineering style**
- Don't rewrite the app. Preserve working behaviour and UX unless security or integrity requires a change.
- Match the existing style:
  - Backend: CommonJS, Express, Mongoose, Zod.
  - Frontend: a vanilla-JS IIFE that builds HTML as concatenated strings, always passed through `escapeHtml`.
- Add regression tests for every security- or integrity-critical change.
- **Priority:** security > data integrity > correctness > reliability > maintainability > performance > cosmetics. Don't polish the UI while an auth bypass exists. Add no infrastructure (Redis or queues) without a measured need.

**Invariants to hold at all times**
- Authentication, exam state and timing are server-authoritative.
- Authorization comes from Entitlement.
- Ranking is computed on the server.
- Payments are backend-native.
- AI only interprets and never blocks.
- The audit log is append-only.
- Secrets stay on the server.

---

## 2. Decision log (owner decisions, with rationale)

| # | Decision | Source and rationale |
|---|---|---|
| D1 | **AI provider: Google Gemini** via `@google/genai`, server-side only. `GEMINI_MODEL` is configurable; default to a current stable **Flash-Lite** model with a free tier (the review mentions Gemini 3.1 Flash-Lite and 2.5 Flash-Lite). **Re-check the official model list and pricing at the start of M7.** | Owner. The task is structured interpretation, so a small model is enough. |
| D2 | **Payments come from the AceIIIT commerce backend** over authenticated HTTP to `/api/internal/access/provision` and `/revoke`. The commerce side must stop writing directly to the portal's Mongo. | Owner, plus §6 finding |
| D3 | **Execute the full 23-phase spec**, curated into milestones M0–M8. | Owner |
| D4 | **Exam integrity = enforcement + telemetry**, not proctoring. Browser signals are evidence; the server enforces. No webcam or screen recording. | Owner review |
| D5 | **Abandoned sessions:** the server deadline runs independently. A sweeper expires the session and finalizes the result from the server-saved answers. Nothing depends on the browser "auto-submitting". | Owner review |
| D6 | **One active exam session with session binding** (`examToken`), not device authentication. A fingerprint is telemetry only. Start/resume/409/takeover behave exactly as in M2b's table. | Owner review |
| D7 | **Git:** the agent never commits or pushes. **Updated 2026-10-07: the owner said not to stop for commits.** Run all milestones back to back; the owner commits everything later. Still give the per-milestone report (§11) in the tracker, with changed files and suggested commit messages. | Owner |
| D8 | Static assets move to **`backend/public/`**; only that directory is served. | Review §31 |
| D9 | User-state cache, if used, has a TTL of 30s or less and is **invalidated immediately** on security changes. Entitlement checks always go to the DB. | Review §3.1 |
| D10 | AI circuit breaker: use the provider's `retryDelay` or a configurable TTL with a maximum. **No hardcoded timezone reset.** | Review §3.2 |
| D11 | Idempotency keys are scoped to `userId + operation + key`, and the stored response is replayable. | Review §3.8 |
| D12 | Catalog metadata policy is in M3. Unauthenticated users get nothing; unentitled users get basic metadata only. | Review §3.9 |
| D13 | AI numeric validation uses a **typed evidence-number set**, not a naive regex. The prompt discourages numbers. | Owner review |
| D14 | CSRF tests cover POST, PUT, PATCH and DELETE individually, plus the match and mismatch cases. | Owner review |
| **Q1 (open)** | **Email fallback provider.** The review says "Resend primary, SMTP fallback". But the live `backend/.env` has the keys `RESEND_API_KEY` and `BREVO_API_KEY` and **no SMTP keys**. Removing Brevo as written would remove the working fallback. **Ask the owner at the start of M4.** If there's no answer: keep **Resend primary + Brevo fallback** (SMTP optional), and remove only Sender and SendPulse. **Related M0 finding:** `sendReminderEmail` (`utils/mailService.js:~171`) uses *only* the `REMINDER_SMTP_*` transport, and none of those keys are set, so **scheduled reminder emails probably never send in production today**. Each `reminderService` flush throws "Reminder SMTP is not configured", and the error is swallowed. M4 must route reminders through the same provider chain as other mail. | Agent finding |

---

## 3. Project facts (verified 2026-10-06)

**Environment**
- Linux, Node **v22.22.1**, npm 9.2.0.
- **No local `mongod` or `mongosh`.** mongodb-memory-server downloads a MongoDB binary on its first run, which needs network. If that's blocked, ask the owner.

**Stack**
- Frontend: a vanilla-JS SPA. `index.html` loads `js/seed.js`, `js/storage.js`, `js/auth.js`, `js/db.js`, `js/ui.js`, KaTeX (jsdelivr CDN) and then `js/app.js`, all with `?v=1.0.31` cache-busting. Google GSI and Apple JS SDKs also load.
- Backend: Express 4, Mongoose 8, Zod 3.25, Helmet, express-rate-limit, multer, Cloudinary, googleapis, resend and nodemailer, all in `backend/`.
- **Run:** `cd backend && npm install && npm start`, which runs `node server.js` on `PORT` (default 4000). Seed with `npm run seed`, but **only against a local DB**, because it deletes all questions and tests. **Test:** `npm test`, added in M0. No lint script yet; that comes in M8.

**Size**
- `js/app.js`: 10,212 lines; `css/portal.css`: 10,240; `js/storage.js`: 1,828.
- Backend: about 6.5k lines; `adminController.js` alone is 1,134 and `authController.js` 794.

**Env variable names in `backend/.env`** (names only; never read the values):
- Server and limits: `ADMIN_EMAILS`, `ATTEMPT_QUEUE_*`, `CORS_ORIGIN`, `HEADERS_TIMEOUT_MS`, `KEEP_ALIVE_TIMEOUT_MS`, `PORT`, `REQUEST_TIMEOUT_MS`, `SERVER_REQUEST_TIMEOUT_MS`.
- Auth: `JWT_EXPIRES_IN`, `JWT_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_CALENDAR_REDIRECT_URI`, `APPLE_CLIENT_ID`, `APPLE_TEAM_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY`, `APPLE_REDIRECT_URI`.
- Email: `BREVO_API_KEY`, `MAIL_FROM_EMAIL`, `MAIL_FROM_NAME`, `RESEND_API_KEY`, `RESEND_FROM`.
- Database: `MONGODB_URI`, `MONGO_AUTO_INDEX`, `MONGO_*`.
- Other: `CLOUDINARY_URL`, `PAID_SHEETS_*`.
- **Missing today:** `INTERNAL_API_SECRET`, `PORTAL_BASE_URL`, `CALENDAR_TOKEN_KEY`, `GEMINI_*`, `SENTRY_DSN`. Add these to `.env.example` and tell the owner to set them.

**Backend map** (`backend/server.js`)
- Middleware order: helmet (CSP) → compression → cookieParser → JSON limit 256kb → morgan (non-production only) → `requestTimeout`.
- Routes:
  - `/vendor/katex` is static from `node_modules/katex`, **which isn't installed**.
  - `/health` and `/api/health`.
  - `/api/upload-image` is mounted *before* `requireDbReady`.
  - Then `/api` → `requireDbReady`, followed by `/api/auth`, `/api/tests`, `/api` (attempts), `/api/reminders`, `/api/admin`, `/api/calendar` and `/api/internal`.
  - **The repo root is served as static files**, and `app.get('*')` falls back to `index.html`.
- Startup: the paid-sheet job starts after 10s; the DB connects with retry and then starts `reminderService`. `unhandledRejection` and `uncaughtException` are logged and swallowed.

**Auth**
- JWT payload: `{userId, role, email, isPaid, name}`, valid 7 days.
- Cookie `aceiiit_session` (httpOnly, sameSite lax, secure in production).
- `middleware/auth.js` accepts a Bearer token *or* the cookie and **never reloads the user**.
- `requireAdmin` checks `req.auth.role`.
- Admin status comes from `ADMIN_EMAILS` at login.

**Models** (`backend/models`): `User`, `Test`, `Question`, `Attempt`, `AuthToken`, `Otp`, `Reminder`, `AppConfig`, `AuditLog`, `Entitlement`, `PaymentRecord`, `Season`, `GoogleCalendarConnection`, `GoogleCalendarEvent`.

**Key services**
- `entitlementService`: `canAccessTest`, `grantEntitlement`, `revokeEntitlement`, `linkPendingPaymentToUser`.
- `testDataService`: catalog, public questions, runtime snapshot, QOTD, `MemoryCache`.
- `rankService`: in-memory snapshot plus key lock.
- `evaluationService`: `evaluateAttempt`.
- `attemptAnalysisService`: `buildAttemptAnalysis`.
- `paymentSyncService`: verify/revoke with audit; the sheet sync is a stub.
- `paidSheetService`.
- `reminderService`: 60s interval, takes the 20 oldest.
- `googleCalendarService`.
- `auditLogService`: `logAuditEvent`.
- `seasonService`: `getActiveSeason`.

**Utilities and middleware**
- Utilities: `mailService` (5 providers, ICS builder at about line 195), `memoryCache`, `normalize`, `http`.
- Middleware: `requestQueue` (`createRequestQueue`, `getStats`), `rateLimit` (6 limiter factories), `timeout`, `dbReady`, `upload` (multer, 15MB), `error`.

**Frontend anchors** (re-grep before editing)
- **`js/storage.js`**:
  - `api()` at 167, `apiForm()` at 193.
  - Session token in `state.session.token`, used at 169, 195, 485–621 and 649–675.
  - Local attempt lifecycle: `createAttempt` at 826, `submitAttempt` at 886, with practice scoring at 896–930.
  - Practice test builder at about 1650–1690.
  - Store exported as `window.AceIIIT.__store`.
- **`js/app.js`**, rendering and helpers:
  - `escapeHtml` at 925, `formatRichText` at 937, `renderLatexInElement` at 944.
  - `getSectionTimeLeft` at 2461.
  - Greetings at about 699.
  - SVG loader `<img>` at 1107; a WebGL canvas at 180–390 whose purpose is unverified.
  - `isAttemptExpired` at 1534.
- **`js/app.js`**, exam and features:
  - `renderInstructions` at 5262 and `renderTest` at 5431. The SUPR→REAP switch is `activateReap` at about 5490–5510. Exam markup is at about 5640–5700 and the timer interval at 6080.
  - `renderResults` at 6127.
  - Print view at 8811–8818 (it escapes LaTeX instead of rendering it).
  - QOTD UI at about 4200–4240 and 4800.
  - Admin "sheet verified" tab at 7456–7505.
  - Route handling: `parseHashRoute` at 9941, `renderRoute` at 9974. The `visibilitychange` and `beforeunload` handlers at about 10090 and 10174 only manage keep-alive.
  - Hash routes: `login`, `activate`, `forgot-password`, `reset-password`, `dashboard`, `exams`, `progress`, `resources`, `updates`, `account`, `instructions/:testId`, `test/:attemptId`, `results/:attemptId`, `admin`, `admin-activity`.

**Commerce repo** (`/home/arco/Documents/AceIIIT/api`)
- TypeScript, Prisma, Jest and supertest (`npm test` runs jest).
- `src/config.ts` already enforces a strong `INTERNAL_API_SECRET` (`strongSecret(16)`).
- **`src/services/commerce.service.ts`**:
  - Provisioning at 346–404, `deprovisionMock` at 411–421.
  - `connectMockPortal` uses `process.env.MONGODB_URI` and a loose `MockUser` schema, and writes `isPaid` directly.
  - Resource code `PAID_MOCK_SERIES`.
- **`src/routes.ts`**: the revoke path calls `deprovisionMock` at about 429, and the retry route for `PROVISIONING_FAILED` is at about 520–530.
- **Tests**: `tests/e2e.test.ts` (step 4 checks provisioning) and `tests/setup-env.ts`.

---

## 4. Where the product stands

**Late beta: feature-complete MVP, not production-safe. Roughly 45–50% ready.**

| Area | Ready | Main gaps |
|---|---|---|
| Features and UX | ~85% | QOTD submit broken; practice scoring broken; ranks frozen; paid buyers blocked (§6) |
| Security | ~35% | 2 auth bypasses, exposed source, default internal secret, 8 vulnerable dependencies |
| Exam integrity | ~45% | Server scoring is good. Timer, section lock and answers live only in the browser. No integrity controls. Paid and draft content leaks. |
| Code quality | ~40% | Two files of 10k lines each; no lint; stray files; most new work uncommitted |
| Tests and CI | ~5% | Ad-hoc scripts only (`scripts/verify-auth-matrix.js`, `backend/scripts/smokeTest.js`, `backend/test_qotd.js`) |
| Ops | ~20% | Single instance, console logs, no backups or staging |
| Docs and legal | ~30% | README still describes OTP and Sheets. DEPLOYMENT, ARCHITECTURE, SECURITY and TESTING docs are missing. |

**What exists**
- **Student**:
  - Sign-in by password, activation link, password reset, Google or Apple.
  - Dashboard with notice, countdown, QOTD and greeting; catalog gated by season.
  - Timed SUPR/REAP exam (palette, review flags, LaTeX, images, calculator, localStorage autosave), local practice mode.
  - Server-side evaluation, results with paginated review, attempt history.
  - Progress, resources, updates and account pages; planner with email and ICS reminders; Google Calendar sync.
- **Admin Studio**:
  - Metrics, snapshot, activity.
  - Question bank with Cloudinary images and LaTeX preview.
  - Test builder: attach/detach, bulk actions, reorder, random generation, duplicate, publish validation.
  - Results, leaderboard, analytics.
  - Users, payments and entitlements, seasons.
  - Trash, app config, audit log viewer.
- **Platform**: JWT (Bearer plus cookie), Helmet CSP, rate limiters, timeouts, attempt queue, in-memory caches, sheet-sync and reminder jobs, internal provisioning API, 5 email providers.
- **Not present, although the spec assumes them**: AI interpretation, backend-native payment ingestion, any exam-integrity enforcement or telemetry, `ALLOW_INSECURE_DEV_AUTH`.

## 5. Phase 0 classification (re-confirm at the start of each milestone)

| Item | Status | Evidence |
|---|---|---|
| `mock_google_` accepted in production | **OPEN P0** | `authController.js:490` |
| `mock_apple_` plus a fallback that trusts an unverified token | **OPEN P0** | `authController.js:613`, `:624-631` |
| `ALLOW_INSECURE_DEV_AUTH` | Absent | Add it as the only gate for dev mocks; the app refuses to start with it in production |
| Internal secret defaults to `'secret'` | **OPEN P0** | `internalRoutes.js:9`; no Zod, plain `!==` compare, no audit. `User.findOne({normalizedEmail})` then creates active users. |
| Repo root served as static files | **OPEN P0** | `server.js:91`: `/backend/**` and `node_modules` are public. `.env` is protected only by the default `dotfiles:'ignore'`. |
| OAuth audience not checked | **OPEN P0** | Skipped when `GOOGLE_CLIENT_ID` or `APPLE_CLIENT_ID` is unset (`authController.js:67,114,509`) |
| Sheets used as authority | **PARTIAL** | `syncGoogleSheetPayments` is a stub, but `paidSheetService.isVerified` still sets `isPaid` (`authController.js:228,545,662`), feeds `isSheetVerified` (`adminController.js:309-310,877`), and starts on boot |
| `/send-otp`, `/verify-otp` | OPEN | `authRoutes.js:51-52`; obsolete aliases |
| `req.auth.id` | **OPEN bug** | `testController.js:504`: QOTD always returns 404 |
| `correctOption` leak in QOTD | **OPEN P0** | `testDataService.js:335-376`: answer included; picks from all questions, including paid and draft |
| Client timing trusted | **OPEN P0** | `attemptController.js:112,157`; ranking tie-break at `rankService.js:421` |
| localStorage bearer token | **OPEN P0** | `js/storage.js:169,195,485-675` |
| Calendar refresh token in plaintext | OPEN P1 | `GoogleCalendarConnection.js:8`. The ICS UID and SEQUENCE are already correct (`mailService.js:206-207`). |
| Stale JWT state | **OPEN P0** | `requireAuth` never reloads the user; tokens last 7 days; deleted or disabled users keep access |
| Entitlement checks | **PARTIAL** | Per-test routes use `canAccessTest`, but the catalog trusts JWT `isPaid` (`testController.js:314-321`) and ships every live test's questions (`testDataService.js:231-266`) |
| Live-question delete bricks tests | OPEN P1 | Soft delete plus a 30-day TTL; the runtime returns null on a count mismatch (`testDataService.js:313`) |
| User TTL index orphans data | OPEN P1 | `User.js:34` |
| Reminder head-of-line blocking | OPEN P1 | `reminderService.js:44-60,113`: a failure aborts the loop, and the 20 oldest failures block everything |
| Email HTML not escaped | OPEN P1 | `reminderService.js:84-96` |
| Upload base64 fallback | OPEN P1 | `uploadController.js:46`. Multer allows 15MB, but `error.js` says 4MB. |
| Admin regex and filter injection | OPEN P1 | `adminController.js:862-871` (search, the `role` query, the enrolled filter ignoring search) |
| Audit coverage | **PARTIAL** | Covers payment verify/revoke (`paymentSyncService`), seasons and publish only |
| Rank frozen at submit | **OPEN P0** | `attemptController.js:190`; repair hack at 78–85; percentile is 0 when the total is 1 |
| `uncaughtException` swallowed, no SIGTERM handling | OPEN P1 | `server.js` end |
| Greetings | FIXED | `app.js:~699`: preserve, then verify the 6 time bands from the spec |
| SVG loader | PARTIAL | `<img>` loader at `app.js:1107`. The WebGL canvas at `app.js:180-390` must be proven unrelated. |
| Vulnerable dependencies | OPEN P1 | `proxy-addr` (critical); `compression`, `multer`, `nodemailer` (high); `mongoose`, `morgan`, `qs` (moderate) |
| Git state | **RISK** | 32 modified files and ~30 untracked core source files. The owner should commit them before M0. |
| KaTeX | OPEN | `/vendor/katex` package missing; the cdnjs fallback (`app.js:954`) is blocked by CSP |
| Practice scoring | **OPEN bug** | `storage.js:896-930`: no `correctOption` on the client, so every answer is wrong; the negative-marks sign is inverted |
| Exam timer, section lock, answers | **OPEN P0** | All client-side (`app.js:2461,5490-5510`, `storage.js:826-860`); system-clock and localStorage edits change the time |
| Exam integrity telemetry | Absent | No visibility, fullscreen, clipboard or multi-tab handling |

## 6. Cross-repo finding: paid buyers are locked out

`AceIIIT/api/src/services/commerce.service.ts:346-404` writes `isPaid:true` straight into the portal's Mongo `users` collection, with **no Entitlement or PaymentRecord**. `canAccessTest` (`entitlementService.js:22-66`) ignores `isPaid` for per-test access. So buyers see the paid tests in the catalog (via JWT `isPaid`), but opening or submitting one returns **402**. Deprovisioning only flips `isPaid`.

Fix in M3: authenticated HTTP becomes a hard architectural boundary:

```text
commerce ──HTTP──▶ /api/internal/access/provision ──▶ PaymentRecord ──▶ Entitlement ──▶ AuditLog
```

---

## 7. Milestones

**Before M0:** ask the owner to commit the current uncommitted work themselves, so your changes show up as clean diffs.

At the end of every milestone:
- run `cd backend && npm run lint && npm test` (lint only once it exists, from M8)
- review `git diff` (read-only)
- fill in the §11 report, with the changed files and a suggested commit message from the list in §9
- **STOP**

### M0: Safety net
- Add `jest`, `supertest` and `mongodb-memory-server` to backend devDependencies, only if absent; this matches AceIIIT/api. Add a `"test": "jest"` script.
- Split `backend/app.js` (builds the Express app, no listeners or jobs) from `backend/server.js` (listen, jobs, shutdown). Tests import `app.js`.
- Write characterization tests for login, catalog, test access, submit and result, using memory-server and seeded fixtures.
- Run `npm audit --omit=dev` and record the baseline in `SECURITY.md`. Use `npm audit fix` (**never `--force`**) and deliberate bumps of multer, nodemailer and compression; document any residual risk.
- **Exit criteria**: `npm test` passes, the app imports without listening, baseline behaviour is recorded, and nothing changes unintentionally.

### M1: Authentication, sessions, CSRF, P0 security
- **OAuth** (`authController.js`):
  - Delete the mock branches, the `decodeJwtPayloadUnchecked` fallback, the body-email paths, and the Google tokeninfo fallback (or keep it only with a strict audience check).
  - Dev mocks are allowed only when `ALLOW_INSECURE_DEV_AUTH=true` and `NODE_ENV!=='production'`; boot fails if the flag is set in production.
  - Always enforce `aud`, `iss`, `exp` and `sub`.
  - Link accounts by provider `sub`. Link by email only when the provider marks it verified. Never trust an email from the request body.
- **Env** (`backend/config/env.js`, Zod, validated at boot): production requires
  - `JWT_SECRET` (32+ characters)
  - `MONGODB_URI`
  - `GOOGLE_CLIENT_ID`
  - `APPLE_CLIENT_ID` (when Apple is enabled)
  - `INTERNAL_API_SECRET` (32+ characters)
  - `PORTAL_BASE_URL` (https)
  - `CALENDAR_TOKEN_KEY`
  - The email provider keys (per Q1)

  Also rename `CLIENT_ORIGIN` to `PORTAL_BASE_URL` (`reminderService.js`, `mailService.js`, `authController.getBaseUrl`), update `.env.example`, and never touch `.env`.
- **Static files**:
  - Move `index.html`, `css/`, `js/` and `assets/` into **`backend/public/`**; serve only that directory (fix relative paths if needed).
  - The SPA fallback serves `index.html` only for extension-less GET requests outside `/api`; anything else returns 404.
  - Install `katex` locally, and make sure the CSP allows the chosen sources.
- **Sessions**:
  - Add `User.tokenVersion`; the JWT carries `tv`.
  - `requireAuth` loads the current user and rejects if deleted, disabled, or `tv` doesn't match. Role and paid state come from the DB.
  - Optional user cache: TTL of 30s or less, invalidated immediately on security changes.
  - Bump `tokenVersion` on password change or reset, disable or delete, role change, `POST /admin/users/:id/revoke-sessions`, and "log out all devices". A normal logout just clears the cookie.
  - JWT lifetime 24h, with sliding renewal in `/auth/me`.
- **Cookie-only auth**:
  - Grep all frontend files for `Authorization`, `Bearer`, `session.token`, `localStorage`, `accessToken` and `jwt`. Migrate **every** consumer in one change (`credentials:'same-origin'`).
  - Stop returning `token` in auth responses, and stop accepting Bearer tokens on browser routes.
- **CSRF**:
  - Double-submit: an `aceiiit_csrf` cookie (not httpOnly), set at login and `/me`, plus an `X-CSRF-Token` header, compared in constant time, on every POST, PUT, PATCH and DELETE under `/api`.
  - The only exemptions are `/api/internal/*` (shared secret) and the Calendar OAuth callback (`state` check).
  - Audit for GET routes with side effects and convert them to POST.
- **Abuse**:
  - `failedLoginCount` and `lockedUntil` on User, plus rate limits keyed by email and by IP. Reduce `authLimiter`.
  - Enumeration-safe responses: no User record is created before activation completes, and login messages are generic.
  - Remove the OTP routes and the `Otp` model.
- **Exit tests**:
  - OAuth: mock Google, forged Apple, wrong audience and expired tokens each get 401; a valid token signed by a local JWKS (with fetch mocked) gets 200.
  - Boot and static: missing production env fails boot; `/backend/server.js`, `/backend/package.json` and `/backend/.env` return 404.
  - Sessions and lockout: a revoked session gets 401 *immediately*; lockout is enforced.
  - **CSRF, per method**:
    - POST, PUT, PATCH and DELETE without the header each get 403.
    - The correct cookie plus the matching header succeeds.
    - A cookie and header that don't match get 403.
    - A header with no cookie gets 403.
    - `/api/internal/*` with the secret succeeds without CSRF.

### M2: Exam integrity (server-authoritative)
- **`AttemptSession`** model: `userId, testId, seasonId, startedAt, sectionDeadlines{SUPR,REAP}, deadlineAt, suprLockedAt, status(active|submitted|expired), examTokenHash, answers (server autosave), lastSeq, submissionKey, submittedReason, attemptId, fingerprint (telemetry only), timestamps`.
  - A **Mongo partial unique index** on `{userId, testId}` with `partialFilterExpression {status:"active"}`.
- **Endpoints**:
  - `POST /api/attempt/start` (semantics in M2b)
  - `GET /api/attempt/session/:id/paper` (questions are served only after start)
  - `PUT /api/attempt/session/:id/answers` (autosave, batched, increasing `seq`)
  - `POST /api/attempt/session/:id/advance` (server-side SUPR lock; REAP starts at server time)
  - `POST /api/attempt` (submit, with `sessionId` and an `Idempotency-Key`)
- **Idempotency**: an `IdempotencyRecord` keyed by `userId + operation + key`, with the stored response replayed on repeat.
- **Validation**:
  - The session belongs to the caller, is active, and is for this test; the deadline check has a 60s grace.
  - Each question must belong to the test and its section, and each answer must be an integer in `[0, options.length)`.
  - SUPR answers are rejected after the SUPR lock or deadline.
  - The active→submitted transition is atomic (`findOneAndUpdate`).
- **Timing**: duration = `min(submittedAt, deadlineAt) − startedAt`, on the server. Client per-question time is clamped and kept for analytics only.
- **Server-side expiry.** It never depends on the browser:
  - When the browser closes, no client request may ever arrive, and the server deadline keeps running on its own.
  - The sweeper job (`services/attemptSweeper.js`, atomic claim) finds `active` sessions past `deadlineAt + grace`, marks them `expired`, and **finalizes them on the server from the last autosaved answers** (`submittedReason:"deadline_expired"`). It uses the same idempotent finalize function as submit and reuses `evaluateAttempt`.
  - Server-saved answers are authoritative. A submit that arrives after finalization gets the finalized attempt back.
- **Ranks**:
  - No stored rank. Rank and percentile are computed on read with a count query; ties break on server duration and then `submittedAt`.
  - Percentile is defined even when there is only one attempt.
  - Cached 15s per test and invalidated on submit.
  - Update `getResult`, `getAnalysisSummary`, `listAttempts` and the admin leaderboard; remove the repair hack at `attemptController.js:78-85`.
- **Practice**: `POST /api/practice` builds an ephemeral server test from questions the student can access and runs it through the same lifecycle. It is marked `isPractice` and excluded from ranks. Delete the client-side scoring in `storage.js:896-930`.
- **Frontend** (`storage.js`, `app.js` 5262–6125):
  - Countdown to the server deadline using a server clock offset (`serverNow`).
  - Autosave status chip ("Saved to server ✓ / Offline").
  - Submit retries with backoff using the same key.
  - Reload resumes from the server.
- **Exit tests**:
  - Session lifecycle: creation. Two concurrent starts without a binding produce exactly one session (index-enforced; the other caller gets 409).
  - Deadlines: late submit rejected; an abandoned session with no client calls is expired and finalized from its saved answers; clock skew has no effect.
  - Submission validity: duplicate submit returns the same attempt; invalid option, wrong question and wrong test are rejected; SUPR after lock is rejected.
  - Scoring and ranking: negative marking is correct; rank changes as others submit; the tie-break works; practice scoring is correct.

### M2b: Exam flow, formatting, exam integrity (enforcement + telemetry)
- **Formatting**:
  - One `renderRichContent(value, {inline})` helper for prompt, passage, options, explanation, review, admin preview and print. The print view at `app.js:8811-8818` currently escapes LaTeX instead of rendering it.
  - A/B/C/D option labels, the whole card clickable, `aria-checked`, and keys 1–4.
  - KaTeX re-renders on every question change; wide math gets `overflow-x:auto`.
  - Images lazy-load with alt text (fallback "Figure n") and keep the lightbox.
  - Passages use a split pane at 1024px and wider.
  - Consistent formats: 2-decimal numbers, mm:ss times, IST dates.
  - Screenshot audit of the instructions, exam (both sections), transition modal, palette (mobile and desktop), submit, results and review screens.
- **Shuffle**: optional `Test.shuffleQuestions` and `Test.shuffleOptions`, seeded per session and mapped back on the server before scoring.

**Integrity model** (enforcement plus telemetry; never "the browser detects cheating and disqualifies"):

```text
Exam Integrity
├── Server deadline                      (enforcement, M2)
├── Server answer validation             (enforcement, M2)
├── Section locking                      (enforcement, M2)
├── Single active session                (enforcement)
├── Concurrent-session prevention        (enforcement: session binding)
├── Automatic expiry + server finalize   (enforcement, M2)
├── Reload recovery                      (server autosave + resume, M2)
├── Visibility/tab-switch telemetry      (signal)
├── Fullscreen state telemetry           (signal)
└── Clipboard/context-menu telemetry     (signal)
```

- **Single active exam session with session binding.** This binds requests to a session; it doesn't authenticate a device.
  - `start` issues a random `examToken`. Only its hash is stored on the session, and the browser keeps the raw value in `sessionStorage`.
  - It is required on paper, answers, advance, events and submit.

  | Situation | Response |
  |---|---|
  | No active session | Create one and return `{sessionId, examToken, serverNow, deadlines}` (201) |
  | Active session, request carries the matching `examToken` | Return the existing session (200; resume) |
  | Active session, request has no valid binding (another tab or device, or cleared storage) | **409 `EXAM_ACTIVE_ELSEWHERE`**, offering takeover |
  | `POST /api/attempt/session/:id/takeover` (explicit action, same authenticated user) | Rotate the token, which **revokes the old one**; return the new token (200); write an `EXAM_SESSION_TAKEOVER` audit and integrity event |

  Any exam call with a revoked or old token gets 409 `EXAM_ACTIVE_ELSEWHERE`. Takeover never resets the deadline or the answers. A fingerprint (user-agent hash plus coarse IP prefix) is **telemetry only**, never a security boundary.
- **Telemetry** (`js/examIntegrity.js`, loaded on the exam route only):
  - **Signals recorded**:
    - tab hidden or window blur (1.5s debounce; in-app calculator, palette and modals exempt)
    - fullscreen exit and return, with duration
    - copy, cut, paste and context-menu attempts; blocked shortcuts
    - offline periods
    - heavy viewport shrink
    - second tab detected (BroadcastChannel)
  - Batched to `POST /api/attempt/session/:id/events` and stored in an `IntegrityEvent` model, rate-limited, with the server keeping the counts.
  - **Light deterrents**:
    - Fullscreen is requested at start, with a non-blocking prompt to return. iOS, which lacks the Fullscreen API, records that instead.
    - Copy, paste, context menu and selection are disabled on the exam surface.
    - `@media print` hides the exam.
    - A faint watermark shows email, session ID and time.
    - A `beforeunload` confirmation.
    - The instructions screen lists everything recorded, and the student must agree before starting.
- **Policy** (`Test.integrity = {mode: "record"|"warn"|"strict", warnThreshold, autoSubmitThreshold}`):
  - **record**: log only.
  - **warn** (the default): a warning modal with a running count.
  - **strict**: once the server-counted `autoSubmitThreshold` is passed, auto-submit the saved answers (`submittedReason:"integrity_threshold"`), after warnings were shown.
  - **There is never automatic disqualification.** `POST /admin/attempts/:id/invalidate` (audited) is the only way to void an attempt, and it removes it from ranks.
  - Admin results and leaderboard show an integrity badge and timeline, with an optional "exclude flagged" filter.
- **Honest limits** (to be written in `SECURITY.md`): signals can be missing, spoofed, or triggered innocently. They are evidence for review, not proof. No webcam or screen recording.
- **Exit tests**:
  - Sessions, one per row of the table:
    - a matching token resumes the session
    - no binding gets 409 and the original keeps working
    - takeover rotates the token, after which the old token gets 409
    - takeover keeps the deadline and answers
    - a takeover audit entry is written
  - Telemetry policy: strict mode auto-submits only after the server threshold; record and warn modes never do; nothing auto-invalidates.
  - Events: rate limits hold, and the client can't lower the server count.
  - Shuffling: answers map back so scores match an unshuffled run.
  - `examIntegrity.js`: jsdom unit tests.

### M3: Payments, entitlements, paid-content isolation
- **Access rule**: `test.isFree || admin || active, non-expired Entitlement for (test.seasonId ?? activeSeason)`. `User.isPaid` stays only as a display cache. `canAccessTest` becomes read-only (side effects move to the payment flows).
- **Catalog metadata policy**:
  - Unauthenticated users get nothing.
  - Unentitled users get `title, subtitle, series, isFree, durationMinutes, questionCount, displayOrder`, but no `questionIds`, topics or difficulty mix.
  - Questions come only via the exam-session paper (M2). The catalog never ships questions, and its cache is keyed per entitlement set.
  - Update the frontend's `state.db.questions` consumers to match.
- **Remove**: `paidSheetService`, `syncGoogleSheetPayments`, `/admin/sync-sheets`, `/admin/payments/sync`, `PAID_SHEETS_*`, `isSheetVerified` (backend and `app.js:7456-7505`), and the sheet job started in `server.js`. Add `"commerce"` to `PaymentRecord.source`.
- **Internal API** (rewrite `routes/internalRoutes.js`):
  - **Secret check**: SHA-256 both values, then `crypto.timingSafeEqual`. This is length-safe.
  - **Request validation**: a Zod body `{commerceUserId, email, resourceCode, entitlementId, idempotencyKey}`.
  - **Season mapping**: `resourceCode` maps to a season via the new `Season.resourceCode` field; if nothing maps, return 422. Never create a default season.
  - **Provision**: upsert a PaymentRecord (verified, `sourceRecordId=entitlementId`), call `grantEntitlement`, then audit `INTERNAL_PROVISION`.
  - **Revoke**: `/access/revoke` calls `revokeEntitlement` and writes an audit entry.
  - **Unknown users**: an unknown email creates a *pending* user who activates normally.
- **AceIIIT repo** (working-tree edits only):
  - In `commerce.service.ts`, `provisionEntitlements` and `deprovisionMock` call the portal over HTTP using `MOCK_PORTAL_URL` and the `x-internal-api-secret` header.
  - Remove `mongoose`, `MockUser` and `connectMockPortal`.
  - Update `config.ts`, `.env.example` and `tests/e2e.test.ts` (mock the HTTP call). Keep the `PROVISIONING_FAILED` state and retry route.
- **Admin**: an "Add payment" form, `POST /admin/payments` (Zod; creates a pending record, and verification grants access).
- **Database integrity**:
  - Drop the `User.deletedAt` TTL; purges become explicit, anonymizing or cascading to related records.
  - Questions referenced by any test are never hard-deleted: deleting one attached to a live test returns 409, and an `archived` state is added.
  - The runtime still loads soft-deleted questions a test references.
  - Attempt review is slimmed to per-question results plus a snapshot taken when a question is edited. The migration script `backend/scripts/migrations/2026-10-attempt-review.js` has a dry-run mode; **never run it against production without the owner**.
- **Exit tests**:
  - Entitlements, six cases: free, no entitlement (402), correct season, wrong season (402), revoked (402), admin.
  - Internal API: missing or wrong secret gets 401; a bad body 400; a valid request creates the entitlement; a replay is idempotent; an unmapped resource gets 422.
  - Deleting a live question gets 409.
  - The catalog leaks no question IDs.

### M4: QOTD, email and reminders, uploads, calendar
- **QOTD**:
  - Candidates come only from questions in live, free tests (or a `qotdEligible` flag), selected by ID rather than loading the whole bank.
  - The GET response has no answer or explanation.
  - `POST /api/tests/qotd-attempt {questionId, selectedOption}` uses `req.auth.userId`, checks it is today's question and the option is in range, and allows one attempt per day. The answer and explanation come back only after submission.
  - Fix `app.js:4200-4240,4800` and remove the guest localStorage answer logic.
- **Email**:
  - `utils/escapeHtml.js` and `escapeIcsText()` (RFC 5545: `\`, `;`, `,`, newline) used in every template (`mailService.js`, `reminderService.js`).
  - Provider consolidation follows **Q1**.
- **Reminders**:
  - New fields `deliveryState (pending|sending|sent|failed)`, `attempts`, `nextAttemptAt`, `failedAt`.
  - Each reminder is claimed atomically and handled in its own try/catch.
  - Backoff 1m → 5m → 30m → 2h; marked failed after 5 attempts.
- **Uploads**:
  - Remove the base64 fallback.
  - Allow only PNG, JPEG, WebP and GIF, checked by magic bytes, up to 4MB in multer. The error message must match the limit.
  - A Cloudinary failure returns a controlled 502.
- **Calendar**:
  - Refresh tokens encrypted with AES-256-GCM (`utils/crypto.js`, `CALENDAR_TOKEN_KEY`), plus a migration for existing tokens.
  - Disconnect revokes the token at Google.
  - The callback URL comes from `PORTAL_BASE_URL` (https in production).
  - Keep UID `<reminderId>@aceiiit.in`, UTC times, and SEQUENCE++ on update or cancel. Add a CANCEL test.
- **Exit tests**:
  - QOTD: no leak, no paid or draft question, one attempt per day, correct user saved.
  - Email: HTML and ICS are escaped.
  - Reminders: one failure doesn't block the others; backoff follows the schedule.
  - Uploads: over 4MB gets 400; a fake magic header gets 400.
  - Calendar: token encryption round-trips; ICS sequence and cancel are correct.

### M5/M6: Authorization, validation, audit
- **IDOR sweep**: every `:id` route gets an owner-or-admin check and `isValidObjectId`. A cross-user test matrix covers attempts, results, analysis, sessions, reminders, calendar, payments and entitlements.
- **Validation**: `middleware/validate.js` taking `({body, query, params})` with Zod. Apply it to seasons (`createSeason` currently has none), payments, entitlements, `toggleAutoAdd`, admin filters (`role` enum, int paging, `escapeRegex` search capped at 64 characters), trash, uploads, internal routes and user/test/attempt routes.
- **Audit** (`logAuditEvent`): user delete, restore and purge; role changes; session revocation; entitlement grant and revoke; config; question and test lifecycle; internal provisioning; payment transitions; attempt invalidation; exam session takeover. A redaction helper keeps secrets, tokens and password hashes out of logs.

### M7: Gemini Performance Intelligence
- **Deterministic layer** (authoritative). Reuses `evaluationService` and `attemptAnalysisService`:
  - `services/analyticsService.js` computes attempt rate, average and median time, time efficiency, section, topic and difficulty accuracy, and mark-leakage estimates.
  - `services/patternDetectionService.js` finds patterns, each with evidence and a minimum sample size:
    - high-time/low-accuracy, fast/low-accuracy, slow/accurate
    - repeated topic failure, difficulty sensitivity
    - question-selection issues, avoidable time sinks
    - an error fingerprint
  - `services/performanceProfileService.js` (V1 small): the change since the previous attempt, and improvement or regression.
  - No psychological claims.
- **AI layer** (`services/aiInterpretationService.js`, `@google/genai`, server only):
  - **Model and key**: `GEMINI_MODEL` per D1. `GEMINI_API_KEY` stays server-side and is redacted from logs.
  - **Payload**: `buildAIInterpretationPayload()` sends sections, topics, difficulty buckets, timing patterns, behaviour patterns and the change since the previous attempt. It **never** sends name, email, userId, attemptId, question text or options, explanations, raw session, auth or payment data. A snapshot test enforces this.
  - **Output**:
    - JSON response mode with a schema built from the same Zod `InterpretationSchema`: `{headline, summary, strengths[], priorityAreas[{topic,reason,action}], behaviorPatterns[], nextTestStrategy[]}`, with count and length caps, low temperature, and a conservative `maxOutputTokens`.
    - **Avoid numbers first**: the prompt tells Gemini not to make numeric claims unless essential, since the UI shows the authoritative metrics.
  - **Typed number check, not a naive regex**:
    - `buildEvidenceNumberSet(evidence)` builds `{percentages, counts, durations (seconds, mm:ss), scores, marks}`.
    - Extract only typed claims: `N%`, `N/M`, `N marks`, `N questions`, `Nm Ns` / `mm:ss`, `rank N`.
    - Ignore numbers inside section or topic names from the evidence, years and dates, and list ordinals.
    - Each claim must match a value of the same type (percentages within ±0.5; counts exact).
    - Prose without numbers always passes.
    - Pipeline: parse → Zod → number check → on any failure, the deterministic fallback.
    - Unit tests cover false positives (plain prose, section names, dates) and true positives (an invented %, rank or score).
  - **Reliability**:
    - **Timeout**: 20s via `AbortController`.
    - **Retries**: only network errors, 429 and 5xx, with exponential backoff, at most 3 attempts. Never retry 400, schema failures or bad configuration.
    - **Circuit breaker** (D10): visible in `/ready` and the admin dashboard.
  - **Async**:
    - Submit persists the attempt and its deterministic analytics, queues the interpretation, and returns; it **never waits for Gemini**.
    - A worker claims jobs atomically.
    - A unique `attemptId` means one analysis per attempt; a cached result means zero further provider calls.
  - **Storage**: an isolated `AttemptInterpretation` collection `{attemptId (unique), status, provider, model, payloadVersion, result, fallbackReason, attemptCount, createdAt, completedAt, expiresAt}`. There is no write path to `Attempt`.
  - **Env**: `GEMINI_API_KEY`, `GEMINI_MODEL`, `AI_INTERPRETATION_ENABLED=false` (off by default), `AI_TIMEOUT_MS=20000`.
- **UI**:
  - A "Performance Intelligence" area with the sections *What Changed? · Your Edge · Where Marks Leak · Your Error Fingerprint · The Pattern · Your Next Move · Your Trajectory*.
  - A **"Verified metrics"** block (from the attempt) is kept visually separate from the **"AI interpretation"** block.
  - While pending, it shows "Analyzing your attempt…" and polls `GET /api/analysis/:id/interpretation` (owner or admin only).
  - If Gemini is off or fails, the deterministic version is shown.
  - Disclosure: "ACEIIIT may use an external AI service to interpret structured performance evidence. AI does not calculate or alter scores." Don't market it as private: free-tier content may be used by Google.
- **Exit tests** (Gemini mocked):
  - Valid output is stored.
  - Invalid JSON, wrong schema and invented numbers all fall back.
  - A timeout retries, then falls back.
  - A 400 is not retried; a 429 retries or trips the breaker; a 500 retries.
  - A duplicate submit creates one job; a cache hit makes 0 calls.
  - PII in the payload fails the test.
  - The Attempt document is unchanged.
  - The API key never appears in logs.
  - The dependency scan confirms that no integrity, entitlement, rank or payment module imports the AI modules.

### M8: Frontend, observability, CI, load testing, docs, legal
- **Loader**: prove the WebGL canvas (`app.js:180-390`) isn't the loader before touching it. The SVG `<img>` loader restarts on every session, hides on success and error, supports reduced motion, and leaves no stale overlay.
- **Responsive audit**: 320, 360, 390, 430, 768, 1024, 1280 and 1440px, using the `run` or `claude-in-chrome` skill if available. Fix only real problems: overflow, double scrollbars, modal state, mobile exam, Admin Studio, greeting transitions.
- **Admin Studio**: run the checklist (search, filter, bulk select, attach/detach, reorder, preview, publish, LaTeX, modal and scroll state). Add server-side pagination for the question bank (`GET /admin/questions`), replacing the full bank in `/admin/snapshot`.
- **Observability**:
  - `pino` plus `pino-http`, with request IDs and redaction; `@sentry/node`, enabled when `SENTRY_DSN` is set.
  - `/health` checks that the process is up. `/ready` checks the DB, queues, job heartbeats and the AI breaker, without exposing secrets or stack traces.
  - An `uncaughtException` is logged, then the process exits. SIGTERM triggers a graceful shutdown: close the server, stop the jobs, disconnect Mongo, with a 10s hard timeout.
- **Code quality**:
  - ESLint (flat config) and Prettier, with a `lint` script. Formatting goes in its own suggested commit.
  - Remove superseded files: `check_braces.js`, `backend/test_qotd.js`, `backend/verify_ics.js`, `scripts/verify-auth-matrix.js`, `$null` (the last only with approval).
  - No framework rewrite.
- **CI**: `.github/workflows/ci.yml` on Node 22 runs install → lint → test → `npm audit --omit=dev --audit-level=high` → build (if one exists).
- **Load testing**: a submission script at 20, 40, 60, 80, 100 and 150 concurrent users, recording p50, p95 and p99, error rate, queue depth, CPU, memory and DB behaviour. **Local or staging only.** The baseline (20 → p95 1.59s; 40 → 4.34s; 60 → 3.55s) is not a capacity claim.
- **Docs**: README, ARCHITECTURE, SECURITY, TESTING and DEPLOYMENT, plus an update to `PRODUCTION_HARDENING.md`. They cover:
  - env vars, staging versus production, rollback
  - backup retention and a *tested* restore
  - OAuth, provisioning, entitlements
  - AI privacy and fallback, and the AI rule
  - exam-integrity limits
  - load results, residual risks

  Remove OTP and Sheets references.
- **Legal**: privacy and terms (reuse AceIIIT's `privacy.html` and `terms.html`), support contact, the AI disclosure, `DELETE /api/account` and `GET /api/account/export`.
- **Deferred to P2**: Redis, distributed queues, horizontal scaling, frontend modularization, Vite, deeper longitudinal AI.

---

## 8. Key files

**Backend**
- **Infrastructure**: new `app.js`; a slimmer `server.js`; new `config/env.js`; middleware `auth`, `csrf` (new), `validate` (new), `error`, `upload`.
- **Controllers**: `auth`, `attempt`, `test`, `admin`, `payment`, `season`, `reminder`, `calendar`, `upload`, plus a new practice controller. All routes are touched.
- **Services**:
  - Changed: `entitlement`, `testData`, `rank`, `reminder`, `paymentSync`, `googleCalendar`, `attemptAnalysis`, `auditLog`.
  - New: `attemptSession`, `attemptSweeper`, `analytics`, `patternDetection`, `performanceProfile`, `aiInterpretation`.
- **Models**:
  - Changed: `User`, `Attempt`, `Question`, `Season`, `PaymentRecord`, `Reminder`, `GoogleCalendarConnection`, `Test`.
  - New: `AttemptSession`, `AttemptInterpretation`, `IntegrityEvent`, `IdempotencyRecord`.
- **Utilities**: `mailService`; new `escapeHtml`, `crypto` and `escapeRegex`.
- **Delete**: `services/paidSheetService.js`, `models/Otp.js`.

**Frontend** (moved to `backend/public/`)
- New `js/examIntegrity.js`.
- `js/storage.js`: cookie and CSRF, start, autosave, advance, submit, takeover, clock offset, practice, per-session paper.
- `js/app.js`: exam flow, `renderRichContent`, QOTD, Performance Intelligence UI, admin payment form and integrity badges, sheet tab removed, loader.

**Cross-repo** (AceIIIT): `api/src/services/commerce.service.ts`, `src/config.ts`, `.env.example`, `tests/e2e.test.ts`.

**Reuse, don't rewrite**: `logAuditEvent`, `grantEntitlement`/`revokeEntitlement`, `createRequestQueue`/`getStats`, `MemoryCache`, `normalizeEmail`, `evaluateAttempt`, `buildAttemptAnalysis`, the ICS builder in `mailService.js`, and the existing Zod patterns and `errorHandler` (`err.expose`, ZodError → 400).

## 9. Suggested commit messages (the owner commits; one or more per milestone)

```text
hardening: establish test baseline                 (M0)
security: harden authentication and sessions       (M1)
security: isolate public assets and secrets        (M1)
integrity: make exam sessions server authoritative (M2)
integrity: exam flow, formatting and telemetry     (M2b)
commerce: migrate to backend-native entitlements   (M3, plus a separate commit in AceIIIT)
security: harden qotd email uploads calendar       (M4)
security: complete idor validation and audit       (M5/M6)
ai: add deterministic performance intelligence     (M7)
ai: integrate Gemini interpretation                (M7)
ops: add observability and CI                      (M8)
test: add production verification matrix           (M8)
docs: document production deployment               (M8)
```

## 10. Progress tracker (keep this updated in the repo copy)

| Milestone | Status | Exit tests | Notes |
|---|---|---|---|
| Pre-M0: owner checkpoint commit | ☐ (skipped) | n/a | The owner said "go" without committing. The agent saved non-git baselines (without `.env`) to its session scratchpad. |
| M0 Safety net | ☑ 2026-10-06 | ☑ 13/13 | `app.js`/`server.js` split; Jest, supertest and memory-server; characterization and known-issue tests; prod audit 8 → 0; `SECURITY.md` |
| M1 Auth/sessions/CSRF/static | ☑ 2026-10-07 | ☑ 90/90 | Report in §14 |
| M2 Exam integrity | ☑ 2026-10-07 | ☑ 114/114 + browser E2E | Report in §14 |
| M2b Exam flow/formatting/integrity telemetry | ☑ 2026-10-07 | ☑ 124/124 + browser E2E | Report in §14 |
| M3 Commerce/entitlements (+ AceIIIT) | ☑ 2026-10-07 | ☑ portal 146/146 + E2E; AceIIIT 87 pass | Report in §14 |
| M4 QOTD/email/uploads/calendar | ☑ 2026-10-07 | ☑ 168/168 + E2E | Q1 resolved by default (Resend→Brevo→SMTP); report in §14 |
| M5/M6 IDOR/validation/audit | ☑ 2026-10-07 | ☑ 178/178 + student & admin E2E | Report in §14 |
| M7 Gemini Performance Intelligence | ☑ 2026-10-07 | ☑ 210/210 + E2E | Model re-checked 2026-10-07; report in §14 |
| M8 Ops/frontend/CI/load/docs/legal | ☑ 2026-10-07 | ☑ 232/232 + 4 E2E suites (prod smoke 36/36) | Report in §14 |
| Final verification and report | ☑ 2026-10-07 | ☑ 236/236 + 4 E2E suites, lint 0 errors, prod audit 0 | "Final report" in §14. Production readiness depends on the owner items it lists |

## 11. Per-milestone report template

```text
## Milestone Mx: <name>
Audit re-check: <items re-classified, with FIXED/OPEN/PARTIAL/OBSOLETE/NOT VERIFIED>
Implemented: <bullets>
Tests run: <command> → <pass/fail counts>; new tests: <list>
Exit criteria: <each item → PASS/FAIL/PARTIAL/NOT VERIFIED>
Changed files: <git diff --stat output>
Migrations/env changes: <new env names for the owner to set; scripts to run and how>
Risks/notes: <...>
Suggested commit message: <from §9>
STOPPED: waiting for the owner to commit before Mx+1.
```

## 12. Final verification and acceptance
- **Final matrix** (supertest plus curl against a local server with `NODE_ENV=production` and test env values):
  - Every row of `PRODUCTION_HARDENING.md` §30.
  - Exam integrity, each of which must hold:
    - changing the clock gives no extra time
    - SUPR answers are rejected after the lock
    - a conflicting second session gets 409 (session binding)
    - takeover revokes the old token
    - strict mode auto-submits only after the server threshold
    - an abandoned session is expired and finalized on the server from its saved answers, with no client request
  - The CSRF per-method matrix.
  - The AI dependency-isolation scan.
- **End to end** (browser):
  1. Log in.
  2. Start the exam: agree to the rules and go fullscreen.
  3. Reload mid-exam. The deadline persists and answers come back from the server.
  4. Open a second tab. It gets 409, then try takeover.
  5. Switch tabs. Telemetry is logged.
  6. Submit. Result and rank appear, and the AI panel goes from pending to ready or fallback.
  7. Have an admin revoke the entitlement. Access is lost immediately.
- **Cross-repo**: AceIIIT `npm test` with HTTP provisioning mocked; then, on staging, commerce verify → portal entitlement → the paid test opens.
- **Acceptance**: the 20 Final Acceptance Criteria in `PRODUCTION_HARDENING.md`. Label each unresolved item OPEN, PARTIAL, NOT VERIFIED or ACCEPTED RISK. Never hide uncertainty.
- **Final report** covers: executive summary, changes, tests run, the PASS/FAIL/PARTIAL/NOT VERIFIED matrix, remaining risks, changed files, migration requirements, deployment checklist, rollback plan, and production items that couldn't be verified.
- **Can't be verified from the dev machine** (these become owner checklist items): Atlas backup and restore drill, the Sentry account, a staging environment, real OAuth and Gemini keys, legal review.

## 13. Known gotchas
- **Testing setup (since M0):**
  - `cd backend && npm test` runs Jest in band.
  - `tests/helpers/env.js` forces `NODE_ENV=test` and fake secrets, and never loads `.env`.
  - `tests/helpers/db.js` starts mongodb-memory-server with its data under `backend/node_modules/.cache/mongodb-test-data/`, because `/tmp` is a quota-limited tmpfs that fails with "Disk quota exceeded".
  - `tests/helpers/fixtures.js` provides users, questions, tests, entitlements and `loginAs`. `loginAs` returns a Bearer token today; switch it to a cookie agent in M1.
  - **`tests/characterization/known-issues.test.js` asserts today's defects.** Flip each test when its milestone fixes the defect.
- **Imports:** `backend/app.js` exports `createApp()` and doesn't listen. `server.js` loads dotenv, then listens and starts jobs.
- **Mongoose duplicate-index warnings:** `User.normalizedEmail` and `GoogleCalendarEvent.reminderId` declare both `index:true` and `schema.index()`. Clean this up in M3 (database integrity).
- **Node version:** nodemailer 10 requires Node ≥ 20, and `engines` is set to match.
- **Line numbers drift** as milestones change files. Always re-grep the anchors.
- **Moving to `backend/public/`**: `index.html` uses relative paths (`css/`, `js/`, `assets/`), so moving the four items together keeps them working. Check every hard-coded `/assets/...` and every link the CSS uses.
- **mongodb-memory-server** needs to download a binary on its first run.
- **CSP** currently allows the jsdelivr CDN for KaTeX and Google/Apple SDKs. Keep these when tightening, or self-host KaTeX.
- **`app.js` re-renders whole views** with `innerHTML` and rebinds handlers. New exam features must hook into `renderTest`'s rebinding and `stopRuntime` cleanup, otherwise timers and listeners leak.
- **`storage.js` keeps `state.db` in localStorage.** After M2/M3 it must stop being the source of truth for attempts and questions; keep it only as a cache and UI state.
- **The commerce repo** shares `MONGODB_URI` naming with the portal. Once it moves to HTTP, it must no longer need the portal's DB URI.
- The **`.env` has `BREVO_API_KEY`** but no SMTP (see Q1).
- **Free-tier Gemini** content may be used by Google, so never send PII or question text.

---

## 14. Milestone reports (agent log)

### M1: Authentication, sessions, CSRF, static files (2026-10-07)
**Re-audit:**
- `mock_google_`/`mock_apple_`, the unverified Apple fallback, optional audience, repo-root static serving, localStorage Bearer tokens, stale JWT state and the OTP aliases were all OPEN. All are now **FIXED**.

**Implemented:**
- **Env validation:** `config/env.js` (Zod) is called from `server.js`. Production requires JWT/INTERNAL/CALENDAR secrets of 32+ characters, `MONGODB_URI`, `GOOGLE_CLIENT_ID`, an https `PORTAL_BASE_URL` and an email key, and refuses `ALLOW_INSECURE_DEV_AUTH`.
- **OAuth** (`authController.js`, rewritten):
  - JWKS verification of signature, alg, iss, aud, exp and sub, refetching keys once when the `kid` is unknown.
  - Fails closed: 503 when not configured or keys can't be fetched.
  - No tokeninfo fallback, no unsigned decode, and mocks only behind the dev flag.
  - Links accounts by provider subject, or by email only when the provider verified it; 409 when the email is bound to another subject.
- **Sessions:**
  - `services/sessionService.js`: JWT `{userId, tv}`, 24h (`SESSION_TTL_HOURS`), with sliding renewal in `/auth/me`.
  - `middleware/auth.js`: cookie only, loads the user on every request (no cache), and rejects deleted, disabled or `tv`-mismatched sessions. Role and paid state come from the DB.
  - `User.tokenVersion` is bumped on password change or reset, role change, admin delete, `POST /api/admin/users/:id/revoke-sessions` (audited) and `POST /api/auth/logout-all`.
- **CSRF:** `middleware/csrf.js` implements double-submit (`aceiiit_csrf` cookie plus `X-CSRF-Token` header, constant-time compare) on POST, PUT, PATCH and DELETE under `/api`. Only `/api/internal/*` is exempt. `GET /api/auth/csrf` bootstraps the token.
- **Abuse protection:**
  - `loginAccountLimiter`: per email, failures only, 5 per 15 minutes.
  - DB lockout using `failedLoginCount`/`lockedUntil`. Attempts 1–5 get 401 and the 6th gets 429, the same for existing and unknown accounts.
  - Generic login message.
  - Activation request: same response for everyone and no User created. The account is created at `/activate/complete` (`AuthToken.userId` is now optional).
  - Per-IP auth limit lowered from 1000 to 600 per 10 minutes.
  - OTP routes, the OTP limiter, `models/Otp.js`, `sendOtpEmail` and the frontend `sendOtp`/`verifyOtp` were removed.
- **Static:** `index.html`, `css/`, `js/` and `assets/` moved to `backend/public/`, and only that directory is served. The SPA fallback serves only extension-less GETs outside `/api`. KaTeX 0.16.9 is installed locally (`/vendor/katex`); the fallback URL is jsdelivr, which the CSP allows (cdnjs was blocked).
- **Frontend** (`public/js/storage.js`): a single `request()` path sends the cookie session plus the CSRF header, refreshes the token and retries once on `CSRF_FAILED`, and clears the session on 401. No token is stored, and legacy stored tokens are dropped. The calendar helpers go through `api()`.

**Tests:** `npm test` → 8 suites, 90 tests, all pass.
- New in `tests/security/`: `env`, `static`, `oauth`, `session`, `csrf`, `abuse`.
- `tests/helpers/session.js` provides a cookie and CSRF client.

**Exit criteria (all PASS):**
- Mock Google, forged Apple, wrong audience and expired tokens each get 401.
- Missing production env fails boot.
- `/backend/server.js`, `/backend/package.json` and `/backend/.env` return 404.
- A revoked session gets 401 immediately.
- POST, PUT, PATCH and DELETE without CSRF each get 403; a mismatched token gets 403; a header without a cookie gets 403.
- Lockout is enforced.

**Env for the owner to set before deploying:** `PORTAL_BASE_URL`, `INTERNAL_API_SECRET` (the same value in AceIIIT, 32+ characters), `CALENDAR_TOKEN_KEY`, `SESSION_TTL_HOURS` (optional), `GOOGLE_CLIENT_ID`. `JWT_SECRET` must be 32+ characters. `JWT_EXPIRES_IN` is no longer used.

**Notes and risks:**
- **Everyone is signed out once on deploy.** Existing 7-day JWTs lack `tv` and fail the check.
- **GET side effects:** `/api/calendar/google/connect` sets an OAuth-state cookie, which carries no CSRF risk. `getResult`'s rank "repair" write is removed in M2.
- `scripts/test-login-load.js` and `scripts/verify-auth-matrix.js` still use the old Bearer/mock flows; they get updated or removed in M8.

**Suggested commits:** `security: harden authentication and sessions` and `security: isolate public assets and secrets`

### M2: Server-authoritative exam sessions (2026-10-07)
**Re-audit:** client-owned timing, section lock and answers; client timing used in ranking; frozen rank; broken client-side practice scoring. All were OPEN and are now **FIXED**.

**Implemented:**
- **Models:**
  - `models/AttemptSession.js`: Mongo partial unique index `one_active_session_per_user_test` on `{userId, testId}` where `status:"active"`. Stores the exam token hash, server-saved answers, timeSpent, marked, visited and `lastSeq`, the timeline fields, and `submittedReason`.
  - `models/IdempotencyRecord.js`: unique on `userId+operation+key`, with a 24h TTL.
  - `Attempt` gained `sessionId` (unique, sparse), `isPractice`, `submittedReason` and `invalidatedAt`/`invalidatedReason`.
  - `Test` gained `status:"practice"`, `isPractice` and `ownerUserId`.
- **`services/attemptSessionService.js`:**
  - `computeTimeline` uses server timestamps only. REAP starts at the early SUPR submit or automatically at the SUPR deadline; grace is 60s.
  - `startSession` follows the start/resume/409 table.
  - `takeoverSession` rotates the token.
  - `getPaper` serves questions only after start and requires the token.
  - `saveProgress` validates question membership, option range, section lock, REAP not started, deadlines and stale `seq`.
  - `advanceSection` performs the server SUPR lock.
  - `finalizeSession` is idempotent and race-safe: it claims `active→finalizing`, recovers stuck claims, and guarantees exactly one Attempt per session.
  - `submitSession`: a late submit gets 409 `EXAM_EXPIRED` and the saved answers are finalized.
  - `listActiveSessions` finalizes any expired sessions it finds.
- **`services/attemptSweeper.js`** runs every 30s from `server.js`. It expires sessions past the deadline and finalizes them from saved answers. No browser involvement is needed, and it is safe across instances.
- **`services/rankService.js`:** rank and percentile are computed on read (score desc, then server duration asc, then `submittedAt` asc), excluding admin, practice and invalidated attempts. Cohorts are cached 15s and invalidated on finalize. A single student gets percentile 100. Admin snapshot, results and user detail also compute ranks on read.
- **Routes** (`routes/attemptRoutes.js`):
  - `POST /api/attempt/start`
  - `GET /api/attempt/sessions/active`
  - `POST /api/attempt/session/:id/{takeover,advance,abandon}`
  - `GET …/paper`
  - `PUT …/answers`
  - `POST /api/attempt` (requires `sessionId`, `X-Exam-Token` and `Idempotency-Key`)

  The legacy direct submit gets 400.
- **`POST /api/tests/practice`:** a server-built paper drawn only from accessible questions. Free accounts get one; it is excluded from the catalog, admin lists and ranks.
- **Rate limits:** `submissionLimiter` and `readLimiter` are keyed by user when authenticated, so one campus NAT IP doesn't throttle a whole class.
- **`middleware/error.js`** passes `code` and extra fields (`attemptId`, `sessionId`) through on exposed errors.
- **Frontend** (`public/js/storage.js`, `public/js/app.js`):
  - The local attempt mirrors the server session, and the timer uses `store.serverNow()`, a monotonic `performance.now()` offset from the server clock.
  - Autosave is debounced at 3s and sends only changed answers (plus timeSpent, marked and visited), with an increasing `seq`. It retries 3s, 6s, 15s, then 30s, and resyncs on `SECTION_LOCKED`.
  - A "Saved to server ✓ / Offline" chip shows autosave state.
  - Answers are flushed with a keepalive `fetch` on unload and when the tab is hidden.
  - `launchExam()` handles start, resume, the 409 takeover confirm, and expired sessions (showing the server result).
  - Advancing to REAP calls the server.
  - Submit uses a stable Idempotency-Key and retries on 5xx or network errors; `EXAM_EXPIRED` leads to the finalized result.
  - **Quit and Restart now submit the saved answers** (`/abandon`). This closes the "abandon near the deadline and restart for more time" hole.
  - Client-only practice tests and pre-session in-progress attempts from older builds are dropped on load.
- **Bugs fixed along the way:**
  - `User.toJSON` leaked `tokenVersion`, `failedLoginCount`, `lockedUntil` and the Google/Apple subjects; these are now stripped.
  - **The results page threw on a missing `#back-dashboard` button, so Retake never worked.** The bindings are now guarded.

**Tests:**
- `npm test` → 114/114, including new `tests/integrity/exam-session.test.js` (23 tests).
- **Browser E2E** with puppeteer-core and system Chrome: the script lives in the agent scratchpad and will be added to the repo in M8. It covers cookie login (no token in storage, httpOnly cookie), start, timer from the server, autosave to the server, reload recovery, a second tab getting 409 → takeover (same session, answers carried over, old token rejected), REAP advance, submit, server score 8, rank-on-read, and the results page rendering. There are no console errors other than the designed 409s.

**Exit criteria (all PASS):** session creation; a concurrent duplicate start produces one session; deadline enforcement; late submit rejected; abandoned session finalized server-side; duplicate submit returns the same attempt; invalid option, wrong question and wrong test rejected; SUPR after lock rejected; negative marking; rank changes as others submit; server-time tie-break; clock skew ignored.

**Notes:**
- Attempts already in the DB keep their stored `rank`/`percentile` fields, but responses now compute them, so those fields are ignored.
- The legacy `getTestQuestions` endpoint still serves questions before start. M3 restricts it (questions then come only via the paper).

**Suggested commit:** `integrity: make exam sessions server authoritative`

### M2b: Exam flow, formatting, integrity (enforcement + telemetry) (2026-10-07)
**Implemented:**
- **Shuffling:**
  - `Test.shuffleQuestions` and `Test.shuffleOptions` are copied onto the session with a random `shuffleSeed` (`attemptSessionService`: `seededShuffle`, `optionPermutation`, `orderQuestions`).
  - Questions are shuffled within each section, and SUPR always precedes REAP.
  - The paper serves permuted options. Answers are stored in the **original** option order (mapped in `buildProgressUpdate`) and echoed back in displayed order (`sessionView` takes optional `optionCounts`), so scoring is unchanged.
- **Integrity policy:** `Test.integrity = {mode: record|warn|strict, warnThreshold, autoSubmitThreshold}`, defaulting to warn, then 1, then 5; practice papers use record. The policy is snapshotted onto `AttemptSession.integrity`, which also holds the server-side `violations`, `byType`, `lastCountedAt` and `takeovers`.
- **Telemetry endpoint:** `models/IntegrityEvent.js` plus `POST /api/attempt/session/:id/events`, which requires the binding and is rate-limited.
  - **Counted events:** `tab_hidden`, `fullscreen_exit`, `copy_attempt`, `cut_attempt`, `paste_attempt`, `blocked_shortcut`, `print_attempt`, `second_tab`.
  - **Telemetry only:** `window_blur`, `context_menu`, `offline`, `viewport_shrink`, `fullscreen_return`, `device_takeover`.
  - A counted type is deduped within 2s, and the client can't lower the count.
  - Strict mode with violations over the threshold finalizes the session (`submittedReason:"integrity_threshold"`).
  - **No mode ever auto-invalidates.** A takeover writes a `device_takeover` event plus an `EXAM_SESSION_TAKEOVER` audit entry. `Attempt.integrity` snapshots the counts at finalize.
- **Admin:**
  - `GET /api/admin/attempts/:id/integrity` returns the event timeline.
  - `POST /api/admin/attempts/:id/invalidate {reason, restore?}` requires a reason, is audited as `ATTEMPT_INVALIDATED`/`ATTEMPT_RESTORED`, invalidates the rank cache and is reversible.
  - The leaderboard accepts `?excludeFlagged=1`, and the results payload includes integrity data.
  - The admin UI gains a results badge, Review (timeline) and an invalidate/restore prompt. The test form has integrity mode, a strict limit, and the shuffle checkboxes.
- **Frontend** (`public/js/examIntegrity.js`, new):
  - Monitors visibility, debounced blur, full-screen exit (10s grace with a one-click return prompt), clipboard and context menu (blocked on the exam surface), blocked shortcuts, print, a second tab via BroadcastChannel, offline duration and viewport shrink.
  - Events are batched to the server. Adds a watermark (email, session and time) and `@media print` hiding.
  - Full screen is requested inside the Begin click.
  - A non-blocking notice shows the server count.
  - The instructions page discloses everything that is recorded, and the student agrees to it.
- **Formatting:**
  - A–D option letters, with keys 1–9 to select (ignored in text fields and modals).
  - Lazy images with "Figure n" alt text.
  - Passage/question split pane at 1024px and wider.
  - Scrollable `.katex-display`.
  - **Admin PDF export now renders LaTeX** (KaTeX in the export window) instead of printing escaped source.
- **Bug fixed** (it predates this work): **the exam was broken on phones (≤780px).** Unconditional `!important` "Floating Exam Layout" rules later in `portal.css` re-showed the desktop sidebar and forced a 280px column. A mobile override is now appended last. Verified by screenshot at 390px with no horizontal overflow.

**Tests:**
- `npm test` → 124/124, including new `tests/integrity/integrity-telemetry.test.js` (10 tests): shuffle mapping and scoring, section ordering, binding required, warn counting and dedupe, unknown types rejected, strict auto-submit after the threshold (not invalidated), record mode, takeover audit, admin timeline, invalidate/restore and ranks, `excludeFlagged`, and students forbidden from both.
- **Browser E2E** additionally checks A–D letters, the watermark, the number-key select, a copy attempt being recorded server-side with a notice shown, and no overflow at 390 and 1280px.

**Honest limits:** browser signals deter and inform but can't stop a second device or devtools. This is documented in `SECURITY.md` in M8.

**Suggested commit:** `integrity: exam flow, formatting and telemetry`

### M3: Payments, entitlements, paid-content isolation (2026-10-07). First half; see the completion entry below
**Done (backend; `npm test` 123/123):**
- `canAccessTest` is read-only and implements: free OR admin OR active, unexpired Entitlement for the test's season. The isPaid shortcut and the grant side effect are removed. `getEntitledSeasonIds`, `isTestAccessible` and `hasAnyActiveEntitlement` were added.
- `linkPendingPaymentToUser` no longer reactivates revoked entitlements. It only links `userId` and creates missing entitlements for verified payments.
- **Catalog** (`testDataService.getCatalogPayload`): metadata only, with `questionIds: []`, `questions: []`, a per-user `accessible` flag, and `sectionSummary` only when accessible. The shared base is cached 60s.
- `GET /api/tests/:id/questions` is admin-only; students get 403 `PAPER_VIA_SESSION_ONLY`. The runtime and public question loaders now include soft-deleted questions a test still references, so a test can't brick.
- **Sheets removed:**
  - Deleted `services/paidSheetService.js` and `scripts/smokeTest.js` (which was Sheets-based).
  - Removed `/admin/sync-sheets`, `/admin/payments/sync`, the sheet job in `server.js`, `isSheetVerified` in the admin API, and the signup `isPaid` from Sheets.
  - `PaymentRecord.source` now accepts `commerce|admin|google_sheet` (the last is legacy only).
- `Season.resourceCode` field added.
- **`services/paymentSyncService.js`:**
  - `createManualPayment`, exposed as `POST /api/admin/payments`: creates a pending record that the admin then verifies.
  - `provisionFromCommerce` and `revokeFromCommerce`: idempotent, audited as `INTERNAL_PROVISION`/`INTERNAL_REVOKE`, and create a pending user for unknown emails.
  - `resolveSeasonForResource`: a tagged season, else the generic codes (`COMMERCE_ACTIVE_SEASON_RESOURCE_CODES`, default `PAID_MOCK_SERIES`) map to the existing active season, else 422. It never creates a season.
  - Errors now carry HTTP status codes.
- **`routes/internalRoutes.js` rewritten:**
  - Mandatory `INTERNAL_API_SECRET`: none set means closed (401).
  - SHA-256 plus `timingSafeEqual` compare.
  - Zod body `{commerceUserId, email, resourceCode, entitlementId, idempotencyKey}`.
  - Rate limited.
  - `POST /access/provision` and `POST /access/revoke`.
- Fixed the admin users "enrolled only" filter, which ignored the search term.

**Remaining M3 work (next agent, start here):**
1. **Tests:** six-case entitlement matrix (including expired); internal API (missing or wrong secret 401, bad body 400, valid request creates the entitlement, replay is idempotent with no duplicate audit, unmapped resource 422, revoke works); `POST /admin/payments` followed by verify grants access; catalog leaks no IDs.
2. **Frontend** (`public/js/app.js`):
   - Replace `!t.isFree && !user.isPaid && !auth.isAdmin(user)` locks (around lines 3811, 3881, 4430, 4476, 4511, 5431) with `t.accessible === false`.
   - `renderInstructions` must stop calling `getTestQuestionsFromRemote`/`ensureTestQuestionsLoaded` for students. Use `test.sectionSummary` for counts and marks.
   - Remove the "sheet" users tab (around line 7717) and `syncPaidSheets` (storage around 1916, app around 9427).
   - Add an admin "Add payment" form that calls `POST /api/admin/payments`.
   - Set `User.isPaid` in `/auth/me` from `hasAnyActiveEntitlement` (display only).
3. **AceIIIT repo** (`api/src/services/commerce.service.ts:346-421`): replace the direct `MockUser` Mongo writes with `fetch(MOCK_PORTAL_URL + "/api/internal/access/provision|revoke")` with the `x-internal-api-secret` header. Remove `mongoose`, `MockUser` and `connectMockPortal`. Add `MOCK_PORTAL_URL` to `config.ts` and `.env.example`. Update `tests/e2e.test.ts`.
4. **Database integrity:**
   - Drop the `User.deletedAt` TTL index, with a migration script to drop the `deletedAt_1` index on users.
   - `deleteQuestion`/purge must return 409 when the question is attached to a live test.
   - User purge should anonymize and cascade.
   - Fix the duplicate-index warnings (`User.normalizedEmail`, `GoogleCalendarEvent.reminderId`).
   - Attempt-review slimming: decide and document (deferred is acceptable if justified).
5. Re-run the browser E2E (scratchpad script `e2e/exam-e2e.js`; copy it into the repo in M8) after the frontend changes.

**After M3:** M4, M5/M6, M7 and M8 per §7.

### M3, completion (2026-10-07)
**Done after the partial entry above:**
- **Tests:**
  - `tests/payments/entitlements.test.js` (18): the six-case matrix plus expired; `User.isPaid` alone gives 402; login doesn't reactivate a revoked entitlement; catalog isolation.
  - Internal API: missing, wrong or unset secret → 401; bad body → 400; unmapped resource → 422 with no season created; a valid request creates a commerce PaymentRecord, an Entitlement, an audit entry and a pending user; replay is idempotent; a tagged season wins; revoke works and is audited.
  - Admin add-payment then verify grants access; students get 403.
  - `tests/payments/data-integrity.test.js` (5).
- **Bug fixed:** `getActiveSeason()` fell back to the newest season *even if archived*. It now excludes archived seasons.
- **Frontend:**
  - Locks use the server-computed `test.accessible` via `isTestLocked()` instead of `user.isPaid`.
  - `renderInstructions` never fetches questions for students; it uses `test.sectionSummary` for counts and marks.
  - The Sheets UI is replaced by an "Add payment" form (`store.createPayment`) with "verify now".
  - The buy screen copy no longer says "log out and log in again".
  - `/auth/me` and login sync `User.isPaid` from `hasAnyActiveEntitlement` (display only).
- **AceIIIT repo** (working tree only; your own uncommitted changes there were kept):
  - `commerce.service.ts` no longer imports mongoose or writes to the portal DB. `callMockPortal()` POSTs to `${MOCK_PORTAL_URL}/api/internal/access/{provision,revoke}` with `x-internal-api-secret`, a 10s timeout and `idempotencyKey: provision-<entitlementId>`. Failures leave `PROVISIONING_FAILED`, so the existing retry route still works.
  - `StudentIdentity.mockUserId` comes from the portal response (the portal now returns `mockUserId`).
  - `config.ts` gains `MOCK_PORTAL_URL` (optional URL); `.env.example` documents it and recommends a 32+ character shared secret.
  - Tests: `setup-env.ts` sets `MOCK_PORTAL_URL`; `security.test.ts` asserts the HTTP calls via the existing fetch spy; `e2e.test.ts` mocks fetch.
  - `npx jest` → 87 passed, 12 skipped (DB suites without `TEST_DATABASE_URL`, as before).
- **Database integrity:**
  - The `User.deletedAt` TTL is removed. Run `node scripts/migrations/2026-10-drop-user-ttl.js` (dry run) and then `--apply` once in production.
  - Deleting or purging a question used by a live test returns 409 `QUESTION_IN_LIVE_TEST`.
  - User purge requires the user to be in trash first. It anonymizes attempts, unlinks entitlements, deletes reminders, calendar data and sessions, and logs a `USER_PURGED` audit entry.
  - Duplicate-index warnings fixed.
- **Browser E2E** additionally checks that the paid test shows the buy screen and that a direct question fetch returns 403.

**Accepted / deferred:** slimming the attempt review. Each Attempt still embeds `questionReview` (question content at submit time). Slimming it needs copy-on-edit question snapshots. Since this copy *is* what preserves historical correctness, it is deferred to P2 and accepted as storage overhead.

**Owner actions:**
- Set `MOCK_PORTAL_URL` in AceIIIT.
- Use the same `INTERNAL_API_SECRET` (32+ characters) in both services.
- Optionally tag seasons with `resourceCode`; `PAID_MOCK_SERIES` maps to the active season by default.
- Run the TTL migration.
- `MONGODB_URI` is no longer needed in the AceIIIT api.

**Suggested commits:** `commerce: migrate to backend-native entitlements` (portal) and `commerce: provision mock portal over internal HTTP API` (AceIIIT)

### M4: QOTD, email and reminders, uploads, calendar (2026-10-07)
**Re-audit findings (all now FIXED):**
- QOTD was broken on both ends. The client called a nonexistent `store.getUser()`, so it never POSTed and kept the answer in localStorage as a "guest". The server read `req.auth.id`.
- The answer shipped in the payload, and the QOTD could be picked from paid or draft tests.
- **Reminder emails were SMTP-only and SMTP isn't configured, so they never sent.**
- **A successful calendar-invite email set `Reminder.sentAt`.** After any edit or resend, the real pre-exam reminder was therefore never sent.
- Email HTML was not escaped, ICS text was not escaped, and there was a base64-in-Mongo upload fallback.
- Calendar refresh tokens were stored in plaintext, disconnect didn't revoke at Google, and links used `CLIENT_ORIGIN` (default `localhost:10000`).

**Implemented:**
- **QOTD:**
  - Questions come from **live free** tests only, picked deterministically per IST day (`qotdDateKey`). The pick is persisted in the new `models/QotdPick.js`, so it stays stable across restarts, publishes and instances.
  - The payload has no answer or explanation.
  - `POST /api/tests/qotd-attempt {questionId, selectedOption}` uses `req.auth.userId`, an atomic one-per-day write, 409 `QOTD_STALE`/`QOTD_ALREADY_ATTEMPTED` (with the prior result), and 400 for a bad option. It returns `{correct, correctOption, explanation}` afterwards, and the catalog includes today's `qotd.attempt`.
  - `User.lastQotdAttempt` gains `questionId` and `correct`.
  - Frontend: the answer is never in the page before submitting, the explanation is shown afterwards, and KaTeX renders.
- **Email** (`utils/mailService.js` rewritten; new `utils/escape.js`):
  - Resend first, then Brevo, then SMTP (only if configured). Sender and SendPulse are removed.
  - Every dynamic value is `escapeHtml`'d, and links go through `safeUrl` (http/https only).
  - Attachments are supported on all providers.
  - Reminder and invite mail uses the same chain, and links use `PORTAL_BASE_URL`.
  - ICS output uses `escapeIcsText` and CRLF stripping, folds lines at 75 octets, and keeps UID `<id>@aceiiit.in`, UTC times and the SEQUENCE.
- **Reminders** (`services/reminderService.js` rewritten):
  - New fields: `deliveryState pending|sending|sent|failed|cancelled`, `attempts`, `nextAttemptAt`, `claimedAt`, `failedAt`, plus `inviteSentAt`/`inviteError` kept separate from delivery.
  - Each reminder is claimed atomically and handled in its own try/catch, with backoff 1m → 5m → 30m → 2h and failure after 5 attempts.
  - Stuck `sending` claims are released after 5 minutes, and legacy rows without `deliveryState` still send.
  - A reminder whose plan already started is marked failed rather than sending a wrong "starts in" email.
  - The controller resets delivery on update and sets `cancelled` on delete; resend touches only the invite.
- **Uploads** (new `services/imageUploadService.js`, used by both the upload route and admin question images):
  - Multer limit is 4MB with a MIME allow-list (png/jpeg/webp/gif), and the **real bytes are sniffed**.
  - No base64 fallback: a Cloudinary failure returns 502 `IMAGE_STORAGE_UNAVAILABLE`, and missing configuration returns 503.
- **Calendar:**
  - New `utils/crypto.js` encrypts refresh tokens with AES-256-GCM (`v1:iv:tag:ct`, key from `CALENDAR_TOKEN_KEY`); legacy plaintext is still readable.
  - Disconnect revokes the token at Google (`revokeRefreshToken`) before clearing it.
  - The redirect URI defaults to `${PORTAL_BASE_URL}/api/calendar/google/callback` and must be https in production.
  - Event links use `PORTAL_BASE_URL`.
  - Migration: `node scripts/migrations/2026-10-encrypt-calendar-tokens.js` (dry run), then `--apply`.

**Tests:** `npm test` → 168/168.
- `tests/features/qotd.test.js` (4): free/live only, no answer, persisted, one per day, invalid input, stable daily pick.
- `tests/features/email-reminders.test.js` (10): escaping, `javascript:` links, the ICS UID/SEQUENCE/escaping/fold/CRLF-injection checks, update and delete SEQUENCE++ without marking sent, failure isolation, the backoff schedule and max attempts, skips and legacy rows, expired plans.
- `tests/features/uploads-calendar.test.js` (8): valid PNG, >4MB, fake magic bytes, SVG, Cloudinary failure gives 502 with no data URI, students forbidden, crypto round trip and tamper detection, disconnect revokes and clears.
- Browser E2E adds: no answer in the DOM before answering, the result after a server submit, and the answered state persisting after reload.

**Owner actions:**
- Run the calendar token migration once `CALENDAR_TOKEN_KEY` is set.
- Email works with your existing Resend and Brevo keys; SMTP is now optional.
- Remove `PAID_SHEETS_*` from `.env` (no longer used).

**Suggested commit:** `security: harden qotd email uploads calendar`

### M5/M6: Authorization, validation, audit (2026-10-07)
**IDOR re-audit:**
- Every student route with an id already scoped to its owner: results and analysis use `ownedQuery`, exam sessions use `loadOwnedSession`, reminders filter by `userId`, tests go through the entitlement check.
- Admin routes all require `requireAdmin`.
- The cross-user matrix below now proves this.

**Implemented:**
- **`middleware/validate.js`:** `validate({params, query, body})` with Zod. Parsed values replace the raw input, and empty query values count as absent. `objectIdParam` is registered via `router.param("id")` on the admin, test, attempt and reminder routers, so a malformed `:id` gets 400 before any DB call.
- **Schemas added:**
  - admin users list (`role` enum, int paging, `search` capped at 64), payments list (`status` enum, `seasonId`), audit logs filters, leaderboard (`testId`, `excludeFlagged`)
  - trash `kind`/`id`, verify payment (`sendEmail`), create and duplicate season (including `resourceCode`), invalidate
  - calendar callback query, calendar auto-add body
  - Existing controller schemas are kept: auth, attempts and sessions, questions, tests, config, reminders, QOTD, practice, internal.
- **`utils/escapeRegex.js`** is used for the admin user and payment search. This closes regex injection and ReDoS, and blocks operator injection such as `role[$ne]=` (400).
- **Audit:**
  - `services/auditLogService.redact()` replaces any key matching password, secret, token, hash, apikey, authorization, cookie or refresh with `[REDACTED]`, at any depth.
  - New `middleware/audit.js` writes a log entry after successful (2xx) admin mutations only. It covers config, user delete, grant/revoke access, trash restore and purge, question create/update/delete, test create/update/delete/duplicate, attach/detach (including bulk), reorder and generate.
  - `USER_ROLE_CHANGED` is logged when `ADMIN_EMAILS` changes a role.
  - Already audited explicitly: payments, seasons, publish, invalidate, revoke-sessions, purge, takeover, internal provisioning.

**Tests:** `npm test` → 178/178. New `tests/security/authz-validation-audit.test.js` (10):
- Cross-user 404 for results, analysis, paper, answers, advance, events, abandon, takeover, submit, and reminder update/delete/resend; student lists stay isolated.
- Admin surfaces return 403 to students.
- Malformed ids → 400.
- Operator and regex injection, bad filters, season and calendar schema checks.
- Lifecycle audit entries; failed mutations not audited; redaction; role-change audit.

Browser E2E: the student flow passes, and a new **admin smoke test** (agent scratchpad `e2e/admin-e2e.js`) renders all 9 Admin Studio tabs with no page errors and confirms "Add payment, verify now" grants an entitlement.

**Suggested commit:** `security: complete idor validation and audit`

### M7: Gemini Performance Intelligence (2026-10-07)
**Model check** (ai.google.dev on 2026-10-07):
- Stable Flash-Lite models are `gemini-3.5-flash-lite` and `gemini-3.1-flash-lite`, both with a free Standard tier. The 2.0 and older 2.5 variants are shutting down.
- **The free tier states "Content used to improve our products: Yes".** Hence the strict no-PII payload and the disclosure; this must not be marketed as private.
- The default `GEMINI_MODEL` is `gemini-3.5-flash-lite` and is configurable.
- SDK: `@google/genai` 2.27 (`ai.models.generateContent` with `responseMimeType`, `responseJsonSchema`, `maxOutputTokens`, `abortSignal`; `ApiError.status`).

**Implemented:**
- **Deterministic layer** (authoritative):
  - `services/analyticsService.js`: overall, section, topic and difficulty buckets (accuracy, attempt rate, average and median time, marks gained/lost), plus timing relative to the student's own median.
  - `services/patternDetectionService.js`: `high_time_low_accuracy`, `fast_low_accuracy`, `accurate_but_slow`, `weak_topics`, `difficulty_sensitivity`, `easy_question_slips`, `low_coverage`, `time_sunk_into_wrong_answers`, `section_gap`, `improving`/`regressing`. Each carries its evidence and a minimum sample size; there are no psychological claims.
  - `services/performanceProfileService.js`: the change since the previous attempt, and a trajectory of the last 6 accuracies.
- **AI layer** (`services/aiInterpretationService.js`):
  - `buildAIInterpretationPayload` sends aggregate evidence only.
  - One Zod `InterpretationSchema` (`.strict()`, with caps) plus the matching `RESPONSE_JSON_SCHEMA` sent to Gemini.
  - The system instruction says: no numbers unless copied, no scores, ranks or percentiles, no psychology.
  - **Typed numeric validation:** `buildEvidenceNumberSet` (percentages, counts, durations, marks) and `findUnsupportedNumbers`. It checks only typed claims (`N%`, `N/M`, `N marks`, `N questions`, durations, `mm:ss`); rank and percentile claims are always rejected. It ignores numbers inside topic and section names, years, dates and list ordinals.
  - Pipeline: parse → Zod → number check → on failure, the deterministic fallback.
  - **Reliability:**
    - 20s `AbortController` timeout.
    - Retries only on network errors, timeouts, 5xx and per-minute 429, honouring a hinted `retryDelay`, at most 3 attempts. A 400 or other 4xx is never retried.
    - A daily-quota 429 opens a **circuit breaker** (provider `retryDelay`, else `AI_BREAKER_TTL_MS`, capped at `AI_BREAKER_MAX_MS`; no timezone assumption).
    - Jobs that hit the breaker are parked with `retryAfter` and get AI once it closes.
    - `AI_MIN_INTERVAL_MS` paces calls for free-tier rate limits.
  - **Async:** `services/domainEvents.js` carries `attempt.finalized`, emitted by `finalizeSession`, so exam code never imports AI. A listener enqueues one job per attempt (unique `attemptId`). `interpretationWorker` claims jobs atomically and recovers stuck ones. Submission never waits.
  - **Storage:** `models/AttemptInterpretation.js`, isolated from `Attempt`, holds `status`, `provider`, `model` (with prompt version), `payloadVersion`/`payloadHash`, `result`, `deterministic`, `fallbackReason`, `attemptCount`, `retryAfter` and `expiresAt` (365-day TTL).
  - If AI is disabled or not configured, jobs resolve to the deterministic result immediately.
- **API:** `controllers/aiController.js` is the only AI consumer.
  - `GET /api/analysis/:id/interpretation` (owner or admin) returns `{status, source, result, deterministic, pending, profile, disclosure}`.
  - `GET /api/admin/ai-status` returns enabled, configured, model and breaker state, never the key.
- **UI:** a "Performance Intelligence" card on the results page.
  - Sections: What Changed? · The Pattern · Your Edge · Where Marks Leak · Your Error Fingerprint · Your Next Move · Your Trajectory.
  - Labelled "AI interpretation" or "Rule-based interpretation", with a note that the score, accuracy, rank and percentile above are verified.
  - Polls while pending and shows the disclosure text.
- **Bugs fixed:**
  - The exam-integrity notice stayed on screen after the exam ended; it is now removed in `stopRuntime`.
  - KaTeX was bumped from 0.16.9 to 0.19.0 (3 moderate advisories); production audit is back to 0.

**Tests:** `npm test` → 210/210. New `tests/ai/performance-intelligence.test.js` (32), with Gemini mocked:
- One job per attempt; valid output stored and served; cache hit makes 0 extra calls; submission doesn't wait; disabled gives the fallback; owner-only.
- Fallbacks for invalid JSON, wrong schema, extra fields, an invented % and an invented rank.
- A timeout is retried 3 times and then falls back; a 400 is not retried; a 500 and a per-minute 429 recover; the daily-quota breaker parks jobs and they retry after it closes.
- A privacy snapshot of the payload (no email, name, ids, question text or options), and the prompt equals the payload.
- The Attempt document is unchanged; the API key never appears in responses, logs or stored docs.
- Typed-number validator: 8 accepted cases and 6 rejected cases.
- A **dependency-isolation scan** confirms no integrity, entitlement, rank or payment module imports the AI layer.

The browser E2E checks that the card renders with the verified-vs-interpretation labelling and the disclosure.

**Owner actions:**
- To enable AI, set `AI_INTERPRETATION_ENABLED=true`, `GEMINI_API_KEY` (server only) and, optionally, `GEMINI_MODEL`.
- With AI off, everything works on the deterministic interpretation.

**Suggested commits:** `ai: add deterministic performance intelligence` and `ai: integrate Gemini interpretation`

### M8: Ops, frontend, CI, load, docs, legal (2026-10-07)
**Implemented:**
- **Observability:** pino request ids, `/ready`, optional Sentry, graceful shutdown. Server logging goes through pino via `errorSummary()` (Google errors carry auth headers). `no-console` is enforced in server code.
- **Account rights:** `GET /api/account/export` and `DELETE /api/account`, plus the Account page UI. Bug fixed: the export always reported `password: false`.
- **Legal:** `public/privacy.html` and `public/terms.html` (drafts; owner legal review needed). Footer links to Privacy, Terms and Support.
- **Loader:**
  - The dead WebGL "orb" code was removed. It was never called, and it loaded `ogl` from a CDN.
  - Reduced-motion users get a static mark, because the SMIL animation can't be paused by CSS.
  - The overlay is cleared on the error screen.
- **Responsive audit** (`tests/e2e/responsive.e2e.js`, 9 routes × 8 widths): overflow went from 19 route/width cases to 0. Fixes:
  - Studio tabs and question rows clipped (rows were also clipped at 768px).
  - Results stats strip was 780px wide.
  - Dashboard grid had min-content floors.
  - Instructions double-scrolled, and the chat button covered the consent checkbox.
  - Studio topbar overflowed.
- **Admin question bank:** new paginated `GET /api/admin/questions`; the snapshot now carries only attached questions plus `questionBankTotal`.
  - The Bank tab, the drawer and the modal use the server. Before this, the Bank tab rendered every question and ignored its filters, and the drawer filters had no handlers at all.
  - The backup export pages through the whole bank.
- **Lint and format:** ESLint 9 flat config and a Prettier config; `npm run lint` gives 0 errors. A mass reformat was deliberately not run; do it as its own commit. Lint found real bugs, now fixed:
  - `openImageLightbox` and `showSaveChip` were undefined (ReferenceErrors).
  - Duplicate store key.
  - Unreachable legacy code.
- **Security fixes found during M8:**
  - `safeImageUrl` let `"` break out of `src` attributes; quotes and angle brackets are now percent-encoded.
  - Login timing oracle for unknown accounts; a dummy bcrypt compare equalizes it.
  - `npm run seed` deleted ALL questions and tests; it now refuses on a non-empty DB or in production.
  - Harnesses loaded `backend/.env`; `ACEIIIT_SKIP_DOTENV=1` now prevents that. Earlier scratchpad admin E2E runs may have attempted one real payment email to buyer@test.local.
- **Performance:** `bcryptjs` was replaced by native `bcrypt` (`utils/password.js`, with bcryptjs fallback; hashes are compatible). Full flow p95 at 150 students went from 54 s to 26 s, and autosave p95 from 2.7 s to 0.42 s.
- **Indexes:** production runs with `autoIndex` off, so the new unique indexes (single active session, idempotency and others) would never have been created. Added:
  - `scripts/migrations/2026-10-sync-indexes.js`: create-only; dry run by default.
  - `services/indexCheck.js` with a boot warning.
- **Tests:**
  - New Jest suites: `account/account-data`, `admin/question-bank`, `security/password`, `ops/indexes`.
  - E2E moved into the repo, `npm run test:e2e`: production, exam, admin and responsive suites. The production suite is a NODE_ENV=production smoke with 36 checks.
  - Load harness `scripts/load-test.js`; results are in TESTING.md.
- **CI:** `.github/workflows/ci.yml` runs lint, test and `npm audit --omit=dev --audit-level=high`, then the E2E job.
- **Removed:**
  - `check_braces.js`, `backend/test_qotd.js`, `backend/verify_ics.js`, `scripts/verify-auth-matrix.js`.
  - `scripts/test-login-load.js`: it wrote to MONGODB_URI; replaced by `backend/scripts/load-test.js`.
  - Left in place: `$null` (needs approval) and `backend/scripts/test_calendar_sync.js` (not on the approved list).
- **Docs:** README was rewritten. New: ARCHITECTURE, TESTING. Rewritten: DEPLOYMENT, SECURITY. `.env.example` is complete. PRODUCTION_HARDENING has a status note.

**Results:** `npm test` passes 232/232 (22 suites). Lint: 0 errors, 18 warnings (unused frontend locals). All 4 E2E suites pass. Production dependency audit: 0 vulnerabilities.

**Known cosmetic issue:** one malformed traced SVG path (app.js ~4239) logs console errors. The source image isn't available, so it was left as is.

**Follow-up (done in the final pass):** final report written (below); `production.e2e.js` added to TESTING.md; added `tests/features/email-providers.test.js` (Resend → Brevo → SMTP fallback and the all-fail 503; this checklist item had no test); full re-run is green.

**Owner actions:** see the DEPLOYMENT.md checklist. In order: migrations (sync-indexes, drop-user-ttl, encrypt-calendar-tokens), new env vars, `UV_THREADPOOL_SIZE`, backups and restore drill, staging, legal review.

**Suggested commits:** `ops: add observability and CI`, `test: add production verification matrix`, `docs: document production deployment`, then a separate `style: prettier format`.

## Final report (2026-10-07)

### Executive summary
All milestones M0–M8 are implemented in the working tree. Nothing is committed: per D7, the owner commits.

**Final verification run:**

| Check | Result |
|---|---|
| `npm run lint` | 0 errors (18 warnings, all unused locals in the frontend) |
| `npm test` | 236/236 tests in 23 suites |
| `npm run test:e2e` | 4 suites pass: production-mode smoke 36/36, student exam flow, Admin Studio, and the responsive audit (0 issues) |
| `npm audit --omit=dev` | 0 vulnerabilities |

**What this covers:** everything in the codebase that `PRODUCTION_HARDENING.md` requires is implemented and verified locally.

**What is not verified:** the remaining items need the production environment:
- backups and a restore drill
- a staging environment
- real OAuth, email and Gemini credentials
- CI on GitHub
- legal review

**Status: ready for staging, not yet production-ready.** It becomes production-ready once the owner checklist below is done.

### Implemented changes (by milestone; details in each report above)
- **M0:** app/server split; Jest, supertest and memory-server; characterization tests; production audit 8 → 0.
- **M1:**
  - OAuth verified against JWKS, failing closed.
  - Zod env validation at boot.
  - Only `backend/public` is served.
  - Cookie-only sessions with `tokenVersion` revocation, and CSRF on every method.
  - Lockout and enumeration safety; the OTP flow is removed.
- **M2:**
  - Server-authoritative exam sessions with deadlines, autosave and the SUPR lock.
  - Idempotent submit; a sweeper finalizes abandoned exams.
  - Rank and percentile computed on read; server-side practice mode.
- **M2b:**
  - Rich-text and KaTeX formatting fixes.
  - Session binding: resume, 409 and takeover.
  - Seeded option shuffling.
  - Integrity telemetry with record/warn/strict modes and no auto-invalidation; admin review and invalidation.
- **M3:**
  - Entitlement is the only access authority; Sheets removed.
  - Authenticated, idempotent internal provisioning; the AceIIIT commerce repo now calls it over HTTP.
  - Catalog sends metadata only; data-integrity fixes.
- **M4:**
  - QOTD rebuilt on the server; email HTML and ICS escaping.
  - Provider chain Resend → Brevo → SMTP; reminder state machine.
  - Upload hardening; calendar tokens encrypted and revoked on disconnect.
- **M5/M6:** IDOR matrix, Zod validation everywhere, audit coverage with redaction.
- **M7:**
  - Deterministic analytics first.
  - Gemini interpretation: async, schema-validated, typed-number guarded, with circuit breaker, privacy-safe payload and dependency-isolation test.
- **M8:**
  - Observability; account data rights; legal pages.
  - Responsive and loader fixes; paginated admin question bank.
  - ESLint, Prettier and CI.
  - Browser E2E and the load harness in the repo.
  - Native bcrypt; index migration and boot check; seed guard.
  - Documentation.

### Tests executed
- **Jest:** 23 suites, 236 tests (list in TESTING.md).
- **Browser E2E:**
  - production smoke: 36 checks
  - student flow: 24 checks
  - admin flow: 19 checks
  - responsive: 9 routes × 8 widths
- **Load test** at 20 / 40 / 60 / 80 / 100 / 150 concurrent students: all flows completed with 0 errors (TESTING.md).
- **AceIIIT** (M3): 87 passed and 12 skipped (DB suites without `TEST_DATABASE_URL`).

### Verification matrix: PRODUCTION_HARDENING §30
| Area | Verification | Required | Result | Evidence |
|---|---|---|---|---|
| Google auth | mock token | 401 | PASS | `security/oauth`; production smoke |
| Apple auth | forged token | 401 | PASS | `security/oauth` (forged, mock and unverified email) |
| OAuth | wrong audience | 401 | PASS | `security/oauth` |
| Environment | missing required secret | boot failure | PASS | `security/env`; production smoke (4 cases) |
| Static | `/backend/server.js`, `/backend/.env` | 404 | PASS | `security/static`; production smoke (8 paths) |
| Internal API | wrong secret / bad body | 401 / 400 | PASS | `payments/entitlements` |
| Internal API | valid request / replay | entitlement / no duplicate | PASS | `payments/entitlements` |
| QOTD | answer before submit / paid or draft question | impossible | PASS | `features/qotd`; exam E2E |
| Exam | late submit / duplicate submit | rejected / same attempt | PASS | `integrity/exam-session` |
| Exam | invalid option / wrong test's question | 400 | PASS | `integrity/exam-session` ("invalid option, unknown question…"). Sessions are bound to their test |
| Access | none / correct / revoked / wrong season | 402 / allowed / 402 / 402 | PASS | `payments/entitlements` (also covers expired and admin) |
| IDOR | another user's attempt / reminder | denied | PASS | `security/authz-validation-audit` (13-endpoint matrix) |
| IDOR | another user's calendar | denied | PASS (by design) | Calendar routes take no id and always act on the session user |
| AI | malformed / invented number / timeout | fallback | PASS | `ai/performance-intelligence` |
| AI | duplicate attempt | one analysis | PASS | `ai/performance-intelligence` |
| AI | PII in payload | test failure | PASS | `ai/performance-intelligence` (payload snapshot test) |
| Security | API key in logs | impossible | PASS | `ai/performance-intelligence`, `ops/observability` (redaction) |

### §29 production-readiness checklist
| Section | Result |
|---|---|
| Security | All PASS: mock auth impossible, OAuth claims verified, secret required and timing-safe, source and `.env` inaccessible, cookie-only, revocation, CSRF, lockout, enumeration (including timing), IDOR |
| Exam | All PASS |
| Commerce | All PASS. The real AceIIIT → portal path on staging is NOT VERIFIED; it is unit and E2E tested with mocked HTTP |
| QOTD | All PASS |
| Email | All PASS. Delivery through real providers is NOT VERIFIED |
| Calendar | All PASS. A real Google round trip is NOT VERIFIED |
| AI | All PASS with Gemini mocked. A real Gemini call and the current model ID are NOT VERIFIED (owner to check before enabling) |
| Operations | PASS: request IDs, redaction, health, readiness, graceful shutdown, lint, tests, audit |
| Operations, partial | Sentry is PARTIAL: implemented and scrubbed, but no DSN or account has been verified. CI is PARTIAL: the workflow exists and the same commands pass locally, but it has not run on GitHub |
| Operations, not verified | Backup procedure, restore procedure and staging environment are NOT VERIFIED; they are owner actions documented in DEPLOYMENT.md |

### Final acceptance criteria
| # | Criterion | Result |
|---|---|---|
| 1 | All P0 findings fixed and tested | PASS |
| 2 | Every access path uses Entitlement | PASS |
| 3 | Production auth can't use mocks | PASS |
| 4 | Backend source not public | PASS |
| 5 | Server-authoritative deadlines | PASS |
| 6 | Idempotent duplicate submit | PASS |
| 7 | QOTD can't leak answers | PASS |
| 8 | IDOR matrix passes | PASS |
| 9 | Internal provisioning authenticated and idempotent | PASS |
| 10 | AI asynchronous and optional | PASS |
| 11 | Gemini key server-only | PASS |
| 12 | No PII or question text in the AI payload | PASS |
| 13 | AI output schema-validated | PASS |
| 14 | AI can't alter Attempt | PASS |
| 15 | Deterministic analytics work without Gemini | PASS |
| 16 | CI passes | PARTIAL: local equivalent passes; first GitHub run pending |
| 17 | Dependency audit resolved or documented | PASS: production 0; dev-only `sprintf-js` moderate is an accepted risk |
| 18 | Load tests recorded | PASS (local). Capacity on production hardware is NOT VERIFIED |
| 19 | Backup and restore tested | NOT VERIFIED (owner) |
| 20 | Deployment checklist complete | OPEN (owner checklist in DEPLOYMENT.md) |

### Remaining risks
Full table in `SECURITY.md`.

| Risk | Status |
|---|---|
| Single instance: limits, queue and caches are in-memory | ACCEPTED; Redis is P2 |
| Browser telemetry can be spoofed | ACCEPTED; enforcement is server-side |
| Login bursts are bcrypt-bound on small hosts | PARTIAL |
| `'unsafe-inline'` in the CSP | OPEN; P2 |
| Purge of the 30-day trash drops test titles from old results | ACCEPTED |
| Legal pages are drafts | OPEN |
| Malformed decorative SVG path logs console errors | Cosmetic |
| 18 lint warnings for unused frontend locals | Cosmetic |
| Earlier scratchpad admin E2E runs loaded `backend/.env` | May have attempted one payment email to buyer@test.local; harnesses now set `ACEIIIT_SKIP_DOTENV` |

### Changed files
- **Working tree:** 53 modified, 34 deleted and 48 untracked paths. See `git status`.
- **Moved:** the `assets/`, `css/`, `js/` and `index.html` deletions are moves into `backend/public/` (M1).
- **AceIIIT repo:** `api/src/services/commerce.service.ts`, `src/config.ts`, `.env.example` and its tests, as working-tree edits.

### Migration requirements
Run these in order, after a backup. Each is a dry run first, then `--apply`; see DEPLOYMENT.md.
0. `2026-10-renumber-duplicate-attempts.js`. Added after a read-only check of the live DB found 40 duplicate (student, test, attempt number) groups. They are all in 1 student/test group, and 132 attempts get renumbered. Without this, the unique attempt-number index can't build.
1. `2026-10-sync-indexes.js`. Required: without it, the single-session, idempotency, interpretation and QOTD unique indexes don't exist in production. The live-DB dry run showed 22 indexes to create, 6 of them unique.
2. `2026-10-drop-user-ttl.js`
3. `2026-10-encrypt-calendar-tokens.js`

**New environment variables:** `PORTAL_BASE_URL`, `INTERNAL_API_SECRET` (shared with AceIIIT), `CALENDAR_TOKEN_KEY`, a 32+ character `JWT_SECRET`, `UV_THREADPOOL_SIZE`, and optionally `SENTRY_DSN` and the `GEMINI_*` variables.

**AceIIIT environment:** `MOCK_PORTAL_URL` and the shared secret. Remove the portal `MONGODB_URI` from it.

**User impact:** everyone is signed out once.

### Deployment checklist, rollback plan, unverifiable items
- The full deployment checklist, smoke checks and rollback plan are in `DEPLOYMENT.md`.
- **Rollback:** redeploy the previous build. The migrations are additive or safe to leave in place. Restore from the pre-release snapshot if data is damaged. Commerce retries `PROVISIONING_FAILED` on its own.
- **Unverifiable from the dev machine (owner checklist):**
  - Atlas backup and restore drill
  - staging environment
  - real Google/Apple OAuth clients and the Calendar redirect
  - email sender verification and real delivery
  - Gemini key and current model
  - Sentry project
  - GitHub CI first run
  - a load test on production-sized hardware
  - legal review of the privacy and terms pages


## Production rollout log
**Date:** 2026-10-07

**Deploy:**
- Render service `aceiiit-mock-portal` (https://mock.aceiiit.in) is running the hardened build. `/health` returns 200; `/ready` reports ready, with the DB connected, all 3 jobs running, and queue max 300.
- Env set from `backend/.env.production.local`. `JWT_SECRET`, `CALENDAR_TOKEN_KEY` and `INTERNAL_API_SECRET` were regenerated. The old `INTERNAL_API_SECRET` was a patterned placeholder, and the old values were exposed in a screen recording.
- `INTERNAL_API_SECRET` is synced into AceIIIT `api/.env`. The AceIIIT production env must be updated by the owner.

**Migrations applied to production:**

| Migration | Result |
|---|---|
| `renumber-duplicate-attempts` | 132 attempts in 1 group renumbered |
| `sync-indexes` | 22 indexes created (6 unique), 0 failures. A re-run reports "All schema indexes exist" |
| `encrypt-calendar-tokens` | 1 of 1 encrypted; a re-run shows 0 left |
| `drop-user-ttl` | Nothing to do |

Two legacy indexes remain for review, not dropped:
- `tests.status_1_deletedAt_1_createdAt_1`
- `users.deletedAt_1`

**Still open (owner):**
- Google OAuth client `…l3d4jr`: add the JavaScript origin `https://mock.aceiiit.in` and the redirect URI `/api/calendar/google/callback`. Until then, Google sign-in fails with `origin_mismatch`.
- AceIIIT production env: set `INTERNAL_API_SECRET` (the new value) and `MOCK_PORTAL_URL`.
- Rotate the credentials exposed in the screen recording: Google client secret, Resend key, MongoDB user password, Cloudinary secret, Brevo key.
- Push the `engines: 22.x` change, or set `NODE_VERSION=22` on Render.
- Run an Atlas restore drill.
- Legal review of the privacy and terms pages.
