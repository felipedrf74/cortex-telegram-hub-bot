# Training Release Candidate Test Coverage Gaps

Date: 2026-04-28

## Covered In This Run

- Full backend typecheck and test suite via `npm run verify`.
- Training engine, lifecycle, calendar/agenda, identity, constrained-week, profile, feedback, catalog, recovery, cross-skill, and security tests as included in the 380-file backend suite.
- Training coach-quality evaluation harness across 156 persona/scenario cases.
- Calendar staging smoke harness execution path and prerequisite detection.
- Cross-skill staging smoke local fixture contract checks and prerequisite detection.
- iOS focused Training rich-payload and feedback tests are documented separately in `docs/ios/release-candidate-local-ios-smoke-results.md`.

## Remaining Gaps

| Priority | Gap | Current Evidence | Required Closure |
| --- | --- | --- | --- |
| Closed | Real Google Calendar staging lifecycle | Passed: `training-calendar-smoke-20260428165035-7ljwng`, with provider read-back and cleanup. | Keep production-safe post-deploy provider check. |
| Closed | Real Outlook Calendar staging lifecycle | Passed: `training-calendar-smoke-20260428165107-7fsbbr`, with provider read-back and cleanup. | Keep production-safe post-deploy provider check. |
| Closed | Real cross-skill staging tenant flow | Passed: `training-cross-skill-smoke-20260428164946-829lm7`, with seeded staging fixture cleanup verified. | Keep production-safe shared-context monitoring. |
| P2 | Fully authenticated local iOS backend smoke | iOS local smoke used deterministic Training fixtures with local backend online. Non-Training calls can still show debug-only local auth errors because `NEXUS_SKIP_AUTH=1` does not seed a backend user/token. | Add a local seeded test user/token path or fixture-feed Home during local smoke. |
| P2 | Poor-recovery minute-level estimator precision | Eval score remains high, but poor-recovery minimum-dose sessions are the lowest scoring cases. | Add targeted evaluator/test coverage for minimum-dose claimed duration versus estimated content. |

## Release Gate Interpretation

The automated unit/integration/evaluation layer is strong enough for a release-candidate code review. It is not enough for production promotion until the real staging provider and cross-skill gates are run or explicitly waived by the team.
