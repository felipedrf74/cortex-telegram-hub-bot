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
- Cooking tests under `__tests__/services` and `__tests__/api`

## Existing Strengths

- Token-zero REST endpoints exist for recipes, meal plans, shopping lists, and prep-event scheduling.
- Recipe CRUD and meal-plan CRUD are covered by tests.
- Shopping list generation merges compatible quantities and assigns grocery aisle metadata.
- iOS route layer avoids leaking internal exception details.
- Cooking already has Training-aware meal adaptation for hard sessions, readiness, low sleep, low HRV, and leg-load context.
- Cooking meal prep is routed through `submitCookingMealPrepSchedulingIntent` before calendar event creation.
- Chat/tool executor has Cooking tools and authenticated tool-scope checks.
- Cross-agent learning derives Cooking mesh signals for meal coverage, execution readiness, and grocery spend forecast.

## Gaps Found

- Core Cooking tables were historically scoped only by `user_id`; they did not carry explicit `tenant_id`, owner, visibility, lifecycle, or audit metadata.
- Same-user multi-tenant Cooking storage was not modeled. Auth currently blocks active tenant switching, but persistence should still be explicit.
- No deterministic meal-plan quality assessment existed before response/API composition.
- Pantry is not persisted as a first-class Cooking object.
- Cooking preferences and correction handling are documented in the skill memory foundation but not yet wired into a dedicated Cooking preference writer.
- Finance budget context is represented through mesh estimates but not a full meal-planning budget contract.
- iOS receives basic Cooking DTOs but does not yet render rich assessment, pantry, substitution, and warning states.
- Portal Cooking preferences/pantry management is not implemented.
- Local full-product smoke for Cooking has focused tests but no archived full runtime log in this branch.

## Model Routing

Cooking domain handling uses the live domain/provider routing path through `handleSimpleDomain`. This workstream did not introduce any fixed provider/model. The Cooking manifest no longer lists a provider-specific required API key.

## Risk Summary

- P0 before fix: explicit tenant metadata missing on recipes, meal plans, and shopping lists.
- P1: pantry, preference memory, budget, iOS/portal rich states, and full local runtime smoke remain incomplete.
- P2: deeper recipe substitution and food-safety workflow needs more runtime coverage.

