# Tasks Section Deep QA Handoff

Date: 2026-06-24
Scope: Tasks section backend contract, iOS repository/cache behavior, local-engine simulator E2E, and cleanup inspection.

## Verdict

PASS_WITH_WARNINGS.

The task active/completed separation and provider-missing warning leak are fixed and verified locally. Production Microsoft To Do writes were not run. The docs audit still reports the repository's pre-existing documentation hygiene warning backlog.

## Implemented

- Backend active list counts and list pages now exclude completed-like statuses before counting or page limiting.
- Backend completed/history reads still include completed-like rows where completed scope is requested.
- Backend DTO projection suppresses persisted `provider_task_missing` warnings for completed/cancelled rows.
- Backend status normalization now maps `complete` and `done` to completed DTO status.
- iOS UI tests can target the local engine through the local debug-auth import path.
- iOS Overdue smart view has a stable accessibility identifier for E2E.
- Local-engine UI test covers overdue completion, relaunch into Completed, reopen, and return to Overdue.
- Canonical offline-first Tasks architecture doc records the active/completed and provider-missing warning contract.

## Files Changed

- `src/services/task-store/offline-first-task-service.ts`
- `__tests__/services/task-store/offline-first-task-service.test.ts`
- `docs/engineering/offline-first-tasks-architecture.md`
- Adjacent iOS checkout: `Nexus Hub/Views/Tasks/TaskListView.swift`
- Adjacent iOS checkout: `Nexus HubUITests/LocalEngineUITestHelpers.swift`
- Adjacent iOS checkout: `Nexus HubUITests/TaskCompletedSurfaceUITests.swift`

## Verification Evidence

| Check | Environment | Result | Artifact |
| --- | --- | --- | --- |
| `npm run typecheck` | Backend local | PASS | command output |
| `npx vitest run __tests__/services/task-store/offline-first-task-service.test.ts` | Backend local | PASS, 15 tests | command output |
| Focused task backend Vitest slice | Backend local | PASS, 6 files / 56 tests | command output |
| `scripts/changed-area-classifier.sh --json` | Backend local | PASS, scoped to backend task service/test/doc | command output |
| `scripts/risk-gate.sh` | Backend local | PASS, changed-only typecheck + 6 files / 60 tests | command output |
| Local-engine provider-missing completed probe | Docker local engine | PASS, no Overdue leak and no completed warning leak | command output |
| Focused iOS unit tests | iPhone 17 Pro Max simulator | PASS, 81 tests | `/tmp/nexus-task-unit-deep-focused.xcresult` |
| Focused local-engine iOS UI tests | iPhone 17 Pro Max simulator | PASS, 6 tests | `/tmp/nexus-task-ui-local-engine-deep-final.xcresult`; summary `/tmp/nexus-task-ui-local-engine-deep-final-summary.json` |
| Local sandbox QA residue check | Docker local engine | PASS, 0 matching leftover QA rows | command output |
| `npm run docs:audit` before and after doc edit | Backend local | PASS command exit with existing warnings | command output |
| Verifiable reward check | Backend local | Initial run required handoff evidence | `.local/reward-runs/2026-06-24-task-section-deep-qa-release.json` |

## Coverage Matrix

| Area | Coverage |
| --- | --- |
| Backend read models | Snapshot, lists, list scope, filtered Overdue, completed history, completed-like status variants |
| Backend mutations | Create, complete, delete cleanup through local-engine API and tests |
| Provider sync | Provider-missing completed warning suppression, task-sync issue persistence, reconciliation-related tests in focused slice |
| iOS repository/cache | Active/completed separation, stale completed upserts, list-cache dedupe, completed history, mutation invalidation, outbox scope |
| iOS UI | Tasks home, Overdue, Completed, new task sheet, swipe delete confirmation, relaunch after completion |
| Offline/outbox | Unit coverage for persisted outbox and tenant switch namespace isolation |
| Account isolation | Unit coverage for repository scope invalidation and outbox/cache scope switching |
| Visual/accessibility | Stable Overdue smart-view identifier; UI smoke confirms row movement and surfaces render |
| Dead-code/cleanup | No safe deletion made; candidates classified below |

## Findings

| Severity | Area | Finding | Status |
| --- | --- | --- | --- |
| P1 | Backend read model | Completed/provider-missing rows could still expose persisted `provider_task_missing` warnings in completed DTOs. | Fixed |
| P1 | Backend list read | Completed-like rows could fill a page before active filtering, hiding active rows from list pages. | Fixed |
| P2 | Backend list count | Active list counts only excluded literal `completed`, not variants like `done` or `cancelled`. | Fixed |
| P3 | Docs | Offline-first Tasks doc did not state the completed-like filter/warning contract. | Fixed |
| P3 | Docs audit | Repo docs audit has pre-existing warning backlog. | Deferred, unrelated |

## Cleanup Candidates

| Candidate | Classification | Evidence | Recommendation |
| --- | --- | --- | --- |
| Backend and iOS both filter completed-like smart-view rows | Keep | `offline-first-task-service.ts` and `TaskRepositoryDueTodayUnionTests` show server contract plus client defense-in-depth | Keep until provider deltas are proven consistently normalized |
| Task list count fallback resolver vs backend `activeCountsByList` | Keep | `TaskListCountResolverTests` cover fallback when server count is unavailable | Keep; not dead code |
| Repeated fixture-app setup in Tasks UI tests | Safe cleanup later | `TaskCompletedSurfaceUITests` and `TaskSwipeDeleteConfirmationUITests` each build fixture apps | Optional consolidation only; not required for release |
| Legacy native task backfill path | Keep for compatibility | Existing tests verify native task migration and edit preservation | Do not remove |

## Deferred

- No production Microsoft To Do writes.
- No live Hotmail/calendar writes.
- No full app-wide test suite.
- No TestFlight release.
- No unrelated docs audit backlog cleanup.

## Verifiable Reward Summary

- **Verdict**: WARN
- **Score**: 98
- **Area**: backend
- **Changed-area classifier**: `scripts/changed-area-classifier.sh --json` passed; changed files are scoped to Tasks backend code, Tasks regression tests, and Tasks docs/handoff.
- **Hard failures**: none observed.
- **Mandatory checks**: `npm run docs:audit` passed with existing warnings; backend evidence review has typecheck, focused Vitest, risk gate, local-engine API probe, and iOS simulator evidence.
- **Skipped checks and reasons**: no production Microsoft To Do writes, live provider writes, TestFlight, full app-wide suite, or unrelated docs cleanup; all are intentionally out of scope for this focused local/staging-safe QA.
- **Evidence commands**: `npm run typecheck`; focused task Vitest; `scripts/risk-gate.sh`; local-engine provider-missing completed probe; focused iOS unit tests; focused iOS local-engine UI tests; `npm run docs:audit`.
- **Evidence artifacts**: `/tmp/nexus-task-unit-deep-focused.xcresult`; `/tmp/nexus-task-ui-local-engine-deep-final.xcresult`; `/tmp/nexus-task-ui-local-engine-deep-final-summary.json`; raw reward JSON under `.local/reward-runs/`.
- **Export eligibility**: ineligible; manual human review required before export.
- **Prompt/process improvement**: keep provider-missing completed suppression verified at backend DTO level and local-engine simulator level before deploy.
