# Training expert coach - Codex independent validation

Date: 2026-05-03
Branch: `feature/training-expert-coach-codex-validation`
Scope: second-pass validation of Claude Code's Training expert-coach knowledge-engine pass. Local validation only. No push, no deploy, no production calendars.

## Executive summary

- verdict: PASS WITH CONDITIONS
- Claude report confidence: MEDIUM-HIGH for backend code and tests, LOW for iOS workflow coverage.
- biggest verified fixes: Claude's past-day floor, plan-linter, calendar degraded warning, session-load metadata, athlete lifecycle derivation, and safety guardrails are real and test-backed.
- biggest missed issue: same-day sessions could still schedule earlier than the plan creation time. Codex fixed this with a `notBefore` floor in the scheduler and persistence/calendar sync callers.
- second missed issue: the linter's exact-date rules were only reliable in direct tests. Persistence claimed to backfill scheduled dates but left them undefined. Codex now pairs persisted calendar event starts back into lint sessions.
- latest request-contract closure: the app-facing Training generation route now accepts safe allowlisted `goalMode`, `trainingPriority`, and request `raceDate`; the coach-kernel honors them, the generated plan persists them in preferences, and the response echoes them for iOS verification.
- Training readiness: backend is ready for local QA and staging review after approval; not ready for unconditional closed-beta until iOS creation workflows and linter-strict behavior are closed.

## Evidence review

| Claude claim | Status | Evidence level | Notes |
| --- | --- | --- | --- |
| Week-1 past weekdays no longer silently slide forward | VERIFIED | E3 | `training-plan-persistence.test.ts` covers Monday/Tuesday generated on Wednesday. |
| Plan-linter exists and catches unsafe plans | VERIFIED WITH CONDITION | E3/E4 | It catches blockers and local API returns `planLint.status:"fail"`, but the plan is still created in advisor mode. |
| Calendar fetch degraded state is surfaced | VERIFIED | E3 | `training-plan-generation.test.ts` covers degraded warnings. |
| SessionLoadMetadata exists | VERIFIED | E2 | Focused tests cover derived load scores and spacing compatibility. |
| Athlete lifecycle state exists | VERIFIED | E2 | Focused tests cover 11 state outputs. |
| Safety/referral guardrails exist | VERIFIED | E2 | Focused tests cover pain, fatigue, diagnosis, supplement, and under-fueling boundaries. |
| iOS Training workflows are validated | PARTIAL AFTER IOS FIX | E5 partial | Physical-device fixture suite now passes, including create-plan CTA/goal-mode/priority controls and tab-stress. Full backend-generated A-I workflows remain blocked. |
| Full backend regression had one known failing prompt-cleanliness test | REFUTED AFTER FIX | E3 | Codex fixed the archived prompt assertion; full Vitest now passes. |

## Architecture verification

- athlete state machine: partial. `src/services/coach-kernel/athlete-lifecycle-state.ts` derives typed states, but it is not persisted as a long-term athlete-state table.
- modality profile: partial. Profile builders exist and tests cover missing race date and equipment parsing, but there is no unified persisted modality profile aggregate.
- roadmap/block/ledger: missing for long-term continuity. Multi-block `TrainingRoadmap` and `TrainingProgressLedger` remain P3/P2 design work depending on release target.
- continuous planning: partial. Current generation is still block-oriented; no-event continuous roadmaps need follow-up.
- capacity budget: partial. Capacity reconciliation exists; no single persisted `CapacityBudget` object.
- goal priority: partial. Primary focus and weekly targets exist; explicit `GoalPriorityResolver` object is not complete. The app-facing request contract now accepts `trainingPriority` and forwards it to coach-kernel priority resolution.
- session load metadata: exists and tested.
- linter: exists, tested, and now receives persisted scheduled dates.
- decision log: partial through decision reasons and logger output; not a complete durable `CoachDecisionLog`.
- repair/versioning: partial. Advisor-mode linter suggests fixes but does not repair or block invalid plans.
- catalog/config: exists through coach-kernel knowledge templates and tests.
- safety/referral: exists and tested, but not yet wired everywhere in iOS copy.

## Backend tests

Commands run:

