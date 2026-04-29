# Content Gap Analysis

Date: 2026-04-29
Branch: `feature/content-creation-intelligence-upgrade`

## Executive Summary

Content Creation has a real product foundation: references, Voice DNA, pipeline, scripts, topics, radar preferences, iOS screens, and model-routed script generation. It is not yet safe or accurate to call it a full creative intelligence system because source provenance, tenant-safe reference ownership, artifact lifecycle, quality evaluation, cross-skill scheduling arbitration, and skill version tracking are incomplete.

## Priority Matrix

| Priority | Gap | Status | Why It Matters |
|---|---|---|---|
| P0 | Full tenant-safe Content reference/memory model is not proven | Open | Tenant leakage in Content references, scripts, prompts, or memory is a production blocker |
| P0 | Prompt construction must never receive unauthorized references or memory | Open until tested end to end | Model providers cannot enforce tenant isolation for us |
| P1 | Content source/provenance is fragmented | Open | Serious creative output needs traceable books, links, channels, snippets, and learned patterns |
| P1 | Links are not first-class references | Open | Links are a core creator input and carry prompt-injection/provenance risk |
| P1 | Content artifact lifecycle is not unified | Open | Users need to move work from idea to publication without stale or duplicated states |
| P1 | Content scheduling bypasses Secretary arbitration | Open | Secretary must own schedule capacity, conflict handling, and calendar placement |
| P1 | Content discovery still has provider-specific fallback logic | Open | Live routing and operator overrides should remain consistent |
| P1 | Portal/admin Content surfaces are global/founder-oriented | Open | Tenant admin/support visibility needs explicit policy and audit |
| P1 | Skill memory and skill version tracking are missing | Open | Future releases need reliable capability history, open items, test evidence, and rollout state |
| P1 | Quality evaluation harness is missing | Open | We cannot measure whether Content is getting smarter or just changing output |
| P1 | iOS cannot render provenance/lifecycle/novelty states | Open | Backend intelligence would be flattened or hidden |
| P2 | Hardcoded/static creator assumptions remain in some paths | Open | Outputs can feel generic or founder-shaped |
| P2 | Duplicate detection is too narrow | Partially improved | User-scoped dedup improved, but artifact-level novelty/reuse is not done |
| P2 | Content notification deep-links are incomplete | Open | Users land on the Skills hub instead of the exact content item |
| P2 | Cross-skill opportunity detection is shallow | Open | Training, Cooking, Finance, and Secretary signals are not yet typed Content opportunities |
| P3 | Comments/docs can drift toward fixed-provider wording | Partially improved | Runtime architecture must remain provider-agnostic |

## Specific Prompt-Required Gaps

Generic content generation behavior:

- Discovery and generation can still lean on broad prompt buckets and static creator assumptions.
- Need explicit product, audience, platform, source, freshness, and novelty contracts.

Missing source attribution:

- Outputs cannot consistently show which book/channel/link/snippet informed them.
- Search grounding sources exist in one provider path but are not unified into Content provenance.

Hallucinated references risk:

- Without a source registry and generation-time source ledger, the system can overstate or invent grounding.
- Links and retrieved content need prompt-injection-safe labels before being included in prompts.

Weak voice consistency:

- Voice DNA exists, but profile completeness/confidence and versioned changes are not explicit.
- Missing follow-up questions when voice/profile data is weak.

Poor tenant separation:

- App-facing Content is user-scoped but not tenant-owned end to end.
- Same-user multi-tenant reference and memory separation is not proven.

Missing content lifecycle:

- Existing ideas/topics/scripts are useful but not one versioned artifact workflow.
- Review, approval, reuse, publication, and performance learning are not first-class across all artifacts.

Repeated ideas/scripts:

- User-scoped idea dedup improved.
- Need near-duplicate detection across scripts, angles, hooks, captions, repurposed variants, and archived artifacts.

Weak platform awareness:

- Platform-specific output quality needs explicit policies and tests.
- The system should know when to generate a short, long-form script, thread, carousel, caption, outline, or packaging set.

Missing approval/review states:

- No universal state model for draft, needs_review, approved, rejected, revision_requested, scheduled, published, and measured.

Missing cross-skill content opportunity detection:

- Training, Cooking, Finance, and Secretary signals can inform Content, but are not represented as typed, scoped, fresh Content opportunities.

Missing quality evaluation:

- No scenario bank or rubric for originality, platform fit, source grounding, brand consistency, tenant safety, schedule realism, and usefulness.

Missing memory or stale memory:

- Learned patterns and Voice DNA exist, but freshness/confidence/staleness/invalidation are incomplete.

Missing version tracking for skill improvements:

- No first-class ledger for Chat, Secretary, Training, Finance, Cooking, and Content capability changes, test status, open items, and rollout state.

## Proposed Architecture Direction

Content Creation should evolve into these explicit layers:

1. Content Source Registry
   - Books, links, channels, transcripts, notes, snippets, studies, and learned patterns.
   - Fields: source_id, source_type, tenant_id, user_id, owner_scope, visibility, provenance_url, rights_status, extraction_status, freshness, confidence, last_used_at.

2. Creator Profile And Content Memory
   - Versioned audience, voice, platforms, formats, goals, banned patterns, cadence, and language preferences.
   - Separate user-private memory from tenant-shared brand memory.

3. Content Artifact Lifecycle
   - Idea, brief, outline, script, packaging, schedule, publication, performance, reuse.
   - Versioned states, review status, lineage, source ledger, and novelty decision.

4. Quality And Novelty Engine
   - Provider-routed checks for duplicate, near-duplicate, platform fit, source support, brand fit, and reuse strategy.

5. Cross-Skill Opportunity Layer
   - Scoped summaries from Training, Cooking, Finance, Secretary, and Chat.
   - Source/freshness/confidence metadata required before use.

6. Secretary Scheduling Contract
   - Content submits writing, filming, editing, review, and publishing intents.
   - Secretary returns scheduled, reflowed, compressed, deferred, unscheduled, rejected, or needs_more_context.

7. Evaluation Harness
   - Repeatable local scenarios with product-quality scoring, tenant-safety scoring, and source-grounding scoring.

## Do-Not-Break List

- Do not route operational Content actions through fake chat commands.
- Do not hardcode any model provider as the Content runtime default.
- Do not remove legacy user/system reference behavior without migration and rollback.
- Do not expose platform-global dashboards as tenant admin surfaces.
- Do not mutate by id without ownership/scope checks.
- Do not create calendar cleanup by title/date matching.
- Do not make iOS a security boundary.
- Do not claim full-product smoke, iOS smoke, or staging proof until actually run.

