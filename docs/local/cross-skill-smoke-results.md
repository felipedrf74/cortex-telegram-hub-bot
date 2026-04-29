# Cross-Skill Local Smoke Results

Generated: 2026-04-29
Branch: `feature/secretary-scheduling-arbitrator-batch4`
Mode: deterministic local fixture/service smoke
Production data/provider calls: none

## Final Verdict

**PASS WITH CONDITIONS**

The requested cross-skill behaviors passed in deterministic local fixture mode and focused service-level integration tests. This run did not start the full backend server, iOS simulator, or real model/provider/calendar integrations; those remain covered by their separate full-local, iOS, and staging-provider gates.

## Commands Run

```bash
FULL_NEXUS_STATE_DIR=.local/cross-skill-smoke-20260429T145621 \
DATABASE_PATH="$PWD/data/cross-skill-smoke.db" \
NEXUS_LOCAL_ALLOW_MODEL_CALLS=0 \
scripts/full-nexus-local-engine.sh cross-skill-fixtures
```

Result: local fixture checks passed. The staging-runtime section was blocked by design because this was a dry-run/local smoke.

Fixture report:

```text
.local/cross-skill-smoke-20260429T145621/cross-skill-fixture-results.md
```

Focused service smoke:

```bash
npx vitest run \
  __tests__/services/chat-skill-orchestrator.test.ts \
  __tests__/services/chat-context-engine.test.ts \
  __tests__/services/chat-day-to-day-simulation.test.ts \
  __tests__/services/secretary-scheduling-arbitrator.test.ts \
  __tests__/services/shared-decision-context.test.ts \
  __tests__/services/training-plan-coordination.test.ts \
  __tests__/services/cooking-mesh-context.test.ts \
  __tests__/services/finance-mesh-context.test.ts \
  __tests__/services/content-workflow-user-scope.test.ts \
  __tests__/services/mesh-context-scope.test.ts \
  __tests__/tools/training-cross-skill-staging-smoke.test.ts
```

Result: `11` test files passed, `92` tests passed.

Compile gate:

```bash
npm run typecheck
```

Result: passed with no diagnostics.

## Scenario Matrix

| Scenario | Evidence | Result |
| --- | --- | --- |
| Chat coordinates multi-skill request | `chat-skill-orchestrator.test.ts`, `chat-day-to-day-simulation.test.ts` | PASS |
| Secretary schedules cross-skill workload | `secretary-scheduling-arbitrator.test.ts` | PASS |
| Training reacts to schedule constraints | `training-plan-coordination.test.ts`, `training-cross-skill-staging-smoke.test.ts`, local fixture runner | PASS |
| Cooking reacts to Training | `cooking-mesh-context.test.ts`, local fixture runner fueling-gap flow | PASS |
| Finance constraints influence choices | `finance-mesh-context.test.ts`, `training-plan-coordination.test.ts`, local fixture runner budget flow | PASS |
| Content uses relevant milestones/references | `content-workflow-user-scope.test.ts`, local fixture runner content workload/milestone flows | PASS |
| Shared context updates and invalidates correctly | `shared-decision-context.test.ts` | PASS |
| No stale recommendations | `shared-decision-context.test.ts` stale-signal exclusion | PASS |
| No duplicate recommendations | `shared-decision-context.test.ts` duplicate warning prevention; fixture fueling warning count | PASS |
| No tenant leakage | `chat-context-engine.test.ts`, `mesh-context-scope.test.ts`, shared decision non-canonical tenant fail-closed test | PASS |

## Fixture Runner Evidence

The local cross-skill fixture runner validated:

- Secretary travel/admin pressure constrains Training.
- Cooking fueling gaps produce one specific warning line.
- Finance budget constraints reach Training.
- Content workload protects the filming day.
- Training exposes a content-capture milestone for Content Creation.
- Secretary pressure produces reflow/modular Training guidance.
- Fueling warnings are deduped.
- Spend-heavy Training recommendations are suppressed under tight budget posture.

The same runner intentionally did not read staging data or claim staging success.

## Conditions And Limitations

| Condition | Impact |
| --- | --- |
| Full backend server was not started for this narrow run. | This is a deterministic local fixture/service smoke, not an HTTP/API smoke. |
| iOS simulator was not run. | UI rendering of these cross-skill states is not revalidated by this document. |
| Real model providers were not called. | Reasoning quality is validated by deterministic fixtures, not Gemini/OpenAI/Anthropic live calls. |
| Google/Outlook were not called. | Provider read-back remains a staging calendar gate, not a local cross-skill gate. |
| Mesh readers are still user-scoped. | Non-canonical tenant context remains fail-closed rather than fully tenant-aware. |

## Cleanup Status

No backend, workers, containers, tunnels, iOS simulator sessions, or provider-call loops were started by this smoke batch. No service cleanup was required.

## Open Blockers

| ID | Severity | Status | Notes |
| --- | --- | --- | --- |
| XSKILL-P1-01 | P1 | Open | Underlying mesh readers and `agent_signals` are still not fully tenant-aware. |
| XSKILL-P1-02 | P1 | Open | Full HTTP local server smoke for this exact cross-skill slice was not rerun in this batch. |
| XSKILL-P2-01 | P2 | Open | iOS rendering of these cross-skill states was not rerun here. |
| XSKILL-P2-02 | P2 | Open | Live provider reasoning/cost behavior was intentionally not exercised. |

## Final Assessment

The local cross-skill fixture/service layer is healthy. Chat, Secretary, Training, Cooking, Finance, Content Creation, and shared context are coordinating correctly in deterministic local validation, with stale/duplicate/tenant leakage guardrails covered.

Release gate remains **PASS WITH CONDITIONS** until the tenant-aware mesh work and full server/iOS/provider gates are closed or explicitly accepted as out of scope for the release.
