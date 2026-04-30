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
| P1 | iOS rich warning/substitution/correction rendering | Fixed in focused code/tests and local simulator smoke: assessment/context/preference rendering landed on iOS branch `feature/cooking-rich-state-ui` at `f4f1053`; pantry freshness UI landed at `cfe5df4`; correction capture landed at `e8cdc80`; assessment review prompts landed at `d7eb9f4`; compact substitution suggestion rendering landed at `7be4b6f`; simulator smoke passed against local backend `127.0.0.1:8200` |
| P1 | Portal Cooking preference/pantry console | Fixed for preference/pantry scope: backend admin/operator routes and browser UI are implemented and tested; browser runtime smoke passed against `127.0.0.1:8200/portal` |
| P1 | Full local runtime smoke with backend, workers/cache, and fixture model | Fixed with attached backend full-smoke on `127.0.0.1:8326`, plus rich iOS/portal smoke on `127.0.0.1:8200` |
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
3. Add dedicated substitution acceptance/replacement actions if needed beyond compact rendering.
4. Add portal recipe library, meal-plan, and grocery-settings deep editors when
   the backend mutation contracts exist.
5. Add real-provider quality sampling under the normal provider-call limits.
