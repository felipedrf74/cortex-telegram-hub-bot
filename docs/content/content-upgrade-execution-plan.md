# Content Upgrade Execution Plan

Date: 2026-04-29
Branch: `feature/content-creation-intelligence-upgrade`
Rollback branch/tag: `backup/content-before-intelligence-upgrade-20260429-1636`, `backup-content-before-intelligence-upgrade-20260429-1636`

## Mission

Upgrade Content Creation from a useful content generation surface into a serious creative intelligence system with tenant-safe references, source grounding, creator memory, lifecycle management, quality evaluation, cross-skill opportunity detection, Secretary scheduling coordination, iOS/portal readiness, and live model-routing safety.

## Phase 0 - Protection, Product Definition, Audit

Status: In progress.

Completed:

- Confirmed working branch is not `main`, `master`, or production.
- Confirmed rollback branch and tag exist.
- Defined product outcome and quality bar.
- Audited module structure, routes, state, model routing, tenant posture, iOS posture, and product gaps.

Current branch:

- `feature/content-creation-intelligence-upgrade`

Rollback:

- Branch: `backup/content-before-intelligence-upgrade-20260429-1636`
- Tag: `backup-content-before-intelligence-upgrade-20260429-1636`

Exit criteria:

- Six kickoff docs created.
- P0/P1/P2/P3 gaps classified.
- No broad rewrite performed.

## Phase 1 - Safe Scope And Routing Hardening

Status: Partially completed by earlier safe hardening pass.

Already improved:

- `/content/discover` uses the shared Content route guard.
- Reference and learning routes use the shared guard.
- Content dedup no longer calls Anthropic directly; it uses the live routing wrapper.
- Dedup cache is user-scoped.
- Internal AI proxy accepts optional user/tenant metadata.
- Python content-engine forwards user scope for script generation.
- Workflow feedback/topic helpers now support user-scoped reads/mutations where used.

Remaining:

- Carry tenant_id through all Content app-facing and model-call paths where active tenant is available.
- Convert Content discovery fallback into the same provider-routing abstraction or document it as a provider-specific capability with tests.
- Harden portal/admin Content routes before any tenant-admin exposure.
- Add route/query tests for same-user multi-tenant Content boundaries once tenant Content model exists.

## Phase 2 - Source And Provenance Foundation

Tasks:

- Add a typed source/reference contract for books, links, channels, notes, transcripts, snippets, and learned patterns.
- Add first-class link references with extraction status, prompt-injection safety labels, provenance URL, freshness, confidence, and rights/usage metadata.
- Store source ledgers on generated artifacts.
- Add tests for source ownership, source retrieval scope, source attribution, stale source handling, and hallucinated-source prevention.

Exit criteria:

- Content can explain which references influenced an output.
- Unauthorized sources are filtered before prompt construction.

## Phase 3 - Creator Profile, Voice, And Memory

Tasks:

- Define versioned creator profile fields for audience, platforms, voice, constraints, content goals, cadence, formats, and banned patterns.
- Separate user-private creator memory from tenant-shared brand memory.
- Add profile completeness/confidence and targeted follow-up questions.
- Add memory freshness/confidence/invalidation.
- Add user correction handling.

Exit criteria:

- Output changes measurably when profile data changes.
- Weak profile data triggers targeted questions instead of silent risky assumptions.

## Phase 4 - Content Artifact Lifecycle

Target states:

- captured
- triaged
- briefed
- drafted
- reviewed
- approved
- revision_requested
- packaged
- scheduled
- filmed
- edited
- published
- measured
- repurposed
- archived
- rejected

Tasks:

- Align ideas, topics, scripts, and pipeline rows with a versioned artifact lifecycle.
- Track source ledger, platform packaging, review status, publication state, performance learning, novelty/reuse state, and schedule status.
- Add stale/duplicate artifact prevention.

Exit criteria:

- A content item can be followed from idea to publication and learning without losing ownership, source grounding, or version history.

## Phase 5 - Cross-Skill Opportunity Detection

Tasks:

- Define typed Content opportunity inputs from Training, Cooking, Finance, Secretary, Chat, and shared context.
- Require source, freshness, confidence, scope, and relevance metadata.
- Deduplicate repeated cross-skill warnings/opportunities.
- Avoid raw cross-skill dumps into prompts.

Exit criteria:

- Content can safely say why a cross-skill opportunity matters and what context it consumed.

## Phase 6 - Secretary Scheduling Coordination

Tasks:

- Add Content scheduling intents for writing, filming, editing, publishing, review, and batch planning.
- Preserve existing topic scheduler behavior while adding Secretary arbitration for new placement decisions.
- Add tests for focus block scheduling, publishing deadlines, no-valid-slot state, and conflict reflow.

Exit criteria:

- Content no longer creates new schedule chaos independently of Secretary.

## Phase 7 - Quality Evaluation And Day-To-Day Simulation

Tasks:

- Build Content persona bank and scenario bank.
- Score outputs on originality, source grounding, platform fit, voice fit, tenant safety, novelty, schedule realism, and usefulness.
- Include prompt-injection link/reference tests.
- Include model fixture mode and limited real provider calls where appropriate.

Exit criteria:

- Content quality can be measured repeatedly instead of judged by snapshots or happy paths.

## Phase 8 - iOS And Portal Readiness

iOS tasks:

- Add source/provenance chips.
- Render lifecycle, review, novelty, and schedule states.
- Add notification deep-link resolver for content artifacts.
- Prove tenant/cache invalidation for Content data.
- Add unknown enum/state fallback.

Portal tasks:

- Define tenant-admin versus platform-admin visibility.
- Add support diagnostics that default to metadata and audit, not raw private content.
- Add source library management only after permissions are explicit.

Exit criteria:

- Client surfaces can display richer Content intelligence without becoming security boundaries.

## Phase 9 - Release Hardening

Required validation:

- Content unit and route tests.
- Tenant/user scope tests.
- Model-routing tests.
- Source/provenance tests.
- Artifact lifecycle tests.
- Cross-skill tests.
- Local full-product smoke.
- iOS local smoke.
- Portal/admin smoke where applicable.
- Build/typecheck/lint.

Release gate:

- No unresolved P0.
- P1 fixed or explicitly accepted with rationale.
- No fake provider, smoke, or staging claims.

