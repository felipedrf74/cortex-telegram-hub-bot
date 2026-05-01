# Cooking Safety Test Results

Date: 2026-04-30

## Commands

```bash
npx vitest run __tests__/services/tool-executor.test.ts __tests__/services/cooking-chef.test.ts __tests__/services/cooking-intelligence.test.ts __tests__/api/cooking-routes.test.ts __tests__/services/cooking-mesh-context.test.ts
npx vitest run __tests__/services/cooking-chef.test.ts __tests__/api/cooking-routes.test.ts __tests__/services/tool-executor.test.ts __tests__/services/cooking-chef-qa-validation.test.ts
npx vitest run __tests__/services/cooking-preferences.test.ts __tests__/api/cooking-routes.test.ts __tests__/services/tool-executor.test.ts __tests__/services/cooking-chef-qa-validation.test.ts __tests__/skills/skills-command-qa-validation.test.ts __tests__/commands/skills.test.ts __tests__/api/app-facing-happy-path-smoke.test.ts
npx tsc --noEmit
npm run verify
```

## Results

- Focused tests: PASS, 126 tests.
- Pantry-focused tests: PASS, 175 tests.
- Preference-memory focused tests plus app-facing smoke: PASS, 208 tests.
- Typecheck: PASS.
- Full verify: PASS, 429 files / 6434 tests.

## Safety Coverage

| Safety Area | Result |
|---|---|
| Cross-tenant recipe access | PASS |
| Cross-tenant meal-plan access | PASS |
| Cross-tenant shopping-list access | PASS |
| Cross-tenant pantry access | PASS |
| Cross-tenant Cooking preference memory access | PASS |
| Allergy conflict | PASS |
| Allergy conflict from Cooking memory before response composition | PASS |
| Expired pantry item | PASS |
| Authenticated tenant passed to Cooking tool writes/reads | PASS |
| Unsupported medical claim | Not automated in this branch |
| Prompt injection through Chat | Not run in this branch |
| iOS stale cache | Not run in this branch |
