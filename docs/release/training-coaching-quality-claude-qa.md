# Training Coaching Quality + Delivery — Claude Hostile QA

**Date**: 2026-05-13
**Engine**: `/Users/felipedominguez/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot` — branch `main` @ `ed545867`, dirty working tree
**iOS**: `/Users/felipedominguez/Desktop/Nexus Hub IOS/Nexus Hub` — branch `main` @ `666a19e`, dirty working tree
**Simulator**: iPhone 17 Pro, iOS 26.4.1 (`A0B13967-B5DE-4E6F-897D-F1E409093F94`)
**xcresult**: `/tmp/training-qa/training-qa.xcresult`

## Verdict

**GO_WITH_CONDITIONS.**

13 of 15 scope items source-verified at the cited file:line. All 8
hostile probes return the expected result. Backend `tsc` clean. Backend
focused vitest sweep **117/117 across 8 files**. iOS xcresult
**53 passed / 0 failed / 0 skipped** including the
`test_saturdayConflictFixtureShowsPreferredTimeConflict` UI test.
`npm run docs:audit` exit 0.

Two findings before merge:

- **P1 — Coach report sanitizer leaks `[DEBUG]` tags and provider errors.**
  The spec lists 7 leak categories the sanitizer must block; the
  implementation blocks 5 (raw markers, event IDs, recommendation
  boilerplate, timing traces, JSON fragments, long hashes). `[DEBUG]`-style
  bracketed debug tags and provider-error patterns (e.g.,
  `Google API: 503`, `Garmin timeout`) are not filtered.
  File: `src/api/routes/training-coach-briefing.ts:45-66`.
  Test gap: `__tests__/api/training-coach-briefing.test.ts:76-94`
  doesn't pin either category.

