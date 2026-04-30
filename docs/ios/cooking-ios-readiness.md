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

## Gaps

- Render assessment warnings/blockers.
- Render allergy/restriction warning distinctly.
- Render pantry available/expired status from shopping-list items and pantry list rows.
- Render substitution/review prompts once substitution engine lands.
- Capture user correction input.
- Invalidate Cooking cache on tenant switch.
- Unknown enum/state fallback tests.

Verdict: PASS WITH CONDITIONS. No iOS code was modified in this backend pass.
