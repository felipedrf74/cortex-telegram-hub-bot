# 2026-07-09 Paid Coach Briefing Production Handoff

Scope: close coach briefing QA findings, push the scoped backend release to
`main`, and deploy it to the production VPS without rerunning the full backend
suite.

What shipped:

- Commit `9c68db5a` is on `origin/main` and live on production `4.14.215`.
- Cron and on-demand coach briefings require both an active workout plan and an
  eligible Pro/Max entitlement.
- Free, owner-only, beta-trial, expired, and no-active-plan users stop before
  cache, calendar, LLM, report, push, conversation, or coach-state work.
- Founder Pro/Max assignments remain eligible.
- Coach input/output is compacted, visible ISO ranges are normalized to
  start/end/duration, and malformed recommendation tails are removed.

Verification:

- Focused coach/API/entitlement tests: 153 passed.
- Protected pre-commit matrix: 156 files / 2,338 tests passed.
- Changed dependency pass: 61 files / 1,383 tests passed.
- Typecheck, build, migration safety (216), backup, SQLite integrity, native
  binding, PM2 stability, and readiness checks passed.
- Public `/health` is healthy; production artifact digest matches local at
  `2f2b0869e98522ad914cdb8cc6fb6ff1b4da33266caa437bf9f999874f9da88d`.

Still in flight / caveats:

- Staging deploy/smoke, live coach generation, live APNs delivery, and
  production calendar writes were not run for this scoped release.
- PM2 reported historical restart counters of 57 (`nexus-hub`) and 7
  (`content-engine`), with no restart during the deploy stability sample.

Next actions:

1. Observe the next eligible daily coach briefing for delivery and formatting.
2. Confirm a Free/no-plan account receives neither a report nor notification.
3. Run the local-LLM benchmark separately; this release does not change model
   routing.

## Verifiable Reward Summary

- **Verdict**: WARN on the final advisory run; manual human review is required
  before reward export.
- **Score**: 98.
- **Area**: backend.
- **Changed-area classifier**: passed and classified the remaining changes as
  release documentation only.
- **Hard failures**: none.
- **Mandatory checks**: PASS 4, NOT_APPLICABLE 1; no mandatory check failed.
- **Skipped checks and reasons**: `verify-deliverable` emitted an advisory
  warning because this handoff does not declare a separate L1-L5 claim level.
  Production calendar writes, live coach generation, live APNs, and staging
  smoke remain explicit release-scope omissions rather than skipped reward
  checks.
- **Evidence**: focused and protected test matrices, typecheck, build, deploy
  validation, public health, PM2 state, artifact digest, docs audit, and the
  advisory reward run are recorded above.
