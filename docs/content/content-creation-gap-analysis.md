# Content Creation Gap Analysis

Date: 2026-04-29
Branch: `feature/content-creation-intelligence-upgrade`

## Priority Matrix

| Priority | Gap | Evidence | Why It Matters |
|---|---|---|---|
| P0 | No confirmed full tenant-scoped content model | Content tables and helpers are primarily `user_id` plus `owner_scope`; shared context remains user/global | Content must not claim tenant-safe reference libraries or tenant-specific brand memory until tenant boundaries are explicit |
| P1 | Content dedup bypassed live routing | `src/services/content-dedup.ts` called Anthropic directly before first implementation pass | CLOSED IN CODE: now uses `completeOneShotWithFallback()` under `content_dedup`; keep broader regression gate |
| P1 | Python content-engine AI proxy lacks tenant/user metadata | `content-engine/services/claude_client.py` sends prompt/system/category only | Provider logs and cost traces cannot prove tenant/user scope for Content generation |
| P1 | Content discovery has local direct fallback logic | `src/services/content-discovery.ts` uses Gemini search, then direct `trackedCreate` Anthropic fallback | Routing behavior is not consistently controlled through the central model routing layer |
| P1 | `/api/v1/content/discover` lacked the shared content route guard | `src/api/routes/content.ts` routed `/discover` without `ensureValidContentRouteScope` before first implementation pass | CLOSED IN CODE: discovery now validates `content_route_discover` |
| P1 | Reference and learning routes assumed `userId` was enough | `registerContentReferenceRoutes(router)` and `registerContentLearningRoutes(...)` previously received no scope guard | CLOSED IN CODE: reference and learning routes now use the shared guard; keep wider tenant model work open |
| P1 | Portal/admin Content writes are global | `content-admin-write.ts` and `portal/content-routes.ts` mutate/read by id or global tables | Safe for a founder-only platform console, not safe for tenant admin/support workflows |
| P1 | Id-only content helper mutations | `updateFeedback`, `markScriptGenerated`, `getTopicById`, `removeChannel`, `updateChannelStatus` | These are safe only when callers prove ownership; contracts should make ownership explicit |
| P1 | Content scheduling bypasses Secretary arbitration | `content-topic-secretary-sync.ts` creates tasks/calendar events directly | Secretary is supposed to arbitrate schedule capacity and conflicts across skills |
| P1 | Content source/provenance model is incomplete | Channels/books/knowledge exist, but no unified source registry for books/channels/links | Creative intelligence needs traceable, fresh, permissioned references |
| P1 | Skill memory/version tracking is missing | No first-class skill release/version ledger found for Chat, Secretary, Training, Finance, Cooking, Content | Future releases need memory of capability changes, open items, rollout status, and test evidence |
| P2 | Hardcoded creator defaults and wording remain | Discovery buckets and workflow taste prompt include fixed creator assumptions | Makes Content feel less like a configurable creative operating system |
| P2 | iOS cannot deep-link to specific Content artifact from notification | `SkillsHubView.swift` documents missing notification resolver API | Users land on the hub instead of the exact topic/script/action needing attention |
| P2 | iOS does not expose provenance/novelty/lifecycle quality states | Current Content UI renders home, workbench, pipeline, scripts, topics, backstage | Richer backend intelligence would be flattened unless iOS contracts evolve |
| P2 | Portal dashboard is platform-global | `content-dashboard.ts` aggregates all content reference rows | Good for founder ops, unsafe as tenant-admin content console without role/scope changes |
| P3 | Misleading comments imply fixed Claude/Sonnet route | `content-script-routes.ts` comment says Claude Sonnet | Documentation drift can cause future hardcoded model assumptions |

## What Exists Today

- A real Content skill screen and API surface.
- Per-user content references for books/channels/Voice DNA.
- A topic scheduler with task/calendar sync.
- Content home contract with degraded-mode metadata.
- A content-engine proxy that preserves central TypeScript model selection for script generation.
- Cost guardrail around script generation.
- Cache invalidation hooks for Content-derived state.

