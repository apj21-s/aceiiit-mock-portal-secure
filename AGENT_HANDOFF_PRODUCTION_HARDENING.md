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
| D7 | **Git:** the agent never commits or pushes. Stop after each milestone and hand over the changed files and a suggested commit message. | Owner |
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
| M1 Auth/sessions/CSRF/static | ☐ | ☐ | |
| M2 Exam integrity | ☐ | ☐ | |
| M2b Exam flow/formatting/integrity telemetry | ☐ | ☐ | |
| M3 Commerce/entitlements (+ AceIIIT) | ☐ | ☐ | |
| M4 QOTD/email/uploads/calendar | ☐ | ☐ | Q1 answered? |
| M5/M6 IDOR/validation/audit | ☐ | ☐ | |
| M7 Gemini Performance Intelligence | ☐ | ☐ | Model re-checked? |
| M8 Ops/frontend/CI/load/docs/legal | ☐ | ☐ | |
| Final verification and report | ☐ | ☐ | |

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
