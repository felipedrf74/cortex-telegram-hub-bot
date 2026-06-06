# P0 Tenant And Safety + Perf Hardening - Round B Closeout

Date: 2026-05-10
Status: SOURCE_AND_STAGING_VALIDATION_COMPLETE

Engine branch: `fix/perf-and-a11y-2026-05`
Engine code commit: `796b93ae`
Engine deploy-script fix: `4b7c5537`

iOS branch: `fix/perf-and-a11y-2026-05`
iOS code commit: `13a5fa9`

Base: `origin/fix/p0-tenant-and-safety-2026-05` (Round A launch-blocker tenant/safety branch).

Production: not touched.
Engine main: not pushed.
iOS main: not pushed.
TestFlight: not cut.

## Scope

Round A closed Parts 1-2 (P0 tenant isolation + production safety). This Round B closes the remaining Parts 3-5: Felipe-volume Home performance, second-pass backend performance, iOS hot-path performance, retry/backoff safety, and accessibility polish.

## Implementation Summary

### Engine

- `src/api/routes/dashboard-data-fetchers.ts:29` extends `DASHBOARD_READINESS_CACHE_TTL` to 300 seconds.
- `src/api/routes/dashboard-data-fetchers.ts:319` keeps `fetchTraining()` behavior but accepts test-injected dependencies and starts readiness plus fallback calendar-event fetch in parallel via `Promise.allSettled()` at `src/api/routes/dashboard-data-fetchers.ts:354`.
- `src/api/routes/dashboard.ts:32` and `src/api/routes/dashboard.ts:34` align dashboard/root and dashboard/home fresh TTLs to 180 seconds; the SWR stale window remains 300 seconds.
- `src/api/routes/content-topic-routes.ts:104` tightens `/content/topics` default limit to 20 and hard-caps at 500.
- `migrations/118_perf_indexes_daily_context_audit.sql:5` adds `idx_daily_context_lookup` on `(tenant_id, user_id, date, scope_status)`.
- `migrations/118_perf_indexes_daily_context_audit.sql:8` adds `idx_audit_action_ts` on `(action, ts DESC)`.
- `src/services/scheduler.ts:62` and `src/services/scheduler.ts:721` add a process-level reminder cron mutex that skips overlapping ticks and always releases in `finally`.
- `src/services/cache-store.ts:337` accepts a single prefix or an array of prefixes in `clearCacheByPrefix()`.
- `src/services/cache-coherence-registry.ts:182`, `:199`, `:213`, `:304`, `:312`, `:345`, and `:357` batch related cache-prefix invalidations through the new array path without changing cache-key vocabulary.
- `src/services/provider-fallback.ts:103` and `:218` convert provider runaway detection into a clean 502 hard stop (`AI_PROVIDER_RUNAWAY_LIMIT`) before another fallback attempt is made.
- `src/utils/logger.ts:118` compiles logger redaction paths once at module scope.
- `src/index.ts:114` cold-starts the active provider router during boot and fails soft with a warning if provider warmup cannot complete.
- `scripts/deploy-staging.sh` now excludes symlinked `node_modules` and `.claude` metadata. This was required after a worktree symlink caused rsync code 23 and briefly left staging without installed dependencies.

### iOS

