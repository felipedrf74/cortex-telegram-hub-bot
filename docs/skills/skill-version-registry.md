# Skill Version Registry

Date: 2026-04-29
Branch: `feature/content-creation-intelligence-upgrade`
Scope: Cross-skill foundation for Chat, Secretary, Training, Finance, Cooking, and Content Creation.

## Purpose

The skill version registry is Nexus's structured release truth for skills. It is separate from the existing `installed_skills` toggle catalog:

- `installed_skills` answers: "Is this skill or sub-skill enabled?"
- `skill_versions` answers: "What release is live, what changed, what tests passed, what risks remain, and how do we roll back?"

This registry is designed for release management, observability, support, rollout tracking, and future rollback decisions. It is not a cosmetic version label.

## Implementation

Migration:

- `migrations/087_skill_version_registry.sql`

Service:

- `src/services/skill-version-registry.ts`

API integration:

- `GET /api/v1/skills/versions`
- `GET /api/v1/skills/versions/:skillId`
- `GET /api/v1/skills/versions/:skillId/history`
- `POST /api/v1/skills/versions` owner-only
- `POST /api/v1/skills/versions/:skillId/:version/status` owner-only
- `POST /api/v1/skills/versions/:skillId/:version/activate` owner-only

The read endpoints are safe for authenticated users and omit `internal_notes`. Mutations require owner tier. The routes do not deploy code, enable skills, disable skills, or change model routing.

## Canonical Skills

The registry tracks:

- `chat` - Chat
- `secretary` - Secretary
- `training` - Training
- `finance` - Finance
- `cooking` - Cooking
- `content` - Content Creation

The service normalizes the legacy runtime domain `triathlon` to canonical release skill id `training`.

## Version Fields

Each skill version tracks:

- `skill_id`
- `skill_name`
- `version`
- `release_type`: `major`, `minor`, `patch`, `hotfix`, `experimental`
- `release_title`
- `release_summary`
- `capabilities_added_json`
- `logic_improvements_json`
- `bug_fixes_json`
- `security_fixes_json`
- `tenant_scope_changes_json`
- `memory_context_changes_json`
- `model_routing_changes_json`
- `data_schema_changes_json`
- `ios_portal_contract_changes_json`
- `tests_added_json`
- `smoke_tests_passed_json`
- `evaluation_results_json`
- `open_risks_json`
- `known_limitations_json`
- `rollback_notes`
- `internal_notes`
- `created_by`
- `created_at`
- `activated_at`
- `deprecated_at`
- `status`: `draft`, `candidate`, `active`, `deprecated`, `rolled_back`
- `rollout_scope`: `global`, `tenant`, `user`, `canary`
- `compatible_api_version`
- `memory_schema_version`
- `quality_gate_status`

## Baseline Seed

Migration `087` seeds active global baseline records for:

- Chat `1.0.0`
- Secretary `2.0.0`
- Training `3.0.0`
- Finance `1.0.0`
- Cooking `1.0.0`
- Content Creation `2.0.0`

These seed records are intentionally conservative. They record current baseline capability truth and known limitations, not a production GO claim.

## Content Creation Candidate

Migration `095_content_creation_production_candidate_version.sql` registers:

- Skill: `content`
- Version: `2.3.0-rc.1`
- Status: `candidate`
- Rollout scope: `global`
- Quality gate: `pass_with_conditions`
- Active version remains: `content@2.0.0`

The candidate record documents the Content Creation intelligence workstream:

- tenant-safe reference registry and prompt context handling
- reference provenance and unsupported-claim review
- editorial lifecycle and approval gates
- Content Radar scoring/conversion
- creative memory and voice profile context
- duplicate, novelty, reuse, and repurposing controls
- cross-skill content opportunity contracts
- deterministic Content quality evaluation evidence

The candidate does not deploy or activate the release. It exists so support, release docs, and rollback planning can reference a concrete Content version while production conditions remain open.

## Cooking Candidate

Migration `103_cooking_intelligence_candidate_version.sql` registers:

- Skill: `cooking`
- Version: `1.1.0-rc.1`
- Status: `candidate`
- Rollout scope: `global`
- Quality gate: `pending`
- Active database-seeded version remains: `cooking@1.0.0` until explicit promotion.

The candidate record documents the Cooking intelligence foundation:

- tenant-scoped recipes, meal plans, and shopping lists
- deterministic meal-plan practicality assessment
- allergy and dietary restriction blockers
- grocery and pantry coherence checks
- schedule, budget, and Training-fit warnings
- provider-agnostic Cooking prompt/runtime guardrails

The candidate does not deploy or activate the release. It exists so support, release docs, and rollback planning can reference a concrete Cooking version while full local runtime/iOS/portal conditions remain open.

## Public Skill Metadata

Each skill can expose:

- current active version
- status
- release title and summary
- capability list
- release notes
- known limitations
- open risks
- last updated date
- compatible API version
- memory schema version
- quality gate status
- rollout scope
- rollback notes

If a future dynamic skill has no explicit version record, the service returns fallback metadata with `currentVersion: "0.0.0"` and `qualityGateStatus: "fallback"`. This preserves backward compatibility and makes missing release metadata visible rather than silently pretending.

## Rollout Model

The first implementation supports:

- global active release truth
- tenant-specific rollout metadata
- user-specific rollout metadata
- canary rollout metadata

Specific rollout lookup precedence:

1. exact user rollout
2. exact tenant rollout
3. canary rollout
4. global rollout

This lets support and release tooling answer "which version is this tenant/user supposed to be using?" without changing existing skill behavior.

## Security And Privacy

- Mutations require owner tier.
- Public reads omit `internal_notes`.
- Release notes should describe capabilities and risks without raw private user data, raw prompts, provider secrets, or tenant-sensitive incident details.
- This registry does not weaken existing auth, tenant, skill entitlement, or provider-routing gates.

## Model Routing

The registry records model-routing changes but does not control model routing. Nexus's live model routing remains provider-agnostic and operator-configurable. A release record may say "model routing changed" only when the underlying routing code/config changed and tests prove operator overrides are preserved.
