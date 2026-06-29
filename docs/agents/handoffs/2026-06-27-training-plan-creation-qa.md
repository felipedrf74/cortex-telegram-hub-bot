# Agent Handoff - Training Plan Creation QA And Fixes

## Session Summary

**Started**: 2026-06-27T19:10:00+01:00
**Updated**: 2026-06-28T01:03:30+01:00
**Backend branch**: `codex/Trainingfixes`
**Backend worktree**: `/Users/felipedominguez/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot`
**iOS branch**: `main`
**iOS worktree**: `/Users/felipedominguez/Developer/Nexus Hub IOS/Nexus Hub`
**Agent**: Codex with two read-only sub-agent QA passes

## What Changed Locally

- Backend route validation/idempotency:
  - Normalized `twoADayPreference` before preview/generate routing and request hashing.
  - Failed plan-generation idempotency rows on quota guardrail, missing profile, clarification, quality-gate, cancellation, preview-invalid, and unexpected-error exits so same-key retries can re-run instead of replaying broken frontend states.
  - Added stale-replay proof checks so confirmed idempotency replays only return when the referenced active plan, weeks, and sessions still exist and still belong to the user.
- Backend selected-model fidelity:
  - Stopped treating `trainingPriority: strength` alone as gym-only for non-gym objectives.
  - Preserved explicit sport split targets for running, cycling, swimming, triathlon, hybrid, and strength priorities in planner input, response `weeklyTargets`, and stored `preferences_json`.
  - Persisted the effective non-zero gym target when a gym-only objective sends explicit `strengthSessionsPerWeek: 0` but the downstream generator expands it.
- Backend agenda/provider consistency:
  - Training session persistence now cleans up a provider event if ownership recording fails after provider creation.
  - The failed session is marked unscheduled and the Secretary agenda row is marked `failed_sync`/readback failed instead of pretending the agenda is fully synced.
  - Secretary agenda failure marking preserves terminal completed/canceled rows and keeps provider identifiers when provider args are null.
- iOS plan-builder flow:
  - Replaced priority `.onChange` reset behavior with a picker binding so programmatic chat/objective prefills do not overwrite explicit session counts.
  - Added reducer-backed defaults for cycling, swimming, triathlon, and strength selected models.
  - Added/kept bike and swim state, steppers, summary copy, preview/create payload forwarding, and preview fingerprint membership.
  - Chat prefill now accepts `bikeSessionsPerWeek`/`cyclingSessionsPerWeek` and `swimSessionsPerWeek`/`swimmingSessionsPerWeek`.

## Sub-Agent QA

- Backend read-only QA agent found no blocking issues. It flagged one P3 gap: quota/cost guardrail retry was implemented but not directly asserted. Closed with `marks quota-blocked plan generation idempotency rows failed so retry re-runs`.
- iOS read-only QA agent found no blocking issues. It flagged one P3 gap: preview fingerprint bike/swim membership was implemented but not source-pinned. Closed in `NavigationPerformanceSourcePinsTests`.

## Local Validation Evidence

- `NODE_ENV=test DATABASE_PATH=:memory: TZ=Europe/Lisbon npx vitest run __tests__/api/training-routes.test.ts __tests__/api/training-plan-generation.test.ts __tests__/api/training-plan-persistence.test.ts __tests__/services/secretary-scheduling-arbitrator.test.ts`
  - Passed: 4 files, 163 tests.
- `NODE_ENV=test DATABASE_PATH=:memory: TZ=Europe/Lisbon npx vitest run __tests__/api/training-plan-calendar-sync.test.ts __tests__/api/training-plan-cancellation.test.ts __tests__/api/training-coach-v2-reflow-serializer.test.ts __tests__/services/training-plan-cancellation-cascade.test.ts __tests__/services/training-week-reflow.test.ts __tests__/services/training-plan-lifecycle.test.ts __tests__/services/training-calendar-provider-retry.test.ts __tests__/integration/training-plan-create-cycle.test.ts __tests__/services/training-plan-creation-validation.test.ts`
  - Passed: 9 files, 151 tests.
- `npm run typecheck`
  - Passed.
- Final risk gate:
  - `NODE_ENV=test DATABASE_PATH=:memory: TZ=Europe/Lisbon NEXUS_RISK_GATE_REPORTER=dot scripts/risk-gate.sh --files src/api/routes/training-plan-routes.ts,src/api/routes/training-plan-generation.ts,src/api/routes/training-plan-persistence.ts,src/services/secretary-scheduling-arbitrator.ts,src/services/training-plan-generation-idempotency.ts,__tests__/api/training-routes.test.ts,__tests__/api/training-plan-generation.test.ts,__tests__/api/training-plan-persistence.test.ts,__tests__/services/secretary-scheduling-arbitrator.test.ts`
  - Passed focused risk block: 140 files, 2,217 tests.
  - Passed `--changed origin/main` sweep: 603 files, 9,281 tests.
  - Warnings only: existing Vitest hoisted-mock warnings, node-cron sourcemap warning, and `--localstorage-file` warning.
