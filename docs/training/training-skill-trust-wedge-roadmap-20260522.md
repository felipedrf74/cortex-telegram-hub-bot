# Training Skill Trust Wedge — Roadmap 2026-05-22

Status: PLAN (no code yet)
Owner: Felipe (with Claude/Codex execution)
Last updated: 2026-05-22
Update policy: living doc. PR0/PR1/PR2 close-out updates land in this file as each ships.
Codex critical review: 2026-05-22 (see §18 before starting PR0).

> This document is the **handoff artifact** between Claude's Phase 1-4 feature-dev work (discovery → exploration → clarifying questions → architecture design) and the code-execution phase. Read this in order; every section answers a specific design decision.

---

## 1. Executive Summary

**Feature**: Make the Training skill more reliable, trustworthy, intelligent, and user-friendly for **first plan creation** — the moment of maximum user doubt.

**Wedge**: When the user clicks "Create training plan" in the iOS Plan Builder, they receive a structured `PlanCreationExplanation` payload that surfaces *only the smart picks* the system made (inferred decisions, not flat defaults). iOS renders this as a "what Nexus chose for you and why" card with confidence pills, expandable 5-bucket why-sections, and coach principle attributions.

**Horizon**: Roadmap-scale multi-week. The wedge is Phase 1. Phase 2 (adaptive intelligence), Phase 3 (reliability sweep), and Phase 4 (inline-editable preview) stack on top of the wedge's extension hooks without refactor.

**Out of scope for this roadmap**: Phase 2/3/4 implementations are designed-for but NOT planned in detail here. This roadmap covers Phase 1 (the trust wedge) only.

---

## 2. Decisions Ledger

All locked decisions from Phase 1-4 with reasoning.

