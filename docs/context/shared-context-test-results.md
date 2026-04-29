# Shared Context Test Results

Generated: 2026-04-29
Branch: `feature/secretary-scheduling-arbitrator-batch4`

## Summary

Focused validation passed for the shared-context fixes.

Verdict: **PASS WITH CONDITIONS**

The implementation is test-backed for the requested cross-skill paths, stale context handling, tenant fail-closed behavior, duplicate warning prevention, and Chat visibility. The condition remains the older tenant-unaware mesh storage layer, documented in `docs/context/shared-context-fixes.md` and `docs/context/shared-context-risk-register.md`.

## Commands Run

```bash
npx vitest run __tests__/services/shared-decision-context.test.ts __tests__/services/chat-context-engine.test.ts
npm run typecheck
```

## Results

| Check | Result | Notes |
| --- | --- | --- |
| Shared decision context tests | PASS | `29` tests passed. |
| Chat context engine tests | PASS | `13` tests passed. |
| Focused test total | PASS | `42` tests passed. |
| TypeScript typecheck | PASS | `tsc --noEmit` completed with no diagnostics. |

## Coverage Matrix

| Required Area | Test Evidence | Status |
| --- | --- | --- |
| Training -> Secretary | `adds source attribution, skill ownership boundaries, and downstream update signals for Training -> Secretary` | PASS |
| Training -> Cooking | `keeps Training -> Cooking and Content -> Secretary context visible with source metadata` | PASS |
| Finance -> Training/Cooking | `shares Finance constraints into Training and Cooking without losing scope metadata` | PASS |
| Content -> Secretary | `keeps Training -> Cooking and Content -> Secretary context visible with source metadata` | PASS |
| Chat multi-skill context | `passes multi-skill shared context source attribution through to Chat prompt construction` | PASS |
| Stale context invalidation | `ignores stale peer signals and records why they were excluded` | PASS |
| Cache invalidation helper | `invalidates shared decision and chat context together after a source skill update signal` | PASS |
| Tenant isolation | `refuses peer mesh prompt context for a non-canonical tenant until tenant-aware mesh reads exist` | PASS |
| Duplicate warning prevention | `deduplicates repeated cross-skill warnings before Chat or Secretary consume them` | PASS |

## Fixes Verified

### Source Attribution

Verified that shared context includes source-agent metadata for peer signals and that Chat prompt construction preserves it as a `shared_decision_context` item.

### Freshness And Confidence

Verified that active Training and Finance signals receive freshness and confidence values derived from `expiresAt`, `meshPriority`, and payload confidence where available.

### Stale Context

Verified that expired peer signals are not used as active facts and are reported under `<stale_context>`.

### Tenant/User Scoping

Verified that the shared decision context builder still returns empty context for non-canonical tenant scope instead of reading user-scoped mesh data across tenants.

### Warning Deduplication

Verified that duplicate Cooking fueling warnings collapse to a single summary fact and a single source-attribution line.

## Local Smoke Results

No full-product local smoke was required for this narrow shared-context batch. The local validation performed here was a focused service-level smoke through:

- shared decision context construction
- Chat prompt context construction
- cache invalidation path
- TypeScript compile check

Full local product smoke remains covered by the broader local Nexus smoke documents for Chat and Secretary batches.

## Remaining Blockers

| ID | Severity | Blocker | Release Impact |
| --- | --- | --- | --- |
| CTX-P1-01 | P1 | `agent_signals` lacks `tenant_id`. | Blocks unconditional multi-tenant shared-context release. |
| CTX-P1-02 | P1 | Mesh readers are user-scoped only. | Requires fail-closed behavior for `tenantId !== userId`. |
| CTX-P1-03 | P1 | Not all skill write paths call `invalidateSharedContextForSkillChange()` yet. | Stale shared context can persist after writes outside this tested path. |
| CTX-P2-01 | P2 | Chat still applies aggregate freshness/confidence to the whole shared-decision item. | Source-level metadata is present in content but not yet structured on the Chat item. |

## Final Verdict

**PASS WITH CONDITIONS**

The requested shared-context correctness improvements are implemented and focused validation is green. Production release should still carry the documented condition that the underlying mesh/signal stores are not fully tenant-aware yet.