- XcodeBuildMCP `Nexus Hub` scheme:
  - `Nexus HubTests/TrainingPlanBuilderPrefillTests`
  - `Nexus HubTests/TrainingPlanBuilderSummaryResolverTests`
  - `Nexus HubTests/NavigationPerformanceSourcePinsTests/test_trainingPlanBuilderPinsTodayPolicyStrengthDefaultsAndActiveCalendarSource`
  - Passed earlier focused unit matrix: 24 tests.
  - Passed final source-pin rerun after fingerprint pin: 1 test.
- XcodeBuildMCP `Nexus Hub Debug UI Smoke` scheme:
  - `Nexus HubUITests/TrainingValidationUITests/test_createPlanSheet_strengthStepperAccepts5Sessions`
  - `Nexus HubUITests/TrainingValidationUITests/test_documentationOnly_trainingUIIdentifiersExist`
  - `Nexus HubUITests/TrainingFixtureBypassUITests/test_noPlanFixture_createPlanSheetStrengthStepperAccepts5Sessions`
  - `Nexus HubUITests/TrainingFixtureBypassUITests/test_noPlanFixture_planBuilderSummaryPrecedesPreviewAndCreateIsGatedBeforePreview`
  - Passed: 4 UI tests.
- `npm run docs:audit`
  - Passed with warnings only: 1,624 existing-style docs audit issues flagged, including the known literal test-count warnings and workspace mirror drift warnings.

## Requirement Coverage

- Selected model correctness:
  - Covered by backend per-priority weekly-target round-trip tests and iOS reducer/prefill/source-pin tests.
- Frontend create errors and retry behavior:
  - Covered by idempotency failure/retry tests for quota guardrail, missing profile, quality gate, clarification, stale replay proof, replay mismatch, and stale active-plan proof.
- Agenda and provider sync:
  - Covered by persistence tests for ownership failure cleanup, Secretary failed-sync marking, and provider delete failure being nonfatal.
- Reflow and adjustment safety:
  - Covered by existing completed-session reflow protection and expanded Training reflow/cancellation suites.
- Cancellation and create-cancel-create:
  - Covered by cancellation cascade, provider retry, and integration create-cycle tests.
- iOS plan creation flow:
  - Covered by source pins, focused unit tests, and no-plan create-sheet UI smoke tests.

## Residual External Checks

- No staging, production, live provider write, real-account iOS create, or real calendar readback was performed. These require owner authorization and external state.
- The long full Training UI suite was not completed because the simulator run hit the tool timeout during visual screenshot tests; the create-flow subset passed.
- Before release, run real-account create/preview for cycling, swimming, triathlon, and strength plans and verify no frontend error banner, correct payload, Training sessions, Secretary agenda rows, provider ownership rows, and `/plan/weeks` parity.
- Before production promotion, follow release docs and verify PM2/public health/runtime artifacts after deploy.

## Files Touched By This Fix

Backend:
- `src/api/routes/training-plan-routes.ts`
- `src/api/routes/training-plan-generation.ts`
- `src/api/routes/training-plan-persistence.ts`
- `src/services/secretary-scheduling-arbitrator.ts`
- `src/services/training-plan-generation-idempotency.ts`
- `__tests__/api/training-routes.test.ts`
- `__tests__/api/training-plan-generation.test.ts`
- `__tests__/api/training-plan-persistence.test.ts`
- `__tests__/services/secretary-scheduling-arbitrator.test.ts`
- `docs/agents/handoffs/2026-06-27-training-plan-creation-qa.md`

iOS:
- `Nexus Hub/Views/Training/TrainingView.swift`
- `Nexus Hub/Views/Training/TrainingPlanBuilderSummaryResolver.swift`
- `Nexus HubTests/NavigationPerformanceSourcePinsTests.swift`
- `Nexus HubTests/TrainingPlanBuilderPrefillTests.swift`
- `Nexus HubTests/TrainingPlanBuilderSummaryResolverTests.swift`
- `Nexus HubUITests/TrainingFixtureBypassUITests.swift`
- `Nexus HubUITests/TrainingValidationUITests.swift`

## Out Of Scope Dirty Files

The backend worktree also contains unrelated dirty portal/token/release files that were not part of this Training fix and should not be included in a Training-only review:
- `__tests__/portal/portal-cooking-ui.test.ts`
- `__tests__/portal/owner-dashboard.test.ts`
- `docs/TOKEN-QUOTA-CONTRACT.md`
- `docs/_workspace-mirror/docs/release/feature-delivery-ledger.md`
- `docs/release/eval-evidence/registry-shadow-parity-latest.json`
- `docs/release/feature-delivery-ledger.md`
- `src/config.ts`
- `src/portal/portal.html`
- `src/portal/server.ts`
- `src/portal/owner-dashboard-routes.ts`
- `src/portal/owner-dashboard.ts`

The iOS worktree also has generated local artifacts that were intentionally preserved:
- `DerivedData/`
- `test-summary.json`

## Local Verdict

LOCAL FIX VERIFIED for the scoped backend and iOS Training plan creation work. The implementation now matches the selected training model parameters, keeps preview/create payloads and persisted preferences aligned, makes failed create attempts retryable, and prevents agenda/provider sync from claiming success when ownership recording fails. No commit, push, deploy, archive, reset, or cleanup was performed.

## Verifiable Reward Summary

