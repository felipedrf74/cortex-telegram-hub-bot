# Cooking Domain Model

Date: 2026-04-30

## Core Objects

- Recipe: ingredients, instructions, prep/cook time, servings, tags, source, nutrition fields, tenant/user scope, lifecycle.
- Meal plan: date, meal type, recipe link or manual title, notes, lifecycle state, tenant/user scope.
- Shopping list: week, items, status, lifecycle state, tenant/user scope.
- Shopping item: ingredient, quantity, unit, aisle, checked state.
- Pantry item: proposed object for item, quantity, unit, freshness/expiration, confidence, tenant/user scope.
- Preference profile: allergies, restrictions, dislikes, cuisine/style, equipment, skill level, time tolerance, budget sensitivity.
- Meal assessment: deterministic warnings/blockers before the model/provider path.

## Lifecycle States

Meal states:

- planned
- scheduled
- shopped
- prepped
- cooked
- eaten
- skipped
- replaced
- archived

Grocery states:

- needed
- added_to_list
- purchased
- unavailable
- substituted
- pantry_available
- expired
- removed

Recipe/reference states:

- active
- archived
- needs_review
- stale

## Scope Fields

Recipes, meal plans, and shopping lists now carry:

- `tenant_id`
- `owner_user_id`
- `visibility_scope`
- `lifecycle_state`
- `scope_status`
- `created_by`
- `updated_by`
- `audit_metadata_json`

Legacy rows are backfilled to `tenant_id=user_id`, `owner_user_id=user_id`, and `visibility_scope=user_private`.

