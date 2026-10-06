# ACEIIIT --- Production Hardening & Completion Specification

## Purpose

This document is the execution specification for Claude Code. Bring the
current ACEIIIT repository from its advanced-beta / production-oriented
state to a secure, integrity-safe, observable, tested, maintainable
production release.

Do not blindly rewrite the application. Audit first, classify each old
finding as FIXED, STILL OPEN, OBSOLETE, or PARTIALLY FIXED, then
implement only applicable work. Preserve working functionality and add
regression tests for every security/integrity-critical change.

## Current architecture

ACEIIIT is a full-stack online assessment platform with email/password,
Google and Apple authentication, HttpOnly sessions, timed SUPR/REAP
exams, autosave, server-side evaluation, rankings/percentiles,
season-based entitlements, backend-native payments, Admin Studio,
question banks, test publishing, study planning, reminders, Google
Calendar OAuth, email workflows, Performance Intelligence, and
AI-assisted result interpretation.

The old Google Sheets payment workflow is obsolete. Entitlement is the
authoritative access layer:

``` text
Payment → PaymentRecord → Admin verification → Entitlement → Season → Test access
```

Do not reintroduce Sheets as an authorization source.

## Phase 0 --- Repository audit

Inspect the complete repository before modification: backend, frontend,
routes, controllers, services, models, auth, payments, entitlements,
seasons, admin, calendar, reminders, analytics, AI, uploads, email,
jobs, CSP, deployment, package files, tests and Git state.

Search for obsolete or risky paths including `mock_google_`,
`mock_apple_`, `ALLOW_INSECURE_DEV_AUTH`, hardcoded `secret`,
`INTERNAL_API_SECRET`, Google Sheets/sheet sync, `isSheetVerified`,
`sheet_sync`, `/send-otp`, `/verify-otp`, `req.auth.id`,
`correctOption`, client timing fields, localStorage tokens, calendar
tokens, and old environment names. Classify every result before changing
it.

Inspect `git status`, branches, diffs and tracked/untracked files. Never
delete user work or secrets blindly.

## Phase 1 --- Authentication and security

### Google

-   Verify ID tokens server-side.
-   Verify issuer, audience, expiry and subject.
-   Require `GOOGLE_CLIENT_ID` in production.
-   Never accept `mock_google_*` in production.
-   Never trust arbitrary client-provided identity fields.

Required: mock credential → 401; forged token → 401; wrong audience →
401; expired token → 401; valid token → authenticated.

### Apple

-   Verify signature, issuer, audience, expiry and subject.
-   Remove any unsigned-token fallback.
-   Never accept `mock_apple_*` in production.
-   Fail closed.

### Account linking

Link by verified provider subject or an explicitly verified provider
identity. Never link solely because an unverified email string matches
an existing account.

### Sessions

Use the HttpOnly `aceiiit_session` cookie as the production auth
mechanism. Remove unnecessary long-lived localStorage tokens after
auditing all consumers. Add session revocation using a user
`tokenVersion` or equivalent. Revoke on password reset/change,
disable/delete and explicit security revocation. Keep authentication
middleware aware of user status.

### CSRF and abuse

Because authentication uses cookies, implement a suitable CSRF strategy
for state-changing routes. Add IP and account-aware throttling for
login, activation and password reset. Make responses enumeration-safe.

### Internal API

`INTERNAL_API_SECRET` must be mandatory. No default secret. Validate
input with Zod, compare secrets safely, authorize the requested action
and audit it. Missing/wrong secret → 401; invalid body → 400.

### Static serving

Never serve the repository root. Only intended public assets may be
exposed. `/backend/server.js`, `/backend/package.json`, controllers and
`.env` must not be publicly downloadable.

### Environment

Validate required production environment variables at boot and fail
fast. No localhost production fallback. Never commit secrets.

## Phase 2 --- Exam integrity

Create a server-authoritative attempt lifecycle:

``` text
Start → server startedAt/deadline → submission → server evaluation
```