- `npx vitest run __tests__/api/training-schedule-utils.test.ts __tests__/api/training-plan-persistence.test.ts __tests__/services/coach-kernel-plan-linter.test.ts --reporter=default` - passed.
- `npx tsc --noEmit` - passed.
- `npx vitest run __tests__/services/coach-kernel-*.test.ts __tests__/api/training-*.test.ts --reporter=default` - 39 files / 474 tests passed.
- `npx vitest run __tests__/services/prompt-cleanliness.test.ts --reporter=default` - 72 tests passed after the archived-prompt assertion fix.
- `npx vitest run --reporter=default` - 437 files / 6645 tests passed.
- `npx vitest run __tests__/api/training-plan-generation.test.ts __tests__/services/training-coach-kernel-plan-generator.test.ts __tests__/services/coach-kernel-athlete-lifecycle-state.test.ts __tests__/services/training-coach-kernel-weekly-targets.test.ts __tests__/api/training-plan-persistence.test.ts --reporter=default` - 74 tests passed after the goal-mode / priority / race-date request contract change.

## iOS workflows

Simulator: iPhone 17 Pro, iOS 26.4.1, UDID `A0B13967-B5DE-4E6F-897D-F1E409093F94`.

| Workflow | Status | Evidence |
| --- | --- | --- |
| A advanced hybrid stress case | BLOCKED | Existing UI tests do not drive the full questionnaire/generation flow. Backend API smoke produced a lint fail for the unsafe hybrid plan. |
| B beginner no-equipment | BLOCKED | Backend tests cover equipment compatibility; iOS creation flow not driven. |
| C mid-week creation | BACKEND PASS, IOS BLOCKED | Backend tests cover past weekdays and same-day past time. |
| D missing marathon date | PARTIAL | Unit tests cover profile prompt. Local sandbox user likely had profile state, so direct API did not reproduce missing-date path. |
| E Saturday unavailable | BLOCKED | Requires calendar fixture with Saturday unavailable. |
| F feedback adaptation | BACKEND PARTIAL, IOS BLOCKED | Coach adaptation tests exist; iOS feedback flow not driven. |
| G account/tenant isolation | BACKEND PASS, IOS BLOCKED | Broader user-isolation tests pass; iOS account switch was not driven in this pass. |
| H continuous no-event plan | PARTIAL | No durable roadmap/ledger yet. |
| I event added later | BLOCKED | Needs roadmap/ledger follow-up. |

Targeted UI test:

- Initial `xcodebuild test ... -only-testing:"Nexus HubUITests/TrainingFixtureBypassUITests"` executed 4 tests with 1 failure: `training-action-createPlan` did not render.
- iOS follow-up fixed the CTA identifier path, added goal-mode / priority controls, and reran the full physical-device fixture suite.
- Current result: physical iPhone `TrainingFixtureBypassUITests` passed 11/11 in 272.852 seconds.

## Plan linter stress test

Covered invalid scenarios:

- equipment violation for bodyweight user with barbell session - fail.
- taper/race-week label without race date - warning.
- 3 consecutive leg-heavy days - warning.
- heavy lower-body before long run - blocker.
- heavy lower-body on Sunday before Monday long run when real persisted dates are present - blocker after Codex fix.

Remaining gap:

- The API still persists plans with `planLint.status:"fail"` in advisor mode. This is honest but not strict. Before closed beta, either flip blockers to strict/repair or accept the risk explicitly with iOS banners.

## Continuous roadmap validation

- no-event: partial. Existing block plans do not yet become a durable continuous roadmap.
- block rollover: not verified through a durable ledger.
- event added later: not verified.
- deload/review: derivation exists, but not a full continuous roadmap.
- focus rotation: partial in templates/tests.
- progression ceiling: partial.

## Secretary/calendar validation

- scheduling intent: verified statically and through persistence tests using `submitSecretarySchedulingIntent` mock.
- schedule result: reflected for scheduled/unscheduled/reflowed states in tests.
- sync state: partial. Calendar sync tests pass; provider-live smoke not run.
- duplicates: covered by existing calendar lifecycle tests.
- cleanup: covered by cancellation/reconciliation tests.
- local engine smoke: 13 authenticated iOS API checks passed, including Training summary and Training today.

## Runtime performance

- Local engine started in fixture/provider-safe mode with `NEXUS_LOCAL_ALLOW_MODEL_CALLS=0`.
- `scripts/full-nexus-local-engine.sh smoke` passed 13 authenticated checks.
- Direct generation API smoke showed `planLint.status:"fail"` for the unsafe 5-strength marathon hybrid scenario, proving lint metadata surfaces to iOS without provider calls.
- Simple smoke did not show model/provider calls during reads.
- App-facing generation now accepts `goalMode`, `trainingPriority`, and request `raceDate` without adding provider/model calls to read paths.

