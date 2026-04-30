# Cooking Gap Analysis

Date: 2026-04-30

## Priority Matrix

| Priority | Gap | Status |
|---|---|---|
| P0 | Cooking persistence lacks explicit tenant metadata | Fixed in this branch with migration `102` and scoped service queries |
| P0 | Cross-tenant Cooking reads/writes possible if future same-user tenants are enabled without storage scope | Fixed at service layer for recipes, meal plans, and shopping lists |
| P0 | Allergy/restriction conflicts not deterministically blocked | Improved by deterministic assessment; full memory-driven enforcement still P1 |
| P1 | Dedicated pantry persistence | Open |
| P1 | Cooking preference/memory writer and correction flow | Open |
| P1 | Finance-backed grocery budget model | Open |
| P1 | iOS rich warning/substitution/correction rendering | Open |
| P1 | Portal Cooking preference/pantry console | Open |
| P1 | Full local runtime smoke with backend, workers, iOS, and fixture model | Documented blocker |
| P2 | Advanced substitution model | Documented foundation, not fully implemented |
| P2 | Food waste/leftover optimization | Partial assessment only |

## Implemented Direction

- Make tenant/user ownership explicit in Cooking data.
- Keep existing APIs backwards-compatible while adding tenant-aware service parameters.
- Add deterministic pre-provider meal-plan assessment for constraints that should not depend on model behavior.
- Keep Secretary as the scheduling owner.
- Keep live model routing configurable and provider-agnostic.

## Recommended Next Sequence

1. Add pantry tables and APIs with tenant/user scope.
2. Wire Cooking preference writes into `skill_memories`.
3. Add route/tool support for meal-plan generation using structured constraints.
4. Add Finance budget read path for grocery planning.
5. Extend iOS and portal DTOs for Cooking assessment states.
6. Run full local runtime smoke with fixture model and archived logs.

