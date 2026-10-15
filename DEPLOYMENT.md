# Deployment

One Node service serves the API and the frontend (`backend/public`). The examples below
use Render, but any Node 22 host with a **glibc** Linux image works. Alpine/musl is not
supported, because native `bcrypt` ships prebuilt binaries for glibc only.

| Setting | Value |
|---|---|
| Root directory | `backend` |
| Build | `npm ci --omit=dev` |
| Start | `node server.js` |
| Node | 22 LTS (`engines: 22.x`; on Render also set `NODE_VERSION=22`, which takes precedence) |
| Health check | `GET /health` (liveness) · `GET /ready` (readiness: DB, jobs, queue, AI breaker) |
| Instances | **1** (rate limits, the submit queue and caches are in-memory; see "Scaling") |

## Environment variables

`NODE_ENV=production` turns on strict validation (`backend/config/env.js`): the server
refuses to start when a required value is missing or weak. Set variables in the host's
dashboard; never commit `backend/.env`.

### Required in production

| Variable | Notes |
|---|---|
| `NODE_ENV` | `production` |
| `MONGODB_URI` | Atlas connection string (a dedicated database user with readWrite on the portal DB only) |
| `JWT_SECRET` | ≥ 32 random chars (`openssl rand -hex 32`). Rotating it signs everyone out |
| `PORTAL_BASE_URL` | Public `https://` origin (email links, OAuth/Calendar callbacks) |
| `INTERNAL_API_SECRET` | ≥ 32 chars; **the same value** in the AceIIIT commerce backend |
| `CALENDAR_TOKEN_KEY` | ≥ 32 chars; encrypts Google Calendar refresh tokens. **Changing it makes stored tokens unreadable**, so users would have to reconnect |
| `GOOGLE_CLIENT_ID` | Google sign-in (audience is always enforced) |
| `RESEND_API_KEY` and/or `BREVO_API_KEY` | At least one email provider |
| `ADMIN_EMAILS` | Comma-separated admin accounts |

### Optional

| Variable | Default | Notes |
|---|---|---|
| `APPLE_CLIENT_ID`, `APPLE_REDIRECT_URI` | (unset) | Apple sign-in is disabled unless set |
| `GOOGLE_CLIENT_SECRET`, `GOOGLE_CALENDAR_REDIRECT_URI` | (unset) | Google Calendar sync |
| `RESEND_FROM`, `MAIL_FROM_EMAIL`, `MAIL_FROM_NAME`, `REMINDER_FROM_EMAIL`, `SMTP_*` | | Senders must be verified with the provider; SMTP is a last-resort fallback |
| `CLOUDINARY_URL` (or `CLOUDINARY_CLOUD_NAME/API_KEY/API_SECRET`) | | Question images and study materials. Study files are uploaded from the admin's browser straight to Cloudinary (signed per file; the CSP allows `api.cloudinary.com`) as non-public "authenticated" assets; students get 5-minute signed download links |
| `MATERIAL_MAX_BYTES` | 10485760 (10 MB) | Largest study-material file. 10 MB is Cloudinary's free-plan per-file limit; raise it only on a plan that allows larger files |
| `SESSION_TTL_HOURS` | 24 | Session lifetime (sliding renewal while active) |
| `COMMERCE_ACTIVE_SEASON_RESOURCE_CODES` | `PAID_MOCK_SERIES` | Commerce resource codes that map to the active season |
| `AI_INTERPRETATION_ENABLED`, `GEMINI_API_KEY`, `GEMINI_MODEL` | `false`, (unset), `gemini-3.5-flash-lite` | AI coach on the results page (full mocks only; practice papers never call Gemini). Check Google's current model list and pricing before enabling. If Gemini refuses (quota, a denied project), results show the rule-based plan only |
| `AI_TIMEOUT_MS`, `AI_BREAKER_TTL_MS`, `AI_BREAKER_MAX_MS`, `AI_MIN_INTERVAL_MS` | 20000, 3600000, 86400000, 4000 | AI reliability tuning |
| `MENTOR_MAX_CONCURRENT`, `MENTOR_SENDS_PER_MINUTE` | 4, 6 | ACEIIIT Mentor limits per instance: replies generated at the same time, and messages per student per minute. It uses `GEMINI_API_KEY`/`GEMINI_MODEL`/`AI_TIMEOUT_MS` and works whether or not `AI_INTERPRETATION_ENABLED` is on. Allowances, programme codes and the daily cap are set in Studio → ACEIIIT Mentor (see below) |
| `ACEIIIT_SITE_URL` | (unset) | The AceIIIT site's origin. With the shared `INTERNAL_API_SECRET` it powers programme-enrolment checks for the mentor and the "On the AceIIIT site" orders in Studio user details. Unset turns both off |
| `SENTRY_DSN` | (unset) | Error monitoring (no bodies, cookies or auth headers are sent) |
| `LOG_LEVEL` | `info` | pino JSON logs to stdout |
| `UV_THREADPOOL_SIZE` | 4 | Password hashing runs here; set it to the host's vCPU count (minimum 4) |
| `ATTEMPT_QUEUE_CONCURRENCY`, `ATTEMPT_QUEUE_MAX_SIZE`, `ATTEMPT_QUEUE_MAX_WAIT_MS` | 8, 180, 20000 | Submission smoothing. Set `MAX_SIZE` above the largest cohort that may submit at the same instant |
| `MONGO_*`, `DB_RETRY_DELAY_MS`, `MONGO_AUTO_INDEX` | see `.env.example` | Pool and timeouts. Keep `MONGO_AUTO_INDEX=false` and use the index migration |
| `REQUEST_TIMEOUT_MS`, `SERVER_REQUEST_TIMEOUT_MS`, `KEEP_ALIVE_TIMEOUT_MS`, `HEADERS_TIMEOUT_MS`, `UPLOAD_REQUEST_TIMEOUT_MS`, `SHUTDOWN_TIMEOUT_MS` | see `.env.example` | HTTP timeouts and graceful shutdown |
| `CORS_ORIGIN` | (unset) | Only if the frontend is served from another origin |

