---
work_order_id: WO-decision-center-execution-20260603
mode: implementation
branch: codex/decision-center-execution-20260603
worktree: /Users/felipedominguez/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot-decision-center-execution-20260603
owned_paths:
  - docs/qa/work-orders/WO-decision-center-execution-20260603.md
  - docs/qa/final-handoffs/WO-decision-center-execution-20260603-final-handoff.md
  - docs/qa/AGENT_WORK_REGISTRY.md
  - docs/qa/peer-validation/WO-decision-center-execution-20260603-peer-validation.md
  - docs/qa/prompts/claude-decision-center-execution-qa.md
  - docs/decision-center/command-bus-integration-wo.md
  - docs/release/feature-delivery-ledger.md
  - scripts/verify-deliverable.mjs
  - migrations/195_decision_lifecycle_events.sql
  - migrations/196_decision_metrics_daily.sql
  - migrations/197_decision_active_expiry_index.sql
  - migrations/198_decision_type_suppressions.sql
  - src/api/decision-api-version.ts
  - src/api/decision-cursor.ts
  - src/api/routes/decisions.ts
  - src/portal/decision-center-routes.ts
  - src/services/app-summary-read-models.ts
  - src/services/decision-command-adapter.ts
  - src/services/decision-center-semantic-dedup.ts
  - src/services/decision-center.ts
  - src/services/decision-dashboard.ts
  - src/services/decision-relationship-types.ts
  - src/services/notification-orchestrator.ts
  - src/services/runtime-flags.ts
  - src/services/scheduler.ts
  - __tests__/api/decision-api-version.test.ts
  - __tests__/api/decision-cursor.test.ts
  - __tests__/api/decisions-routes.test.ts
  - __tests__/api/event-backbone-routes.test.ts
  - __tests__/portal/portal-decision-center-routes.test.ts
  - __tests__/security/decision-prompt-injection.test.ts
  - __tests__/services/decision-center-semantic-dedup.test.ts
  - __tests__/services/decision-command-adapter.test.ts
  - __tests__/services/decision-center-command-bus-equivalence.test.ts
  - __tests__/services/decision-center.test.ts
  - __tests__/services/decision-dashboard.test.ts
  - __tests__/services/decision-relationship-types.test.ts
  - __tests__/services/event-backbone.test.ts
  - __tests__/services/notification-orchestrator.test.ts
  - __tests__/services/runtime-flags.test.ts
status: release_gate_preflight
max_claim_level: L2
---

# Work Order — Decision Center Execution Plan

Status: local verification complete; user authorized commit, main push, and production promotion on 2026-06-03. Overall claim remains local/L2 until staging smoke and production health proof are attached. No feature-flag enablement is authorized by this Work Order.

## Base And Candidate

- Base fetched from `origin/main` on 2026-06-03: `09a1c96d` (`chore: bump version to 4.14.199 [deploy]`).
- Current mode: Implementation.
- Current candidate branch/worktree: `codex/decision-center-execution-20260603` at `/Users/felipedominguez/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot-decision-center-execution-20260603`.
- Validation target: the current candidate commit/worktree only. Do not validate stale `codex/decision-center-command-bus-unblock-20260530` or stale ChatV2 activation work as if it were this candidate.

## Scope

Continue the Decision Center plan after ChatV2 main sync:

1. Phase 3: add a Decision Center-side Command Bus adapter contract using `origin = decision_center`.
2. Phase 4: route one low-risk Decision Center action slice (`dismiss`) through the bus behind a default-off flag, preserving the legacy path when disabled.
3. Phase 5, bounded slice: keep `retry`, `choose_priority`, and rollback as honest non-executing/preview-gated outcomes unless a current bus capability exists. Do not fake execution.
4. Phase 6, bounded slice: preserve or add Decision Center intelligence improvements that do not require ChatV2 internals or production rollout.

## Ownership Boundaries

Owned paths are listed in frontmatter. The active ChatV2 Work Order owns `src/services/chat-core-v2/**`; this Work Order may read those files and call exported APIs, but must not edit any file under `src/services/chat-core-v2/**`.

No active Work Order on fetched `origin/main` owns `src/services/decision-center.ts`, `src/services/decision-command-adapter.ts`, or `src/services/runtime-flags.ts`. `WO-chatv2-completion` remains in progress but its declared owned paths are ChatV2 internals and related ChatV2 evidence/docs, not this Decision Center adapter seam.

## Runtime Controls

- New flag: `DECISION_CENTER_COMMAND_BUS_ENABLED`.
- Default: off.
- Scoped forms: `DECISION_CENTER_COMMAND_BUS_ENABLED_USER_<id>` and `DECISION_CENTER_COMMAND_BUS_ENABLED_TENANT_<id>` through the existing scoped runtime flag helper.
- Rollback: unset the flag; the legacy Decision Center executor path remains available.

