# Cooking Test Matrix

Date: 2026-04-30

## Focused Tests Added Or Updated

| Area | Test File | Coverage |
|---|---|---|
| Tenant-safe recipes | `__tests__/services/cooking-chef.test.ts` | Same-user cross-tenant recipe read/update/delete denied |
| Tenant-safe meal plans | `__tests__/services/cooking-chef.test.ts` | Cross-tenant read/delete denied and same-slot overwrite rejected |
| Tenant-safe shopping lists | `__tests__/services/cooking-chef.test.ts` | Cross-tenant shopping list read denied |
| Allergy/restriction safety | `__tests__/services/cooking-intelligence.test.ts` | Allergy conflict blocks assessment |
| Pantry safety | `__tests__/services/cooking-intelligence.test.ts` | Expired pantry item blocks use |
| Grocery coherence | `__tests__/services/cooking-intelligence.test.ts` | Pantry/list coherence and missing ingredient warning |
| Schedule/budget realism | `__tests__/services/cooking-intelligence.test.ts` | Over-capacity and over-budget warnings |
| Training coordination | `__tests__/services/cooking-intelligence.test.ts` | Hard training day without meal support flagged |
| Tool call tenant scope | `__tests__/services/tool-executor.test.ts` | Authenticated tenant is passed into Cooking writes |
| Route regression | `__tests__/api/cooking-routes.test.ts` | Existing route behavior and Secretary prep scheduling |
| Mesh context | `__tests__/services/cooking-mesh-context.test.ts` | Cross-skill Cooking signals |

## Commands Run

```bash
npx vitest run __tests__/services/tool-executor.test.ts __tests__/services/cooking-chef.test.ts __tests__/services/cooking-intelligence.test.ts __tests__/api/cooking-routes.test.ts __tests__/services/cooking-mesh-context.test.ts
npx tsc --noEmit
npm run verify
```

## Results

- Focused Vitest: PASS, 5 files / 126 tests.
- Typecheck: PASS.
- Full verify: PASS, 425 files / 6374 tests.

## Not Yet Run

- Full local runtime smoke with backend, workers, cache, iOS simulator, and fixture model.