**Never set in production:** `ALLOW_INSECURE_DEV_AUTH` (boot fails),
`ACEIIIT_SKIP_DOTENV` (test harnesses only). These are removed and no longer read:
`PAID_SHEETS_*`, `JWT_EXPIRES_IN`, `CLIENT_ORIGIN`, `OTP_*`.

### AceIIIT commerce backend

- `MOCK_PORTAL_URL`: the portal's `https://` origin.
- `INTERNAL_API_SECRET`: the same value as in the portal.
- `MONGODB_URI` for the portal database is no longer needed there. Remove it so commerce
  has no direct access to the portal DB.
- Optional: tag a season with a `resourceCode` in Admin Studio → Seasons. Otherwise
  `PAID_MOCK_SERIES` maps to the active season.

## Migrations

Scripts live in `backend/scripts/migrations/`. Each one is a **dry run by default** and
changes data only with `--apply`. They read `MONGODB_URI` from `backend/.env` (or the
environment), so double-check which database you are pointed at before applying.

Run them once, in this order, after a fresh backup (see "Backups"):

| Order | Script | Why |
|---|---|---|
| 0 | `2026-10-renumber-duplicate-attempts.js` | The old client flow saved some attempts with the same (student, test, attempt number). That double-counts first attempts in rankings and blocks the new unique index. It renumbers affected groups only, 1…N in submission order. A dry run on the live DB (2026-10-07) found 132 attempts in 1 group |
| 1 | `2026-10-sync-indexes.js` | Creates indexes the schemas declare, including the unique ones behind one active exam session, idempotent submit, one interpretation per attempt and one QOTD per day. Create-only; it lists unknown indexes for review and never drops them. The server logs a warning at boot while any are missing |
| 2 | `2026-10-drop-user-ttl.js` | Removes the old TTL index that auto-deleted trashed users (it orphaned their data) |
| 3 | `2026-10-encrypt-calendar-tokens.js` | Encrypts existing Google Calendar refresh tokens (needs `CALENDAR_TOKEN_KEY`). Plaintext tokens keep working until it runs |

```bash
cd backend
node scripts/migrations/2026-10-renumber-duplicate-attempts.js          # review
node scripts/migrations/2026-10-renumber-duplicate-attempts.js --apply
node scripts/migrations/2026-10-sync-indexes.js                         # review
node scripts/migrations/2026-10-sync-indexes.js --apply                 # must report no FAILED lines
```

