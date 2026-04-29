# Nexus Hub — Focused QA Open Blockers (P0/P1)

**Generated:** 2026-04-29 18:48 WEST (v1) + 19:30 WEST (Opus rerun deltas)
**Source audits:** `docs/qa/nexus-hub-focused-qa-findings.md` (Sonnet baseline) + `docs/qa/nexus-hub-focused-qa-opus-rerun-addendum.md` (Opus 4.7 corrections)

This document lists ONLY P0 and P1 findings — the must-fix list before the content-creation intelligence upgrade can ship.

> **⚠️ Opus 4.7 rerun has corrected this list.** The Wave 1 Sonnet baseline below is preserved for traceability but **selected entries are refuted, downgraded, or escalated**. The Wave 2 Opus authoritative P0/P1 list is the **"POST-OPUS CORRECTED P0/P1 LIST"** section at the end of this file.

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

---

# POST-OPUS CORRECTED P0/P1 LIST (authoritative)

The Wave 1 list above is preserved for audit traceability. **The Opus 4.7 rerun corrected the list as follows:**

## Wave 1 → Wave 2 deltas

### REFUTED (remove from must-fix)

| Wave 1 ID | Why refuted by Opus |
|---|---|
| D-P0-1 | `adaptation-engine.ts:165` — `readiness: ReadinessSnapshot` is non-optional in type; `readiness-snapshot-adapter.ts` provides defaults. Not a crash. |
| D-P0-2 | `biomechanics-and-ordering.ts:83` uses optional chaining + nullish coalescing properly. Defended. |
| D-P0-3 | `session-coherence.ts:298-300` has explicit `if (claimedMinutes <= 0) return ok` defense. |
| D-P1-1 | Cancellation saga `local_delete_failed` correctly transitions ownership to `'orphaned'` via `markCalendarOwnershipDeleted`. Saga aborts before any new ownership is recorded. |
| D-P1-3 | `training-session-identity.ts:221-231 stableStringify` calls `Object.keys(record).sort()`. Confirmed correct. |
| G-P0-1 | `setSkillVersionStatus`/`activateSkillVersion` ARE auth-gated at route level via `requireOwner` in `src/api/routes/skills.ts:295-357`. |
| I-P0-1 | `__tests__/api/training-plan-cancellation.test.ts` has 12 it() cases (lines 116-572). Coverage exists. |
| B-P1-1 | `getModelRouting` in `ai-provider.ts:84-92` IS called by both Gemini and OpenAI. (But subtle bug exists — see B-OPUS-P1-1.) |
| B-P2-2 | Circuit breaker IS wired in `provider-fallback.ts:243-330` and used in `TaskRoutingProvider.executeWithFallback` (lines 452, 466, 476, 540). |
| F-P1-4 | Content DOES use `submitSecretarySchedulingIntent` (`content-editorial-workflow.ts:615`). Training/Cooking/Finance gap is narrower → P2. |

### DOWNGRADED

| Wave 1 ID | New severity | Reason |
|---|---|---|
| A-P1-2 | P2 | Practical leak vector theoretical because every audited caller wraps consistently. |
| A-P3-1 | "internal-API hardening note", not a finding | Private helper; only call sites already validate scope. |
| B-P0-1 | P2 (kill-switch bypass framing) | `trackedCreate` enforces kill switch. The 10 hardcoded clients are dead-code surface, not a bypass. |

### ESCALATED

| Wave 1 ID | New severity | Reason |
|---|---|---|
| D-P1-2 | **P0** | `incrementPlanVersion` is **DEFINED but NEVER CALLED**. Plan version stays at 1 forever. Dead-code mechanism, latent regenerate-without-cancel bug. |
| E-P1-1 | **P0** | `getTopicById` conditional `userId` filter is a direct authorization-bypass entry-point exposed via API surface. |
| E-P3-1 | **P2** | Internal AI route never validates `userId` actually belongs to `tenantId`. |
| H-P0-1 | **P0 (invariant in `getSkillMemories` itself)** | Should be hardened in the function, not in every caller. |

### CONFIRMED-AS-IS (Wave 1 P0/P1 still must-fix)

A-P0-1 (tool allowlist), A-P0-2 (default-allow on missing context), A-P1-1 (shared_memory cleanup), A-P2-1, A-P2-2, B-P1-2, B-P1-3, B-P2-1, B-P2-3, B-P3-1, B-P3-2, C-P0-1, C-P1-1, C-P1-2 (worse than reported — no `agenda_item_id` link at all), C-P1-3 (line citation wrong but fact correct), C-P2-1, C-P2-2, C-P2-3, E-P0-1, E-P0-2, E-P0-3, E-P1-2, E-P2-1, E-P2-2, E-P2-3, F-P1-1, F-P1-2, F-P1-3, G-P2-1, H-P0-2, H-P2-1, H-P2-2, H-P3-1, I-P0-2, I-P1-2 (8 of 11 not 5), I-P2-2.

## NEW Opus P0s (must-fix)

