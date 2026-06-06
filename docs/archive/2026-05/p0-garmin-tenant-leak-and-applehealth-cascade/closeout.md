# P0 Garmin Tenant Leak + Apple Health Cascade Closeout

Date: 2026-05-09  
Branch: `p0-garmin-tenant-leak-and-applehealth-cascade-2026-05`  
Backup tag: `backup/garmin-applehealth-cascade-fix-before-20260509-1754`  
Production: not touched.  
Main: not touched by Codex.

## Verdict

Source, tests, staging deploy, staging smoke, cleanup dry-run/delete pass, and
authenticated staging probes are complete. This branch is ready for Felipe +
Claude hostile QA before any production push or production cleanup run.

## Root Cause

### Finding 1: Garmin tenant leak

Pre-fix, `src/services/garmin.ts` allowed the legacy filesystem token branch in
`hydrateClientFromPersistedSession(...)` to run for any `userId`. If a non-owner
had no `garmin_sessions` row, the service could load Felipe's token files and
then persist those tokens via `persistTokens(userId)` and
`markGarminConnectionActive(userId, config.garmin.email)`.

Current fixed path:
- `src/services/garmin-session-store.ts:97` defines `isOwnerGarminUserId(...)`.
- `src/services/garmin.ts:685` gates filesystem token import on that owner
  predicate.
- `src/services/garmin.ts:699` logs and skips the filesystem path for
  non-owner users.
- `src/services/garmin.ts:803` refuses global Garmin credential MFA login for
  non-owner users with no per-user session, closing the sibling contamination
  path that would otherwise still use `config.garmin.email`.

### Finding 2: Apple Health fallback gap

The readiness cascade already had a direct Apple Health path after Garmin was
unavailable, but the Garmin leak short-circuited it. This round verified the
cascade end to end and hardened Apple Health parsing so staging/iOS fixture
payloads with `value`, `sdnn_ms`, `ms`, `bpm`, and minute/second sleep keys all
work.

Current fixed path:
- `src/services/readiness-scorer.ts:526` only enters Garmin when the current
  user has an active Garmin connection.
- `src/services/readiness-scorer.ts:541` falls through to Apple Health.
- `src/services/readiness-scorer.ts:365` reads `apple_health_data` scoped by
  `user_id`.
- `src/services/readiness-scorer.ts:489` marks the result reasoning as Apple
  Health-driven for test/probe observability.

## Implementation Summary

- Garmin legacy filesystem token import is owner-only.
- Global Garmin credential MFA login is also blocked for non-owner users with
  no per-user session.
- Apple Health readiness parsing now accepts the payload key shapes used by the
  iOS/staging fixture seeders.
- `scripts/cleanup-tainted-garmin-sessions.mjs` identifies contaminated
  non-owner Garmin rows by owner email match and owner-token-material match,
  defaults to dry-run, and is idempotent.
- Staging fixture harness can seed users with `--seed-apple-health`, include
  Garmin/Apple Health tables in cleanup, run focused route probes, and report
  dashboard readiness text/body-battery text/reason codes.
- Cannot-skip dashboard includes the new
  `garmin-tenant-leak-and-apple-health-cascade` gate.

## Behavioral Evidence

Local validation:
- `npx tsc --noEmit --pretty false`: PASS.
- Focused P0/Garmin/readiness route suite: PASS, 9 files / 140 tests.
- New P0 regression suite: PASS, 6/6.
- Cannot-skip dashboard: PASS, 33/33.
- `node scripts/vi-mock-completeness-lint.mjs --strict`: PASS at strict
  baseline 827.

Staging:
- Deploy to staging: PASS.
- Staging smoke evidence:
  `engine/docs/release/smoke-evidence/staging-smoke-379f741d-20260509T171331Z.json`
  with 17 passed / 0 failed / 19 total. Two entries are process detail rows,
  not failed checks.
- Cleanup dry-run on staging: matched 0 contaminated users, deleted 0 rows.
- Cleanup delete pass on staging: matched 0 contaminated users, deleted 0 rows,
  remaining count 0.
