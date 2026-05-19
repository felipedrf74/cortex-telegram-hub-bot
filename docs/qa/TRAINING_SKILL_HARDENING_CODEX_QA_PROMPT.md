# Training Skill Hardening — Claude Code QA Prompt

You are Claude Code performing independent hostile QA on Codex's Training Skill hardening work.

## Worktrees

- Backend:
  - `/Users/felipedominguez/Desktop/Nexus Hub/worktrees/training-skill-hardening-codex-20260519`
  - Branch: `feature/training-skill-hardening-codex-20260519`
- iOS:
  - `/Users/felipedominguez/Desktop/Nexus Hub IOS/worktrees/training-skill-ui-codex-20260519`
  - Branch: `feature/training-skill-ui-codex-20260519`

Do not inspect or mutate Claude's other worktrees. These changes are intentionally uncommitted.

## Original Goal

Implement the merged Training Skill hardening plan without creating `CoachKernelV2`, `TrainingCoachKernelV2`, or any parallel V2 Training service path. The existing Training architecture remains the source of truth.

The work should improve plan creation reliability, quality gates, readiness transparency, calendar/window safety, duplicate-create prevention, conflict-time UX, fixture coverage, and iOS Training preview UX while preserving the Token-Zero rule: operational Training flows remain REST/repository based and must not be routed through fake chat commands.

## What Codex Implemented

### Backend

1. Extended the existing plan linter in place:
   - Added `week_one_has_active_training`.
   - Added `no_sessions_outside_plan_window`.
   - Added `session_prescription_completeness`.
   - Added `durationWeeks` and session `description` inputs so the quality gate can catch hidden Week 5 leakage and non-executable session labels.

2. Threaded quality-gate inputs through persistence:
   - `training-plan-persistence.ts` now maps generated session descriptions into lint sessions.
   - Strict preflight receives `durationWeeks` before persistence/cancellation can proceed.

3. Added honest readiness confidence metadata:
   - Existing `ReadinessSnapshot` now supports `confidence`, `dataSource`, `isStale`, and `reasonCode`.
   - Coach-kernel plan generation preserves `fresh_wearable`, `stale_provider`, `manual_check_in`, or `no_data`.
   - Read models expose no-wearable fallback as `confidence: "no_data"` instead of pretending fresh readiness.
   - Manual check-in confidence is pinned so it cannot be silently upgraded into wearable truth.

4. Pinned phase behavior in the existing coach kernel:
   - Continuous/no-end-date plans use rolling base/build/deload behavior and do not fake taper.
   - Event/race-date plans derive base/build/peak/taper/race phases from the actual race date.
   - Route comments now describe the deterministic REST coach-kernel path instead of the stale "one Gemini call" narrative.

5. Added a Token-Zero source contract:
   - New source test confirms the operational plan-generation route uses `buildCoachKernelTrainingPlan` and has no direct Gemini/OpenAI/LLM/api_usage scheduling path.
   - Normal deterministic plan creation should not create a training-plan `api_usage` row.

6. Expanded Training semantic fixtures:
   - Added no-wearable, stale-provider, Week 1 empty, hidden Week 5, cancellation cleanup, and duplicate preview/create fixtures.
   - The fixture corpus pins requested surfaces across Training, Secretary, Cooking, Decision Center, privacy, and iOS create idempotency.

7. Added Training hardening source-contract tests for architecture claims that are intentionally served by existing services:
   - Durable coach-kernel knowledge stays in reusable templates/docs, not prompt-only logic.
   - LLM remains an orchestrator for explanation/synthesis and is forbidden from inventing prescriptions or bypassing guardrails.
   - Feedback/adaptation loops remain deterministic through `analyzeTrainingFeedback`, `applyFeedbackToAthleteState`, `applyFeedbackToWeeklyPlan`, and decision-reason propagation.
   - Cross-skill orchestration remains explicit through Training-scoped signals for Secretary/calendar, Cooking/fueling, Finance/budget, adherence, and plan drift.
   - The plan-generation route keeps cost guardrails around any future AI explanation/fallback path while the scheduling path remains deterministic and does not write `api_usage`.
   - No Training V2 / CoachKernelV2 naming pollution was introduced.

