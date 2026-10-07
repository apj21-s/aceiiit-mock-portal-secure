# Security

How the ACEIIIT Mock Portal protects accounts, exams, payments and data, what its limits
are, and what is still open. The decisions and per-milestone evidence are in
`AGENT_HANDOFF_PRODUCTION_HARDENING.md`; the tests are listed in `TESTING.md`.

## Reporting a vulnerability

Email support@aceiiit.com, and don't open a public issue. Include the steps to reproduce
and the affected endpoint.

## Controls

### Authentication and sessions
- **Sign-in methods:** password, Google or Apple.
  - OAuth ID tokens are verified against the provider's JWKS, with `aud`, `iss`, `exp`
    and `sub` always enforced. Verification fails closed.
  - Accounts link by provider subject; linking by email happens only when the provider
    marks it verified. Emails in request bodies are never trusted.
  - Mock logins exist only with `ALLOW_INSECURE_DEV_AUTH=true` outside production, and
    the server refuses to start with that flag in production.
- **Session cookie:** httpOnly, `Secure` in production, `SameSite=Lax`, holding a JWT
  `{userId, tv}`.
  - It lives 24 h with sliding renewal.
  - The user is reloaded on every request, so deleted, disabled or revoked sessions fail
    immediately.
  - `tokenVersion` is bumped on password change or reset, role change, disable or delete,
    "sign out of all devices", and admin session revocation.
- **No bearer tokens:** the browser never holds an auth token (nothing in `localStorage`).
- **CSRF:** double-submit token on every POST, PUT, PATCH and DELETE under `/api`. The
  only exemptions are `/api/internal/*` (shared secret) and the Calendar OAuth callback
  (`state`).
- **Brute force:**
  - Per-account failed-login limiter, plus a DB lockout.
  - A generous per-IP ceiling, because campus NAT is common.
  - Activation and reset limiters.
- **Enumeration:** messages are generic, no user record exists before activation
  completes, and login for an unknown account does the same bcrypt work as for a real
  one (no timing oracle).
- **Passwords:** bcrypt cost 12 (native, off the event loop).

### Authorization and input
- Paid access comes only from an active, unexpired `Entitlement` for the test's season,
  checked against the database on every request. `User.isPaid` is display-only.
- The catalog returns metadata only, and only to signed-in users. Questions are served
  only through an active exam session's paper. Answers and explanations are never sent
  before submission.
- **Ownership:** every `:id` route checks the owner, and another user's resource returns
  404 (tested as a cross-user matrix).
- **Validation:** Zod on params, query and body. ObjectIds are enforced. Admin filters
  are enum or integer bound, and search input is regex-escaped and capped at 64 chars.
- **Uploads:** admin only, PNG/JPEG/WebP/GIF checked by magic bytes, at most 4 MB, stored
  in Cloudinary, with no base64 fallback.
- **Internal provisioning API:**
  - The shared secret is compared in constant time (SHA-256, then `timingSafeEqual`).
  - The body is Zod-validated and replays are idempotent.
  - An unknown resource gets 422, and a season is never created implicitly.
  - Every call is audited.

### Data protection
- Google Calendar refresh tokens are encrypted at rest (AES-256-GCM, `CALENDAR_TOKEN_KEY`)
  and revoked at Google on disconnect.
- Logs are structured (pino) with header and secret redaction. Third-party errors are
  logged as message, code and status only (Google API errors carry auth headers).
- Sentry, if enabled, receives no bodies, cookies or auth headers.
- Email HTML and ICS fields are escaped. Image URLs are percent-encoded before going into
  HTML attributes.
- Self-service data rights:
  - `GET /api/account/export` downloads my data.
  - `DELETE /api/account` deletes my account; it needs a confirmation phrase plus the
    password, signs out everywhere, and is refused for admins.
- The audit log is append-only and redacted. It covers role changes, session revocation,
  payments and entitlements, user lifecycle, question and test lifecycle, config,
  internal provisioning, exam takeover, and attempt invalidation and restore.

### Platform
- **Static files:** only `backend/public/` is served; source, `.env` and `node_modules`
  are unreachable. The CSP allows self, Google/Apple sign-in, jsdelivr and fonts; KaTeX
  is self-hosted.
- **Boot validation:** production refuses to start without strong `JWT_SECRET`,
  `INTERNAL_API_SECRET` and `CALENDAR_TOKEN_KEY` (32+ chars each), an https
  `PORTAL_BASE_URL`, `GOOGLE_CLIENT_ID`, and an email provider key.
- **Failure handling:** request timeouts, graceful shutdown, and exit on uncaught
  exceptions (the platform restarts the process).

## Exam integrity: what it is and isn't

