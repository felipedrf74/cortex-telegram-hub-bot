# Training Release Candidate Failures

Date: 2026-04-28

## Resolved During This Run

| Severity | Area | Failure | Root Cause | Fix | Current Status |
| --- | --- | --- | --- | --- | --- |
| P1 test gate | Backend calendar persistence test | `npm run verify` failed in `__tests__/api/training-plan-persistence.test.ts`. | Test expected pre-hardening log payload containing raw `title`; implementation now redacts title and logs scoped IDs. | Updated assertion to verify `userId`, `planId`, `planVersion`, `sessionId`, and absence of `title`. | Fixed; focused tests and full verify passed. |

## Open Release Blockers

| Severity | Area | Failure / Blocker | Evidence | Required Closure |
| --- | --- | --- | --- | --- |
| P1 / release gate | Google Calendar staging lifecycle | Real Google staging smoke did not run. Harness exited 2 because staging env/secrets were missing. | `npm run smoke:training-calendar:staging`; `docs/training/calendar-staging-smoke-results.md`. | Provide staging credentials/env and rerun create/read-back/update/regenerate/cancel/cleanup. |
| P1 / release gate | Outlook Calendar staging lifecycle | Real Outlook staging smoke did not run. Same missing staging prerequisites. | `npm run smoke:training-calendar:staging`; `docs/training/calendar-staging-smoke-results.md`. | Provide staging credentials/env and rerun full provider lifecycle. |
| P1 / release gate | Cross-skill staging orchestration | Local fixture contracts passed, but runtime staging smoke did not run because staging DB/user/env were missing. | `npm run smoke:training-cross-skill:staging`; `docs/training/cross-skill-staging-smoke-results.md`. | Provide staging test tenant/user/database and rerun Secretary/Cooking/Finance/Content flows. |

## Non-Blocking Quality Follow-Ups

| Severity | Area | Finding | Evidence | Suggested Next Step |
| --- | --- | --- | --- | --- |
| P2 | Poor-recovery time-volume precision | Evaluation harness still flags some minimum-dose poor-recovery sessions as claiming more time than estimated content supports. | Lowest case `advanced-strength-focused__poor-recovery`, 90/100. | Tighten poor-recovery estimator or enrich minimum-dose blocks so claimed durations match work content more precisely. |

## Not Observed

- No backend typecheck failures after the test-only assertion update.
- No backend unit/integration failures after rerun.
- No evaluation harness P0/P1 failures.
- No evidence of broad calendar deletion or duplicate event behavior in automated mocks; real provider proof remains blocked separately.

