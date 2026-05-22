# Claude Code QA Prompt — Training Skill Trust Wedge 2026-05-22

You are Claude Code independently reviewing the Training Skill Trust Wedge implementation across the backend and iOS worktrees.

## Original goal

Make first Training plan creation more trustworthy by explaining what Nexus chose, what it respected from the user's request, and what deserves attention. The wedge should expose smart plan decisions without turning flat defaults into fake intelligence, and it should reuse proven Decision Center primitives where appropriate.

The roadmap source of truth is:

- Backend: `/Users/felipedominguez/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot-training-trust-wedge-20260522/docs/training/training-skill-trust-wedge-roadmap-20260522.md`
- iOS: `/Users/felipedominguez/Desktop/Nexus Hub IOS/worktrees/training-trust-wedge-20260522`

## What was implemented

Backend:

- Added a Training-native `PlanCreationExplanation` contract with schema versioning, smart picks, respected constraints, attention items, evidence snippets, and Decision Center `DecisionWhy` reuse.
- Exported `DECISION_CONFIDENCE_RUBRIC` from Decision Center instead of duplicating confidence constants.
- Integrated explanation generation into `buildCoachKernelTrainingPlan`.
- Added `explanation` to preview, quality-blocked, and created plan responses.
- Persisted explanation JSON and schema version on `fitness_training_plans` via migration `155_training_plan_creation_explanation.sql`.
- Parsed persisted explanation back into Training read models.
- Added sample payloads for representative plan-creation scenarios.
- Expanded builder tests to cover smart pick, constraint, attention, sanitizer, stale readiness, goal-mode cap, weekly-volume inference, equipment fallback, and persistence round-trip behavior.
- Closed QA follow-up P3s by documenting that sample payloads are intentionally abbreviated, pinning that documentation with a regression test, and documenting why respected constraints do not carry evidence arrays.

iOS:

- Added `PlanCreationExplanation` Codable models.
- Extended `PlanGenerateResponse` to decode/encode `explanation`.
- Added `PlanCreationExplanationCard` for the preview flow.
- Rendered the card under the plan preview in `TrainingView`.
- Added tests for decoding, semantic label preference over fallback copy, and confidence bucket labels.
- Closed the reserved-severity follow-up by treating future `block` attention severity with the warning tone/icon instead of the neutral accent path.

## Files changed

Backend worktree:

- `src/services/training-plan-explanation/types.ts`
- `src/services/training-plan-explanation/builder.ts`
- `src/services/decision-center-logic-v2.ts`
- `src/services/training-coach-kernel-plan-generator.ts`
- `src/services/training-plan-coordination.ts`
- `src/services/training-plans.ts`
- `src/api/routes/training-plan-generation.ts`
- `src/api/routes/training-plan-persistence.ts`
- `src/api/routes/training-read-models.ts`
- `migrations/155_training_plan_creation_explanation.sql`
- `__tests__/services/training-plan-explanation-builder.test.ts`
- `__tests__/services/training-plans.test.ts`
- `__tests__/api/training-plan-generation.test.ts`
- `__tests__/api/training-read-models.test.ts`
- `docs/training/training-plan-explanation-samples-20260522.json`
- `docs/training/training-skill-trust-wedge-roadmap-20260522.md`
- `docs/training/claude-code-qa-training-trust-wedge-20260522.md`

iOS worktree:

- `Nexus Hub/Core/Models/PlanCreationExplanation.swift`
- `Nexus Hub/Core/Services/TrainingService.swift`
- `Nexus Hub/Views/Training/TrainingView.swift`
- `Nexus Hub/Views/Training/PlanCreationExplanationCard.swift`
- `Nexus HubTests/PlanCreationExplanationTests.swift`

Feature ledger artifact outside git:

- `/Users/felipedominguez/Desktop/Nexus Hub/docs/release/feature-delivery-ledger.md`

## Expected behavior

- Previewing or generating a Training plan returns an optional `explanation` object.
- The explanation separates:
  - `smartPicks`: decisions Nexus inferred from profile, objective, race window, readiness, history, goal mode, or plan shape.
  - `respectedConstraints`: explicit request fields Nexus honored, such as session counts, preferred times, long-session day, and start policy.
  - `attentionItems`: low-confidence, stale, fallback, or data-quality facts the user may want to fix.
- Request-sourced values must never appear as smart picks.
- Raw defaults should stay hidden unless disclosure improves trust, such as no readiness data or equipment fallback.
- Evidence snippets must be sanitized and bounded; user-facing iOS copy should prefer semantic keys over backend fallback prose.
- Persisted plans should retain the explanation for read-model surfaces.
- Older iOS payloads without `explanation` should continue decoding.

