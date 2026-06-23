# Claude Code QA Prompt - Training Plan UX And Quality Matrix

You are Claude Code performing an independent code-level review only. Do not
interact with the iOS simulator, Xcode UI, browser, production services,
staging services, real calendar providers, Hotmail/Gmail accounts, or live
provider data. Do not claim runtime/user-visible behavior unless it follows
directly from code or from the test evidence listed here.

## Original Goal

Felipe asked Codex to implement Training Skill UX and validation fixes:

- Preserve the existing Training flow: Skills Hub -> Training -> Today / Plan / Progress.
- Keep token-zero REST contracts; do not replace Training with chat-prompt shortcuts.
- Improve plan creation UX with a mandatory review summary before preview/create.
- Keep preview-before-create mandatory; create only appears/fires after the preview fingerprint matches current options.
- Use `nexushubbot@hotmail.com` as the Training validation QA account.
- Keep `nexushubbot@gmail.com` separate as the local simulator/debug-auth sandbox account.
- Validate plan creation with a bounded quality matrix covering output quality, training quality, calendar/agenda quality, evidence structure, progression, adaptation, safety, and variation.
- Make agenda matching symmetric across `sessionIdentityKey` and `sessionId`, while avoiding mixed-key over-match.
- Compare agenda status with `planned`, `scheduled`, and `synced` as equivalent; skipped/canceled/deferred sessions stay excluded.
- Add quality dimensions for `deload_logic`, standalone `safety_downgrades`, expanded `equipment_fit`, and `objective_fidelity`.
- Keep `weight_loss` runtime behavior unchanged; add QA scorer detection only.
- Add `optional` two-a-day coverage and limited-calendar-capacity scenarios.
- Add iOS resolver/UI coverage for event item text, Portuguese labels, event-without-race-date warning, many-stacked-sessions warning, direct calendar-label helper behavior, summary-before-preview ordering, preview/create gating, active-plan fallback, and wearable-skip scope isolation.
- Do not deploy, commit, push, TestFlight, or perform production/staging/live Hotmail/calendar writes without explicit owner authorization.

## What Was Implemented

Backend:

- `src/services/training-plan-creation-validation.ts`
  - Defines `TRAINING_PLAN_CREATION_QA_ACCOUNT_EMAIL = "nexushubbot@hotmail.com"`.
  - Defines `TRAINING_PLAN_CREATION_LOCAL_SIMULATOR_ACCOUNT_EMAIL = "nexushubbot@gmail.com"`.
  - Defines 17 validation axes, including `twoADayPreference.optional` and `calendarCapacityState`.
  - Builds 50 bounded validation scenarios and 50 static/offline quality matrix rows.
  - Scores output quality, training quality, calendar quality, evidence structure, progression, and variation.
  - Adds the evidence baseline: WHO, ACSM GETP, ACSM RT 2026, IOC REDs, endurance TID review, and HIIT/MICT review.
  - Implements status equivalence and active exclusion for skipped/canceled/deferred sessions.
  - Tightens agenda matching to prefer exact `sessionIdentityKey` matches before falling back to `sessionId`, and only falls back to keyless agenda items.
  - Implements quality dimensions including `deload_logic`, `safety_downgrades`, expanded `equipment_fit`, and `objective_fidelity`.
- `src/tools/training-plan-creation-validation-matrix.ts`
  - Emits the validation matrix, quality matrix, science baseline, write-authorization flags, and the local simulator account email.
- `src/api/routes/training-plan-generation.ts`
  - Persists `twoADayPreference` in `preferences_json` so created plans retain `optional` / `preferred` / `never` selections.
- `package.json`
  - Adds `training:plan-validation-matrix`.
- `__tests__/services/training-plan-creation-validation.test.ts`
  - Covers axis completeness, quality-matrix row completeness, deterministic matrix output, mixed agenda keys, status drift/equivalence, colliding session ids, CLI top-level booleans, quality dimensions, warning verdicts, and deload/safety checks.
- `__tests__/integration/training-plan-create-cycle.test.ts`
  - Adds persistence coverage for all supported two-a-day preferences: `preferred`, `optional`, and `never`.
