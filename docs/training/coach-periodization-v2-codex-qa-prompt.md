# Codex QA Prompt — Coach Periodization v2.1 Implementation

## Original goal

Build a **professional coach-level** Week-Level Adaptability + Progression & Periodization system grounded in published sports-science best practices, with hard safety guardrails for pain/illness/RED-S, multi-source load modeling that includes RPE-based internal load, configurable intensity distributions per athlete/phase, and a full audit trail.

The full plan (v2.1, 30 slices across 3 phases) is at:
`/Users/felipedominguez/.claude/plans/can-you-work-on-polymorphic-lamport.md`

Your job: independently review what landed against the plan. Find behavioral regressions, missing slice scope, contract drift between modules, and any place where the implementation diverges from the documented sports-science framing.

## What was implemented

All 30 planned slices shipped. Summary by phase:

**Phase A — Foundation (11 slices)**
- **A0**: `adaptation_revision` column on `fitness_training_plans` (migration 155) + `incrementAdaptationRevision()` / `getAdaptationRevision()` helpers in `training-plan-lifecycle.ts`. Two-counter independence from existing `plan_version`.
- **A0b**: Adaptation ledger table (migration 156) — `training_plan_adaptations` with `UNIQUE(plan_id, adaptation_revision)` partial index, `UNIQUE(plan_id, idempotency_key)` partial index, `rollback_of_adaptation_id` self-ref. Service module `training-plan-adaptations.ts` with `recordAdaptation()`, `recordPreviewAdaptation()`, `rollbackAdaptation()` (latest-only optimistic-lock, append-only), `getAdaptationByRevision()`, `getAdaptationsForPlan()`, `findAdaptationByIdempotencyKey()`, `purgeSensitivePayloadsForUser()`, role-based redaction via `ViewerRole`.
- **A0c**: CompletionFeedbackV2 — extended `training_completions` with 10 new columns (migration 157); kept existing `rpe_overall`/`duration_minutes`/`soreness_level` (discovery confirmed they semantically match). New `athlete_readiness_events` + `athlete_health_signals` tables (migration 158) with per-signal `consent_scope`. Service modules `readiness-events.ts` and `health-signals.ts` with consent-gated writes.
- **A1a**: Activated dormant `training-principles.json` — typed accessor module `coach-kernel/training-principles.ts`, wired `applyVolumeGrowthCapForSport()` into running-engine (primary + support paths) and cycling-engine (primary path).
- **A1b**: Extended `training-principles.json` with mesocycle lengths, block templates, weekIntent defaults, intensityDistributionModels, taperCoefficients (per priority), acwrThresholds, riskScoreWeights, deloadCadenceRules, returnFromGapRamps (per protocol class), missedSessionPolicyDefaults, minimumViableWeekTemplates, `sciencePolicyVersion`. Added 12 new typed accessors. **CI gate**: `scripts/ci/science-policy-version-check.mjs` fails when JSON content hash changes without version bump; pinned hash at `src/services/coach-kernel/knowledge/entities/.science-policy-hash`.
- **A2**: ZoneSet calculator `coach-kernel/zone-calculator.ts` — Coggan %FTP (cycling), Daniels VDOT (running), %CSS (swim), %LTHR/%HRmax (HR fallback). `computeIntensityFactorForZone()` powers B1's TSS math.
- **A2b**: Interval-level intensity profiles. New types `IntensitySegment`, `SessionIntensityProfile`, `IntensitySummary` on `Session`. Module `coach-kernel/intensity-profile.ts` with segment heuristics, distribution computation, TSS = duration × IF² × 100 estimated load. Compact iOS summary view.
- **A3**: `PlanGenerationContext` + cross-week state. New types `HealthSignal`, `VersionStamp`, `WeekConditions`, `PlanGenerationContext`, `WeekContextDelta`. Module `coach-kernel/plan-generation-context.ts` — immutable `commitWeek(ctx, delta)`, `withReadinessSnapshot()`, `withHealthSignal()`, `withRollingHrv()`, `withRollingAdherence()`. **AthleteProfile remains untouched**; readiness/health are events on context.
- **A4**: Safety wiring. Module `coach-kernel/safety-wiring.ts` — `mapHealthSignalToSafetyInput()` translates A0c HealthSignal to safety-guardrails input, respecting consent scopes. `wireHealthSignalToSafety()` distinguishes typed structured intake (hard pause) vs inferred (warning-only). User-facing copy `SEEK_PROFESSIONAL_SUPPORT_COPY`; internal code constant `medical_referral`. Extended existing `safety-guardrails.ts` with `feverPresent` and `energyAvailabilityRisk` self-reported flags (RED-S framed as risk screening, not diagnosis).
- **A4p**: Health-data privacy & consent. Module `health-consent.ts` — `CONSENT_EXPLANATIONS` per scope, `validateConsentScopes()`, `SCOPE_SUPPORT_REDACTED` flags, `DEFAULT_RETENTION_DAYS`, `deleteAllHealthDataForUser()` cascade across `athlete_readiness_events` + `athlete_health_signals` + adaptation-ledger redaction.
- **A5**: CoachPlanPolicy substrate. `coach_plan_policy_json` column on `fitness_training_plans` (migration 159). Module `coach-plan-policy.ts` — `DEFAULT_COACH_PLAN_POLICY`, `getCoachPlanPolicy()`, `setCoachPlanPolicy()` with enum validation. Uses `'data_informed'` (not `'data_driven'`) per v2.1 wording.

