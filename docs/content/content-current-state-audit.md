# Content Current-State Audit

Date: 2026-04-29
Branch: `feature/content-creation-intelligence-upgrade`
Rollback branch/tag: `backup/content-before-intelligence-upgrade-20260429-1636`, `backup-content-before-intelligence-upgrade-20260429-1636`
Current backend HEAD at branch creation: `888b69e`
Mode: Current-state audit. No deployment.

## Branch And Rollback Protection

- Current working branch: `feature/content-creation-intelligence-upgrade`.
- Rollback branch exists: `backup/content-before-intelligence-upgrade-20260429-1636`.
- Rollback tag exists: `backup-content-before-intelligence-upgrade-20260429-1636`.
- Work is not on `main`, `master`, or production.
- Earlier in this Content workstream, safe P1 hardening edits were made and validated. This document records the current truth rather than pretending the tree is still docs-only.

## Module Structure

Primary backend routes:

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

Primary backend services/state:

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
- `content-engine/models/requests.py`
- `content-engine/services/claude_client.py`
- `content-engine/services/orchestrator.py`
- `content-engine/services/creator_profile.py`
- `content-engine/services/book_knowledge.py`
- `content-engine/services/creative/script_writer.py`

## What Exists Today

- iOS-facing Content home: `GET /api/v1/content/home`.
- Content pipeline and ideas APIs.
- Topic scheduler with task/calendar artifacts.
- Per-user books, channels, Voice DNA, radar preferences, content topics, scripts, and learning tables across migrations `056`, `059`, `071`, `073`, `074`, and `078`.
- Content script generation through the Python content engine, which calls back into the TypeScript internal AI proxy.
- User-scoped Content references with `owner_scope` for system/user-owned rows.
- Content home degraded-mode metadata.
- iOS Content screens for home, pipeline, script generation, topic scheduler, notes, backstage intelligence, and degraded-state banners.
- Existing focused test coverage for Content routes, workflow scope, reference routes, learning routes, script hardening, and Python proxy behavior.

## Current Content Agent Logic

Content agent behavior is split across route/service layers rather than one explicit agent model. The system can use creator profile/Voice DNA and reference data, but there is not yet a versioned Content Agent contract that captures audience, platform strategy, voice rules, do-not-use rules, cadence, review policy, and tenant/user visibility in one place.

## Content Radar Logic

Radar preferences exist and can influence content suggestions. Discovery still uses broad interest buckets and prompt-driven generation. It does not yet have a first-class ranking model with source freshness, confidence, novelty, schedule feasibility, and cross-skill opportunity scoring.

## Reference Management

Books, channels, Voice DNA, learned patterns, and content knowledge exist. Links are not yet a first-class reference type with extraction/provenance/prompt-injection metadata. Source handling is fragmented across books, channels, knowledge, saved ideas, search sources, and scripts.

## Source Retrieval And Provenance

The system has partial source concepts:

- Saved ideas have source/source_date fields.
- Channels and knowledge rows have source-ish metadata.
- Gemini provider can extract search grounding sources.
- Script packaging lineage exists in migration `074`.

Missing:

- Unified source/reference registry.
- Freshness and confidence on every consumed source.
- Rights/usage status.
- Last-used metadata.
- Clear "these exact references influenced this output" lineage.

## Idea And Script Generation

Content can generate ideas and scripts. Script generation benefits from user-scoped creator profile/Voice DNA and internal AI proxy routing. Current gaps are stronger novelty controls, explicit source grounding, platform-specific quality gates, review/approval lifecycle, and repeat detection at artifact level rather than only recent-idea level.

## Workflow And Lifecycle States

Current lifecycle is split across ideas, topics, pipeline items, scripts, and topic scheduler artifacts. There is no single versioned content artifact lifecycle spanning capture, triage, brief, draft, review, package, schedule, publish, measure, archive, reject, and repurpose.

## Content Calendar Integration

`content-topic-secretary-sync.ts` can create/update task and calendar artifacts for topic schedules. It uses provider event IDs and avoids broad date/title deletion. However, Content still creates schedule load directly instead of submitting a Secretary scheduling intent. This conflicts with the newer Secretary-as-arbitrator direction.

## Voice/Profile Logic