- `__tests__/services/nexus-points.test.ts`
  - Pins a deterministic test clock to keep unrelated May 2026 credit fixtures valid, closing the release/risk-gate blocker without changing product runtime code.

iOS:

- `Nexus Hub/Views/Training/TrainingPlanBuilderSummaryResolver.swift`
  - Adds a direct `calendarLabel(...)` helper.
  - Adds optional two-a-day summary text.
  - Builds pre-preview summary and preview story items.
- `Nexus Hub/Views/Training/TrainingView.swift`
  - Adds `Optional` to the two-a-day picker.
  - Preserves `optional` in plan-builder prefill instead of collapsing it to `auto`.
  - Renders the review summary before notes/preview/create.
  - Keeps existing fingerprint-based preview/create gating.
  - Adds preview story pills.
- `Nexus Hub/Views/Training/Today/TrainingFirstRunWearableSkipStore.swift`
  - Scopes wearable skip state by authenticated scope and migrates the legacy global key.
- `Nexus Hub/Views/Training/Today/TrainingFirstRunGateView.swift`
  - Uses the scoped wearable-skip store.
- `Nexus Hub/Core/Repositories/TrainingRepository.swift`
  - Uses `/training/plan/weeks` plan metadata as an active-plan fallback only when `lifecycleState == "active"`.
- `Nexus Hub/Core/TrainingLocalSmokeFixtures.swift`
  - Clears only the current fixture account's scoped wearable-skip state during DEBUG fixture setup, preserving the legacy leak test path.
- `Nexus HubTests/TrainingPlanBuilderSummaryResolverTests.swift`
  - Adds Portuguese/event/stacked-session/calendar-helper coverage, including event tile value branches for race date, event without date, maintenance, return, and continuous.
- `Nexus HubTests/TrainingRepositoryAllWeeksTests.swift`
  - Adds positive active-plan fallback coverage and a negative no-plan branch that keeps the first-run gate active.
- `Nexus HubUITests/TrainingFixtureBypassUITests.swift`
  - Adds summary-before-preview/create-gated fixture coverage and wearable-skip scope-isolation UI coverage.

## Files To Inspect

Backend:

- `package.json`
- `src/api/routes/training-plan-generation.ts`
- `src/services/training-plan-creation-validation.ts`
- `src/tools/training-plan-creation-validation-matrix.ts`
- `__tests__/integration/training-plan-create-cycle.test.ts`
- `__tests__/services/training-plan-creation-validation.test.ts`
- `__tests__/services/nexus-points.test.ts`
- `docs/qa/TRAINING_PLAN_UX_VALIDATION_CLAUDE_QA_PROMPT.md`
- `docs/_workspace-mirror/docs/agents/handoffs/2026-06-23-training-plan-ux-validation.md`

iOS:

- `/Users/felipedominguez/Developer/Nexus Hub IOS/Nexus Hub/Nexus Hub/Core/Repositories/TrainingRepository.swift`
- `/Users/felipedominguez/Developer/Nexus Hub IOS/Nexus Hub/Nexus Hub/Core/TrainingLocalSmokeFixtures.swift`
- `/Users/felipedominguez/Developer/Nexus Hub IOS/Nexus Hub/Nexus Hub/Views/Training/TrainingView.swift`
- `/Users/felipedominguez/Developer/Nexus Hub IOS/Nexus Hub/Nexus Hub/Views/Training/TrainingPlanBuilderSummaryResolver.swift`
- `/Users/felipedominguez/Developer/Nexus Hub IOS/Nexus Hub/Nexus Hub/Views/Training/Today/TrainingFirstRunGateView.swift`
- `/Users/felipedominguez/Developer/Nexus Hub IOS/Nexus Hub/Nexus Hub/Views/Training/Today/TrainingFirstRunWearableSkipStore.swift`
- `/Users/felipedominguez/Developer/Nexus Hub IOS/Nexus Hub/Nexus HubTests/TrainingPlanBuilderSummaryResolverTests.swift`
- `/Users/felipedominguez/Developer/Nexus Hub IOS/Nexus Hub/Nexus HubTests/TrainingRepositoryAllWeeksTests.swift`
- `/Users/felipedominguez/Developer/Nexus Hub IOS/Nexus Hub/Nexus HubUITests/TrainingFixtureBypassUITests.swift`