| ID | Title | File:Line | Owner |
|---|---|---|---|
| A-OPUS-P0-1 | Provider fallback restores full TOOLS array (tool authorization bypass) | `gemini-provider.ts:802, :862`; `openai-provider.ts:328-334` | Chat workstream |
| A-OPUS-P0-2 | Shared-memory correction destructively overwrites without lineage | `state/shared-memory.ts:116-130` | Memory workstream |
| B-OPUS-P0-1 | Internal AI proxy reachable from any network (no loopback restriction) | `api/routes/internal.ts:35-56` | Platform workstream |
| B-OPUS-P0-2 | Internal `ai-complete` accepts attacker-controlled `userId`/`tenantId` for billing attribution | `api/routes/internal.ts:167-180` | Platform workstream |
| C-OPUS-P0-1 | Lifecycle never advances to `'synced'`/`'completed'`/`'failed_sync'` | `secretary-agenda-provider-sync.ts:348-370` | Secretary workstream |
| C-OPUS-P0-2 | Cooking/Training/Finance bypass Secretary scheduler (Phase 9 contract violation) | `submitSecretarySchedulingIntent` callers | Cross-skill (joint) |
| D-OPUS-P0-1 | `incrementPlanVersion` is dead code; supersession is a paper mechanism | `training-plan-lifecycle.ts:294-306` | Training workstream |
| E-OPUS-P0-1 | `content-learning-store.ts:557-561` pipeline read unscoped | `content-learning-store.ts:557-561` | Content workstream |
| E-OPUS-P0-2 | `content-learning-store.ts:572-573` topic-feedback read unscoped | `content-learning-store.ts:572-573` | Content workstream |
| E-OPUS-P0-3 | `content-learning-store.ts:612-618` content_performance read unscoped | `content-learning-store.ts:612-618` | Content workstream |
| E-OPUS-P0-4 | `content-learning-store.ts:595-599` content_scripts read in artifact chain unscoped | `content-learning-store.ts:595-599` | Content workstream |
| E-OPUS-P0-5 | `content-workflow.ts:79-99` `updateFeedback`/`markScriptGenerated` allow cross-tenant writes | `content-workflow.ts:79-99` | Content workstream |
| E-OPUS-P0-6 | `content-dedup.ts:62-89` AsyncLocalStorage fallback runs global query, exposes all users' titles in prompt | `content-dedup.ts:62-89` | Content workstream |
| F-OPUS-P0-1 | `intelligence-bus.writeSignal` does not pass `tenant_id`; cross-tenant signal contamination | `intelligence-bus.ts:341-429` | Memory + cross-skill |
| G-OPUS-P0-1 | Version status transitions accept illegal regressions (`active`→`draft`, `deprecated`→`active`) | `skill-version-registry.ts:328-367` | Platform workstream |
| H-OPUS-P0-1 | `skill_specific_memory` umbrella type bypasses MEMORY_BOUNDARIES | `skill-memory.ts:149-213, 221-226` | Memory workstream |
| H-OPUS-P0-2 | `UNSAFE_MEMORY_PATTERNS` misses every modern token shape (JWT, AWS, Google API, Stripe, GitHub PAT, Slack, DB connection strings) | `skill-memory.ts:142-147` | Memory workstream |

## NEW Opus P1s

| ID | Title | File:Line |
|---|---|---|
| A-OPUS-P1-1 | `[Current State]` user-message marker is spoofable (PROMPT INJECTION) | `anthropic.ts:1067-1072, :1163-1168`; `gemini-provider.ts:798, :860`; `openai-provider.ts:432-440` |
| A-OPUS-P1-2 | Portal admin chat-diagnostics no rate limit | `portal/chat-routes.ts:52-95` |
| A-OPUS-P1-3 | Backend has no scope-key cache mirroring iOS tenant switch | `chat-pending-confirmations.ts` etc. |
| B-OPUS-P1-1 | Domain model pins bypassed when `modelTier` is supplied | `gemini-provider.ts:570-588`; OpenAI equivalent |
| B-OPUS-P1-2 | `setActiveModel` mutates live `config` object (race) | `model-config.ts:310-316` |
| B-OPUS-P1-3 | `AI_CHAT_PRIMARY=anthropic` + `ANTHROPIC_ENABLED=false` silent provider substitution | `provider-registry.ts:88-108` |
| B-OPUS-P1-4 | `completeOneShotWithSearch` no PII scrub or tenant scope | `gemini-provider.ts:221-290` |
| C-OPUS-P1-1 | Decision explanation visible only on synchronous response, never persisted | `secretary-scheduling-arbitrator.ts:415, 527, 808-834` |
| C-OPUS-P1-2 | Stale `start_at`/`end_at` on superseded rows | `secretary-scheduling-arbitrator.ts:455-461` |
| D-OPUS-P1-1 | Training timezone server-pinned, not user-pinned | `api/routes/training-schedule-utils.ts:57` |
| E-OPUS-P1-1 | `content-dedup.getAngleDistribution` falls back to global aggregation | `content-dedup.ts:188-212` |
| E-OPUS-P1-2 | `internal.ts:241-265` performance-summary uses owner-bootstrap target | `api/routes/internal.ts:241-265` |
| E-OPUS-P1-3 | References concatenated without health filter (`needsReview` passes through) | `content-reference-context.ts:246-264` |
| E-OPUS-P1-4 | Provenance never refuses generation when zero usable references | `content-workflow.ts:360-421` |
| E-OPUS-P1-5 | Approval gate has no actor-permission check (`approvalConfirmed: true` from any caller bypasses) | `content-editorial-workflow.ts:439-445` |
| E-OPUS-P1-6 | `convertRadarSignalToIdea` allows visibility-scope elevation without approval | `content-editorial-workflow.ts:618-710` |
| F-OPUS-P1-1 | `source_agent` provenance is unsigned; impersonation trivial | `intelligence-bus.ts:341-429` |
| F-OPUS-P1-2 | Two parallel signal ledgers (`agent_signals` + `skill_memories`) with no reconciliation | `intelligence-bus.ts` + `skill-memory.ts` |
| G-OPUS-P1-1 | `getActiveSkillVersion` ambiguity on dual rollouts | `skill-version-registry.ts:423-466` |
| G-OPUS-P1-2 | `skill_version_rollouts` lacks uniqueness | `migrations/087_skill_version_registry.sql:52-75` |
| H-OPUS-P1-1 | No memory quota — tenant DOS / unbounded growth | `skill-memory.ts` + migration 088 |
| H-OPUS-P1-2 | `getSkillMemories` SELECT + UPDATE non-transactional | `skill-memory.ts:489-515` |
| H-OPUS-P1-3 | `setSkillMemory` correction history truncates lineage to length 1 | `skill-memory.ts:366-374` |
| I-OPUS-P0-2 | Concurrent cancel race | `api/routes/training-plan-cancellation.ts:164-167` |
| I-OPUS-P1-1 | Reminder lifecycle disconnected from agenda lifecycle (no `agenda_item_id` FK) | `state/reminders.ts:9-20` |

