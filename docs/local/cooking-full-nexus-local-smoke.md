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
