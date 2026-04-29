# Shared Context Release Gate

Generated: 2026-04-29
Branch: `feature/secretary-scheduling-arbitrator-batch4`
Related smoke: `docs/local/cross-skill-smoke-results.md`

## Final Verdict

**PASS WITH CONDITIONS**

Shared context is good enough for continued release-candidate hardening and deterministic local cross-skill validation. It is not yet an unconditional production gate for fully multi-tenant shared-context orchestration because the lower mesh/signal layer remains user-scoped.

## Evidence Summary

| Evidence | Result |
| --- | --- |
| Shared context implementation docs | `docs/context/shared-context-fixes.md` created |
| Shared context test results | `docs/context/shared-context-test-results.md` created |
| Cross-skill local smoke | `docs/local/cross-skill-smoke-results.md` created |
| Focused shared/context tests | `92/92` cross-skill smoke tests passed |
| TypeScript typecheck | PASS |
| Production/provider data usage | None |

## Release Criteria

| Criterion | Status | Evidence |
| --- | --- | --- |
| Source attribution exists | PASS | Shared decision blocks include source skill, source agent, priority, mesh priority, and expiry metadata. |
| Freshness/confidence exists | PASS | Active/expiring/stale/unknown freshness and confidence estimates are computed from mesh signal metadata. |
| Tenant/user scope visible | PASS WITH CONDITION | Shared decision blocks include scope metadata and fail closed for non-canonical tenants. Underlying mesh readers are still not tenant-aware. |
| Context invalidation exists | PASS WITH CONDITION | `invalidateSharedContextForSkillChange()` clears shared decision + daily context caches. Not all skill write paths call it yet. |
| Skill ownership boundaries exist | PASS | Shared decision blocks explicitly state Secretary, Training, Cooking, Finance, and Content ownership. |
| Warning deduplication exists | PASS | Duplicate facts, source lines, and typed contract lines are deduped. |
| Downstream update signals exist | PASS | Shared decision blocks tell downstream skills to invalidate and refresh when peer state changes. |
| Stale context handling exists | PASS | Expired signals are excluded from active facts and reported under `<stale_context>`. |
| Chat visibility exists | PASS | Chat prompt context preserves the enriched shared decision block. |
| Secretary visibility exists | PASS | Secretary receives the enriched block when building shared decision context. |
| Tenant leakage absent in local smoke | PASS WITH CONDITION | Local tests cover fail-closed behavior. Full tenant-aware mesh storage remains open. |

## Blocking Conditions

| ID | Severity | Condition | Required Closure |
| --- | --- | --- | --- |
| CTX-P1-01 | P1 | `agent_signals` lacks `tenant_id`. | Add tenant scope to signal storage/read/write APIs, or explicitly classify signals as platform-global/user-private/tenant-global. |
| CTX-P1-02 | P1 | Mesh readers are user-scoped only. | Add tenant-aware inputs and tenant-filtered underlying queries. |
| CTX-P1-03 | P1 | Non-default tenant context safely degrades to empty. | Replace fail-closed behavior with tenant-aware reads after CTX-P1-01/02 close. |
| CTX-P1-04 | P1 | Invalidation helper is not yet wired into every skill write path. | Call `invalidateSharedContextForSkillChange()` from Training, Cooking, Finance, Content, Secretary, calendar, and integration state changes. |

## Deferrable Conditions

| ID | Severity | Item | Notes |
| --- | --- | --- | --- |
| CTX-P2-01 | P2 | Chat item metadata is still aggregate. | Source metadata is present inside the shared decision block, but Chat still assigns one aggregate confidence/freshness to the whole item. |
| CTX-P2-02 | P2 | Full HTTP local server smoke was not rerun for this exact slice. | Deterministic service/harness smoke passed. |
| CTX-P2-03 | P2 | iOS rendering was not rerun for this exact slice. | UI state support should stay under the iOS rich-state gate. |
| CTX-P2-04 | P2 | Live provider behavior was not rerun. | Fixture mode is correct for local release gating; live calls should be bounded and explicit. |

## Release Recommendation

Proceed only as **GO WITH CONDITIONS** for shared context.

Safe to merge into a release candidate if:

- the release scope explicitly accepts fail-closed multi-tenant mesh behavior, or
- tenant-aware mesh/signal storage is completed before deployment.

Do not claim full multi-tenant shared-context orchestration until CTX-P1-01 and CTX-P1-02 are closed.

## Monitoring Checklist

Before production release, make sure monitoring can surface:

- shared-context build failures
- stale signal exclusion count
- duplicate warning suppression count
- tenant-scope anomaly count from shared context and mesh readers
- cross-skill invalidation calls by source skill
- Chat prompt context shared-decision item inclusion rate
- Secretary shared-context inclusion rate
- cases where shared context returns empty because tenant scope is non-canonical
- downstream skill refresh failures after context invalidation

## Exact Gate State

Final shared context release gate: **PASS WITH CONDITIONS**.