## What Is Missing

- Tenant-owned content reference libraries.
- Explicit user-private vs tenant-shared content boundaries.
- Unified source/provenance records for books, channels, links, extracted snippets, and learned patterns.
- Content memory with freshness/confidence, source attribution, and safe forgetting/versioning.
- Editorial artifact lifecycle spanning idea, brief, draft, script, packaging, schedule, publish, performance, and learning.
- Novelty/reuse controls that are explicit and route through the provider layer.
- Content quality evaluation harness.
- Day-to-day content workflow simulation.
- Content-to-Secretary scheduling intents.
- First-class link references.
- Portal tenant/admin policy for content visibility and mutations.
- Skill version tracking across all Nexus skills.

## What Is Brittle

- AsyncLocalStorage-based user inference in dedup/diversity helpers.
- Id-only helper functions with no ownership parameter.
- Global portal/admin mutation routes.
- Discovery prompt tied to a static creator config.
- Direct Anthropic fallback in Content paths.
- Shared context signal bus without tenant_id.
- iOS notification deep-link behavior that acknowledges but cannot resolve the concrete content artifact.

## What Must Be Preserved

- Token-Zero rule: operational Content flows must remain REST, not fake chat commands.
- Live provider routing and operator override architecture.
- Cost guardrails for AI-using Content endpoints.
- Existing iOS contracts and degraded-mode behavior.
- User-scoped rows and owner_scope fallback semantics for legacy/system references.
- Precise calendar sync behavior with provider event IDs. Do not introduce broad date/title cleanup.

## Proposed Architecture Direction

Content Creation should be split into explicit layers:

1. Reference Registry
   - Book, channel, link, note, transcript, source snippet, and extracted pattern records.
   - Fields: source_id, source_type, tenant_id, user_id, owner_scope, visibility, freshness, confidence, provenance_url, rights_status, extraction_status, last_used_at.

2. Creator Profile And Voice Memory
   - Versioned creator profile, platform preferences, audience, voice DNA, constraints, do-not-use rules.
   - User-private and tenant-shared variants.

3. Content Artifact Lifecycle
   - Idea, brief, outline, script, packaging, scheduled item, publication, performance learning.
   - Lifecycle state and versioning.

4. Quality And Novelty Engine
   - Duplicate, near-duplicate, reuse, source overlap, platform fit, brand consistency, claim support.
   - Provider-routed, tenant-scoped, and test-backed.

5. Cross-Skill Opportunity Layer
   - Training progress, Cooking/fueling moments, Finance/product decisions, Secretary calendar gaps.
   - Content uses summaries with source/freshness/confidence rather than raw cross-skill dumps.

6. Secretary Scheduling Contract
   - Content submits scheduling intents for writing, filming, editing, publishing, and review blocks.
   - Secretary owns placement, conflicts, reflow, and calendar provider sync.

7. Evaluation Harness
   - Persona/scenario bank for real creator workflows.
   - Scores originality, usefulness, platform fit, provenance, tenant safety, and schedule coordination.

## Recommended Implementation Sequence

1. Fix P1 routing and scope hazards that are safe and additive.
2. Add typed content source/provenance contracts without changing existing UI behavior.
3. Add explicit content memory metadata and source attribution.
4. Add content artifact lifecycle contracts and tests.
5. Introduce Secretary scheduling intents behind existing topic scheduler behavior.
6. Expand iOS DTOs to render source/provenance/lifecycle/decision states.
7. Add portal policy docs and, if needed, tenant-safe admin/support surfaces.
8. Add evaluation harness and local full-product smoke.
9. Add skill version tracking across Nexus.

## Do-Not-Break List

- Do not route operational Content flows through Chat.
- Do not hardcode GPT, Claude, Gemini, or any single provider.
- Do not remove existing system/global reference fallback without a migration plan.
- Do not expose platform-global Content dashboard as tenant admin tooling.
- Do not mutate or delete Content references by id unless ownership/scope is proven.
- Do not create calendar cleanup by date/title matching.
- Do not claim local/staging smoke success until the commands actually run.
