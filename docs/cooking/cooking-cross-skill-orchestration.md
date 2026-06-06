# Cooking Cross-Skill Orchestration

Date: 2026-04-30

## Secretary

Cooking schedules meal prep through `submitCookingMealPrepSchedulingIntent`. Cooking does not directly own agenda placement.

Implemented:

- `src/services/cooking-secretary-integration.ts`
- `POST /api/v1/cooking/meal-plan/create-prep-event`
- `GET /api/v1/cooking/meal-plan` now reads Secretary agenda pressure through `cooking-planning-context.ts` and feeds available cooking minutes into assessment.

Open:

- grocery shopping block scheduling
- iOS rendering of Secretary decision reasons for Cooking prep

## Training

Implemented:

- Training-aware meal adaptation on meal-plan read-back.
- Cooking mesh signals for fueling support and meal execution readiness.
- Assessment flags hard training dates without planned meals.

Open:

- richer Training load/recovery input into generation
- deduped fueling warnings across Chat/Training/Cooking

## Finance

Implemented:

- Cooking mesh grocery spend forecast.
- Assessment can evaluate budget input when supplied.
- `GET /api/v1/cooking/meal-plan` now reads Finance monthly budget headroom and returns tenant/user-safe budget context without exposing raw transactions.

Open:

- Item-price grocery optimization and category-level grocery planning.

## Content Creation

Open:

- Permissioned cooking routine/recipe content opportunity signal.
- Sensitive signal policy for food/training/finance context reuse.

## Chat

Implemented:

- Cooking route/tool ownership remains through central Chat/tool authorization.
- Tool calls now pass authenticated tenant scope into Cooking persistence.

Open:

- Vague follow-up resolution with Cooking memory and pantry context.
