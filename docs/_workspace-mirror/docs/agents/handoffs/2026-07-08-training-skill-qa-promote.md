# 2026-07-08 Training Skill QA Promote Handoff

Status: production promoted, backend and iOS main pushed. TestFlight/App Store upload was not authorized or run.

## What Shipped

- Backend `/Users/felipedominguez/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot` promoted to production at `b1916a76`, version `4.14.213`.
- Runtime Training code landed in `b28a47b6`; QA handoff/docs in `90d0a8a3`; staging-smoke evidence in `b1916a76`.
- iOS `/Users/felipedominguez/Developer/Nexus Hub IOS/Nexus Hub` pushed to `main` at `e1d1ca0` with commits:
  - `9093526` Training plan/route/calendar presentation hardening.
  - `88e48bc` Content Studio bottom scroll runway repair.
  - `e1d1ca0` TestFlight export stable-toolchain guard and Content Studio UI smoke fix.
- Local iOS `Nexus Hub.xcodeproj/project.pbxproj` build-number bump remains uncommitted, unreverted, and not uploaded pending Felipe's App Store Connect build-state confirmation.

## Evidence

- Backend classifier selected T0/T1/T2/T4/T5-on-promote/T6-postdeploy.
- Backend risk gate passed focused Training/calendar 131 files / 2,086 tests and changed sweep 54 files / 1,431 tests; pre-push repeated the gate and build verification.
- iOS focused gates passed:
  - `NavigationPerformanceSourcePinsTests`: 43/43.
  - touched Training bundle: 154/154.
  - `ContentStudioShellUITests` on `Nexus Hub Debug UI Smoke`: 4/4.
- Staging deploy passed; soak ran `2026-07-08T17:24:35Z` to `2026-07-08T17:29:35Z`.
- Staging smoke passed 19/19 with engine evidence `docs/release/smoke-evidence/staging-smoke-90d0a8a3-20260708T173034Z.json`.
- Promote gate smoke passed 19/19.
- Production deploy validation passed migration safety (216 migrations), typecheck, science-policy check, and full Vitest 867 files / 12,725 tests.
- Post-promote probes passed:
  - public `https://api.nexushub.me/health`: `status=healthy`, server online, database connected.
  - public `https://api.nexushub.me/public-status`: `status=ok`.
  - PM2 `nexus-hub` and `content-engine` online on `4.14.213`.
  - authenticated Decision Center overview returned `ok: true`.

## Not Run / Still Blocked

- TestFlight/App Store upload, App Review, App Store Connect build-state mutation.
- Physical-device proof.
- Live Google/Outlook production calendar writes.
- Two-account provider proof.
- HealthKit, Garmin, APNs live push, and production provider-state validation.
- Wider follow-ups from Claude QA remain product/owner-scoped: real wearable capture timestamp conduit, Secretary provider-sync fingerprinting, and reflow-confirm agenda mapping cleanup.

## Canonical Docs Updated

- Backend `docs/release/CURRENT_RELEASE_STATE.md`.
- Backend `docs/release/current-release-index.md`.
- Backend `docs/release/feature-delivery-ledger.md`.
- Workspace `docs/release/CURRENT_RELEASE_STATE.md`.
- Workspace `docs/release/feature-delivery-ledger.md`.

## 2026-07-08 P3 Release Tooling Promote Addendum

Felipe authorized fixing the three P3 findings from adversarial QA and
promoting the backend again. TestFlight/App Store upload remained out of scope.

What shipped:

- Backend production now runs `4.14.214` at `df21fd04`.
- Backend commits pushed to `origin/main`: `dd7afaf8` version mint / promote
  policy, `113b83a5` PM2 smoke-evidence status checks, and `df21fd04`
  pre-promote staging-smoke evidence.
- iOS `main` is pushed at `3030c71`; `scripts/testflight-export.sh` defaults
  to local `export` and requires `IOS_EXPORT_DESTINATION=upload` for upload.
- iOS `Nexus Hub.xcodeproj/project.pbxproj` remains intentionally dirty and
  uncommitted pending App Store Connect build-number confirmation.

Evidence:

- iOS `bash -n`, grep assertion, 12-case guard matrix under `/bin/bash` 3.2,
  and `scripts/ios-release-hardening-validate.sh` passed.
- Backend classifier selected T0/T1/T3-recommended/T5-on-promote/T6-postdeploy.
- Backend risk gate and pre-push each passed typecheck plus full Vitest 867
  files / 12,725 tests.
- Staging deploy passed; soak ran `2026-07-08T19:02:05Z` to
  `2026-07-08T19:07:05Z`.
- Standalone staging smoke passed 21/21 with engine evidence
  `docs/release/smoke-evidence/staging-smoke-113b83a5-20260708T190748Z.json`.
  The schema intentionally differs from previous 19/19 smoke evidence because
  PM2 online/restart gates now appear as explicit status-bearing checks.
- Promote gate smoke passed 21/21; strict deploy validation passed migration
  safety (216 migrations), typecheck, science-policy, and full Vitest 867
  files / 12,725 tests.
- Post-promote probes passed: public `/health`, exact public `/public-status`
  shape, PM2 `nexus-hub` + `content-engine` online on `4.14.214`, and
  authenticated Decision Center overview `ok: true`.

Still blocked / not authorized:

- TestFlight/App Store upload, physical-device proof, live Google/Outlook
  production calendar writes, two-account provider proof, HealthKit, Garmin,
  APNs live push, provider-state validation, and App Store Connect build 51/52
  manual confirmation.
