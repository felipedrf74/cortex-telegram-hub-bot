# Skill Memory And Version Tracking Plan

Date: 2026-04-29
Branch: `feature/content-creation-intelligence-upgrade`

## Purpose

Nexus needs a first-class way to remember what each skill can do, what changed in each release, what tests proved it, what remains open, and which memories/context items are safe to reuse. This plan covers:

- Chat
- Secretary
- Training
- Finance
- Cooking
- Content Creation

## Current Gap

Today, skill state is scattered across code, docs, migrations, local smoke reports, and release notes. The product has rich implementation history, but not a durable skill-version ledger that the app, operators, and future agents can query.

Risks:

- A future release may regress a capability because the capability was documented only in prose.
- Chat may overclaim a skill capability that is not live.
- Skills may reuse stale or unsafe memory.
- Operators cannot easily see which skill improvements are deployed, staged, or only local.
- iOS may render states that backend does not yet guarantee, or vice versa.

## Proposed Skill Version Model

Create a durable skill release/version registry with fields similar to:

- `skill_id`: chat, secretary, training, finance, cooking, content
- `version`: semantic or release-counter version
- `release_branch`
- `commit_sha`
- `status`: local, staged, production, rolled_back, deprecated
- `capabilities_added`
- `capabilities_changed`
- `bug_fixes`
- `known_limitations`
- `open_items`
- `test_evidence`
- `local_smoke_evidence`
- `staging_smoke_evidence`
- `production_health_evidence`
- `rollout_started_at`
- `rollout_completed_at`
- `rollback_ref`
- `operator_notes`

## Proposed Skill Memory Model

Skill memory should be explicit and safe:

- `memory_id`
- `skill_id`
- `tenant_id`
- `user_id`
- `scope`: user-private, tenant-shared, system, operator
- `source`: user answer, tool result, skill output, provider summary, operator note
- `source_entity_type`
- `source_entity_id`
- `freshness`
- `confidence`
- `valid_from`
- `expires_at`
- `superseded_by`
- `sensitivity`
- `retention_policy`
- `last_used_at`
- `use_count`
- `audit_reason`

## Required Behavior

- Chat can ask "what capability is live?" without reading stale docs.
- Skills can version their outputs and invalidate stale memories.
- Release notes can be generated from structured changes.
- Cross-skill context can cite source/freshness/confidence.
- iOS and portal can render "available, degraded, staged, blocked" skill states honestly.
- Future Codex/Claude work can start from a queryable release truth source.

## Implementation Sequence

1. Add docs-only registry spec and test matrix.
2. Add additive tables for skill versions and skill memory events.
3. Backfill current live capabilities from release docs.
4. Add service APIs for read-only skill capability truth.
5. Add write APIs for release tooling and controlled operator updates.
6. Add tests for scope, retention, supersession, and rollback visibility.
7. Wire Chat and Content prompts to consume capability summaries rather than stale freeform docs.

## Open Questions

- Whether skill version records should be user-visible or only operator/internal.
- Whether tenant admins can pin or disable skill capabilities.
- Whether skill memory should share the same retention/export/delete policy as Chat memory.
- How to handle local-only capabilities during development without exposing them as production truth.

## Release-Gate Status

Partially implemented on 2026-04-29:

- Skill version registry foundation: `migrations/087_skill_version_registry.sql`, `src/services/skill-version-registry.ts`.
- Skill memory foundation: `migrations/088_skill_memory_foundation.sql`, `src/services/skill-memory.ts`.
- Focused tests cover version metadata, rollout lookup, safe public release history, tenant/user memory boundaries, skill memory boundaries, correction supersession, stale invalidation, and Content/Secretary/Training examples.

Still open: portal visibility, release automation, full local smoke, prompt-builder integration, and privacy/export/delete policy integration.