**Phase B — Periodization model (11 slices)**
- **B0**: Load-source normalization `coach-kernel/load-input.ts` — `SessionLoadEstimate` with four parallel dimensions (planned/completed-external/internal/strength/impact). Never collapses. Cycling NP→TSS, running pace→TSS, swim pace→TSS, sRPE×duration universal fallback (Foster 2001), TRIMP preferred when present, strength tonnage separate, impact running-only, body-mass-factor weighted.
- **B1**: EWMA load model `coach-kernel/load-model.ts` — CTL (42d EWMA), ATL (7d EWMA), TSB = CTL-ATL, ACWR coupled + uncoupled. `LoadModelStatus = 'cold_start' (<14d) | 'warming' (14-41d) | 'stable' (42+d)`. Per-dimension aggregation in `computeMultiDimensionLoadModel()`.
- **B2**: `WeekIntent` discriminated type added to types.ts (`accumulation` | `intensification` | `realization` | `deload` | `recovery` | `taper` | `race` | `post_race_recovery`). Module `coach-kernel/week-intent.ts` — `intentFromKind()`, `resolveWeekIntent()` with race-aware precedence (race day > post-race > taper > mesocycle > default), `blockPhaseFromWeekIntent()` for backwards compat.
- **B2a**: Extended `RaceEvent` with `expectedDurationSec`, `taperImportance`, `recoveryDaysAfter`, `disciplines[]`, `raceFormat`. New `RacePriorityNormalized` ('A'/'B'/'C') normalized from existing lowercase. Module `race-calendar.ts` — `findNextRace()`, `findMostRecentPastRace()`, `daysToRace()`, `isInPostRaceRecovery()` (per priority + format), `isInTaperWindow()`, `resolveRaceDisciplines()`.
- **B3**: Mesocycle resolver `coach-kernel/mesocycle.ts` — `resolveMesocyclePlan()` composes B2 into a full WeekIntent[] for the plan, race-aware. Default block name by athlete level (novice 5wk, intermediate 4wk, advanced 3wk).
- **B4**: Configurable intensity distribution `coach-kernel/intensity-distribution.ts` — `pickIntensityDistribution()` (race=95/0/5, deload=90/10/0, post_race=100/0/0, else from policy/sport/level), `measureWeeklyDistribution()` (segment_time_in_zone default, session_goal alt), `assessDistributionDelta()` with warnings.
- **B4b**: Symptom-aware preference (capture only). Table `athlete_session_preferences` (migration 160). Module `symptom-aware-preference.ts` — `recordSessionPreference()`, `getPreferenceForDate()`, `getPreferencesInRange()`, `deletePreferenceHistoryForUser()`. **No phase prediction — symptom-aware only.**
- **B5**: Deload recommendation `coach-kernel/deload-recommendation.ts` — `recommendDeload()` with cold-start gating, ACWR-soft-signal rule, HRV-pairing rule (Plews-Buchheit), composite risk score, primary signal selection. Hybrid + scheduled + data_informed strategies.
- **B6**: Strength progression gating `coach-kernel/strength-progression.ts` — `decideStrengthProgression()` with 9 gates (equipment / pain / novelty / pattern-recency / interference / reps / RPE / soreness / technical). Four vectors (load / volume / intent / consistency). Substring-order fix for compound target names.
- **B7**: Day-level taper `coach-kernel/taper.ts` — `decideTaper()` with quadratic volume curve (endMultiplier + (1-endMultiplier) × (daysToRace/durationDays)²), priority-scaled windows, strength cutoff active. `shouldDropMissedTaperSession()` — taper never crammed.
- **B8**: Race-aware taper + post-race recovery — composition slice, accomplished through B2a + B2 + B3 + B7. No separate module.

