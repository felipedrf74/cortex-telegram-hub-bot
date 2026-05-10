# Home Performance Pre-Wave-1 Closeout

Date: 2026-05-10

Status: READY_FOR_HOSTILE_QA

## Branches

| Repo | Branch | Backup tag | Head |
| --- | --- | --- | --- |
| iOS | `fix/home-perf-pre-wave1-2026-05` | `backup/home-perf-pre-wave1-ios-before-20260510-1332` | `b69a0ce` |
| Engine | `fix/home-perf-pre-wave1-2026-05` | `backup/home-perf-pre-wave1-engine-before-20260510-1332` | `86ef215d` |

Production, engine `main`, iOS `main`, and TestFlight were not touched.

## Implementation Summary

### Fix 1 - iOS DashboardViewModel parallel warmup

`Nexus Hub/ViewModels/DashboardViewModel.swift:443` now starts `loadCommand.execute()` and `refreshHomeCalendarCachesIfNeeded()` with sibling `async let` tasks, then awaits both together. The focused regression test at `Nexus HubTests/DashboardViewModelObservationTests.swift:36` delays the dashboard, today-calendar, and range-calendar requests and asserts all three are observed before any delayed response is released.

### Fix 2 - iOS Home Secretary calendar projection cache

`Nexus Hub/Views/Dashboard/DashboardSecretaryCalendarPresentation.swift:18` adds `DashboardSecretaryHomeCalendarSnapshot`; `:31` adds `DashboardSecretaryHomeCalendarSnapshotCache`; `:313` keeps the existing sort/dedupe algorithm behind `homeSnapshot(...)`. `Nexus Hub/Views/Dashboard/DashboardView.swift:363` owns one cache instance and `:500` reads the cached event, compact-event, and timeline projections.

The focused 100-event test at `Nexus HubTests/DashboardSecretaryCalendarPresentationTests.swift:249` calls the cached projection 12 times with identical inputs and verifies the builder runs once, then verifies a changed input invalidates the cache.

### Fix 3 - Engine dashboard readiness TTL

`src/api/routes/dashboard-data-fetchers.ts:31` moves dashboard readiness cache TTL from 60 seconds to 300 seconds. `__tests__/api/dashboard-routes.test.ts:780` asserts `dashboard-readiness:{userId}` writes with TTL `300`.

### Fix 4 - Engine fetchTraining parallel readiness + events

`src/api/routes/dashboard-data-fetchers.ts:356` starts readiness work immediately and `:363` starts the calendar event lookup as a settled promise. The existing branches consume the results at `:371` and `:440`. `__tests__/api/dashboard-routes.test.ts:822` uses two controlled 100 ms delays and asserts total wall time is below the sequential sum.

### Fix 5 - Engine dashboard cache TTL alignment

`src/api/routes/dashboard.ts:32` and `:34` move the root/home dashboard cache TTLs from 60 seconds to 180 seconds while preserving the 300 second SWR stale window. `__tests__/api/dashboard-routes.test.ts:802` asserts a second read returns the warm cached path.

### Fix 6 - iOS dashboard cache TTL alignment

`Nexus Hub/Core/Repositories/DashboardRepository.swift:35` moves dashboard/home repository cache TTL from 30 seconds to 60 seconds. The underlying `CachedResource` instances at `:47` and `:48` use the shared TTL. Secondary Content/Cooking/Finance preview TTLs remain at 300 seconds; lowering them would increase provider load and was not the requested align-up path.

## Behavioral Evidence

### iOS

| Gate | Result | Evidence |
| --- | --- | --- |
| Focused DEBUG tests | PASS - 2 tests / 0 failures | `/Users/felipedominguez/Library/Developer/Xcode/DerivedData/Nexus_Hub-dqmldhrjztglllhauzggxgzcbpif/Logs/Test/Test-Nexus Hub-2026.05.10_13-44-43-+0100.xcresult` |
| Repository visual matrix DEBUG | PASS - 21 tests / 80 screenshots | `/Users/felipedominguez/Library/Developer/Xcode/DerivedData/Nexus_Hub-dqmldhrjztglllhauzggxgzcbpif/Logs/Test/Test-Nexus Hub-2026.05.10_13-45-27-+0100.xcresult` |
| Repository visual matrix Release | PASS - 21 tests / 80 screenshots | `/Users/felipedominguez/Library/Developer/Xcode/DerivedData/Nexus_Hub-dqmldhrjztglllhauzggxgzcbpif/Logs/Test/Test-Nexus Hub Release UI Validation-2026.05.10_13-55-46-+0100.xcresult` |

Release validation used the tracked `Nexus Hub Release UI Validation` scheme. The default `Nexus Hub` scheme still compiles the unit-test target in Release, which hits Apple's expected `ENABLE_TESTABILITY = NO` behavior for `@testable import`.

