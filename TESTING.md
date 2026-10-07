# Testing

All commands run from `backend/`. Nothing here touches the database in `MONGODB_URI`:
tests and harnesses start their own in-memory MongoDB (`mongodb-memory-server`, data under
`node_modules/.cache/`), and the browser/load harnesses start throwaway servers with
`ACEIIIT_SKIP_DOTENV=1`, so `backend/.env` (which may hold production credentials) is never
loaded.

| Command | What it runs |
|---|---|
| `npm run lint` | ESLint flat config (`eslint.config.js`): correctness rules; `no-console` in server code |
| `npm test` | Jest, 24 suites / 237 tests (unit + HTTP integration via supertest) |
| `npm run test:e2e` | Puppeteer: student exam flow, Admin Studio, responsive audit |
| `npm run load-test` | Concurrent students through the full HTTP flow (20 → 150) |
| `npm audit --omit=dev` | Production dependency advisories (CI fails on high/critical) |

The first test run downloads a MongoDB binary (needs network once).

## Jest suites (`backend/tests`)

| Area | Files | Covers |
|---|---|---|
| Characterization | `characterization/core`, `known-issues` | Baseline login → catalog → access → submit → result behaviour |
| Security | `security/env`, `static`, `oauth`, `session`, `csrf`, `abuse`, `password`, `authz-validation-audit` | Boot env validation; only `public/` served; OAuth audience/issuer/expiry with a local JWKS; immediate session revocation; CSRF on POST/PUT/PATCH/DELETE (missing, mismatched, cookie-less); lockout and enumeration safety (including login timing); cross-user IDOR matrix; input validation and operator/regex injection; audit coverage and redaction |
| Exam integrity | `integrity/exam-session`, `integrity-telemetry` | Server deadlines and clock skew; SUPR lock; one active session (index-enforced), resume/409/takeover; abandoned-session finalize; idempotent submit; scoring and negative marking; ranks on read and tie-breaks; practice; shuffling maps back; telemetry rate limits and server-owned counts; strict auto-submit only past the server threshold; no auto-invalidation |
| Payments | `payments/entitlements`, `data-integrity` | Free / no entitlement / right season / wrong season / revoked / expired / admin; internal provisioning (secret, schema, 422 unmapped, idempotent replay, revoke); catalog leaks no questions; live-question delete → 409; purge cascade |
| Features | `features/qotd`, `email-reminders`, `email-providers`, `uploads-calendar` | QOTD (no answer leak, free/live only, once per day); HTML/ICS escaping, RFC 5545 UID/SEQUENCE/CANCEL; reminder isolation and backoff; Resend → Brevo → SMTP fallback with a controlled 503; uploads (4 MB, magic bytes, no base64 fallback); calendar token encryption and revoke |
| AI | `ai/performance-intelligence` | Deterministic analytics; payload has no PII; schema and typed-number validation; timeout/retry/breaker behaviour; one job per attempt; cache hits make no calls; Attempt never modified; API key never logged; dependency scan for the AI rule |
| Account / admin | `account/account-data`, `admin/question-bank` | Data export contents (no secrets); deletion (confirmation, password re-check, CSRF, sessions revoked, admins refused); paginated question bank and slim snapshot |
| Ops | `ops/observability`, `ops/indexes`, `ops/renumber-attempts` | Request ids, `/health`, `/ready`, error responses without stacks; missing-index detection and recreation; duplicate attempt-number renumbering migration |

## Browser E2E (`backend/tests/e2e`)

Pages are hermetic: requests to anything other than the local test server (Google sign-in script, fonts, CDNs) are blocked, so runs don't hang on the network or DNS; that is why the browser console logs `ERR_FAILED` lines. The screenshot harness (`ui-shots.e2e.js`) still loads Google Fonts. On a machine with little free RAM, run the suites one at a time (`node tests/e2e/<suite>.e2e.js`), because each one starts Chrome, MongoDB and a server.

Uses `puppeteer-core` with a locally installed Chrome (`CHROME_PATH`, default
`/usr/bin/google-chrome`). Screenshots go to `node_modules/.cache/e2e-shots/`
(`SHOTS=1` for the exam suite).

- **`production.e2e.js`** (36 checks): the real `server.js` with `NODE_ENV=production`.
  - Boot is refused for weak config: a short JWT secret, an http base URL, dev auth
    enabled, or no email provider.
  - Security headers are present: CSP, HSTS and nosniff, with no `X-Powered-By`.
  - Nothing outside `public/` is served (`.env`, source and `node_modules` all return 404).
  - CSRF is required, and the session cookie is `HttpOnly; Secure; SameSite=Lax`.
  - Mock Google logins, bearer tokens, and internal API calls without the secret are rejected.
  - SIGTERM exits gracefully.
  - The index migration works as a dry run, applies, and is idempotent; the boot warning
    disappears afterwards.
- **`exam.e2e.js`** (24 checks): no token in `localStorage`, httpOnly cookie; QOTD answer
  hidden until submit and persisted; paid test locked without an entitlement; server
  timer; A–D options and number keys; watermark; copy attempt recorded; autosave and
  reload recovery; second tab → 409 → takeover (old token revoked); REAP advance; server
  score and rank; Performance Intelligence card with disclosure.
- **`admin.e2e.js`** (19 checks): all nine Studio tabs render without errors; question bank
  pagination, server search with focus kept, drawer excludes attached questions and
  attaches; integrity settings; Add Payment grants an entitlement.
- **`responsive.e2e.js`**: dashboard, exams, progress, account, instructions, exam,
  results, login and Admin Studio at 320, 360, 390, 430, 768, 1024, 1280 and 1440 px.
  It fails on horizontal page overflow (it reports the elements causing it) or on
  nested scrollers that double-scroll. The current result is 0 issues.

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
