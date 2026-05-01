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
| Substitution candidates | `__tests__/services/cooking-intelligence.test.ts`, `__tests__/api/cooking-routes.test.ts` | Allergy, dietary-restriction, and expired-pantry issues emit reviewable substitution candidates |
| Substitution application | `__tests__/api/cooking-routes.test.ts` | Accepted substitution updates only the authenticated tenant's linked recipe/meal copy and regenerated shopping list; cross-tenant attempts fail closed |
| Pantry safety | `__tests__/services/cooking-intelligence.test.ts` | Expired pantry item blocks use |
| Grocery coherence | `__tests__/services/cooking-intelligence.test.ts` | Pantry/list coherence and missing ingredient warning |
| Schedule/budget realism | `__tests__/services/cooking-intelligence.test.ts` | Over-capacity and over-budget warnings |
| Finance/Secretary planning context | `__tests__/services/cooking-planning-context.test.ts`, `__tests__/api/cooking-routes.test.ts` | Finance budget headroom and Secretary agenda pressure feed meal-plan assessment without raw data exposure |
| Training coordination | `__tests__/services/cooking-intelligence.test.ts` | Hard training day without meal support flagged |
| Tool call tenant scope | `__tests__/services/tool-executor.test.ts` | Authenticated tenant is passed into Cooking meal, pantry, and preference writes/reads |
| Route regression | `__tests__/api/cooking-routes.test.ts` | Existing route behavior and Secretary prep scheduling |
| Mesh context | `__tests__/services/cooking-mesh-context.test.ts` | Cross-skill Cooking signals |
| Portal management contracts | `__tests__/portal/portal-cooking-routes.test.ts` | Admin/operator guards, tenant rejection, sanitized preference reads, pantry reads/writes, audited substitution apply, invalid-reason rejection, and cross-tenant substitution denial |
| Portal browser UI wiring | `__tests__/portal/portal-cooking-ui.test.ts` | Cooking nav/section, script syntax, direct scoped backend routes, no Chat command path, delete confirmation, and substitution acceptance panel wiring |
| iOS Cooking future-state fallback | `Nexus HubTests/CookingPresentationTests` | Unknown meal adaptation kinds decode to `.unknown` without dropping the meal-plan payload; unknown substitution reason/confidence metadata remains readable |

## Commands Run

```bash
npx vitest run __tests__/services/tool-executor.test.ts __tests__/services/cooking-chef.test.ts __tests__/services/cooking-intelligence.test.ts __tests__/api/cooking-routes.test.ts __tests__/services/cooking-mesh-context.test.ts
npx vitest run __tests__/services/cooking-chef.test.ts __tests__/api/cooking-routes.test.ts __tests__/services/tool-executor.test.ts __tests__/services/cooking-chef-qa-validation.test.ts
npx vitest run __tests__/services/cooking-preferences.test.ts __tests__/api/cooking-routes.test.ts __tests__/services/tool-executor.test.ts __tests__/services/cooking-chef-qa-validation.test.ts __tests__/skills/skills-command-qa-validation.test.ts __tests__/commands/skills.test.ts __tests__/api/app-facing-happy-path-smoke.test.ts
npx vitest run __tests__/services/cooking-planning-context.test.ts __tests__/services/cooking-intelligence.test.ts __tests__/api/cooking-routes.test.ts
npx vitest run __tests__/portal/portal-cooking-ui.test.ts __tests__/portal/portal-cooking-routes.test.ts
npx vitest run __tests__/portal/portal-cooking-ui.test.ts __tests__/portal/portal-cooking-routes.test.ts __tests__/api/cooking-routes.test.ts
npx vitest run __tests__/services/cooking-preferences.test.ts __tests__/services/cooking-intelligence.test.ts __tests__/api/cooking-routes.test.ts
npx tsc --noEmit
npm run verify
```

## Results

- Focused Vitest: PASS, 5 files / 126 tests.
- Substitution-candidate/application focused Vitest: PASS, 2 files / 45 tests.
- Pantry-focused Vitest: PASS, 4 files / 175 tests.
- Preference-memory focused Vitest plus app-facing smoke: PASS, 7 files / 208 tests.
- Planning-context focused Vitest: PASS, 3 files / 29 tests.
- Portal focused Vitest: PASS, 2 files / 16 tests.
- Portal/API substitution acceptance focused Vitest: PASS, 3 files / 52 tests.
- iOS Cooking presentation focused tests: PASS, 15 tests on iPhone 17 Pro / iOS 26.4 using explicit simulator UDID.
- Typecheck: PASS.
- Full verify: PASS, 429 files / 6434 tests.

## Not Yet Run

- iOS direct-accept affordance for the backend substitution application
  contract.