Preserve awareness:

- `/Users/felipedominguez/Developer/Nexus Hub IOS/Nexus Hub/test-summary.json` is pre-existing untracked state and should not be attributed to this work.

## Expected Behavior

- Training remains in the existing Skills Hub -> Training -> Today / Plan / Progress flow.
- The create-plan sheet shows a derived summary before preview.
- The CTA remains a preview CTA until the current inputs match an accepted preview fingerprint.
- Changing inputs invalidates create readiness.
- `optional` is preserved as a two-a-day option in UI prefill, picker state, backend create payload, and persisted plan preferences.
- A locally created active plan dismisses the iOS first-run gate when the all-weeks endpoint has active plan metadata, even if narrower Today/Week state is delayed.
- A null or inactive all-weeks plan does not synthesize an active plan and keeps the first-run gate active.
- Static/offline matrix generation performs no writes.
- Hotmail is only the Training validation QA identity; Gmail remains local debug-auth only.
- Agenda matcher accepts either identity key or session id, but avoids matching an agenda item with a conflicting identity key only because `sessionId` collides.
- `planned`, `scheduled`, and `synced` are equivalent; skipped/canceled/deferred sessions are excluded.
- Quality scoring is deterministic and non-diagnostic.
- `weight_loss` is detected as a QA objective-fidelity warning without changing runtime `inferTrainingPlanGoal(...)`.

## Tests And Checks Already Performed

Treat these as Codex-provided evidence; inspect skeptically, but do not rerun in
this Claude code-level prompt.

- `scripts/changed-area-classifier.sh --json`
  - PASS. Selected full Vitest and cannot-skip Training create coverage.
- `npx vitest run __tests__/services/training-plan-creation-validation.test.ts __tests__/integration/training-plan-create-cycle.test.ts`
  - PASS: 2 files, 19 tests.
- `npm run training:plan-validation-matrix -- --qa-account=nexushubbot@hotmail.com`
  - PASS: 50 scenarios, 50 quality rows, duplicate scenario ids `[]`, missing axis coverage `[]`, verdict counts `{ pass: 49, warn: 1, fail: 0 }`.
  - Top-level output includes `authorizationRequired: true`, `productionWritesForbiddenByDefault: true`, and `localSimulatorAccountEmail: "nexushubbot@gmail.com"`.
- `npx vitest run __tests__/services/nexus-points.test.ts --reporter=verbose`
  - PASS: 1 file, 11 tests.
- `npm run release:focused-verify`
  - PASS. Full selected release verification completed: 859 Vitest files / 12,572 tests passed, 181 Python tests passed, typecheck/science-policy/build/migration safety passed.
- `npm run release:verify:full`
  - PASS. Full release verification completed with the same passing counts.
- `scripts/risk-gate.sh`
  - PASS. Gating option (a) was taken: the unrelated Nexus Points fixture-time drift was fixed.
- XcodeBuildMCP `build_sim`, scheme `Nexus Hub`, Debug.
  - PASS. Build log: `/Users/felipedominguez/Library/Developer/XcodeBuildMCP/workspaces/cortex-telegram-hub-bot-f9372b678f4b/logs/build_sim_2026-06-23T20-48-32-033Z_pid8790_156e616d.log`.
- XcodeBuildMCP selected iOS unit tests:
  - `TrainingRepositoryAllWeeksTests`
  - `TrainingPlanBuilderSummaryResolverTests`
  - `TrainingFirstRunWearableSkipStoreTests`
  - `TrainingFirstRunGateResolverTests`
  - PASS: 24 selected tests, 0 failed.
  - Result bundle: `/Users/felipedominguez/Library/Developer/XcodeBuildMCP/workspaces/cortex-telegram-hub-bot-f9372b678f4b/result-bundles/test_sim_2026-06-23T20-49-13-174Z_pid8790_270b9f0d.xcresult`.
