# Wave 1 Launch Readiness Sweep Closeout

Status: READY_FOR_HOSTILE_QA
Date: 2026-05-10

## Branches

- Engine branch: `launch-readiness-sweep-2026-05`
- Engine backup tag: `backup/launch-readiness-sweep-before-20260510-0025`
- Engine source commit: `9d39ae33`
- iOS branch: `phase2b4-ios-repository-primitive-2026-05`
- iOS backup tag: `backup/phase2b4-single-flight-before-20260510-0025`
- iOS follow-up commit: `0ab5b00`

Production was not touched. Main was not pushed. TestFlight was not cut.

## Task A: CachedResource Single-Flight Test

Status: complete on the existing iOS Phase 2B.4 branch.

Implementation:
- Added `testConcurrentLoadsShareSingleFetch` in
  `Nexus HubTests/CachedResourceTests.swift`.
- The test dispatches two concurrent `CachedResource.load` calls, holds the
  first fetch on a continuation, and proves both callers share one fetch.
- The test asserts one fetch invocation, both callers receive the shared value,
  and at least one outcome is `.fetched`.

Evidence:
- Focused Xcode suite PASS: `CachedResourceTests` 7/7.
- xcresult:
  `/Users/felipedominguez/Library/Developer/Xcode/DerivedData/Nexus_Hub-cmfnspevpqheawbspbjptrzkfwxy/Logs/Test/Test-Nexus Hub-2026.05.10_00-26-07-+0100.xcresult`

Test count delta: `CachedResourceTests` moved from 6 to 7 tests.

## Task B: Partial Apple Health Sufficiency

Status: complete.

Implementation:
- Added partial Apple Health seed helper and six parametric cases in
  `__tests__/security/garmin-tenant-leak-and-apple-health-cascade.test.ts`.
- Cases: `hrvOnly`, `sleepOnly`, `rhrOnly`, `hrvSleep`, `hrvRhr`,
  `sleepRhr`.
- Each case seeds only the named subset, calls `calculateReadiness`, and asserts
  a non-neutral Apple Health readiness result with positive score.

Evidence:
- Focused B+D suite PASS: 2 files / 14 tests.
- P0 Garmin/Apple Health suite PASS: 12/12.

Test count delta: P0 Garmin/Apple Health cascade suite moved from 6 to 12
tests.

## Task C: Amazon/Uber Filesystem Session Audit

Status: complete, dirty follow-up opened.

Audit memo:
`docs/archive/2026-05/launch-readiness-sweep/provider-filesystem-session-audit.md`

Verdicts:
- Amazon collector: `dirty-different-mechanism`.
- Uber collector: `dirty-different-mechanism`.

Summary:
- Both collectors use global Playwright filesystem sessions plus global
  credentials.
- Scheduled collection is owner-only through `getOwnerTenantIds()`.
- Manual Telegram `/amazon` and `/uber` commands can invoke those global
  sessions under any authenticated canonical user ID.
- This is not Garmin-style provider token-table contamination, but it is a
  finance collector tenant-safety follow-up before broad multi-user finance
  rollout.

Recommendation: `scoped-architecture-round`. No collector fix was made in this
launch sweep by design.

## Task D: Garmin Tenant Isolation Watcher

Status: complete and staged.

Implementation:
- Added `src/services/garmin-tenant-isolation-watcher.ts`.
- The watcher runs `node scripts/cleanup-tainted-garmin-sessions.mjs` without
  `--yes`, parses the dry-run JSON, and alerts only when `matchedCount > 0`.
- Positive matches write a warning to `error_log` through `captureError` and
  create/update a durable operator alert through `recordOperatorAlert`.
- Added daily scheduler registration and cron at `45 6 * * *`.
- Added unit coverage in
  `__tests__/services/garmin-tenant-isolation-watcher.test.ts`.

Evidence:
- Focused watcher suite PASS: 2/2.
- Scheduler watcher import/registration slice PASS with
  `scheduler-user-scope.test.ts`: 16/16.
- Pre-commit focused engine slice PASS: 26 files / 249 tests.
- Typecheck PASS.
- Staging positive-path watcher probe PASS:
  `docs/release/smoke-evidence/staging-garmin-tenant-isolation-watcher-20260509T233855Z.json`

Staging watcher probe notes:
- Injected a dry-run result with one synthetic matched row.
- Verified one `error_log` warning row and one durable operator alert row.
- Deleted the synthetic staging probe rows before closeout.