- Verdict: WARN for scoped backend advisory reward run; all mandatory checks passed, no hard failures. Initial `--area auto` advisory run returned `FAIL` because the full dirty worktree was classified as release due unrelated release-file changes and this block was missing before correction.
- Score: 95.
- Area: backend reward check for scoped Training backend and paired iOS local QA evidence; not a release/deploy claim.
- Changed-area classifier: final risk gate selected Training/API/Secretary plus cannot-skip Training create, entitlement, and cost-guardrail gates.
- Hard failures: none observed in scoped local verification.
- Mandatory checks: backend typecheck, focused Training tests, final scoped risk gate, docs audit, focused XcodeBuildMCP unit/UI checks, and two read-only sub-agent QA passes completed.
- Skipped checks and reasons: reward checker reported no skipped checks in the final scoped backend run. Staging, production, live provider writes, real-account iOS create, and real calendar readback were outside the local scope because this task had no owner authorization for external-state writes.
- Evidence commands: see `Local Validation Evidence` above.
- Evidence artifacts: XcodeBuildMCP result bundles under the local XcodeBuildMCP workspace; raw reward JSON under ignored `.local/reward-runs/`.
- Export eligibility: ineligible until human review because this is local scoped QA only and external release checks were intentionally not run.
- Prompt/process improvement: keep Training QA scoped to selected model inputs, generated plan preferences, Training sessions, Secretary agenda state, calendar ownership, iOS payload wiring, read-model parity, and retry/idempotency behavior.

---

## Round 2 Addendum - 2026-06-28

### Scope

Round-2 independent QA found a major regression in the Training ownership-failure cleanup path plus minor issues in two-a-day prefill, zero-modality multisport defaults, and persisted strength targets. This addendum records the follow-up fixes and evidence without changing the no-commit/no-deploy boundary.

### Round 2 Fixes

- Backend ownership failure no longer leaves a Secretary agenda row in active `failed_sync` with a stale deleted provider id.
  - `src/api/routes/training-plan-persistence.ts`
  - Successful provider delete after ownership-record failure now marks the agenda `unscheduled` / `deleted`, clears `provider_event_id` and `provider_source`, and records `training_provider_ownership_record_failed`.
  - Provider delete failure now leaves the agenda `unscheduled` / `delete_failed` with the provider id retained only so the next provider sync can retry deletion.
  - Calendar create failure now marks the agenda `unscheduled` / `create_failed` with mapping cleared instead of an active retryable provider row.
- Backend Secretary sync has a Training-backed safety guard.
  - `src/services/secretary-agenda-provider-sync.ts`
  - If an active provider-backed agenda row points at a Training session that is already `unscheduled`, `canceled`, or `cancelled`, sync converts it to cleanup and deletes/skips provider state instead of recreating a missing event.
- Backend persisted strength target is capped to the schedulable strength budget.
  - `src/services/training-plan-volume-enforcement.ts`
  - `src/api/routes/training-plan-generation.ts`
  - Explicit `strengthSessionsPerWeek=5` with `sessionsPerWeek=3` and no explicit run budget now persists/reports `3`, matching real enforcer output.
- Backend modality targets are floored for selected cycling/swimming/triathlon plans.
  - `src/services/training-coach-kernel-plan-generator.ts`
  - Explicit zero for a selected own-modality target no longer produces cycling/swimming/triathlon plans with zero bike/swim/run modality counts.
- iOS plan-builder preserves `twoADayPreference = "optional"`.
  - `Nexus Hub/Views/Training/TrainingView.swift`
  - `Nexus HubTests/TrainingPlanBuilderPrefillTests.swift`
- iOS non-forced priority defaults now fill missing own-modality minimums after customization.
  - A customized plan that switches to triathlon now gets bike/swim minimums without overwriting existing run/strength counts.

### Round 2 New Coverage

- Ownership failure cleanup:
  - `__tests__/api/training-plan-persistence.test.ts`
  - `__tests__/services/secretary-scheduling-arbitrator.test.ts`
  - `__tests__/services/secretary-agenda-provider-sync.test.ts`
- Replay/idempotency:
  - `__tests__/api/training-routes.test.ts`
  - Covered tenant mismatch by `tenant_id`, stale replay reappearing after discard returning 409 `TRAINING_PLAN_GENERATION_IN_PROGRESS`, and existing stale-proof branches.
- Strength and modality targets:
  - `__tests__/api/training-plan-generation.test.ts`
  - `__tests__/services/training-plan-volume-enforcement.test.ts`
  - `__tests__/services/training-coach-kernel-weekly-targets.test.ts`
- iOS builder:
  - `Nexus HubTests/TrainingPlanBuilderPrefillTests.swift`
  - Existing summary/source-pin tests also ran cleanly for the Training-scoped subset.

### Round 2 Validation Evidence

- `npx vitest run __tests__/api/training-plan-persistence.test.ts __tests__/services/secretary-scheduling-arbitrator.test.ts __tests__/services/secretary-agenda-provider-sync.test.ts`
  - Passed: 3 files, 59 tests.
- `npx vitest run __tests__/api/training-routes.test.ts --testNamePattern "replay|idempotency|stale confirmed plan replay|stale confirmed replay reappears"`
  - Passed: 1 file, 15 selected tests.
- `npx vitest run __tests__/api/training-plan-generation.test.ts __tests__/services/training-plan-volume-enforcement.test.ts __tests__/services/training-coach-kernel-weekly-targets.test.ts`
  - Passed: 3 files, 73 tests.
