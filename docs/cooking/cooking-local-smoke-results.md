# Cooking Local Smoke Results

Date: 2026-04-30

## Mode

Focused backend fixture tests only.

No production data, production calendars, or real provider calls were used.

## Commands

```bash
npx vitest run __tests__/services/tool-executor.test.ts __tests__/services/cooking-chef.test.ts __tests__/services/cooking-intelligence.test.ts __tests__/api/cooking-routes.test.ts __tests__/services/cooking-mesh-context.test.ts
npx tsc --noEmit
npm run verify
```

## Results

| Smoke | Result | Notes |
|---|---|---|
| Cooking recipes | PASS | CRUD and tenant isolation covered |
| Cooking meal plans | PASS | CRUD, tenant isolation, Training adaptation covered |
| Shopping list | PASS | Generation, grouping, checked state, tenant isolation covered |
| Secretary prep scheduling route | PASS | Existing route regression passed after tenant fallback fix |
| Deterministic assessment | PASS | Allergy, pantry, grocery, schedule, budget, Training cases covered |
| Tool tenant scope | PASS | Tool executor forwards authenticated tenant into Cooking writes |
| Model routing | PASS BY INSPECTION | No provider/model hardcoding added |
| Full backend verify | PASS | `npm run verify`: 425 files / 6374 tests |
| Full local engine | BLOCKED/NOT RUN | Requires full runtime startup, workers/cache, fixture mode, and iOS simulator pass |

## Cleanup

No long-running local services, workers, containers, tunnels, or provider loops were started for this focused smoke.
