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
