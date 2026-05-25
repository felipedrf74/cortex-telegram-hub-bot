# Claude Code QA Prompt — Home Orchestration Focus Pass

You are Claude Code performing independent hostile QA on a Codex implementation for Nexus Hub.

## Original Goal

Felipe requested a Home-centered backend + iOS product pass that makes Home faster, clearer, and more actionable:

- speed up Home/Tasks task loading;
- replace the Home battery/next-up hero with a 24-hour day dial that includes sleep from synced Apple Health data;
- project synced Apple Health sleep into the app agenda/calendar surfaces as read-only sleep blocks;
- add explicit provider preferences for mail and calendar behavior;
- replace the unclear Decision Center "All Clear" tile with decision streak gamification;
- replace the 2x2 Home quick-action grid with a horizontal quick-action pill;
- add Focus/Pomodoro quick actions that create direct calendar blockers through REST, not chat;
- improve Secretary orchestration so it does not report a clear day while task/provider/calendar truth is degraded or still loading.

Do not treat this as deployed. The work is in isolated worktrees and needs QA before staging.

## Worktrees To Inspect

- Backend: `/Users/felipedominguez/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot-home-orchestration-focus`
- iOS: `/Users/felipedominguez/Desktop/Nexus Hub IOS/Nexus Hub-home-orchestration-focus`

Branches are both expected to be `codex/home-orchestration-focus`.

## Implemented Backend Work

Key files changed or added:

- `migrations/136_home_orchestration_focus.sql`
- `src/services/provider-preferences.ts`
- `src/services/focus-blocks.ts`
- `src/services/health-sleep-agenda.ts`
- `src/services/home-day-dial.ts`
- `src/services/runtime-flags.ts`
- `src/services/unified-calendar.ts`
- `src/services/decision-center.ts`
- `src/services/google-calendar.ts`
- `src/services/outlook-calendar.ts`
- `src/api/routes/settings.ts`
- `src/api/routes/calendar.ts`
- `src/api/routes/dashboard.ts`
- `src/api/routes/dashboard-data-fetchers.ts`
- `src/api/routes/dashboard-home-input.ts`
- `src/api/routes/health-data.ts`
- `src/api/routes/notifications.ts`
- `src/api/routes/tasks.ts`
- `__tests__/services/home-orchestration-focus.test.ts`

Expected backend behavior:

- `/api/v1/settings/provider-preferences` supports GET and PATCH for `primaryMailProvider` and `primaryCalendarProvider`.
- Mail preference distinguishes Gmail mail from Outlook mail and does not silently fallback when an explicit disconnected provider is selected.
- Calendar preference distinguishes Google Calendar from Outlook Calendar and does not silently fallback for explicit disconnected providers.
- `POST /api/v1/calendar/events` accepts safe Nexus category metadata and uses the preferred calendar provider when no explicit source is provided.
- `POST /api/v1/calendar/focus-conflict-check` detects agenda overlaps and returns conflict details plus an optional next free slot.
- `POST /api/v1/calendar/focus-blocks` creates Focus or Pomodoro calendar blockers only after conflict checks.
- Pomodoro supports 1-8 focus blocks, with 25-minute focus blocks, 5-minute normal rests, and 15-minute rests after every fourth focus block. Exactly four blocks includes the final 15-minute rest.
- Dashboard can include `featureFlags`, `dayDial`, decision gamification, and faster task snapshot metadata.
- Day dial classifies calendar/scheduled time into Meet, Focus, Train, Eat, Sleep, and Open, and clips Apple Health sleep intervals to the user's local day.
- Apple Health sleep intervals appear in agenda/calendar reads as read-only virtual events with `source: "apple_health"` and `category: "sleep"`.
- Apple Health sleep events are included in dashboard calendar data, `/api/v1/calendar/events`, and `/api/v1/calendar/today` when synced sleep exists.
- Apple Health sleep is agenda occupancy for Focus/Pomodoro conflict prechecks, but the backend does not write sleep into Google/Outlook provider calendars.
- Day dial avoids double-counting sleep when sleep was already injected into the calendar event input.
- Health sync accepts sleep intervals from iOS without requiring Home to perform synchronous HealthKit reads.
- Secretary summary copy should not call a day clear when tasks or calendar truth is degraded/still loading.
- Feature flags are available for `home_day_dial_v1`, `provider_preferences_v1`, `home_focus_pill_v1`, `decision_streak_v1`, and `secretary_orchestration_snapshot_v1`.

## Implemented iOS Work

Key files changed:

- `Nexus Hub/Models/ServerStatus.swift`
- `Nexus Hub/Core/Services/SettingsService.swift`
- `Nexus Hub/Core/Services/CalendarService.swift`
- `Nexus Hub/Core/Repositories/CalendarRepository.swift`
- `Nexus Hub/Core/Services/HealthKitService.swift`
- `Nexus Hub/Core/Services/ReportService.swift`
- `Nexus Hub/ViewModels/DashboardViewModel.swift`
- `Nexus Hub/Models/CalendarEvent.swift`
- `Nexus Hub/Views/Dashboard/DashboardHomePrimarySections.swift`
- `Nexus Hub/Views/Dashboard/DashboardView.swift`
- `Nexus Hub/Views/Settings/ConnectionsView.swift`
- `Nexus HubTests/CalendarEventPresentationTests.swift`
- `Nexus HubTests/ModelDecodingTests.swift`
- `Nexus HubTests/HealthDaySnapshotPayloadTests.swift`
- `Nexus HubTests/NavigationPerformanceSourcePinsTests.swift`
- `scripts/ios-single-simulator-test.sh`

Expected iOS behavior:

- Home shows the 24-hour day dial behind the backend feature flag, with safe fallback to the old hero.
- Sleep is shown when synced sleep is present and honestly unavailable when it is missing.
- Apple Health sleep agenda blocks display as Sleep/Sono with Apple Health source labeling and sleep coloring.
- Apple Health sleep agenda blocks remain read-only in provider event sheets.
- Home shows a horizontal quick-action pill behind the backend feature flag.
- Focus expands inline to Pomo, 30m, 1h, and 2h; other actions collapse to icons.
- New Task opens existing task creation, Decision opens Decision Center, and Ask opens Chat without sending a fake chat command.
- Pomodoro opens a block-count selector and then creates a grouped calendar event through the Calendar repository.
- Focus/Pomodoro conflicts show a user warning instead of silently writing over agenda.
- Calendar success optimistically updates today's calendar cache and refreshes Home/Decision state.
- Settings/Connections exposes provider preferences and clearly distinguishes Gmail mail from Google Calendar agenda.
- New DTOs decode safely and are optional/backward-compatible.
- Home does not synchronously read HealthKit on first paint.

## Validation Already Performed By Codex

Backend:

- `npx vitest run __tests__/services/home-orchestration-focus.test.ts __tests__/api/notifications-routes.test.ts __tests__/api/calendar-routes.test.ts __tests__/api/settings-routes.test.ts` — PASS.
- `npx vitest run __tests__/services/home-orchestration-focus.test.ts __tests__/api/calendar-routes.test.ts __tests__/api/dashboard-routes.test.ts` — PASS after adding Apple Health sleep agenda projection.
- `npx vitest run __tests__/services/home-orchestration-focus.test.ts` — PASS after final coverage additions: 18 tests passed. This now pins dashboard task snapshot reuse and decision streak rollup computation.
- `npm run typecheck` — PASS after the final backend changes.
- `npm run verify` — PASS after the final backend changes: 607 files passed, 9,018 tests passed.
- Earlier security sweep `npx vitest run __tests__/security` — PASS.

iOS:

- `xcodebuild -project "Nexus Hub.xcodeproj" -scheme "Nexus Hub" -sdk iphonesimulator build` — PASS.
- Targeted model/Health payload tests — PASS.
- Targeted calendar presentation/model decoding tests for Apple Health sleep agenda events — PASS.
- Targeted `xcodebuild test` for `ModelDecodingTests` and `CalendarEventPresentationTests` — PASS: 75 selected tests passed.
- Targeted `xcodebuild test` for `NavigationPerformanceSourcePinsTests` — PASS after final source-pin additions: 36 selected tests passed, 0 failures. This pins day dial, quick-action pill, decision streak, direct REST focus/provider paths, and Ask opening Chat without fake commands.
- Full simulator helper `scripts/ios-single-simulator-test.sh` — PASS:
  - app unit target: 1,385 tests executed, 0 failures;
  - Swift Testing suites: 10 tests passed;
  - UI target: 117 tests executed, 15 skipped, 0 failures;
  - xcresult: `/Users/felipedominguez/Library/Developer/Xcode/DerivedData/Nexus_Hub-gwcbksvndidqfycolqideiqitfit/Logs/Test/Test-Nexus Hub-2026.05.17_23-51-02-+0100.xcresult`.
- Mandatory simulator cleanup was run after the full suite; `xcrun simctl list devices booted` showed no booted devices, and a final post-kill process check showed no simulator processes.

Final Codex coverage-gap closure before this QA prompt:

- Added backend assertions that dashboard task summaries paint from the shared working-set snapshot instead of re-fetching a separate slow path.
- Added backend assertions that decision streak gamification is computed from tenant-scoped daily rollups.
- Added iOS source-pin assertions for direct REST Home/Focus/Provider surfaces and Settings provider preference copy.

Docs:

- `cd /Users/felipedominguez/Desktop/Nexus\ Hub/engine && npm run docs:audit` — completed with the existing baseline warning set.