The browser timer is UI only. Validate attempt ownership, test/season
membership, deadline, answer ranges and submission state on the server.
Make submission idempotent so retries cannot duplicate attempts,
rankings, emails or analytics.

Do not trust client `timeTakenSeconds` as authoritative. Server
timestamps must drive exam integrity and ranking tie-breaks.

## Phase 3 --- Paid content and entitlements

Every student-facing paid endpoint must enforce:

``` text
free test OR admin OR active entitlement for test.seasonId
```

`User.isPaid` must not be sufficient. Audit catalog, question retrieval,
attempt start, results, review, QOTD and all test APIs. Draft and
paid-only questions must never leak to unauthorized users.

Prevent destructive deletion of questions attached to live/published
tests; use soft deletion/archive/reference protection.

## Phase 4 --- QOTD

Fix QOTD authentication to use the actual authenticated user ID. Select
only appropriate published questions. Never send `correctOption` before
submission. Validate answers and persist attempts correctly. Test valid
submission, ownership and no paid/draft/answer leakage.

## Phase 5 --- Rank, percentile and timing

Do not freeze rank/percentile permanently at first submission. Use
dynamic calculation, aggregation or an explicitly invalidated snapshot.
Server-derived timing must be used for tie-breaking. Preserve correct
tie behavior and update rankings as the population changes.

## Phase 6 --- Reliability

Reminder processing must isolate failures per item. Add retry count,
backoff, failedAt and delivery state. One failed reminder must never
block unrelated reminders.

Escape all user-controlled content in HTML emails.

For uploads, validate size/MIME/type and use object storage/Cloudinary.
Do not fall back to oversized MongoDB base64 documents.

## Phase 7 --- Calendar

Encrypt Google Calendar refresh tokens at rest. Preserve secure OAuth
connect/disconnect and ownership checks. Use stable event UID
`<reminderId>@aceiiit.in`, UTC timestamps and correct sequence
semantics. Reschedule/cancel must update lifecycle state safely.
Production callback must use HTTPS and the real origin.

## Phase 8 --- Authorization and validation

Audit every route containing
user/test/attempt/question/payment/entitlement/reminder/season IDs for
IDOR. Students can access only their own resources; admins require admin
authorization; internal routes require internal authorization.

Use Zod or equivalent validation on every route accepting user input:
auth, payments, entitlements, seasons, tests, questions, attempts, QOTD,
reminders, calendar, uploads, admin filters and internal APIs.

## Phase 9 --- Performance Intelligence and AI

Preserve this architecture:

``` text
Attempt → Deterministic Analytics → Pattern Detection → Evidence → AI Interpretation → Validated Output
```

Deterministic backend code remains authoritative for score, accuracy,
rank, percentile, timing and question correctness. AI must never modify
those values.

Support evidence-based patterns such as high-time/low-accuracy,
fast/low-accuracy, strong/slow, recurring topic failures, difficulty
sensitivity, improvement/regression, question-selection issues and
repeated error types. Require sufficient evidence and never diagnose
psychological states.

Validate AI output against a strict schema such as:

``` json
{
  "headline": "",
  "summary": "",
  "strengths": [],
  "priorityAreas": [{"topic": "", "reason": "", "action": ""}],
  "behaviorPatterns": [],
  "nextTestStrategy": []
}
```

Run AI asynchronously after submission. Cache results, enforce
timeouts/output limits, handle quota failures, and provide deterministic
fallback. Do not send unnecessary PII to the AI provider. Store
model/prompt version and analysis status.

## Phase 10 --- Admin Studio

Preserve and verify question-bank search/filter, bulk selection,
attach/detach, question reuse, section grouping, sticky actions,
validation, preview, publish, inline editing, LaTeX preview, stable
scroll/modal state and large-bank pagination/virtualization. Avoid
nested scrollbars and UI regressions.

## Phase 11 --- Frontend and loader

