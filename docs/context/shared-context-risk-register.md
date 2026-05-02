# Shared Context Risk Register

Generated: 2026-04-29
Branch: `feature/secretary-scheduling-arbitrator-batch4`
Related audit: `docs/context/shared-context-audit.md`

## Verdict

**PASS WITH CONDITIONS**

No immediate P0 cross-tenant exploit was confirmed in the newer Chat memory/context path. The broader shared-context stack still has P1 production blockers before a fully tenant-safe cross-skill release.

2026-05-02 Training deep audit update: local `chat-tenant-smoke` passed 15 checks with 1 partial provider-fallback check and 0 failures. No direct Training-specific identity leak was reproduced, but CTX-P1-02/04 remain release-significant because Training mesh/shared-decision readers still need tenant-explicit APIs before Nexus can claim unconditional multi-tenant shared-context safety.

## P0 Blockers

| ID | Status | Risk | Evidence | Required Closure |
| --- | --- | --- | --- | --- |
| CTX-P0-01 | Guardrail open | Tenant leakage must remain treated as P0 until mesh/signals are tenant-aware. | Chat memory is tenant-scoped, but `agent_signals` and mesh readers are not tenant-scoped. | Do not claim full multi-tenant shared-context safety until P1 tenant-scope items are closed or explicitly excluded from release scope. |

## P1 Must Fix Before Unconditional Production Release

| ID | Status | Risk | Why It Matters | Evidence | Required Closure |
| --- | --- | --- | --- | --- | --- |
| CTX-P1-01 | Open | `agent_signals` has no `tenant_id`. | Per-user signals are safer than old global rows, but global content signals can still cross workspace boundaries. | `src/services/intelligence-bus.ts:109-130`, `:341-428`, `:443-490` | Add tenant/workspace scope to signal rows and all read/write APIs, or explicitly classify which signals are truly platform-global. |
| CTX-P1-02 | Open | Mesh readers are user-scoped only. | Training/Cooking/Finance/Content/Secretary mesh context cannot correctly serve a multi-tenant user without either degradation or wrong-tenant assumptions. | `src/services/cross-agent-learning.ts:738-750`, `:950-970`, `:1232-1252`, `:1340-1360`, `:1492-1512` | Add `tenantId` to mesh reader inputs and underlying store queries. |
| CTX-P1-03 | Open | Shared decision context refuses non-default tenant scope. | This is safe fail-closed behavior, but Chat/Secretary lose peer context after tenant switching. | `src/services/shared-decision-context.ts:95-109` | Replace refusal with tenant-aware mesh reads after CTX-P1-02 closes. |
| CTX-P1-04 | Open | Some callers omit tenant ID when building shared decision context. | Active tenant can be lost, causing default-user context or empty context in multi-tenant flows. | `src/api/routes/training-plan-generation.ts:270-277` | Pass active tenant through all build/read paths and add tests. |
| CTX-P1-05 | Open | Daily context builder persists tenant scope but builds from mostly user-only queries. | Cache rows can appear tenant-scoped while the underlying sections may not be tenant-filtered. | `src/services/context-engine.ts:105-228` | Audit each section and add tenant filters or documented user-private/global exceptions. |
| CTX-P1-06 | Open | Daily context cron warms only default tenant. | Non-default tenant contexts may be absent/stale until first request. | `src/services/context-engine.ts:254-266`, `src/services/scheduler.ts:909-914` | Build per active tenant/user membership, or do not prewarm tenant-scoped rows until membership exists. |
| CTX-P1-07 | Partially fixed | Shared context invalidation is fragmented. | Stale context can survive after Training/Cooking/Finance/Content/Secretary writes. | `src/services/context-engine.ts:60-80`, `src/services/shared-decision-context.ts:50-80`, `src/services/intelligence-bus.ts:416-424` | `invalidateSharedContextForSkillChange()` now clears shared decision + daily context caches. Remaining work: call it from every skill write/integration sync. |
| CTX-P1-08 | Open | Global content signal semantics are ambiguous. | Content references, channel learnings, and formulas may be tenant-private in SaaS workspaces but currently map to platform-global rows. | `src/services/intelligence-bus.ts:293-317`, docs classify these as global content mesh signals | Define platform-global vs tenant-global vs user-private content signals and enforce in schema/API. |

## P2 Should Fix

| ID | Status | Risk | Why It Matters | Evidence | Recommended Closure |
| --- | --- | --- | --- | --- | --- |
| CTX-P2-01 | Partially fixed | Source freshness/confidence is flattened in shared decision summaries. | Chat/Secretary may treat mixed-confidence peer facts as equally reliable. | `src/services/chat-context-engine.ts:241-258`, `src/services/shared-decision-context.ts:120-280` | Shared decision blocks now include source agent, freshness, confidence, priority, meshPriority, and expiresAt. Remaining work: expose these as structured Chat item metadata instead of only embedded block content. |
| CTX-P2-02 | Open | Duplicate context injection. | Same facts can appear in legacy memory/daily/shared text and again inside `chat_reasoning_context`, increasing contradictions and warning spam. | `src/domains/domain-handler.ts:367-396`, `src/domains/secretary.ts:141-158`, `:171-193`, `:309-311` | Make `chat_reasoning_context` the canonical prompt carrier or explicitly suppress duplicated sources. |
| CTX-P2-03 | Open | Tenant-shared memory is conservative but not truly tenant-shared. | This is safe, but product semantics will surprise teams expecting shared workspace memory. | `src/state/shared-memory.ts:153-170`, `__tests__/state/shared-memory.test.ts` | Add tenant membership/permission model before cross-user tenant-shared reads. |
| CTX-P2-04 | Open | Same-priority cross-skill contradictions are not surfaced everywhere. | Weekly planner has conflict logic, but Chat/Secretary prompt summaries can still present contradictory peer suggestions as plain facts. | `docs/MESH.md`, `src/services/weekly-plan-orchestrator.ts` | Promote `ConflictNote` style output into shared decision context and Chat prompt context. |
| CTX-P2-05 | Open | Intelligence bus `dismissSignal()` has duplicated local declaration in source. | This can be a latent TypeScript/runtime hazard depending on compiler path and file freshness. | `src/services/intelligence-bus.ts:512-514` | Remove duplicate declaration in a small hygiene patch with tests. |
| CTX-P2-06 | Open | Context expiry cleanup is uneven. | Shared memory self-cleans opportunistically; agent signals require `expireStaleSignals`; daily context cache is date-keyed. | `src/state/shared-memory.ts:132-150`, `src/services/intelligence-bus.ts:534-550` | Add scheduled cleanup/reporting for all shared context stores. |