- XcodeBuildMCP `Nexus Hub Debug UI Smoke`, selected `TrainingFixtureBypassUITests`.
  - Final rerun PASS: 18 tests, 0 failed, 0 skipped.
  - Result bundle: `/Users/felipedominguez/Library/Developer/XcodeBuildMCP/workspaces/cortex-telegram-hub-bot-f9372b678f4b/result-bundles/test_sim_2026-06-23T21-08-09-718Z_pid8790_afba18d8.xcresult`.
- `npm run docs:audit`
  - PASS exit 0 with existing warning baseline.

## Areas Claude Should Inspect Carefully

- Whether the matrix axes really match current iOS/backend accepted values.
- Whether `optional` should be sent to backend as a first-class value everywhere, or only in plan builder paths.
- Whether `calendarCapacityState` is clearly QA-only and cannot affect runtime API contracts accidentally.
- Whether identity-key-priority agenda matching still handles mixed-key legitimate matches without over-matching collisions.
- Whether duplicate detection is still correct when one agenda item carries both identity and session id.
- Whether status comparison should treat any additional statuses as equivalent or excluded.
- Whether the quality matrix synthetic candidate generation hides edge cases by producing recovery/mobility fallback sessions.
- Whether deload rebound logic is too permissive or too strict.
- Whether `weight_loss` warning behavior is code-level QA only and does not alter runtime `inferTrainingPlanGoal(...)`.
- Whether iOS summary text can overflow under large Dynamic Type.
- Whether the all-weeks active-plan fallback can conflict with a newer Today/Week response that intentionally reports no active plan.
- Whether clearing scoped wearable skip state in DEBUG local fixture setup is properly limited to the current fixture account.
- Whether persisting `twoADayPreference` in backend preferences is enough for every downstream read model that needs to display or regenerate the plan.
- Whether new accessibility identifiers are stable and unique.
- Whether scoped wearable skip handles nil/empty authenticated scope safely.
- Whether any private health/calendar/provider/raw debug text can leak into matrix output.

## Edge Cases To Verify Statically

- Mixed agenda keys: plan has identity but agenda has only session id; plan has identity and agenda has only identity.
- Colliding agenda keys: agenda has same `sessionId` but a different `sessionIdentityKey`.
- Status: planned/scheduled/synced equivalence; completed/canceled/skipped/deferred handling.
- Date/time: no race, near race, normal race, far race, DST time bucket.
- Weekly structure: 3/5/7 total sessions, 0/7 run/cardio, 0/6 strength, fallback recovery/mobility sessions.
- Two-a-day: auto, optional, preferred, never.
- Calendar: no connected calendar, Google, Outlook, both prefer Outlook, limited capacity.
- Readiness: no data, stale wearable data, high readiness, low readiness, soreness/fatigue, high recent load, missed sessions, red flag.
- Equipment: bodyweight, dumbbells, full gym, hotel gym, limited/travel.
- Profile/questionnaire: complete, fitness missing, objective missing, questionnaire pending.
- iOS active-plan fallback: active all-weeks plan, inactive all-weeks plan, null all-weeks plan, and no-plan Today/Week/Progress endpoints.

## Known Risks And Assumptions

- Claude cannot validate simulator behavior in this prompt.
- Live Hotmail/provider/calendar E2E was not run and remains blocked without explicit owner authorization.
- Local-engine create/write E2E was previously authorized locally only; no production/staging/provider writes were performed in this closeout pass.
- Calendar/agenda creation with a real provider remains live/staging-authorized-only.
- The quality matrix is bounded axis coverage, not the full Cartesian product.
- Evidence checks validate training reasonableness and safety flags only; they do not diagnose medical conditions.

## Requested Claude Output

Return findings first, ordered by severity, with file and line references. Then
answer:

1. Does the code match the implementation plan at code level?
2. Are the residual Claude re-review fixes closed?
3. Are there any runtime-risky API or decoder changes?
4. Are account/write boundaries respected in code and tests?
5. Are the matrix columns complete and deterministic?
6. Are there missing code-level tests that should block release discipline?