Preserve the finalized ACEIIIT SVG loader as a static asset using
`<img>`, not canvas/base64 JS. Preserve existing loading APIs, delay and
overlay semantics. Ensure every loading session starts from the first
animation frame, hides on success/error, remains responsive and supports
reduced motion. Remove old loader code only after repository-wide
reference verification.

Audit responsiveness at 320, 360, 390, 430, 768, 1024, 1280, 1440 and
large desktop widths. No horizontal overflow or accidental double
scrollbars.

Keep the centralized time-aware greetings: - 05:00--08:59 --- Rise &
Revise. - 09:00--11:59 --- Let's Get Sharp. - 12:00--16:59 --- Keep The
Momentum. - 17:00--19:59 --- Time To Lock In. - 20:00--23:59 --- One
More Push. - 00:00--04:59 --- Still In The Game?

## Phase 12 --- Database integrity

Audit indexes, unique constraints, TTL behavior and reference
relationships. Do not TTL-delete users in a way that orphans attempts,
entitlements, reminders or audit logs. Prefer soft deletion. Prevent
live-test question deletion.

Review attempt document size and avoid unnecessary duplication of
complete question content when safe while preserving historical
correctness.

## Phase 13 --- Audit logging

Audit payment verify/revoke, entitlement changes, role changes, user
deletion, season changes, question edits, test edits/publishing,
configuration changes and administrative overrides. Never log secrets.

## Phase 14 --- Observability and operations

Add structured logging with request IDs, error monitoring, metrics and
meaningful health/readiness checks. Do not swallow `uncaughtException`;
log and exit safely. Implement graceful SIGTERM shutdown for server,
MongoDB and background jobs.

## Phase 15 --- Scalability

Do not add infrastructure merely for fashion. Current in-memory
cache/rate-limit/job state is acceptable for a single instance but must
be externalized for multi-instance correctness.

When scale requires it, use Redis for shared cache/rate limits/locks and
a queue for emails, reminders, AI and heavy jobs. Make jobs idempotent
and claimable by one worker.

Optimize rank aggregation and question-bank queries; do not load an
entire test/question bank into memory for ordinary requests.

## Phase 16 --- Code quality

Add ESLint and Prettier. Incrementally modularize large frontend files
only after preserving behavior and adding tests. A TypeScript migration
is optional and must not block production hardening.

Introduce a build pipeline with hashed assets and long-lived caching
only if compatible with current deployment.

## Phase 17 --- Dependencies

Run `npm audit --omit=dev`. Resolve high/critical vulnerabilities where
feasible. Do not blindly use `npm audit fix --force`. Document any
accepted residual risk.

## Phase 18 --- Testing

Create automated unit/integration/API tests using the repository's
appropriate framework, Supertest and an isolated test database.

Minimum coverage: - Email auth, activation, password reset -
Google/Apple invalid and valid identities - Session revocation - RBAC
and IDOR - Entitlements and season isolation - Attempt
lifecycle/deadline - Duplicate submission - Answer validation - Negative
marking - QOTD - Payment verify/revoke - Calendar lifecycle - Reminder
retry - AI schema validation/failure/fallback/cache - Admin
authorization

## Phase 19 --- CI

GitHub Actions should run:

``` text
Install → Lint → Tests → Security Audit → Build
```

Do not deploy production from a failing CI state.

## Phase 20 --- Load testing

Preserve the validated baseline:

-   20 concurrent submissions: 100% success, \~1.59s p95
-   40 concurrent submissions: 100% success, \~4.34s p95
-   60 concurrent submissions: 100% success, \~3.55s p95

Do not claim 100+ simultaneous capacity unless newly tested. Future
tests should measure 80/100/150 concurrency plus CPU, memory, MongoDB
latency, queue depth, p50/p95/p99 and error rate.

## Phase 21 --- Backups and staging

Configure automated MongoDB backups, retention and documented restore
procedures. A backup is not considered proven until restoration has been
tested.

Maintain separate development, staging and production environments with
separate databases/OAuth credentials and no production secrets in
staging.

Never run destructive smoke tests against production.

## Phase 22 --- Documentation

Update README and create/refresh:

-   `ARCHITECTURE.md`
-   `SECURITY.md`
-   `TESTING.md`
-   `DEPLOYMENT.md`

Remove obsolete references to OTP login and Google Sheets payment
authority. Document environment variables, authentication, entitlements,
seasons, calendar, email, AI analytics, testing, deployment, rollback
and backup/restore.

## Phase 23 --- Privacy and legal

Before public launch, provide Privacy Policy, Terms of Service,
support/contact, account deletion and clear AI/performance-data handling
disclosure. Explain that AI output interprets structured performance
evidence and does not calculate authoritative scores.

## Final verification matrix

Claude Code must explicitly report PASS/FAIL/PARTIAL/NOT VERIFIED for:

### Authentication

-   mock Google → 401
-   forged Apple → 401
-   wrong OAuth audience → 401
-   missing required OAuth env → startup failure

### Internal API

-   missing secret → 401
-   wrong secret → 401
-   invalid body → 400
-   valid request → authorized

### Static security

-   backend source unavailable
-   package files unavailable
-   `.env` unavailable

### QOTD

-   submission succeeds
-   correct user persisted
-   no answer leakage
-   no unauthorized paid/draft question

### Exam integrity

-   server start/deadline
-   timeout enforcement
-   duplicate submission protection
-   invalid option rejection
-   wrong test rejection
-   wrong season rejection

### Entitlements

-   free test allowed
-   paid test without entitlement denied
-   correct season entitlement allowed
-   wrong-season entitlement denied
-   admin allowed
-   revoked entitlement denied

### IDOR

Attempt cross-user access for attempts, results, planner, reminders,
payments and entitlements; all must fail.

### Security

Run:

``` bash
npm audit --omit=dev
```

Document all remaining high/critical issues.

## Definition of Done

ACEIIIT is ready for production only when:

-   No production authentication bypass exists.
-   OAuth verification is fail-closed.
-   Internal APIs are secured.
-   Backend source is not publicly served.
-   Production secrets are protected.
-   Sessions can be revoked.
-   Cookie authentication is hardened.
-   CSRF strategy is implemented where required.
-   Exam timing is server-authoritative.
-   Duplicate submissions are safe.
-   Answers are validated server-side.
-   Paid content cannot leak.
-   Season entitlements are authoritative.
-   Draft questions cannot leak.
-   QOTD is secure and functional.
-   Live-test questions cannot be destructively deleted.
-   Rank/percentile behavior is correct.
-   Reminder failures cannot block the queue.
-   User-controlled email content is escaped.
-   OAuth refresh tokens are encrypted.
-   Admin search is injection-safe.
-   Critical routes validate input.
-   AI cannot alter authoritative statistics.
-   AI failure does not break results.
-   Automated security/integration tests exist.
-   CI runs tests and security checks.
-   Structured logging and error monitoring exist.
-   Graceful shutdown exists.
-   Database backups exist and restore has been tested.
-   Staging exists.
-   Production documentation is current.
-   Privacy/Terms/support paths exist.
-   Load-test results are documented.
-   No unresolved production blocker remains.

## Execution rule

Do not treat this as permission to rewrite the application.

Use:

``` text
AUDIT
  ↓
CLASSIFY
  ↓
TEST CURRENT BEHAVIOR
  ↓
FIX HIGH-RISK ISSUES
  ↓
ADD REGRESSION TESTS
  ↓
HARDEN
  ↓
OPTIMIZE
  ↓
CLEAN UP
  ↓
VERIFY
  ↓
DOCUMENT
```

Prioritize:

**Security \> data integrity \> correctness \> reliability \>
maintainability \> performance \> cosmetic refactoring.**

Do not polish UI while a production authentication bypass exists. Do not
optimize distributed scaling before correctness is proven. Do not
introduce infrastructure without a concrete requirement.

At completion, provide a concise final report containing: implementation
summary, security fixes, integrity fixes, test commands/results,
verification matrix, remaining risks, changed files, deployment
checklist, and explicit items that could not be verified.
