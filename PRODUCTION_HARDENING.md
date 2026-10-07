# ACEIIIT --- Production Hardening, Completion & AI Integration Master Plan

**Status:** Execution-ready review\
**Scope:** M0--M8 production hardening, Gemini Performance Intelligence,
verification, and release readiness\
**Source basis:** ACEIIIT production review supplied by the project
owner\
**Updated:** 2026-10-06

> **Implementation status (2026-10-07):** M0–M8 are implemented in the working tree.
> The final verification matrix, test results, residual risks and deployment checklist are
> in `AGENT_HANDOFF_PRODUCTION_HARDENING.md` (§14, "Final report"). The operational docs
> are `ARCHITECTURE.md`, `SECURITY.md`, `DEPLOYMENT.md` and `TESTING.md`. This document is
> kept unchanged below as the review the work was executed against.

------------------------------------------------------------------------

## 1. Executive decision

The supplied plan is directionally correct and unusually thorough. It
correctly identifies the most dangerous classes of problems:
authentication bypasses, exposed source files, weak internal
provisioning, stale authorization state, client-controlled exam timing,
payment/entitlement divergence, QOTD answer leakage, IDORs, unreliable
jobs, unsafe uploads, weak validation, and missing production
verification.

The plan should **not** be implemented literally line-by-line without
reconciliation.

The recommended execution order is:

1.  **M0 --- Safety net and characterization tests**
2.  **M1 --- Authentication, sessions, CSRF and P0 security**
3.  **M2 --- Exam integrity and submission correctness**
4.  **M3 --- Payments, entitlements and paid-content isolation**
5.  **M4 --- QOTD, email, uploads and calendar security**
6.  **M5/M6 --- Authorization, validation, audit and AI**
7.  **M8 --- frontend hardening, observability, CI, load testing and
    documentation**
8.  **Final production verification and deployment**

Do not optimize for completing all files. Optimize for proving that each
security and integrity invariant is true.

------------------------------------------------------------------------

# 2. What is correct

## 2.1 P0 security findings are correctly prioritized

The following findings deserve immediate treatment:

-   mock Google authentication accepted in production
-   unsigned/fallback Apple token handling
-   hardcoded internal API secret
-   repository-root static serving
-   optional OAuth audience validation
-   obsolete Sheets authority
-   bearer tokens stored in localStorage
-   stale JWT authorization state
-   plaintext Calendar refresh tokens
-   missing validation
-   cross-user authorization risks

The source audit explicitly identifies these as still open or P0. Do not
downgrade them merely because the application is otherwise functional.

## 2.2 Exam integrity architecture is fundamentally correct

The proposed `AttemptSession` model is the right direction.

The authoritative exam state should be server-owned:

-   `startedAt`
-   `deadlineAt`
-   `status`
-   `submissionKey`
-   `attemptId`

The browser timer should be a display mechanism, not the authority.

Likewise:

-   answer option validity must be checked server-side
-   question IDs must belong to the test
-   duplicate submissions must be idempotent
-   ranking must not use client timing
-   server time must determine the authoritative duration

This is a major improvement over trusting `timeTakenSeconds` and
`timeSpent`.

## 2.3 Entitlement-based authorization is correct

The strongest architectural decision in the plan is:

> `Entitlement` is the authority for paid access.

`User.isPaid` should only exist as a cache/legacy compatibility field if
absolutely necessary. It must never determine access to an individual
test.

The access rule should be conceptually:

``` text
test.isFree
OR admin
OR active entitlement for the test's season
```

with revoked and expired entitlements denied.

## 2.4 Backend-native payment provisioning is correct

Removing Google Sheets as an authority is the correct long-term
architecture.

The commerce application should not write directly into the portal's
MongoDB collections.

Instead:

``` text
Commerce
   ↓ authenticated internal HTTP
Portal /api/internal/access/provision
   ↓
PaymentRecord
   ↓
Entitlement
   ↓
AuditLog
```

This establishes a clean ownership boundary.

## 2.5 QOTD isolation is correctly designed

QOTD should never expose:

-   `correctOption`
-   explanation before submission
-   paid questions
-   draft questions

The answer should only be returned after a valid QOTD submission.

The `req.auth.userId` correction is also necessary.

## 2.6 AI architecture is correctly separated from authoritative analytics

The strongest AI decision is:

``` text
Attempt
  ↓
Deterministic analytics
  ↓
Evidence/pattern extraction
  ↓
Gemini interpretation
  ↓
Validated AIAnalysis
  ↓
Student UI
```

Gemini must not calculate:

-   score
-   rank
-   percentile
-   authoritative accuracy
-   authoritative timing

Those values must come from deterministic backend data.

------------------------------------------------------------------------

# 3. What is risky or needs modification

## 3.1 30-second user cache conflicts with "immediate" revocation

The plan proposes:

> cache user rows for 30 seconds

but later expects access changes to happen immediately.

That creates a contradiction.

### Recommended correction

Use one of:

1.  short cache + explicit invalidation on every mutation, or
2.  no cache for security-critical session state, or
3.  cache only immutable/non-security metadata.

Recommended:

``` text
Normal request:
  cached user lookup, max TTL 5–30s

Security mutation:
  update DB
  increment tokenVersion
  immediately invalidate user cache

Sensitive access check:
  DB-backed entitlement lookup
```

A revoked session should not remain valid for the full cache TTL.

## 3.2 "Midnight Pacific" AI quota reset is too specific

The plan assumes:

> daily quota resets at midnight Pacific

Do not encode this as a permanent provider invariant.

Google may expose rate/quota behavior differently across models and API
tiers.

### Recommended correction

Circuit breaker should use:

-   provider error classification
-   `retryDelay` where supplied
-   configurable fallback TTL
-   maximum breaker duration
-   explicit admin visibility

Do not hardcode a timezone-based reset unless the current API
documentation explicitly requires it.

## 3.3 Do not blindly pin an old Gemini model

