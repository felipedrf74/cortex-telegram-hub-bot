# iOS Pre-TestFlight Release-Mode Validation

Date: 2026-05-10
Scope: iOS `main` pre-TestFlight hardening for Wave 1.

## Source Reconcile

- Task A single-flight regression test was cherry-picked onto iOS `main`.
- Cherry-pick commit: `39b4003`.
- Focused Debug suite: `CachedResourceTests` passed 7/7.
- Debug xcresult: `/tmp/nexus-ios-pre-testflight/CachedResourceTests-Debug-20260510T001753Z.xcresult`.
- iOS `origin/main` after validation + version bump: `5981d10`.

## Release Clean Build

- Status: PASS.
- Configuration: `Release`.
- Destination: `platform=iOS Simulator,name=iPhone 17 Pro`.
- Build log: `/tmp/nexus-ios-pre-testflight/release-clean-build-final-pinned-20260510T083948Z.log`.
- Warning/error scan: zero `warning:` and zero `error:` lines.
- AppIntents.framework link fix: added explicit `-framework AppIntents` linker flags to the app target so Xcode's App Intents metadata extraction no longer emits the missing-framework warning.

## Release Unit Tests

Release-config unit tests are intentionally skipped. Apple sets `ENABLE_TESTABILITY = NO` in Release by design, and `Nexus HubTests` uses `@testable import Nexus_Hub`, so compiling the unit-test bundle against the Release app target is not the right validation surface for this round.

The Debug-config unit pass remains the correctness gate. If Release-mode unit coverage becomes necessary later, add a dedicated `ReleaseWithTesting` configuration that inherits Release optimizations and explicitly sets `ENABLE_TESTABILITY = YES`.

## Release Visual Matrix

- Status: PASS.
- Scheme: `Nexus Hub Release UI Validation`.
- Configuration: `Release`.
- Destination: `platform=iOS Simulator,name=iPhone 17 Pro`.
- Test class: `Nexus HubUITests/RepositoryCacheStateVisualUITests`.
- Result: 21/21 passed.
- Screenshot attachments: 80 PNGs.
- xcresult: `/tmp/nexus-ios-pre-testflight/RepositoryCacheStateVisualUITests-ReleaseUIOnly-20260510T083018Z.xcresult`.
- Test log: `/tmp/nexus-ios-pre-testflight/release-repository-visual-matrix-ui-only-20260510T083018Z.log`.

The dedicated Release UI validation scheme excludes the unit-test bundle while still launching the Release-built app binary through `XCUIApplication`. `QualityAuditScenario` now honors forced visual-audit scenarios only for simulator UI-test launches in non-Debug builds; TestFlight/device binaries continue to ignore the audit scenarios.

## Debug vs Release Divergence

None found. The Release visual matrix matched the Debug-era expected shape: every repository-consuming surface rendered loading, cached-fresh, cached-stale, and error+retry states across en-US and pt-BR, with all 80 screenshots attached.

## Optimizer-Crash Regression

Confirmed clean. The Release visual matrix exercises the repository cache visual audit host through the Release-built binary and repeatedly enters/exits cache-state surfaces, which triggers the `CachedResource` lifecycle and deallocation paths that previously surfaced the optimizer crash fixed by `3c85ce50`.

## TestFlight Version Bump

- Old marketing version/build: `1.4.1` / `15`.
- New marketing version/build: `1.4.2` / `16`.
- Approach: direct `project.pbxproj` update for the app target's Debug and Release `MARKETING_VERSION` and `CURRENT_PROJECT_VERSION`.
- Verification: `xcodebuild -showBuildSettings -scheme "Nexus Hub"` reports `MARKETING_VERSION = 1.4.2` and `CURRENT_PROJECT_VERSION = 16`.
- Version bump commit: `5981d10`.

## Garmin Watcher Observability Snapshot

- Script added: `engine/scripts/check-garmin-watcher-state.mjs`.
- Focused unit test: `engine/__tests__/scripts/check-garmin-watcher-state.test.ts`, 2/2 passed.
- Engine typecheck: PASS.
- Mock lint: PASS at 826/827 strict baseline.
- Staging deploy: PASS, production untouched.
- Staging snapshot: `engine/docs/release/smoke-evidence/staging-garmin-watcher-state-20260510T084533Z.json`.
- Staging result: `recentErrorLogCount: 0`, `openAlertCount: 0`, `mostRecentMatchedCount: 0`.

## Operator Boundary

No TestFlight build was cut, no App Store Connect upload was performed, no invitations were sent, and no signing/provisioning identities were modified.

