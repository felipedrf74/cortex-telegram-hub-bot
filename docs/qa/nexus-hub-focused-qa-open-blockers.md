# Nexus Hub — Focused QA Open Blockers (P0/P1)

**Generated:** 2026-04-29 18:48 WEST
**Source audit:** `docs/qa/nexus-hub-focused-qa-findings.md`

This document lists ONLY P0 and P1 findings — the must-fix list before the content-creation intelligence upgrade can ship.

Severity legend:
- **P0** = tenant leakage / unauthorized tool / kill-switch bypass / crash on common path / production-grade data risk. Cannot ship.
- **P1** = release blocker for the upgrade. Cannot ship without explicit acceptance.

---

## P0 Blockers (15)

### Tenant isolation / data leakage

| ID | Title | File:Line | Recommended owner |
|---|---|---|---|
| E-P0-1 | `getArtifactChain` looks up ideas by title, no tenant scope | `src/services/content-learning-store.ts:586-587` | Content workstream |
| E-P0-2 | `getScriptByPipelineId` reads scripts with no scope | `src/services/content-learning-store.ts:234-243` | Content workstream |
| E-P0-3 | Learned-patterns query falls back to user_id when tenant_id null | `src/services/content-learning-store.ts:622-627` | Content workstream |
| H-P0-1 | `tenant_shared` memory does not validate caller's tenant membership | `src/services/skill-memory.ts:489-505` | Memory workstream |
| I-P0-2 | `training_agenda_event_ownership` missing `tenant_id` column | `migrations/081_training_agenda_event_ownership.sql` | Training workstream |

### Authorization gaps / privilege escalation / unauthorized tool

| ID | Title | File:Line | Recommended owner |
|---|---|---|---|
| A-P0-1 | Tool allowlist absent in `tool-executor.ts` | `src/services/tool-executor.ts:215-952` | Chat workstream |
| A-P0-2 | `chat-tool-authorization.ts` defaults to allowed:true when context missing | `src/services/chat-tool-authorization.ts:92-94` | Chat workstream |
| G-P0-1 | `setSkillVersionStatus`/`activateSkillVersion` lack auth gate | `src/services/skill-version-registry.ts:328-367` | Platform workstream |

### Kill switch / cost control

| ID | Title | File:Line | Recommended owner |
|---|---|---|---|
| B-P0-1 | Hardcoded Anthropic SDK clients bypass kill switch (7 services) | `garmin-coach.ts`, `invoice-filer.ts`, `content-workflow.ts`, `autoresearch.ts`, `content-discovery.ts`, `video-study.ts`, `channel-learner.ts` | Platform workstream |

### Crash bugs / null-handling on common path

| ID | Title | File:Line | Recommended owner |
|---|---|---|---|
| D-P0-1 | Adaptation engine null-readiness crash | `src/services/coach-kernel/adaptation-engine.ts:165` | Training workstream |
| D-P0-2 | Biomechanics substitution undefined `painFlags` | `src/services/coach-kernel/biomechanics-and-ordering.ts:83-89` | Training workstream |
| D-P0-3 | Session coherence treats zero-duration as `ok:true` | `src/services/coach-kernel/session-coherence.ts:298-302` | Training workstream |

### Schema / data-model gaps

| ID | Title | File:Line | Recommended owner |
|---|---|---|---|
| C-P0-1 | Missing `decision_explanation` column on `secretary_agenda_items` | migration 083 + `secretary-scheduling-arbitrator.ts:505` | Secretary workstream |
| H-P0-2 | No memory-schema version compatibility check on `getActiveSkillVersion` | `src/services/skill-version-registry.ts:423-466` | Platform workstream |

### Test coverage gap on operationally critical path

| ID | Title | File:Line | Recommended owner |
|---|---|---|---|
| I-P0-1 | Cancellation saga has zero integration tests | `__tests__/api/training-plan-cancellation.test.ts` | Training workstream |

---

## P1 Blockers (20)

### Tenant scoping retrofit gaps (M089 follow-up)