The original plan correctly says to check the model list when
implementation begins.

That rule should remain.

As of the current Google documentation, Gemini 3.1 Flash-Lite is listed
as a stable model and its Standard tier currently shows free
input/output pricing. Gemini 2.5 Flash-Lite also currently has a free
Standard tier. citeturn0search1turn0search3

For ACEIIIT, a small Flash-Lite model is appropriate because the task is
structured interpretation rather than open-ended reasoning.

However:

``` text
GEMINI_MODEL
```

must remain configurable.

Do not bake a model identifier into frontend code or business logic.

## 3.4 Free Gemini tier has a privacy implication

Google's current pricing documentation indicates that content on the
free tier may be used to improve Google products, while paid-tier
content is not used for that purpose. citeturn0search0

The plan partially mitigates this by sending no:

-   name
-   email
-   userId
-   attemptId
-   question text

That is good.

But the production UX should still explicitly disclose:

> ACEIIIT may use an external AI service to interpret structured
> performance evidence. AI does not calculate or alter scores.

Do not market the feature as private/confidential merely because PII is
removed.

## 3.5 Cookie-only authentication is good, but the migration must be exhaustive

Removing localStorage bearer tokens is correct.

But this is not a one-file change.

Search for every use of:

``` text
Authorization
Bearer
session.token
localStorage
accessToken
jwt
```

before deleting the old mechanism.

A partially migrated system is worse than either architecture because
some routes may silently authenticate differently.

## 3.6 CSRF implementation needs careful OAuth treatment

Double-submit CSRF is reasonable for cookie-authenticated mutation
endpoints.

But define the exact boundary:

``` text
/api/internal/*
OAuth callback endpoints
health/read-only endpoints
```

Do not casually exempt all OAuth routes or all GET routes if any route
has side effects.

Also validate the CSRF cookie/header comparison in constant time where
appropriate.

## 3.7 `AttemptSession` uniqueness needs a real MongoDB partial index

The requirement:

``` text
{ userId, testId, status: active }
```

must be implemented as a partial unique index, not merely application
logic.

Otherwise concurrent starts can create two active sessions.

## 3.8 Idempotency must be scoped

An `Idempotency-Key` should be unique within a meaningful scope such as:

``` text
userId + operation + key
```

Do not make a globally unique key unless there is a reason to.

The stored record should let the server reproduce the original response
safely.

## 3.9 Catalog privacy needs two layers

Removing question data from inaccessible tests is correct.

But also consider metadata leakage:

-   question count
-   paid/free state
-   section names
-   difficulty distribution

Not all metadata is sensitive, but decide intentionally what an
unauthenticated or unauthorized user can see.

## 3.10 AI circuit breaker should not become a queue-killing mechanism

If Gemini is unavailable:

``` text
Attempt submission must still succeed.
Deterministic analytics must still succeed.
AI analysis becomes pending/fallback.
```

Never make AI part of the critical submission transaction.

------------------------------------------------------------------------

# 4. What is redundant or over-engineered

## 4.1 Five email providers

The source plan itself proposes consolidating to:

``` text
Resend primary
SMTP fallback
```

That is sufficient.

Keeping five provider integrations increases:

-   configuration complexity
-   test surface
-   failure modes
-   secret-management burden

Do not preserve five providers merely because they already exist.

## 4.2 Frontend modularization is not a current production blocker

Do not rewrite the vanilla frontend into TypeScript/React/Vite merely
for cleanliness.

The source plan correctly defers this.

First establish:

-   tests
-   security
-   correct authorization
-   reliable exam state
-   observability

Then modularize if actual maintenance pain justifies it.

## 4.3 Redis is not mandatory for the first production hardening pass

For the current scale, introducing Redis before proving the application
needs it adds operational complexity.

First harden the single-instance architecture and measure.

Move to Redis/job infrastructure when metrics demonstrate the need.

## 4.4 AI does not need a sophisticated "digital twin" on day one

A longitudinal profile is valuable, but it should be introduced
incrementally.

V1 should have:

``` text
current attempt
previous attempt delta
topic aggregates
difficulty sensitivity
time/accuracy patterns
next-test strategy
```

Only after that works should you introduce deeper longitudinal modeling.

## 4.5 Do not overbuild AI prompts

The AI prompt should be compact and evidence-driven.

Do not send:

-   entire attempt documents
-   question text
-   explanations
-   user history dumps
-   raw frontend state

The deterministic analytics layer should compress the evidence first.

------------------------------------------------------------------------

# 5. P0 / P1 / P2 priority model

## P0 --- Must fix before production

### Authentication/security

-   Remove production mock Google auth
-   Remove unsigned Apple fallback
-   Enforce OAuth `aud`, `iss`, `exp`, `sub`
-   Require production secrets
-   Remove hardcoded internal secret
-   Use constant-time internal secret comparison
-   Stop serving repository root
-   Remove localStorage JWT authentication
-   Implement secure HttpOnly cookie sessions
-   Implement session revocation/tokenVersion
-   Add CSRF protection
-   Add login abuse protection
-   Remove obsolete OTP routes
-   Validate all internal provisioning requests

### Authorization/payment

-   Make Entitlement authoritative
-   Remove Sheets authority
-   Fix commerce → portal provisioning
-   Prevent paid-test catalog/question leakage
-   Prevent wrong-season access
-   Prevent revoked entitlement access
-   Add IDOR protection to sensitive routes

### Exam integrity

-   Server-authoritative attempt session
-   Server deadline
-   Idempotent submission
-   Server-authoritative timing
-   Server-side answer validation
-   Duplicate-submit protection
-   Correct rank calculation
-   Prevent test/question mismatch

### Data exposure

-   Stop serving backend source files
-   Stop exposing `.env`
-   Stop exposing package files
-   Stop QOTD answer leakage
-   Stop paid/draft QOTD selection

------------------------------------------------------------------------

# 6. P1 --- Must fix before calling the platform mature

