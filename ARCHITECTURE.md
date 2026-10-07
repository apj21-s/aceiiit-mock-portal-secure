# Architecture

## Components

```text
                 ┌─────────────────────────── one Node 22 process ───────────────────────────┐
 Browser (SPA) ──┤ Express: helmet/CSP · compression · cookies · pino-http (request id)     │
 backend/public  │   /health /ready                                                          │
                 │   /api  → CSRF check → DB-ready check → routers                           │
                 │   static: backend/public only (SPA fallback for extension-less GETs)      │
                 │                                                                           │
                 │ Background jobs: attemptSweeper · reminderService · interpretationWorker  │
                 └───────────┬───────────────────────────┬───────────────────────────┬───────┘
                             │                           │                           │
                        MongoDB (Atlas)        Resend → Brevo → SMTP        Google APIs: OAuth,
                                               Cloudinary (images)          Calendar, Gemini (optional)

 AceIIIT commerce backend ── HTTPS + x-internal-api-secret ──▶ /api/internal/access/{provision,revoke}
```

- **`backend/app.js`** builds the Express app (no listeners or jobs), so tests import it
  directly. **`backend/server.js`** validates env (`config/env.js`), connects to MongoDB,
  starts jobs, and handles graceful shutdown (SIGTERM/SIGINT; exit on `uncaughtException`).
- **Frontend**: one IIFE (`public/js/app.js`) renders views as escaped HTML strings;
  `public/js/storage.js` is the API client (cookie session, CSRF header, exam-session
  mirror); `public/js/examIntegrity.js` collects exam telemetry.

## Request pipeline

1. `helmet` with a CSP allowing only self, Google/Apple sign-in, jsdelivr and fonts.
2. `pino-http` assigns a request id (`X-Request-Id`, sanitized) and logs with redaction.
3. `requireCsrf`: every POST/PUT/PATCH/DELETE under `/api` must send `X-CSRF-Token`
   equal to the `aceiiit_csrf` cookie (constant-time compare). The only exemptions are
   `/api/internal/*` (shared secret) and the Calendar OAuth callback (`state` check).
4. `requireAuth` verifies the session JWT `{userId, tv}` **and reloads the user** on every
   request: deleted, disabled, or `tokenVersion` mismatch → 401. Role and paid state come
   from the database, never from the token.
5. Zod validation (`middleware/validate.js`) replaces `params`/`query`/`body` with parsed
   values; every `:id` must be an ObjectId.
6. Errors go to `middleware/error.js`: 4xx carry a message and `code`; 5xx are logged,
   reported to Sentry (if configured) and return a request id, never a stack.

## Authorization model

| Decision | Authority |
|---|---|
| Who you are | Session cookie + `User.tokenVersion` (bumped on password change/reset, role change, disable/delete, "log out everywhere", admin revoke) |
| Admin | `User.role`, synced from `ADMIN_EMAILS` at login (role changes are audited) |
| Access to a test | `test.isFree` OR admin OR an active, unexpired `Entitlement` for the test's season (`services/entitlementService.js`). `User.isPaid` is a display cache only. |
| Your attempts, results, reminders, sessions | Owner check on every `:id` (cross-user access → 404) |

Paid access is created only by `PaymentRecord` → `Entitlement` transitions: the commerce
backend's internal provisioning call, or an admin adding/verifying a payment. Every
transition is audited.

## Data model (main collections)

| Model | Purpose |
|---|---|
| `User` | Account, role, `tokenVersion`, login lockout counters, soft delete |
| `Season` | Exam season (`draft`/`active`/`archived`), optional commerce `resourceCode` |
| `Test`, `Question` | Paper definition; soft delete (trash, purged after 30 days); questions in a live test can't be deleted |
| `AttemptSession` | A running exam: server deadlines, saved answers, exam-token hash, integrity counters. Partial unique index: one active session per user and test |
| `Attempt` | A finished attempt: score, per-question review snapshot, timing, `submittedReason`, invalidation fields. No stored rank |
| `IntegrityEvent` | Exam telemetry (tab hidden, fullscreen exit, copy/paste, second tab, takeover …) |
| `IdempotencyRecord` | Replayable responses keyed by `userId + operation + key` (24 h TTL) |
| `Entitlement`, `PaymentRecord` | Paid access per season and its payment history |
| `Reminder`, `GoogleCalendarConnection/Event` | Planner, delivery state machine, encrypted calendar refresh tokens |
| `QotdPick` | The persisted Question of the Day per date |
| `AttemptInterpretation` | AI/deterministic interpretation per attempt (isolated; 365-day TTL) |
| `AuditLog` | Append-only record of security-relevant actions (secrets redacted) |

