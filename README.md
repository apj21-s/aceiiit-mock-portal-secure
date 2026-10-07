# ACEIIIT Mock Portal

A UGEE mock-test platform: timed SUPR/REAP exams with server-authoritative timing and
scoring, results with rank and percentile, a practice mode, Question of the Day, a study
planner with email/Google Calendar reminders, and an Admin Studio for building tests.
Paid access is provisioned by the AceIIIT commerce backend.

One Node service serves both the API and the single-page frontend.

| | |
|---|---|
| Backend | Node 22, Express 4, MongoDB (Mongoose 8), Zod |
| Frontend | Vanilla-JS SPA in `backend/public/` (KaTeX served locally) |
| Auth | Password, Google, Apple; httpOnly session cookie + CSRF token |
| Email | Resend, falling back to Brevo, then optional SMTP |
| AI (optional) | Google Gemini interprets structured performance evidence; off by default |

## Documentation

| Document | What it covers |
|---|---|
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | Components, request flow, data model, exam lifecycle, invariants |
| [`SECURITY.md`](SECURITY.md) | Threat model, controls, exam-integrity limits, AI rule, dependency audit, residual risks |
| [`DEPLOYMENT.md`](DEPLOYMENT.md) | Environment variables, first deploy, migrations, backups, rollback, owner checklist |
| [`TESTING.md`](TESTING.md) | Unit/integration tests, browser E2E, load test and results |
| [`AGENT_HANDOFF_PRODUCTION_HARDENING.md`](AGENT_HANDOFF_PRODUCTION_HARDENING.md) | Hardening plan, decision log and per-milestone reports |

## Local development

```bash
cd backend
npm install
cp .env.example .env        # then fill in values; see DEPLOYMENT.md for each variable
npm run seed                # optional: sample data (empty dev database only)
npm start                   # http://localhost:4000
```

For local sign-in without real Google/Apple credentials you can set
`ALLOW_INSECURE_DEV_AUTH=true` (development only: the server refuses to start with it
in production). Admin access comes from `ADMIN_EMAILS`.

You need a MongoDB to run the app. Tests don't: they use an in-memory MongoDB.

## Checks

```bash
cd backend
npm run lint        # ESLint (correctness rules)
npm test            # Jest: unit + integration against in-memory MongoDB
npm run test:e2e    # Puppeteer browser flows (needs Chrome; CHROME_PATH to override)
npm run load-test   # concurrency levels 20–150 against a throwaway local server
```

CI (`.github/workflows/ci.yml`) runs lint, tests and the production dependency audit on
every push and pull request, then the browser E2E.

## API overview

All state-changing `/api` requests need the `X-CSRF-Token` header (the value of the
`aceiiit_csrf` cookie). Sessions are the httpOnly `aceiiit_session` cookie; bearer tokens
are not accepted.

| Area | Endpoints |
|---|---|
| Auth (`/api/auth`) | `GET /csrf`, `GET /config`, `POST /login`, activation (`/activate/request`, `/verify`, `/complete`), password reset (`/forgot-password/...`), `POST /google`, `POST /apple`, `GET /me`, `PUT /password`, `POST /logout`, `POST /logout-all` |
| Account (`/api/account`) | `GET /export` (download my data), `DELETE /` (delete my account) |
| Catalog (`/api/tests`) | `GET /` (metadata only), `GET /:id`, `POST /practice`, `POST /qotd-attempt` |
| Exam (`/api`) | `POST /attempt/start`, `GET /attempt/sessions/active`, `POST /attempt/session/:id/takeover`, `GET .../paper`, `PUT .../answers`, `POST .../advance`, `POST .../events`, `POST .../abandon`, `POST /attempt` (submit, `Idempotency-Key`) |
| Results (`/api`) | `GET /attempts`, `GET /result/:id`, `GET /analysis/:id`, `GET /analysis/:id/questions`, `GET /analysis/:id/interpretation` |
| Planner | `/api/reminders` (CRUD + resend), `/api/calendar/google/*` |
| Admin (`/api/admin`) | snapshot, paginated question bank (`GET /questions`), question/test lifecycle, results, leaderboard, analytics, integrity review and invalidation, users, sessions, payments, seasons, trash, audit logs, AI status |
| Internal (`/api/internal`) | `POST /access/provision`, `POST /access/revoke` (commerce → portal, shared secret) |
| Health | `GET /health` (process up), `GET /ready` (DB, jobs, queue, AI breaker) |

Exam-session calls also need `X-Exam-Token` (issued at start). See
[`ARCHITECTURE.md`](ARCHITECTURE.md#exam-lifecycle).
