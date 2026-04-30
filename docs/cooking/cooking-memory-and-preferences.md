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

## Still Open

- Dedicated write/update APIs for Cooking preferences.
- Automatic correction handling from Chat utterances such as "stop suggesting mushrooms."
- Stale preference downgrade job.
- User-facing preference review in iOS/portal.

