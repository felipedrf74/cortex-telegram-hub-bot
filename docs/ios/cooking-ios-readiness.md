# Cooking iOS Readiness

Date: 2026-04-30

## Current Readiness

Existing iOS contracts can consume recipes, meal plans, shopping lists, Training adaptations, and prep-event scheduling responses.

## New Backend Field

`GET /api/v1/cooking/meal-plan` now includes an additive `assessment` block:

- status
- confidence
- issues
- groceryCoherence
- scheduleFit
- budgetFit
- trainingFit

Existing clients should ignore it safely if not decoded.

Pantry now also has additive backend routes:

- `GET /api/v1/cooking/pantry`
- `POST /api/v1/cooking/pantry/items`
- `GET /api/v1/cooking/pantry/items/:id`
- `PATCH /api/v1/cooking/pantry/items/:id`
- `DELETE /api/v1/cooking/pantry/items/:id`

Shopping-list items may now include `pantry_status`,
`pantry_item_id`, `pantry_freshness_status`, and `pantry_note`.

Cooking preference memory now has additive backend routes:

- `GET /api/v1/cooking/preferences`
- `POST /api/v1/cooking/preferences`

`GET /api/v1/cooking/meal-plan` may also include
`preferences.summary` so iOS can show what memory influenced warnings without
rendering raw prompt context.

## Gaps

- Render assessment warnings/blockers.
- Render allergy/restriction warning distinctly.
- Render pantry available/expired status from shopping-list items and pantry list rows.
- Render preference/correction state and expose a correction capture path.
- Render substitution/review prompts once substitution engine lands.
- Invalidate Cooking cache on tenant switch.
- Unknown enum/state fallback tests.

Verdict: PASS WITH CONDITIONS. No iOS code was modified in this backend pass.