- `Nexus Hub/ViewModels/DashboardViewModel.swift:443` runs dashboard load and calendar warmup concurrently.
- `Nexus Hub/Views/Dashboard/DashboardView.swift:363` caches sorted/deduped Home Secretary calendar projections in `@State`, turning repeated SwiftUI reads into O(1) access until the underlying event signature changes.
- `ContentRepository.swift`, `CookingRepository.swift`, and `FinanceRepository.swift` align dashboard-facing cache TTLs to 60 seconds.
- `Nexus Hub/Core/NexusHTTPClient.swift` retries transient GET/PATCH/PUT failures with exponential jittered backoff, does not auto-retry POST, and moves JSON decoding off the main actor via `decodeBodyAsync()`.
- `WeeklyMealPlanView.swift`, `TopicSchedulerView.swift`, `TasksViewModel.swift`, and `ConnectionsView.swift` cache hot-path `DateFormatter` / `ISO8601DateFormatter` instances.
- `ReceiptReviewSheet.swift` downscales receipt preview images, constrains preview height, and replaces hardcoded confidence icon type with semantic `.callout`.
- `TaskPriority.swift` and `TaskCountChip.swift` replace hardcoded system font sizes with semantic Dynamic Type-friendly styles.
- `Nexus_HubApp.swift`, `DashboardViewModel.swift`, `MainTabView.swift`, and `QuickAddBar.swift` add reduce-motion guards around launch/Home/quick-add animation paths.
- Source-pin accessibility coverage now asserts labels for MainTab, QuickAdd, task rows, dashboard calendar rows, training rows, content topics, recipes, and finance transactions.

## Behavioral Evidence

### Engine local

- Typecheck PASS: `npx tsc --noEmit --pretty false`.
- Focused Round B suite PASS: 6 files / 65 tests.
  - `__tests__/api/dashboard-routes.test.ts`
  - `__tests__/api/content-topic-routes.test.ts`
  - `__tests__/services/cache-store-observability.test.ts`
  - `__tests__/services/cache-coherence-registry.test.ts`
  - `__tests__/services/model-routing-observability.test.ts`
  - `__tests__/services/model-routing-local-smoke.test.ts`
- Commit hook focused suite PASS: 58 files / 436 tests.
- Push hook focused suite PASS: 85 files / 832 tests.
- Mock completeness lint PASS: 827 / 827 strict baseline.
- Cannot-skip dashboard PASS: 34 / 34.
- Docs audit PASS: 408 issues / 475 markdown files (under 480 ceiling).

### Engine staging

- Staging deploy PASS after fixing `deploy-staging.sh` symlink exclusions.
- Staging smoke PASS: 20 tests / 0 failures.
  - Evidence: `docs/release/smoke-evidence/staging-smoke-4b7c5537-20260510T154651Z.json`
- Authenticated staging fixture probe PASS: 0 route failures, synthetic user cleanup returned `remainingUser: 0`.
  - Evidence: `docs/release/smoke-evidence/staging-perf-a11y-fixture-probe-20260510T154733Z.json`
  - Dashboard-home timing: 91.6 ms first call -> 8.3 ms cached call.
  - Dashboard-root timing: 54.9 ms first call -> 7.6 ms cached call.

### iOS

- Debug focused suite PASS: 45 tests / 0 failures.
  - xcresult: `/Users/felipedominguez/Library/Developer/Xcode/DerivedData/Nexus_Hub-croxswchyfuczufajxyojmbmflef/Logs/Test/Test-Nexus Hub-2026.05.10_16-19-11-+0100.xcresult`
- ReleaseWithTesting focused suite PASS: 45 tests / 0 failures.
  - xcresult: `/Users/felipedominguez/Library/Developer/Xcode/DerivedData/Nexus_Hub-croxswchyfuczufajxyojmbmflef/Logs/Test/Test-Nexus Hub-2026.05.10_16-19-44-+0100.xcresult`
- ReleaseWithTesting full unit suite PASS: 1,263 XCTest + 10 Swift Testing / 0 failures.
  - xcresult: `/Users/felipedominguez/Library/Developer/Xcode/DerivedData/Nexus_Hub-croxswchyfuczufajxyojmbmflef/Logs/Test/Test-Nexus Hub-2026.05.10_16-24-40-+0100.xcresult`
- Release UI visual matrix PASS via `Nexus Hub Release UI Validation`: 21 tests / 0 failures / 80 PNG screenshots.
  - xcresult: `/Users/felipedominguez/Library/Developer/Xcode/DerivedData/Nexus_Hub-croxswchyfuczufajxyojmbmflef/Logs/Test/Test-Nexus Hub Release UI Validation-2026.05.10_16-26-04-+0100.xcresult`

## Performance Evidence