- `npm run typecheck`
  - Passed.
- `npx vitest run __tests__/services/training-*.test.ts __tests__/services/coach-kernel-*.test.ts __tests__/api/training-*.test.ts __tests__/integration/training-plan-create-cycle.test.ts`
  - Passed: 122 files, 1,929 tests.
- `scripts/changed-area-classifier.sh --format json --files <round-2 Training file list>`
  - Focused Training/API/Secretary classifier; cannot-skip gates included Training create, Training entitlement, and cost guardrail.
- `scripts/risk-gate.sh --files <round-2 Training file list>`
  - Passed focused risk block: 140 files, 2,225 tests.
  - Passed `--changed origin/main` sweep: 604 files, 9,301 tests.
  - Warnings only: existing hoisted `vi.mock` warnings, node-cron sourcemap warning, production-warning stderr in auth tests, and `--localstorage-file` warnings.
- `npm run docs:audit`
  - Exit 0 with existing repo-wide docs warnings: 1,624 warnings, including known workspace mirror drift and literal test-count warnings.
- XcodeBuildMCP `Nexus Hub` scheme:
  - `Nexus HubTests/TrainingPlanBuilderPrefillTests`
  - `Nexus HubTests/TrainingPlanBuilderSummaryResolverTests`
  - `Nexus HubTests/NavigationPerformanceSourcePinsTests/test_trainingPlanBuilderPinsTodayPolicyStrengthDefaultsAndActiveCalendarSource`
  - Passed: 25 tests.
- XcodeBuildMCP `Nexus Hub Debug UI Smoke` scheme:
  - `Nexus HubUITests/TrainingFixtureBypassUITests`
  - `Nexus HubUITests/TrainingValidationUITests`
  - Passed: 22 tests, 0 failures.
  - Note: the MCP wrapper timed out at 300s, but the underlying `xcodebuild` process continued and finished successfully. `xcresulttool` summary reported `result: Passed`, `passedTests: 22`, `failedTests: 0`.
- XcodeBuildMCP full source-pin class:
  - Not used as final Training evidence because unrelated dirty Content Studio/tab warmup source pins failed. Training-specific source-pin test passed in the scoped run.

### Round 2 Reward Summary

- Initial scoped reward command:
  - `node scripts/reward-check.mjs --area backend --advisory --changed-files <round-2 Training file list>`
  - Verdict: `MANUAL_REQUIRED`
  - Score: 69
  - Hard failures: none
  - Reason: handoff/evidence summary was not yet updated.
- Final scoped reward command:
  - `node scripts/reward-check.mjs --area backend --handoff docs/agents/handoffs/2026-06-27-training-plan-creation-qa.md --advisory --changed-files <round-2 Training file list>`
  - Verdict: `WARN`
  - Score: 98
  - Hard failures: none
  - Mandatory checks: PASS 4
  - Skipped checks: `verify-deliverable` warning only.
  - Export eligibility: ineligible until manual human review because this is local scoped QA, not a release/deploy proof.

### Round 2 Residual Risks

- No staging, production, live provider writes, real OAuth calendar readback, PM2 health proof, or real-account iOS create was performed. Those require explicit owner authorization.
- The backend broad `--changed origin/main` leg included unrelated dirty files, so the scoped Training classifier/risk-gate file list is the authoritative Training validation scope.
- iOS full `NavigationPerformanceSourcePinsTests` currently has unrelated non-Training failures in Content Studio/tab warmup pins from the dirty worktree; the Training-specific source pin passed.
- The UI smoke run is slow and exceeded the MCP tool-call timeout, but the underlying xcodebuild finished passed.

### Round 2 Claude QA Prompt

Original goal:
Independently validate the round-2 Training plan creation fixes. The user reported Training plans being created without expected parameters, frontend errors after creation, agenda/provider sync inconsistencies, stale idempotency/replay behavior, iOS create-flow issues, two-a-day mismatch, zero bike/swim triathlon plans, and persisted strength targets not matching generated sessions.

What was implemented:
Backend Training ownership-failure cleanup now marks Secretary agenda rows as cleanup state instead of active `failed_sync`, clears stale provider ids after successful delete, keeps ids only for delete retry when delete fails, and prevents Secretary provider sync from resurrecting events for unscheduled/canceled Training sessions. Backend strength targets are persisted/reported from a schedulable budget, and selected cycling/swimming/triathlon targets floor explicit zero own-modality values. iOS now preserves `twoADayPreference = "optional"` and fills missing bike/swim minimums for non-forced triathlon/cycling/swimming defaults without overwriting customized counts.

Files changed:
Backend:
- `src/api/routes/training-plan-generation.ts`
- `src/api/routes/training-plan-persistence.ts`
- `src/api/routes/training-plan-routes.ts`
- `src/services/secretary-agenda-provider-sync.ts`
- `src/services/secretary-scheduling-arbitrator.ts`
- `src/services/training-coach-kernel-plan-generator.ts`
- `src/services/training-plan-generation-idempotency.ts`
- `src/services/training-plan-volume-enforcement.ts`
- `__tests__/api/training-plan-generation.test.ts`
- `__tests__/api/training-plan-persistence.test.ts`
- `__tests__/api/training-routes.test.ts`
- `__tests__/services/secretary-agenda-provider-sync.test.ts`
- `__tests__/services/secretary-scheduling-arbitrator.test.ts`
- `__tests__/services/training-coach-kernel-weekly-targets.test.ts`
- `__tests__/services/training-plan-volume-enforcement.test.ts`
- `docs/agents/handoffs/2026-06-27-training-plan-creation-qa.md`