`ReleaseWithTesting` was not available on this branch base because `origin/main` does not include the separate local `ca41491` build-configuration commit. That gate was therefore not runnable from the requested `origin/main` branch base.

### Engine

| Gate | Result | Evidence |
| --- | --- | --- |
| `npx tsc --noEmit --pretty false` | PASS | local command output empty |
| Focused dashboard suite | PASS - 1 file / 25 tests | `npx vitest run __tests__/api/dashboard-routes.test.ts --reporter=default` |
| Pre-commit focused suite | PASS - 2 files / 48 tests | dashboard routes + P0 chat identity isolation |
| Commit hook focused suite | PASS - 2 files / 25 tests | cached-route-handler + Garmin/Apple Health cascade |
| VI mock completeness lint | PASS - 493 files, 826 partial mocks, baseline 827 | `node scripts/vi-mock-completeness-lint.mjs --strict` |
| Staging smoke | PASS - 17 passed / 0 failed | `docs/release/smoke-evidence/staging-smoke-86ef215d-20260510T131242Z.json` |
| Docs audit | PASS - 414 issues, under 480 ceiling | `npm run docs:audit` |

The staging deploy initially hit an rsync code 23 from a local worktree `node_modules` symlink. The symlink was removed, the same branch payload was synced with `node_modules` excluded, PM2 processes were restarted, content-engine health passed, and staging smoke passed 17/0.

## Staging Fixture Probe

Successful probe report:

`docs/release/smoke-evidence/home-perf-staging-fixture-after-86ef215d-20260510T131450Z.json`

The authenticated staging fixture used Apple Health seed data and cleaned up user `1000009` after the run. Key timings:

| Route | First read | Second read | Cache flags | Readiness signal |
| --- | ---: | ---: | --- | --- |
| `dashboard-root` | 51.5 ms | 8.5 ms | false -> true | n/a |
| `dashboard-home` | 131.6 ms | 7.9 ms | false -> true | readiness `87`, body battery `74%` |
| `training-home` | 26.0 ms | 7.6 ms | false -> true | n/a |

The exact requested before/after wall-time measurement on a 100-calendar-event synthetic Felipe-volume fixture could not be completed because the current staging fixture harness does not seed 100 calendar events or a fixture calendar OAuth provider. The source-level regression tests prove the two latency mechanics directly, and the staging fixture proves the post-fix warm-cache path, but this is not a full before/after Felipe-volume measurement.

## Issues Claude Missed

1. clean - Fix 1 starts dashboard load and calendar warmup as sibling tasks; the focused test proves both paths are invoked before either returns.
2. clean - Fix 2 does not rewrite the calendar sort/dedupe algorithm; it moves Home hot-path projection behind a snapshot cache.
3. clean - The 100-event projection test proves repeated SwiftUI body reads reuse one projection build.
4. clean - Dashboard readiness TTL is tested at the cache-write boundary with TTL `300`.
5. clean - Dashboard route TTL alignment is tested with a second cached read and TTL-preserving SWR.
6. clean - `fetchTraining` wall-time regression is tested through public `fetchTraining` behavior, not by peeking at internals.
7. dirty-but-deferred-with-reason - `fetchTraining` now starts the calendar lookup even when an active plan session later satisfies the UI branch. This was the requested top-hoist shape and buys latency for no-plan users, but it can over-fetch on plan-session users. Revisit after Wave 1 telemetry if calendar load becomes visible.
8. dirty-but-deferred-with-reason - The staging fixture harness cannot currently produce the requested 100-calendar-event Felipe-volume before/after measurement. Add calendar fixture seeding and a provider-free event path before treating this as a formal perf benchmark.
9. dirty-but-deferred-with-reason - The deploy script was vulnerable to a local `node_modules` symlink in worktrees; rsync failed before restart. Add an explicit `--exclude=node_modules` or avoid symlinked dependency roots in future worktrees.
10. dirty-but-deferred-with-reason - `ReleaseWithTesting` was unavailable on the requested iOS branch base. Once the config commit is on `origin/main`, re-run the full ReleaseWithTesting unit gate before TestFlight if Felipe wants that signal in this branch lineage.
11. clean - Release visual matrix passed with 80 screenshots, so the Home projection cache did not alter the visible repository-cache state matrix.
12. clean - Production was not touched, no TestFlight was cut, and both staging fixture cleanup and PM2 staging health completed.

## Cleanup Contract

- Production promote: not performed.
- Engine `main`: not pushed.
- iOS `main`: not pushed.
- TestFlight: not cut.
- Staging fixture user: cleaned up by harness (`remainingUser = 0`).
- Local staging tunnel: closed.
- Remaining operator follow-up: hostile QA should decide whether the missing 100-calendar-event fixture benchmark is acceptable for Wave 1 or should become a small tooling ticket.