Production runs with Mongo `autoIndex` off; indexes are created by
`scripts/migrations/2026-10-sync-indexes.js` and checked at boot (`services/indexCheck.js`).

## Exam lifecycle

```text
start ──▶ paper ──▶ autosave (PUT answers, increasing seq) ──▶ advance (SUPR locks) ──▶ submit
  │                        ▲                                                         │
  │      reload: resume ───┘                                                         ▼
  └─ 409 EXAM_ACTIVE_ELSEWHERE ─▶ takeover (rotates token)              Attempt (scored once)
                                                    sweeper: deadline + 60 s ──▶ finalize saved answers
```

- **Start** (`POST /api/attempt/start`): no active session → create one with server
  deadlines and a random exam token (only its hash is stored; the browser keeps it in
  `sessionStorage`) → 201. Matching token → resume (200). No valid binding → 409
  `EXAM_ACTIVE_ELSEWHERE`.
- **Takeover**: an explicit action by the same user rotates the token (the old one stops
  working), keeps deadlines and answers, and is audited and recorded as an integrity event.
- **Timing** is server-only. SUPR answers are rejected after the SUPR lock or deadline;
  everything is rejected after the final deadline + 60 s grace. Duration =
  `min(submittedAt, deadline) − startedAt`.
- **Submit** is idempotent (`Idempotency-Key`) and the active→submitted transition is
  atomic. Options can be shuffled per session (seeded); answers are mapped back before scoring.
- **Abandoned exams**: `attemptSweeper` finalizes sessions past deadline + grace from their
  last saved answers (`submittedReason: deadline_expired`). Nothing depends on the browser.
- **Integrity policy** (`Test.integrity`): `record` (log only), `warn` (default: warning
  with a count) or `strict` (auto-submit saved answers once the *server* count passes
  `autoSubmitThreshold`). Nothing is ever auto-invalidated; invalidation is an audited
  admin action that removes the attempt from ranks.
- **Ranks** are computed on read with count queries (ties: server duration, then submit
  time), cached 15 s per test and invalidated on submit. Practice and invalidated attempts
  are excluded.

## Performance Intelligence (optional AI)

```text
Attempt finalized ──event──▶ enqueue job ──worker──▶ deterministic analytics ──▶ Gemini (JSON schema)
                                                        (always available)          │
                                    UI ◀── stored interpretation ◀── Zod ◀── typed-number check
                                                                     └─ any failure → deterministic fallback
```

- `analyticsService` / `patternDetectionService` / `performanceProfileService` compute
  the authoritative metrics. Gemini only phrases an interpretation of aggregate evidence
  (no name, email, ids or question text), via `services/aiInterpretationService.js`.
- Submit never waits for AI. One interpretation per attempt; a circuit breaker handles
  quota exhaustion; timeouts and retries only for network/429/5xx.
- **Rule:** AI output is display-only text. It is never used for authorization, ranking,
  scoring, test eligibility, payment state or exam-integrity enforcement. A test scans
  those modules to make sure they don't import the AI modules.

## Background jobs

| Job | Interval | Notes |
|---|---|---|
| `attemptSweeper` | 30 s | Atomic claim; idempotent finalize shared with submit |
| `reminderService` | 60 s | Per-reminder atomic claim; backoff 1 m → 5 m → 30 m → 2 h; failed after 5 attempts |
| `interpretationWorker` | 5 s | Atomic job claim; respects the AI breaker and minimum call interval |

Each job records `lastRunAt`; `/ready` reports their age with the DB state, the submission
queue and the AI breaker.

## Invariants

1. Authentication, exam state and timing are server-authoritative.
2. Access comes from `Entitlement`, checked against the database on every request.
3. Ranking is computed on the server, on read.
4. Payments are backend-native (no spreadsheets).
5. AI only interprets and never blocks or decides anything.
6. The audit log is append-only and redacted.
7. Secrets stay on the server; the browser never holds a bearer token.
