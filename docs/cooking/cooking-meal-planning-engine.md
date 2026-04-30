# Cooking Meal Planning Engine

Date: 2026-04-30

## Implemented Engine Slice

`src/services/cooking-intelligence.ts` adds deterministic meal-plan assessment before any model/provider reasoning is needed.

The assessment evaluates:

- allergy conflicts
- dietary restriction conflicts
- disliked ingredients
- grocery list coherence
- pantry available/expired items
- schedule capacity by date
- grocery budget limit
- hard training days without meal support
- repeated meals
- too many high-effort meals

## API Integration

`GET /api/v1/cooking/meal-plan` now returns an additive `assessment` block alongside existing `meals`.

This is backwards compatible for current iOS clients because the existing fields are unchanged.

## Open Engine Work

- Full meal generation endpoint using structured constraints.
- Finance-backed grocery budget estimates.
- Secretary-backed available cooking windows.
- Pantry-aware meal-plan generation that actively prefers available/use-soon pantry items.
- Leftover and waste minimization planner.
- Travel-week and batch-cooking optimizer.
