# Cooking Full Nexus Local Smoke Plan

Date: 2026-04-30

## Scope

Validate Cooking in the full local product runtime:

- backend
- auth/session
- tenant/user context
- Chat
- Secretary
- Training
- Finance
- Content Creation
- Cooking
- shared context
- fixture model/provider mode
- local database/cache
- workers
- iOS simulator
- portal if available

## Scenarios

1. Chat asks Cooking for today's meal.
2. Cooking respects allergy/restriction.
3. Cooking uses Training context.
4. Cooking asks Secretary for meal prep.
5. Finance budget affects groceries.
6. Grocery list generated from meal plan.
7. Pantry item persisted, used/marked, and isolated by tenant.
8. User correction updates Cooking memory.
9. Tenant switch does not leak Cooking data.
10. iOS renders Cooking result.

## Execution Addendum

The backend portion of this smoke ran on 2026-04-30 with:

- `FULL_NEXUS_STATE_DIR=.local/cooking-full-nexus-smoke`
- `DATABASE_PATH=data/cooking-full-nexus-smoke.db`
- `PORTAL_PORT=8326`
- `NEXUS_LOCAL_ALLOW_MODEL_CALLS=0`

Results are archived in `docs/local/cooking-full-nexus-local-smoke-results.md`.
The iOS rendering scenario remains open for simulator smoke, but the frontend
now has DTO and compact card support for assessment warnings, Finance/Secretary
planning context, and preference summaries on `feature/cooking-rich-state-ui`
at `f4f1053`.