- No-data probe:
  `/tmp/staging-probe-garmin-no-data-20260509T1716.json`
  returned `readinessText: "—"`, `bodyBatteryText: "—"`, and reason codes
  `WEARABLE_INTEGRATION_MISSING` + `BODY_BATTERY_UNAVAILABLE`.
- Apple Health probe:
  `/tmp/staging-probe-garmin-apple-health-20260509T1716.json`
  seeded 21 Apple Health rows, returned `readinessText: "87"` and
  `bodyBatteryText: "72%"`, with no `garmin_sessions` or `garmin_user_tokens`
  rows for the fixture user.

## Cleanup Script Output

Dry-run:

```json
{
  "ok": true,
  "mode": "dry-run",
  "ownerUserId": 1,
  "ownerGarminEmail": "fe***@hotmail.com",
  "matchedCount": 0,
  "deletion": {
    "deletedGarminSessions": 0,
    "deletedGarminUserTokens": 0
  },
  "remainingCount": 0
}
```

Delete pass:

```json
{
  "ok": true,
  "mode": "delete",
  "ownerUserId": 1,
  "ownerGarminEmail": "fe***@hotmail.com",
  "matchedCount": 0,
  "deletion": {
    "deletedGarminSessions": 0,
    "deletedGarminUserTokens": 0
  },
  "remainingCount": 0
}
```

## Other Provider Audit

- Google/Outlook owner env refresh-token bridges still exist, but the audited
  paths are owner-bootstrap migration/fallback helpers; per-user calls go
  through DB-scoped OAuth token lookup. No P0 sibling found in this round.
- `src/services/garmin.ts` was the only `loadTokenByFile` provider hit in the
  audited services.
- P3 deferred: `src/services/amazon-collector.ts` and
  `src/services/uber-collector.ts` use local filesystem session paths. They
  appear collector-scoped and outside Wave 1 wearable readiness, but should get
  a separate user-scope audit before those integrations expand.

## Issues Claude missed

1. clean - Other provider modules with `loadTokenByFile` pattern: Garmin was
   the only hit; Google/Outlook owner env bridges are documented as separate,
   owner-scoped legacy paths.
2. dirty-but-deferred-with-reason - Production cleanup was not run; it requires
   operator authorization after hostile QA. The staging dry-run/delete path is
   proven.
3. clean - Apple Health readiness reads `apple_health_data` by `user_id`; no
   global Apple Health fallback found.
4. clean - Apple Health cascade was not fundamentally broken; it was blocked by
   Garmin appearing connected. Parsing was hardened and regression-tested.
5. clean - Owner Garmin email persistence is now owner-only in legacy/global
   credential paths; Garmin-auth routes persist user-submitted emails.
6. clean - Readiness cron/use sites audited: active-user scheduler paths pass
   explicit user context.
7. dirty-but-deferred-with-reason - I did not check out the backup tag to prove
   the new test fails pre-fix; the post-fix regression and code diff pin the
   launch-blocking behavior.
8. dirty-but-deferred-with-reason - Partial Apple Health data sufficiency
   (example: one HRV sample, no sleep) is not newly covered; keep as P2 follow-up.
9. clean - The P0 suite uses real in-memory DB migrations for Apple Health rows
   and mocked Garmin clients to avoid live provider traffic.
10. dirty-but-deferred-with-reason - Staging pre-fix reproduction was not run
    because the branch was already fixed before staging deploy; the no-data and
    Apple Health post-fix probes are captured.
11. clean - Cleanup detection checks owner email match and owner token-material
    match, not just the email field.
12. dirty-but-deferred-with-reason - Production logs were not searched; that
    requires operator production log access and should be part of the production
    remediation runbook.

## Operator-Only Follow-Ups

- Felipe/Claude hostile QA on this branch.
- If QA returns `READY_FOR_LOCAL_QA`, Felipe authorizes production push.
- Run production cleanup as dry-run first, then `--yes` only after dry-run
  output is reviewed.