**Phase C — Week-level adaptability (8 slices)**
- **C1**: Missed-session sweep `missed-session-sweep.ts` — `detectMissedSessions()` with timezone-aware date reconstruction, 12h key/24h easy grace, exclusions for completed/external/preview-active.
- **C2**: Travel windows. Table `travel_windows` (migration 161). Module `travel-windows.ts` — `recordTravelWindow()` with stress flags, `findTravelWindowsInRange()`, `computeTravelStressScore()`.
- **C3**: Per-week equipment override. `equipment_override_json` column on `training_weeks` (migration 161). Module `week-equipment-override.ts`.
- **C4**: Gap detector `gap-detector.ts` — `detectTrainingGap()` returns `{gapDays, lastCompletionDate, protocol, inferenceRationale}`. Protocol classes inferred from concurrent A0c signals (vacation_or_life_gap / minor_illness_resolved / febrile_or_systemic_illness / injury_localized / post_exertional_symptom_risk / unknown_conservative); declared override wins.
- **C5**: Adherence trend `adherence-trend.ts` — `computeAdherenceTrend()` returns current + prior week + rolling fraction + `trendLow` boolean (both weeks below 0.70).
- **C6**: Week reflow service `training-week-reflow.ts` — `executeWeekReflow()` with `mode: 'preview' | 'apply'` + idempotency key. Preview = no revision bump, optional preview-scope ledger row. Apply = single-transaction revision bump + ledger row + idempotency dedup.
- **C7**: Week conditions aggregator `coach-kernel/week-conditions.ts` — `aggregateWeekConditions()` composes signals from C1/C2/C4/C5 + A4 health + PR 3 athlete-lifecycle-state into a single `WeekConditions` record for C8 consumption.
- **C8**: Scenario classifier `coach-kernel/scenario-classifier.ts` — `classifyTrainingScenario()` returns `ScenarioAssessment` with typed `CoachAction[]` (drop_session / move_session / scale_volume / swap_exercise / downgrade_intensity / insert_recovery_day / pause_training). Two-tier precedence (safety > rate-limit > scenarios). Anti-churn rate limits configurable.

## Files changed

**Migrations (7 new)**
- `migrations/155_plan_adaptation_revision.sql`
- `migrations/156_training_plan_adaptations.sql`
- `migrations/157_completion_feedback_v2.sql`
- `migrations/158_athlete_readiness_and_health_events.sql`
- `migrations/159_coach_plan_policy.sql`
- `migrations/160_athlete_session_preferences.sql`
- `migrations/161_travel_windows_and_equipment_overrides.sql`

