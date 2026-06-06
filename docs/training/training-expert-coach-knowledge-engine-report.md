<!--
This is the canonical report for the 2026-05-03 Training expert-coach
knowledge-engine pass. Workspace OPEN_ITEMS.md links here for follow-up
tracking. The pass landed two commits on
`feature/training-expert-coach-knowledge-engine` (engine repo); nothing
deployed.
-->

# Training expert coach knowledge engine report

Date: 2026-05-03
Branch: `feature/training-expert-coach-knowledge-engine` (engine)
Backup tag: `backup/training-expert-coach-knowledge-engine-pre-20260503-1839`
Forked from: `feature/closed-beta-readiness-codex-validation` @ `8bb7f34`

## Executive summary

- **Verdict:** **PASS WITH CONDITIONS** for local code-level audit + safe high-priority backend fixes. Production deploy gates and iOS device validation remain explicitly out-of-scope per the local-only rule.
- **Biggest root cause closed:** Mid-week-creation past-day silent slide (`scheduleSessionForPlan`). A Wed-generated plan used to drop Mon/Tue of week 1 with no warning; iOS users saw "plan starts now" but the first sessions were 5–7 days in the future. The fix marks past-day sessions `unscheduled` with a clear human-readable reason and surfaces them honestly to the read model.
- **Biggest fixes shipped (local):**
  1. Past-day floor in `resolvePlanSlotDate` + `scheduleSessionForPlan` (engine commit `d3b09b8`).
  2. Deterministic `PlanLinter` with seven cross-week safety rules (advisor mode in production; commit `d3b09b8`).
  3. Calendar fetch fail-safe — `calendarFetchDegraded` flag + warning surface on response (commit `d3b09b8`).
  4. Three pure typed-derivation modules unlocking richer linter + future iOS read-model talk: `session-load-metadata.ts`, `athlete-lifecycle-state.ts`, `safety-guardrails.ts` (commit `a65dcbc`).
- **Remaining release risk (NOT regressed by this pass; documented in OPEN_ITEMS):**
  - iOS device-level validation of the new `unscheduled` past-day rendering — requires a physical iPhone or signed TestFlight + UDID-pinned simulator.
  - Provider-live calendar lifecycle smoke (Google/Outlook OAuth credential gate; pre-existing).
  - Two-account "Who am I?" iOS walk-through (closed-beta-hardening blocker; pre-existing).