Integrity means **server enforcement plus telemetry**. It is not proctoring.

**Enforced by the server** (can't be bypassed from the browser):
- **Timing and answers:** deadlines and the SUPR section lock; answers are validated
  against the test, its section and the option range.
- **One active session:** one session per student and test, bound to an exam token.
  Another tab or device gets 409; an explicit takeover rotates the token and is audited.
- **Submission:** autosave to the server and resume after reload; abandoned exams are
  finalized from saved answers; submit is idempotent.
- **Results:** rank and percentile are computed on the server; per-session option
  shuffling is mapped back before scoring.

**Recorded as telemetry** (evidence for review, not proof):
- tab hidden or window blur, fullscreen exit, copy/cut/paste and the context menu,
  blocked shortcuts, print attempts, a second tab, offline periods, heavy viewport
  shrink, and device takeover.
- The server keeps the counts; the client can't lower them.

**Limits:**
- Signals can be missing (unsupported browsers, iOS fullscreen), spoofed (a modified
  client can stop sending them) or triggered innocently (notifications, accessibility
  tools).
- Copy/paste blocking and the watermark are deterrents. A second device, a phone camera,
  or another person in the room are invisible to a web page.
- There is no webcam or screen recording, by design.
- Consequences are human decisions:
  - **record** mode logs only.
  - **warn** mode (the default) shows the student a counted warning.
  - **strict** mode auto-submits saved answers after the server-counted threshold, with
    warnings first.
  - Nothing is invalidated automatically. Invalidation is an audited admin action that
    can be restored.
- A takeover keeps the original deadline and answers, so it can't be used to gain time.

## AI (Performance Intelligence)

- **Off by default.** When enabled, Google Gemini receives only aggregate performance
  evidence: section, topic and difficulty accuracy, timing patterns, and the change since
  the last attempt. It never receives names, emails, IDs, question text, options,
  explanations, or auth or payment data. A test enforces this.
- Free-tier Gemini content may be used by Google to improve its products. The disclosure
  in the UI and in `privacy.html` says so; the feature is not marketed as private.
- Output passes a strict JSON schema, then a typed check of numeric claims against the
  evidence. Any failure falls back to the deterministic interpretation. The API key is
  server-side only and never logged.
- **Rule:** AI interpretation is never used in authorization, ranking, scoring, test
  eligibility, payment state or exam-integrity enforcement. It is display-only text, and
  a dependency-scan test fails if those modules import the AI modules.

## Dependency audit

Run from `backend/`. CI fails on high or critical advisories in production dependencies.

```bash
npm audit --omit=dev   # production dependencies
npm audit              # includes dev-only tooling
```

| Date | Production (`--omit=dev`) | Dev-only |
|---|---|---|
| 2026-10-06 (before M0) | 8 (1 critical, 3 high, 4 moderate): proxy-addr, compression, multer, nodemailer, mongoose, morgan, qs | n/a |
| 2026-10-07 (after M8) | **0** | 19 moderate, all from one advisory: `sprintf-js` (GHSA-hp3w-g68c-fv3c) through `jest → babel-plugin-istanbul → js-yaml → argparse`. It is only used by test coverage tooling and never shipped or run in production. **Accepted.** |

Notable upgrades:
- `nodemailer` ^10, a deliberate major bump. Only the stable
  `createTransport`/`sendMail` API is used.
- KaTeX 0.16 → 0.19.
- `bcryptjs` → native `bcrypt` 6 (hashes are interchangeable; `bcryptjs` remains as the
  fallback).
- `morgan` was removed in favour of pino.

## Residual risks and open items

| Item | Status |
|---|---|
| Single instance: rate limits, the submit queue and caches are in-memory | ACCEPTED. Redis is needed before horizontal scaling (P2) |
| Browser telemetry can be spoofed or suppressed by a modified client | ACCEPTED (inherent; server enforcement doesn't depend on it) |
| Large login bursts are CPU-bound (bcrypt) on small hosts | PARTIAL: native bcrypt plus `UV_THREADPOOL_SIZE`; capacity on production hardware is not verified (see `TESTING.md`) |
| Trash auto-purge after 30 days (Question and Test TTL): a purged test's past results lose the test title. Scores survive, because attempts embed their review snapshot | ACCEPTED (existing recycle-bin behaviour) |
| `script-src` and `style-src` allow `'unsafe-inline'` (the SPA uses inline handlers and styles) | OPEN (P2: move to nonces/hashes) |
| Privacy Policy and Terms are drafts | OPEN: owner legal review |
| Backups and restore drill, staging, Sentry, real OAuth and Gemini keys | NOT VERIFIED from the development machine (owner checklist in `DEPLOYMENT.md`) |
