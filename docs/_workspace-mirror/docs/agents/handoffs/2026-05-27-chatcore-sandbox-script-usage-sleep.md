# Agent Handoff — ChatCore sandbox script, usage, and sleep fixes

## Session summary

**Started**: 2026-05-27T22:30:00+01:00  
**Ended**: 2026-05-28T00:35:20+01:00  
**Branch**: backend `codex/chatcore-v2-production-activation-wo`; iOS `main`  
**Worktree**: `/Users/felipedominguez/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot-chatcore-v2-activation` and `/Users/felipedominguez/Desktop/Nexus Hub IOS/Nexus Hub`  
**Agent**: Codex

## What shipped

- No commit/deploy shipped. Worktree-only fixes: content-engine Docker base URL, beta-provider quota resolution, percentage-only app-facing usage payloads/copy, and tolerant Apple Health sleep interval parsing.
- Updated active backend Work Order ownership for the extra scoped files.

## What's still pending

- P1: user/operator decides when to commit these worktree changes.
- P2: `nexushubbot@gmail.com` is not present in local `data/local.db`; production/staging DB should be inspected read-only before claiming that a specific existing row is beta/internal. Code now grants beta/unlimited entitlement when this configured internal email exists (`NEXUS_INTERNAL_UNLIMITED_EMAILS`, default `nexushubbot@gmail.com`).
- P2: broad `scripts/ios-single-simulator-test.sh` still has one unrelated local-engine UI failure: `HomeWeekNavigationPerformanceUITests.test_homeQuickActionsRespondWithoutStalling` cannot find `home-quick-action-add-task`. The release-hardening scheme failure from this branch was fixed and the targeted test now passes.

## QA verdict

- PASS for local sandbox behavior: script generation returns `ok=true`; `/billing/status`, `/billing/usage`, and `/dashboard` expose percent/state usage only; `/dashboard.dayDial` includes sleep after local Apple Health sleep data exists.
- Backend focused Vitest: 6 files / 168 tests passed. Backend `npx tsc --noEmit` passed. iOS Simulator focused tests: 33 passed. Targeted release-hardening rerun passed after restoring `parallelizable = "NO"` on the shared UI-test scheme entry.

## Prod-promote authorization

- **Authorized**: no
- **Last green smoke**: local endpoint smoke only; no staging/prod smoke.
- **Reservations**: no commit or deploy per user constraint.

## Next agent's first 3 actions

1. Review backend diffs in `src/services/content-engine.ts`, `src/services/plan-quotas.ts`, `src/api/routes/billing.ts`, `src/api/routes/dashboard.ts`, and `src/services/health-sleep-agenda.ts`.
2. If committing, include the matching tests: `__tests__/api/billing-routes.test.ts`, `__tests__/api/dashboard-routes.test.ts`, `__tests__/services/cost-guardrail.test.ts`, `__tests__/services/entitlement.test.ts`, `__tests__/services/home-orchestration-focus.test.ts`, `__tests__/services/python-engine-hardening.test.ts`, plus iOS entitlement files.
3. Read-only verify staging/prod account state for `nexushubbot@gmail.com` before claiming specific-account unlimited access.

## Open questions / decisions deferred to user

- Whether to hard-enforce a configured internal email allowlist for non-invite accounts; recommendation is config-driven, not hardcoded.

## Files not committed (working tree)

- Backend has this session's files plus substantial pre-existing ChatCoreV2 worktree changes.
- iOS has this session's two entitlement files plus pre-existing chat/task/QA changes.

## Ledger updates

- None. No new feature flag shipped and no production deploy occurred.

## Definition of done — verification

- [x] Backend `npx tsc --noEmit` passed
- [x] Backend focused Vitest passed (6 files / 168 tests)
- [x] iOS focused `xcodebuild test` via XcodeBuildMCP passed
- [x] Local Docker endpoint smoke passed
- [x] Session handoff created
- [x] `npm run docs:audit` exited 0 with existing baseline warnings; it also reports the new handoff as workspace-mirror-missing until the workspace mirror is refreshed
- [ ] Full `npm run verify` not run in this slice
- [x] `scripts/ios-single-simulator-test.sh` was run; it failed with 2 tests in the first run: `ReleaseHardeningConfigTests.test_sharedSchemeDoesNotAllowParallelUITestSimulatorFanout` and `HomeWeekNavigationPerformanceUITests.test_homeQuickActionsRespondWithoutStalling`
- [x] `ReleaseHardeningConfigTests.test_sharedSchemeDoesNotAllowParallelUITestSimulatorFanout` was fixed and rerun via XcodeBuildMCP: 1 passed
- [ ] `HomeWeekNavigationPerformanceUITests.test_homeQuickActionsRespondWithoutStalling` still fails in isolation; evidence: `XCTAssertTrue failed - Add Task quick action did not render.`
