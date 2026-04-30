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

## Gaps

- Render assessment warnings/blockers.
- Render allergy/restriction warning distinctly.
- Render pantry available/expired status.
- Render substitution/review prompts once substitution engine lands.
- Capture user correction input.
- Invalidate Cooking cache on tenant switch.
- Unknown enum/state fallback tests.

Verdict: PASS WITH CONDITIONS. No iOS code was modified in this backend pass.

