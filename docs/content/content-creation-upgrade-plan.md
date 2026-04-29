# Content Creation Upgrade Execution Plan

Date: 2026-04-29
Branch: `feature/content-creation-intelligence-upgrade`

## Goal

Upgrade Content Creation from a generic generation surface into a tenant-safe creative intelligence system with explicit reference provenance, creator memory, content lifecycle, editorial workflow, quality evaluation, cross-skill opportunity detection, and Secretary coordination.

## Phase 0 - Rollback And Audit

Status: In progress.

Completed:

- Backend rollback branch/tag created.
- iOS rollback branch/tag created.
- Backend working branch created: `feature/content-creation-intelligence-upgrade`.
- iOS working branch created: `feature/ios-content-creation-intelligence-upgrade`.
- Current-state audit and gap map created.

No code changes have been made in this phase beyond documentation.

## Phase 1 - Routing And Scope Safety

Primary objective: close safe P1 hazards before deeper product work.

Tasks:

- Add the shared Content route scope guard to `/content/discover`.
- Pass the route guard into reference routes or add equivalent guard checks inside `content-reference-routes.ts`.
- Replace direct Anthropic dedup call with provider-routed completion using existing model routing.
- Preserve category tags for cost tracking: `content_dedup`, `content_discovery`, `content_script`, `content_quality`.
- Add user/tenant-safe metadata to internal AI proxy calls from the Python content-engine where request context is available.
- Make content helper functions require explicit `userId` or `ownerScope` for mutations that currently update by id.
- Add tests for cross-user content route access, id-only mutation denial, and provider-routing preservation.

Acceptance:

- No Content AI call hardcodes a single provider unless documented as a provider-specific capability with gated fallback.
- App-facing Content routes consistently validate authenticated user scope.
- Provider call logs include provider/model/tier/category/fallback metadata without raw prompt leakage.

## Phase 2 - Reference And Provenance Model

Primary objective: make books, channels, links, and learned patterns traceable.

Tasks:

- Add a typed content reference/source contract.
- Support links as first-class references.
- Track source type, owner scope, user/tenant ownership, provenance URL, freshness, confidence, extraction status, rights/usage status, and last-used metadata.
- Add APIs for source list/detail/search with user-private and tenant-shared visibility.
- Add tests for source ownership, provenance persistence, stale source handling, and unauthorized access denial.

Acceptance:

- Generated or suggested content can explain which references influenced it.
- References are tenant/user safe before prompt construction.

## Phase 3 - Creator Profile And Content Memory

Primary objective: replace static creator assumptions with explicit, versioned creator memory.

Tasks:

- Define creator profile fields: audience, platforms, voice, worldview, constraints, formats, banned patterns, language, cadence, content goals.
- Split memory into stable preferences, learned performance patterns, temporary conversation/project context, and stale/uncertain facts.
- Add freshness/confidence/source metadata to learned content memory.
- Add user correction handling and invalidation.
- Add tests for profile updates changing output, stale memory handling, and cross-tenant memory separation.

Acceptance:

- Content output changes based on user/tenant profile in measurable ways.
- The system can say why it used a voice/source/memory item.

## Phase 4 - Content Lifecycle And Editorial Workflow

Primary objective: track creative work as artifacts, not loose ideas.

Lifecycle states:

- captured
- triaged
- briefed
- drafted
- reviewed
- packaged
- scheduled
- filmed
- edited
- published
- measured
- archived
- rejected

Tasks:

- Create or align content artifact state with existing ideas/topics/scripts.
- Track source references and version lineage.
- Add review/approval notes, platform packaging, publication metadata, and performance learning.
- Add duplicate/novelty/reuse states.
- Add tests for lifecycle transitions, stale artifact prevention, and iOS DTO decoding.

Acceptance:

- Users can follow a content item from idea to publication and learning.

## Phase 5 - Secretary And Cross-Skill Coordination

Primary objective: Content should not create schedule load independently.

Tasks:

- Add Content scheduling intents for writing, filming, editing, publishing, review, and batch planning.
- Keep existing topic scheduler behavior backward compatible while routing new decisions through Secretary where available.
- Use Training, Cooking, Finance, and shared context only as scoped summaries with source/freshness/confidence.
- Add tests for Content focus block scheduling, filming day selection, publishing deadline pressure, and conflict reflow.

Acceptance:

- Secretary owns placement and conflict resolution for Content schedule demand.

## Phase 6 - Quality Evaluation And Day-To-Day Simulation

Primary objective: measure whether Content is actually useful.

Scenario bank:

- Creator asks what to make today.
- Creator asks for ideas from a book plus current trend.
- Creator asks to reuse a topic without duplicating prior content.
- Creator plans a week around Training and filming constraints.
- Creator asks for platform-specific variants.
- Creator asks "why this idea?"
- Tenant switch with tenant-specific references.
- Prompt injection in a link/reference.
- Low-confidence source or stale trend.

Scoring:

- originality
- platform fit
- source grounding
- brand consistency
- tenant safety
- actionability
- schedule realism
- novelty/reuse quality
- explanation quality

Acceptance:

- The Content skill has a repeatable local evaluation suite with actionable failure taxonomy.

## Phase 7 - iOS And Portal Readiness

Primary objective: clients must not flatten backend intelligence.

iOS tasks:

- Render source/provenance chips.
- Render lifecycle state, quality/novelty, and schedule status.
- Add tenant/cache invalidation checks for Content.
- Add notification resolver support for content artifact deep-links.
- Add unknown state fallback.

Portal tasks:

- Define platform-admin vs tenant-admin visibility.
- Add audit/diagnostic views that default to metadata, not raw private content.
- Add retention/export/delete controls where applicable.

Acceptance:

- iOS and portal can display richer Content states without becoming security boundaries.

## Phase 8 - Release Hardening

Tasks:

- Run focused Content tests.
- Run model-routing tests.
- Run tenant/security tests.
- Run local full-product smoke.
- Run iOS simulator smoke against local backend.
- Produce release gate docs and open blockers.

Release criterion:

- No P0/P1 tenant/routing/source/lifecycle blockers remain unless explicitly accepted with rationale.
