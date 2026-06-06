# Peer Validation - WO-decision-center-execution-20260603

Status: peer reports received; findings triaged, fixed locally, and re-verified on 2026-06-03.

## Candidate

- Worktree: `/Users/felipedominguez/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot-decision-center-execution-20260603`
- Branch: `codex/decision-center-execution-20260603`
- Base: `origin/main` `09a1c96d`
- Work Order: `docs/qa/work-orders/WO-decision-center-execution-20260603.md`
- Maximum overall claim: L2 local verification with independent peer review for the tested backend slices. No iOS or production claim.

## Agent Requests

### Agent `019e8ca1-0182-7bd3-a783-3c7625b8264a`

Scope:

- Verify Work Order lane check.
- Verify no `src/services/chat-core-v2/**` edits.
- Run focused Command Bus/flag/prompt-injection tests.
- Review adapter risks: default-off flag, raw private content, idempotency, readback, error mapping, legacy fallback, and no fake execution.

Required commands:

```bash
git status --short
git diff --name-only origin/main -- src/services/chat-core-v2
node scripts/verify-agent-lanes.mjs --work-order docs/qa/work-orders/WO-decision-center-execution-20260603.md
npx vitest run __tests__/services/runtime-flags.test.ts __tests__/services/decision-command-adapter.test.ts __tests__/services/decision-center-command-bus-equivalence.test.ts __tests__/security/decision-prompt-injection.test.ts
```

Report summary:

- Commands passed: `git status --short`, ChatV2 diff check, Work Order lane check, and focused Command Bus tests.
- Finding: low docs drift in `docs/decision-center/command-bus-integration-wo.md`; the old branch text overstated non-dismiss bus work.
- Resolution: replaced the doc with a current dismiss-only integration note and explicit unsupported-action guardrails.
- Evidence level from agent: L2 overall; L3 only for a narrow local backend slice if accepted by rubric.

### Agent `019e8ca1-2998-77f2-bec8-a352ed6ce7b6`

Scope:

- Verify API v2/backward compatibility.
- Verify migration numbering/collision safety.
- Verify dashboard, semantic-dedup, relationship, notification, and event-backbone tests.
- Build check.

Required commands:

```bash
npx vitest run __tests__/api/decision-api-version.test.ts __tests__/api/decision-cursor.test.ts __tests__/api/decisions-routes.test.ts __tests__/portal/portal-decision-center-routes.test.ts __tests__/services/decision-center-semantic-dedup.test.ts __tests__/services/decision-dashboard.test.ts __tests__/services/decision-relationship-types.test.ts __tests__/services/notification-orchestrator.test.ts __tests__/services/event-backbone.test.ts __tests__/services/database-migration-prefix-collisions.test.ts
npm run build
```

Report summary:

- Commands passed: targeted API/dashboard/migration suite, 10 files / 107 tests, and `npm run build`.
- High finding: `buildDecisionDashboardSnapshot` could write lifecycle exposure events through `getDecisionReleaseGateStatus`.
- Resolution: `getDecisionReleaseGateStatus` now calls `listDecisionItems(..., { recordExposure: false })`, and `decision-dashboard.test.ts` asserts dashboard reads do not append lifecycle rows.
- High finding: `decision_metrics_rollup` computed "yesterday" by subtracting 24h and slicing UTC ISO, which is wrong for the repo's `Europe/Lisbon` timezone during DST.
- Resolution: added `decisionMetricsRollupDateForScheduler(now, timezone)` using Luxon in the configured scheduler timezone and updated the cron to use it; `scheduler-user-scope.test.ts` covers Lisbon summer and winter midnight rollups.
- Medium finding: v1 summary/overview/list responses added `schemaVersion`, drifting from byte-identical v1 behavior.
- Resolution: v1 summary/overview/list no longer include `schemaVersion`; v2 still includes it. `decisions-routes.test.ts` covers v1 omission and v2 inclusion.
- Medium finding: v2 cursor mode requested a 500-item universe but `listDecisionItems` clamped at 200.
- Resolution: `listDecisionItems` now supports an explicit internal `maxLimit` override capped at 500; cursor mode passes `maxLimit: 500` and tests assert that call shape.

## Local Evidence Already Collected

- Work Order lane check passed.
- `git diff --name-only origin/main -- src/services/chat-core-v2` returned no files.
- Focused Decision Center suite passed: 13 files, 251 tests.
- `npm run typecheck` passed.
- `npm run verify` passed after peer fixes: 812 test files, 11,848 tests.
- Decision Center notification smoke dry-run passed with a throwaway local `DATABASE_PATH`.
- After peer fixes, typecheck, build, and expanded focused suite passed: 16 files, 286 tests.
- A full-suite-only `event-backbone-routes` timing flake was fixed by pinning the route-rate-limit test clock; the isolated test and full verify both passed afterward.

## Evidence Limits

- Peer validation is independent and current for the tested backend slices, but final claim remains bounded by the Work Order evidence level and missing runtime/iOS/production proof.
- No iOS simulator proof is present.
- No production deploy, health check, or live smoke proof is present.