8. Closed the feasible LLM-cost attribution gap:
   - `generateCoachBriefing` now passes `{ userId, tenantId }` to Gemini-first `completeOneShotWithFallback` and Anthropic fallback `trackedCreate`.
   - The user/tenant metering contract is pinned by `garmin-coach-user-scope.test.ts`.
   - Plan creation and adaptation remain deterministic zero-provider-cost paths; coach explanation is the metered Training AI surface under the existing `coach_analysis` category.

### iOS

1. Added preview/create duplicate protection:
   - Stable deterministic idempotency key derived from preview fingerprint via SHA256.
   - Repeated create from the same preview uses the same `ios-training-plan-*` key.
   - Added explicit `Edit inputs` and `Discard` actions to the preview-ready card.
   - Create remains disabled while `viewModel.isGeneratingPlan`.

2. Fixed conflict-time formatting and action language:
   - Added `TrainingReflowTimeFormatter` to parse normal ISO, long-fraction ISO, and offset timestamps.
   - `WeeklyPlanView` uses the formatter instead of falling back to raw `window.start`.
   - Invalid dates and offset timestamps fall back or format cleanly without raw provider payloads.
   - Conflict actions now use user-facing approved language: `Find next available`, `Move to next available`, `Choose another slot`, `Keep unscheduled`, `Move to selected slot`.

3. Pinned cancellation UX contracts:
   - Existing cancellation progress overlay remains wired.
   - Tests now pin `Removing calendar blocks`, `Deleting sessions and calendar blocks`, and the cancel button identifier.

4. Added iOS tests:
   - Source-pin test for preview duplicate prevention.
   - Source-pin test for friendly conflict/reflow formatter wiring.
   - Source-pin test for approved conflict action language.
   - Source-pin test for cancellation cleanup progress contracts.
   - Formatter tests proving fractional, offset, and invalid date strings do not leak to UI.

## Files Changed

### Backend

- `src/services/coach-kernel/plan-linter.ts`
- `src/services/coach-kernel/types.ts`
- `src/services/coach-kernel/readiness-snapshot-adapter.ts`
- `src/services/training-coach-kernel-plan-generator.ts`
- `src/services/garmin-coach.ts`
- `src/api/routes/training-plan-persistence.ts`
- `src/api/routes/training-plan-routes.ts`
- `src/api/routes/training-read-models.ts`
- `__tests__/services/coach-kernel-plan-linter.test.ts`
- `__tests__/services/training-coach-kernel-plan-generator.test.ts`
- `__tests__/services/garmin-coach-user-scope.test.ts`
- `__tests__/api/training-plan-generation-source-contract.test.ts`
- `__tests__/services/training-skill-hardening-source-contract.test.ts`
- `__tests__/api/training-read-models.test.ts`
- `__tests__/fixtures/training/semantic-fixtures.ts`
- `__tests__/services/training-semantic-fixtures.test.ts`
- `docs/qa/TRAINING_SKILL_HARDENING_CODEX_QA_PROMPT.md`

### iOS

- `Nexus Hub/Views/Training/TrainingView.swift`
- `Nexus Hub/Views/Training/WeeklyPlanView.swift`
- `Nexus Hub/Views/Training/TrainingReflowTimeFormatter.swift`
- `Nexus HubTests/TrainingUIRevampSourcePinsTests.swift`
- `Nexus HubTests/TrainingReflowTimeFormatterTests.swift`

## Expected Behavior

### Backend

- A generated plan cannot pass pre-save quality gate when:
  - Week 1 has no active training while later weeks have work.
  - A 4-week plan includes a Week 5 session or an active date outside the plan window.
- Active non-rest sessions without executable basics produce a warning.
- The plan end is exclusive: sessions before the end boundary pass, sessions at/after it fail.
- No-end-date continuous plans do not fake taper weeks.
- Event/race plans still require race-date context before taper/peak logic is trusted.
- No-wearable readiness is explicitly `no_data` / `fallback`, not fresh wearable data.
- Stale provider input stays visible as stale readiness confidence.
- Manual check-in input remains `manual_check_in` / `manual`.
- Existing cancellation, calendar ownership, and reconciliation behavior remains intact.
- The operational plan-generation route stays deterministic by default and does not call LLM providers directly.

### iOS