iOS:
- `Nexus Hub/Views/Training/TrainingView.swift`
- `Nexus HubTests/TrainingPlanBuilderPrefillTests.swift`

Expected behavior:
- Ownership-record failure after provider create should unschedule the Training session, delete the provider event, clear agenda provider mapping, mark the agenda cleanup state, and never let the next Secretary sync recreate/mark synced.
- If provider deletion fails, the agenda must still be cleanup-state and retry deletion, not recreate.
- Calendar create failure must also put the agenda in cleanup-safe unscheduled state.
- Active provider rows backed by unscheduled/canceled Training sessions must cleanup, not recreate.
- Replay of a stale completed idempotency result should only return if active plan proof passes; if a stale replay reappears after discard, return 409 `TRAINING_PLAN_GENERATION_IN_PROGRESS`.
- Tenant mismatch by `tenant_id` must fail replay proof.
- Persisted/response strength targets must match real scheduled strength counts when explicit strength exceeds day budget.
- iOS `optional` two-a-day must round-trip as `optional`.
- iOS triathlon/cycling/swimming selected priority must not send zero own-modality counts after the user customized other counts.

Tests/checks already performed:
- Backend focused regression tests: 3 files, 59 tests passed.
- Backend replay/idempotency selected route tests: 15 selected tests passed.
- Backend generation/volume/weekly-target selected tests: 3 files, 73 tests passed.
- `npm run typecheck`: passed.
- Expanded backend Training matrix: 122 files, 1,929 tests passed.
- Scoped risk gate: focused 140 files / 2,225 tests passed; changed sweep 604 files / 9,301 tests passed.
- `npm run docs:audit`: exit 0 with existing warnings.
- iOS focused unit/source-pin tests: 25 passed.
- iOS Debug UI Smoke Training UI tests: 22 passed, 0 failed; underlying xcodebuild passed after MCP wrapper timeout.

Inspect carefully:
- `src/api/routes/training-plan-persistence.ts` ownership failure branch, especially whether stale provider ids are cleared only after successful delete and retained only for delete retry.
- `src/services/secretary-agenda-provider-sync.ts` Training-backed unscheduled/canceled guard and whether it can accidentally affect non-Training or valid active agenda rows.
- `src/services/secretary-scheduling-arbitrator.ts` cleanup helper SQL, completed-row protection, provider mapping clearing, and reminder cancellation.
- `src/api/routes/training-plan-generation.ts` persisted strength target and `preferences_json` alignment with `weeklyTargets`.
- `src/services/training-coach-kernel-plan-generator.ts` explicit zero floors for cycling/swimming/triathlon and whether legitimate user intent can still be represented.
- iOS `TrainingPlanBuilderPriorityDefaultsReducer` non-forced behavior: it should fill missing own-modality minimums without overwriting customized counts.

Edge cases to verify:
- Ownership failure with provider delete success, provider delete failure, and create failure.
- Secretary sync after agenda active `failed_sync` + missing provider event + Training session `unscheduled`.
- Completed Training session with provider mapping should not be reflowed or cleanup-mutated unexpectedly.
- Recreate same plan rapidly with explicit idempotency key, no idempotency key, and create-cancel-create flow.
- Mismatched user and mismatched tenant replay proof.
- Cycling-only, swimming-only, triathlon six-day, strength-only, and hybrid generated plans: actual scheduled session counts match payload and `preferences_json`.
- iOS optional two-a-day, triathlon preset after strength customization, and preview fingerprint updates for bike/swim changes.
- PT/EN labels for summary and any new visible strings.

Known risks/assumptions:
- No live provider/OAuth/staging/production validation was run.
- The Training session status sync guard assumes numeric Training `sourceEntityId` for persisted sessions.
- The iOS Debug UI Smoke scheme is the UI-test-capable scheme; the normal `Nexus Hub` scheme cannot run `Nexus HubUITests`.
- Unrelated dirty backend portal/docs/config files and unrelated iOS local artifacts are excluded from the Training-only commit set.

---

## Round 3 Addendum - 2026-06-28

### Scope

Round-3 independent QA confirmed the event-resurrection fix and asked for the
remaining Training plan-creation discrepancies to be closed: persisted/reported
weekly targets had to come from the actual scheduled plan, iOS objective
switch-away had to clear stale auto multisport defaults, Secretary same-slot
reschedule had to stop reusing cleanup rows, the dead sync-failure helper had
to be removed or wired, and cleanup-row provider sync had to short-circuit
terminal no-op rows.

### Round 3 Fixes

- Backend weekly target truth source now derives from the generated scheduled
  plan.
  - `src/api/routes/training-plan-generation.ts`
  - `preferences_json`, preview `weeklyTargets`, and create `weeklyTargets`
    now use scheduled run/bike/swim/strength counts after kernel generation,
    volume enforcement, equipment authority, and quality repair.
  - `countSchedulablePlanSessions` and weekly-target derivation share the same
    dropped/deferred/rest exclusion.