| ID | Title | File:Line | Recommended owner |
|---|---|---|---|
| E-P1-1 | `getTopicById` uses conditional `userId` filter | `src/services/content-workflow.ts:101-107` | Content workstream |
| E-P1-2 | `buildTasteProfileBlock` legacy user-only filter (taste-profile blend) | `src/services/content-workflow.ts:118-128` | Content workstream |
| E-P1-3 | `getContentWorkflowObject` no inline scope assertion | `src/services/content-editorial-workflow.ts:366-382` | Content workstream |
| A-P1-1 | `shared_memory` cleanup query lacks tenant scope | `src/state/shared-memory.ts:149` | Memory workstream |

### Routing parity / operator overrides

| ID | Title | File:Line | Recommended owner |
|---|---|---|---|
| B-P1-1 | Per-domain model overrides not applied to OpenAI/Gemini | `openai-provider.ts`, `gemini-provider.ts`, `model-config.ts` | Platform workstream |
| B-P1-2 | Internal AI proxy hardcodes `claude-haiku-4-5-20251001` | `src/api/routes/internal.ts:188-205` | Platform workstream |
| B-P1-3 | `classifyMessage` passes un-scrubbed PII to providers | `src/services/anthropic.ts:910-950` | Platform workstream |
| A-P1-2 | Provider-fallback context not re-validated between providers | `src/services/gemini-provider.ts:458-504` | Platform workstream |

### Architecture: Secretary as scheduler-of-record

| ID | Title | File:Line | Recommended owner |
|---|---|---|---|
| C-P1-3 | Training writes calendar events directly, bypasses Secretary intent | `src/services/training-plans.ts:431-448`, `anthropic.ts:413` | Secretary + Training (joint) |
| F-P1-4 | No `submitSchedulingIntent` call sites — Secretary arbitration not wired | (cross-codebase grep, 0 hits) | Secretary + cross-skill (joint) |

### Lifecycle / state-machine completeness

| ID | Title | File:Line | Recommended owner |
|---|---|---|---|
| I-P1-2 | Secretary writes only 5 of 11 lifecycle states | `secretary-scheduling-arbitrator.ts:236, 244, 353, 472, 861` | Secretary workstream |
| C-P1-1 | Cancellation does not notify source skill | `secretary-scheduling-arbitrator.ts:287-312` | Secretary workstream |
| F-P1-1 | No invalidation hook on plan cancellation for cross-skill memory | `skill-memory.ts:520-551` | Memory workstream |

### Cross-skill correctness

| ID | Title | File:Line | Recommended owner |
|---|---|---|---|
| F-P1-2 | Cross-skill signal origin not enforced | `skill-memory.ts:149-213 MEMORY_BOUNDARIES` | Memory workstream |
| F-P1-3 | No deduplication of warnings at chat surface | `src/services/intelligence-bus.ts` | Chat workstream |

### Calendar / agenda integrity

| ID | Title | File:Line | Recommended owner |
|---|---|---|---|
| I-P1-1 | `recordCalendarOwnership` time-of-check-to-time-of-use race | `src/services/training-plan-lifecycle.ts:104-172` | Training workstream |
| C-P1-2 | `reminders` table has no uniqueness key | `src/state/reminders.ts:9-20` | Secretary workstream |
| D-P1-1 | Cancellation saga `local_delete_failed` leaves orphaned ownership rows | `src/services/training-plan-lifecycle.ts runPrePersistCancellationSaga` | Training workstream |

### Determinism / contract gaps

| ID | Title | File:Line | Recommended owner |
|---|---|---|---|
| D-P1-2 | Plan-version increment not test-asserted before re-persist | `src/services/training-plan-persistence*.ts` | Training workstream |
| D-P1-3 | Session shape hash determinism not guaranteed (key-sort) | `src/services/training-session-identity.ts:33-45` | Training workstream |

---

## Recommended sequencing for the must-fix work

The blockers cluster by leverage. Fix in this order:

### Block 1 — One-day cleanup (ships several P0/P1 together)

