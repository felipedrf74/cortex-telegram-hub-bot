# Backend Current Release State

Status: canonical
Owner: backend release lead (Felipe)
Last verified: 2026-05-09
Update policy: update after backend deploy or staging change. Workspace-level entry point is docs/release/CURRENT_RELEASE_STATE.md.

Last updated: 2026-05-09

## Active Production Release

- Source branch: `p0-garmin-tenant-leak-and-applehealth-cascade-2026-05`
- Production HEAD: `d05e3bac`
- Release source commits:
  - `645c7ece fix(garmin): restrict global token fallback to owner user only`
  - `9bf19ccf feat(wearable): verify Apple Health readiness cascade`
  - `5f87ec3c feat(scripts): clean tainted Garmin session rows`
  - `379f741d test(security): assert Garmin Apple Health cascade isolation`
  - `d580da66 docs: refresh release identity mirror after P0 closeout`
  - `d05e3bac chore: bump version to 4.14.146 [deploy]`
- iOS source was not changed in this backend P0 promote.
- Production version: `4.14.146`
- Official workspace root: `/Users/felipedominguez/Desktop/Nexus Hub`

## Scope

P0 Garmin tenant-leak block and Apple Health readiness cascade verification:

- Garmin legacy filesystem token fallback is owner-only.
- Global Garmin credential MFA login is blocked for non-owner users without
  per-user Garmin sessions.
- Apple Health readiness fallback is verified when Garmin is empty.
- Contaminated non-owner Garmin token/session rows were removed after the
  source-side fix was live.
- Non-owner production readiness probe confirmed Apple Health-derived values,
  not the leaked Felipe readiness/body-battery pair.

## Validation Before Promotion

- Branch push preflight: typecheck PASS and focused P0 suite PASS.
- Pre-promote staging deploy: PASS.
- Pre-promote staging smoke: 17 passed / 0 failed / 19 total.
- Deploy-time validation: full vitest PASS, 492 files / 7157 tests.
- Deploy-time build: PASS.
- Production promote: completed at `4.14.146`.
- Production health: API health healthy, portal snapshot version `4.14.146`,
  PM2 `nexus-hub` and `content-engine` online at `4.14.146`.
- Production cleanup: dry-run matched 5 tainted rows, delete pass removed 5,
  post-delete dry-run matched 0.

## Evidence

- Staging smoke evidence:
  - `docs/release/smoke-evidence/staging-smoke-d580da66-20260509T173848Z.json`
- Staging readiness probe evidence:
  - `docs/release/smoke-evidence/staging-p0-garmin-no-data-20260509T173947Z.json`
  - `docs/release/smoke-evidence/staging-p0-garmin-apple-health-20260509T173947Z.json`
- Production cleanup/health evidence:
  - `docs/release/smoke-evidence/prod-cleanup-dry-run-20260509T174048Z.json`
  - `docs/release/smoke-evidence/prod-cleanup-delete-20260509T174717Z.json`
  - `docs/release/smoke-evidence/prod-cleanup-postdelete-dry-run-20260509T174722Z.json`
  - `docs/release/smoke-evidence/prod-health-20260509T174909Z.json`
  - `docs/release/smoke-evidence/prod-snapshot-20260509T174909Z.json`
  - `docs/release/smoke-evidence/prod-pm2-health-20260509T174938Z.json`
- Production non-owner readiness evidence:
  - `docs/release/smoke-evidence/prod-non-owner-readiness-probe-user28-clean-20260509T174858Z.json`
- Backend QA report: `docs/qa/QA_BACKEND_REPORT.md`
- iOS QA report: `/Users/felipedominguez/Desktop/Nexus Hub/ios/docs/qa/QA_IOS_REPORT.md`
- Release gate report: `docs/qa/QA_RELEASE_GATE_REPORT.md`
- Closed-beta runbook: `docs/release/closed-beta-runbook.md`
- Portal scope policy: `docs/release/portal-scope-policy.md`

## Required Post-Promotion Checks

Production-safe follow-ups:

- TestFlight/device pass should confirm the iOS readiness card renders Apple
  Health-derived values for non-Garmin users after the backend cleanup.
- Separate P3 audit remains open for Amazon/Uber collector filesystem sessions.
