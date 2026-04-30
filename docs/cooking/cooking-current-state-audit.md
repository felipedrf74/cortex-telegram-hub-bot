# Cooking Current State Audit

Date: 2026-04-30
Branch: `feature/cooking-intelligence-upgrade`

## Code Surfaces Audited

- `src/services/cooking-chef.ts`
- `src/api/routes/cooking.ts`
- `src/services/cooking-secretary-integration.ts`
- `src/services/cross-agent-learning.ts`
- `src/services/tool-executor.ts`
- `src/domains/cooking.ts`
- `src/skills/cooking/manifest.json`
- `src/skills/cooking/prompts/system.md`
- `migrations/024_cooking_tables.sql`
- `migrations/072_recipe_nutrition.sql`
- `migrations/102_cooking_tenant_scope_and_intelligence.sql`
- `migrations/104_cooking_pantry_items.sql`
- Cooking tests under `__tests__/services` and `__tests__/api`

## Existing Strengths

- Token-zero REST endpoints exist for recipes, meal plans, shopping lists, and prep-event scheduling.
- Recipe CRUD and meal-plan CRUD are covered by tests.
- Shopping list generation merges compatible quantities and assigns grocery aisle metadata.
- Pantry is now persisted as tenant/user-scoped rows and shopping lists can mark pantry-available or pantry-expired ingredients.
- iOS route layer avoids leaking internal exception details.
- Cooking already has Training-aware meal adaptation for hard sessions, readiness, low sleep, low HRV, and leg-load context.
- Cooking meal prep is routed through `submitCookingMealPrepSchedulingIntent` before calendar event creation.
- Chat/tool executor has Cooking tools and authenticated tool-scope checks.
- Cross-agent learning derives Cooking mesh signals for meal coverage, execution readiness, and grocery spend forecast.

## Gaps Found

- Core Cooking tables were historically scoped only by `user_id`; they did not carry explicit `tenant_id`, owner, visibility, lifecycle, or audit metadata.
- Same-user multi-tenant Cooking storage was not modeled. Auth currently blocks active tenant switching, but persistence should still be explicit.
- No deterministic meal-plan quality assessment existed before response/API composition.
- Cooking preferences and correction handling now use the dedicated `cooking-preferences.ts` adapter over `skill_memories`.
- Finance budget context is represented in meal-plan read-back through monthly budget headroom. Item-price grocery optimization remains open.
- iOS basic Cooking DTOs now have a rich-state extension branch:
  `feature/cooking-rich-state-ui` at `f4f1053` renders assessment/context/preference
  signals; `cfe5df4` renders pantry freshness states. Substitution/review prompts,
  correction capture, and simulator smoke remain open.
- Portal Cooking preference/pantry management contracts are implemented as
  audited admin/operator routes; browser UI/deep editing remains open.
- Local backend product smoke for Cooking ran with fixture model on `127.0.0.1:8326`; iOS focused tests passed for rich-state DTOs, while iOS simulator and portal runtime smoke remain open.

## Model Routing

Cooking domain handling uses the live domain/provider routing path through `handleSimpleDomain`. This workstream did not introduce any fixed provider/model. The Cooking manifest no longer lists a provider-specific required API key.

## Risk Summary

- P0 before fix: explicit tenant metadata missing on recipes, meal plans, and shopping lists.
- P1: iOS rich assessment/pantry rendering and backend portal contracts are partially complete; portal browser UI and iOS correction/simulator coverage remain incomplete.
- P2: deeper recipe substitution and food-safety workflow needs more runtime coverage.