-   Calendar refresh-token encryption
-   Email HTML escaping
-   Upload magic-byte validation
-   4MB upload limit
-   Reminder retry/backoff
-   Admin search escaping
-   Zod validation coverage
-   Audit event coverage
-   Question lifecycle protection
-   User purge/anonymization
-   Rank/percentile consistency
-   Graceful shutdown
-   Structured logging
-   Request IDs
-   Sentry
-   `/ready`
-   automated tests
-   CI
-   dependency remediation
-   load testing
-   deployment documentation
-   backup/restore verification
-   privacy/terms/account deletion/export

------------------------------------------------------------------------

# 7. P2 --- Improvements after the core system is stable

-   frontend modularization
-   Vite/build optimization
-   Redis
-   distributed queues
-   horizontal scaling
-   advanced performance profiles
-   recommendation feedback loops
-   deeper longitudinal analytics
-   additional infrastructure automation
-   larger-scale load testing

------------------------------------------------------------------------

# 8. Recommended milestone structure

## M0 --- Safety net

### Objective

Create a reproducible baseline before changing behavior.

### Tasks

-   create `hardening/production`
-   snapshot current state
-   add Jest
-   add Supertest
-   add mongodb-memory-server
-   split Express app construction from server startup
-   characterize:
    -   login
    -   catalog
    -   submit
    -   result
-   run dependency audit
-   document current vulnerabilities

### Exit criteria

``` text
npm test passes
app can be imported without listening
baseline behavior is recorded
no production behavior is changed unintentionally
```

------------------------------------------------------------------------

# 9. M1 --- Authentication and security

### Objective

Make unauthorized authentication impossible by configuration accident.

### Required changes

-   remove production mock auth
-   introduce `ALLOW_INSECURE_DEV_AUTH`
-   reject it in production
-   enforce OAuth claims
-   enforce provider subject linking
-   require verified provider email before email-based linking
-   Zod environment validation
-   secure production configuration
-   move public assets into `public/`
-   stop serving repository root
-   add `User.tokenVersion`
-   DB-backed session validation
-   cookie-only authentication
-   CSRF
-   login lockout
-   enumeration-safe activation/login
-   remove OTP routes

### Exit criteria

All of these must be tested:

``` text
mock Google → 401 production
forged Apple → 401
wrong audience → 401
expired token → 401
missing production env → boot failure
/backend/server.js → 404
/backend/package.json → 404
/backend/.env → 404
revoked session → 401
missing CSRF → 403
lockout → enforced
```

------------------------------------------------------------------------

# 10. M2 --- Exam integrity

### Objective

Make the server the only authority for exam state.

### Data model

``` text
AttemptSession
  userId
  testId
  seasonId
  startedAt
  deadlineAt
  status
  submissionKey
  attemptId
  createdAt
  updatedAt
```

### Rules

-   one active session per user/test
-   server creates deadline
-   client displays countdown
-   server validates deadline
-   answers validated against actual test questions
-   submission atomically closes session
-   duplicate submission is idempotent
-   server time determines ranking duration
-   rank calculated on read
-   percentile calculated on read

### Exit criteria

-   late submission rejected
-   duplicate submission safe
-   invalid option rejected
-   wrong test rejected
-   wrong question rejected
-   rank changes as other attempts arrive
-   ties use server time

------------------------------------------------------------------------

# 11. M3 --- Payments and entitlements

### Objective

Create one authoritative access system.

### Authority

``` text
PaymentRecord → Entitlement → access decision
```

### Remove

-   Google Sheets authority
-   `paidSheetService`
-   sheet sync endpoints
-   `PAID_SHEETS_*`
-   `isSheetVerified`

### Internal provisioning

``` text
POST /api/internal/access/provision
POST /api/internal/access/revoke
```

Validate:

``` text
commerceUserId
email
resourceCode
entitlementId
idempotencyKey
```

### Provision flow

``` text
validate
→ verify internal secret
→ map resourceCode to season
→ upsert PaymentRecord
→ grant Entitlement
→ audit
```

### Exit criteria

-   free test allowed
-   paid test without entitlement → 402
-   correct entitlement → allowed
-   wrong season → 402
-   revoked entitlement → 402
-   admin → allowed
-   repeated provisioning → idempotent

------------------------------------------------------------------------

# 12. M4 --- QOTD, email, uploads and calendar

## QOTD

Never expose answer before submission.

## Email

Centralize:

``` text
escapeHtml()
escapeIcsText()
```

Use:

``` text
Resend
SMTP fallback
```

## Uploads

-   remove base64 fallback
-   4MB limit
-   MIME allow-list
-   magic-byte verification
-   Cloudinary failure → controlled error

## Calendar

-   AES-256-GCM refresh-token encryption
-   revoke token on disconnect
-   HTTPS callback in production
-   stable UID
-   UTC timestamps
-   SEQUENCE increment on update/cancel
-   cancellation test

------------------------------------------------------------------------

# 13. M5/M6 --- Authorization, validation, audit and AI

## Authorization

Perform a complete `:id` route audit.

Every object access must answer:

``` text
Does this object belong to the authenticated user?
OR
Is this user authorized as admin?
```

Validate ObjectIds before database calls.

## Zod

Use one validation middleware:

``` text
validate({ body, query, params })
```

Apply consistently.

## Audit

Audit:

-   user deletion
-   restore
-   purge
-   role changes
-   session revocation
-   entitlement grant/revoke
-   config changes
-   question lifecycle
-   test lifecycle
-   internal provisioning
-   payment state changes

------------------------------------------------------------------------

# 14. Gemini Performance Intelligence --- exact architecture

## 14.1 Product goal

The AI feature should answer:

> "What is actually costing me marks, why is it happening, and what
> should I change before my next test?"

It should not generate a generic motivational summary.

------------------------------------------------------------------------

## 14.2 Deterministic analytics first

Create:

``` text
backend/services/analyticsService.js
backend/services/patternDetectionService.js
backend/services/performanceProfileService.js
```

The deterministic layer computes:

-   score
-   accuracy
-   attempt rate
-   average time
-   median time
-   time efficiency
-   section performance
-   topic performance
-   difficulty performance
-   previous-attempt delta
-   improvement/regression
-   high-time/low-accuracy patterns
-   fast/low-accuracy patterns
-   slow/accurate patterns
-   recurring topic failures
-   difficulty sensitivity
-   question-selection issues
-   avoidable time sinks
-   repeated error patterns
-   mark leakage estimates

Never allow Gemini to calculate these authoritative values.

------------------------------------------------------------------------

# 15. Gemini service design

Create:

``` text
backend/services/aiInterpretationService.js
backend/models/AttemptInterpretation.js
```

Use Google's official:

``` text
@google/genai
```

Server-side only.

Environment:

``` text
GEMINI_API_KEY=
GEMINI_MODEL=
AI_INTERPRETATION_ENABLED=false
AI_TIMEOUT_MS=20000
```

The API key must never reach the browser.

------------------------------------------------------------------------

# 16. AI input privacy contract

The Gemini payload may contain only structured evidence such as:

``` json
{
  "sections": [],
  "topics": [],
  "difficultyBuckets": [],
  "timingPatterns": [],
  "behaviorPatterns": [],
  "previousAttemptDelta": {}
}
```

It must not contain:

``` text
name
email
userId
attemptId
question text
question options
answer explanation
raw session data
authentication data
payment data
```

Implement a payload builder:

``` text
buildAIInterpretationPayload()
```

and test its output against a privacy snapshot.

------------------------------------------------------------------------

# 17. AI output schema

Use one Zod schema for both the intended JSON structure and server
validation.

Conceptual shape:

``` json
{
  "headline": "string",
  "summary": "string",
  "strengths": ["string"],
  "priorityAreas": [
    {
      "topic": "string",
      "reason": "string",
      "action": "string"
    }
  ],
  "behaviorPatterns": ["string"],
  "nextTestStrategy": ["string"]
}
```

Apply:

-   maximum counts
-   maximum string lengths
-   no arbitrary numeric claims
-   no unsupported percentages
-   no invented scores
-   no invented rankings
-   no psychological diagnoses

------------------------------------------------------------------------

# 18. AI hallucination guard

After Gemini returns JSON:

1.  parse JSON
2.  validate against Zod
3.  scan numeric claims
4.  compare every numeric claim against the evidence set
5.  reject unsupported numbers
6.  fall back to deterministic interpretation

Example:

If evidence contains:

``` text
accuracy = 44%
```

then AI may say:

``` text
Your accuracy in Calculus is 44%.
```

But it must not invent:

``` text
You are 17% behind top students.
```

unless that number exists in the supplied evidence.

------------------------------------------------------------------------

# 19. AI request policy

One AI interpretation per completed attempt.

The request is asynchronous.

Never:

``` text
POST /attempt
  ↓
wait for Gemini
  ↓
return result
```

Instead:

``` text
POST /attempt
  ↓
persist attempt
  ↓
persist deterministic analytics
  ↓
queue AI interpretation
  ↓
return result
```

The result page can display:

``` text
Performance Intelligence
Analyzing your attempt…
```

and poll/fetch the analysis.

------------------------------------------------------------------------

# 20. Gemini retry policy

Timeout:

``` text
20 seconds
```

Retry only:

-   network failures
-   HTTP 429
-   HTTP 5xx

Maximum:

``` text
3 attempts
```

Use exponential backoff.

Do not retry:

-   HTTP 400
-   malformed response
-   schema validation failure
-   unsupported model configuration

------------------------------------------------------------------------

# 21. AI circuit breaker

If provider quota exhaustion is detected:

``` text
OPEN
 ↓
new AI jobs → deterministic fallback
 ↓
retry later
 ↓
CLOSED
```

Do not hardcode a provider-specific timezone reset.

Use:

-   provider retry metadata
-   configurable breaker TTL
-   bounded retry delay
-   admin visibility

Expose breaker state through:

``` text
/ready
```

and the admin dashboard.

------------------------------------------------------------------------

# 22. AI storage model

Create an isolated collection:

``` text
AttemptInterpretation
```

Suggested fields:

``` text
attemptId
status
provider
model
payloadVersion
result
fallbackReason
attemptCount
createdAt
completedAt
expiresAt
```

The AI service must not have write access to `Attempt`.

This makes AI interpretation structurally incapable of modifying
authoritative exam data.

------------------------------------------------------------------------

# 23. Gemini UI

The result page should not show a generic:

> AI Summary

Instead use sections such as:

``` text
Performance Intelligence
What Changed?
Your Edge
Where Marks Leak
Your Error Fingerprint
The Pattern
Your Next Move
Your Trajectory
```

The UI must visually distinguish:

``` text
Verified metrics
```

from:

``` text
AI interpretation
```

For example:

``` text
Score: 68/100
Accuracy: 71%
Rank: 14

AI interpretation:
You are losing disproportionate time on…
```

The first group is authoritative backend data.

------------------------------------------------------------------------

# 24. Gemini testing matrix

Mock the Gemini client.

Test:

  Case                    Expected
  ----------------------- ---------------------------
  valid JSON              stored
  valid schema            stored
  invalid JSON            fallback
  wrong schema            fallback
  invented number         fallback
  timeout                 retry then fallback
  400                     no retry
  429                     retry/circuit handling
  500                     retry
  duplicate attempt       one AI job
  cached interpretation   zero extra provider calls
  PII in payload          test fails
  AI modifies Attempt     impossible
  API key in logs         impossible

------------------------------------------------------------------------

# 25. M8 --- Frontend, admin, observability and scale readiness

## Loader

Keep the approved SVG `<img>` loader.

Before removing any canvas loader, verify whether it is actually a
separate animation system.

Requirements:

-   restart SVG animation for each loading session
-   hide on success
-   hide on error
-   reduced-motion support
-   no stale overlay

## Responsive

Test:

``` text
320
360
390
430
768
1024
1280
1440
```

Fix:

-   horizontal overflow
-   double scrollbars
-   broken modal state
-   admin Studio overflow
-   mobile exam UI
-   greeting transitions

## Admin Studio

Verify:

-   search
-   filter
-   bulk select
-   attach
-   detach
-   reorder
-   preview
-   publish
-   LaTeX
-   modal state
-   scroll state

Question bank should become paginated server-side.

------------------------------------------------------------------------

# 26. Observability

Add:

``` text
pino
pino-http
request IDs
secret redaction
Sentry
```

Health:

``` text
/health
```

should be liveness.

Readiness:

``` text
/ready
```

should report:

-   database
-   queues
-   job heartbeat
-   relevant breaker state

Never expose secrets or internal stack traces.

------------------------------------------------------------------------

# 27. Testing and CI

CI:

``` text
install
↓
lint
↓
test
↓
npm audit --omit=dev --audit-level=high
↓
build if applicable
```

Use Node 22.

Testing must include:

-   auth
-   activation
-   reset
-   RBAC
-   payments
-   entitlements
-   QOTD
-   attempts
-   ranking
-   reminders
-   calendar
-   uploads
-   IDOR
-   AI
-   internal provisioning

------------------------------------------------------------------------

# 28. Load testing

Do not claim capacity that has not actually been measured.

Existing validated baseline:

``` text
20 concurrent submissions → p95 1.59s
40 concurrent submissions → p95 4.34s
60 concurrent submissions → p95 3.55s
```

These are baseline measurements, not a guaranteed production capacity
statement.

Future test:

``` text
20
40
60
80
100
150
```

Record:

-   p50
-   p95
-   p99
-   error rate
-   queue depth
-   CPU
-   memory
-   database behavior

Run only against local/staging.

------------------------------------------------------------------------

# 29. Production-readiness checklist

## Security

-   [ ] production mock auth impossible
-   [ ] OAuth audience/issuer/expiry verified
-   [ ] internal secret required
-   [ ] timing-safe secret comparison
-   [ ] repository source inaccessible
-   [ ] `.env` inaccessible
-   [ ] cookie-only authentication
-   [ ] token revocation works
-   [ ] CSRF works
-   [ ] login lockout works
-   [ ] enumeration resistance verified
-   [ ] IDOR matrix passes

## Exam

-   [ ] server deadline
-   [ ] active session uniqueness
-   [ ] duplicate submission idempotency
-   [ ] answer validation
-   [ ] server timing
-   [ ] rank-on-read
-   [ ] percentile-on-read
-   [ ] question deletion cannot brick tests

## Commerce

-   [ ] Sheets removed as authority
-   [ ] PaymentRecord authoritative for payment state
-   [ ] Entitlement authoritative for access
-   [ ] internal provisioning works
-   [ ] internal revoke works
-   [ ] idempotency works
-   [ ] audit events work
-   [ ] wrong-season access denied

## QOTD

-   [ ] only eligible questions
-   [ ] no answer leak
-   [ ] one attempt/day
-   [ ] correct user persisted
-   [ ] answer revealed only after submission

## Email

-   [ ] HTML escaped
-   [ ] ICS escaped
-   [ ] retries work
-   [ ] one failed reminder does not block others
-   [ ] provider fallback works

## Calendar

-   [ ] refresh tokens encrypted
-   [ ] disconnect revokes provider token
-   [ ] stable UID
-   [ ] correct sequence
-   [ ] cancellation works

## AI

-   [ ] API key server-only
-   [ ] model configurable
-   [ ] deterministic analytics first
-   [ ] no PII
-   [ ] no question text
-   [ ] structured output
-   [ ] Zod validation
-   [ ] invented-number guard
-   [ ] timeout
-   [ ] retry policy
-   [ ] circuit breaker
-   [ ] cached interpretation
-   [ ] fallback works
-   [ ] AI cannot mutate Attempt
-   [ ] privacy disclosure exists

## Operations

-   [ ] request IDs
-   [ ] secret redaction
-   [ ] Sentry
-   [ ] health
-   [ ] readiness
-   [ ] graceful shutdown
-   [ ] CI
-   [ ] lint
-   [ ] tests
-   [ ] dependency audit
-   [ ] backup procedure
-   [ ] restore procedure
-   [ ] staging environment

------------------------------------------------------------------------

# 30. Final verification matrix

  Area           Verification              Required result
  -------------- ------------------------- -------------------------------
  Google auth    mock token                401
  Apple auth     forged token              401
  OAuth          wrong audience            401
  Environment    missing required secret   boot failure
  Static files   `/backend/server.js`      404
  Static files   `/backend/.env`           404
  Internal API   wrong secret              401
  Internal API   bad body                  400
  Internal API   valid request             entitlement
  Internal API   replay                    same entitlement/no duplicate
  QOTD           answer before submit      impossible
  QOTD           paid/draft question       impossible
  Exam           late submit               rejected
  Exam           duplicate submit          same attempt
  Exam           invalid option            400
  Exam           wrong test                400
  Access         no entitlement            402
  Access         correct entitlement       allowed
  Access         revoked                   402
  Access         wrong season              402
  IDOR           another user's attempt    denied
  IDOR           another user's reminder   denied
  IDOR           another user's calendar   denied
  AI             malformed response        fallback
  AI             invented number           fallback
  AI             timeout                   fallback
  AI             duplicate attempt         one analysis
  AI             PII payload               test failure
  Security       API key logging           impossible

------------------------------------------------------------------------

# 31. Single master Claude Code implementation prompt

Copy the following prompt into Claude Code from the repository root.

------------------------------------------------------------------------

## MASTER PROMPT --- ACEIIIT PRODUCTION HARDENING M0--M8

You are the senior engineer responsible for completing production
hardening of ACEIIIT.