Voice DNA and creator profile support exist. Static or fallback creator assumptions still appear in some discovery/profile paths. Excellent Content requires explicit per-user/tenant profile fields, confidence, versioning, and follow-up prompts when voice/profile data is weak.

## Content Memory

Content has learned patterns and Voice DNA, but not a full memory model that separates stable preferences, temporary project context, tenant-shared brand memory, user-private creator memory, source-derived facts, and stale/uncertain facts.

## Duplicate Detection

Deduplication exists. Earlier in this workstream, direct Anthropic usage in `content-dedup.ts` was replaced by `completeOneShotWithFallback()` under category `content_dedup`, and cache scope now includes user context. Broader artifact-level novelty/reuse control is still missing.

## Platform-Specific Generation

Content supports multiple output shapes, but platform policy is not yet explicit enough. We need per-platform constraints for hooks, captions, scripts, outlines, shorts, long-form, carousels, and reuse variants, with tests that evaluate format fit rather than only successful API responses.

## Approval And Review Flows

Current review behavior is implicit. The system needs explicit states for draft, needs_review, approved, rejected, revision_requested, scheduled, published, measured, and archived, plus iOS/portal support.

## Cross-Skill Signals

Content already uses limited Secretary/Training signals for home/intelligence. It does not yet use a typed cross-skill opportunity contract with source, freshness, confidence, tenant/user scope, priority, and deduplication. It must not ingest raw cross-skill data without need.

## Tenant/User Scoping

Current posture:

- App-facing Content is primarily user-scoped.
- `owner_scope` supports system/user ownership.
- Earlier hardening added route guards to discovery, reference, and learning routes.
- Workflow helper scope was improved for feedback and topic/script helper paths.

Open posture:

- Tenant-owned content references are not yet modeled end to end.
- Shared context is not a full tenant mesh.
- Portal/admin Content surfaces remain platform-global or founder/operator-oriented.
- True same-user multi-tenant Content memory separation is not yet proven.

## iOS-Facing APIs

iOS uses REST in line with Token-Zero. Key files:

- `Nexus Hub/Core/Services/ContentService.swift`
- `Nexus Hub/Core/Repositories/ContentRepository.swift`
- `Nexus Hub/Views/Content/ContentSkillView.swift`

Known iOS limits:

- Content cache reset exists on sign-out, but richer tenant-scoped cache keys and same-user tenant switching need proof.
- Notifications can route to Skills hub, but deep-linking to exact content artifact still needs a resolver.
- iOS does not yet render source provenance, novelty decisions, rights status, lifecycle review states, or content calendar decision reasons.

## Portal-Facing APIs

Portal/admin surfaces exist for content operations and dashboards. They should be treated as platform/founder tooling until explicit tenant-admin policy, audit, and content visibility controls are implemented.

## Model Routing Usage

Current truth:

- Script generation goes through the TypeScript internal AI proxy.
- The Python request model now carries optional `user_id` and `tenant_id`; script generation forwards `user_id`.
- Internal AI proxy now accepts optional user/tenant metadata and preserves centralized provider routing.
- Dedup now uses provider-routed completion with a gated Anthropic thunk.
- Discovery still has local Gemini-first plus direct tracked Anthropic fallback logic, not the same central provider-routing abstraction.

Do not claim a fixed GPT, Claude, Gemini, or other single-provider runtime. Nexus runtime selection remains configurable.

## Tests And Validation

Focused tests were run after the earlier safe hardening pass:

- Content route/reference/learning/workflow/dedup tests passed.
- Internal AI route and Python engine hardening tests passed.
- `npm run typecheck` passed.

This audit document itself does not claim full local product smoke, iOS smoke, staging smoke, or production readiness.

## Observability

Content has category tags and degraded-mode metadata in several paths. Missing observability remains around content source usage, novelty/reuse decisions, source freshness, provider fallback reasons per Content artifact, tenant-safe model-call metadata for every path, and prompt/context minimization evidence.

## Local Full-Product Smoke Readiness

Not complete. A real Content release gate still needs local full-product smoke covering backend APIs, auth/session, tenant/user context, Chat, Secretary, Training, Cooking, Finance, Content, model fixture mode, workers, local DB/cache, iOS simulator where possible, and resource cleanup.