## Tests and checks already performed

Backend:

```bash
npx tsc --noEmit
npx vitest run \
  __tests__/services/training-plan-explanation-builder.test.ts \
  __tests__/api/training-plan-generation.test.ts \
  __tests__/api/training-read-models.test.ts \
  __tests__/services/training-plans.test.ts
# 4 files / 83 tests passed

npm run verify
# 640 files / 9474 tests passed
```

iOS via XcodeBuildMCP simulator profile `nexus-ios-trust-wedge`:

```text
Nexus HubTests/PlanCreationExplanationTests
Nexus HubTests/PlanGenerateResponseRaceDateTests
Nexus HubTests/PlanGenerateResponseExpertCoachTests
Nexus HubTests/PlanGenerateResponsePrimaryFocusTests
Nexus HubTests/TrainingPresentationTests
Nexus HubTests/TrainingViewModelGoalModeEchoTests
Nexus HubTests/TrainingViewModelObservationTests
# 86 tests passed
```

## Areas to inspect carefully

1. Contract shape:
   - Does `PlanCreationExplanation` have enough structure for iOS localization without relying on English fallback strings?
   - Are `labelKey` values stable and specific enough?
   - Does the summary use useful counts and severity semantics?

2. Honesty boundary:
   - Confirm request-sourced fields are only in `respectedConstraints`.
   - Confirm raw defaults do not masquerade as smart picks.
   - Confirm low-confidence fallback rows are represented as attention/data-quality items, not scary blockers.

3. Generator integration:
   - Trace from `buildCoachKernelTrainingPlan` to preview/create route response.
   - Verify explanation generation uses already-resolved plan facts instead of re-resolving differently.
   - Confirm planId is null for preview and attached after persistence for created plans.

4. Persistence/read models:
   - Confirm migration 155 is additive and migration numbering is still safe against current main.
   - Confirm `createPlan` writes `explanation_json` and `explanation_schema_version`.
   - Confirm malformed or future-version explanation JSON fails closed to `null`.

5. iOS rendering:
   - Confirm the card layout is not too noisy on mobile.
   - Confirm the card appears for preview and does not require created-plan state.
   - Confirm fallback labels do not leak raw backend wording when semantic keys are known.
   - Confirm reserved/future attention severity values do not understate risk. In particular, `block` should render with warning tone/icon until a dedicated blocked-state design ships.
   - Confirm old payloads without explanation still render normally.

6. Privacy and safety:
   - Check evidence truncation and control-character stripping.
   - Look for full raw objective/profile leakage in persisted explanation.
   - Confirm no secrets, token data, or large profile dumps can be persisted in evidence.

7. Test adequacy:
   - Challenge whether builder coverage is broad enough across categories.
   - Identify any missing regression tests around preview vs create, quality-blocked responses, or read-model parsing.

## Edge cases to verify

- Missing objective or unrecognized objective.
- No wearable/readiness data.
- Stale wearable provider data.
- Equipment profile missing/fallback.
- Explicit 6 run + 5 strength request: run/strength counts should be respected constraints, not smart picks.
- Goal-mode volume cap: should show what changed and why.
- Race-calendar phase inference.
- Older app/client payloads missing `explanation`.
- Future schema version in persisted JSON.
- Huge objective strings and control characters in objective/evidence.
- Portuguese UI: verify semantic labels are acceptable and no English-first backend fallback dominates.

## Known risks or assumptions

- TestFlight smoke was not run from this local session; it requires the normal app distribution lane.
- Backend staging deploy/smoke was intentionally deferred until independent QA accepts the contract.
- PR3 historical `GET /training/plan/:id/explanation` endpoint remains deferred until the feature soaks in production for at least one week.
- Sample payloads are committed for review, but the QA reviewer should verify they match actual builder behavior and do not drift.
- Sample payloads are explicitly documented as abbreviated examples. Treat `src/services/training-plan-explanation/types.ts` and `__tests__/services/training-plan-explanation-builder.test.ts` as the runtime contract source of truth.
- `PlanExplanationSeverity.block` is still reserved and is not emitted by the backend builder. iOS now renders it as warning if a future backend starts emitting it before a dedicated blocked design lands.
- The global Feature Delivery Ledger is outside a git repo on this machine, so it was updated as a local documentation artifact rather than committed with backend/iOS code.

## QA ask

Do not rubber-stamp the implementation. Review the backend and iOS diffs as if this is the first time you are seeing the trust wedge. Verify the source-to-UI path, then run focused tests of your choice. Report blockers/highs/mediums with file:line references, and explicitly state whether this is ready for staging smoke.