You are working in an existing production-oriented online assessment
platform. Do not rewrite the application from scratch. Preserve working
functionality and existing UX unless a security/integrity requirement
requires a change.

The supplied production audit is the source of truth for the work.

### NON-NEGOTIABLE RULES

1.  Work from the existing repository, not from assumptions.
2.  Inspect the actual code before modifying it.
3.  Never invent files, models, routes, environment variables or
    existing behavior.
4.  Never weaken security to make tests pass.
5.  Never use mock authentication in production.
6.  Never expose secrets.
7.  Never print API keys or tokens in logs.
8.  Never put the Gemini API key in frontend code.
9.  Never allow Gemini to calculate authoritative scores, ranks,
    percentiles or timings.
10. Never put Gemini on the critical submission path.
11. Never make payment status depend on Google Sheets.
12. Never trust client timing for authoritative exam duration or
    ranking.
13. Never trust client-provided entitlement/access state.
14. Never trust an AI JSON response without server-side validation.
15. Never silently delete production data.
16. Never modify `.env`.
17. Never force-reset Git history.
18. Do not remove `.agents/`, `.ralph/` or scratch material without
    explicit approval.
19. Before destructive changes, create a safe checkpoint.
20. After every milestone, run the relevant test suite.
21. Do not claim a feature is fixed until a test or direct verification
    proves it.
22. If the repository differs from the audit, classify the finding as
    FIXED, OPEN, PARTIAL, OBSOLETE or NOT VERIFIED instead of blindly
    applying the old fix.

### EXECUTION MODEL

For every milestone:

``` text
AUDIT
→ PLAN
→ IMPLEMENT
→ TEST
→ REVIEW DIFF
→ VERIFY
→ REPORT
```

At the beginning:

-   inspect Git status
-   inspect package manifests
-   inspect backend entrypoints
-   inspect auth middleware
-   inspect models
-   inspect routes
-   inspect services
-   inspect frontend storage/auth logic
-   inspect payment/commerce integration
-   inspect existing tests
-   inspect environment configuration

Create:

``` text
hardening/production
```

Commit current tracked and untracked production source safely before
major modifications, but do not include secrets or explicitly excluded
scratch directories.

------------------------------------------------------------------------

## M0 --- SAFETY NET

Install:

``` text
jest
supertest
mongodb-memory-server
```

only if absent.

Split Express construction from listening:

``` text
backend/app.js
backend/server.js
```

`app.js` must export the Express application without starting listeners
or background jobs.

`server.js` must handle:

-   listening
-   jobs
-   graceful shutdown

Create characterization tests for:

-   login
-   catalog
-   test access
-   submission
-   result

Run:

``` text
npm test
npm audit --omit=dev --audit-level=high
```

Do not make functional changes unless required to create the test
harness.

------------------------------------------------------------------------

## M1 --- AUTHENTICATION AND SECURITY

### OAuth

Delete production mock authentication branches.

Development mocks may exist only when:

``` text
ALLOW_INSECURE_DEV_AUTH=true
AND
NODE_ENV !== production
```

Production must reject this configuration.

Google and Apple tokens must validate:

``` text
aud
iss
exp
sub
```

Account linking must use provider subject.

Email-based linking is allowed only when the provider explicitly
verifies the email.

Never trust a request-body email for identity linking.

### Environment validation

Create:

``` text
backend/config/env.js
```

using Zod.

Production must require appropriate secrets including:

``` text
JWT_SECRET
MONGODB_URI
GOOGLE_CLIENT_ID
APPLE_CLIENT_ID when Apple enabled
INTERNAL_API_SECRET
PORTAL_BASE_URL
CALENDAR_TOKEN_KEY
email provider configuration
```

Production `PORTAL_BASE_URL` must be HTTPS.

Do not modify `.env`.

Update `.env.example`.

### Static files

Move public assets to:

``` text
backend/public/
```

Serve only that directory.

The following must return 404:

``` text
/backend/server.js
/backend/package.json
/backend/.env
```

Audit SPA fallback carefully so it cannot become a filesystem exposure
mechanism.

### Sessions

Add:

``` text
User.tokenVersion
```

JWT contains token version.

Auth middleware must load current user state and reject:

-   deleted
-   disabled
-   tokenVersion mismatch

Role and paid access state must come from authoritative server state,
not stale JWT claims.

Use secure HttpOnly cookie authentication.

Remove localStorage bearer-token storage.

Search the entire frontend for:

``` text
Authorization
Bearer
session.token
localStorage
accessToken
```

and remove stale authentication paths.

Implement:

``` text
POST /admin/users/:id/revoke-sessions
```

and bump tokenVersion on:

-   password change/reset
-   disable/delete
-   role change
-   explicit session revocation
-   logout if the architecture requires global invalidation

Use a short session lifetime with safe sliding renewal.

If user-state caching is used, invalidate immediately after security
mutations. Do not permit a revoked account to remain authorized merely
because of a cache TTL.

### CSRF

Implement double-submit CSRF for cookie-authenticated mutations.

Set:

``` text
aceiiit_csrf
```

and require:

``` text
X-CSRF-Token
```

for state-changing API calls.

Keep explicit exemptions only for truly independently authenticated
internal/OAuth callback flows.

### Abuse prevention

Add:

``` text
failedLoginCount
lockedUntil
```

Use account/email and IP-based rate limiting.

Use enumeration-safe activation and login responses.

Remove obsolete:

``` text
/send-otp
/verify-otp
```

and obsolete OTP model/code unless needed strictly for migration.

### M1 tests

Prove:

-   mock Google production → 401
-   forged Apple → 401
-   wrong audience → 401
-   expired token → 401
-   missing required production env → boot failure
-   static source paths → 404
-   revoked session → 401
-   missing CSRF → 403
-   lockout → enforced

------------------------------------------------------------------------

## M2 --- EXAM INTEGRITY

Create:

``` text
AttemptSession
```

Fields:

``` text
userId
testId
seasonId
startedAt
deadlineAt
status
submissionKey
attemptId
createdAt
updatedAt
```

Create a MongoDB partial unique index guaranteeing one active session
per:

``` text
userId + testId
```

Implement:

``` text
POST /api/attempt/start
```

The server computes the authoritative deadline.

The frontend timer is display-only.

Submission must require:

``` text
sessionId
Idempotency-Key
```

Validate:

-   session ownership
-   session status
-   test identity
-   deadline
-   answer range
-   question membership

Atomically transition:

``` text
active → submitted
```

Duplicate requests with the same scoped idempotency key must return the
original attempt.

Authoritative duration:

``` text
min(submittedAt, deadlineAt) - startedAt
```

Client per-question timing may be stored for analytics but cannot
determine ranking.

Remove frozen persisted rank.

Implement rank/percentile calculation on read with server-authoritative
duration tie-break.

Cache ranking carefully and invalidate/update when appropriate.

### M2 tests

-   session creation
-   duplicate session start
-   deadline enforcement
-   late submit
-   duplicate submit
-   invalid answer
-   wrong question
-   wrong test
-   negative marking
-   rank change
-   tie-break

------------------------------------------------------------------------

## M3 --- PAYMENTS AND ENTITLEMENTS

Make:

``` text
Entitlement
```

the only authoritative per-test access mechanism.

Access rule:

``` text
test.isFree
OR admin
OR active entitlement matching test season
```

Do not use `User.isPaid` for authorization.

Remove Google Sheets as payment authority.

Remove:

``` text
paidSheetService
syncGoogleSheetPayments
/admin/sync-sheets
/admin/payments/sync
PAID_SHEETS_*
isSheetVerified
```

unless a specific migration compatibility requirement is proven.

Create/rewrite:

``` text
POST /api/internal/access/provision
POST /api/internal/access/revoke
```

Use:

``` text
INTERNAL_API_SECRET
```

with constant-time comparison.

Because constant-time comparison normally requires equal-length buffers,
implement length-safe handling rather than directly passing arbitrary
strings to a function that throws on length mismatch.

Validate:

``` text
commerceUserId
email
resourceCode
entitlementId
idempotencyKey
```

Map `resourceCode` to a season.

Do not silently create a default season.

Provision:

``` text
PaymentRecord
→ Entitlement
→ AuditLog
```

Make the operation idempotent.

Revoke entitlement and audit it.

In the separate AceIIIT commerce repository, replace direct portal
MongoDB writes with HTTP provisioning.

Do not couple commerce directly to portal Mongoose models.

### Catalog

Return metadata for live tests.

Do not return questions/question IDs for inaccessible tests.

Do not ship the whole question bank in the catalog.

Use per-test question retrieval.

### Question lifecycle

Do not hard-delete questions referenced by live tests.

Use archived/soft-deleted states.

Ensure test runtime can still resolve referenced historical questions.

### M3 tests

Verify the six-case entitlement matrix:

-   free
-   paid without entitlement
-   correct season
-   wrong season
-   revoked
-   admin

Also test internal API:

-   missing secret
-   wrong secret
-   invalid body
-   valid request
-   replay/idempotency

------------------------------------------------------------------------

## M4 --- QOTD, EMAIL, UPLOADS, CALENDAR

### QOTD

Only choose questions from:

-   live
-   eligible
-   free/QOTD-enabled

Never return the answer before submission.

Implement:

``` text
POST /api/tests/qotd-attempt
```

Use authenticated user ID from server auth state.

Allow one attempt per day.

Return correct answer/explanation only after submission.

### Email

Create:

``` text
utils/escapeHtml.js
```

and use it for every dynamic HTML interpolation.

Create ICS escaping utility.

Prefer:

``` text
Resend primary
SMTP fallback
```

Do not keep unnecessary provider complexity.

### Uploads

Remove base64 fallback.

Allow only:

``` text
image/png
image/jpeg
image/webp
image/gif
```

Verify magic bytes.

Limit:

``` text
4MB
```

Return a controlled failure if Cloudinary is unavailable.

### Calendar

Encrypt refresh tokens with AES-256-GCM.

Key comes from:

``` text
CALENDAR_TOKEN_KEY
```

Migrate existing plaintext tokens safely.

Disconnect must revoke provider authorization.

Use HTTPS callback in production.

Preserve:

``` text
UID = <reminderId>@aceiiit.in
```

Use UTC.

Increment sequence on reschedule/cancel.

Test cancellation.

------------------------------------------------------------------------

## M5/M6 --- AUTHORIZATION, VALIDATION, AUDIT

Audit every object-ID route.

Every route must have explicit:

``` text
owner check
OR admin authorization
```

and ObjectId validation.

Create:

``` text
middleware/validate.js
```

using Zod.

Apply to:

-   seasons
-   payments
-   entitlements
-   admin filters
-   trash
-   uploads
-   internal routes
-   relevant user/test/attempt routes

Escape regex search input and cap search length.

Audit:

-   user delete/restore/purge
-   role changes
-   session revocation
-   entitlement grant/revoke
-   config changes
-   question lifecycle
-   test lifecycle
-   internal provisioning
-   payment transitions

------------------------------------------------------------------------

# M6/M7 --- GEMINI PERFORMANCE INTELLIGENCE

Use Google's official:

``` text
@google/genai
```

server-side only.

Before implementation, inspect the current official Gemini model list
and pricing documentation. Do not rely on an old model identifier.

Keep:

``` text
GEMINI_MODEL
```

configurable.

A current Flash-Lite model is preferred for this structured, high-volume
interpretation task.

Never expose:

``` text
GEMINI_API_KEY
```

to the browser.

### Services

Create:

``` text
services/analyticsService.js
services/patternDetectionService.js
services/performanceProfileService.js
services/aiInterpretationService.js
models/AttemptInterpretation.js
```