- Backend volume enforcement now understands explicit bike/swim modality
  budgets.
  - `src/services/training-plan-volume-enforcement.ts`
  - Explicit run/bike/swim budgets bound the active target and training-day
    budget for their selected sport, so cycling `bike=3` with strength support
    is not inflated to `sessionsPerWeek`.
  - Strength is also capped by available training days so explicit
    `run=2` / `strength=5` schedules and reports two strength sessions.
- Backend Secretary agenda reuse no longer treats cleanup rows as reusable.
  - `src/services/secretary-scheduling-arbitrator.ts`
  - `unscheduled`, `canceled`, `deferred`, `completed`, and `superseded` rows
    are non-reusable for intent same-shape/same-slot short-circuiting.
  - `markSecretaryAgendaProviderSyncFailed` was removed because it had zero
    production callers after the cleanup-required path became the real failure
    contract.
- Backend Secretary provider sync now short-circuits terminal cleanup rows with
  no provider event id.
  - `src/services/secretary-agenda-provider-sync.ts`
  - `unscheduled`/`canceled`/`deferred`/`superseded` rows already marked
    `deleted` with no `provider_event_id` are skipped in batch selection and
    return a direct-sync no-op.
  - The numeric `sourceEntityId` guard is documented as intentional for
    persisted Training sessions; legacy/non-numeric intent rows remain on the
    normal lifecycle path.
- iOS objective-derived defaults reset stale auto multisport values when the
  inferred priority changes.
  - `Nexus Hub/Views/Training/TrainingView.swift`
  - Triathlon -> General Fitness now leaves priority `hybrid` and clears only
    auto bike/swim defaults (`2`/`2`), while preserving customized counts.
  - Switching from one sport template to another clears stale auto values from
    the prior template before applying the new inferred priority.

### Round 3 New Coverage

Backend:
- `__tests__/api/training-plan-generation.test.ts`
  - Route-level response and `preferences_json` now assert scheduled-derived
    targets for constrained strength and triathlon zero-bike/swim cases.
- `__tests__/integration/training-plan-create-cycle.test.ts`
  - Real create-route matrix counts persisted scheduled sessions and asserts
    response targets and stored preferences match those counts for running
    no-explicit-run strength, explicit-run strength, triathlon zero
    bike/swim, and cycling non-zero bike passthrough.
- `__tests__/services/training-plan-volume-enforcement.test.ts`
  - Real kernel/enforcer scheduled counts pin no-run strength `6 -> 3`,
    explicit run `2` plus strength `5 -> 2`, triathlon bike/swim floors, and
    cycling `bike=3` non-inflation.
- `__tests__/services/training-coach-kernel-weekly-targets.test.ts`
  - Pins zero own-modality floors and non-zero own-modality passthrough for
    triathlon/cycling/swimming.
- `__tests__/services/secretary-scheduling-arbitrator.test.ts`
  - Pins real cleanup `delete_failed` update retaining provider ids and
    cleanup-then-reschedule-same-slot inserting a fresh active row.
- `__tests__/services/secretary-agenda-provider-sync.test.ts`
  - Pins terminal deleted cleanup rows with null provider ids as no-op syncs
    with no create/delete provider calls.
- `__tests__/api/training-plan-persistence.test.ts`
  - Removes mocks/expectations for the deleted unused sync-failure helper.

iOS:
- `Nexus HubTests/TrainingPlanBuilderPrefillTests.swift`
  - Pins Triathlon -> General Fitness reset, custom count preservation when
    switching away, and sport-template switch cleanup.

### Round 3 Validation Evidence

- `git diff --check`
  - Passed in backend repo.
- iOS `git diff --check`
  - Passed in iOS repo.
- `npm run typecheck`
  - Passed.
- `scripts/changed-area-classifier.sh --json`
  - Ran against the full backend dirty worktree and confirmed Training/API/
    Secretary risk plus unrelated dirty portal/docs/config files.
- `scripts/risk-gate.sh --files <round-3 Training backend file list> --dry-run`
  - Passed dry run without executing tests.
  - Selected `npx tsc --noEmit`.
  - Selected focused Training/Coach-kernel/Secretary/API Vitest matrix.
  - Selected `npx vitest run --reporter=dot --changed origin/main`.
  - Cannot-skip gates selected: `training-routes-entitlement`,
    `training-plan-create-e2e`, `cost-guardrail-global-rest`.
- No Vitest, XCTest, UI test, staging, production, live provider write, or real
  calendar readback was run in round 3 because Felipe explicitly instructed:
  "Don't commit or run any tests unless if I specify to do it so."

### Round 3 Reward Summary

- Scoped reward command:
  - `node scripts/reward-check.mjs --area backend --handoff docs/agents/handoffs/2026-06-27-training-plan-creation-qa.md --advisory --changed-files .local/reward-runs/round3-training-files.txt`
  - Verdict: `WARN`
  - Score: 98
  - Hard failures: none
  - Mandatory checks: PASS 4
  - Skipped checks: optional `verify-deliverable` warning because the handoff
    does not declare an L1-L5 claim level.
  - Raw reward JSON: `.local/reward-runs/round3-training-reward.json`
