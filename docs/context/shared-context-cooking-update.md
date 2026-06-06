# Shared Context Cooking Update

Date: 2026-04-30

## Summary

Cooking shared context now has a stronger backend foundation:

- `readCookingMeshContext()` can accept tenant scope.
- Cooking meal/shopping reads are tenant-filtered before shared context derivation.
- Cooking pantry items now have tenant-scoped persistence and can support future shared-context freshness/availability signals.
- Cooking-derived signals still include meal plan window, fueling support, meal execution readiness, and grocery spend forecast.

## Remaining Work

- Promote pantry freshness/availability into shared-context signals where useful.
- Add preference/correction invalidation when Cooking memory changes.
- Add Finance budget signals into meal-plan assessment.
- Add Secretary available-window signals into meal-plan generation.
- Add Content opportunity signal only with explicit permission.