**New service modules (20)**
- `src/services/training-plan-adaptations.ts`
- `src/services/readiness-events.ts`
- `src/services/health-signals.ts`
- `src/services/health-consent.ts`
- `src/services/coach-plan-policy.ts`
- `src/services/symptom-aware-preference.ts`
- `src/services/travel-windows.ts`
- `src/services/week-equipment-override.ts`
- `src/services/missed-session-sweep.ts`
- `src/services/gap-detector.ts`
- `src/services/adherence-trend.ts`
- `src/services/training-week-reflow.ts`
- `src/services/race-calendar.ts`
- `src/services/coach-kernel/training-principles.ts`
- `src/services/coach-kernel/zone-calculator.ts`
- `src/services/coach-kernel/intensity-profile.ts`
- `src/services/coach-kernel/load-input.ts`
- `src/services/coach-kernel/plan-generation-context.ts`
- `src/services/coach-kernel/safety-wiring.ts`
- `src/services/coach-kernel/week-intent.ts`
- `src/services/coach-kernel/mesocycle.ts`
- `src/services/coach-kernel/intensity-distribution.ts`
- `src/services/coach-kernel/load-model.ts`
- `src/services/coach-kernel/deload-recommendation.ts`
- `src/services/coach-kernel/strength-progression.ts`
- `src/services/coach-kernel/taper.ts`
- `src/services/coach-kernel/week-conditions.ts`
- `src/services/coach-kernel/scenario-classifier.ts`

**Extended existing modules**
- `src/services/training-plan-lifecycle.ts` — `incrementAdaptationRevision()`, `getAdaptationRevision()`.
- `src/services/coach-kernel/types.ts` — `HealthSignal`, `VersionStamp`, `WeekConditions`, `PlanGenerationContext`, `WeekContextDelta`, `CoachPlanPolicy`, `WeekIntent`, `WeekIntentKindEnum`, `IntensitySegment`, `IntensitySegmentRole`, `SessionIntensityProfile`, `IntensitySummary`, `RacePriorityNormalized` types; extended `RaceEvent` with multisport fields; extended `Session` with optional `intensityProfile` + `intensitySummary`; extended `TrainingDecisionReasonCode` with safety codes; extended `TrainingDecisionReason.sourceConstraint.type` with 'safety'.
- `src/services/coach-kernel/safety-guardrails.ts` — added `feverPresent` and `energyAvailabilityRisk` to `selfReportedFlags`; added fever + RED-S finding builders in `buildSelfReportedFinding()`.
- `src/services/coach-kernel/engines/running-engine.ts` — wired `applyVolumeGrowthCapForSport()` in both primary and support-only paths.
- `src/services/coach-kernel/engines/cycling-engine.ts` — wired `applyVolumeGrowthCapForSport()` in primary path.
- `src/services/coach-kernel/knowledge/entities/training-principles.json` — added `sciencePolicyVersion`, `mesocycleLengths`, `blockTemplates`, `weekIntentDefaults`, `intensityDistributionModels`, `taperCoefficients`, `acwrThresholds`, `riskScoreWeights`, `deloadCadenceRules`, `returnFromGapRamps`, `missedSessionPolicyDefaults`, `minimumViableWeekTemplates`.

**New CI tooling (1)**
- `scripts/ci/science-policy-version-check.mjs` — content-hash gate; pinned hash at `src/services/coach-kernel/knowledge/entities/.science-policy-hash`.

## Expected behavior

After this work, the training engine has:

1. **Two-counter versioning**: `plan_version` (manual regen, heavyweight) + `adaptation_revision` (adaptive reflow, lightweight). Independent.
2. **Adaptation ledger** for every persisted adaptive change with strict invariants (exactly-one ledger row per revision; transactional; rollback append-only with optimistic lock; idempotency dedup).
3. **CompletionFeedbackV2 substrate**: sRPE, RIR, pain, soreness, technical success, missed reason, external-training declaration captured from sessions; readiness/health captured as time-varying events with per-signal consent.
4. **A1a baseline coach delta**: weekly volume capped per sport (running 8%, cycling 12%) — defensive ceiling, fail-open to no-cap when JSON missing.
5. **Activated periodization policy JSON** with semver + content-hash CI gate.
6. **Per-sport zone tables** computed from athlete anchors (FTP, T-pace, CSS, HRmax, LTHR) via canonical mappings.
7. **Multi-source load model** (separated external/internal/strength/impact dimensions) with EWMA CTL/ATL/TSB/ACWR and cold-start gating.
8. **Race-aware mesocycle resolution**: 12-week plan with A-priority marathon in week 11 generates accumulation/deload/...taper/race/post_race_recovery automatically.
9. **Day-level taper**: quadratic volume curve from 100% to (1 - volumeDropPct/100) over the priority-scaled window, intensity preserved at 100%, strength cutoff at priority-scaled days before race.
10. **Safety wiring**: typed structured intake → hard pause + medical_referral decision-reason; inferred → warning-only. RED-S framed as risk screening; fever as systemic illness.
11. **Privacy/consent**: per-signal opt-in for menstrual/RED-S/pain/illness/injury; one-call delete-my-history cascade.
12. **Week-level adaptability**: missed-session sweep (timezone + grace + exclusions), travel windows with stress score, equipment override, gap detector with ReturnProtocol classification, adherence trend.
13. **Scenario classifier with CoachAction grammar**: typed action DSL replaces free-form strings; safety always wins; rate-limit anti-churn caps; scenario composition (modifiers stack).
14. **Reflow service with preview/apply**: preview never mutates; apply is transactional with idempotency dedup.

## Tests and checks already performed

- **Unit tests**: each slice has a dedicated focused test file under `__tests__/services/`. 21 new test files; ~350+ new tests in total. All passing.
- **Full test suite**: `npx vitest run` → 671 files / 9956 tests pass. Zero existing tests broken. The 7335 baseline floor is well exceeded.
- **TypeScript**: `npx tsc --noEmit` clean throughout (no errors).
- **CI version-hash check**: `node scripts/ci/science-policy-version-check.mjs` → pinned hash matches.
- **Engine regression**: ran `__tests__/services/coach-kernel-*.test.ts` + `__tests__/services/training-coach-kernel-*.test.ts` + training-API tests after each engine wire — all 39+ files / 662+ existing kernel tests + 65 API tests still pass.

## Areas Claude should inspect carefully (areas of concern)

1. **A0c column-rename decisions** — discovery showed `training_completions` already had `rpe_overall`, `duration_minutes`, `soreness_level`. I kept those instead of adding parallel `session_rpe`/`completed_duration_minutes`/`soreness_score` columns to avoid dual sources of truth. Verify: is there ANY upstream code that expected a literal `session_rpe` column name? A grep for `session_rpe` in `src/` shouldn't find any non-comment usage outside the new modules.

2. **Engine WeekIntent adoption scope** — B2 ships the `WeekIntent` type + resolver + `BlockPhase` legacy bridge, but the six engines (running/cycling/swimming/strength + biomechanics ordering + planner-engine) still read `BlockPhase` directly in their template selection branches. The plan's "~18 read-sites" engine refactor is intentionally **deferred to a follow-up**. Verify: WeekIntent does not silently shadow BlockPhase in any path that would change behavior today. The fail-safe is `blockPhaseFromWeekIntent()` for any consumer needing the legacy label.

3. **`PlanGenerationContext` plumbing** — A3 ships the context type + builder + immutable `commitWeek` semantics, but the existing `training-coach-kernel-plan-generator.ts:177-209` (the silent `currentBlock.weekIndex` overwrite per the plan) is NOT yet refactored to thread the context through. Verify: does the new code break the existing generator's behavior? It shouldn't — A3 ships substrate-only and doesn't wire into the generator yet. Follow-up work will route engines through the context.

