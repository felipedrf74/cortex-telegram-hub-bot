# Cooking Local Smoke Results

Date: 2026-04-30

## Mode

Focused backend fixture tests only.

No production data, production calendars, or real provider calls were used.

## Commands

```bash
npx vitest run __tests__/services/tool-executor.test.ts __tests__/services/cooking-chef.test.ts __tests__/services/cooking-intelligence.test.ts __tests__/api/cooking-routes.test.ts __tests__/services/cooking-mesh-context.test.ts
npx vitest run __tests__/services/cooking-chef.test.ts __tests__/api/cooking-routes.test.ts __tests__/services/tool-executor.test.ts __tests__/services/cooking-chef-qa-validation.test.ts
npx vitest run __tests__/services/cooking-preferences.test.ts __tests__/api/cooking-routes.test.ts __tests__/services/tool-executor.test.ts __tests__/services/cooking-chef-qa-validation.test.ts __tests__/skills/skills-command-qa-validation.test.ts __tests__/commands/skills.test.ts __tests__/api/app-facing-happy-path-smoke.test.ts
npx tsc --noEmit
npm run verify
```

## Results

| Smoke | Result | Notes |
|---|---|---|
| Cooking recipes | PASS | CRUD and tenant isolation covered |
| Cooking meal plans | PASS | CRUD, tenant isolation, Training adaptation covered |
| Shopping list | PASS | Generation, grouping, checked state, tenant isolation covered |
| Pantry | PASS | Persistent tenant-scoped CRUD, expired filtering, shopping-list pantry status, and route/tool tenant scope covered |
| Preference memory | PASS | User-private preference writes, corrections, tenant isolation, Chat tools, allergy assessment read-through, and app-facing smoke covered |
| Secretary prep scheduling route | PASS | Existing route regression passed after tenant fallback fix |
| Deterministic assessment | PASS | Allergy, pantry, grocery, schedule, budget, Training cases covered |
| Tool tenant scope | PASS | Tool executor forwards authenticated tenant into Cooking writes and preference reads/writes |
| Model routing | PASS BY INSPECTION | No provider/model hardcoding added |
| Full backend verify | PASS | `npm run verify`: 426 files / 6394 tests |
| Full local engine | BLOCKED/NOT RUN | Requires full runtime startup, workers/cache, fixture mode, and iOS simulator pass |

## Cleanup

No long-running local services, workers, containers, tunnels, or provider loops were started for this focused smoke.
