# Training Release Candidate Test Run

Date: 2026-04-28
Backend branch: `release/training-engine-production-hardening` / `release/training-engine-production-candidate` at `b8f9be7`
iOS branch used for local smoke: `release/ios-training-engine-local-smoke-candidate` at `537abf6`
Deployment: not run

## Summary

The automated backend gate is green after two test-only corrections. The first full backend verification exposed an outdated calendar-persistence test that expected a raw session title in warning logs. The production behavior had already been hardened to log scoped IDs instead of calendar/session title text, so the assertion was updated to verify `userId`, `planId`, `planVersion`, `sessionId`, and absence of `title`. A later full-suite run exposed cross-test environment contamination from Training calendar kill-switch flags; the persistence suite now clears the relevant operational-switch env in `beforeEach`.

The Training evaluation harness passed with a 99/100 aggregate quality score across 156 persona/scenario cases. Real Google/Outlook calendar staging and seeded cross-skill staging gates have since passed; the release still requires production-predeploy snapshot and production-safe post-deploy validation.

## Commands And Results

| Area | Command | Result | Release-blocking status |
| --- | --- | --- | --- |
| Backend full verify, first run | `npm run verify` | Failed in `__tests__/api/training-plan-persistence.test.ts`; stale privacy-era assertion expected raw `title` in calendar failure logs. | Fixed and rerun. |
| Focused backend retest | `npx vitest run __tests__/api/training-plan-persistence.test.ts __tests__/utils/logger-redaction.test.ts` | Passed: 2 files / 8 tests. | Clear. |
| Backend full verify, final run | `npm run verify` | Passed: typecheck plus 383 test files / 6,001 tests. | Clear. |
| Training eval harness | `npm run eval:training` | Passed: 99/100, 156 cases. | Clear, with P2 quality follow-up below. |
| Backend commit hook validation | `npm run typecheck` and `npm test` | Passed while creating `b8f9be7`; latest full verify passed 383 files / 6,001 tests after staging-gate updates. | Clear. |
| iOS full scheme | `xcodebuild test -project "Nexus Hub.xcodeproj" -scheme "Nexus Hub" -sdk iphonesimulator -destination "platform=iOS Simulator,name=iPhone 17 Pro"` | Passed on `537abf6`; result bundle `Test-Nexus Hub-2026.04.28_14-09-36-+0100.xcresult`. | Clear for local pre-release compatibility. |
| Google/Outlook staging calendar smoke | `node dist/tools/training-calendar-staging-smoke.js` on staging with approved provider env | Passed Google run `training-calendar-smoke-20260428165035-7ljwng` and Outlook run `training-calendar-smoke-20260428165107-7fsbbr`. | Clear for staging gate. |
| Cross-skill staging smoke | `node dist/tools/training-cross-skill-staging-fixtures.js` seed/cleanup plus `node dist/tools/training-cross-skill-staging-smoke.js` | Passed seeded staging run `training-cross-skill-smoke-20260428164946-829lm7`; cleanup verified zero fixture rows/plans. | Clear for staging gate. |

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
