# Cooking Local Smoke Results

Date: 2026-04-30

## Mode

Focused backend fixture tests plus full local backend product runtime smoke.

No production data, production calendars, or real provider calls were used.

## Commands

```bash
npx vitest run __tests__/services/tool-executor.test.ts __tests__/services/cooking-chef.test.ts __tests__/services/cooking-intelligence.test.ts __tests__/api/cooking-routes.test.ts __tests__/services/cooking-mesh-context.test.ts
npx vitest run __tests__/services/cooking-chef.test.ts __tests__/api/cooking-routes.test.ts __tests__/services/tool-executor.test.ts __tests__/services/cooking-chef-qa-validation.test.ts
npx vitest run __tests__/services/cooking-preferences.test.ts __tests__/api/cooking-routes.test.ts __tests__/services/tool-executor.test.ts __tests__/services/cooking-chef-qa-validation.test.ts __tests__/skills/skills-command-qa-validation.test.ts __tests__/commands/skills.test.ts __tests__/api/app-facing-happy-path-smoke.test.ts
npx vitest run __tests__/services/cooking-planning-context.test.ts __tests__/services/cooking-intelligence.test.ts __tests__/api/cooking-routes.test.ts
npx tsc --noEmit
npm run verify
FULL_NEXUS_STATE_DIR=.local/cooking-full-nexus-smoke DATABASE_PATH="$PWD/data/cooking-full-nexus-smoke.db" PORTAL_PORT=8326 FULL_NEXUS_RESET_DB=1 NEXUS_LOCAL_ALLOW_MODEL_CALLS=0 scripts/full-nexus-local-engine.sh cleanup
FULL_NEXUS_STATE_DIR=.local/cooking-full-nexus-smoke DATABASE_PATH="$PWD/data/cooking-full-nexus-smoke.db" PORTAL_PORT=8326 NEXUS_LOCAL_ALLOW_MODEL_CALLS=0 scripts/full-nexus-local-engine.sh doctor
FULL_NEXUS_STATE_DIR=.local/cooking-full-nexus-smoke DATABASE_PATH="$PWD/data/cooking-full-nexus-smoke.db" PORTAL_PORT=8326 NEXUS_LOCAL_ALLOW_MODEL_CALLS=0 scripts/full-nexus-local-engine.sh up
FULL_NEXUS_STATE_DIR=.local/cooking-full-nexus-smoke DATABASE_PATH="$PWD/data/cooking-full-nexus-smoke.db" PORTAL_PORT=8326 NEXUS_LOCAL_ALLOW_MODEL_CALLS=0 scripts/full-nexus-local-engine.sh full-smoke
```

## Results

| Smoke | Result | Notes |
|---|---|---|
| Cooking recipes | PASS | CRUD and tenant isolation covered |
| Cooking meal plans | PASS | CRUD, tenant isolation, Training adaptation covered |
| Shopping list | PASS | Generation, grouping, checked state, tenant isolation covered |
| Pantry | PASS | Persistent tenant-scoped CRUD, expired filtering, shopping-list pantry status, and route/tool tenant scope covered |
| Preference memory | PASS | User-private preference writes, corrections, tenant isolation, Chat tools, allergy assessment read-through, and app-facing smoke covered |
| Finance/Secretary planning context | PASS | Finance monthly budget headroom and Secretary agenda pressure are read before meal-plan assessment, with safe degradation |
| Secretary prep scheduling route | PASS | Existing route regression passed after tenant fallback fix |
| Deterministic assessment | PASS | Allergy, pantry, grocery, schedule, budget, Training cases covered |
| Tool tenant scope | PASS | Tool executor forwards authenticated tenant into Cooking writes and preference reads/writes |
| Model routing | PASS BY INSPECTION | No provider/model hardcoding added |
| Full backend verify | PASS | `npm run verify`: 427 files / 6398 tests |
| Full local backend engine | PASS WITH CONDITIONS | Backend ran attached on `127.0.0.1:8326`; 13/13 authenticated API smoke checks passed; Chat tenant smoke 15 pass / 1 partial; cross-skill fixtures and Chat eval/day-to-day fixtures passed |
| Cooking live local planning-context read-back | PASS | Authenticated local API returned Finance `available/tight` context, Secretary available cooking minutes `{ "2026-05-04": 60 }`, `COOKING_TIME_OVER_CAPACITY`, and `FINANCE_BUDGET_TIGHT` |
| iOS focused rich-state tests | PASS | iOS branch `feature/cooking-rich-state-ui` at `f4f1053` and `cfe5df4`; 8 Cooking presentation tests passed, including rich/legacy meal-plan payload decoding and pantry freshness DTO rendering |
| iOS simulator | NOT RUN | Still a separate frontend gate for rich Cooking states against the local backend |
| Portal Cooking contracts | PASS | `npx vitest run __tests__/portal/portal-cooking-routes.test.ts`: 6 tests passed for admin/operator guards, tenant rejection, sanitized preference reads, pantry reads/writes, and audit calls |
| Portal browser runtime | NOT RUN | Portal Cooking browser UI/deep editor remains a frontend/product gap |

## Cleanup

Attached backend was stopped after smoke. Final cleanup removed the local smoke DB/auth artifacts and verified no listener remained on port `8326`.
