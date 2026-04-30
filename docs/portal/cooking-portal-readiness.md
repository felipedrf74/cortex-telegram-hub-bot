# Cooking Portal Readiness

Date: 2026-04-30

## Desired Portal Role

Portal should be the deeper Cooking setup and management surface:

- preferences
- allergies/restrictions
- pantry
- recipe library
- grocery planning settings
- memory review
- tenant/shared rules
- quality diagnostics

## Current Status

Backend portal Cooking management APIs exist:

- `GET /api/users/:userId/cooking/preferences`
- `POST /api/users/:userId/cooking/preferences`
- `GET /api/users/:userId/cooking/pantry`
- `POST /api/users/:userId/cooking/pantry`
- `DELETE /api/users/:userId/cooking/pantry/:itemId`

These routes require the portal admin credential and the operator target-user
guard, fail closed on cross-tenant `tenantId`, audit reads/mutations, and avoid
returning raw preference `memoryValue` fields in read responses.

The browser portal now includes a dedicated `Cooking` section:

- target user/tenant scope selector
- scoped Cooking preference review with metadata-only memory rows
- preference correction/write form using direct portal REST, not Chat
- pantry editor with freshness/expiration fields
- pantry delete flow with explicit confirmation
- quick handoff from the user slideout to the Cooking manager

The UI intentionally calls the existing backend-authorized portal Cooking routes
instead of becoming a security boundary itself.

## Required Before Full Portal Product Claim

- Tenant-admin policy for private preferences if support/admin roles expand
  beyond platform operator access.
- Aggregate diagnostics without raw private meal/preference exposure.
- Recipe library, grocery settings, and meal-plan deep editors once those
  backend management contracts are promoted beyond the current preference/pantry
  scope.

## Validation

- `npx tsc --noEmit`: PASS
- `npx vitest run __tests__/portal/portal-cooking-routes.test.ts`: PASS, 6 tests
- `npx vitest run __tests__/portal/portal-cooking-ui.test.ts`: PASS, 4 tests

Verdict: PASS WITH CONDITIONS. Preference and pantry portal management now have
backend contracts and browser UI coverage; broader Cooking deep-editing remains
scoped to future backend contracts.