Other one-off scripts:
- `scripts/seed-ugee-2026.js` (`npm run seed`): sample data for **empty development** databases. It replaces all questions and tests, so it refuses to run when any exist (or with `NODE_ENV=production`). Never run it against production.
- `scripts/load-test.js`: local only.

## First deploy, or the hardening release

1. **Back up** the production database and confirm the backup can be restored.
2. **Stage it**: deploy to a staging service with its own database restored from that
   backup, and the same env as production (its own `PORTAL_BASE_URL`, OAuth origins and
   Calendar redirect).
3. On staging, run the migrations, then the smoke checks below.
4. Configure production env (new required variables: `PORTAL_BASE_URL`,
   `INTERNAL_API_SECRET`, `CALENDAR_TOKEN_KEY`, a ≥ 32-char `JWT_SECRET`), deploy, and run
   the migrations against production.
5. Update the AceIIIT commerce env (`MOCK_PORTAL_URL`, shared secret) and deploy it.
6. Smoke checks on production.

Expected effects of this release:
- **Everyone is signed out once.** Sessions moved to the cookie + `tokenVersion` model;
  old 7-day tokens and `localStorage` tokens are no longer accepted.
- An exam in progress during the deploy resumes from its server-saved answers. The
  server deadline is unaffected by the restart.

### Smoke checks

- `/health` returns 200 and `/ready` returns `status: "ready"`. Job ages should be fresh,
  `attemptQueue.queued` 0 and the AI breaker closed.
- Boot logs show no "missing schema indexes" warning.
- Password login and Google login work, and the session cookie is `HttpOnly; Secure`.
- A student starts a free test, reloads mid-exam (answers return), submits, and sees
  score, rank and percentile.
- Opening the same exam in a second browser shows "open elsewhere", and takeover works.
- A paid test is locked for a student without an entitlement. A commerce test purchase
  (or Admin → Add payment → verify) unlocks it, and revoking re-locks it immediately.
- A reminder email arrives; Calendar connect and disconnect work.
- Admin Studio: the question bank pages and search work, and a question can be attached.

## Backups and restore

- **Atlas:** enable continuous cloud backup (point-in-time restore) on the cluster tier.
  Keep at least 7 days of point-in-time history plus daily snapshots for 30 days.
- **Before every release and every migration**, take an on-demand snapshot.
- **Restore drill (owner action, at least quarterly):**
  1. Restore the latest snapshot to a *new* cluster or database.
  2. Point a staging deploy at it.
  3. Log in as a student and an admin, open a past result, and check the collection
     counts for `users`, `attempts` and `entitlements`.
  4. Record the date and the time it took.

  A backup you have never restored is unverified.
- Cloudinary images and email-provider logs live with those providers. Exam data, users,
  entitlements and the audit log live in MongoDB.

## Rollback

- **Application:** redeploy the previous build (Render → Deploys → Rollback). The
  hardening release changes session format and adds collections and fields. An older
  build ignores the new fields, but it would also re-enable the fixed vulnerabilities, so
  only roll back to restore service and then redeploy a fix.
- **Data:** the migrations are additive (indexes, token encryption) or remove a
  destructive TTL index. None of them needs to be reverted for a rollback.
  - Encrypted calendar tokens can't be read by an older build; those users would
    reconnect Calendar.
  - If data was damaged, restore from the pre-release snapshot (point-in-time restore to
    just before the deploy).
- **Commerce:** if portal provisioning fails, AceIIIT marks the entitlement
  `PROVISIONING_FAILED`, and its retry route re-sends provisioning once the portal is
  healthy. Provisioning is idempotent.

## ACEIIIT Mentor

The floating help button opens ACEIIIT Mentor, a Gemini-backed chat about the student's own
results (WhatsApp support is linked inside it). Scores, ranks and percentiles are always
calculated by the portal; the model only explains them.

**Before switching it on**

1. Run `scripts/migrations/2026-10-sync-indexes.js --apply` (dry run first). The unique
   indexes on `mentorusages {userId, period}` and `mentormessages {userId, clientMessageId}`
   make the monthly allowance exactly-once under concurrent requests; production runs with
   auto-indexing off, so without the migration the allowance is not race-safe. The same run
   creates the `studyfiles` / `studyfolders` indexes.
2. Set `GEMINI_API_KEY` and `GEMINI_MODEL` on Render (never in the frontend or in Git). Check
   that the Google Cloud project can call `generateContent`; Studio → ACEIIIT Mentor shows
   "Paused after a provider error" if Google refuses the key or project.
