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

Backend portal Cooking management APIs now exist:

- `GET /api/users/:userId/cooking/preferences`
- `POST /api/users/:userId/cooking/preferences`
- `GET /api/users/:userId/cooking/pantry`
- `POST /api/users/:userId/cooking/pantry`
- `DELETE /api/users/:userId/cooking/pantry/:itemId`

These routes require the portal admin credential and the operator target-user
guard, fail closed on cross-tenant `tenantId`, audit reads/mutations, and avoid
returning raw preference `memoryValue` fields in read responses.

The browser UI/deep editor for Cooking is still open.

## Required Before Full Portal Product Claim

- Browser UI for Cooking setup, preference review, and pantry editing.
- Tenant-admin policy for private preferences if support/admin roles expand
  beyond platform operator access.
- Aggregate diagnostics without raw private meal/preference exposure.

## Validation

- `npx tsc --noEmit`: PASS
- `npx vitest run __tests__/portal/portal-cooking-routes.test.ts`: PASS, 6 tests

Verdict: PASS WITH CONDITIONS. Backend portal management contracts are ready;
browser UI remains open.