Repository-state note:

- The current backend worktree does not expose the newer `test:changed`, `test:security`, or `test:count` package scripts described in the pipeline-hygiene prompt; Codex used available repo commands instead.
- The current iOS worktree does not contain `scripts/ios-session-test.sh` or `scripts/ios-feature-test-convention-check.sh`; Codex used `ios-single-simulator-test.sh` and direct `xcodebuild` instead.

## Areas To Inspect Carefully

1. Token-Zero and routing:
   - Verify none of the Home quick actions, Focus/Pomodoro writes, provider preferences, or task/dashboard reads use chat or fake chat commands.

2. Provider preferences:
   - Verify Gmail means email only, Google Calendar means calendar writes.
   - Verify explicit unavailable providers warn and guide recovery instead of silently switching providers.
   - Verify `auto` preserves prior behavior.
   - Verify tenant/user scope is respected for all preference reads/writes.

3. Calendar writes and conflicts:
   - Verify Focus and Pomodoro use direct calendar REST paths.
   - Verify conflict prechecks cannot be bypassed accidentally.
   - Verify a provider failure does not produce false success copy.
   - Verify Nexus category metadata is provider-safe and does not leak internal details.

4. Pomodoro math:
   - Verify 1, 2, 4, 5, and 8 block sequences.
   - Verify exactly 4 focus blocks include the final 15-minute rest.
   - Verify interval descriptions match the created event duration.

5. Day dial and sleep:
   - Verify sleep intervals are clipped to the user's local day.
   - Verify synced sleep appears in agenda/calendar surfaces as read-only virtual Apple Health events.
   - Verify sleep agenda blocks are not written into Google or Outlook calendars unless a future explicit opt-in feature is added.
   - Verify Focus/Pomodoro conflict checks count sleep as busy time.
   - Verify overlapping calendar/sleep segments do not create impossible totals.
   - Verify missing Apple Health sleep is shown honestly.
   - Verify Home does not perform a blocking HealthKit read on first paint.

6. Task loading and Secretary orchestration:
   - Verify dashboard, Tasks, and Secretary actually benefit from the shared task snapshot path.
   - Verify stale/degraded task states are surfaced honestly.
   - Verify Secretary no longer reports a clear day while task/provider/calendar truth is degraded.

7. Decision streak:
   - Verify streak rollup and current/best/last-14-days behavior across local timezone boundaries.
   - Verify "at risk" behavior uses decisions left and hours left correctly.
   - Verify migration/idempotence and tenant/user isolation.

8. iOS UI quality:
   - Verify day dial and quick pill fit on smaller iPhones and dynamic type.
   - Verify focus expanded pill behavior matches the reference.
   - Verify provider preferences copy is clear in English and Portuguese paths where applicable.
   - Verify backward-compatible decoding when backend flags/DTOs are absent.

9. Release safety:
   - Verify all new behavior is flag-gated or backward-compatible.
   - Verify rollback can disable Home dial, provider prefs, focus pill, decision streak, and Secretary snapshot behavior independently.

## Edge Cases To Verify

- Google-only user, Outlook-only user, both connected, and neither connected.
- Explicit Gmail mail preference with no Gmail connected.
- Explicit Google Calendar preference with only Gmail mail connected.
- Calendar conflict at the rounded start boundary.
- Pomodoro sequence crossing midnight.
- Sleep interval crossing midnight and clipped to a local day.
- Sleep-only agenda response when no Google/Outlook calendar provider is connected.
- Sleep agenda block tapped in iOS event sheet should not expose edit/delete actions.
- Duplicate quick taps on Focus/Pomodoro.
- Provider 401/403/5xx during conflict check or write.
- Existing calendar event already categorized as training/focus/meal.
- Task snapshot cache stale while task provider is degraded.
- Decision queue reaches zero just before and just after local midnight.

## Known Risks And Assumptions

- Live staging/provider validation was not performed in this Codex turn.
- Real Apple Health/HealthKit behavior still requires device/TestFlight validation.
- The implementation assumes the current migrations runner can apply migration 136 in this worktree without colliding with other active branches; verify numbering against main before merge.
- The iOS script change in `scripts/ios-single-simulator-test.sh` is intended to preserve behavior while satisfying an existing release-hardening test; verify it does not alter CI invocation semantics.
- The backend task snapshot speedup is partly architectural reuse and cache seeding; measure Home/Tasks latency on staging before claiming a production percentage gain.

## Required QA Output

Produce one of:

- PASS
- PASS WITH MINOR ISSUES
- PARTIAL
- FAIL
- NOT VERIFIED

Lead with blocking findings first. For every finding, include file path, line or symbol when possible, why it matters, and a recommended fix. Also state which validation commands you ran and which you could not run.
