# Content Creation Current-State Audit

Date: 2026-04-29
Branch: `feature/content-creation-intelligence-upgrade`
Rollback branch/tag: `backup/content-before-intelligence-upgrade-20260429-1636`, `backup-content-before-intelligence-upgrade-20260429-1636`
Mode: Audit and planning. No deployment. No production data mutation.

## Scope

This audit covers the Content Creation backend, content-engine proxy, iOS-facing contracts, portal/admin surfaces, cross-skill scheduling hooks, model-routing behavior, tenant/privacy boundaries, and the new requirement for skill memory plus skill version tracking.

Content Creation currently has useful product foundations:

- iOS-facing content home contract: `GET /api/v1/content/home`.
- Pipeline and idea surfaces: `/api/v1/content/pipeline`, `/api/v1/content/ideas`.
- Topic scheduler with Secretary task/calendar artifacts.
- Per-user books, channels, Voice DNA, radar preferences, content topics, content scripts, and content learning tables added across migrations `056`, `059`, `071`, `073`, `074`, and `078`.
- Python content-engine that calls back into the TypeScript AI proxy instead of calling one fixed provider directly.
- iOS Content screen with home state, pipeline, script generator, topic scheduler, notes, backstage intelligence, and degraded-state banners.

The current system is not yet a full creative intelligence layer. It still mixes user-scoped and global/system content state, has routing bypasses, has portal/admin surfaces that are platform-global, and lacks a first-class content source/provenance/lifecycle model for books/channels/links/editorial memory.

## Backend Module Structure

Primary routes:

- `src/api/routes/content.ts`
- `src/api/routes/content-reference-routes.ts`
- `src/api/routes/content-script-routes.ts`
- `src/api/routes/content-intelligence-routes.ts`
- `src/api/routes/content-pipeline-routes.ts`
- `src/api/routes/content-topic-routes.ts`
- `src/api/routes/content-learning-routes.ts`
- `src/api/routes/content-dashboard.ts`
- `src/api/routes/content-admin-write.ts`
- `src/api/routes/chat-content-refinement.ts`

Primary services/state:

- `src/services/content-engine.ts`
- `src/services/content-discovery.ts`
- `src/services/content-dedup.ts`
- `src/services/content-learning-store.ts`
- `src/services/content-workflow.ts`
- `src/services/content-topic-secretary-sync.ts`
- `src/services/content-intelligence.ts`
- `src/services/content-dashboard-service.ts`
- `src/services/content-home-view-state.ts`
- `src/services/content-radar-preferences.ts`
- `src/state/content-references.ts`
- `src/state/saved-ideas.ts`
- `src/domains/content-creator.ts`

Python content engine:

- `content-engine/main.py`
- `content-engine/services/claude_client.py`
- `content-engine/services/orchestrator.py`
- `content-engine/services/creator_profile.py`
- `content-engine/services/book_knowledge.py`

## Data Model Snapshot

Content tables are partially user-scoped:

- `content_topics` is user-owned and carries scheduler fields plus Secretary artifact metadata.
- `content_scripts`, `content_performance`, `content_learned_patterns` have `user_id`.
- `book_library`, `content_ref_channels`, and `content_knowledge` have `user_id` plus `owner_scope` after migration `073`.
- `content_radar_preferences` is per-user.
- `content_notifications` is per-user.

Content tables are not fully tenant-aware:

- The reference model is primarily `user_id` plus `owner_scope`.
- System/global rows are intentionally available as shared defaults.
- The shared-context signal bus remains user/global rather than tenant-scoped, consistent with `docs/context/shared-context-risk-register.md`.

This means Content can support user-private personalization today, but should not yet claim full tenant-safe content reference sharing, tenant-owned brand libraries, or same-user multi-tenant content boundaries.

## iOS-Facing Contracts

iOS calls Content through REST, in line with the Token-Zero rule. Key paths:

- `Nexus Hub/Core/Services/ContentService.swift`
- `Nexus Hub/Core/Repositories/ContentRepository.swift`
- `Nexus Hub/Views/Content/ContentSkillView.swift`

The iOS repository maintains cached pipeline, ideas, content notes, topics, home view state, intelligence summary/detail, and filming recommendation. `ContentRepository.reset()` clears these on sign-out.

Observed iOS limits:

- Content cache is repository-level and reset on sign-out, but the repository itself does not expose a tenant-scoped cache key. Multi-tenant same-user switching must rely on app-level reset/invalidation.
- Content notifications currently route to the Skills hub and mark the notification read. They do not deep-link to a concrete content topic/script yet. `SkillsHubView.swift` explicitly documents the missing resolver API.
- iOS can render current Content home and intelligence states, but it does not yet render source/provenance, content lifecycle quality states, rights/usage status, duplicate/novelty decisions, or editorial review status as first-class UI states.

## Model Routing Snapshot

The TypeScript script path preserves live routing through the content-engine internal AI proxy:

- `content-engine/services/claude_client.py` sends prompt/system/category to `/api/v1/internal/ai-complete`.
- The Python `model` argument is kept for backward compatibility and ignored by design.

Routing risks found during audit:

- `src/services/content-dedup.ts` originally called Anthropic directly through `fetch('https://api.anthropic.com/v1/messages')`, using `config.anthropic.classifierModel`. First implementation pass replaced this with `completeOneShotWithFallback()` and a gated Anthropic thunk under category `content_dedup`.
- `src/services/content-discovery.ts` uses a local Gemini-first path with direct Anthropic fallback via `trackedCreate`. This is documented in comments but is not the same as the provider-agnostic routing layer used elsewhere.
- `src/api/routes/content-script-routes.ts` comments previously said the pipeline was "Claude Sonnet"; first implementation pass updated this to describe TypeScript AI proxy live routing.
- The Python content-engine internal AI request originally did not include tenant/user/scope metadata. First implementation pass added optional `userId`/`tenantId` support to the internal proxy and forwards `user_id` for script generation. True tenant metadata remains open because the Content script request path does not yet carry active tenant IDs.

## Tenant And Privacy Snapshot

App-facing routes are improving but not uniform:

- `content.ts` has `ensureValidContentRouteScope()`, but it validates a syntactically valid user scope, not tenant membership.
- `/content/home` uses the guard.
- `/content/discover` originally did not call the guard; first implementation pass added `content_route_discover` validation.
- `registerContentReferenceRoutes(router)` originally registered without the shared guard; first implementation pass now passes the guard to books/channels/Voice DNA routes.
- `registerContentLearningRoutes(router)` originally registered without the shared guard; first implementation pass added scoped middleware for learning routes.
- `content-reference-routes.ts` uses user filtering for books/channels/voice DNA, but it assumes `AuthenticatedRequest.userId` is sufficient and does not receive the route-scope guard.

State helpers include id-only mutation/read functions that are safe only if every caller has already scoped the resource:

- `content-workflow.updateFeedback(id, sentiment)`.
- `content-workflow.markScriptGenerated(id)`.
- `content-workflow.getTopicById(id)`.
- `content-references.getChannel(id)`.
- `content-references.updateChannelStatus(id, ...)`.
- `content-references.removeChannel(id)`.

Portal/admin content surfaces are platform-global:

- `content-admin-write.ts` applies portal scoped-token middleware, but many routes mutate global content resources by id without target tenant/user scope.
- `portal/content-routes.ts` has admin-token write routes for channels/books, but `GET /api/content-knowledge` and `GET /api/books` are read routes without the same visible admin guard in that file.
- `content-dashboard.ts` aggregates all rows for channels/transcripts/studies, which is appropriate only as a platform/operator dashboard, not as a tenant admin surface.

## Creative Intelligence Snapshot

Current content intelligence is useful but narrow:

- Discovery uses broad hardcoded interest buckets.
- The discovery system prompt loads a creator config file as canonical.
- Voice DNA and content knowledge can be per-user.
- Content scripts can use user Voice DNA memory.
- Deduplication checks recent saved ideas and feedback, but uses request context instead of an explicit user/tenant argument.
- No first-class link reference registry exists yet.
- Source/provenance is partial: channels, books, studies, and knowledge have source-ish fields, but there is no unified reference/source object with freshness, confidence, ownership, rights, extraction status, or "last used in output".
- Editorial lifecycle is split between ideas/pipeline/topics/scripts, not represented as a single versioned content artifact lifecycle.

## Cross-Skill Snapshot

Content already coordinates with Secretary and Training in limited ways:

- `content-topic-secretary-sync.ts` creates/updates task artifacts for date-only topics.
- It creates/updates calendar events for date-time topics.
- Content home/intelligence can show filming recommendations based on Secretary and Training signals.

The current scheduling path still directly creates tasks/calendar events instead of submitting a Secretary scheduling intent. It uses provider event IDs and does not use broad date/title deletion, which is good. But it does not yet align with the newer Secretary-as-arbitrator model.

## Tests Observed

Existing test coverage includes many Content route/service tests:

- `__tests__/api/content-*`
- `__tests__/services/content-*`
- `__tests__/services/content-learning-store.test.ts`
- `__tests__/services/content-workflow-user-scope.test.ts`
- `__tests__/services/content-radar-preferences.test.ts`
- `__tests__/services/content-owner-scope.test.ts`

No new tests were added in this audit-only pass. No smoke run was claimed.

## Initial Release-Gate Verdict

Verdict: NO-GO for a Content Creation production release claim.

Reason: the branch is safely prepared and the foundations are strong, but the product cannot honestly claim tenant-safe content intelligence, provider-agnostic routing across all Content AI paths, complete Content-to-Secretary arbitration, first-class source/provenance lifecycle, or iOS/portal readiness for the richer states yet.
