# Full Nexus Local Readiness Report

Date: 2026-04-28  
Branch: `feature/local-full-nexus-product-engine-smoke-environment`  
Backend base commit: `b8f9be7`

Rollback safety:

- backend backup branch: `backup/local-full-nexus-engine-pre-20260428-125032`
- backend backup tag: `backup-local-full-nexus-engine-pre-20260428-125032`
- iOS backup branch: `backup/ios-local-full-nexus-engine-pre-20260428-125032`
- iOS backup tag: `backup-ios-local-full-nexus-engine-pre-20260428-125032`

## 1. Executive Summary

A durable local runner has been added for the full Nexus product backend behind
iOS. It starts the local API on loopback, uses an isolated SQLite DB, mints a
local sandbox iOS auth session, supports authenticated API smoke, optionally
starts the content-engine sidecar, and defaults to zero model-provider calls.

This is now a better pre-production gate than waiting for production deploys,
but it is not yet a complete cross-skill scenario bank. The biggest remaining
gap is local seed data for rich Secretary/Cooking/Finance/Content contexts.

## 2. What Full Local Engine Means Here

The local engine is the Express/iOS API process, SQLite persistence, auth,
tenant context, scheduler, SWR/cache layer, skill routes, shared plan/signals
routes, Training orchestration, calendar/agenda internals, and optional content
engine sidecar.

## 3. Services Included

- Backend API
- iOS auth/session
- tenant/user request context
- entitlement/paywall path in local bypass mode
- SQLite migrations
- cache store
- scheduler/jobs with Telegram delivery off
- Secretary/Training/Cooking/Finance/Content route surfaces
- shared plan/signals route surfaces
- optional Python content engine

## 4. Services Not Included by Default

| Service | Why |
| --- | --- |
| Real Google/Outlook writes | Must remain staging-only to avoid calendar pollution. |
| Real APNs | Requires signed device/TestFlight. |
| Real Apple Health | Simulator cannot prove watch/device data. |
| Real model calls | Disabled by default to control cost; opt in only for bounded quality checks. |

## 5. Startup Commands

```bash
scripts/full-nexus-local-engine.sh doctor
scripts/full-nexus-local-engine.sh start
scripts/full-nexus-local-engine.sh auth-token
scripts/full-nexus-local-engine.sh smoke
```

## 6. Shutdown Commands

```bash
scripts/full-nexus-local-engine.sh stop
scripts/full-nexus-local-engine.sh cleanup
```

## 7. Required Env Vars

The runner supplies local defaults for all required boot variables. Use
`.env.local-full-nexus` only for local overrides. Do not use production `.env`.

## 8. Test Users/Tenants

Currently automated:

- one local sandbox iOS user via invite-code auth

Still needed:

- second tenant/user
- local admin user
- cross-skill seeded personas

## 9. Skill Services Included

The local API exposes Secretary, Training, Cooking, Finance, Content Creation,
signals, plan, calendar, tasks, connections, wearable, health-data, usage,
notifications, and reports routes under `/api/v1`.

## 10. Fixture Strategy

Use real local engine calls for auth/API/tenant shape, iOS deterministic rich
fixtures for frontend Training rendering, and local seed personas for
cross-skill orchestration as those seeds are added.

## 11. GPT-5.5 Local Usage Strategy

Default: zero model calls. Use `NEXUS_LOCAL_ALLOW_MODEL_CALLS=1` for a bounded
reasoning-quality smoke only, and record it in
`docs/local/gpt55-smoke-test-usage-notes.md`.

## 12. iOS Local Connection

Use:

```text
-nexus_allow_local_backend YES
-nexus_base_url http://127.0.0.1:8200
```

The iOS side has existing rich Training fixture support through
`-NEXUSQATrainingFixture rich-v1`.

## 13. Portal/Web Local Connection

Portal binds to `127.0.0.1:8200` by default. Admin portal auth is loopback-only
when local bypass is enabled.

## 14. Cross-Skill Local Status

Route/runtime readiness exists. Scenario proof is pending local seed scripts for
Secretary conflicts, Cooking fueling gaps, Finance constraints, and Content
workload/milestone signals.

## 15. Smoke Tests Available

- public health/API smoke
- local sandbox auth token smoke
- authenticated iOS API endpoint smoke
- optional content-engine health
- iOS rich Training fixture tests/smoke
- staging calendar and cross-skill smoke scripts remain available separately

## 16. Smoke Tests Run

See `docs/local/full-nexus-local-smoke-results.md`. Summary:

- runner syntax passed
- doctor passed
- backend public API health passed on `127.0.0.1:8200`
- local sandbox auth token creation passed
- authenticated iOS API smoke passed 13/13 endpoints
- cleanup confirmed no `8200` listener remained

## 17. Smoke Tests Blocked

- local rich cross-skill orchestration until seed personas exist
- ~~local full iOS authenticated journey until simulator is rerun using the new
  local token strategy~~ **CLOSED 2026-04-28**: `DebugAuthTokenImporter`
  (DEBUG+simulator-only, dual launch-arg gate) reads the runner-minted JSON
  and seeds `AuthManager` exactly as a real `/auth/register` response would.
  43 authenticated REST calls across 19 endpoints validated on a cold
  simulator boot. See `full-nexus-local-smoke-results.md` and
  `Nexus Hub/docs/ios/training-local-api-configuration.md`.
- real provider calendar read-back until staging credentials are used

## 18. Issues Fixed

- Added a reusable local runner that can mint a real local iOS auth session
  instead of relying only on `NEXUS_SKIP_AUTH=1`.
- Added resource-control defaults to prevent accidental production data/model
  usage.
- (2026-04-28) Added DEBUG+simulator-only iOS bootstrap path
  (`Nexus Hub/Core/DebugAuthTokenImporter.swift` + AuthManager wiring + 15
  policy tests) that consumes the runner's `local-ios-auth.json` and seeds
  the keychain through the same setter the real `/auth/register` flow uses.
  This closes the previously-blocking P2 gap: iOS can now run a fully
  authenticated local product journey against `127.0.0.1:8200` without
  relying on `NEXUS_SKIP_AUTH=1`.

## 19. Open Blockers

See `docs/local/full-nexus-local-open-blockers.md`.

## 20. Cleanup Confirmation

Cleanup was run after the attached local smoke. No backend/content listener
remained on port `8200`, and the local auth token was removed by the cleanup
command.

## 21. Production Readiness Fit

This local environment should become the default first gate before staging and
production. It does not replace staging Google/Outlook read-back, TestFlight
HealthKit/APNs checks, or production-safe post-deploy validation.
