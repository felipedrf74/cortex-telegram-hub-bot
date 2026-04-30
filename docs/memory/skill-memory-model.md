# Skill Memory Model

Date: 2026-04-29
Branch: `feature/content-creation-intelligence-upgrade`

## Purpose

Nexus skills need durable memory that is useful without becoming unsafe. The skill memory foundation is separate from Chat `shared_memory` and gives every major skill a typed, scoped, version-aware memory ledger.

Implementation:

- Migration: `migrations/088_skill_memory_foundation.sql`
- Service: `src/services/skill-memory.ts`
- Tests: `__tests__/services/skill-memory.test.ts`

## Memory Types

Supported memory types:

- `user_preference`
- `tenant_preference`
- `skill_specific_memory`
- `cross_skill_signal`
- `action_history`
- `unresolved_commitment`
- `content_creative_preference`
- `schedule_preference`
- `training_preference`
- `cooking_preference`
- `finance_preference`
- `source_reference_preference`
- `voice_brand_preference`
- `correction_override`
- `stale_uncertain_memory`

## Required Fields

Each memory stores:

- `memory_id`
- `tenant_id`
- `user_id` where applicable
- `skill_id`
- `memory_type`
- `scope`: `user_private`, `tenant_shared`, `platform_internal`
- `memory_key`
- `memory_value`
- `source`
- `confidence`
- `freshness_status`: `fresh`, `uncertain`, `stale`, `expired`, `corrected`
- `status`: `active`, `superseded`, `stale`, `deleted`
- `created_at`
- `updated_at`
- `expires_at`
- `staleness_policy`
- `schema_version`
- `related_skill_version`
- `superseded_by_memory_id`
- `correction_parent_memory_id`
- `correction_history_json`
- `audit_metadata_json`
- `last_used_at`
- `use_count`

## Scope Rules

User-private:

- Requires `tenant_id` and `user_id`.
- Only the same user in the same tenant can retrieve it.

Tenant-shared:

- Requires `tenant_id`.
- Stored with `user_id = 0`.
- Authorized users in the same tenant can retrieve it.

Platform/internal:

- Reserved for future operator/system use.
- Not writable through normal skill memory APIs.
- Not returned by ordinary retrieval.

## Safety Rules

The service rejects:

- missing or invalid tenant id
- user-private memory without user id
- unsupported memory type for the skill
- unsafe keys
- empty or oversized memory values
- secrets, tokens, private keys, card-like values, and credential-like data

Memory retrieval always filters by tenant, user/scope, skill/domain, freshness, and status before returning memory to a caller or prompt builder.

## Correction Handling

When a user corrects memory:

- the previous active row is marked `superseded`
- the new row becomes active with `freshness_status = corrected`
- the new row records correction history with the superseded memory id, prior value, prior confidence, correction time, and source
- stale summaries should consume only active memory unless explicitly requesting stale history

## Prompt/Context Use

Prompt builders should use `buildSkillMemorySummary()` or scoped retrieval results. The summary includes:

- memory key
- value
- source
- confidence
- freshness

Prompt builders must not bypass the service and query `skill_memories` directly.

## Cooking Candidate Notes

The Cooking intelligence candidate keeps runtime memory compatibility at `cooking-memory-v1` and documents the next memory fields that should be written through `skill_memories`:

- allergies and dietary restrictions
- disliked ingredients
- preferred ingredients and cuisines
- equipment and skill level
- weekday prep-time tolerance
- batch-cooking preference
- budget sensitivity
- favorite/rejected meals
- training-day fueling preferences
- correction overrides

Until a dedicated Cooking memory writer is promoted, these values should enter prompt/context construction only through tenant/user-authorized fixtures, route inputs, or scoped `skill_memories` retrieval. Do not infer or store sensitive dietary data from unrelated Chat context.