- Preview-ready state is visibly actionable with create, edit inputs, and discard paths.
- Duplicate create attempts from the same preview share a stable idempotency key.
- The create button cannot fire while plan generation is pending.
- Training conflict move suggestions show friendly local times and never leak ISO strings with trailing zeros.
- Invalid or malformed reflow timestamps fall back to “suggested time” / “horário sugerido”.
- Conflict-resolution actions read as clear user choices: next available, choose another slot, keep unscheduled.
- Cancellation shows cleanup progress before completion.

## Tests / Checks Already Performed

### Backend

Run in `/Users/felipedominguez/Desktop/Nexus Hub/worktrees/training-skill-hardening-codex-20260519`:

```bash
npm run typecheck
```

Result: PASS.

```bash
npx vitest run \
  __tests__/services/training-coach-kernel-plan-generator.test.ts \
  __tests__/services/coach-kernel-plan-linter.test.ts \
  __tests__/api/training-plan-generation-source-contract.test.ts \
  __tests__/services/training-skill-hardening-source-contract.test.ts
```

Result after final contract pass: PASS, 4 files / 52 tests.

```bash
npx vitest run \
  __tests__/services/garmin-coach-user-scope.test.ts \
  __tests__/services/training-skill-hardening-source-contract.test.ts \
  __tests__/api/training-plan-generation-source-contract.test.ts
```

Result after final cost-attribution pass: PASS, 3 files / 12 tests.

```bash
npx vitest run \
  __tests__/services/training-coach-kernel-plan-generator.test.ts \
  __tests__/services/training-coach-kernel-goal-mode-shaping.test.ts \
  __tests__/services/garmin-coach-user-scope.test.ts \
  __tests__/services/training-semantic-fixtures.test.ts \
  __tests__/services/coach-kernel-plan-linter.test.ts \
  __tests__/api/training-plan-generation-source-contract.test.ts \
  __tests__/services/training-skill-hardening-source-contract.test.ts \
  __tests__/api/training-plan-generation.test.ts \
  __tests__/api/training-plan-persistence.test.ts \
  __tests__/api/training-read-models.test.ts \
  __tests__/api/training-plan-cancellation.test.ts \
  __tests__/api/training-routes.test.ts \
  __tests__/services/training-plan-lifecycle.test.ts \
  __tests__/services/training-plan-cancellation-cascade.test.ts \
  __tests__/api/training-plan-calendar-sync.test.ts
```

Result after the final cost-attribution patch: PASS, 15 files / 226 tests.

```bash
npx vitest run
```

Result after final Training hardening pass: PASS, 608 files / 9019 tests.

### iOS

Run in `/Users/felipedominguez/Desktop/Nexus Hub IOS/worktrees/training-skill-ui-codex-20260519`:

```bash
xcodebuild test -project "Nexus Hub.xcodeproj" -scheme "Nexus Hub" -sdk iphonesimulator \
  -destination "platform=iOS Simulator,name=iPhone 17 Pro" \
  -only-testing:"Nexus HubTests/TrainingReflowTimeFormatterTests" \
  -only-testing:"Nexus HubTests/TrainingUIRevampSourcePinsTests"
```

Result: PASS, 11 tests.

```bash
xcodebuild -project "Nexus Hub.xcodeproj" -scheme "Nexus Hub" -sdk iphonesimulator build
```

Result: PASS.

```bash
IOS_SIM_UDID=BD5CFDE5-33A7-45E2-AF82-0E2A6A7D8187 \
IOS_SHUTDOWN_OTHER_SIMS=0 \
IOS_QUIT_SIMULATOR_APP=0 \
IOS_TRIM_SIMULATOR_PROCESSES=0 \
IOS_ALLOW_MULTIPLE_BOOTED=1 \
scripts/ios-single-simulator-test.sh
```

Result: PARTIAL/PASS-WITH-RETRY evidence. The helper executed 86 UI tests with 1 expected skip and 0 assertion failures in the final selected suite, but the overall xcodebuild session exited 65 because four earlier UI tests were reported as `Test crashed with signal term` during simulator process turnover:

- `AuthenticationFlowUITests.test_emailRegister_then_login_then_signOut_then_relogin`
- `ContentCreationLiveWorkflowUITests.test_contentAgencyFixtureOutputIsActionableCleanAndExtractable`
- `NotificationDecisionCenterUITests.test_actionFailureKeepsListVisibleAndAllowsRetry`
- `NotificationDecisionCenterUITests.test_decisionCenterLoadFailureShowsErrorScreen`