- **P2 — `coach-rules` registry is dormant.** The registry exists at
  `src/services/coach-kernel/coach-rules.ts` with 9 research-cited rules
  across 8 categories. `__tests__/services/coach-rules.test.ts` is the
  ONLY importer (verified via `grep -rn "from.*coach-rules" src/ __tests__/`).
  No production code path (plan linter, planner-engine, decision-making)
  consumes the registry. The rules are documentation, not enforcement.
  This still satisfies scope item 1 ("research-backed coach rules registry
  exists in the coach-kernel path, not a parallel v2 stack") — the registry
  IS in the coach-kernel path and IS research-backed. But the implied
  behavior contract is weaker than the wording suggests.

Both findings are mechanical fixes; neither blocks the broader behavior
contract the closure was designed to deliver.

## Conditions before merge

1. **(P1)** Extend `sanitizeTrainingCoachReportText` with two more denylist
   patterns:
   - Bracketed debug tags: `/\[(DEBUG|TRACE|VERBOSE|INFO|WARN|ERROR)\]/i`
   - Provider errors: `/\b(Google|Outlook|Garmin|Apple)[\s_-]?(API|Calendar|Health)?\s*[:]\s*\d{3}\b/i` (or equivalent).
   Add a test case per category in `__tests__/api/training-coach-briefing.test.ts`.

2. **(P2)** Either:
   - **(a)** Wire `listTrainingCoachRules()` into the plan linter or
     plan-generation guardrail layer so at least one rule has an
     observable runtime effect. Pin via an integration test.
   - **(b)** Move the registry to `src/services/coach-kernel/docs/` with
     a README that explicitly documents it as a "policy reference, not
     a runtime gate," to avoid future ambiguity.

3. **Commit the dirty state.** 11 modified + 5 untracked files are
   sitting uncommitted on engine `main`. iOS has 11 modified files. Two
   focused commits per side (one for the closure code, one for tests)
   should be enough.

## Per-area verification table

| # | Item | Verdict | Evidence |
|---|---|---|---|
| 1 | Coach rules registry in coach-kernel (not v2) | **PASS** (P2 dormant) | `src/services/coach-kernel/coach-rules.ts:22-100` exports `TRAINING_COACH_RULES` (9 rules, 8 categories) + `listTrainingCoachRules()`. **No production importer** (only `__tests__/services/coach-rules.test.ts:3`). |
| 2 | Plan preview non-mutating | **PASS** | `src/api/routes/training-plan-routes.ts:45-127` POST `/plan/preview` sets `previewOnly: true`; `src/api/routes/training-plan-generation.ts:531-560` short-circuits to `{ status: 'preview', data: {…} }` before any DB write or idempotency claim. |
| 3 | Confirmed gen uses preview/confirm + atomic | **PASS** | `src/api/routes/training-plan-routes.ts:145-352` POST `/plan/generate` claims idempotency at `:213` BEFORE cost guardrail; saga at `src/api/routes/training-plan-generation.ts:603-640` runs cancellation BEFORE persist, aborts on `local_delete_failed` — no half-baked plans. |
| 4 | Race date not falsely blocked when supplied | **PASS** | `src/services/training-coach-kernel-plan-generator.ts:1985-1995` emits `event_based_missing_race_date` only when `raceCalendar.length === 0`; `:276` populates raceCalendar from `input.raceDate`. Pinned by `__tests__/services/training-coach-kernel-plan-generator.test.ts:176-205`. |
| 5 | Phase roadmap not all-deload unless warranted | **PASS** | `src/services/coach-kernel/planner-engine.ts:60-77` `inferPhase()`: deload only on `red` readiness, high-impact injury, or `weekIndex % 4 === 0`; orange returns `maintenance`; race-window inputs bypass cadence. |
| 6 | Volume/day count/two-a-day respected | **PASS** | `src/services/training-plan-volume-enforcement.ts:29-79` clamps + enforces exact `sessionsPerWeek` and `strengthSessionsPerWeek`; `:65` `spreadSameTypeCollisions` permits two-a-days when target requires; pinned by `__tests__/services/training-plan-volume-enforcement.test.ts:22-146` (6 tests). |
| 7 | Calendar source honored, no silent fallback | **PASS** | `src/services/training-calendar-source.ts:30-52` validates source, returns 409 on unconfigured (no fallback); `:55-82` `resolveTrainingCalendarSource` is deterministic; `src/api/routes/training-plan-calendar-sync.ts:655-671` propagates the resolved source through reads + writes. |
| 8 | Per-session sync truth in response | **PASS** | `src/api/routes/training-plan-calendar-sync.ts:72-83` `TrainingCalendarSessionSyncResult` carries per-session `provider`, `eventId`, `status` enum, `reason`, `retryable`, `start`, `end`. Builder at `:1135-1158`. |
| 9 | Reflow preview shows destination before mutation | **PASS** | `src/api/routes/training-plan-routes.ts:415-453` POST `/sessions/:id/reflow-preview` → `src/api/routes/training-plan-calendar-sync.ts:294-417` returns `proposed`, `whyThisSlot`, `whatThisProtects`, `tradeoffs`, `reasonCodes`, `confidence`. No write, no idempotency consumed. |
| 10 | Reflow confirm mutates only after preview + read-back | **PASS** | `src/api/routes/training-plan-routes.ts:455-511` → `src/api/routes/training-plan-calendar-sync.ts:419-527`: calls preview first at `:426`, writes provider event at `:461-477`, reads back via `trainingPlans.getSessionById` at `:488` and verifies `day_of_week`/`status`/`calendar_event_id` at `:489-494`, returns verified `eventId`. |
| 11 | Coach report structured + sanitized (7 categories) | **PASS WITH GAP** | `src/api/routes/training-coach-briefing.ts:45-66`: 5/7 categories blocked. `[DEBUG]` tags + provider errors NOT blocked. **P1**. |
| 12 | iOS preview card renders roadmap/provider/session count | **PASS** | `Nexus Hub/ViewModels/TrainingViewModel.swift:402-414` populates `planGenerationPreview`; `:735-754` `planPreviewReadySummary()` renders `result.totalSessions`, `result.phaseRoadmap`, `result.calendarSource` via `localizedCalendarProvider()`. |
| 13 | Create dismisses sheet + refreshes surfaces | **PASS** | `Nexus Hub/ViewModels/TrainingViewModel.swift:492-621`: `didGeneratePlan = true` at `:493` triggers sheet dismissal; `:620-621` calls `repository.loadAll(forceRefresh: true)` + `repository.loadHome(forceRefresh: true)`. Pinned by `Nexus HubTests/TrainingViewModelObservationTests.swift:154-180`. |
| 14 | Conflict UI exposes 4 real actions | **PASS** | `Nexus Hub/Views/Training/WeeklyPlanComponents.swift:457-474` renders chip with id `weekly-plan-preferred-time-unavailable-chip`. Actions in `WeeklyPlanView.swift`: `:970-992` move-to-slot (`onConfirmSessionReflow`), `:998` choose-another-time (`showManualReflowPicker`), `:1043` keep-as-is, `:1060` ask-Nexus (route to Inbox). All four present, tappable. |
| 15 | Idempotency coverage (no duplicate on retry) | **PASS** | `migrations/127_training_plan_generation_idempotency.sql:7-17` PRIMARY KEY `(user_id, idempotency_key)` + `request_hash` column. `src/services/training-plan-generation-idempotency.ts:41-130` claim/complete/fail with tenant scoping. Route at `:213-237` short-circuits on `replay` (200), `in_progress` (409), `conflict` (409). Pinned by `__tests__/api/training-routes.test.ts:1247-1296` (replay) + `:1298-1320` (conflict). |

## Hostile probe results (8/8 PASS)

| # | Probe | Result | Evidence |
|---|---|---|---|
| 1 | Same `idempotencyKey` + same payload → only one plan/session/event | ✓ PASS | `__tests__/api/training-routes.test.ts:1247-1296` — second call returns cached `data`; plan/session/event create called once (asserted at `:1293-1295`). |
| 2 | Same `idempotencyKey` + different payload → 409, no duplicate | ✓ PASS | `__tests__/api/training-routes.test.ts:1298-1320` — second call returns 409 `IDEMPOTENCY_KEY_REUSED`; plan create called once (`:1319`). |
| 3 | Preview route does not claim/consume idempotency | ✓ PASS | `src/api/routes/training-plan-routes.ts:45-127` — no call to `claimTrainingPlanGenerationIdempotency` in preview handler. |
| 4 | Generation without `idempotencyKey` is backward-compatible | ✓ PASS | `src/services/training-plan-generation-idempotency.ts:41-46` — `claimTrainingPlanGenerationIdempotency` returns `{ kind: 'not_requested' }` when key is null. Route at `:213-237` only short-circuits on `replay`/`in_progress`/`conflict`; `not_requested` falls through to normal generation. |
| 5 | No raw coach report fragments leak into iOS formatted sections | ✓ PASS | `Nexus Hub/Core/CoachBriefingFormatter.swift:105-132` `redactedOperationalNoise()` strips timestamps + telemetry; `:274-293` `isUnsafeCoachReportLine()` strips raw markers, long hashes, JSON. Pinned by `Nexus HubTests/CoachBriefingFormatterTests.swift:127` `test_format_removesCoachReportMarkersIdsAndRecommendationLegend` + `:102` timestamp test. |
| 6 | Outlook-selected gen cannot create Google events | ✓ PASS | `src/services/training-calendar-source.ts:55-82` deterministic resolver — `:61-62` if `requestedSource` is connected use it, else fall to plan pref/linked source/first available; **never** silently picks the "other" provider; returns undefined → 409 if none. |
| 7 | Reflow cannot move without first returning destination/tradeoff | ✓ PASS | `src/api/routes/training-plan-calendar-sync.ts:419-527` `confirmTrainingSessionReflow` calls `previewTrainingSessionReflow` at `:426` first, then extracts proposed times from payload OR preview at `:429-430`. No reflow mutation path bypasses preview output. |
| 8 | No duplicate Training v2 stack / DTO family | ✓ PASS | `find src/ -name "*v2*" -o -name "*V2*" | grep -i train` returns nothing. `grep -rn "TrainingV2|trainingV2|training_v2|TrainingPlanV2"` returns nothing. 17 training route files + 21 training service files are all canonical primary stack. `training-plan-routes.ts` is additive registration; imports from `training-plan-generation.ts` (not duplicating it). |

## Test counts

| Suite | Files | Passed | Failed | Skipped |
|---|---|---|---|---|
| Engine focused vitest | 20 | 199 | 0 | 0 (prior closeout) |
| Engine training scope | 8 | **117** | 0 | 0 |
| iOS (this run) | 5 targets | **53** | 0 | 0 |
| `npm run docs:audit` | n/a | exit 0 | — | — |
| `npx tsc --noEmit` | n/a | exit 0 | — | — |

xcresult bundle: `/tmp/training-qa/training-qa.xcresult` (iPhone 17 Pro,
iOS 26.4.1, 24.38s test duration).

## P0 / P1 / P2 findings

### P1 — Coach report sanitizer leaks 2 of 7 declared categories

**File**: `src/api/routes/training-coach-briefing.ts:45-66`
**Missing**: `[DEBUG]`/`[TRACE]`/`[INFO]`/`[WARN]`/`[ERROR]` bracketed
debug tags, and provider error patterns (`Google API: 503`,
`Garmin timeout`, etc.).
**Test gap**: `__tests__/api/training-coach-briefing.test.ts:76-94`
asserts 5 categories; misses these 2.
**Fix size**: ~5 lines (two regex entries in the denylist), ~30 lines
of test cases.

### P2 — `coach-rules` registry has no production importer

**File**: `src/services/coach-kernel/coach-rules.ts:22-100`
**Effect**: 9 research-cited rules exist as TypeScript constants but
never gate plan generation. `__tests__/services/coach-rules.test.ts`
is the only consumer (asserts shape, not enforcement).
**Risk**: future contributor reads the registry, assumes plan output
respects it, breaks expected behavior unnoticed.
**Fix options**:
 - **Wire**: import `listTrainingCoachRules` into `training-plan-generation.ts`
   guardrail layer; add at least one runtime check (e.g., the
   "strength-progressive-overload-with-deloads" rule could observe
   `weekIndex` and block plans that violate the 4-week deload cadence).
 - **Reframe**: relocate to `src/services/coach-kernel/docs/` with a
   README header making the documentation-only intent explicit.

### P3 — Backend coach-rules test exercises 1 case only

`__tests__/services/coach-rules.test.ts:6-22` is a single test asserting
category coverage, rule citation presence, and ACSM anchor. If the
registry stays dormant, this is sufficient. If the registry becomes
enforcing (P2 option a), the test surface needs to grow.

## Cross-stream coordination

**Codex-untouched (Wave 1 isolation list)**: not applicable here —
Training Coaching scope intentionally overlaps with the chat-logic lane
(Codex's territory). Specifically, this work touches
`src/services/training-coach-kernel-plan-generator.ts` and the new
`training-plan-routes.ts`, which is the canonical Training-side surface;
the Wave 1 closure pass already established `secretary-fastpath.ts` +
`chat-message-*.ts` + `chat-*.ts` + `tool-executor.ts` as Codex-owned, and
**this audit confirms none of those files are modified in the dirty
state**:

```
% git status --short | grep -E "secretary-fastpath|chat-message-|chat-(answer|grounding|response|skill)-|tool-executor"
(no output — no Codex-lane file modified)
```

## Cleanup confirmation

- iOS xcscheme/project drift preserved: `Nexus Hub.xcodeproj/project.pbxproj`
  and `Nexus Hub.xcodeproj/xcshareddata/xcschemes/Nexus Hub.xcscheme` were
  modified before this run; not touched by QA. (Re-verified by `git status`.)
- `docs/agents/` directory preserved (untracked, not touched).
- Engine smoke-evidence preserved: `docs/release/smoke-evidence/staging-smoke-ed545867-20260513T192035Z.json` (untracked, not touched).
- No production data accessed. No real APNs send. No TestFlight cut. No
  push to remote. Tests ran against `:memory:` SQLite (engine) and
  `iPhone 17 Pro` simulator (iOS).

## Mergeability

Ready to land **after** the 2 conditions above. The closure pass is
behavior-complete for the scope it set; the 2 findings are mechanical
fixes that don't require rework.

## Hand-off recommendation

**Ship with conditions.** Apply the P1 fix (~10min), choose either P2
option (~30min for wire, ~5min for reframe), commit the dirty state in
2-3 focused commits per repo, then rebase against `origin/main` and push.

---

Generated 2026-05-13 by Claude Opus 4.7 (max effort) on engine `main`
@ `ed545867` and iOS `main` @ `666a19e`.
