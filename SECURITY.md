# Security

This file tracks the security posture of the ACEIIIT Mock Portal during production hardening.
The full plan, findings and decisions are in `AGENT_HANDOFF_PRODUCTION_HARDENING.md`.

## Reporting a vulnerability

Email the portal owner and don't open a public issue. Include the steps to reproduce and the affected endpoint.

## Dependency audit

Run from `backend/`:

```bash
npm audit --omit=dev   # production dependencies (must be 0 high/critical)
npm audit              # includes dev-only tooling
```

### Baseline (2026-10-06, before M0)

`npm audit --omit=dev` reported 8 vulnerabilities (1 critical, 3 high, 4 moderate):

| Package | Severity | Issue |
|---|---|---|
| proxy-addr ≤2.0.7 | critical | IP spoofing via IPv4-mapped IPv6 trust subnet |
| compression <1.8.2 | high | DoS via memory leak on premature close |
| multer ≤2.2.0 | high | DoS via nested/crafted field names, incomplete cleanup of aborted uploads |
| nodemailer ≤10.0.5 | high | SMTP command injection, unintended-domain delivery |
| mongoose 8.0.0–8.24.0 | moderate | Prototype pollution in update casting |
| morgan ≤1.12.0 | moderate | Log forging/injection |
| qs ≤6.15.3 | moderate | DoS, array-limit bypass |

### After M0

`npm audit --omit=dev` reports **0 vulnerabilities**. What changed:
- `npm audit fix`, run without `--force`
- `compression` ^1.8.2, `multer` ^2.4.0, `morgan` ^1.12.1, `mongoose` ^8.24.5, `express` ^4.22.3 (pulls in fixed `qs` and `proxy-addr`)
- `nodemailer` 6.10 → **^10.0.15**. This is a deliberate major bump. The portal only uses `createTransport({host,port,secure,auth})` and `sendMail({from,to,subject,html})`, which are unchanged; checked with a JSON transport. nodemailer 10 needs Node ≥ 20, and the dev machine runs Node 22.

**Accepted residual risk:** `npm audit` (including dev dependencies) reports 1 moderate issue in `sprintf-js`, which comes in transitively through test tooling. It never ships to production.

## Known open issues

Application-level findings (auth bypasses, exposed source, session revocation, exam integrity and so on) are listed with severity and status in §5 of `AGENT_HANDOFF_PRODUCTION_HARDENING.md`. Each one is fixed by a numbered milestone and covered by regression tests. The defects that are still open are pinned as executable assertions in `backend/tests/characterization/known-issues.test.js`. Each assertion is flipped into a regression test when its fix lands.