- Engine `fetchTraining()` now has a controlled-delay regression proving readiness and calendar fallback wall time follows `max(delay)` rather than `sum(delay)`.
- Dashboard cache TTL tests assert the 180-second route cache and 300-second readiness cache constants.
- iOS source-pin tests assert dashboard and Home Secretary hot paths moved from repeated computed work to concurrent/cached paths.
- Full Instruments traces and a true Felipe-volume 100-event staging before/after measurement were not captured in this coding pass because the current staging fixture harness does not seed calendar-provider event volume. The authenticated staging probe did confirm the deployed Home cache behavior on a synthetic Apple Health user (`dashboard-home` 91.6 ms -> 8.3 ms cached), and the source changes are test-backed. Operator QA should still spot-check Home rendering under a 100-event fixture before TestFlight.

## Issues Claude Missed

- P3: `scripts/deploy-staging.sh` excluded `node_modules/` but not symlinked `node_modules`. Worktree deploys could try to replace the remote dependency directory with a local symlink, returning rsync code 23 after services had already stopped. Fixed in this round by excluding both `node_modules` and `node_modules/`, plus `.claude` metadata.
- P3: The existing staging fixture harness does not yet seed 100 calendar events, so it cannot directly produce the Felipe-volume Home performance proof requested by the prompt. The implementation includes deterministic code-level concurrency/cache tests; a future fixture enhancement should add calendar-volume seeding for repeatable wall-time comparisons.

## Hostile Self-Review

1. Engine dashboard TTLs preserve stale-while-revalidate semantics: clean.
2. Readiness cache TTL matches Garmin/Apple Health update cadence better than 60 seconds: clean.
3. `fetchTraining()` parallelization preserves fallback behavior when either readiness or events rejects: clean, covered by `Promise.allSettled()` and test injection.
4. Dashboard cache-key strings were not changed: clean.
5. Batched cache invalidation preserves the same prefix set: clean, covered by flattened-prefix tests.
6. `clearCacheByPrefix()` still accepts old single-string callers: clean.
7. Reminder cron mutex cannot wedge after an exception: clean, `finally` resets `remindersJobInFlight`.
8. Provider runaway hard-stop emits a clean error and prevents an extra provider attempt: clean, covered by two model-routing tests.
9. Provider cold-start cannot crash boot if provider registry warmup fails: clean, warning-only path.
10. iOS HTTP retry excludes POST and 4xx caller errors: clean, source and retry test cover transient GET behavior.
11. JSON decode off-main preserves API contract and only changes execution context: clean.
12. Dashboard event caching can go stale if the signature misses a semantic event field: dirty-but-deferred-with-reason. The signature includes id/start/end/title count/order fields sufficient for the rendered Home Secretary projection; deeper event-body changes should be covered by repository event identity tests in a future UI perf round.
13. Reduce-motion guards cover launch/Home/quick-add paths from the prompt: clean.
14. Dynamic Type changes remove the three hardcoded font-size sites named by the prompt: clean.
15. Accessibility source-pin coverage is not a substitute for full VoiceOver runtime auditing: dirty-but-deferred-with-reason. The code coverage is now substantially better, but physical-device VoiceOver smoke remains operator QA.
16. True Felipe-volume before/after wall-time evidence is incomplete without a 100-event fixture: dirty-but-deferred-with-reason, tracked above as a fixture enhancement.

## Cleanup Contract

- Production was not deployed.
- Engine `main` was not pushed.
- iOS `main` was not pushed.
- TestFlight was not cut.
- No simulator processes were intentionally left running beyond normal Xcode test artifacts.

## Operator Follow-Ups

- Run hostile QA against `fix/perf-and-a11y-2026-05` in both repos.
- Add 100-calendar-event seeding to the staging fixture harness before treating Felipe-volume wall-time deltas as closed with runtime evidence.
- If QA returns `READY_FOR_LOCAL_QA`, decide whether Round B promotes with Round A or remains queued behind the launch-blocker production path.
