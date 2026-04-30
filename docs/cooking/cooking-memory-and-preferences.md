# Cooking Memory And Preferences

Date: 2026-04-30

## Memory Types

Cooking should store and retrieve:

- allergies
- dietary restrictions
- ingredient dislikes
- preferred ingredients
- cuisine preferences
- cooking skill level
- equipment
- prep-time tolerance
- batch-cooking preference
- budget sensitivity
- grocery preferences
- favorite meals
- rejected meals
- training-day fueling preferences
- recovery meal preferences
- user corrections

## Required Scope Metadata

Every Cooking memory must include:

- `tenant_id`
- `user_id` where user-private
- `scope`
- `skill_id=cooking`
- `memory_type=cooking_preference` or approved related type
- confidence/freshness
- source
- schema/version
- correction lineage

## Implemented In This Branch

- Deterministic `buildCookingPreferenceMemorySummary()` for safe prompt/context summaries.
- Assessment input accepts preference profiles for allergy, restriction, disliked ingredient, prep-time, budget, and training-day logic.
- Skill registry candidate records memory schema compatibility as `cooking-memory-v1`.
- `src/services/cooking-preferences.ts` writes and reads user-private Cooking preference memory through `skill_memories`.
- `GET /api/v1/cooking/preferences` and `POST /api/v1/cooking/preferences` expose tenant-scoped read/write/correction contracts.
- Chat tools `cooking_set_preference` and `cooking_get_preferences` let Chat record explicit user corrections without bypassing backend authorization.
- `GET /api/v1/cooking/meal-plan` now applies active Cooking preference memory before returning deterministic assessment warnings/blockers.

## Still Open

- Stale preference downgrade job.
- User-facing preference review in iOS/portal.