## New findings

### P1

- **TR-CV-1: same-day past time floor missing.**
  - file: `src/api/routes/training-schedule-utils.ts`
  - impact: creating a plan at 15:15 could schedule today's 07:00 session in the past.
  - status: fixed and tested.

- **TR-CV-2: persisted linter sessions lacked scheduled dates.**
  - file: `src/api/routes/training-plan-persistence.ts`
  - impact: exact-date linter rules worked in pure tests but not reliably in real persistence.
  - status: fixed and tested.

- **TR-CV-3: linter blockers remain advisor-only.**
  - file: `src/api/routes/training-plan-generation.ts`
  - impact: unsafe plans can still be created with fail metadata. This is transparent but not a hard gate.
  - status: open. Needs strict/repair design.

- **TR-CV-4: iOS no-plan fixture create-plan CTA missing.**
  - file: `Nexus HubUITests/TrainingFixtureBypassUITests.swift`
  - impact: current XCUITest cannot validate 5-strength creation UI.
  - status: fixed in the iOS validation branch; physical iPhone `TrainingFixtureBypassUITests` now passes 11/11.

### P2

- **TR-CV-5: archived prompt cleanliness test was stale.**
  - file: `__tests__/services/prompt-cleanliness.test.ts`
  - impact: full backend suite failed on an intentionally archived prompt.
  - status: fixed.

- **TR-CV-6: app request intent was incomplete for expert-coach planning.**
  - file: `src/api/routes/training-plan-generation.ts`, `src/services/training-coach-kernel-plan-generator.ts`
  - impact: iOS could not explicitly request continuous/event/maintenance/return-to-training modes or priority; an app-supplied race date could also be ignored unless already present in the stored running profile.
  - status: fixed and tested.

## Fixes implemented

1. Same-day scheduling floor:
   - files: `src/api/routes/training-schedule-utils.ts`, `src/api/routes/training-plan-persistence.ts`, `src/api/routes/training-plan-calendar-sync.ts`
   - root cause: `scheduleSessionWindow` only checked busy windows, not whether the candidate start was before the plan/sync clock.
   - tests: `training-schedule-utils.test.ts`, `training-plan-persistence.test.ts`, broad Training suite, full Vitest.

2. Persisted linter date bridge:
   - files: `src/api/routes/training-plan-persistence.ts`
   - root cause: comment promised scheduled-date backfill, but code left `scheduledDate` undefined.
   - tests: persistence-level Sunday-before-Monday long-run blocker.

3. Archived prompt-cleanliness assertion:
   - file: `__tests__/services/prompt-cleanliness.test.ts`
   - root cause: test still read `prompts/daily-content-discovery.md` after the stale prompt was archived.
   - tests: prompt-cleanliness focused suite and full Vitest.

4. App-facing goal mode / priority / race-date intent:
   - files: `src/api/routes/training-plan-generation.ts`, `src/services/training-coach-kernel-plan-generator.ts`, `src/services/coach-kernel/types.ts`
   - root cause: expert-coach inputs existed in planning concepts but were not part of the app generation request contract; request `raceDate` was not threaded into the normalized running profile used by the kernel and linter.
   - tests: `training-plan-generation.test.ts` and `training-coach-kernel-plan-generator.test.ts` cover valid forwarding, invalid-value dropping, race-date profile injection, and maintenance/return mode priority marking.

## Cleanup status

- local backend: stopped.
- content engine: not running.
- simulator: shut down.
- ports: `8200` and `8326` clear after cleanup.
- processes: no Nexus backend or local-engine process left running; pre-existing Outlook connector processes were not touched.

## Final recommendation

READY_WITH_CONDITIONS

Backend local QA is strong enough for staging-review preparation after owner approval. Do not call Training fully closed-beta ready yet because:

1. iOS creation workflow A-I was not validated end to end.
2. full backend-generated iOS Training workflows A-I still need local full-engine/provider-safe validation.
3. plan-linter blockers are still advisor-only, so invalid plans can be created as transparent-but-not-blocked failures.
4. continuous roadmap/ledger is still incomplete.

## Next actions

1. Decide strict/repair behavior for `planLint.status:"fail"` before closed beta.
2. Add a local full-engine Training plan creation smoke with seeded advanced hybrid and beginner no-equipment users.
3. Add continuous no-event roadmap/ledger or explicitly scope it out of beta.
4. Run physical-device TestFlight Training workflows once local full-engine fixtures are available.
