# Training Release Candidate Test Run

Date: 2026-04-28  
Backend branch: `release/training-engine-production-hardening` at `d0d0c41`  
iOS branch used for local smoke: `feature/ios-training-local-engine-smoke` at `f7da7b7`  
Deployment: not run

## Summary

The automated backend gate is green after one test-only correction. The first full backend verification exposed an outdated calendar-persistence test that expected a raw session title in warning logs. The production behavior had already been hardened to log scoped IDs instead of calendar/session title text, so the assertion was updated to verify `userId`, `planId`, `planVersion`, `sessionId`, and absence of `title`.

The Training evaluation harness passed with a 99/100 aggregate quality score across 156 persona/scenario cases. Real Google/Outlook and cross-skill staging gates remain blocked by missing staging prerequisites, so this run does not claim full release readiness.

## Commands And Results

| Area | Command | Result | Release-blocking status |
| --- | --- | --- | --- |
| Backend full verify, first run | `npm run verify` | Failed in `__tests__/api/training-plan-persistence.test.ts`; stale privacy-era assertion expected raw `title` in calendar failure logs. | Fixed and rerun. |
| Focused backend retest | `npx vitest run __tests__/api/training-plan-persistence.test.ts __tests__/utils/logger-redaction.test.ts` | Passed: 2 files / 8 tests. | Clear. |
| Backend full verify, final run | `npm run verify` | Passed: typecheck plus 380 test files / 5,981 tests. | Clear. |
| Training eval harness | `npm run eval:training` | Passed: 99/100, 156 cases. | Clear, with P2 quality follow-up below. |
| Google/Outlook staging calendar smoke | `npm run smoke:training-calendar:staging` | Blocked with exit code 2 by missing staging env/secrets. No provider lifecycle was run. | Release blocker unless provider gate is waived. |
| Cross-skill staging smoke | `npm run smoke:training-cross-skill:staging` | Local fixture contract checks passed; runtime staging smoke blocked with exit code 2 by missing staging env/database user. | Release blocker unless staging gate is waived. |

## Fix Applied During Test Run

File: `__tests__/api/training-plan-persistence.test.ts`

The calendar failure log assertion now checks only safe scoped identifiers and verifies that the warning payload does not include `title`. This aligns the test with the privacy/telemetry hardening already in the code.

## Staging Gate Status

Calendar staging prerequisites still missing:

- `STAGING=true` or `NODE_ENV=staging`
- `TRAINING_CALENDAR_STAGING_SMOKE=1`
- `TRAINING_CALENDAR_STAGING_ALLOW_LIVE_WRITES=1`
- `TRAINING_CALENDAR_STAGING_USER_ID=<staging user id>`
- `OAUTH_ENCRYPTION_KEY`
- `DATABASE_PATH=<staging database path>`
- `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`
- `OUTLOOK_CLIENT_ID` and `OUTLOOK_CLIENT_SECRET`

Cross-skill staging prerequisites still missing:

- `STAGING=true` or `NODE_ENV=staging`
- `TRAINING_CROSS_SKILL_STAGING_SMOKE=1`
- `TRAINING_CROSS_SKILL_STAGING_USER_ID=<staging test user id>`
- `DATABASE_PATH=<staging database path>`

## Release Candidate Verdict

Automated backend regression and evaluation gates passed. The release candidate is not fully releasable yet because real staging proof for Google/Outlook calendar lifecycle and cross-skill orchestration is still missing.

