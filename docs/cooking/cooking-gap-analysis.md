# Cooking Gap Analysis

Date: 2026-04-30

## Priority Matrix

| Priority | Gap | Status |
|---|---|---|
| P0 | Cooking persistence lacks explicit tenant metadata | Fixed in this branch with migration `102` and scoped service queries |
| P0 | Cross-tenant Cooking reads/writes possible if future same-user tenants are enabled without storage scope | Fixed at service layer for recipes, meal plans, and shopping lists |
| P0 | Allergy/restriction conflicts not deterministically blocked | Fixed for explicit Cooking preference memory and route-supplied profiles |
| P1 | Dedicated pantry persistence | Fixed with migration `104`, tenant-scoped service APIs, REST APIs, and Chat tools |
| P1 | Cooking preference/memory writer and correction flow | Fixed with `cooking-preferences.ts`, REST APIs, Chat tools, and meal-plan assessment read path |
| P1 | Finance/Secretary runtime context read-back | Fixed with `cooking-planning-context.ts` and route-level assessment integration |
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

1. Add route/tool support for meal-plan generation using structured constraints.
2. Add item-price grocery budget optimizer and Secretary-driven alternative-window proposals.
3. Extend iOS and portal DTOs for Cooking assessment/pantry/preference states.
4. Run full local runtime smoke with fixture model and archived logs.