- Owner-instruction skips:
  - Backend Vitest execution, iOS XCTest/UI tests, iOS build/simulator checks,
    staging, production, and live provider/calendar validation were not run
    because Felipe explicitly instructed not to run tests unless specified.

### Round 3 Part C Audit Notes

- Persisted/reported weekly-target fields now have a single scheduled-plan
  truth source for run, bike, swim, and strength in preview/create responses
  and stored `preferences_json`.
- The priority x modality matrix is covered at route unit level and real create
  integration level for running, cycling, swimming, triathlon, hybrid, and
  strength cases, with scheduled session counting used as the oracle.
- iOS objective reset uses auto-default value heuristics (`triathlon` bike/swim
  `2`, cycling bike `4`, swimming swim `4`) so custom non-default counts are
  preserved.
- Secretary same-shape/same-slot idempotent reuse is preserved for active
  rows; cleanup-state rows now force a new version.
- Delete-retry cleanup keeps provider ids when `providerSyncState` is
  `delete_failed`; terminal deleted rows with no provider id are no-op only.

### Round 3 Residual Risks

- Round-3 tests were added but not executed due the explicit no-tests
  instruction.
- The iOS Swift changes received static diff validation only; no build/XCTest/
  simulator validation was run this round.
- No real OAuth provider, staging, production, PM2, or live calendar readback
  proof was collected.
- The full backend and iOS worktrees still contain unrelated dirty files from
  prior work; use the scoped Training commit set below.

### Round 3 Training-Only Commit Set

Backend:
- `src/api/routes/training-plan-generation.ts`
- `src/services/training-plan-volume-enforcement.ts`
- `src/services/secretary-scheduling-arbitrator.ts`
- `src/services/secretary-agenda-provider-sync.ts`
- `__tests__/api/training-plan-generation.test.ts`
- `__tests__/api/training-plan-persistence.test.ts`
- `__tests__/integration/training-plan-create-cycle.test.ts`
- `__tests__/services/training-plan-volume-enforcement.test.ts`
- `__tests__/services/training-coach-kernel-weekly-targets.test.ts`
- `__tests__/services/secretary-scheduling-arbitrator.test.ts`
- `__tests__/services/secretary-agenda-provider-sync.test.ts`
- `docs/agents/handoffs/2026-06-27-training-plan-creation-qa.md`

iOS:
- `Nexus Hub/Views/Training/TrainingView.swift`
- `Nexus HubTests/TrainingPlanBuilderPrefillTests.swift`

Excluded dirty files remain the backend portal/token/release/config files and
iOS generated artifacts already listed above.

---

## Round 4 Addendum - 2026-06-28

### Scope

Round-4 independent QA cleared the root-cause fix and asked for final
micro-fixes before shipping: count reported weekly targets from the finalized
scheduled plan, narrow Secretary agenda non-reuse states back to cleanup-only,
remove dead strength helper code, and make iOS objective/default reset track
auto-applied values instead of guessing from magic counts.

### Round 4 Fixes

- Backend weekly targets are rebuilt after persistence finalization.
  - `src/api/routes/training-plan-generation.ts`
  - `preferences_json`, preview `weeklyTargets`, and create response targets
    now use finalized `planData`, excluding sessions whose `scheduleState` is
    `unscheduled`, `canceled`, or `cancelled`.
  - Tests pin mid-week week-1 unscheduled sessions and all-week unscheduled
    swim sessions so reported targets match what lands on the calendar.
- Backend Secretary same-slot reuse is narrowed to true cleanup states only.
  - `src/services/secretary-scheduling-arbitrator.ts`
  - Non-reusable agenda lifecycle states are now `canceled`, `superseded`, and
    `unscheduled`; `completed` and `deferred` reuse remains idempotent.
  - Tests cover deferred same-slot idempotency, completed same-slot provider
    preservation, and unscheduled cleanup rows forcing a fresh active row.
- Backend volume enforcement cleanup is complete.
  - `src/services/training-plan-volume-enforcement.ts`
  - Removed dead `resolveSchedulableStrengthSessionsPerWeek`.
  - Added cardio modality trimming so duplicate cycling/swimming sessions are
    capped by explicit targets and default multisport floors.
- iOS objective/default reset now uses auto-applied flags.
  - `Nexus Hub/Views/Training/TrainingView.swift`
  - Objective switches reset stale running priority as well as stale auto
    bike/swim defaults, while preserving manual counts even when they equal
    template values.
  - Stepper bindings mark run/bike/swim/strength values as manual when edited.

### Round 4 New Coverage

Backend:
- `__tests__/api/training-plan-generation.test.ts`
  - Finalized unscheduled sessions do not inflate weekly targets.
  - All-week unscheduled swim sessions reduce swim target to zero.
- `__tests__/integration/training-plan-create-cycle.test.ts`
  - Real route matrix seeds complete sport profiles and asserts response,
    stored preferences, and scheduled sessions stay aligned.
- `__tests__/services/secretary-scheduling-arbitrator.test.ts`
  - Deferred same-slot resubmit is idempotent.
  - Completed same-slot resubmit reuses the completed row and does not recreate
    provider events.
  - Unscheduled cleanup rows still produce a fresh active row.