## P3 Deferrable

| ID | Status | Risk | Recommendation |
| --- | --- | --- | --- |
| CTX-P3-01 | Open | Mesh docs still describe user-keyed plan cache only. | Update after tenant-aware cache keys are implemented. |
| CTX-P3-02 | Open | Some comments still frame the mesh as content-agent first. | Refresh wording once the cross-skill shared context model is formalized. |
| CTX-P3-03 | Open | Context audit dashboards are not consolidated. | Add a portal diagnostics view after the schema stabilizes. |

## Not A Blocker

| Item | Reason |
| --- | --- |
| Shared decision context returning empty for `tenantId !== userId` | This is safe fail-closed behavior. It is a product/intelligence gap, not a leakage bug. |
| `tenant_shared` memory not visible across users | Conservative safety choice until tenant membership semantics are implemented. |
| No vector store found in this audit | No vector-namespace leakage was confirmed because no durable Chat vector store path was found. |

## Immediate Fix Order

1. Add tenant scope to `agent_signals` and signal APIs.
2. Make mesh readers tenant-aware.
3. Pass active tenant into every shared-decision-context caller.
4. Tenant-proof daily context builder queries.
5. Centralize invalidation across skill writes and integration syncs.
6. Dedupe prompt context injection.
7. Preserve source-level freshness/confidence into decision summaries.

## Suggested Release-Gate Tests

- Cross-tenant `agent_signals` read/write denial.
- Global signal opt-in tests for platform-global signals.
- Mesh reader tenant isolation for all five skills.
- Shared decision context with same user in two tenants and divergent state.
- Daily context cache per tenant with divergent task/calendar/content state.
- Invalidation: Training plan update, Cooking meal update, Finance import, Content publish schedule, Secretary agenda write.
- Prompt context dedupe: memory/daily/shared-decision appears once with metadata.
- Contradictory recommendations: same-priority conflict appears as conflict note.

## Final Risk Verdict

**PASS WITH CONDITIONS**

Safe to continue implementation on this branch. Not safe to treat cross-skill shared context as fully production-ready for multi-tenant release until the P1 items are closed or explicitly accepted with scope limits.

---

## May 2026 P0 chat-identity audit — addendum

Two new shared-context risks identified and closed:

1. **`buildKnowledgePromptBlock` injected literal "Felipe's voice"** into the content-domain system prompt for any user with content_knowledge rows. Closed by `docs/security/p0-chat-identity-final-report.md` — the literal Felipe text was removed and replaced with "the authenticated creator's saved Voice DNA / brand voice for this user and tenant".

2. **`prompts/creator-config.md` was a fully-fleshed founder identity doc** auto-injected via `{{CREATOR_CONFIG}}` placeholder by `loadPromptWithConfig`. Closed by:
   - Removing `{{CREATOR_CONFIG}}` placeholder from `prompts/content.md` and `prompts/topic-generation.md`.
   - Removing `loadPromptWithConfig` from `src/services/anthropic.ts:60` for the content domain.
   - Sanitizing `prompts/creator-config.md` itself to a NEUTRAL TEMPLATE (no creator name, no worldview, no audience defaults, no political/religious/dietary defaults) — so that any future code path which DOES still reference `{{CREATOR_CONFIG}}` cannot leak founder identity.

In addition, the `authenticated-user` `ChatContextItem` was injected into `src/services/chat-context-engine.ts:208-227` with priority 98 (`critical: true`) carrying the JWT-derived display name and explicit "do not use owner/founder/default names" rule. This is the new highest-priority context entry for chat prompts.

Defense-in-depth fixes added in the same audit:
- `getUserByAnyIdentifier` reordered to resolve `users.id` before `telegram_id`, removing the cross-user collision foot-gun.
- New strict by-id resolvers (`getPreferredDisplayNameById`, `getUserLanguageById`, `getUserTimezoneById`) plus migration of all 11 iOS API route call sites to use them.
- `tryBuildAuthenticatedIdentityResponse` deterministic fast-path catches identity questions BEFORE any AI call.
- Persisted-payload writers (`voice-evolution-agent`, `reaction-radar-agent`, `eval-criteria`, `video-study`) and the Python content-engine creative modules de-Felipe'd.
- `fossa_email` cron gated behind `FOSSA_EMAIL_ENABLED=1` env flag to prevent owner PII leaking into a different tenant's automations.

Verification: `__tests__/security/p0-chat-identity-isolation.test.ts` (23 cases) + 998 prior regression tests pass.

Reference: `docs/security/p0-chat-identity-final-report.md`.
