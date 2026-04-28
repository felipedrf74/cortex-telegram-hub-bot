# Training Release Candidate Failures

Date: 2026-04-28

## Resolved During This Run

| Severity | Area | Failure | Root Cause | Fix | Current Status |
| --- | --- | --- | --- | --- | --- |
| P1 test gate | Backend calendar persistence test | `npm run verify` failed in `__tests__/api/training-plan-persistence.test.ts`. | Test expected pre-hardening log payload containing raw `title`; implementation now redacts title and logs scoped IDs. | Updated assertion to verify `userId`, `planId`, `planVersion`, `sessionId`, and absence of `title`. | Fixed; focused tests and full verify passed. |
| P1 test gate | Backend calendar persistence test isolation | Full-suite `npm run verify` later exposed cross-test env contamination from Training calendar kill-switch flags, causing event writes to short-circuit in persistence tests. | The persistence test did not explicitly own the Training calendar operational-switch env it depends on. | Added explicit env cleanup for Training engine/calendar write/sync flags in the persistence suite `beforeEach`. | Fixed; related suites and full verify passed. |

## Open Release Blockers

| Severity | Area | Failure / Blocker | Evidence | Required Closure |
| --- | --- | --- | --- | --- |
| None | Calendar and cross-skill staging | Former Google, Outlook, and cross-skill staging blockers are closed. | `docs/training/final-calendar-staging-results.md`; `docs/training/final-cross-skill-staging-results.md`. | Keep provider post-deploy checks in the release runbook; no open staging blocker remains. |

## Non-Blocking Quality Follow-Ups

| Severity | Area | Finding | Evidence | Suggested Next Step |
| --- | --- | --- | --- | --- |
| P2 | Poor-recovery time-volume precision | Evaluation harness still flags some minimum-dose poor-recovery sessions as claiming more time than estimated content supports. | Lowest case `advanced-strength-focused__poor-recovery`, 90/100. | Tighten poor-recovery estimator or enrich minimum-dose blocks so claimed durations match work content more precisely. |

## Not Observed

- No backend typecheck failures after the test-only assertion update.
- No backend unit/integration failures after rerun.
- No evaluation harness P0/P1 failures.
- No evidence of broad calendar deletion or duplicate event behavior in automated mocks; real Google and Outlook staging provider proof has now passed.
