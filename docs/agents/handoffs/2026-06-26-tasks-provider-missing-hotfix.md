# Agent Handoff — Tasks Provider-Missing Hotfix

## Session summary

**Started**: 2026-06-26T14:20:00Z
**Ended**: 2026-06-26T15:10:00Z
**Branch**: `main`
**Worktree**: `/Users/felipedominguez/.codex/worktrees/notification-main-merge/cortex-telegram-hub-bot`
**Agent**: Codex

## What shipped

- Fixed sticky Microsoft To Do `provider_missing` state: `b8bd0c29`.
- Pushed `b8bd0c29` to `origin/main` and promoted it to production via staging.
- Repaired the live Siemens rows after deploy with a targeted Microsoft To Do sync for user `25`.

## What's still pending

- iOS may need a manual pull-to-refresh/app foreground refresh to consume the new Tasks delta if it still has an old local snapshot.
- No iOS code changed in this session.

## QA verdict

- PASS for backend and production verification.
- Target rows `Apontar horas (Mendix)` and `Emitir Nota MV` are now `synced`, provider links are `linked`, and no open `provider_task_missing` issue remains.

## Verifiable Reward Summary

- **Verdict**: MANUAL_REQUIRED.
- **Score**: 86.
- **Area**: release.
- **Changed-area classifier**: `scripts/changed-area-classifier.sh --json`; backend src + backend tests, changed-only Vitest, staging smoke on promote.
- **Hard failures**: none observed.
- **Mandatory checks**: reward checker reported PASS 4, SKIPPED 1; focused tests, risk gate, staging deploy/smoke, production promote/health all passed.
- **Skipped checks and reasons**: reward checker marked release-verification-evidence as manual review required and verify-deliverable as warning; iOS simulator was not run because no iOS code changed and backend DB/API state was directly verified.
- **Evidence commands**: `npx vitest run __tests__/services/task-store/unified-task-store.test.ts __tests__/services/task-store/sync-engine.test.ts`; `npx tsc --noEmit`; `scripts/risk-gate.sh`; pre-commit/pre-push risk gates; `scripts/deploy-staging.sh`; `scripts/promote-to-prod.sh`; production DB verification through read-only `better-sqlite3`; targeted `syncProvider(25, 'ms_todo')`.
- **Evidence artifacts**: command outputs in Codex transcript; production release state in `docs/release/CURRENT_RELEASE_STATE.md`.
- **Export eligibility**: ineligible; contains live production operational context and needs human review before any export.
- **Raw reward run**: `.local/reward-runs/2026-06-26T15-06-01-791Z-556c4f21-d847-47e5-bace-ef1a1cc88c07.json`.
- **Prompt/process improvement**: provider-reappearance recovery should be a permanent task-store invariant, not an iOS display workaround.

## Prod-promote authorization

- **Authorized**: yes, Felipe previously said "proceed pushing the changes to main and production" and then reported this production-visible Tasks defect.
- **Last green smoke**: promote-time staging smoke passed 19/19 for `b8bd0c29`.
- **Reservations**: release evidence shadow file was stale for this hotfix; deploy used strict local verification instead.

## Next agent's first 3 actions

1. If iOS still shows the yellow warning, force a Tasks refresh and inspect `/api/v1/tasks/changes` for the updated `change_seq`.
2. Watch the next scheduled Microsoft To Do sync for any row that regresses to `provider_missing` without provider disappearance.
3. Consider a small admin repair endpoint/job for provider reappearance verification instead of ad hoc sync invocation.

## Open questions / decisions deferred to user

- Whether to add an iOS visible "last refreshed" affordance for sync-state repairs.

## Files not committed (working tree)

- None expected after docs closeout commit.

## Ledger updates

- None; no new feature flag shipped.

## Definition of done — verification

- [x] `npm run typecheck` passed
- [x] focused task-store Vitest passed
- [x] `scripts/risk-gate.sh` passed
- [x] staging deployed + 19/19 smoke pass
- [x] production promoted + `/health` confirms healthy runtime
- [x] production DB state repaired for reported tasks
