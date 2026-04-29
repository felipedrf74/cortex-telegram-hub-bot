# Shared Context Audit

Generated: 2026-04-29
Branch: `feature/secretary-scheduling-arbitrator-batch4`
Scope: Batch 9 cross-skill shared context correctness

## Executive Summary

Nexus now has several shared-context layers, and they are not all at the same maturity level.

The strongest layer is the newer Chat memory/context path. `shared_memory`, `daily_context_cache`, and `chat-context-engine` now carry explicit tenant/user metadata and prompt-level source/freshness/confidence annotations.

The weaker layer is the cross-skill mesh path. `cross-agent-learning`, `shared-decision-context`, `weekly-plan-orchestrator`, and `intelligence-bus` still mostly reason with `userId` plus selected global signals. This is safer than the old unscoped global model, but it is not yet a complete tenant-aware shared context protocol. In particular, multi-tenant workspaces either get refused/degraded peer context or can still consume global content signals that have no tenant namespace.

Audit verdict: **PASS WITH CONDITIONS** for local development continuation. **Not yet an unconditional production-ready shared-context gate** for multi-tenant Chat/Secretary orchestration.

## Layers Audited

| Layer | Primary Files | Purpose | Current Scope Model |
| --- | --- | --- | --- |
| Durable Chat memory | `src/state/shared-memory.ts` | Cross-domain facts remembered for Chat/skills | `tenant_id`, `user_id`, `visibility_scope`, `scope_status`, `created_by` |
| Daily context cache | `src/services/context-engine.ts` | Compact daily summary injected into AI context | Cache row has `tenant_id`, but builders mostly query by `user_id` |
| Chat prompt context engine | `src/services/chat-context-engine.ts` | Selects context with source/freshness/confidence metadata | Resolves tenant/user before retrieval and annotates every prompt item |
| Shared decision context | `src/services/shared-decision-context.ts` | Cross-skill tradeoff summaries for a target domain | Refuses `tenantId !== userId` because mesh readers are user-scoped |
| Mesh context readers | `src/services/cross-agent-learning.ts` | Reads Training/Cooking/Finance/Content/Secretary context and emits derived signals | Validates positive `userId`; no `tenantId` parameter |
| Intelligence bus | `src/services/intelligence-bus.ts` | Signal bus for content and cross-skill mesh signals | `user_id` for per-user signals, `NULL` for global content signals, no `tenant_id` |
| Weekly plan orchestration | `src/services/weekly-plan-orchestrator.ts` | Syncs derived mesh signals and resolves conflicts | Uses `userId`, `meshPriority`, source agent, payload matching |
| Domain prompt assembly | `src/domains/domain-handler.ts`, `src/domains/secretary.ts` | Adds shared context to model prompt state | Adds multiple context layers; risk of duplicated facts |

## What Exists Today

### Tenant-Scoped Memory

`setSharedMemory()` writes with `tenant_id`, `user_id`, `visibility_scope`, `scope_status`, and `created_by`, and rejects missing user scope. Reads require matching tenant/user and active user-private or tenant-shared visibility.

Evidence:

- `src/state/shared-memory.ts:77-113`
- `src/state/shared-memory.ts:136-170`
- `__tests__/state/shared-memory.test.ts`

Strengths:

- Memory is partitioned by tenant and user.
- Unsafe secret-like memory values are rejected.
- Corrections update a scoped key rather than creating unbounded duplicate memories.
- Existing tests cover tenant partitioning and user-private/tenant-shared separation.

Remaining nuance:

- `tenant_shared` memory is still read only for the current user. That is conservative and safe, but it is not yet a true tenant-member shared memory model.

### Chat Prompt Context Selection

`buildChatPromptContext()` resolves tenant/user scope before selecting context. Each `ChatContextItem` includes source, scope, tenant/user, freshness, confidence, relevance, priority, permission requirements, and stale/expiry metadata.

Evidence:

- `src/services/chat-context-engine.ts:98-170`
- `src/services/chat-context-engine.ts:180-261`
- `src/services/chat-context-engine.ts:520-536`

Strengths:

- Explicit prompt policy tells the model that context items are data, not instructions.
- Weak-context signals exist for missing scope, prompt injection, stale/low-confidence context, tenant boundary mentions, and ambiguous follow-ups.
- The prompt context item metadata is good enough for future eval/audit tooling.

Remaining nuance:

- This layer depends on upstream context sources being correct. It can label shared decision context as scoped, but cannot make the older mesh readers tenant-aware by itself.

### Shared Decision Context

`buildSharedDecisionContext()` aggregates peer mesh contexts into concise tradeoff text and contracts. It deliberately refuses non-default tenant scopes because mesh readers currently accept only `userId`.

Evidence:

- `src/services/shared-decision-context.ts:67-135`
- `src/services/shared-decision-context.ts:95-109`
- `__tests__/services/shared-decision-context.test.ts`

Strengths:

- Fails closed for `tenantId !== userId`.
- Has a short 30-second in-memory cache.
- Produces useful cross-skill tradeoff text for Secretary, Training, Cooking, Finance, and Content.

Main limitation:

- Multi-tenant users do not get tenant-specific peer mesh context; the service returns empty context instead. That prevents leakage, but also means Chat/Secretary can appear less intelligent in real tenant switching flows.

### Mesh Readers And Derived Signals

Training, Cooking, Finance, Content, and Secretary mesh readers validate positive user IDs and return safe empty contexts for invalid user scopes.

Evidence:

- `src/services/cross-agent-learning.ts:738-750`
- `src/services/cross-agent-learning.ts:950-970`
- `src/services/cross-agent-learning.ts:1232-1252`
- `src/services/cross-agent-learning.ts:1340-1360`
- `src/services/cross-agent-learning.ts:1492-1512`
- `__tests__/services/mesh-context-scope.test.ts`

Strengths:

- Invalid user scope fails closed and records tenant-scope anomalies.
- Derived signals carry `sourceAgent`, `signalType`, `meshPriority`, `priority`, `expiresAt`, and payloads.
- Cross-skill products already exist: Training informs Cooking/Content/Finance/Secretary; Secretary informs Training/Cooking/Content; Finance informs scheduling tradeoffs; Content commitments influence planning.

Main limitation:

- There is no tenant ID in these reader inputs, return contracts, or derived signal drafts.

### Intelligence Bus

The bus distinguishes per-user signals from global content signals. Per-user signal types require a valid `user_id`; global content mesh signals are stored as `user_id IS NULL`.

Evidence:

- `src/services/intelligence-bus.ts:109-130`
- `src/services/intelligence-bus.ts:341-428`
- `src/services/intelligence-bus.ts:443-490`

Strengths:

- User-scoped signal types cannot be written without a valid user.
- When a user is supplied, reads return user-specific signals plus global signals.
- Invalid reads/writes emit tenant-scope anomalies.
- `meshPriority=1` invalidates planning cache prefixes.

Main limitation:

- There is no `tenant_id`, `visibility_scope`, or workspace namespace in `agent_signals`. Global content signals are therefore platform-global rather than tenant-global.

## Cross-Skill Handoffs Observed

| Handoff | Current Mechanism | Risk |
| --- | --- | --- |
| Training -> Secretary | `session_prescription`, `session_immovability`, `recovery_state`, `training_load_forecast` | Good user-scope, missing tenant scope |
| Training -> Cooking | `fueling_requirements`, hard-session dates | Good planning signal, missing tenant scope |
| Cooking -> Training/Secretary | `fueling_support_status`, `meal_execution_readiness`, `meal_plan_window` | Useful but can duplicate with Training fueling warnings |
| Finance -> Secretary/Training/Cooking/Content | `budget_remaining`, `tax_deadline`, `subscription_renewal_due` | Useful but source freshness is flattened in prompt summaries |
| Content -> Secretary/Training/Cooking/Finance | `publishing_commitment`, filming recommendation, content execution hints | Useful but content global signal model needs tenant semantics |
| Secretary -> Training/Cooking/Content | `calendar_busy_blocks`, `travel_window`, `deadline_pressure`, `task_portability` | High value; must be tenant-aware before broad production use |
| Chat -> Skills | `buildChatPromptContext` + skill routing block | Strong prompt metadata, depends on upstream scope correctness |

## Freshness And Confidence

What exists:

- `agent_signals` has `created_at`, `expires_at`, `confidence`, and `evidence_count`.
- Derived mesh drafts have `expiresAt` and `priority`.
- Chat prompt context assigns `freshness`, `confidence`, `relevanceScore`, and `staleAfter`.
- Daily context cache stores `built_at` and date.

Gaps:

- `shared-decision-context` strips source-level `created_at`, `expiresAt`, `confidence`, and evidence count when summarizing peer contexts.
- `ChatContextItem` assigns fixed confidence/freshness to the whole shared decision block (`confidence=0.74`, `freshness=recent`, 30-second staleAfter) rather than deriving it from underlying source signals.
- `daily_context_cache` can be stale until explicit invalidation or next rebuild; only task writes were clearly documented as invalidators.

## Invalidation

What exists:

- `invalidateContextCache(userId, tenantId)` deletes today's daily context row for a scoped tenant/user.
- `invalidateSharedDecisionContextCache(userId, tenantId)` can clear in-memory peer decision context.
- `meshPriority=1` signals invalidate weekly/daily planning caches through `intelligence-bus`.
- `syncDerivedSignals()` dismisses superseded mesh signals by source/signal type/payload/priority.

Evidence:

- `src/services/context-engine.ts:60-80`
- `src/services/shared-decision-context.ts:50-65`
- `src/services/intelligence-bus.ts:416-424`
- `src/services/weekly-plan-orchestrator.ts:442-504`

Gaps:

- There is no single shared-context invalidation registry that all skill writes call.
- Cooking/Finance/Content/Training writes may update their own stores without invalidating daily context or shared decision context.
- `buildContextForAllUsers()` warms default tenant only by calling `buildDailyContext(userId)` without tenant IDs.
- Chat prompt context may include a daily context row plus a shared decision block that was computed from stores with different invalidation semantics.

## Duplicate Or Contradictory Context Risks

The domain prompt builder appends multiple layers:

1. `getSharedMemorySummary`
2. `buildSharedDecisionContext`
3. `getDailyContext`
4. `buildChatPromptContextBlock`

Evidence:

- `src/domains/domain-handler.ts:367-396`
- `src/domains/secretary.ts:141-158`
- `src/domains/secretary.ts:171-193`
- `src/domains/secretary.ts:309-311`

Risk:

- `buildChatPromptContextBlock()` can include daily context and shared decision context again.
- The older `getSharedMemorySummary()` text has no freshness/confidence metadata, while the newer chat context engine wraps memory with metadata.
- The model can see the same warning twice, potentially with different wording or freshness.

## Security And Tenant Findings

No immediate confirmed cross-tenant exploit was found in the newer Chat memory/context layer during this audit. However, there are still production-relevant tenant risks in the broader shared-context stack:

- Mesh readers are user-scoped, not tenant-scoped.
- `agent_signals` has no `tenant_id`.
- Global content signals are globally readable by users who ask for matching signal types.
- Several context builders default `tenantId` to `userId`, which is safe for founder/single-user flows but weak for true workspaces.
- Some product paths call `buildSharedDecisionContext(..., userId)` without a tenant argument.

## Priority Matrix

| Priority | Area | Finding |
| --- | --- | --- |
| P0 | Tenant isolation | No direct P0 exploit confirmed in the newer Chat context path. Keep P0 gate open until tenant-aware mesh/signals are fixed or explicitly scoped out. |
| P1 | Intelligence bus | Add `tenant_id`/scope to `agent_signals` or partition global content signals by tenant/workspace. |
| P1 | Mesh readers | Add tenant-aware inputs and store/query filters to Training/Cooking/Finance/Content/Secretary mesh readers. |
| P1 | Shared decision context | Replace `tenantId !== userId` refusal with real tenant-aware mesh reads; preserve fail-closed behavior until then. |
| P1 | Daily context | Ensure every query inside `buildDailyContext()` is tenant-safe or intentionally user-private/global with documentation. |
| P1 | Invalidation | Create central invalidation hooks for skill writes and shared context caches. |
| P2 | Dedupe | Stop injecting the same memory/daily/shared-decision facts in both legacy plain text and `chat_reasoning_context`. |
| P2 | Freshness | Preserve source `expiresAt`, confidence, evidence count, and source agent into shared decision summaries. |
| P2 | Contradictions | Surface same-priority conflicts as explicit conflict notes in Chat/Secretary prompts, not just weekly planner outputs. |
| P3 | Docs | Update `docs/MESH.md` with tenant-aware cache/signals once implemented. |

## Recommended Implementation Sequence

1. Add `tenant_id`, `visibility_scope`, and `source_entity_ref` to `agent_signals`, with backfill/quarantine rules for ambiguous rows.
2. Update `writeSignal`, `readSignals`, `readRankedSignals`, and `markConsumed` to enforce tenant/user scope.
3. Add tenant-aware mesh reader inputs for Training/Cooking/Finance/Content/Secretary and pass `tenantId` through all callers.
4. Update `buildSharedDecisionContext()` to use tenant-aware mesh readers instead of refusing non-default tenant scopes.
5. Audit `buildDailyContext()` section by section and add tenant filters or explicit user-private/global exceptions.
6. Add a shared-context invalidation service used by task writes, agenda writes, training plan changes, cooking plan changes, finance imports, content workflow changes, and integration sync changes.
7. Collapse legacy prompt context injection so `chat_reasoning_context` becomes the single metadata-bearing context carrier.
8. Add cross-skill fixtures for stale context, duplicate warnings, tenant switching, and contradictory recommendations.

## Suggested Test Plan

- `shared-memory` tenant/user partition tests.
- `agent_signals` tenant isolation tests once `tenant_id` exists.
- Mesh reader tests proving tenant A cannot read tenant B Training/Cooking/Finance/Content/Secretary state.
- Shared decision context tests for multi-tenant users where tenant A and tenant B have different schedules/content/budgets.
- Prompt builder tests proving duplicate context suppression.
- Staleness tests: update Training/Cooking/Finance/Content state, invalidate, rebuild, and assert old facts disappear.
- Contradiction tests: same-priority conflict returns explicit conflict note instead of hidden winner.
- Chat/Secretary day-to-day simulation with tenant switch and stale shared context.

## Release-Gate Verdict

**PASS WITH CONDITIONS**

This audit found real shared-context architecture progress, especially in Chat memory and prompt context. The system is not yet ready for an unconditional multi-tenant shared-context production claim because mesh/signals remain user/global scoped and invalidation is fragmented.