## Final P0/P1 totals after Opus rerun

| Severity | Wave 1 (Sonnet) | Refuted/downgraded | Escalated | NEW Opus | **Final** |
|---|---|---|---|---|---|
| **P0** | 15 | -7 | +3 | +13 | **24** |
| **P1** | 20 | -1 | +2 | +14 | **35** |

**Total must-fix: 59 findings.**

## Updated sequencing recommendation (post-Opus)

The original 6-block sequencing in this document needs revision. The new ordering, optimized for leverage:

**Block 1 (HIGHEST LEVERAGE) — Internal AI proxy hardening (½ day)**
- B-OPUS-P0-1: loopback restrict
- B-OPUS-P0-2: validate userId/tenantId attribution
- E-P3-1 (was P3, now P2): same surface

**Block 2 — Content tenant scoping sweep (1 dev-day)**
- 7 unscoped queries in `content-learning-store.ts`
- Cross-tenant write paths in `content-workflow.ts`
- AsyncLocalStorage fallbacks in `content-dedup.ts` (P0 + P1)
- Approval gate actor permission check (E-OPUS-P1-5)

**Block 3 — Tool authorization hardening (½ day)**
- A-P0-1 (tool allowlist)
- A-P0-2 (default-deny)
- A-OPUS-P0-1 (provider fallback TOOLS allowlist)

**Block 4 — Prompt injection + memory secrets (½ day)**
- A-OPUS-P1-1: sanitize `[Current State]` markers
- H-OPUS-P0-2: expand `UNSAFE_MEMORY_PATTERNS`
- H-OPUS-P0-1: schema-validate `skill_specific_memory`

**Block 5 — Lifecycle + cross-skill scheduling (1-2 dev-days)**
- C-OPUS-P0-1: write `'synced'`/`'failed_sync'`/`'completed'` lifecycle states
- C-OPUS-P0-2: route Cooking/Training/Finance through Secretary
- I-P1-2 (Sonnet, confirmed by Opus): backend writes 8 of 11; complete the state machine
- I-OPUS-P1-1: link reminders to agenda items

**Block 6 — Schema + signals (1 dev-day)**
- I-P0-2: `tenant_id` on `training_agenda_event_ownership`
- F-OPUS-P0-1: `tenant_id` on `agent_signals`
- C-P0-1: `decision_explanation` on `secretary_agenda_items`

**Block 7 — Skill version + memory invariants (½-1 day)**
- G-OPUS-P0-1: version status transition validation
- H-P0-1: `tenant_shared` membership validation in `getSkillMemories`
- H-P0-2: schema-version compatibility check
- D-OPUS-P0-1: decide `incrementPlanVersion` (delete or wire)

**Block 8 (DEFERABLE) — P1 backlog**
- All remaining P1s — ~3-5 dev-days. Can ship with documented exceptions if Blocks 1-7 close all P0s.

**Total mandatory P0 effort:** ~5-6 dev-days. Closes all 24 P0s.
**Total P1 backlog effort:** ~5-7 dev-days. Closes all 35 P1s.

**Recommendation:** Treat Blocks 1-7 as the explicit release-condition list. Block 8 (P1 backlog) can be deferred with documented exceptions in `docs/release/`.