3. Programme enrolment: in Studio → ACEIIIT Mentor, list the resource code(s) that mean "enrolled
   in the UGEE preparation programme". A student gets the enrolled allowance only with an
   **ACTIVE** entitlement for one of those codes on the AceIIIT site, or a **verified**
   commerce payment for one recorded in the portal. The list starts empty, so everyone is on
   the free allowance until an operator sets it. The site's entitlement code comes from the
   product's metadata (`resourceCode`, default `DEFAULT_ACCESS`); confirm which code the
   programme product grants before entering it. A site lookup that fails counts as free.
4. Deploy the AceIIIT site API with `GET /api/internal/portal/customer` and
   `GET /api/internal/portal/payments/:id/receipt` (same `INTERNAL_API_SECRET` as the
   portal), then set `ACEIIIT_SITE_URL` on the portal.
5. Optional: set the programme page (https only). Empty uses the existing registrations link.

**Allowance:** counts mentor replies, not tokens. Free: 10 per calendar month by default;
enrolled: 100 by default (both configurable, never unlimited). The month is the calendar month
in Asia/Kolkata and resets at 00:00 IST on the 1st. A reply is charged once, only after it is
stored; failures, timeouts and refusals cost nothing, and a retry of the same message never
charges twice. The count lives in MongoDB, so it holds across restarts and instances.

**Cost controls:** per-student rate limit (`MENTOR_SENDS_PER_MINUTE`), replies generated at
once (`MENTOR_MAX_CONCURRENT`), a global daily reply cap, maximum message length and reply
tokens (Studio), the AI timeout and the shared circuit breaker (quota or a refused project
pauses replies for everyone; nothing is charged while paused). Non-streaming; no automatic
provider retries.

**Data:** collections `mentorconversations`, `mentormessages`, `mentorusages`,
`mentordailystats`. Students can delete conversations; account purge deletes them; "Download
my data" includes them. Prompts carry measured results only, never name, email or account
ids (see `privacy.html`).

**Smoke check:** as a student, open the mentor and send "Analyse my latest mock test.".
The usage line drops by one, and Studio → ACEIIIT Mentor shows the reply under today.

## Scaling

- Run **one instance**. The rate limiters, the submit queue, the rank cache and the
  catalog cache are in-memory, so several instances would each enforce their own limits.
  Moving these to Redis is the P2 step before horizontal scaling.
- Size the instance for login bursts: bcrypt cost 12 takes about 100–250 ms per hash per
  core. See `TESTING.md` for measured load results, and run `scripts/load-test.js`
  against staging before a large live exam.
- Use an Atlas tier with enough IOPS for submission bursts. Keep `MONGO_MAX_POOL_SIZE`
  (25) below the cluster's connection limit.

## Owner checklist (can't be done or verified from a development machine)

- [ ] Set the new production env vars and the matching `INTERNAL_API_SECRET` in AceIIIT.
- [ ] Enable Atlas continuous backup and run (and record) a restore drill.
- [ ] Create a staging service and database. Run the migrations and the smoke checks there first.
- [ ] Run the four migrations in production, in order (dry run, review, `--apply`).
- [ ] Production Google OAuth client: authorized origin = `PORTAL_BASE_URL`; Calendar redirect = `PORTAL_BASE_URL/api/calendar/google/callback`.
- [ ] Verify the email sender domain with Resend and/or Brevo.
- [ ] Optional: create a Sentry project and set `SENTRY_DSN`.
- [ ] Optional: enable Gemini (`AI_INTERPRETATION_ENABLED=true`, `GEMINI_API_KEY`) after reviewing the current model list and pricing.
- [ ] ACEIIIT Mentor: confirm the Gemini project can generate content (a 403 "project has been denied access" must be resolved with Google), run the index migration, set the programme resource code(s) in Studio → ACEIIIT Mentor, deploy the site's internal lookup endpoints and set `ACEIIIT_SITE_URL`.
- [ ] Review Google's data-use terms for the Gemini tier in use (free-tier content may be used to improve Google's products).
- [ ] Have the Privacy Policy and Terms (`backend/public/privacy.html`, `terms.html`) legally reviewed.
- [ ] Run `npm run load-test` (or the same flow) against staging sized like production before a large exam.
