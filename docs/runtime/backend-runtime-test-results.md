# Backend runtime test results

## Commands run

```bash
npm ci
NEXUS_LOCAL_ALLOW_MODEL_CALLS=0 scripts/full-nexus-local-engine.sh doctor
NEXUS_LOCAL_ALLOW_MODEL_CALLS=0 scripts/full-nexus-local-engine.sh start
NEXUS_LOCAL_ALLOW_MODEL_CALLS=0 scripts/full-nexus-local-engine.sh smoke
NEXUS_LOCAL_ALLOW_MODEL_CALLS=0 scripts/full-nexus-local-engine.sh up
scripts/full-nexus-local-engine.sh auth-token
npx tsc --noEmit
npx vitest run __tests__/api/rate-limiter.test.ts
npx vitest run __tests__/api/dashboard-routes.test.ts __tests__/api/plan-routes.test.ts
npx vitest run __tests__/api/app-facing-auth-smoke.test.ts __tests__/api/app-facing-happy-path-smoke.test.ts __tests__/api/dashboard-routes.test.ts __tests__/api/tasks-routes.test.ts __tests__/api/plan-routes.test.ts __tests__/api/training-home-payload.test.ts __tests__/api/connections-routes.test.ts __tests__/api/skills-routes.test.ts
npm run verify
```

## Results

| Check | Result |
| --- | --- |
| `npm ci` | Passed |
| local engine doctor | Passed |
| local authenticated API smoke | 13/13 passed |
| `npx tsc --noEmit` | Passed |
| rate-limiter focused tests | 16/16 passed |
| dashboard + plan Server-Timing tests | 2 files / 30 tests passed |
| app-facing focused tests | 8 files / 111 tests passed |
| full `npm run verify` | 429 files / 6447 tests passed |

## Notes

- Local engine fixture mode used `NEXUS_LOCAL_ALLOW_MODEL_CALLS=0`.
- No production data or production calendars were used.
- A manual POST probe without a JSON body intentionally confirmed the mutation bucket header but produced a local-only 500 from the tasks route. It was not counted as product validation.
