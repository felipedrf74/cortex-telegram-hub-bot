# Shared Context Fixes

Generated: 2026-04-29
Branch: `feature/secretary-scheduling-arbitrator-batch4`
Rollback protection: `backup/shared-context-before-fixes-20260429-1445`, tag `backup-shared-context-before-fixes-20260429-1445`

## Scope

This batch improves cross-skill shared context correctness in the shared decision context layer used by Chat, Secretary, Training, Cooking, Finance, and Content Creation.

The changes are intentionally scoped. They do not migrate the older mesh readers or `agent_signals` schema to full tenant-aware storage yet. The shared decision layer still fails closed for non-canonical tenant scope until those lower layers are tenant-aware.

## Implementation Summary

### Source Attribution

`src/services/shared-decision-context.ts` now emits a `<source_attribution>` section inside each `<shared_decision_context>` block.

Each fresh peer signal is labeled with:

- source skill
- signal type
- source agent
- freshness
- confidence estimate
- priority
- mesh priority
- expiry timestamp

Example shape:

```text
- training.recovery_state: source=mesh.training-context; freshness=active; confidence=0.84; priority=urgent; meshPriority=2; expiresAt=...
```

This gives Chat and Secretary enough metadata to tell whether a schedule or planning recommendation is grounded in Training, Cooking, Finance, Content, or Secretary state instead of anonymous prompt prose.

### Freshness And Confidence

The shared decision context builder now computes signal freshness from `expiresAt`:

- `active`: expires more than 1 hour from now
- `expiring`: expires within 1 hour
- `stale`: already expired
- `unknown`: no valid expiry metadata

Confidence is estimated from explicit payload confidence when present, otherwise from mesh priority:

- mesh priority 1 -> `0.92`
- mesh priority 2 -> `0.84`
- mesh priority 3 -> `0.72`
- mesh priority 4 -> `0.58`
- unknown -> `0.50`

### Stale Context Handling

Expired peer signals are now filtered out before building tradeoff summaries. They are not silently used as facts.

When stale signals are present, the context block records them under `<stale_context>` so downstream consumers can see why context was excluded:

```text
- training.recovery_state: ignored stale signal from mesh.training-context; expiredAt=...
```

### Tenant/User Scope Visibility

Each shared decision block now includes a scope line:

```text
<context_scope tenant_id="..." user_id="..." visibility="user_private" cache_ttl_ms="30000" />
```

The existing safety behavior remains: if `tenantId !== userId`, shared decision context returns empty and records a tenant-scope anomaly because the underlying mesh readers are still user-scoped.

### Skill Ownership Boundaries

Each block now embeds the ownership model explicitly:

- Secretary owns schedule placement, agenda feasibility, reminders, reflow, and calendar arbitration.
- Training owns workout content, recovery logic, and training-plan shape.
- Cooking owns meals, groceries, meal prep, and fueling content.
- Finance owns budget, bill, subscription, tax, and purchase constraints.
- Content owns content workload, references, publishing cadence, and execution state.
- The target skill receives advisory context only; downstream writes still belong to the owning skill.

This prevents Chat and Secretary from treating peer-skill facts as authority to mutate another skill's owned state directly.

### Invalidation

Added `invalidateSharedContextForSkillChange()` in `src/services/shared-decision-context.ts`.

It clears both:

- in-memory shared decision context cache
- daily context cache via `invalidateContextCache()`

This is the common helper skill write paths should call after Training, Cooking, Finance, Content, Secretary, calendar, integration, or Chat state changes.

### Duplicate Warning Prevention

The shared decision context now deduplicates:

- repeated source attribution lines
- repeated summary facts
- repeated typed contract lines

This directly reduces duplicated fueling, finance, and schedule-pressure warnings before Chat or Secretary consume the context.

### Chat And Secretary Visibility

`buildChatPromptContext()` already consumes `buildSharedDecisionContext()` as a scoped `shared_decision_context` item. New tests verify that source attribution and ownership metadata survive into the Chat prompt construction path.

Secretary receives the same enriched block when it requests shared decision context.

## Cross-Skill Handoffs Covered

| Handoff | Result |
| --- | --- |
| Training -> Secretary | Recovery and session signals now include source/freshness/confidence metadata and update signals. |
| Training -> Cooking | Fueling requirements remain visible with source attribution. |
| Finance -> Training/Cooking | Budget constraints are visible to both domains with finance source metadata. |
| Content -> Secretary | Publishing commitments are visible with source attribution. |
| Chat multi-skill context | Chat receives the enriched shared decision block as a scoped context item. |
| Stale context invalidation | Expired peer signals are excluded and reported under stale context. |
| Tenant isolation | Non-canonical tenant scope still fails closed. |
| Duplicate warning prevention | Repeated facts/source lines are deduped before prompt use. |

## Open Blockers

| ID | Severity | Status | Notes |
| --- | --- | --- | --- |
| CTX-P1-01 | P1 | Open | `agent_signals` still has no `tenant_id`. This batch did not change schema. |
| CTX-P1-02 | P1 | Open | Mesh readers still accept `userId` only. Shared decision context therefore refuses `tenantId !== userId`. |
| CTX-P1-03 | P1 | Open | Non-default tenant users get safe degraded context rather than rich peer context. |
| CTX-P1-04 | P1 | Open | All upstream skill write paths still need to call the new invalidation helper consistently. |
| CTX-P2-01 | P2 | Partially fixed | Shared decision blocks now carry source/freshness/confidence, but Chat still assigns one aggregate confidence to the whole block. |

## Release-Gate Verdict

**PASS WITH CONDITIONS**

The shared-decision layer is materially safer and more useful for Chat/Secretary orchestration. It now carries attribution, freshness, confidence, ownership boundaries, stale-signal handling, dedupe, and a centralized invalidation helper.

The remaining production condition is tenant-aware mesh storage/read APIs. Until `agent_signals` and the mesh readers carry tenant scope, this layer must keep failing closed for non-canonical tenant IDs.