## Validation Evidence

- `npx tsc --noEmit --pretty false`: PASS.
- Focused B+D vitest: PASS, 2 files / 14 tests.
- iOS Task A focused Xcode suite: PASS, 7/7.
- Pre-commit focused engine suite: PASS, 26 files / 249 tests.
- `node scripts/vi-mock-completeness-lint.mjs --strict`: PASS at 826 partial
  mocks, below the 827 strict baseline.
- `npm run docs:audit`: PASS, 436 issues under the 480 ceiling after mirror
  sync.
- Staging deploy: PASS.
- Staging soak: 5 minutes.
- Staging smoke: PASS, 17 passed / 0 failed / 17 total.
- Staging smoke evidence:
  `docs/release/smoke-evidence/staging-smoke-9d39ae33-20260509T233738Z.json`

## Cleanup Contract

- Production untouched.
- Engine `main` untouched.
- iOS `main` untouched.
- No TestFlight build cut.
- Staging synthetic watcher probe rows were removed after evidence capture.
- No long-running local simulator, DB, tunnel, or loop process intentionally
  left running by this sweep.

## Follow-Ups

- Operator hostile QA on this branch.
- Production promotion is operator-gated and not performed in this round.
- Open a focused finance collector tenant-safety follow-up for Amazon/Uber
  global browser sessions before broad multi-user finance rollout.
- Operator can decide whether to cherry-pick/push the iOS `CachedResource`
  single-flight test commit into the active Phase 2B.4 branch remote.

## Production Promote Addendum

Date: 2026-05-10.

Production promote status: complete.

Production version after promote: `4.14.147`.

Production deploy commit: `95a42c80`.

Staging re-validation:
- Branch pushed: `launch-readiness-sweep-2026-05`.
- Backup tag pushed: `backup/launch-readiness-sweep-before-20260510-0025`.
- Staging deploy: PASS.
- Staging smoke: PASS, 17 passed / 0 failed / 19 total.
- Staging smoke evidence:
  `docs/release/smoke-evidence/staging-smoke-2703e348-20260509T235754Z.json`
- Promote-gate staging smoke evidence:
  `docs/release/smoke-evidence/staging-smoke-2703e348-20260509T235939Z.json`
  and
  `docs/release/smoke-evidence/staging-smoke-2703e348-20260510T000002Z.json`.

Watcher probe evidence:
- Positive staging probe PASS: injected one synthetic tainted Garmin token row,
  watcher returned `matchedCount: 1`, wrote one warning path, created an
  operator alert, and the synthetic row plus probe evidence rows were cleaned.
  Evidence:
  `docs/release/smoke-evidence/staging-garmin-tenant-isolation-watcher-positive-20260509T235850Z.json`
- Negative staging probe PASS: watcher returned `matchedCount: 0`, `alerted:
  false`, and wrote no new warning or alert rows. Evidence:
  `docs/release/smoke-evidence/staging-garmin-tenant-isolation-watcher-negative-20260509T235904Z.json`

Production health:
- API health returned `status: healthy`. Evidence:
  `docs/release/smoke-evidence/prod-health-launch-readiness-20260510T000541Z.json`
- Authenticated production snapshot returned version `4.14.147`. Evidence:
  `docs/release/smoke-evidence/prod-snapshot-launch-readiness-auth-20260510T001015Z.json`
- PM2 evidence shows `nexus-hub` and `content-engine` online at `4.14.147`.
  Evidence:
  `docs/release/smoke-evidence/prod-pm2-launch-readiness-20260510T000614Z.json`

Production watcher cold-start:
- Manual watcher invocation returned `matchedCount: 0`, `alerted: false`.
- No new watcher warning rows were written to `error_log`.
- No new `garmin_tenant_isolation_watcher` operator alerts were written.
- Evidence:
  `docs/release/smoke-evidence/prod-garmin-tenant-isolation-watcher-cold-start-20260510T001046Z.json`

Main reconcile:
- `origin/main` was fast-forwarded to production deploy commit `95a42c80`.
- Full pre-push vitest gate passed during the main reconcile push: 493 files /
  7165 tests.

iOS Task A reconciliation:
- Deferred to operator decision. No iOS cherry-pick, merge, push, or TestFlight
  cut was performed in this production promote round.