## Non-Negotiables

- Do not edit `src/services/chat-core-v2/**`.
- Do not delete old Decision Center executors in this Work Order.
- Do not enable the new flag in code, local env, staging, or production as a delivery claim.
- Do not claim iOS behavior unless iOS simulator proof exists.
- Do not claim production behavior unless deployed commit/version plus live health/smoke proof exists.
- Do not store raw private content in Command Bus events, tests, docs, or peer-validation artifacts.
- Do not represent backend tests as proof of iOS UI behavior.

## Acceptance Gates

- Lane check:
  - `node scripts/verify-agent-lanes.mjs --work-order docs/qa/work-orders/WO-decision-center-execution-20260603.md`
- Static safety:
  - `git diff --name-only origin/main -- src/services/chat-core-v2` is empty.
  - `npx tsc --noEmit`
- Focused backend:
  - `npx vitest run __tests__/services/runtime-flags.test.ts __tests__/services/decision-command-adapter.test.ts __tests__/services/decision-center-command-bus-equivalence.test.ts __tests__/services/decision-center.test.ts __tests__/api/decision-api-version.test.ts __tests__/api/decisions-routes.test.ts`
- Delivery hygiene:
  - `npm run docs:audit`
  - Final handoff under `docs/qa/final-handoffs/WO-decision-center-execution-20260603-final-handoff.md`
  - Peer-validation brief/report under `docs/qa/peer-validation/WO-decision-center-execution-20260603-peer-validation.md`

## Evidence Collected

- `node scripts/verify-agent-lanes.mjs --work-order docs/qa/work-orders/WO-decision-center-execution-20260603.md` passed.
- `git diff --name-only origin/main -- src/services/chat-core-v2` returned no files.
- `npm run docs:audit` exited 0; the tool reported 808 existing documentation warnings.
- `npm run typecheck` passed.
- Focused Decision Center tests passed: 13 files, 251 tests.
- `npx vitest run __tests__/api/event-backbone-routes.test.ts` passed after pinning the route-rate-limit test clock to remove full-suite timing drift.
- `npm run verify` passed: 812 test files, 11,848 tests.
- `DATABASE_PATH=/tmp/nexus-decision-center-smoke.db DECISION_CENTER_NOTIFICATION_SMOKE_ALLOW_LOCAL_DB=1 npm run smoke:decision-center-notification -- --user 1 --tenant 1 --dry-run --json` passed.
- Peer validation agents were invoked; results are recorded under `docs/qa/peer-validation/WO-decision-center-execution-20260603-peer-validation.md`.
- Peer findings were fixed locally and re-verified with the full repo gate.

Environment-limited gates:

- `node scripts/verify-agent-lanes.mjs --registry docs/qa/AGENT_WORK_REGISTRY.md` passed after adding the registry.
- `node scripts/verify-deliverable.mjs --claim L2 --handoff docs/qa/final-handoffs/WO-decision-center-execution-20260603-final-handoff.md` passed after adding the verifier.
- Local Docker/iOS simulator runtime evidence is covered by `WO-decision-center-ios-smoke-20260603`.

## Phase Status

| Phase | Status | Notes |
| --- | --- | --- |
| 1. Correctness/lifecycle | 100% local/L2 | Lifecycle events, effective statuses, expiry prefilters/indexing, scheduler expiry job, and metrics scaffolding are implemented and tested locally. No production claim. |
| 2A. iOS-only comprehension | 0% in this Work Order | Not touched. Requires iOS Work Order/simulator proof before iOS claims. |
| 2B. API-backed comprehension | 100% local/L2 | API v2 compact cards, schema versioning, cursor pagination, and detail wrapper are implemented and tested locally. No iOS behavior claim. |
| 3. Command Bus adapter | 100% local/L2 | Decision Center-side adapter implemented, default-off, scoped flag. No ChatV2 internals edited. |
| 4. Low-risk bus slice | 100% local/L2 | Literal `dismiss` only routes through the bus when enabled and eligible; equivalence test covers ON/OFF behavior. |
| 5. Dead-end closure | 85% local/L2 | Unsupported actions remain honest legacy/preview/disabled paths; reconnect/refresh/rollback-snapshot protections are flag-gated. Remaining rollout proof depends on runtime/iOS validation. |
| 6. Intelligence | 100% local/L2 | Semantic dedup, relationship semantics, fatigue caps, dashboard snapshot, type suppression, and skill/choice card scaffolding are implemented behind flags and tested locally. |
| 7. Peer validation | 100% local backend peer review | Two independent peer agents reported. Findings were fixed and re-verified locally. This does not create an iOS or production claim. |
| 8. Runtime/iOS/production proof | 25% local only | Build, full verify, targeted backend tests, and dry-run smoke passed. Docker sandbox, iOS simulator, and production proof are not available in this shell. |