| # | Decision | Rationale |
|---|---|---|
| D1 | **Dimension**: all four (reliability + trustworthiness + adaptive intelligence + user-friendly UX) | User selected multi-select; trust wedge is the entry point that unblocks the other three |
| D2 | **User pain**: first plan creation | Moment of maximum doubt; failure here discounts every downstream improvement |
| D3 | **Horizon**: roadmap-scale, multi-week | User explicit pick |
| D4 | **Defaults UX**: Show only SMART picks (not flat defaults) | Resolver `*WithSource` tuples already differentiate inferred vs raw; the filter is `source !== 'request' && source !== 'raw_default'` |
| D5 | **Architecture**: New training-native shape (NOT extending Decision Center's `DecisionLogicV2`) | Decision Center's payload has 30+ fields specific to user-facing decision cards (apnsEligible, displayMode, frontendActionState) that don't fit a read-only training disclosure. Reuse primitives (DecisionWhy, confidence rubric, freshness), not the whole envelope. |
| D6 | **Audit branch sequencing**: Merge `cortex-telegram-hub-bot-training-full-audit-20260522` to main FIRST | Resolves migration-153 collision (audit's `training_operation_locks.sql` vs production's `decision_center_explanations.sql`); audit branch also delivers durable SQLite locks + Outlook gating + iOS in-flight guards + `startPolicy: 'next_full_week'` default — eliminates the mid-week-Week-1 silent issue from the disclosure surface |
| D7 | **Persistence**: `explanation_json TEXT` + `explanation_schema_version INTEGER` columns on `fitness_training_plans` | Single JSON blob (rows read/written together, no field-level query value); schema_version sidecar enables forward migration without losing old rows |
| D8 | **PR strategy**: PR0 first (honest inputs), then PR1 (backend explanation), PR2 (iOS), PR3 deferred | Separate the trust-restoration bug fixes from the explanation surface so each ships independently with its own staging gate |
| D9 | **Dead code scope**: Tackle ALL THREE — compliance hardcode + stale_provider wiring + phase resolver consolidation | Honesty contract: never claim provenance from a signal you haven't actually computed (the 0.82 hardcode would have made every explanation chip a partial lie) |
| D10 | **Architecture choice**: Pragmatic (B), not Lean (A) or Clean (C) | Trust requires depth (5-bucket why) not just disclosure; roadmap-scale needs named hooks not formal abstractions; Decision Center primitives are SHIPPED + PROVEN |

---

## 3. Prerequisites

These must be true BEFORE PR0 starts.

### 3.1 Audit branch merged to main

**Branch**: `codex/training-skill-full-audit-20260522`
**Worktree**: `cortex-telegram-hub-bot-training-full-audit-20260522` at `96cfd84c`
**Blocker**: migration `153_training_operation_locks.sql` collides with production's already-shipped `153_decision_center_explanations.sql`.

**Resolution steps**:
1. On the audit branch: rename `migrations/153_training_operation_locks.sql` → `migrations/154_training_operation_locks.sql`.
2. Update any test that references the migration number (`__tests__/services/training-operation-locks.test.ts` line 68 has the filename literal — verify it's the only reference).
3. Update any QA/handoff doc that references "migration 153 (training_operation_locks)" → "migration 154".
4. Rebase audit branch onto current `origin/main` (`81fd5496`).
5. Confirm `npm run verify` passes.
6. Deploy staging → smoke 21/21 → promote.

**After**: my new migration becomes `155_training_plan_creation_explanation.sql`.

**Status**: NOT STARTED. Felipe or Codex owns this.

### 3.2 Branch + worktree readiness

**Backend worktree**: `cortex-telegram-hub-bot-training-trust-wedge-20260522` (created 2026-05-22)
**Backend branch**: `feature/training-trust-wedge-20260522` (tracking `origin/main` at `81fd5496`)
**iOS worktree**: `worktrees/training-trust-wedge-20260522` (created 2026-05-22)
**iOS branch**: `feature/training-trust-wedge-20260522` (tracking `origin/main` at `b42abe1`)

**Status**: ✅ Created.

### 3.3 Once audit branch lands

**Action**: rebase both `feature/training-trust-wedge-20260522` branches onto post-audit `origin/main`. Verify `migrations/` directory now has 154 (training_operation_locks). My migration becomes 155.

---

## 4. PR Sequence

| PR | Scope | LOC | Gate |
|---|---|---|---|
| **PR-prereq** | Audit branch merge (NOT my scope; Felipe/Codex) | — | Staging 21/21 |
| **PR0** | Honest inputs: per-modality counts wired, structured `decisionReasons` iOS decode, `primaryFocusSource` backend emission, real `trailing14DayCompliance`, `stale_provider` wiring, phase resolver consolidation | ~250 | Backend `npm run verify` + iOS unit + staging 21/21 |
| **PR1** | Backend explanation: new module `training-plan-explanation/`, migration 155, generator integration, route decoration, persistence | ~975 | Same gates + new builder vitest suite + sample-emission JSON inspection |
| **PR2** | iOS rendering: `PlanCreationExplanation.swift` + `TrainingDecisionReason.swift` + `PlanCreationExplanationCard.swift` + 5-bucket DisclosureGroup + confidence pills | ~730 | Xcode build clean + extended `PlanGenerateResponse*Tests.swift` + TestFlight smoke |
| **PR3** (deferred) | `GET /training/plan/:id/explanation` history endpoint + iOS detail view consumption | ~150 | After PR1+PR2 soak 1+ week in production |

**Total wedge**: ~1,955 LOC over 2.5-3 weeks (PR0 + PR1 + PR2). PR3 lands in Phase 2 sprint.

---

## 5. PR0 — Honest Inputs (~250 LOC, ~3-4 days)

The trust contract: never claim provenance from a signal you haven't computed.

### 5.1 Bug fix A — wire `runSessionsPerWeek` / `bikeSessionsPerWeek` / `swimSessionsPerWeek`

**Symptom**: iOS sends these fields (TrainingService.swift:266-274) but backend silently drops them. The "Corridas por semana" stepper in the UI does nothing.

**Files to touch**:
- `src/api/routes/training-plan-routes.ts` lines 58-73 (preview body destructure) and 161-176 (generate body destructure) — accept the three new fields.
- `src/api/routes/training-plan-generation.ts` lines 51-75 (`GenerateTrainingPlanForUserInput`) and 240-254 (destructure inside `generateTrainingPlanForUser`) — thread through.
- `src/services/training-coach-kernel-plan-generator.ts` lines 69-113 (`CoachKernelTrainingPlanInput`) — accept the three optional numbers.
- `src/services/training-coach-kernel-plan-generator.ts` lines 797-855 (`resolveWeeklyTargets`) — when caller-supplied per-sport counts exist, they override the focus-derived shape. Clamp each to 0..7. Rebalance the other modalities to total-strength-run when running is explicit.

**Test pin**: `__tests__/services/training-coach-kernel-primary-focus.test.ts` add cases: "runSessionsPerWeek=4 overrides marathon-default of 4-7", "bikeSessionsPerWeek + runSessionsPerWeek + swimSessionsPerWeek sum + strength = total".

**Estimated LOC**: 50.

### 5.2 Bug fix B — iOS structured `decisionReasons` decode

**Symptom**: kernel emits `TrainingDecisionReason` objects with code/text/severity/affectedEntity/sourceConstraint/before/after/preservedIntent/evidence (`src/services/coach-kernel/types.ts:485-525`), but iOS decodes as flat `[String]` of codes only (`TrainingService.swift:530-533`).

**Files to touch**:
- New file: `Nexus Hub/Core/Models/TrainingDecisionReason.swift` (~80 LOC) — mirrors the backend struct as a Codable Swift type.
- `Nexus Hub/Core/Services/TrainingService.swift` line 462: change `let decisionReasons: [String]` → `let decisionReasons: [TrainingDecisionReason]`.
- Same file lines 530-535: replace `DecisionReasonObject` decoder with structured decoder. Handle BOTH legacy `[String]` (map to `TrainingDecisionReason(code: $0, text: "", severity: .info, ...)`) AND new `[Object]` shape.
- Add computed accessor: `var decisionReasonCodes: [String] { decisionReasons.map(\.code) }` — preserves legacy call sites that do `result.decisionReasons.contains("RACE_DATE_MISSING")`.
- `Nexus Hub/ViewModels/TrainingViewModel.swift` line ~584: update `result.decisionReasons.first { code in ... }` → `result.decisionReasonCodes.first { code in ... }`.
- Test updates: `Nexus HubTests/PlanGenerateResponseRaceDateTests.swift` lines 42, 55 and `PlanGenerateResponseExpertCoachTests.swift` line 381 — switch assertions to `.decisionReasonCodes.contains(...)`.

**Estimated LOC**: 70.

### 5.3 Bug fix C — emit `primaryFocusSource` / `primaryFocusFallbackReason` / `primaryFocusRawObjective`

**Symptom**: iOS already decodes these fields (`TrainingService.swift:458-462`). Backend never emits them. The `primaryFocusResolution` is computed at `src/services/training-coach-kernel-plan-generator.ts:266-282` and discarded after a log line.

**Files to touch**:
- `src/services/training-coach-kernel-plan-generator.ts` lines 159-227 (`buildCoachKernelTrainingPlan`): capture `primaryFocusResolution` (currently lost) and attach to the returned `CoordinatedTrainingPlan` as `primaryFocus`, `primaryFocusSource`, `primaryFocusFallbackReason`, `primaryFocusRawObjective` sibling fields.
- `src/services/training-plan-coordination.ts` — `CoordinatedTrainingPlan` interface: add the four optional fields.
- `src/api/routes/training-plan-generation.ts` response builders at lines 537-562 (preview), ~668-714 (created), 579-596 (plan_quality_blocked): emit the four fields at the top level of the response data block.

**Estimated LOC**: 20.

### 5.4 Dead-code fix A — real `trailing14DayCompliance`

**Symptom**: `AthleteState.compliance.trailing14DayCompliance` is hardcoded to `0.82` at `src/services/training-coach-kernel-plan-generator.ts:538`. The entire `analyzeTrainingFeedback` classifier (`feedback-analysis.ts:354-365`) reads this fake value to derive `adherenceClass`.

**Files to touch**:
- `src/services/training-history.ts`: add new function `computeTrailingCompliance(userId: number, days: 14): number` that reads `training_completions` joined with `training_sessions` over the trailing 14-day window. Compliance = `completed_sessions / planned_sessions` clamped to `[0, 1]`. Return `0.82` (current placeholder) ONLY when there are zero planned sessions (cold start).
- `src/services/training-coach-kernel-plan-generator.ts` line 538: replace `trailing14DayCompliance: 0.82` with `trailing14DayCompliance: computeTrailingCompliance(input.userId)`.
- New test: `__tests__/services/training-history-compliance.test.ts` — pin: zero plans → 0.82 cold-start, 3/4 sessions completed → 0.75, 0/4 → 0.0, 4/4 → 1.0.

**Estimated LOC**: 40.

### 5.5 Dead-code fix B — wire `confidence: 'stale_provider'`

**Symptom**: `'stale_provider'` and `'manual_check_in'` ReadinessSnapshot enum values are typed but never assigned by any code path (`src/services/coach-kernel/types.ts:145`).

**Files to touch**:
- `src/api/routes/training-read-models.ts` lines 532-563 (`fetchCurrentReadinessForPlan`): when readiness data exists but the wearable's most-recent sync timestamp is >24h old, return `confidence: 'stale_provider'` instead of `'fresh_wearable'`. Source the sync timestamp from `garmin_sync_state.last_sync_at` or equivalent.
- `src/services/coach-kernel/readiness-snapshot-adapter.ts:96` — `readinessResultToSnapshot`: respect input.confidence (already does this; verify the stale-provider path produces `isStale: true` as a sibling marker).
- Test: `__tests__/api/training-read-models-readiness.test.ts` extension — pin "wearable last synced 25 hours ago → confidence: stale_provider, isStale: true".

**Estimated LOC**: 30.

### 5.6 Dead-code fix C — consolidate phase resolvers

**Symptom**: Two redundant phase resolvers:
- `resolveWeekPhase` in `src/services/training-coach-kernel-plan-generator.ts:1740-1773` (used today; simple race-date diff + goal-mode override).
- `inferPhase` in `src/services/coach-kernel/planner-engine.ts:60-77` (race-subtype-aware with `raceWindowDays` table at lines 38-58, e.g. ironman = 21d taper / 56d peak; supports readiness/injury overrides at line 61).

The generator's outer loop overwrites `currentBlock.phase` from `resolveWeekPhase` before calling `buildWeekPlan`. So `inferPhase` only fires when `currentBlock.phase` is unset (line 63 of planner-engine.ts: `if (athlete.currentBlock.phase) return athlete.currentBlock.phase;`).

**Resolution**: keep the race-subtype-aware `inferPhase` as the canonical resolver. Either:
- (a) Remove `resolveWeekPhase` from the generator and let `buildWeekPlan` derive the phase. RISK: changes the generator's per-week loop semantics; may regress goal-mode reasons.
- (b) Have `resolveWeekPhase` defer to `inferPhase` for race-subtype-specific tables (so the simpler resolver becomes the goal-mode + injury override layer on top of `inferPhase`).

**Recommendation**: (b) — lower-risk. The generator-level resolver stays in place but composes `inferPhase` for race window math. The `raceWindowDays` table starts driving real production behavior (ironman/marathon/half-marathon get correct taper/peak windows).

**Files to touch**:
- `src/services/training-coach-kernel-plan-generator.ts` lines 1740-1773: compose `inferPhase`-based race window logic into `resolveWeekPhase`. When `raceCalendar` has a next race, delegate phase calculation to `inferPhase` (which knows subtype-specific tables). When no race, keep the simpler base/build/deload logic.
- Test: `__tests__/services/training-coach-kernel-plan-generator.test.ts` — pin "marathon plan with race 56 days out → week N gets phase 'peak'", "ironman plan with race 21 days out → week N gets phase 'taper'", "no race + 4-week plan → weeks 1-2 base, week 3 build, week 4 deload".

**Estimated LOC**: 40 (carefully — this touches kernel brain logic).

### PR0 totals

| Component | LOC |
|---|---|
| Bug A — per-modality counts wired | 50 |
| Bug B — iOS structured decisionReasons + new Swift type + 2 test updates | 70 |
| Bug C — primaryFocusSource emission | 20 |
| Dead-code A — real compliance | 40 |
| Dead-code B — stale_provider wiring | 30 |
| Dead-code C — phase resolver consolidation | 40 |
| **Total** | **250** |

### PR0 verification gate

```bash
npx tsc --noEmit
npx vitest run \
  __tests__/api/training-plan-generation.test.ts \
  __tests__/api/training-routes.test.ts \
  __tests__/services/training-coach-kernel-plan-generator.test.ts \
  __tests__/services/training-history-compliance.test.ts \
  __tests__/api/training-read-models-readiness.test.ts \
  __tests__/services/training-coach-kernel-primary-focus.test.ts
npm run verify   # full backend
./scripts/deploy-staging.sh && ./scripts/staging-smoke.sh   # 21/21
```

iOS:
```bash
xcodebuild test -scheme "Nexus Hub" \
  -only-testing:"Nexus HubTests/PlanGenerateResponseRaceDateTests" \
  -only-testing:"Nexus HubTests/PlanGenerateResponseExpertCoachTests"
```

---

## 6. PR1 — Backend Explanation Builder (~975 LOC, ~5-7 days)

### 6.1 New types: `src/services/training-plan-explanation/types.ts` (~140 LOC)

Reused-from-Decision-Center primitives (import, don't redefine):
- `DecisionWhy` from `decision-center-logic-v2.ts:69-75` (5-bucket: facts/preferences/rules/tradeoffs/uncertainty)
- `DECISION_CONFIDENCE_RUBRIC` from `decision-center-logic-v2.ts:229-247`
- `DecisionConfidenceLabel = 'high' | 'medium' | 'low'`
- `DecisionSourceFreshness = 'live' | 'fresh' | 'stale' | 'unknown'`

New training-native types:

```ts
export type SmartPickCategory =
  | 'primary_focus'         // resolvePrimaryFocusWithSource
  | 'weekly_volume'         // resolveWeeklyTargets per-modality
  | 'experience_level'      // resolveExperienceLevelWithSource
  | 'strength_goal'         // resolveStrengthGoalWithSource
  | 'equipment_profile'     // resolveEquipmentAccessWithSource
  | 'training_history'      // resolveRunningWeeklyMinutesWithSource / cycling
  | 'two_a_day_policy'      // resolveMaxSessionsPerDay
  | 'periodization_phase'   // inferPhase (post-PR0 consolidation)
  | 'goal_mode_volume_cap'  // applyGoalModeVolumeShaping
  | 'readiness_baseline';   // buildReadinessSnapshot fallback path

export type SmartPickProvenance =
  | { kind: 'inferred_from_keyword'; matchedKeyword: string; rawInput?: string }
  | { kind: 'inferred_from_volume_split' }
  | { kind: 'inferred_from_profile_data'; sourceField: string; rawValue?: string | number }
  | { kind: 'inferred_from_targets'; targetField: string; multiplier: number }
  | { kind: 'inferred_from_capacity_cap'; capValue: number; requestedValue: number }
  | { kind: 'inferred_from_race_window'; daysToRace: number }
  | { kind: 'inferred_from_no_data_fallback'; neutralValue: number | string };

export interface SmartPick {
  category: SmartPickCategory;
  pickId: string;                    // stable for SwiftUI list keys
  label: string;                     // short, render-ready
  rationale: string;                 // one-liner ≤140 chars
  provenance: SmartPickProvenance;
  why: Partial<DecisionWhy>;         // sparse — sections with content only
  confidence: number;                // anchored to DECISION_CONFIDENCE_RUBRIC
  confidenceLabel: DecisionConfidenceLabel;
  sourceFreshness: DecisionSourceFreshness;
  coachRuleId?: string;              // optional anchor to coach principle
  userFacingPrinciple?: string;      // optional human copy
}

export interface PlanCreationExplanation {
  schemaVersion: 1;                  // bump on breaking shape change
  generatedAt: string;               // ISO-8601
  planId?: number;                   // omitted on preview
  smartPicks: SmartPick[];           // ONLY system-inferred, NEVER flat defaults
  summary: {
    totalPicks: number;
    highConfidenceCount: number;
    fallbackCount: number;
  };
}
```

### 6.2 New builder: `src/services/training-plan-explanation/builder.ts` (~340 LOC)

Pure function `buildPlanCreationExplanation(input: PlanExplanationBuilderInput): PlanCreationExplanation`.

**Input** (computed upstream, NEVER re-resolved):
```ts
interface PlanExplanationBuilderInput {
  // Original request fields (for raw-input echoes)
  userId: number;
  objective: string;
  sessionsPerWeek: number;
  strengthSessionsPerWeek: number;
  runSessionsPerWeek?: number | null;
  bikeSessionsPerWeek?: number | null;
  swimSessionsPerWeek?: number | null;
  twoADayPreference?: 'never' | 'optional' | 'preferred' | null;
  // Resolver outputs (lifted from buildAthleteStateFromTrainingProfiles)
  primaryFocusResolution: PrimaryFocusResolution;
  equipmentResolution: EquipmentAccessResolution;
  experienceResolution: ExperienceLevelResolution;
  strengthGoalResolution: StrengthGoalResolution;
  runningHistoryResolution: EnduranceMinutesResolution;
  cyclingHistoryResolution: EnduranceMinutesResolution;
  weeklyTargets: Goals['weeklySessionsTarget'];
  rawWeeklyTargets: Goals['weeklySessionsTarget'];  // pre-shape (for goal-mode delta)
  maxSessionsPerDay: number;
  raceCalendar: RaceEvent[];
  kernelDecisionReasons: TrainingDecisionReason[];
  readiness: ReadinessSnapshot | null;
  generatedAt: Date;
}
```

**Filter rule (the SMART pick filter)**: For each resolver output, emit a `SmartPick` ONLY when `source !== 'fallback'` AND the result was inferred (not a literal user-typed value passing through). The fallback path is special-cased:
- `readiness_baseline` ONLY emits when `buildReadinessSnapshot` returned the neutral 70 fallback (no wearable connected). This is honest disclosure of the "no data" path.
- `equipment_profile` with `source: 'fallback'` doesn't emit (would shame the user for incomplete profile); the lint surface handles that case separately.

**Confidence anchoring** (no magic numbers):
```ts
import { DECISION_CONFIDENCE_RUBRIC } from '../decision-center-logic-v2';
const CATEGORY_CONFIDENCE = {
  primary_focus_keyword:       DECISION_CONFIDENCE_RUBRIC.highStructuredState,    // 0.9
  profile_data:                DECISION_CONFIDENCE_RUBRIC.highEntityReadBack,    // 0.88
  volume_split_inferred:       DECISION_CONFIDENCE_RUBRIC.mediumTrainingReview,  // 0.72
  inferred_from_targets:       DECISION_CONFIDENCE_RUBRIC.lowAdvisorMissingContext, // 0.38
  race_window_match:           DECISION_CONFIDENCE_RUBRIC.highScheduleRecommendation, // 0.86
  no_data_fallback:            DECISION_CONFIDENCE_RUBRIC.lowAdvisorMissingContext, // 0.38
};
const labelFor = (n: number): 'high' | 'medium' | 'low' => n >= 0.8 ? 'high' : n >= 0.6 ? 'medium' : 'low';
```

**Source freshness mapping**:
- profile data + wearable connected → `'fresh'`
- profile data without wearable → `'live'`
- inferred from targets / volume split → `'unknown'`
- readiness.isStale === true → degrade to `'stale'`
- fallback path → `'unknown'`

**Coach rule anchor** (Phase 2 hook seed): each SmartPick that matches a known coach principle attaches the pair via `getTrainingCoachRuleById(coachRuleId)`:
- `weekly_volume` (running ≥ 4) → `endurance-periodization-by-goal-horizon`
- `goal_mode_volume_cap` → `strength-progressive-overload-with-deloads`
- `periodization_phase` → `endurance-periodization-by-goal-horizon`
- `experience_level` (advanced) → `strength-progressive-overload-with-deloads`
- Others may have no anchor; `coachRuleId` is optional.

### 6.3 Generator integration

**File modified**: `src/services/training-coach-kernel-plan-generator.ts:159-227` (`buildCoachKernelTrainingPlan`).

Currently `buildAthleteStateFromTrainingProfiles` re-derives resolutions 4× (at log time line 266, at goal-mode reasons line 204, etc.). Lift the resolutions onto a `ResolutionTrace` field returned alongside `AthleteState`:

```ts
// Today (line 159-160):
const athlete = buildAthleteStateFromTrainingProfiles({...});

// After:
const { athlete, resolutionTrace } = buildAthleteStateFromTrainingProfiles({...});
```

Then at the end of `buildCoachKernelTrainingPlan`, call the builder and attach:
```ts
const explanation = buildPlanCreationExplanation({
  userId: input.userId,
  objective: input.objective,
  // ...
  primaryFocusResolution: resolutionTrace.primaryFocus,
  equipmentResolution: resolutionTrace.equipment,
  // ...
  weeklyTargets: athlete.goals.weeklySessionsTarget,
  maxSessionsPerDay: athlete.availability.maxSessionsPerDay,
  raceCalendar: athlete.goals.raceCalendar,
  kernelDecisionReasons: accumulatedDecisionReasons,
  readiness: athlete.readiness,
  generatedAt: new Date(),
});
return { ...planData, explanation };
```

**Estimated LOC**: 50 (generator changes + ResolutionTrace plumbing).

### 6.4 `CoordinatedTrainingPlan` field addition

`src/services/training-plan-coordination.ts` — `CoordinatedTrainingPlan` interface gets:
```ts
explanation?: PlanCreationExplanation;  // optional — never throw if absent
```

Also add the four `primaryFocus*` fields from PR0 (already wired) — re-confirm they survive `applyTrainingPlanCoordination`.

**Estimated LOC**: 10.

### 6.5 Migration 155

**File**: `migrations/155_training_plan_creation_explanation.sql` (~25 LOC)

```sql
-- 155: Plan creation explanation (smart-pick disclosure card data).
-- ASSUMES migration 154 (training_operation_locks, renumbered from audit branch) has shipped.
-- Single JSON blob + sidecar schema version for forward migration safety.

ALTER TABLE fitness_training_plans
  ADD COLUMN explanation_json TEXT;

ALTER TABLE fitness_training_plans
  ADD COLUMN explanation_schema_version INTEGER;
```

No index — only read by plan_id which already has PK index.

### 6.6 Persistence

`src/services/training-plans.ts` lines 251-266 (`createPlan`):
- Add `explanation_json?: string | null` and `explanation_schema_version?: number | null` to `CreatePlanInput`.
- Update INSERT column list + binding tuple (~12 LOC).

`src/api/routes/training-plan-persistence.ts`:
- After `createPlan` call, pass `JSON.stringify(planData.explanation)` and `1` (schemaVersion) (~6 LOC).

### 6.7 API response decoration

**File modified**: `src/api/routes/training-plan-generation.ts`

Three response sites get the new fields:
- Preview response (lines 537-562): `explanation: planData.explanation ?? null`
- Created response (lines 668-714): same
- `plan_quality_blocked` (lines 579-596): same (useful for debugging when the plan is rejected)

Plus the four `primaryFocus*` fields from PR0 carried through.

**Estimated LOC**: 20.

### 6.8 Read-model surface

`src/api/routes/training-read-models.ts` — `getActivePlan(userId)` response: JSON.parse the `explanation_json` column and include in response. iOS may need to re-read explanation after navigation away from creation screen.

**Estimated LOC**: 15.

### 6.9 Test suite

**New file**: `__tests__/services/training-plan-explanation-builder.test.ts` (~280 LOC)

Test cases (one per SmartPickCategory + SMART-filter behavior + serialization round-trip):
1. `primary_focus`: marathon keyword → SmartPick emitted with `confidence: 0.9`, `confidenceLabel: 'high'`, `coachRuleId: endurance-periodization-by-goal-horizon`.
2. `primary_focus`: empty objective → fallback path → NO SmartPick (out of scope for wedge).
3. `weekly_volume`: marathon-derived 4 sessions when no explicit `runSessionsPerWeek` → SmartPick emitted.
4. `weekly_volume`: explicit `runSessionsPerWeek: 6` → NO SmartPick (user pinned the count).
5. `experience_level`: gym_profile.training_age = "5+ years" → SmartPick "Advanced".
6. `strength_goal`: gym_profile.primary_goal = "Hypertrophy" → SmartPick.
7. `equipment_profile`: matched "academia completa" → SmartPick with evidence.
8. `equipment_profile`: fallback → NO SmartPick (lint handles).
9. `training_history`: cycling minutes inferred from targets × 55 → SmartPick `confidence: 0.38`, `sourceFreshness: 'unknown'`.
10. `two_a_day_policy`: 6 sessions + 3 strength → SmartPick "2-a-day enabled".
11. `two_a_day_policy`: 3 sessions + 0 strength → NO SmartPick (default fired).
12. `periodization_phase`: marathon race 56d out → SmartPick "Peak phase active".
13. `goal_mode_volume_cap`: maintenance mode → SmartPick "Capped at 4 sessions/week (60% scale)".
14. `readiness_baseline`: no wearable → SmartPick "Neutral 70 — connect Garmin to make this honest".
15. `readiness_baseline`: wearable connected → NO SmartPick.
16. Confidence labels: `0.9 → 'high'`, `0.72 → 'medium'`, `0.38 → 'low'`.
17. JSON round-trip: marshal/unmarshal preserves all SmartPickProvenance variants.
18. Summary aggregate counts: 5 picks (2 high, 1 low) → `summary = {totalPicks: 5, highConfidenceCount: 2, fallbackCount: 1}`.

**Estimated LOC**: 280.

### 6.10 PR1 totals

| Component | LOC |
|---|---|
| Types file | 140 |
| Builder | 340 |
| Generator integration (ResolutionTrace + builder call) | 50 |
| `CoordinatedTrainingPlan` field addition | 10 |
| Migration 155 | 25 |
| `createPlan` + persistence pass-through | 18 |
| API response decoration (3 sites) | 20 |
| Read-model surface | 15 |
| Test suite | 280 |
| Misc imports/exports | 77 |
| **Total** | **975** |

### 6.11 PR1 verification gate

```bash
npx tsc --noEmit
npx vitest run __tests__/services/training-plan-explanation-builder.test.ts
npx vitest run __tests__/services/training-coach-kernel-* __tests__/api/training-plan-*
npm run verify
# Manual sample inspection:
curl -X POST /api/v1/training/plan/preview \
  -H "Authorization: Bearer ..." \
  -d '{"objective": "Run Lisbon Marathon under 3:30", "sessionsPerWeek": 6, "strengthSessionsPerWeek": 3}' \
  | jq '.data.explanation'
# Expect: 4-6 smartPicks, each with confidence + why + coachRuleId
./scripts/deploy-staging.sh && ./scripts/staging-smoke.sh   # 21/21
```

---

## 7. PR2 — iOS Rendering (~730 LOC, ~5-7 days)

### 7.1 New model: `Nexus Hub/Core/Models/PlanCreationExplanation.swift` (~140 LOC)

```swift
struct PlanCreationExplanation: Codable, Equatable {
    let schemaVersion: Int
    let generatedAt: Date
    let planId: Int?
    let smartPicks: [SmartPick]
    let summary: Summary
    
    struct Summary: Codable, Equatable {
        let totalPicks: Int
        let highConfidenceCount: Int
        let fallbackCount: Int
    }
}

struct SmartPick: Codable, Equatable, Identifiable {
    var id: String { pickId }
    let category: SmartPickCategory
    let pickId: String
    let label: String
    let rationale: String
    let provenance: SmartPickProvenance
    let why: SmartPickWhy
    let confidence: Double
    let confidenceLabel: ConfidenceLabel
    let sourceFreshness: SourceFreshness
    let coachRuleId: String?
    let userFacingPrinciple: String?
}

enum SmartPickCategory: String, Codable {
    case primaryFocus = "primary_focus"
    case weeklyVolume = "weekly_volume"
    case experienceLevel = "experience_level"
    case strengthGoal = "strength_goal"
    case equipmentProfile = "equipment_profile"
    case trainingHistory = "training_history"
    case twoADayPolicy = "two_a_day_policy"
    case periodizationPhase = "periodization_phase"
    case goalModeVolumeCap = "goal_mode_volume_cap"
    case readinessBaseline = "readiness_baseline"
}

enum SmartPickProvenance: Codable, Equatable {
    case inferredFromKeyword(matchedKeyword: String, rawInput: String?)
    case inferredFromVolumeSplit
    case inferredFromProfileData(sourceField: String, rawValue: AnyCodableValue?)
    case inferredFromTargets(targetField: String, multiplier: Double)
    case inferredFromCapacityCap(capValue: Double, requestedValue: Double)
    case inferredFromRaceWindow(daysToRace: Int)
    case inferredFromNoDataFallback(neutralValue: AnyCodableValue)
    case unknown  // forward-compat for new variants
    
    // Custom init(from:) handles the {kind: ..., ...} discriminator
}

struct SmartPickWhy: Codable, Equatable {
    let facts: [String]
    let preferences: [String]
    let rules: [String]
    let tradeoffs: [String]
    let uncertainty: [String]
}

enum ConfidenceLabel: String, Codable { case high, medium, low }
enum SourceFreshness: String, Codable { case live, fresh, stale, unknown }
```

### 7.2 New model: `Nexus Hub/Core/Models/TrainingDecisionReason.swift` (~80 LOC)

Already specified in PR0 (Bug B). Confirmed reusable here.

### 7.3 Decoder integration in `TrainingService.swift`

Add to `PlanGenerateResponse` (`TrainingService.swift:386-465`):
```swift
let explanation: PlanCreationExplanation?
```

In `init(from:)` at lines 471-536:
```swift
self.explanation = try? c.decodeIfPresent(PlanCreationExplanation.self, forKey: .explanation)
```

Add `case explanation` to CodingKeys. Add to `encode(to:)`.

**Estimated LOC**: 15.

### 7.4 New view: `Nexus Hub/Views/Training/PlanCreationExplanationCard.swift` (~220 LOC)

Layout:
- Card header: "Why this plan" / "Por que este plano" (L10n)
- Confidence summary chip: e.g. "4 high-confidence, 2 medium" derived from `summary`
- ForEach over `smartPicks` rendering `SmartPickRow`:
  - Icon (category-specific systemImage)
  - Label (short, bold)
  - Rationale (1 line, secondary color)
  - Confidence pill (color-coded: green=high, amber=medium, gray=low)
  - Source freshness chip when != `.live` (warning case)
  - DisclosureGroup "More" → renders the 5-bucket why (skip empty buckets)
  - "Coach principle" attribution at the bottom when `userFacingPrinciple` is present

Use existing styling from `TrainingPlanPreviewWeekRow` and `TrainingCoachReasoningCard` for visual consistency.

**Estimated LOC**: 220.

### 7.5 Integration in `TrainingView.swift`

After existing `planPreviewCard` content (~line 1839-1847), insert:
```swift
if let explanation = response.explanation {
    PlanCreationExplanationCard(explanation: explanation)
        .padding(.top, NexusSpacing.md)
}
```

Also on the post-create card (after generation success, before navigation to WeeklyPlanView): render the same card so the user sees the explanation alongside the created plan.

**Estimated LOC**: 15.

### 7.6 Test suite

**New file**: `Nexus HubTests/PlanCreationExplanationCardTests.swift` (~160 LOC)

Test cases:
1. JSON round-trip: all 10 SmartPickCategory enum cases decode and re-encode cleanly.
2. SmartPickProvenance forward compat: unknown `kind` variants decode as `.unknown` without throwing.
3. Empty `why` buckets are filtered out of the DisclosureGroup.
4. Confidence label color mapping: `high → green pill`, `medium → amber pill`, `low → gray pill`.
5. Source freshness chip visibility: only shown when `sourceFreshness != .live`.
6. Coach principle attribution: rendered only when `userFacingPrinciple` is non-nil.

**Estimated LOC**: 160.

### 7.7 PR2 totals

| Component | LOC |
|---|---|
| `PlanCreationExplanation.swift` model | 140 |
| `TrainingDecisionReason.swift` model (from PR0) | 80 |
| `TrainingService.swift` decoder integration | 15 |
| `PlanCreationExplanationCard.swift` view | 220 |
| `TrainingView.swift` integration | 15 |
| Test suite | 160 |
| Misc imports + localized strings | 100 |
| **Total** | **730** |

### 7.8 PR2 verification gate

```bash
xcodebuild build -scheme "Nexus Hub" -sdk iphonesimulator
xcodebuild test -scheme "Nexus Hub" \
  -only-testing:"Nexus HubTests/PlanCreationExplanationCardTests" \
  -only-testing:"Nexus HubTests/PlanGenerateResponsePrimaryFocusTests" \
  -only-testing:"Nexus HubTests/PlanGenerateResponseExpertCoachTests" \
  -only-testing:"Nexus HubTests/PlanGenerateResponseRaceDateTests"
# Manual: TestFlight build, create marathon plan, verify card renders ≥4 chips with pills + 5-bucket DisclosureGroup
```

---

## 8. PR3 — Deferred History Endpoint (~150 LOC)

**Scope**: `GET /api/v1/training/plan/:planId/explanation` returns the persisted `explanation_json` for any plan the authenticated user owns. iOS plan-detail view consumes it.

**When to ship**: After PR1+PR2 soak in production for 1+ week. Lands in the Phase 2 sprint.

**Backend changes**:
- New route in `src/api/routes/training-plan-routes.ts` — guard with tenant ownership check, JSON.parse the column, return `{ planId, explanation }`.
- ~50 LOC including tests.

**iOS changes**:
- New entry point in plan-detail view to fetch + render the historical explanation.
- ~100 LOC including a `loadExplanation(planId:)` method on TrainingService and view integration.

---

## 9. Phase 2/3/4 Extension Hooks

Five specific extension points that future phases plug into WITHOUT refactoring the wedge layer.

### Hook 1: `SmartPickProvenance` discriminated union
Phase 2 (adaptive intelligence) adds new variants without breaking existing decoders:
- `inferred_from_completion_history`
- `inferred_from_readiness_trend`
- `inferred_from_feedback_signal`

iOS decoder has `case unknown` last variant — old clients silently skip unknown kinds.

### Hook 2: `PlanCreationExplanation.schemaVersion` + `explanation_schema_version` sidecar column
Phase 2 increments to 2 when shape evolves. Old rows stay decodable because iOS decoder is `try?`-based. A `migrateExplanationV1ToV2` function in `src/services/training-plan-explanation/migrations.ts` (reserved hook point) handles forward migration without touching the builder.

### Hook 3: `SmartPick.coachRuleId` + `userFacingPrinciple`
Phase 3 per-modality enforcement adds new coach rules to `TRAINING_COACH_RULES`. The builder pulls via `getTrainingCoachRuleById` so anchors auto-propagate. Adding new SmartPick categories that anchor to existing rules requires zero builder changes.

### Hook 4: `summary` aggregate counts
Phase 2 telemetry pipeline reads `summary.fallbackCount` + `summary.highConfidenceCount` for plan-quality dashboards. Add new counters to summary as additive fields.

### Hook 5: `GET /training/plan/:id/explanation` endpoint (reserved for PR3)
Phase 2 plan-history view streams a list of past explanations. Phase 3 reliability adds a "plan replay" feature that re-runs the builder against historic athlete state and diffs the SmartPicks. Both consume the persisted JSON; no schema migration needed.

### Bonus Hook: `buildPlanCreationExplanation` is pure
Phase 2's adaptive engine can call it twice (once on plan create, once on plan adapt) and diff the SmartPicks to generate "what changed in your plan and why" cards.

---

## 10. Sample Emissions

Felipe-realistic input: `objective: "Run Lisbon Marathon under 3:30"`, `sessionsPerWeek: 6`, `strengthSessionsPerWeek: 3`, `runSessionsPerWeek: null`, profile has Garmin connected + advanced gym experience + commercial gym.

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-05-22T14:32:08.011Z",
  "planId": 4218,
  "smartPicks": [
    {
      "category": "primary_focus",
      "pickId": "primary_focus:marathon",
      "label": "Marathon focus",
      "rationale": "Your objective said \"marathon\" — Nexus structured base/build/peak/taper around race-specific running volume.",
      "provenance": { "kind": "inferred_from_keyword", "matchedKeyword": "marathon", "rawInput": "Run Lisbon Marathon under 3:30" },
      "why": {
        "facts": ["Objective contained the keyword \"marathon\"."],
        "rules": ["Race-specific running needs a 4-session minimum per week."]
      },
      "confidence": 0.9,
      "confidenceLabel": "high",
      "sourceFreshness": "live",
      "coachRuleId": "endurance-periodization-by-goal-horizon",
      "userFacingPrinciple": "Base, build, peak, taper, race, and recovery phases should follow the athlete's goal horizon, not a fixed four-week label pattern."
    },
    {
      "category": "weekly_volume",
      "pickId": "weekly_volume:running",
      "label": "4 run sessions/week",
      "rationale": "You did not pin a run count, so Nexus applied the marathon minimum: 1 long + 1 quality + 2 supports.",
      "provenance": { "kind": "inferred_from_capacity_cap", "capValue": 4, "requestedValue": 6 },
      "why": {
        "facts": ["Requested 6 sessions/week with no per-modality split.", "Marathon focus enforces 4 runs minimum."],
        "tradeoffs": ["Adding more strength would push runs below the marathon-skeleton floor."]
      },
      "confidence": 0.72,
      "confidenceLabel": "medium",
      "sourceFreshness": "live",
      "coachRuleId": "endurance-periodization-by-goal-horizon",
      "userFacingPrinciple": "Base, build, peak, taper, race, and recovery phases should follow the athlete's goal horizon, not a fixed four-week label pattern."
    },
    {
      "category": "experience_level",
      "pickId": "experience_level:advanced",
      "label": "Advanced experience",
      "rationale": "Your gym profile reads \"5+ years\" — Nexus unlocked the full strength catalog without beginner-safe substitutions.",
      "provenance": { "kind": "inferred_from_profile_data", "sourceField": "gym_profile.training_age", "rawValue": "5+ years" },
      "why": { "facts": ["Matched vocabulary token: \"5+\"."] },
      "confidence": 0.88,
      "confidenceLabel": "high",
      "sourceFreshness": "live"
    },
    {
      "category": "two_a_day_policy",
      "pickId": "two_a_day_policy:auto_enabled",
      "label": "2-a-day enabled",
      "rationale": "6 weekly sessions + 3 strength reached the threshold, so Nexus allows AM cardio + PM strength on the same day.",
      "provenance": { "kind": "inferred_from_capacity_cap", "capValue": 2, "requestedValue": 6 },
      "why": {
        "facts": ["Total weekly target: 6 sessions.", "Strength sessions present: 3."],
        "rules": ["≥5 sessions + strength activates volume-based 2-a-day inference."]
      },
      "confidence": 0.72,
      "confidenceLabel": "medium",
      "sourceFreshness": "live"
    },
    {
      "category": "periodization_phase",
      "pickId": "periodization_phase:peak",
      "label": "Peak phase active",
      "rationale": "Your marathon is 56 days away — Nexus shifted into peak intensity 6 weeks before race day.",
      "provenance": { "kind": "inferred_from_race_window", "daysToRace": 56 },
      "why": {
        "facts": ["Race date: 2026-07-17."],
        "rules": ["Marathon peak window: 21-42 days pre-race."]
      },
      "confidence": 0.86,
      "confidenceLabel": "high",
      "sourceFreshness": "live",
      "coachRuleId": "endurance-periodization-by-goal-horizon"
    }
  ],
  "summary": {
    "totalPicks": 5,
    "highConfidenceCount": 3,
    "fallbackCount": 0
  }
}
```

**Defaults the user accepted by inaction** (`preferredTime: "12:00"`, `durationWeeks: 4`, `twoADayPreference: "optional"` omitted) → **zero smart picks** because their `source === 'request'` (raw form value). Matches the locked scope.

**No-wearable scenario** (otherwise identical): adds a 6th SmartPick:
```json
{
  "category": "readiness_baseline",
  "pickId": "readiness_baseline:neutral_70",
  "label": "Readiness baseline 70",
  "rationale": "No wearable connected, so Nexus used neutral 70. Connect Garmin or Apple Health to make this honest.",
  "provenance": { "kind": "inferred_from_no_data_fallback", "neutralValue": 70 },
  "why": {
    "uncertainty": ["No HRV / sleep / body-battery data available — plan intensity may be too high or too low."]
  },
  "confidence": 0.38,
  "confidenceLabel": "low",
  "sourceFreshness": "unknown"
}
```

---

## 11. Test Pinning Strategy

Per PR:

### PR0
- Vitest: `__tests__/api/training-routes.test.ts` (per-modality counts forward), `__tests__/services/training-coach-kernel-primary-focus.test.ts` (resolveWeeklyTargets honors explicit counts), `__tests__/services/training-history-compliance.test.ts` (NEW; cold-start fallback + real computation), `__tests__/api/training-read-models-readiness.test.ts` (stale_provider 24h detection).
- iOS XCTest: extended `PlanGenerateResponseRaceDateTests.swift` + `PlanGenerateResponseExpertCoachTests.swift` for structured `decisionReasons`.

### PR1
- Vitest: `__tests__/services/training-plan-explanation-builder.test.ts` (NEW; 18 cases pinning every SmartPickCategory + filter behavior + summary aggregation + JSON round-trip + coach rule attachment).
- Vitest: extended `__tests__/api/training-plan-generation.test.ts` for explanation field in preview/created/blocked responses.
- Manual: curl `/preview` with marathon objective, verify explanation JSON shape.

### PR2
- XCTest: `PlanCreationExplanationCardTests.swift` (NEW; SmartPickProvenance decode coverage including `.unknown` forward-compat variant).
- XCTest: extended `PlanGenerateResponsePrimaryFocusTests.swift` for the explanation field decode path.
- TestFlight smoke: signed build, create marathon plan, eyeball the card.

### Source contract guardrails (after PR1)
Add to `__tests__/services/training-skill-hardening-source-contract.test.ts`:
```ts
it('plan generation route emits PlanCreationExplanation alongside planLint and decisionReasons', () => {
  const source = read('src/api/routes/training-plan-generation.ts');
  expect(source).toContain('explanation: planData.explanation');
});
it('explanation builder is pure and exported from training-plan-explanation/builder', () => {
  const source = read('src/services/training-plan-explanation/builder.ts');
  expect(source).toContain('export function buildPlanCreationExplanation');
});
```

---

## 12. Risk Register

| Risk | Likelihood | Mitigation |
|---|---|---|
| Audit branch merge gets delayed | Medium | PR0 can ship without audit branch in main (no migration in PR0); only PR1's migration 155 depends on 154. Re-sequence if needed. |
| Phase resolver consolidation regresses goal-mode tests | Medium | Recommend composition (not replacement) in PR0 §5.6. Full vitest suite plus 4-week-plan e2e tests catch regressions. |
| `trailing14DayCompliance` real computation surfaces low values for cold-start users | High | Default to `0.82` on zero planned sessions (cold-start fallback). Adjust threshold once we see real data distribution. |
| `stale_provider` 24h detection creates user anxiety ("my plan is wrong because data is stale") | Medium | Surface as **disclosure** not blocker; the SmartPick rationale should be encouraging ("Connect Garmin to refresh"). |
| Migration 155 fails on a fresh DB without 154 | Low | Migration table is `IF NOT EXISTS`. But verify the migration runner applies in numerical order. |
| iOS forward-compat: backend adds new SmartPickProvenance kind, old clients crash | Low | Swift decoder has `case unknown` last variant. New backend kinds decode as `.unknown` → filtered out of UI. |
| Explanation JSON column gets corrupted | Low | All readers use `try? JSONDecoder().decode(...)`. Degraded path: card hidden, no crash. |
| Two patterns for explanations (Training native + Decision Center) drift over time | Medium | Document in this roadmap that Training's `PlanCreationExplanation` BORROWS Decision Center primitives (DecisionWhy, rubric). If Decision Center evolves the rubric, Training inherits. |

---

## 13. Migration Number Ledger

| # | Migration | Status | Branch |
|---|---|---|---|
| 152 | `nexus_points_canonical_tx_id` | Shipped (4.14.179) | main |
| 153 | `decision_center_explanations` | Shipped (4.14.183) | main |
| 154 | `training_operation_locks` | RESERVED — needs renumber on audit branch from 153→154 | `codex/training-skill-full-audit-20260522` |
| 155 | `training_plan_creation_explanation` | RESERVED for this work (PR1) | `feature/training-trust-wedge-20260522` |
| 156 | (next available) | — | — |

**Drift watch**: If another worktree claims 154 or 155 before audit branch + this branch land, all branches with affected migrations must renumber.

---

## 14. Files to Read First

For the executor (whether Claude in a future session or Codex), read these in order:

1. `docs/training/training-skill-trust-wedge-roadmap-20260522.md` (THIS DOC)
2. `src/services/training-coach-kernel-plan-generator.ts` — the resolver `*WithSource` pattern (lines 251-544 for AthleteState assembly, 716-862 for resolveWeeklyTargets, 990-1029 for equipment, 1395-1434 for strength goal, 1611-1636 for experience, 1223-1280 for endurance minutes)
3. `src/services/decision-center-logic-v2.ts` — the primitive types we reuse: `DecisionWhy` (lines 69-75), `DECISION_CONFIDENCE_RUBRIC` (lines 229-247), confidenceLabel mapping (line 1795)
4. `src/services/coach-kernel/plan-linter.ts` — `attachCoachRuleEvidence` (lines 642-656), `PLAN_LINT_COACH_RULE_MAP` (lines 187-197)
5. `src/services/coach-kernel/types.ts` — `TrainingDecisionReason` (lines 485-525), `ReadinessSnapshot` (lines 141-156), `TrainingFeedbackDecision` (lines 178-187)
6. `src/services/coach-kernel/coach-rules.ts` — `getTrainingCoachRuleById` (line 101+)
7. `src/api/routes/training-plan-generation.ts` — orchestrator (the 3 response sites + the kernel call)
8. `src/api/routes/training-plan-routes.ts` — preview + generate routes (the bug-fix landing zones)
9. `src/api/routes/training-plan-persistence.ts` — `createPlan` call site, `lintGeneratedTrainingPlanPreflight`
10. `Nexus Hub/Core/Services/TrainingService.swift` lines 386-535 — `PlanGenerateResponse` decoder
11. `Nexus Hub/Views/Training/TrainingView.swift` lines 1716-1893 — Plan Builder + preview card
12. `Nexus Hub/Views/Inbox/NotificationDecisionCenterView.swift` lines 1675-1726 — reference rendering for 5-bucket Why (visual + interaction model to mirror)

---

## 15. Out of Scope (explicitly NOT shipping in this wedge)

These were considered and deferred:

- **Inline editable preview** (drag-and-drop sessions, swap day X for day Y) — Phase 4.
- **"What changed from last plan" diff card** — Phase 2 (depends on persisted explanation history).
- **Real-time plan adaptation as user adjusts inputs** — Phase 4.
- **Cross-skill explanation registry** (sharing this surface with Finance / Content / Cooking) — Approach C scope, rejected as premature abstraction.
- **Decision Center alternatives picker** (`DecisionAlternativeOption` for plan shape decisions) — Phase 2.
- **`GET /plan/:planId/explanation` historical endpoint** — PR3, deferred to Phase 2 sprint.
- **Bike/swim modality enforcement in `enforceRequestedTrainingPlanVolume`** — Phase 3.
- **Outlook smoke unblock + Microsoft OAuth setup** — orthogonal operational task.
- **Multi-process durable lock validation in PM2 cluster** — Phase 3 (audit branch's locks suffice for current single-process deployment).

---

## 16. Handoff

This document is the contract. The executor (Claude in a future session, or Codex) should:

1. Confirm PR-prereq is done (audit branch merged, migration renumbered).
2. Rebase `feature/training-trust-wedge-20260522` onto the post-audit `origin/main`.
3. Read the §14 reading list.
4. Execute PR0 per §5 with the verification gate in §5.7.
5. Once PR0 ships, execute PR1 per §6.
6. Once PR1 ships, execute PR2 per §7.
7. PR3 is deferred.

Update this doc's "PR sequence" table with actual ship dates and any LOC variance as each PR closes.

---

## 17. Live Identity

**Worktrees created**:
- Backend: `cortex-telegram-hub-bot-training-trust-wedge-20260522` on `feature/training-trust-wedge-20260522` (tracking `origin/main` at `81fd5496`)
- iOS: `worktrees/training-trust-wedge-20260522` on `feature/training-trust-wedge-20260522` (tracking `origin/main` at `b42abe1`)

**Author**: Felipe (decisions), Claude (Phase 1-4 design + this doc), Codex/Claude (execution).
**Roadmap session date**: 2026-05-22.

---

## 18. Codex Critical Review — Do Not Start PR0 Until These Are Resolved

This addendum was added after a source-backed pass over the roadmap, the trust-wedge worktrees, the production training audit branch, and the current iOS worktree. It intentionally challenges the plan before implementation.

### 18.1 Current evidence snapshot

Verified on 2026-05-22:

- Trust-wedge backend worktree is still based on `origin/main` at `81fd5496` and has migrations only through `153_decision_center_explanations.sql`.
- Training audit branch `codex/training-skill-full-audit-20260522` is already deployed to production as `v4.14.185` at `96cfd84c`, and contains `migrations/154_training_operation_locks.sql`.
- The audit branch is not merged into `origin/main` from this worktree's perspective; `origin/main...codex/training-skill-full-audit-20260522` reports divergent history.
- Several PR0 items in this roadmap are already present on the deployed audit branch:
  - Backend accepts and forwards `runSessionsPerWeek`, `bikeSessionsPerWeek`, and `swimSessionsPerWeek`.
  - `resolveWeeklyTargets` already consumes those per-modality targets.
  - iOS main already sends those targets and has the plan-builder in-flight guard.
  - Backend emits normalized modality targets in plan responses.
- Several PR0 items remain open:
  - iOS still flattens backend `decisionReasons` objects into `[String]`, so the structured evidence is lost.
  - `trailing14DayCompliance` is still hardcoded to `0.82` in `src/services/training-coach-kernel-plan-generator.ts`.
  - `stale_provider` is typed but not assigned by `fetchCurrentReadinessForPlan`; the route still maps non-missing wearable readiness to `fresh_wearable`.
  - Phase resolver consolidation remains unresolved, and the roadmap currently contains a dangerous week-4 deload regression expectation.

### 18.2 Blocking plan corrections

#### C1. Main/prod provenance must be fixed before this branch starts feature work

Production is running the training audit line, but this trust-wedge branch was created from pre-audit `origin/main`. Starting PR0 here would re-open already-fixed Training behavior and create migration drift.

**Better plan**:
1. Merge or fast-forward the deployed audit line into backend `main` first, preserving `154_training_operation_locks.sql`.
2. Rebase `feature/training-trust-wedge-20260522` onto the post-audit `origin/main`.
3. Re-run the roadmap's evidence sweep and delete PR0 tasks already closed by the audit line.

**Question for Felipe**: should the audit production branch become `main` immediately, or should the trust-wedge branch temporarily base from `codex/training-skill-full-audit-20260522` until main catches up?

#### C2. The roadmap's "no race + week 4 deload" test contradicts the audit we just shipped

Section 5.6 says to pin: "no race + 4-week plan -> weeks 1-2 base, week 3 build, week 4 deload." That directly contradicts the reliability audit rule: no unconditional week-4 deload unless the mesocycle, readiness, fatigue, pain, or race/taper context calls for it.

**Better plan**:
- Replace that test with: "no race + healthy readiness + no fatigue/pain -> no forced week-4 deload."
- Add separate tests where recovery/deload is justified by explicit inputs: fatigue/readiness, pain/injury, race/taper, or a deliberately modeled 3-up/1-down mesocycle.

**Question for Felipe**: should the first trust-wedge phase explain recovery weeks only when they are explicitly justified, instead of making week 4 special by default?

#### C3. "Show only smart picks" may hide the user's highest-trust concerns

The plan intentionally hides request-sourced choices. That is clean, but it misses the exact trust failures Felipe reported: preferred times silently shifted, requested run/gym counts ignored, and calendar creation only partially synchronized. Users may need to see both:

- **Nexus chose**: inferred smart picks.
- **Nexus respected**: user-pinned requirements that were honored.
- **Needs attention**: user-pinned requirements not honored, with a conflict reason.

**Better plan**:
- Keep `SmartPick` for inferred choices.
- Add a parallel `respectedConstraints` or `requirementStatus` array, not a noisy default list.
- Render this as a compact "Respected your choices" row, not as another large disclosure card.

**Question for Felipe**: do you want the wedge to build trust by explaining only Nexus inferences, or also by proving that explicit user choices were respected?

#### C4. Backend-rendered labels/rationales create localization drift

The sample emissions include backend-generated English labels and rationales. Nexus already supports bilingual behavior; a backend-only English explanation card will feel wrong for Portuguese users. If iOS localizes the card but the backend sends English sentences, the UX will be mixed-language.

**Better plan**:
- Either pass `language`/`locale` into the explanation builder and localize backend strings through the existing i18n path, or
- Send stable semantic fields (`category`, `ruleId`, `evidence`) and let iOS render localized copy.

**Question for Felipe**: should the explanation copy be localized by backend at generation time, or should iOS render localized copy from semantic codes?

#### C5. The SMART-pick filter rule is internally inconsistent

Decision D4 says filter with `source !== 'request' && source !== 'raw_default'`. Section 6.2 says emit only when `source !== 'fallback'` and inferred. Those are not the same rule. The difference matters for neutral fallbacks, profile-derived values, and raw defaults.

**Better plan**:
Define one explicit provenance policy:
- `request`: not a smart pick, but may become `respectedConstraint`.
- `raw_default`: not shown.
- `fallback`: shown only when user trust benefits from disclosure, such as no wearable readiness.
- `profile` / `inferred` / `derived`: smart pick.

**Question for Felipe**: should low-confidence fallbacks like no wearable data be shown as trust disclosures, or hidden to avoid anxiety?

#### C6. `DECISION_CONFIDENCE_RUBRIC` is not exported today

The roadmap says Training should import `DECISION_CONFIDENCE_RUBRIC`, but the current source declares it as a local `const` in `src/services/decision-center-logic-v2.ts`.

**Better plan**:
- PR1 should include a tiny, tested export of the rubric or move shared confidence primitives into a neutral `decision-confidence.ts`.
- Do not duplicate the values in Training; that would recreate drift.

**Question for Felipe**: do we want a shared confidence primitive module now, or a minimal export from Decision Center for speed?

### 18.3 PR sequence revised after critical review

Replace the current PR sequence with this safer sequence:

| PR | Scope | Why |
|---|---|---|
| **PR-pre0** | Main/prod convergence: merge deployed training audit line into `main`, rebase trust wedge backend and iOS worktrees, prune already-closed PR0 tasks from this doc | Avoids building on stale source and prevents migration drift |
| **PR0A** | Trust input truth: structured iOS `decisionReasons`, real trailing compliance, stale-provider readiness, one canonical phase resolver without forced week-4 deload | Only the honest-input gaps still open after the audit line |
| **PR0B** | Explanation contract design spike: generate 3 sample JSON payloads from real plan fixtures without persistence or iOS UI | Lets Felipe judge copy/localization/noise before schema migration |
| **PR1** | Backend persisted explanation builder and migration `155_training_plan_creation_explanation.sql` | Only after payload shape is validated |
| **PR2** | iOS rendering, localized or semantic-copy strategy based on C4 decision | Avoids shipping English-only backend prose into Portuguese UX |
| **PR3** | Historical explanation endpoint and plan-detail reuse after one-week production soak | Same as original, still deferred |

### 18.4 Implementation questions that should be answered before coding

1. Do we merge the deployed training audit branch into backend `main` before starting trust wedge work?
2. Should the card have two sections: "Nexus chose" and "Nexus respected", or only "Nexus chose"?
3. Where should explanation copy be localized: backend builder or iOS renderer?
4. Should no-wearable readiness fallback be shown by default, or only behind an expandable "data quality" row?
5. For trailing compliance, exactly which sessions count as "planned": only past-due active sessions, or also canceled/unscheduled sessions?
6. Should compliance be computed per modality as well as overall from day one, since the explanation will mention modality-specific choices?
7. What is the maximum explanation payload size we accept in `/preview` responses?
8. Should explanation JSON persist raw objective text, or store only a truncated/sanitized evidence snippet to reduce privacy exposure?
9. Should Decision Center confidence primitives be exported from the existing file or moved into a shared neutral module?
10. Should Phase 1 include telemetry for how often users expand/read the explanation card, or is that Phase 2?

### 18.5 Current "do not implement yet" line

Do not start PR0 implementation on this worktree until C1 and C2 are resolved. The safest immediate next action is PR-pre0: converge `main` with the already-deployed training audit production branch, then rebase this worktree and refresh the roadmap task list from actual source.
