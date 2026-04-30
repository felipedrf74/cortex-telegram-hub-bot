# Cooking Test Matrix

Date: 2026-04-30

## Focused Tests Added Or Updated

| Area | Test File | Coverage |
|---|---|---|
| Tenant-safe recipes | `__tests__/services/cooking-chef.test.ts` | Same-user cross-tenant recipe read/update/delete denied |
| Tenant-safe meal plans | `__tests__/services/cooking-chef.test.ts` | Cross-tenant read/delete denied and same-slot overwrite rejected |
| Tenant-safe shopping lists | `__tests__/services/cooking-chef.test.ts` | Cross-tenant shopping list read denied |
| Tenant-safe pantry | `__tests__/services/cooking-chef.test.ts`, `__tests__/api/cooking-routes.test.ts` | Pantry CRUD, same-user cross-tenant read/update/delete denied |
| Cooking preference memory | `__tests__/services/cooking-preferences.test.ts`, `__tests__/api/cooking-routes.test.ts` | User-private preference writes, corrections, tenant isolation, and allergy assessment read-through |
| Allergy/restriction safety | `__tests__/services/cooking-intelligence.test.ts` | Allergy conflict blocks assessment |
| Pantry safety | `__tests__/services/cooking-intelligence.test.ts` | Expired pantry item blocks use |
| Grocery coherence | `__tests__/services/cooking-intelligence.test.ts` | Pantry/list coherence and missing ingredient warning |
| Schedule/budget realism | `__tests__/services/cooking-intelligence.test.ts` | Over-capacity and over-budget warnings |
| Finance/Secretary planning context | `__tests__/services/cooking-planning-context.test.ts`, `__tests__/api/cooking-routes.test.ts` | Finance budget headroom and Secretary agenda pressure feed meal-plan assessment without raw data exposure |
| Training coordination | `__tests__/services/cooking-intelligence.test.ts` | Hard training day without meal support flagged |
| Tool call tenant scope | `__tests__/services/tool-executor.test.ts` | Authenticated tenant is passed into Cooking meal, pantry, and preference writes/reads |
| Route regression | `__tests__/api/cooking-routes.test.ts` | Existing route behavior and Secretary prep scheduling |
| Mesh context | `__tests__/services/cooking-mesh-context.test.ts` | Cross-skill Cooking signals |
| Portal management contracts | `__tests__/portal/portal-cooking-routes.test.ts` | Admin/operator guards, tenant rejection, sanitized preference reads, pantry reads/writes, and audit calls |
| Portal browser UI wiring | `__tests__/portal/portal-cooking-ui.test.ts` | Cooking nav/section, script syntax, direct scoped backend routes, no Chat command path, and delete confirmation |

## Commands Run

```bash
npx vitest run __tests__/services/tool-executor.test.ts __tests__/services/cooking-chef.test.ts __tests__/services/cooking-intelligence.test.ts __tests__/api/cooking-routes.test.ts __tests__/services/cooking-mesh-context.test.ts
npx vitest run __tests__/services/cooking-chef.test.ts __tests__/api/cooking-routes.test.ts __tests__/services/tool-executor.test.ts __tests__/services/cooking-chef-qa-validation.test.ts
npx vitest run __tests__/services/cooking-preferences.test.ts __tests__/api/cooking-routes.test.ts __tests__/services/tool-executor.test.ts __tests__/services/cooking-chef-qa-validation.test.ts __tests__/skills/skills-command-qa-validation.test.ts __tests__/commands/skills.test.ts __tests__/api/app-facing-happy-path-smoke.test.ts
npx vitest run __tests__/services/cooking-planning-context.test.ts __tests__/services/cooking-intelligence.test.ts __tests__/api/cooking-routes.test.ts
npx vitest run __tests__/portal/portal-cooking-ui.test.ts __tests__/portal/portal-cooking-routes.test.ts
npx tsc --noEmit
npm run verify
```

## Results

- Focused Vitest: PASS, 5 files / 126 tests.
- Pantry-focused Vitest: PASS, 4 files / 175 tests.
- Preference-memory focused Vitest plus app-facing smoke: PASS, 7 files / 208 tests.
- Planning-context focused Vitest: PASS, 3 files / 29 tests.
- Portal focused Vitest: PASS, 2 files / 10 tests.
- Typecheck: PASS.
- Full verify: PASS, 427 files / 6398 tests.

## Not Yet Run

- iOS simulator smoke for rich Cooking states against the local backend.
- Portal browser runtime smoke for the Cooking preference/pantry manager.