Those four were rerun immediately on the same dedicated simulator:

```bash
IOS_SIM_UDID=BD5CFDE5-33A7-45E2-AF82-0E2A6A7D8187 \
IOS_SHUTDOWN_OTHER_SIMS=0 \
IOS_QUIT_SIMULATOR_APP=0 \
IOS_TRIM_SIMULATOR_PROCESSES=0 \
IOS_ALLOW_MULTIPLE_BOOTED=1 \
IOS_KEEP_SIM_BOOTED=1 \
scripts/ios-single-simulator-test.sh \
  -only-testing:"Nexus HubUITests/AuthenticationFlowUITests/test_emailRegister_then_login_then_signOut_then_relogin" \
  -only-testing:"Nexus HubUITests/ContentCreationLiveWorkflowUITests/test_contentAgencyFixtureOutputIsActionableCleanAndExtractable" \
  -only-testing:"Nexus HubUITests/NotificationDecisionCenterUITests/test_actionFailureKeepsListVisibleAndAllowsRetry" \
  -only-testing:"Nexus HubUITests/NotificationDecisionCenterUITests/test_decisionCenterLoadFailureShowsErrorScreen"
```

Result: PASS, 4 UI tests / 0 failures. Treat the long helper exit as simulator/process instability, not an asserted product failure, but Claude should independently verify whether this retry standard is acceptable for release sign-off.

### Workspace Docs Audit

Run before updating this QA prompt, per workspace bootloader:

```bash
cd "/Users/felipedominguez/Desktop/Nexus Hub/engine" && npm run docs:audit
```

Result after this final prompt refresh: PASS/exit 0 with the existing workspace warning backlog (753 issues flagged, no command failure).

## Completion Audit

Local code/test-backed implementation is complete for this worktree slice:

- Worktrees were created and used; Claude worktrees were not touched.
- Existing Training naming was preserved; no `CoachKernelV2`, `TrainingCoachKernelV2`, or parallel Training V2 path was introduced.
- Existing coach-kernel knowledge loaders/templates, adaptation engines, feedback analysis, training signals, and cross-skill orchestration remain the durable knowledge layer and were not duplicated. This is now pinned by `training-skill-hardening-source-contract.test.ts`, not just asserted in prose.
- Plan quality gate now blocks Week 1 empty starts and out-of-window hidden Week 5 sessions before persistence.
- Session prescription completeness is warning-only and test-pinned.
- Readiness confidence/source/staleness/manual provenance is surfaced through coach-kernel inputs and read-model outputs.
- Existing no-end-date and event-date phase logic is pinned with tests.
- Existing cancellation/calendar ownership implementation was re-verified with focused tests rather than duplicated.
- iOS preview/create is now a two-step flow with deterministic idempotency, edit/discard actions, and pending disabled state.
- iOS conflict move labels use approved UX copy and the friendly formatter instead of raw timestamps.
- Token-Zero was preserved for touched Training surfaces: no fake chat command path was added.
- Cost savings are enforced at the route/source-contract level: operational scheduling and adaptation stay deterministic with no direct provider call/API-usage write in the plan-generation module. Coach explanation calls are metered under `coach_analysis` with scoped `userId`/`tenantId`, and the generate route keeps the existing cost lock/guardrail around any future AI-backed explanation/fallback work.

Rollout-gated items are explicitly not proven locally:

- Real Outlook/Google calendar delete/reconciliation must be validated with live provider accounts.
- TestFlight walkthroughs for Felipe/Jaqueline cannot be performed from this local worktree.
- Shadow/active rollout gates and production promotion are intentionally not done in this branch.
- Production dashboard validation of the new scoped coach-analysis rows remains rollout-gated; the local code path now passes user/tenant metering context, and deterministic plan/adaptation paths remain zero-provider-cost.
- The full iOS helper was run on a dedicated simulator to avoid clobbering another active Codex simulator session. The dedicated rerun proved the four signal-term reports pass in isolation, but the long helper's xcodebuild process still exited 65.

## Areas Claude Should Inspect Carefully