4. **Scenario classifier engine integration** — C8 ships the classifier + CoachAction grammar + tests, but is NOT yet called from the existing planner or weekly orchestrator. Verify: classifier produces correct shapes when invoked directly (the unit tests confirm), but the runtime integration to feed it actual planner data is a future slice (per plan: "All new scenarios + policies ship warning-only behind `COACH_PERIODIZATION_V2_ENABLED` feature flag").

5. **A4p deletion cascade ordering** — `deleteAllHealthDataForUser()` is NOT transactional across the three modules (events table + signals table + ledger redaction), which may leave a brief inconsistency window. Verify: is the brief window acceptable for a deletion-grade operation, or should it be wrapped in a single SQLite transaction? My judgment: each module's delete is atomic; a crash mid-flow leaves orphans on the LATER tables, which is the safer direction (sensitive payloads removed first).

6. **B5 confidence rollup edge** — when `loadModelStatus === 'cold_start'` AND `contributingSignals.length === 0`, I return `confidence: 'low'`. Verify: this is intentional (no signals + cold-start = low) vs should we surface 'medium' since at least the scheduled cadence path is reliable.

7. **B7 quadratic curve endpoints** — at `daysToRace = durationDays`, multiplier ≈ 1.0; at `daysToRace = 0`, multiplier = endMultiplier. Verify the curve smoothness — there's a subtle off-by-one possibility where day 14 of a 14-day taper should be the FIRST taper day (volume just starting to drop), not equal to baseline. The test `A-priority taper start (daysToRace=14): volume ≈ 100%` passes; double-check this matches the Bosquet exponential-drop intent.

8. **B0 `pickPreferredLoadScore()` preference** — order is `completedExternalLoad > completedInternalLoad > plannedExternalLoad > strengthLoad > impactLoad`. For a strength session with only `strengthLoad` and no `completedInternalLoad`, the result is strength. Verify the preference order matches the v2.1 intent (B0 docstring lists exactly this order).

9. **Multi-disc race recovery defaults** — `race-calendar.ts:defaultRecoveryDays()` distinguishes Ironman (14d), 70.3 (10d), other multisport (7d), marathon (10d), short single-disc (5d). Verify these match published recovery guidance — IM is the easiest to be wrong about.

10. **`safety-wiring.ts` consent-scope re-check** — the wiring layer re-checks `consent_scope` on the HealthSignal before mapping fields. The A0c write layer also checks consent. Is the double-check defensible (defense-in-depth) or redundant? My judgment: defense-in-depth — if any other producer ever feeds the safety wiring with non-A0c data, the consent check protects.

## Edge cases to verify