- `__tests__/services/training-plan-volume-enforcement.test.ts`
  - Dead helper references removed; tests assert real scheduled strength and
    cardio counts.

iOS:
- `Nexus HubTests/TrainingPlanBuilderPrefillTests.swift`
  - Stale running priority resets on objective switch.
  - Manual counts matching auto templates are preserved.
- `Nexus HubTests/NavigationPerformanceSourcePinsTests.swift`
  - Training source pin now expects the binding-backed steppers.

### Round 4 Validation Evidence

- `npm run typecheck`
  - Passed.
- Focused backend Training/Secretary/kernel/volume Vitest:
  - `NODE_ENV=test DATABASE_PATH=:memory: TZ=Europe/Lisbon npx vitest run __tests__/api/training-plan-generation.test.ts __tests__/api/training-plan-persistence.test.ts __tests__/api/training-routes.test.ts __tests__/integration/training-plan-create-cycle.test.ts __tests__/services/training-plan-volume-enforcement.test.ts __tests__/services/training-coach-kernel-weekly-targets.test.ts __tests__/services/secretary-scheduling-arbitrator.test.ts __tests__/services/secretary-agenda-provider-sync.test.ts`
  - Passed: 8 files, 234 tests.
- `npm run release:focused-verify`
  - Passed.
  - Selected full local release verification.
  - Vitest passed: 863 files, 12,667 tests.
  - Content-engine pytest passed: 181 tests.
- iOS Debug UI Smoke real build:
  - `xcodebuild -project "/Users/felipedominguez/Developer/Nexus Hub IOS/Nexus Hub/Nexus Hub.xcodeproj" -scheme "Nexus Hub Debug UI Smoke" -configuration Debug -destination "id=02ED1724-41B4-4711-891B-0D753375B9C5" -derivedDataPath "/Users/felipedominguez/Developer/Nexus Hub IOS/Nexus Hub/DerivedData" build`
  - Passed: `** BUILD SUCCEEDED **`.
- iOS focused unit/source-pin test:
  - `xcodebuild -project "/Users/felipedominguez/Developer/Nexus Hub IOS/Nexus Hub/Nexus Hub.xcodeproj" -scheme "Nexus Hub" -configuration Debug -destination "id=02ED1724-41B4-4711-891B-0D753375B9C5" -derivedDataPath "/Users/felipedominguez/Developer/Nexus Hub IOS/Nexus Hub/DerivedData" -only-testing:"Nexus HubTests/TrainingPlanBuilderPrefillTests" -only-testing:"Nexus HubTests/TrainingPlanBuilderSummaryResolverTests" -only-testing:"Nexus HubTests/NavigationPerformanceSourcePinsTests/test_trainingPlanBuilderPinsTodayPolicyStrengthDefaultsAndActiveCalendarSource" test`
  - Passed: 30 tests.
- iOS focused UI subset:
  - `xcodebuild -project "/Users/felipedominguez/Developer/Nexus Hub IOS/Nexus Hub/Nexus Hub.xcodeproj" -scheme "Nexus Hub Debug UI Smoke" -configuration Debug -destination "id=02ED1724-41B4-4711-891B-0D753375B9C5" -derivedDataPath "/Users/felipedominguez/Developer/Nexus Hub IOS/Nexus Hub/DerivedData" -only-testing:"Nexus HubUITests/TrainingFixtureBypassUITests" -only-testing:"Nexus HubUITests/TrainingValidationUITests" test`
  - Passed: 22 tests, 0 failures.
  - Result bundle: `/Users/felipedominguez/Developer/Nexus Hub IOS/Nexus Hub/DerivedData/Logs/Test/Test-Nexus Hub Debug UI Smoke-2026.06.28_13-08-51-+0100.xcresult`.

### Round 4 Claim And Limits

- Claim: L4 predeploy local/simulator evidence for the scoped backend Training
  and iOS Training builder changes. The L1 hygiene claim is also satisfied by
  the explicit evidence commands above.
- Limits: this claim does not cover live provider/OAuth writes, real calendar
  provider readback, physical-device two-account validation, TestFlight/App
  Store delivery, or production health until the deploy/postdeploy step below
  is completed and recorded.

### Round 4 Residual Risks

- No real OAuth provider/calendar write or physical-device two-account
  Training create flow was performed.
- Production deploy and postdeploy health are part of this round's remaining
  ship step and must be recorded after promotion.
- Backend worktree still contains unrelated dirty portal/docs/config files;
  the Training commit must stage only the allowlisted paths.
- iOS worktree still contains untracked generated `DerivedData/` and
  `test-summary.json`; they must remain uncommitted.

### Round 4 Reward Summary

- Scoped reward command:
  - `node scripts/reward-check.mjs --area backend --handoff docs/agents/handoffs/2026-06-27-training-plan-creation-qa.md --advisory --changed-files .local/reward-runs/round4-training-files.txt --json --output .local/reward-runs/round4-training-reward.json`
  - Verdict: `PASS`
  - Score: 100
  - Hard failures: none
  - Mandatory checks: PASS 5
  - Optional checks: `verify-deliverable` PASS for L1 handoff hygiene.
  - Skipped checks: none
  - Raw reward JSON: `.local/reward-runs/round4-training-reward.json`
  - Export eligibility: ineligible until manual human review.