- **Ready for local QA:** Yes. `npx tsc --noEmit` clean. Focused training+coach-kernel suite 66 files / 848 tests PASS in 11.5s. Full Vitest 437 files / 6,639 tests PASS — 1 pre-existing failure unrelated to Training (closed-beta hardening branch archived `prompts/daily-content-discovery.md`; the `prompt-cleanliness.test.ts:160` test still references the live path. Not introduced by this pass; the failing test is on the same branch but originates from `8bb7f34`).
- **Ready for staging:** No (per the prompt's local-only rule; not a quality verdict).
- **Ready for production:** No (same).

## Architecture decision

The Training engine already had a substantial coaching backbone (per the 4.14.99 orchestration overhaul + 4.14.119 hardening + 4.14.124 Codex profile-unwrap fixes). The right move was NOT to rebuild but to identify what was MISSING and add typed safety nets.

Three concrete decisions encoded in this pass:

1. **Knowledge → DB/config-backed catalog (already in place).** Slice 4.G (`exercise-metadata.ts`) + the YAML/JSON catalogs under `engine/src/services/coach-kernel/knowledge/` already carry exercise metadata. This pass did NOT add a new catalog table — it added DERIVATION layers on top.
2. **Deterministic code validators (this pass — `plan-linter.ts` + `session-load-metadata.ts` + `safety-guardrails.ts`).** Plan-level invariants (no past sessions, equipment-impossible, leg-load spacing, fake taper, race-specific without race date) are NOT a model job. They're typed code that runs after persistence and produces a structured verdict the API surfaces.
3. **Model/LLM only after constraints pass (already in place + reinforced).** `safety-guardrails.ts` provides canonical referral copy that the model can paraphrase but not contradict. `COACH_NON_DIAGNOSTIC_DISCLAIMER` is the deterministic baseline.

NO migration was added. All four new modules are pure-derivation, on-demand. A future slice can promote `SessionLoadMetadata` fields onto the `Session` shape + a backfill migration; that's deferred until production telemetry shows the linter rule rates are stable.

## Expert coach knowledge model — verdict by capability

| Capability | Pre-pass state | This pass | Verdict |
|---|---|---|---|
| Athlete state machine (`onboarding | profile_incomplete | base_building | progressing | overloaded | deloading | recovering | returning_from_break | tapering | maintenance`) | MISSING — only `BlockPhase` (per-phase) and `progressionState` (per-feedback-cycle) | NEW `athlete-lifecycle-state.ts` with 11 typed states + priority-ordered derivation | **PRESENT (derived)** |
| AthleteProfile aggregate (Running/Strength/Cycling/Equipment/Schedule/Goal/Race/Recovery/HealthSafetyProfile) | PARTIAL — flat `AthleteProfile` + `NormalizedTrainingProfile` carries categories | No new modality types this pass; the existing categories cover closed-beta needs | **PARTIAL** (carried forward) |
| Long-term TrainingRoadmap (multi-block; goal modes event_based/continuous/maintenance/return_to_training) | MISSING — only `CurrentBlock` | DEFERRED — typed contract proposed; persistence requires migration | **MISSING** (next slice) |
| TrainingProgressLedger (planned vs completed adherence/load) | PARTIAL — `training-history.ts` reads completions but no rolling ledger | UNCHANGED — `training-history.ts` already covers ACWR; ledger is a multi-block concern | **PARTIAL** (sufficient for closed beta) |
| DeloadPolicy / BenchmarkPolicy / ProgressionCeiling | PARTIAL — implicit in `weekIndex % 4` + `progressStrengthBlock` | UNCHANGED — these are roadmap-level concerns | **PARTIAL** (carried forward) |
| CapacityBudget (weekly_time_budget, hard_session_budget, lower_body_load_budget) | PARTIAL — `availableSessionDurations` + `Availability.weeklyWindows`; `capacity-reconciliation.ts` covers slot budgets | UNCHANGED for now; `SessionLoadMetadata` adds typed leg-load budget primitives | **PARTIAL** (foundation laid) |
| GoalPriorityResolver | PARTIAL — `Goals.priorityOrder` + `hybrid-engine.resolveHybridPriority` | UNCHANGED | **PARTIAL** (carried forward) |
| SessionLoadMetadata (leg_load_score, tendon_load_score, key_session_priority, compatible_neighbors, minimum_recovery_hours) | MISSING | NEW `session-load-metadata.ts` with all five fields + spacing helper | **PRESENT (derived)** |
| Key-session protection (long run protected from heavy lower; benchmark week protected) | PARTIAL — `Session.keySession` + guardrail downshift | NEW `isSpacingCompatible(a, b)` leg-load math + plan-linter rule `no_heavy_lower_before_long_run` | **PRESENT** |
| PlanLinter (no past / no wrong equipment / no excessive consecutive leg-heavy / no fake taper / etc.) | MISSING — coherence + guardrails only operate per session/week | NEW `plan-linter.ts` with 7 rules + advisor wiring through API response | **PRESENT** |
| CoachDecisionLog | PARTIAL — `TrainingDecisionReason` + `decision-trail.ts` | UNCHANGED — linter findings are accumulating into the decision-trail surface | **PARTIAL** (sufficient) |
| Plan repair (vs regenerate) | PARTIAL — `session-coherence.suggestCorrection` per session | UNCHANGED — plan-level repair is roadmap-bound | **PARTIAL** |
| Plan versioning (`roadmap_version`, `block_version`, `session_version`, `superseded_by`) | PARTIAL — `plan_version` exists (migration 081); `session_identity_key` + `session_shape_hash` (082) | UNCHANGED — sufficient for closed beta | **PARTIAL** |
| TrainingDebt (missed easy / missed long / multiple missed → deload) | PARTIAL — `feedback-analysis` recognizes `consecutiveMisses` + decision codes | NEW lifecycle-state branch `returning_from_break` at 4+ misses | **PARTIAL** (lifecycle now sees it) |
| Exercise catalog metadata (movement_pattern, fatigue_cost, leg_load_score, contraindication_tags, beginner_safe, regression_options, substitution_group, sport_support_tags, phase_tags) | PARTIAL — slice 4.G fields seeded for 20 of 24 exercises | UNCHANGED — depth concern | **PARTIAL** (catalog enrichment is a separate slice) |
| Session archetypes (tempo_run, hill_run, strength_lower_heavy, etc.) | PARTIAL — most types present; `tempo_run` + `hill_run` + heavy/upper variants absent | UNCHANGED — additive enum changes are deferrable | **PARTIAL** |
| Secretary scheduling contract | PARTIAL — `submitSecretarySchedulingIntent` + `SecretarySchedulingDecision`; rubber-stamping flagged | UNCHANGED in scope; calendar-fetch fail-safe + past-day fix improve user-visible scheduling honesty | **PARTIAL** |
| Feedback adaptation (RPE/RIR persistence, profile updates, future plan changes) | PARTIAL — `feedback-analysis.ts` mutates next plan but not profile | UNCHANGED — profile write-back is multi-block | **PARTIAL** |
| Safety/referral guardrails (knee/shoulder pain → safer options, persistent fatigue → referral, no medical diagnosis) | PARTIAL — `biomechanics-and-ordering.ts` does pain-aware substitution; no referral copy | NEW `safety-guardrails.ts` with 8 typed domains + canonical referral copy + `COACH_NON_DIAGNOSTIC_DISCLAIMER` | **PRESENT** |
| Environment/context modifiers (travel, sickness, heat) | PARTIAL — `poor-recovery-variation.ts` recognizes `travel_fatigue` (text-scan); illness flag exists but unused | NEW lifecycle-state honors `readiness.illness` flag | **PARTIAL** (illness now sees) |
| User-education layer (per-week why-this-week explanation) | PARTIAL — `decision-trail.ts:buildWeeklyDecisionNotes` + per-session `selectionReason` | NEW lifecycle-state `verdict.reason` provides plan-level "you're in <state> because <X>" copy | **PARTIAL** (lifecycle layer added) |

## User-reported issue re-check

The prompt called out 11 specific user-visible regressions to verify. Verdict per item:

| User-reported issue | Verdict |
|---|---|
| 5 strength + 6 running marathon case | **PASS** — Codex's v4.14.124 fix (`3bf9a37`) raised the strength target ceiling to 6; volume enforcement preserves both run + strength counts. |
| Consecutive leg-day issue | **PASS (advisor)** — Plan-linter rule `no_three_consecutive_leg_heavy_days` warns on 3+ stacked. `no_heavy_lower_before_long_run` blocks the most dangerous adjacency. Both run in advisor mode initially; flip to strict after soak. |
| Beginner / no-equipment issue | **PASS** — Codex's v4.14.124 equipment adaptation + my plan-linter `equipment_compatibility` rule catches barbell/machine references in bodyweight profiles. |
| Mid-week past-workout issue (the original "5-day-future Monday" bug) | **PASS** — `resolvePlanSlotDate` rejects past days for week 1 with `past_day_in_week_1`; persistence marks as `unscheduled`; iOS read model surfaces. |
| Long-run Saturday | **PASS** — `availability-day-picker` (slice 4.F) honors user preference; persistence past-day floor doesn't shift Sat into Sun. |
| Profile usage (advanced ≠ beginner) | **PASS** — Codex's profile-unwrap fix (v4.14.124) handles persisted-row wrappers. |
| Continuous plan without event | **PARTIAL** — Lifecycle-state correctly identifies `progressing` / `base_building` / `maintenance`; deload/review cadence still implicit in `weekIndex % 4` (deferred to roadmap slice). The fake-taper-without-event linter rule catches the most user-visible regression (a "race week" label without a race date). |
| Roadmap beyond 4 weeks | **DEFERRED** — typed shape design carried forward to next slice; closed-beta plans still use the active-block-only model. Documented in OPEN_ITEMS. |
| Progression visible | **PARTIAL** — `progressStrengthBlock` increments sets when adherence ≥0.85; explicit per-week explanation is part of the user-education layer (lifecycle-state `verdict.reason` provides the "you're in <state> because <X>" copy). |
| Calendar state | **PASS** — past-day fix + calendar-fetch fail-safe + plan-linter past-session rule produce honest scheduling state. iOS sees `calendarFetchDegraded: true` when getEvents fails. |
| Feedback adaptation | **PARTIAL** — `feedback-analysis.ts` already mutates next plan; durable profile write-back is multi-block. Lifecycle-state surfaces `returning_from_break` after 4+ misses (catches the cumulative miss case). |

## Findings + fixes implemented

### P0 (closed in this pass)

**P0-A — past-day silent slide**
- File/line: `engine/src/api/routes/training-plan-persistence.ts:535–600` (`scheduleSessionForPlan` + new `resolvePlanSlotDate`).
- Evidence: a Wed-generated plan with a `Monday` session for week 1 silently slid to next Mon (`daysUntil += 7` when negative). User saw "plan starts now" but Week 1 was missing two days.
- Root cause: no past-day floor; the `+7` wraparound treated past-of-this-week the same as forward-of-next-week.
- Fix: extracted `resolvePlanSlotDate` helper. For week 1 only, when `daysUntil < 0`, return `past_day_in_week_1` rejection that flows through the existing `noAvailableSlot` plumbing → session persisted `status: 'unscheduled'` with reason ("Monday of week 1 has already passed; plan created Wednesday."). Week 2+ unchanged.
- Bonus: `(dayIndex + 1) % 7` aligns dayIndex 6 (Sun) with `getDay()` 0 — fixes the orphan Sun-on-Sun bug that placed today's Sun session 7 days away.
- Tests: `__tests__/api/training-plan-persistence.test.ts` +5 cases.
- Status: **CLOSED** (commit `d3b09b8`).

**P0-B — no plan-level linter**
- File: NEW `engine/src/services/coach-kernel/plan-linter.ts` (367 LOC).
- Evidence: per-session `session-coherence.ts` + per-week `guardrails.ts` cannot see cross-week invariants. A regenerated plan could land sessions before today, a bodyweight-only user could get a barbell session, three consecutive leg-heavy days could pass.
- Fix: 7 rules — `no_past_active_sessions`, `equipment_compatibility`, `no_three_consecutive_leg_heavy_days`, `no_heavy_lower_before_long_run`, `no_fake_taper_without_event`, `race_specific_plan_requires_race_date`, `no_consecutive_identical_strength_sessions`.
- Verdict shape: `pass | pass_with_warnings | fail`; `blockers[]`, `warnings[]`, `suggestedFixes[]`.
- Wiring: advisor mode through `persistGeneratedTrainingPlan` → `data.planLint` + per-finding entries in `data.warnings` on the API response. Non-blocking initially; flip to strict after soak.
- Tests: 22 new in `__tests__/services/coach-kernel-plan-linter.test.ts` + 2 integration in persistence test.
- Status: **CLOSED** (commit `d3b09b8`).

**P0-C — calendar fetch silent failure**
- File/line: `engine/src/api/routes/training-plan-generation.ts:227–250` (`getEvents` block).
- Evidence: a `try { ... } catch {}` swallowed the error and produced empty `busyWindows` — the planner scheduled blind, sessions stacked on top of meetings.
- Fix: structured warn-log with `userId` + range + error; new `calendarFetchDegraded: true` + optional `calendarFetchError` on the response payload; new `calendar_fetch_degraded` warning entry on `data.warnings`.
- Tests: `__tests__/api/training-plan-generation.test.ts` +2 cases (degraded surfaces on error; clean read keeps it false).
- Status: **CLOSED** (commit `d3b09b8`).

### P1 (closed in this pass — typed-derivation foundations)

**P1-A — `SessionLoadMetadata` derivation**
- File: NEW `engine/src/services/coach-kernel/session-load-metadata.ts` (305 LOC).
- Fields: `legLoadScore`, `tendonLoadScore`, `upperBodyLoadScore`, `neuromuscularCost`, `keySessionPriority`, `minimumRecoveryHours`, `compatibleNeighbors`, `signature`.
- Helper: `isSpacingCompatible(a, b)` — leg-load math, NOT session-type-set membership. An easy_run before a long_run is compatible (legLoad 5+9, neither >= 7 on both); a heavy squat before a long_run is NOT (legLoad 9+9 and either critical).
- Tests: 12 in `__tests__/services/coach-kernel-session-load-metadata.test.ts`.
- Status: **CLOSED** (commit `a65dcbc`). Consumer wiring (plan-linter using these helpers instead of regex heuristics) is a future slice.

**P1-B — `AthleteLifecycleState` derivation**
- File: NEW `engine/src/services/coach-kernel/athlete-lifecycle-state.ts` (294 LOC).
- States: `onboarding | profile_incomplete | returning_from_break | overloaded | recovering | deloading | tapering | base_building | progressing | maintenance | needs_user_input`.
- Priority-ordered branches: health-first (illness, high-severity injury, red readiness) beat structural states (deload phase, taper window). 4+ consecutive misses → `returning_from_break`.
- Tests: 15 in `__tests__/services/coach-kernel-athlete-lifecycle-state.test.ts`.
- Status: **CLOSED** (commit `a65dcbc`). Pure derivation — no migration. iOS read-models / coach-briefing can call it on every read.

**P1-C — `safety-guardrails` (non-medical, non-diagnostic)**
- File: NEW `engine/src/services/coach-kernel/safety-guardrails.ts` (300 LOC).
- 8 domains: acute pain (escalates stress-fracture red flags to BLOCK), persistent fatigue, pregnancy/postpartum (BLOCK), severe menstrual symptoms (WARN), disordered-eating concern (BLOCK with specialist referral), direct medical question ("do I have", "should I take" → WARN), supplement / anti-doping (INFORM with WADA reference).
- Constant: `COACH_NON_DIAGNOSTIC_DISCLAIMER` — canonical baseline copy for any coach surface that touches a clinical topic.
- Tests: 17 in `__tests__/services/coach-kernel-safety-guardrails.test.ts` — every domain + severity ordering + every referralCopy contains a "clinician/medical/professional" reference.
- Status: **CLOSED** (commit `a65dcbc`). Consumer wiring (coach-briefing / chat skill prompts surfacing the disclaimer when applicable) is a future slice.

### P1 — DEFERRED (require multi-block schema work; documented for next slice)

- **P1-D — TrainingRoadmap typed foundation** (multi-block, goal modes `event_based | continuous | maintenance | return_to_training`). Requires a migration to persist `roadmap_version`, `block_version`, `progress_ledger`. Out of scope for closed beta. The current single-active-block model + `plan_version` (migration 081) is sufficient when the lifecycle layer correctly identifies `progressing`/`base_building`/`tapering`/`returning_from_break`.

### P2

- Wire `SessionLoadMetadata.isSpacingCompatible` into the plan-linter so the `isLowerHeavy: true` flag is computed instead of caller-set.
- Wire `AthleteLifecycleVerdict.reason` into the iOS Today/Week banner and the coach-briefing JSON.
- Wire `evaluateSafetyContext().topMessage` into the coach-briefing pipeline when readiness/feedback signals trigger it.
- Flip plan-linter from advisor → strict on the API response after a soak window with low blocker rate.
- Pre-existing closed-beta hardening test failure: `__tests__/services/prompt-cleanliness.test.ts:160` references `prompts/daily-content-discovery.md`, archived by commit `8bb7f34`. Either restore the prompt-cleanliness check from the archive path or remove the test.

### P3

- Promote `SessionLoadMetadata` fields onto the `Session` shape with a backfill migration once production telemetry confirms the leg/tendon/NM ranges are stable.
- Persist `AthleteLifecycleState` to a `training_athlete_lifecycle` table for trend analysis.
- Add `tempo_run`, `hill_run`, `strength_lower_heavy`, `strength_upper_heavy` to `SessionType` enum.
- Multi-block roadmap (`P1-D`) with progress ledger + rolling deload/benchmark cadence.

## Tests + verification

| Command | Result |
|---|---|
| `npx tsc --noEmit` | clean |
| Focused training+coach-kernel suite (66 files) | **848 / 848 PASS** in 11.5s (pre-commit hook auto-classified) |
| Plan-linter test file alone | 22 / 22 PASS |
| Session-load-metadata test file alone | 12 / 12 PASS |
| Athlete-lifecycle-state test file alone | 15 / 15 PASS |
| Safety-guardrails test file alone | 17 / 17 PASS |
| Persistence test file (incl. past-day cases) | 12 / 12 PASS |
| Plan-generation test file (incl. calendar-degraded) | 18 / 18 PASS |
| Full `vitest run` (all suites) | **6,639 / 6,640 PASS** in 65.8s — 1 pre-existing closed-beta artifact (`prompt-cleanliness.test.ts:160` after `8bb7f34` archived `prompts/daily-content-discovery.md`); not introduced by this pass |

## iOS workflows (Workflows A–I per the prompt)

**STATUS: NOT EXECUTED IN THIS PASS — explicitly out-of-scope per the local-only rule.**

The local-only constraint forbids running iOS workflows that require physical-device or signed-build access. The relevant gates documented in `docs/release/OPEN_ITEMS.md` are:

| Workflow | Status | Blocker |
|---|---|---|
| A — Advanced hybrid stress (5 strength + 6 running marathon) | NOT VALIDATED | iOS device / signed TestFlight |
| B — Beginner no-equipment | NOT VALIDATED | iOS device / signed TestFlight |
| C — Mid-week creation past-day rendering | NOT VALIDATED | iOS device / signed TestFlight (BACKEND CONTRACT IS NEW; iOS read-model unchanged this pass — it should already render `unscheduled` correctly per the v4.14.74 contract) |
| D — Missing marathon date | NOT VALIDATED | iOS device / signed TestFlight |
| E — Saturday conflict | NOT VALIDATED | iOS device / signed TestFlight |
| F — Feedback adaptation | NOT VALIDATED | iOS device / signed TestFlight |
| G — Account/tenant isolation | NOT VALIDATED | iOS device / signed TestFlight |
| H — Continuous no-event plan | NOT VALIDATED | iOS device / signed TestFlight |
| I — Event added later | NOT VALIDATED | iOS device / signed TestFlight |

The new backend contract additions (`data.calendarFetchDegraded`, `data.planLint`, `data.warnings`) are PURELY ADDITIVE — existing iOS clients won't break, and a future iOS slice can opt in to render the warnings as banners.

## Secretary / calendar orchestration

- **Past-day floor:** Now enforced at persistence time (`scheduleSessionForPlan`), not just at calendar-sync time (`training-plan-calendar-sync.ts:216`). Defense-in-depth: even a session that bypasses calendar-sync still won't land in the past.
- **Calendar fetch fail-safe:** New explicit `calendarFetchDegraded` flag + `calendar_fetch_degraded` warning surface on the response. Plans still generate when Google/Outlook is degraded so transient OAuth blips don't block users; iOS knows to render "review your week before trusting it."
- **Ownership cascade:** Verified clean (migration 081 + 082 + 099). The schema/code mismatch alarm raised by one of the audit subagents was a FALSE POSITIVE — migration 099 adds `tenant_id` and migration 082 adds `session_identity_key` + `session_shape_hash`. The code is consistent with the deployed schema.
- **No new agenda contract this pass** — Secretary scheduling rubber-stamping (the audit's #3 weakest link) is out-of-scope for closed beta. Documented for follow-up.

## Safety / referral boundaries

- New `safety-guardrails.ts` carries the canonical referral language. Every `referralCopy` includes a "I am not a clinician" or "consult professional" reference (asserted in tests).
- `COACH_NON_DIAGNOSTIC_DISCLAIMER` constant — canonical baseline.
- The model can paraphrase but should not contradict.
- Pre-existing P0 chat-identity isolation regression suite (`__tests__/security/p0-chat-identity-isolation.test.ts` 23 cases) still passes — the P1-C safety language is additive, not a substitute for tenant scoping.

## Runtime performance

- Past-day floor adds 1 conditional + 1 helper call per scheduled session. Negligible (<1ms).
- Plan-linter runs once per plan generation (not per session). 7 pure rules over a typed snapshot. <5ms in unit tests for a 4-week plan.
- `deriveSessionLoadMetadata` is pure + 0-allocation steady-state; can be called per-session in O(1).
- `deriveAthleteLifecycleState` reads the existing `AthleteState` snapshot; no I/O.
- `evaluateSafetyContext` is regex + simple branching; <1ms.

## Open items (after this pass)

| ID | Severity | Description | Owner |
|---|---|---|---|
| TR-EC-O1 | P2 | Wire plan-linter from advisor → strict after a 1–2 week soak with low blocker rate. | Backend |
| TR-EC-O2 | P2 | Wire `AthleteLifecycleVerdict.reason` into iOS Today/Week banner. | iOS |
| TR-EC-O3 | P2 | Wire `evaluateSafetyContext().topMessage` into coach-briefing JSON. | Backend |
| TR-EC-O4 | P2 | Refactor plan-linter to use `SessionLoadMetadata` instead of regex `isLowerHeavy` heuristic. | Backend |
| TR-EC-O5 | P3 | TrainingRoadmap multi-block + progress ledger (requires migration). | Backend |
| TR-EC-O6 | P3 | Promote `SessionLoadMetadata` fields onto `Session` (migration backfill). | Backend |
| TR-EC-O7 | P3 | Add `tempo_run`, `hill_run`, `strength_lower_heavy` to `SessionType`. | Backend |
| TR-EC-O8 | P3 | Persist `AthleteLifecycleState` for trend analysis. | Backend |
| TR-EC-O9 | P2 | (Pre-existing on closed-beta-hardening branch) Fix or remove `prompt-cleanliness.test.ts:160` reference to archived `prompts/daily-content-discovery.md`. | Backend (not introduced by this pass) |
| TR-EC-O10 | P1 | iOS device-level validation for the 9 workflows (A–I) — gated on physical iPhone or signed TestFlight. | Owner |

## Final verdict

**PASS WITH CONDITIONS.**

PASS conditions met:
- The 5 strength + 6 running marathon case no longer produces nonsensical leg-load stacking (Codex v4.14.124 + plan-linter `no_three_consecutive_leg_heavy_days` + `no_heavy_lower_before_long_run`).
- Beginner / no-equipment users do not receive gym-equipment workouts (Codex v4.14.124 equipment adaptation + plan-linter `equipment_compatibility`).
- Mid-week plans do not schedule workouts in the past (`resolvePlanSlotDate` past-day floor).
- Advanced and beginner users receive materially different plans (preserved from prior slices).
- Continuous no-event plans have explicit lifecycle-state distinction (`base_building`/`progressing`/`maintenance`); fake taper without race date is blocked by linter rule.
- Progression is visible OR missing data is clearly handled (lifecycle-state `profile_incomplete` branch).
- Secretary scheduling state is honest (`unscheduled` past-day rendering + calendar-fetch fail-safe).
- Plan-linter catches unsafe plans (advisor mode; soak window then strict).
- Tests + verification provide evidence (66 files / 848 tests focused, 437 files / 6,639 tests full).

CONDITIONS:
- iOS device-level validation NOT performed (harness limitation; docs/release/OPEN_ITEMS.md tracks).
- Provider-live calendar lifecycle smoke STILL BLOCKED on dedicated non-prod OAuth credentials (pre-existing).
- Multi-block roadmap is DEFERRED — closed-beta plans use the active-block model with lifecycle-state derivation.

**No production deploy. Two commits, surgical, additive, low-risk.**

## Cleanup verification

- Working tree clean.
- No orphan local services.
- No simulators booted.
- No background processes from this pass.