1. Verify no `CoachKernelV2`, `TrainingCoachKernelV2`, or V2 Training service was introduced.
2. Confirm `week_one_has_active_training` only blocks when the plan has active training elsewhere and Week 1 has none; it should not block true rest/no-work plans.
3. Confirm `no_sessions_outside_plan_window` blocks both:
   - `weekNumber > durationWeeks`
   - scheduled active dates at/after the plan end.
4. Confirm `session_prescription_completeness` is warning-only and does not over-block rest/recovery/mobility sessions.
5. Confirm strict preflight quality gate runs before persistence side effects and cannot delete/replace the current plan when the new candidate is blocked.
6. Confirm post-persist advisor lint still runs and reports residual schedule/date findings.
7. Confirm no-wearable, stale-provider, and manual-check-in readiness are not represented as fresh provider data in API/read-model output.
8. Confirm iOS preview idempotency key is deterministic per preview fingerprint and regenerated when inputs are edited/discarded.
9. Confirm iOS conflict time formatting handles `.000Z`, `.000000Z`, offset timestamps, and invalid timestamps without showing raw ISO strings.
10. Confirm iOS conflict sheet copy matches the approved actions and keeps accessibility identifiers stable.
11. Confirm no operational Training UI action was implemented by sending fake chat commands. The visible “Ask Nexus” button may route the user to Chat, but must not synthesize and send a fake operational command.
12. Confirm `training-plan-generation.ts` has no direct LLM/Gemini/OpenAI/api_usage scheduling path and that `training-plan-routes.ts` keeps `acquireCostLock` / `enforceCostGuardrails` around future AI explanation/fallback work.
13. Confirm `generateCoachBriefing` passes scoped `userId`/`tenantId` into both Gemini-first and Anthropic-fallback `coach_analysis` metering.
14. Confirm coach-kernel knowledge is loaded from reusable docs/templates (`run`, `bike`, `swim`, `strength`, hybrid rules, marathon periodization, LLM tool contract), not reintroduced as prompt-only logic.
15. Confirm deterministic adaptation/feedback and “what changed” surfaces still flow through `planner-engine`, `feedback-analysis`, `training-history`, and `training-home-view-state`.
16. Confirm Training-scoped cross-skill signals include Secretary/calendar, Cooking/fueling, Finance/budget, adherence, and plan drift.
17. Confirm the semantic fixture corpus additions are representative and not decorative names.
18. Confirm existing cancellation/calendar ownership tests still prove owned calendar rows are deleted/reconciled and tenant-scoped.

## Edge Cases To Verify

- Week 1 contains only unscheduled/rest/mobility sessions while Week 2 has active work.
- Week 4 has `scheduledDate` just inside the plan window boundary versus exactly at the exclusive end.
- A continuous no-end-date plan has deload/review weeks but no taper/peak/race-week copy.
- Race-specific objective without race date still blocks/asks for missing date where expected.
- No wearable provider plus manual check-in: manual confidence should not be overwritten as fresh wearable.
- Reflow timestamp with six or more fractional digits: UI should show a local time range, not `2026-...000000Z`.
- Reflow timestamp parsing failure: UI should show friendly fallback and not expose raw provider/date payload.
- Repeated taps on preview/create while `isGeneratingPlan` is true.
- Edit/discard preview should reset the old deterministic create key.
- Cancel plan progress should be visible and should not imply provider cleanup finished before the backend says so.

## Known Risks / Assumptions

- This is a local hardening slice, not a production rollout. Real provider validation remains required for Outlook/Google calendar event deletion and real TestFlight walkthroughs.
- Full backend `npx vitest run` passed: 608 files / 9019 tests.
- Full iOS helper was attempted on an isolated simulator. It produced a code 65 from four `signal term` reports during the long run, and those exact four tests passed when rerun immediately in isolation. Claude should classify whether this is acceptable simulator instability or requires another clean full helper pass.
- The repo has unrelated pre-existing `V2` symbols in Decision Center, MarkdownV2, and historical docs. QA should grep specifically for Training V2 / CoachKernelV2 pollution, not fail on unrelated existing V2 terms.

## Output Format

Return:

- `VERDICT: PASS / PASS WITH MINOR / PARTIAL / FAIL / NOT VERIFIED`
- Confirmed-implemented items with file:line evidence.
- Any regressions or overreach.
- Deferred/rollout-gated items that remain honest.
- A short punch list ordered by severity.