- Run production health/smoke after promote.
- Open a P3 provider filesystem-session audit for Amazon/Uber collector modules.

## Production Promote Addendum

Date: 2026-05-09  
Authorization: Felipe prompt authorized branch push, production promote, and
post-deploy cleanup execution after hostile QA returned `READY_FOR_LOCAL_QA`.

### Production Version

- Branch pushed: `p0-garmin-tenant-leak-and-applehealth-cascade-2026-05`.
- Backup tag pushed:
  `backup/garmin-applehealth-cascade-fix-before-20260509-1754`.
- Production deploy commit: `d05e3bac`.
- Production version after promote: `4.14.146`.

### Pre-Promote Revalidation

- Staging deploy from the pushed branch: PASS.
- Staging smoke: PASS, 17 passed / 0 failed / 19 total.
- Evidence:
  `engine/docs/release/smoke-evidence/staging-smoke-d580da66-20260509T173848Z.json`.
- Focused no-data staging probe:
  `engine/docs/release/smoke-evidence/staging-p0-garmin-no-data-20260509T173947Z.json`.
  Result: `readinessText: "—"`, `bodyBatteryText: "—"`, and
  `WEARABLE_INTEGRATION_MISSING` present.
- Focused Apple Health staging probe:
  `engine/docs/release/smoke-evidence/staging-p0-garmin-apple-health-20260509T173947Z.json`.
  Result: `readinessText: "87"`, `bodyBatteryText: "72%"`, and
  `WEARABLE_INTEGRATION_MISSING` absent.

### Production Cleanup

- Pre-promote production dry-run:
  `engine/docs/release/smoke-evidence/prod-cleanup-dry-run-20260509T174048Z.json`.
  It found 5 tainted non-owner Garmin token/session rows: user ids
  `25`, `28`, `29`, `30`, and `86`; PII remained redacted by the script.
- Post-deploy dry-run:
  `engine/docs/release/smoke-evidence/prod-cleanup-postdeploy-dry-run-20260509T174712Z.json`.
  It found the same 5 rows after the source-side gate was live.
- Delete pass:
  `engine/docs/release/smoke-evidence/prod-cleanup-delete-20260509T174717Z.json`.
  It deleted 5 `garmin_sessions` rows and 5 `garmin_user_tokens` rows.
- Post-delete dry-run:
  `engine/docs/release/smoke-evidence/prod-cleanup-postdelete-dry-run-20260509T174722Z.json`.
  Result: `matchedCount: 0`, `remainingCount: 0`.

### Production Health

- Public API health:
  `engine/docs/release/smoke-evidence/prod-health-20260509T174909Z.json`
  returned `status: healthy`.
- Detailed health:
  `engine/docs/release/smoke-evidence/prod-health-detailed-20260509T174909Z.json`
  returned `status: healthy`.
- Portal snapshot:
  `engine/docs/release/smoke-evidence/prod-snapshot-20260509T174909Z.json`
  returned version `4.14.146`.
- PM2 process check:
  `engine/docs/release/smoke-evidence/prod-pm2-health-20260509T174938Z.json`
  returned `nexus-hub` and `content-engine` online at `4.14.146`.

### Production Readiness Probe

- Non-owner user `28` has real Apple Health data in production and no
  contaminated Garmin token row after cleanup.
- Probe evidence:
  `engine/docs/release/smoke-evidence/prod-non-owner-readiness-probe-user28-clean-20260509T174858Z.json`.
- Result: readiness `84`, body battery `78`, Apple Health reasoning present,
  and `notLeakedFelipe6672: true`.
- Note: user `25` also resolved through Apple Health, but its current
  production Apple Health-derived values coincidentally matched the historical
  leaked pair, so user `28` is the decisive non-owner proof for this gate.

### Final Status

- P0 source-side fix is live in production.
- Production tainted Garmin session/token rows are removed.
- Production readiness for at least one non-owner user is Apple Health-derived
  and not the Felipe leaked pair.
- Wave 1 Garmin/Apple Health readiness launch block is closed.