- **Empty plan, no completions**: `detectTrainingGap()` returns gapDays=999 (huge) — does this cause downstream code to over-trigger? B5's deload recommender has cold-start protection; verify gap detector flows safely into C7.
- **First adaptation ledger row before any plan generation**: A0b allows `recordAdaptation()` against a plan with `adaptation_revision = 0`; first call produces revision 1. Verify migration order — A0 column must exist before any caller invokes the helper.
- **Concurrent idempotency races**: two simultaneous `executeWeekReflow({mode:'apply', idempotencyKey:'X'})` calls. The first wins; second hits `AdaptationIdempotencyConflictError` (or pre-check hit). Verify the rollback path inside the failed transaction.
- **Rollback chain**: rollback of a rollback — the second rollback should be allowed only if the first is the latest revision. Test covers it; verify the error message clarity.
- **Cold-start ACWR**: athlete with 13 completions → cold_start; the 14th completion flips to warming. Verify the boundary in `computeLoadModelForDimension()` — `< COLD_START_MAX_DAYS` vs `<=`.
- **Race day exactly equals week start**: covered in B2 (`resolveWeekIntent` looks at race date >= weekStart && <= weekEnd). Verify the off-by-one between strict `findNextRace` (>asOf) and the inclusive race-this-week check.
- **Multi-week reflow vs single-week reflow**: C6 currently scopes to a single week. If a user requests cascading reflows (this week + next week), is that supported? Per plan: out of scope for v2.1; verify the C6 endpoint shape doesn't accidentally allow multi-week.
- **Sensitive payload redaction completeness**: `purgeSensitivePayloadsForUser()` redacts `trigger_payload_json` for known-sensitive trigger types. Does it also need to redact `decision_reason_codes_json` or `before_patch_json`/`after_patch_json` if those contain sensitive content? My judgment: trigger_payload_json is the primary surface for sensitive data; patch JSON is session-shape data, not health data. Verify.
- **WeekIntent + race-day same week**: a race on Saturday week-of falls into week-conditions both as `race` (resolveWeekIntent) AND would trigger taper logic from B7. Verify B3 resolveMesocyclePlan picks 'race' correctly, not 'taper'.
- **Volume cap on negative/zero previousMinutes**: `applyVolumeGrowthCap(0, 50, 8)` returns 50 (no cap when prev=0). Cold-start athletes get no cap — verify this is intentional (it is per code; growth from 0 is the baseline first week).

## Known risks and assumptions

1. **Engine refactor deferred**: The full Phase B engine refactor (B2/B6 read-sites across 6 engines) is intentionally deferred. C8's scenario classifier exists as a service but is not yet plumbed into the planner. The substrate is in place; orchestrated rollout per the plan: "all new scenarios + policies ship warning-only behind COACH_PERIODIZATION_V2_ENABLED feature flag" — that flag is not yet wired.
2. **API routes not mounted**: C2 (`POST /api/v1/training/week/travel`), C6 (`POST /api/v1/training/week/:weekId/reflow`), A5 (CoachPlanPolicy edit endpoint) are implemented as service functions but the Express route mounts are not yet added to `src/api/router.ts`. Service-layer tests confirm logic; mounting is a follow-up integration step.
3. **iOS schema versioning not yet enforced**: read-models accept the new fields but no `?schemaVersion=N` query-param routing is implemented. iOS can adopt new fields lazily; old clients shouldn't break because new fields are optional.
4. **No staging soak yet**: per plan, staging soak with feature-flag-on for ≥2 weeks before promoting any rule past warning-only. This work is server-only and tests pass; staging promotion is a separate operator gate.
5. **Adaptation ledger growth**: estimated 50-150K rows/year at 1000 active users with 1-3 reflows/athlete/week. Retention policy (hot 90d, warm 1yr, archive thereafter) is documented in the plan but not implemented as a cron job. Operator concern.
6. **HRV pairing rule strictness**: B5's HRV pairing requires one of {RHR elevated, sleep deficit, subjective fatigue, performance decline, recent load spike}. Solo HRV drops never contribute. This is per Plews-Buchheit but may feel under-responsive to users who track HRV-only. Watch staging metrics.
7. **Anti-churn defaults (1/day, 2/week)** may be conservative for highly active users. CoachPlanPolicy allows override per-plan.
8. **Cold-start gates ACWR universally**: even if ACWR computes to a high value with 12 days of data, B5 ignores it as 'cold_start'. This is conservative but safe.

## What to validate

Please verify, for each numbered "area of concern" above:
- Whether my judgment / deferral is defensible given the v2.1 plan.
- Whether there's any place the implementation drifts from the plan in a way that would require a refactor before staging soak.
- Whether the test coverage adequately exercises the contract (not just the happy path).
- Whether any production wiring is implicitly required (e.g., A4 hard-pause path needs a structured iOS intake form to ever actually fire — is that captured as a known iOS dependency, or did I overlook a server-side bridge?).

Return a verdict (GO / NO-GO / GO-with-followups) plus a punch list of any P0 / P1 / P2 / P3 findings.