1. **Sweep `content-learning-store.ts`** for unscoped queries (closes E-P0-1, E-P0-2, E-P0-3) — change query signatures to require `(userId, tenantId)`, route through `contentScopePredicate()`.
2. **Sweep `content-workflow.ts`** to remove conditional `${userId != null ? 'AND user_id = ?' : ''}` patterns (closes E-P1-1, E-P1-2).
3. **Tighten `content-editorial-workflow.ts:366-382`** with an inline scope assertion (closes E-P1-3).

Estimated effort: 3-4 hours including tests. Closes 5 P0/P1 in one sweep.

### Block 2 — Schema + saga hardening (1 day)

4. **Add `tenant_id` to `training_agenda_event_ownership`** + backfill + index update + insert/query updates (closes I-P0-2).
5. **Add `decision_explanation` to `secretary_agenda_items`** + persist in `persistDecision` (closes C-P0-1).
6. **Write the 5 cancellation-saga integration tests** (closes I-P0-1).
7. **Race-fix `recordCalendarOwnership`** with `INSERT OR IGNORE` + always-refetch (closes I-P1-1).
8. **Fix `local_delete_failed` orphan handling** in the cancellation saga (closes D-P1-1).

Estimated effort: 6-8 hours including tests. Closes 2 P0 + 2 P1 + closes the highest-risk operational gap (saga test coverage).

### Block 3 — Defensive guards (half day)

9. **Null-guard `adaptation-engine.ts:165`** (closes D-P0-1).
10. **Validate readiness presence in `biomechanics-and-ordering.ts`** (closes D-P0-2).
11. **Zero-guard `session-coherence.ts:298-302`** (closes D-P0-3).
12. **Default-deny in `chat-tool-authorization.ts:92-94`** (closes A-P0-2).

Estimated effort: 2-3 hours including tests. Closes 4 P0s.

### Block 4 — Authorization gates (half day)

13. **Auth-gate `setSkillVersionStatus` + `activateSkillVersion`** with portal-admin-token middleware (closes G-P0-1).
14. **Backend tool allowlist in `tool-executor.ts`** (closes A-P0-1).
15. **`tenant_shared` memory: validate user belongs to tenant** before fetch (closes H-P0-1).
16. **Memory-schema version compatibility** check in `getActiveSkillVersion` (closes H-P0-2).

Estimated effort: 4-6 hours including tests. Closes 4 P0s.

### Block 5 — Anthropic kill-switch enforcement (1 day)

17. **Wrap all `new Anthropic(...)` SDK instantiations** through a kill-switch-aware factory (closes B-P0-1).
18. **Apply `getDomainModelOverride()` to OpenAI + Gemini call sites** (closes B-P1-1).
19. **Internal AI proxy: resolve through override system** instead of hardcoded model (closes B-P1-2).
20. **PII scrubber for classifier inputs** (closes B-P1-3).

Estimated effort: 1 full day. Closes 1 P0 + 3 P1.

### Block 6 — Architecture decisions (multi-day, may be deferred to post-release)

21. **Wire `submitSchedulingIntent` from Training/Cooking/Finance** through Secretary (closes C-P1-3, F-P1-4).
22. **Implement Secretary lifecycle state coverage** for the 6 missing states (closes I-P1-2).
23. **Cross-skill signal origin enforcement** + warning deduplication (closes F-P1-2, F-P1-3).
24. **Cancellation propagation to cross-skill memory** (closes F-P1-1, C-P1-1).

Estimated effort: 3-5 days. These are real architecture work; the others are mostly closures.

---

## Total cleanup estimate

- **Mandatory P0/P1 (blocks 1-5):** ~3 dev-days. Closes all 15 P0s and 8 of 20 P1s.
- **Architecture P1 (block 6):** ~3-5 dev-days. Closes the remaining 12 P1s but is a substantial architecture pass.

**Recommendation:** Treat blocks 1-5 as the explicit release-condition list. Block 6 is a follow-up workstream that should land in a subsequent release with its own QA cycle.