### Deterministic evidence

Compute:

-   score
-   accuracy
-   attempt rate
-   average/median time
-   time efficiency
-   section accuracy
-   topic accuracy
-   difficulty accuracy
-   historical delta
-   improvement/regression
-   high-time/low-accuracy
-   fast/low-accuracy
-   slow/accurate
-   repeated topic failure
-   difficulty sensitivity
-   question-selection problems
-   mark leakage estimate
-   error fingerprint

AI only interprets these facts.

### Privacy

AI payload must exclude:

``` text
name
email
userId
attemptId
question text
question options
explanations
payment information
authentication information
```

Send only structured aggregate evidence.

Implement a dedicated payload builder and snapshot test.

### Structured response

Use JSON response mode and a response schema.

Validate again with Zod.

Output:

``` text
headline
summary
strengths[]
priorityAreas[]
behaviorPatterns[]
nextTestStrategy[]
```

Set conservative output limits.

Reject unsupported numerical claims.

### Reliability

Timeout:

``` text
20 seconds
```

Retry:

``` text
network
429
5xx
```

Maximum:

``` text
3 attempts
```

Do not retry:

``` text
400
schema failures
invalid configuration
```

Implement a bounded circuit breaker for quota exhaustion.

Do not hardcode a provider timezone reset.

### Async execution

Submission must not wait for Gemini.

Flow:

``` text
submit
→ persist attempt
→ deterministic analytics
→ enqueue AI analysis
→ return result
```

AI result is eventually available.

If Gemini fails:

``` text
deterministic analytics remain available
```

### Storage

`AttemptInterpretation` must be isolated from `Attempt`.

AI code must have no write path to authoritative attempt fields.

### AI tests

Mock the Gemini client and test:

-   valid result
-   invalid JSON
-   schema failure
-   invented numbers
-   timeout
-   400
-   429
-   500
-   cache hit
-   duplicate submission
-   PII-free payload
-   API key redaction
-   immutable Attempt document

------------------------------------------------------------------------

## M8 --- FRONTEND, OBSERVABILITY, TESTING

Preserve the approved SVG loader.

Before deleting any canvas animation, prove it is not the actual loader.

Audit responsive layouts at:

``` text
320
360
390
430
768
1024
1280
1440
```

Fix only real problems:

-   horizontal overflow
-   double scrolling
-   modal state
-   mobile exam layout
-   admin Studio layout

Add question-bank pagination.

Add:

``` text
pino
pino-http
request ID
redaction
Sentry
```

Implement:

``` text
/health
/ready
```

Implement graceful shutdown.

Add ESLint and Prettier.

Remove obsolete verification scripts only after confirming they are
superseded.

Do not perform a frontend framework rewrite.

------------------------------------------------------------------------

# CI

Create/update:

``` text
.github/workflows/ci.yml
```

Run:

``` text
npm install
npm run lint
npm test
npm audit --omit=dev --audit-level=high
npm run build
```

where applicable.

Use Node 22.

------------------------------------------------------------------------

# DOCUMENTATION

Create/update:

``` text
README.md
ARCHITECTURE.md
SECURITY.md
TESTING.md
DEPLOYMENT.md
PRODUCTION_HARDENING.md
```

Document:

-   environment variables
-   production vs staging
-   rollback
-   database backup
-   restore procedure
-   OAuth configuration
-   payment provisioning
-   entitlement model
-   AI privacy
-   AI fallback
-   load-test results
-   residual risks

Remove obsolete references to:

``` text
OTP
Google Sheets
```

------------------------------------------------------------------------

# FINAL ACCEPTANCE CRITERIA

Do not declare the project production-ready until:

1.  all P0 findings are fixed and tested
2.  all entitlement access paths use Entitlement
3.  production authentication cannot use mocks
4.  backend source is not public
5.  exam deadlines are server-authoritative
6.  duplicate submission is idempotent
7.  QOTD cannot leak answers
8.  IDOR matrix passes
9.  internal provisioning is authenticated and idempotent
10. AI is asynchronous and optional
11. Gemini API key is server-only
12. AI payload contains no PII/question text
13. AI output is schema validated
14. AI cannot alter Attempt
15. deterministic analytics work without Gemini
16. CI passes
17. dependency audit is resolved or documented
18. load tests are recorded
19. backup/restore has been tested
20. production deployment checklist is complete

For every unresolved item, classify:

``` text
OPEN
PARTIAL
NOT VERIFIED
ACCEPTED RISK
```

Never hide uncertainty.

At the end, produce a final report containing:

``` text
Executive summary
Implemented changes
Tests executed
PASS/FAIL/PARTIAL/NOT VERIFIED matrix
Remaining risks
Changed files
Migration requirements
Deployment checklist
Rollback plan
Unverifiable production items
```

------------------------------------------------------------------------

# 32. Recommended Git strategy

Do not create one enormous unreviewable commit.

Recommended:

``` text
hardening: establish test baseline
security: harden authentication and sessions
security: isolate public assets and secrets
integrity: make exam sessions server authoritative
commerce: migrate to backend-native entitlements
security: harden qotd email uploads calendar
security: complete idor validation and audit
ai: add deterministic performance intelligence
ai: integrate Gemini interpretation
ops: add observability and CI
test: add production verification matrix
docs: document production deployment
```

This makes rollback and code review substantially safer.

------------------------------------------------------------------------

# 33. Final recommendation

The plan should be treated as a **security/integrity program**, not
merely a feature implementation project.

The most important architectural invariants are:

``` text
Authentication → server-authoritative
Authorization → Entitlement-authoritative
Exam state → server-authoritative
Timing → server-authoritative
Ranking → server-computed
Payment → backend-native
AI → interpretation-only
AI failure → never breaks submission
Audit → append-only evidence
Secrets → server-only
```

If those invariants hold, ACEIIIT has a credible production foundation.

If they do not, polishing the frontend, adding AI, or increasing
infrastructure capacity should wait.
