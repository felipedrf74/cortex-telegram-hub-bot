# Full Nexus Product Engine Runtime Map

Date: 2026-04-28  
Branch: `feature/local-full-nexus-product-engine-smoke-environment`

## Definition

For local smoke, "full Nexus product engine" means the local runtime that the
iOS app talks to through `/api/v1`, plus the services that create shared state
across skills. It is not only the Training engine.

Included by the local runner:

| Area | Local runtime source | Notes |
| --- | --- | --- |
| iOS API | `src/index.ts` -> `src/portal/server.ts` -> `src/api/router.ts` | Mounted at `/api/v1` when `IOS_API_ENABLED=true`. |
| Auth/session | `src/api/routes/auth.ts`, `src/api/auth-middleware.ts`, `src/services/ios-auth-session.ts` | Local sandbox user can be minted with `IOS_INVITE_CODE`. |
| Tenant/user context | `src/services/user-service.ts`, request context middleware in `src/api/router.ts` | JWT `userId` is propagated through request context. |
| Permissions/access | `src/api/auth-middleware.ts`, `src/api/entitlement-middleware.ts`, route-level owner/admin checks | Local paywall can be disabled only in non-production. |
| Persistence | SQLite through `src/services/database.ts` and migrations in `migrations/` | Local DB defaults to `data/local-full-nexus-smoke.db`. |
| Cache | SQLite-backed cache store initialized in `src/portal/server.ts` | Used by Home/Tasks/Dashboard SWR routes. |
| Scheduler/jobs | `src/services/scheduler.ts` | Starts with backend. Telegram delivery remains disabled unless explicitly enabled. |
| Secretary | Calendar/tasks/plan routes and services under `src/api/routes/*`, `src/services/*calendar*`, task-store | External providers can be mocked/local or staging-only. |
| Training | `src/api/routes/training*`, `src/services/coach-kernel/*`, Training docs/tests | Uses shared context, Secretary windows, agenda/calendar where configured. |
| Cooking | `src/api/routes/cooking.ts`, cooking services | Local smoke uses seeded/empty state unless fixtures are added. |
| Finance | `src/api/routes/finance.ts`, invoice routes/services | Local smoke must avoid real external collection. |
| Content Creation | `src/api/routes/content*`, optional Python content-engine | TS routes run in backend; Python sidecar can be started when needed. |
| Calendar/agenda | `src/api/routes/calendar.ts`, Google/Outlook services, Training agenda identity services | Local mock/default smoke avoids real provider writes. |
| Shared context/orchestration | `/api/v1/plan/*`, `/api/v1/signals/*`, Training generation helpers | `NEXUS_MULTISKILL_MESH=on` in local runner. |
| Model/provider layer | provider registry/domain router | Model keys are blank by default unless `NEXUS_LOCAL_ALLOW_MODEL_CALLS=1`. |

## Startup Commands Found

Backend:

```bash
npm run build
npm start
```

The reusable wrapper is:

```bash
scripts/full-nexus-local-engine.sh start
```

Content engine sidecar:

```bash
cd content-engine
CONTENT_ENGINE_PORT=8102 .venv/bin/python main.py
```

The wrapper starts it only with:

```bash
NEXUS_LOCAL_START_CONTENT_ENGINE=1 scripts/full-nexus-local-engine.sh start
```

## Required Local Configuration

Minimum local defaults supplied by the runner:

| Env var | Local default |
| --- | --- |
| `NODE_ENV` | `development` |
| `PORTAL_BIND` | `127.0.0.1` |
| `PORTAL_PORT` | `8200` |
| `IOS_API_ENABLED` | `true` |
| `IOS_API_JWT_SECRET` | local-only fixed secret |
| `IOS_INVITE_CODE` | `LOCAL-BETA-2026` |
| `DATABASE_PATH` | `data/local-full-nexus-smoke.db` |
| `OAUTH_ENCRYPTION_KEY` | local-only fixed key |
| `PAYWALL_ENABLED` | `false` |
| `NEXUS_MULTISKILL_MESH` | `on` |
| model provider keys | blank unless explicitly allowed |

## Local Auth Path

The local runner can mint a sandbox iOS user:

```bash
scripts/full-nexus-local-engine.sh auth-token
```

This calls:

```http
POST http://127.0.0.1:8200/api/v1/auth/register
```

with a local `deviceId` and `IOS_INVITE_CODE`, then writes the auth payload to
`.local/full-nexus/local-ios-auth.json`.

## Existing Smoke Tooling

| Tool | Purpose |
| --- | --- |
| `scripts/authenticated-api-smoke.sh` | Authenticated iOS API endpoint smoke. |
| `scripts/training-calendar-staging-smoke.sh` | Real provider staging calendar lifecycle smoke. |
| `scripts/training-cross-skill-staging-smoke.sh` | Staging cross-skill smoke. |
| `npm run eval:training` | Training coach-quality evaluation harness. |
| iOS `TrainingLocalSmokeFixtureTests` | Rich Training payload fixture/feedback coverage. |

## Currently Not Fully Local

| Dependency | Local status | Reason |
| --- | --- | --- |
| Real Google Calendar/Outlook writes | Staging-only by default | Local runner must not touch real calendars. |
| Real Apple Health | Device/TestFlight only | Simulator cannot prove real HealthKit data from Apple Watch. |
| Production APNs | Not local | Requires signed device/TestFlight and APNs environment. |
| Full content research sidecar | Optional | Content engine can run locally, but external research/provider calls should stay disabled for smoke unless explicitly validating them. |
| Real GPT-5.5 reasoning quality | Explicit opt-in | Use fixtures for UI/contracts; set `NEXUS_LOCAL_ALLOW_MODEL_CALLS=1` only for bounded quality checks. |
