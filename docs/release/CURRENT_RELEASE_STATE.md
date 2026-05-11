# Backend Current Release State

Status: canonical
Owner: backend release lead (Felipe)
Last verified: 2026-05-11
Update policy: update after backend deploy or staging change. Workspace-level entry point is docs/release/CURRENT_RELEASE_STATE.md.

Last updated: 2026-05-11

## Active Production Release

- Source branch: `feature/decision-center-orchestration-apns`
- Production HEAD: `d46aa107`
- Production version: `4.14.149`
- iOS main was pushed at `b60b14c` with version `1.4.3(17)` and tag
  `ios-1.4.3-build17`.
- Official workspace root: `/Users/felipedominguez/Desktop/Nexus Hub`

## Scope

Round E launch blockers plus Decision Center Round D' source-verified fixes:

- Apple revocation, GDPR account deletion/revocation, prompt injection,
  Sentry redaction, api_cache safety valve, and onboarding isolation hardening.
- Decision Center close-out fixes, including verified inline action failure,
  Home accessibility identifiers, scope discard, and honest APNs evidence.
- Decision Center APIs are live on production and respond with scoped summary
  and list shapes.
- Non-owner production readiness probe confirmed real Apple Health-derived
  values for user `28`, not Felipe's prior leaked readiness/body-battery pair.

## Validation Before Promotion

- Pre-promote staging deploy: PASS.
- Pre-promote staging smoke: 19 passed / 0 failed / 21 total.
- Deploy-time validation: full vitest PASS, 502 files / 7228 tests.
- Deploy-time build: PASS.
- Production promote: completed at `4.14.149`.
- Production health: API health healthy, portal snapshot version `4.14.149`,
  PM2 `nexus-hub` and `content-engine` online at `4.14.149`.
- Production Garmin watcher/manual cleanup-substrate check returned
  `matchedCount: 0`.
- Live APNs validation remains blocked with exact reason: production APNs
  credentials are present, but Felipe `user_id = 1` has no active registered
  production push token. No APNs send or `apns-id` was claimed.

## Evidence

- Final staging smoke:
  - `docs/release/smoke-evidence/staging-smoke-146f6cf7-20260510T233345Z.json`
- Production health/snapshot/PM2:
  - `docs/release/smoke-evidence/prod-health-20260510T234415Z.json`
  - `docs/release/smoke-evidence/prod-snapshot-20260510T234415Z.json`
  - `docs/release/smoke-evidence/prod-pm2-health-20260510T234415Z.json`
- Production Decision Center and readiness probes:
  - `docs/release/smoke-evidence/prod-decision-center-api-smoke-20260510T234511Z.json`
  - `docs/release/smoke-evidence/prod-garmin-tenant-isolation-watcher-20260510T234415Z.json`
  - `docs/release/smoke-evidence/prod-non-owner-readiness-probe-user28-20260510T234511Z.json`
- Live APNs token lookup evidence:
  - `docs/release/smoke-evidence/prod-apns-token-lookup-user1-20260511T001055Z.json`
  - `docs/release/smoke-evidence/prod-apns-token-lookup-user1-retry-20260511T001120Z.json`
- Closeout addendum:
  - `docs/archive/2026-05/decision-center-orchestration-apns/closeout.md`

## Required Post-Promotion Checks

Production-safe follow-ups:

- Felipe must cut TestFlight from iOS `main` manually; no TestFlight build was
  cut during this promote.
- Felipe must launch the production/TestFlight app on the owner account and
  allow/register push notifications before live APNs can be validated for
  `user_id = 1`.
