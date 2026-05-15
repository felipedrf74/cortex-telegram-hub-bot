# Training Engine — Gap Analysis

Status: **Phase 0 audit COMPLETE. Root causes confirmed. Awaiting check-in before Phase 1 rewrite.**
Audit date: 2026-04-27
Anchor commit: `96c61fb` (= `origin/main` = `4.14.97`)
Reference: see `training-engine-orchestration-overhaul-spec.md` for architectural target.

---

## Executive summary of root causes

The three observed regressions trace to **three structural gaps in the engine**, not bugs:

1. **No session coherence validator exists.** The duration is window-derived first, the exercise count is capped from duration second, but no function ever checks that the prescribed exercise list at realistic set/rest times actually fills the claimed duration. A 60-min session with 5 exercises × 3 sets × 2 min + 90s rest is ~87 min of real work — systematically over-prescribed. The 48-min "Dead Bug 2×10–15 only" session is the inverse: under-prescribed content for a duration claim that wasn't sanity-checked.

2. **No multi-week variant rotation exists.** Within a single week, `strengthVariantFor(profile, targetSessions, index)` rotates by slot index (0→Lower A, 1→Upper A, 2→Lower B, 3→Upper B). But `index` resets from 0 at every week's generation. Week 1 day 1 = Week 5 day 1 = Week 12 day 1. Compounding this: `enforceRequestedTrainingPlanVolume → strengthSupportVariants()` injects HARDCODED EXERCISE NAME STRINGS (not IDs) for "missing" sessions, bypassing the substitution graph and the beginner-safe layer. Three "identical" consecutive strength days is the visible signature.

3. **No plan lifecycle state machine exists.** Cancellation works in the happy path (per-session calendar deletes via `(session_id → event_id)` linkage, then FK-cascade hard-delete). But: cancel-then-persist isn't transactional; the cancellation error path is silently swallowed (`generateTrainingPlanForUser` catch block lines 254-265); there's no `plan_version` for supersession; the system can leave both old and new plans + both calendar event sets coexisting if cancellation fails after a successful persist.

These are documented in detail below. Each maps to a slice candidate in the Phase 1 spec.

---

## Mandatory regression #1 — Volume × time mismatch

**Symptom**: A "Lower Body Strength A" session shows ~48 min total with one small exercise (Dead Bug 2×10–15) plus generic warm-up/cool-down.

### Current state (audit-confirmed)

- **Duration source**: `resolveDurationForDay` in `src/services/coach-kernel/engines/strength-engine.ts:443-459`. Finds availability windows for the day with `sport: 'strength'`, computes window length, picks the **largest** `template.durationOptionsMinutes` that fits. The three strength templates in `knowledge/templates/strength-blocks.yaml` define `durationOptionsMinutes`: `strength_max [45, 55, 60]`, `strength_hypertrophy [40, 50, 60]`, `strength_maintenance [30, 40, 45]`.
- **Window source**: `buildAvailabilityWindows` in `src/services/training-coach-kernel-plan-generator.ts:1209-1239` gives **every day a 90-minute strength window** by default (`preferredStrengthTime` → +90min). So the largest fitting option is always 60 (or 45 for maintenance).
- **Exercise count**: `targetExerciseCount(durationMinutes, experience)` in `strength-engine.ts:348-357` (slice 3.H) caps by duration. 60 min advanced → 6, others → 5. 45 min → 5. 35 min → 3 (slice 3.H tier).
- **Exercise selection**: `resolveExercises` (lines 359-428) takes `variant.exerciseIds + template.defaultExercises`, deduplicates, walks substitution graph, fills with hardcoded fillers up to `targetExerciseCount`.
- **Claimed total**: `Session.durationMinutes` is the duration from step 1, surfaced unchanged to the iOS layer.

### Root cause

**No coherence validator.** Nothing checks "given this exercise list at realistic set times + rest + transitions + warmup/cooldown, does it actually fit `durationMinutes`?" Two parallel pipelines (window→duration, then duration→exercise count) never reconcile.

For the 48-min Dead Bug case specifically: the session is likely a **support/recovery session that picked maintenance template's 45 min** + some scheduler padding, with content that came in below the targetExerciseCount (e.g. only Dead Bug + Goblet Squat substitution, of which Goblet Squat got dropped by some path), and surfaced anyway because nothing rejected the sparse session.

### Severity

**Critical** — produces user-visible incoherence and degrades trust.

### Slice candidate

Layer 4 (Session Generator) extension. Add `SessionCoherenceValidator`:

```typescript
type CoherenceVerdict =
  | { ok: true; estimatedMinutes: number }
  | { ok: false; reason: 'underfilled' | 'overstuffed'; estimatedMinutes: number; suggestedAction: 'rebuild' | 'shrinkDuration' };

estimateSessionMinutes(session: Session, knowledge: CoachKnowledge): number;
validateCoherence(session: Session, knowledge: CoachKnowledge, tolerancePct = 0.20): CoherenceVerdict;
```

Wire into the engine's session-output pipeline so any session whose estimated minutes diverge from claimed by >20% is rebuilt (add work) or shrunk (lower claim) before surfacing. Pin with tests covering the 48-min-Dead-Bug shape.

---

## Mandatory regression #2 — Variety / repetition

**Symptom**: Three consecutive strength days are essentially identical.

### Current state (audit-confirmed)

- **Slot-based variant rotation**: `strengthVariantFor(profile, targetSessions, index)` in `strength-engine.ts:217-295`. For `targetSessions=4`: index 0→Lower A, 1→Upper A, 2→Lower B, 3→Upper B (good within-week). For `targetSessions=2`: 0→Full Body A, 1→Full Body B.
- **Week reset**: `index` is the position in `resolveStrengthDays`' output (line 519: `days.slice(0, targetSessions).map((dayOfWeek, index) => ...)`). `rollAthleteStateForward` (lines 1382-1405) does NOT track variant history — it only updates `lastWeekMinutesBySport` for ACWR. So **every week starts from index 0 with the same variant assignment**.
- **Volume enforcement back-fill**: `enforceRequestedTrainingPlanVolume` in `training-plan-volume-enforcement.ts:24` calls `fillMissingStrength → strengthSupportVariants()` (lines 296-341). This function returns **HARDCODED EXERCISE NAME STRINGS** (e.g. `"Front Squat / Goblet Squat"`) — NOT exercise IDs from `exercises.json`. They bypass:
  - The substitution graph (no equipment-aware adaptation)
  - `applyBeginnerSubstitutions` (slice 2.A — novices get adult barbell prescriptions as plain text)
  - The full session-shape generation (these are flat string lists, not `Session` objects)

### Root cause

**Two compounding bugs**:

1. The slot rotation IS designed for within-week variety, but it's reset every week. Block-level / multi-week rotation doesn't exist.
2. When the planner under-generates (e.g. the strength engine returns 1 session but the user requested 3 strength sessions/week), `enforceRequestedTrainingPlanVolume` injects identical text-string sessions to fill. The "3 identical strength days" symptom is most likely THIS — not the slot rotation failing.

### Severity

**Critical** — degrades coaching credibility immediately.

### Slice candidate

Two slices, in this order:

**Slice A — Replace `strengthSupportVariants()` text strings with proper Session generation.** Have `enforceRequestedTrainingPlanVolume` call into the strength engine to generate REAL sessions (with exercise IDs, substitution graph, beginner-safe layer, target exercise count) for the missing slots, instead of synthesizing flat text. This alone closes most of the "identical" symptom because real sessions go through the slot rotation.

**Slice B — Multi-week variant rotation.** Add `recentVariantHistory` to `AthleteState` (e.g. `recentStrengthVariants: ['lower_body_a', 'upper_body_a', ...]` from the last 4 weeks). Modify `strengthVariantFor` to skip variants used in the last N weeks. Track running and cycling key-session shapes the same way. Tests pin: 8-week plan with 4 strength/week produces ≥4 distinct variants per slot across the 8 weeks.

---

## Mandatory regression #3 — Agenda lifecycle (create + cancel + replace)

**Symptom**: Plans don't reliably create calendar entries; cancelling/replacing doesn't reliably delete the old entries.

### Current state (audit-confirmed)

- **Status enum**: `TrainingPlan.status` is `'active' | 'completed' | 'paused' | 'cancelled'` on the `fitness_training_plans` table (`src/services/training-plans.ts:37`). `updatePlanStatus` (line 256) lets any status be set directly — no transition state machine.
- **Calendar ownership**: per-session, not per-plan-version. `training_sessions` carries `calendar_event_id` + `calendar_source` columns (lines 77-78). `linkSessionToCalendar` (line 443) writes them after event creation.
- **No `plan_version`** field anywhere.
- **Activation path**: `persistGeneratedTrainingPlan` (`training-plan-persistence.ts:75`) loops sessions, calls `scheduleSessionWindow`, creates the plan + sessions, then loops again calling `createTrainingCalendarEvent` (with rate-limit retry) + `linkSessionToCalendar` per non-mobility session.
- **Cancellation path**: `training-plan-cancellation.ts:119-176`. Reads `(event_id, source)` per session, calls `deleteEvent` for each in `Promise.allSettled`, then `deletePlanHard` (FK CASCADE drops the sessions).
- **Regeneration path**: `generateTrainingPlanForUser` calls `cancelTrainingPlanForUser` BEFORE `persistGeneratedTrainingPlan` to clear the prior plan. The catch block (lines 254-265) **suppresses cancellation errors** and continues to the new persist.

### Root causes (compounding)

1. **No transaction wrapping cancel + persist.** If cancel succeeds but persist throws mid-loop (rate-limit, bot offline), user ends up with no plan. If persist succeeds but cancel had silently failed, user ends up with both old + new plans + both calendar event sets.
2. **No idempotent calendar create.** If create-event fails partway through the loop (e.g., 5 of 12 succeed, then rate-limit ejection), the persist function has no resume path — re-running would duplicate the first 5.
3. **No supersession state.** `'superseded'` doesn't exist as a status. Hard-delete is the only path. Audit history is lost.
4. **Silent error suppression** on the cancellation catch.

### Severity

**Critical** — the failure mode produces orphaned calendar items + missing scheduled events, both of which damage user trust visibly.

### Slice candidate

Layer 7 (Calendar/Event Sync Reconciler) — add `TrainingPlanLifecycleManager`:

```
States:    draft → active → scheduled → completed
                      ↘   superseded  ↗
                      ↘   cancelled
```

- New `plan_version` integer on the plan row (default 1, bumps on regenerate)
- New `agenda_event_ownership` mapping table: `(plan_id, plan_version, day, session_id, calendar_event_id, calendar_source, created_at)` — survives plan-row deletion so we can audit-trail orphans
- State transitions are explicit: `transitionPlanState(planId, target, ctx)` validates source-state and runs the side-effect (e.g. `active → cancelled` triggers per-session calendar delete via the ownership table)
- Idempotent activation: re-running activate on an already-active plan with all events linked = no-op
- Saga pattern for cancel-then-persist on regenerate: if persist fails after cancel, transition the new plan to `'failed'` state and re-activate the prior plan (or surface the failure clearly)

Tests pin: every state transition's side effects, idempotency under retry, no orphan events after sequenced regen + cancel + regen + cancel.

---

## Other capability areas — audit findings

### Layer 2 — Training Domain Model / Catalog

**Current state**: `knowledge/entities/exercises.json`, `knowledge/templates/strength-blocks.yaml` (3 templates), `run-workouts.yaml`, `bike-workouts.yaml`, `swim-workouts.yaml`. Loaded once via `knowledge-loader.ts → loadCoachKnowledge()`, cached module-level.

**Gap**: catalog metadata is shallow. Need to enrich exercises with: `movementPattern`, `primaryPurpose`, `equipmentRequired/Optional`, `complexity`, `fatigueCost`, `spinalLoading`, `unilateral`, `roleCompatibility`, `contraindicationFlags`, `expectedSetMinutes`, `warmupNeeds`. For sessions: `sessionRole` (key/long/recovery/etc.), `interferenceCompatibility`.

**Severity**: High (blocks Layers 5, 7, 9 quality)

### Layer 3 — Plan Orchestration

**Current state**: `planner-engine.ts:88 buildWeekPlan` dispatches to sport engines based on `primaryFocus`, calls `scheduleSessions`, runs `applyGuardrails`. Day-of-week assignments hardcoded per engine (key run = Tuesday, key ride = Wednesday, long ride = Saturday, etc.) — don't check user availability.

**Gap**:
- No goal→split→role mapping (e.g. hypertrophy + 4 strength/week → Push/Pull/Legs/Upper or Upper/Lower×2)
- No multi-week mesocycle structure (deload weeks, accumulation, intensification)
- Rest-day enforcement between heavy lower-body sessions is unguarded (the existing guardrail covers lower-body × key endurance day adjacency only)
- Hardcoded day slots in running/cycling engines ignore user availability windows for default placement

**Severity**: Critical (drives regression #2)

### Layer 5 — Variation & Substitution Engine

**Current state**: `applyBeginnerSubstitutions` (slice 2.A) maps front_squat→goblet_squat etc. for novices. `resolveExerciseCandidate` (strength-engine.ts) uses substitution graph for equipment availability.

**Gap**:
- Substitution by movement role (not just muscle name) doesn't exist for non-beginner cases
- No rotation pool per movement family (always same goblet_squat, never goblet_squat → DB step-up → split squat)
- No biomechanics-aware substitution (e.g. avoid spinal-loading lifts for users with discomfort flags)
- The hardcoded `strengthSupportVariants()` strings bypass substitution entirely

**Severity**: High

### Layer 6 — Adaptability / Autoregulation

**Current state**: `adaptation-engine.ts` (slice 1.C) handles per-session readiness downshift. Red→recovery+60% cap, orange→80%, injury+sport→mobility 50%.

**Gap**: per-session only. No week-level reflow:
- Missed session → next session compensates? Skipped?
- Schedule change mid-week → re-distribute remaining sessions?
- Travel week with hotel gym → swap variants to dumbbell-only?
- Adherence trending low → simpler prescriptions?
- Return after 2-week interruption → reduced re-entry volume?

**Severity**: High

### Layer 7 — Biomechanics & Movement Intelligence

**Current state**: minimal. Substitution graph encodes equipment but not biomechanics.

**Gap**: no spinal/joint loading metadata; no "avoid heavy lower-body the day after long run" rule beyond a single guardrail; no exercise-order logic within a session (compound first, isolation last); no warmup-relevance check (current warmups are generic strings detached from session content).

**Severity**: Medium-High

### Layer 8 — Metrics & Feedback Analysis

**Current state**: `tailored4WeekMinutesBySport` initialized as 4 copies of one computed value. ACWR comparison always against synthetic identical history. **No actual reads from `training_completions` at plan-generation time** — the system doesn't use real adherence + RPE + load history.

**Gap**: this is foundational and missing. The engine cannot detect plateau, under-recovery, or progression because it doesn't read real outcomes.

**Severity**: Critical (blocks credible long-term coaching)

### Layer 9 — Progression & Periodization

**Current state**: TBD per audit. `strength-blocks.yaml` has phase-aware templates but the planner doesn't appear to differentiate week 1 from week 8 within the same plan.

**Gap**: no rep-range progression, no load progression, no block transitions, no deload weeks, no re-entry logic.

**Severity**: High

### Layer 10 — Explainability

**Current state**: slice 1.C added an adaptation-explanation prefix on iOS Today hero. Decision trail items appear duplicated in the screenshot ("Training is scheduled but meals are missing" appears twice).

**Gap**: no plan-level explanation card; decision trail dedup is missing; explanations are not attached to specific plan decisions.

**Severity**: Medium

---

## Other notable code smells from the audit

| # | Smell | File | Severity |
|---|---|---|---|
| 1 | `scoreToReadinessLevel` defined twice (canonical in `readiness-snapshot-adapter.ts:72`, dup in `training-coach-kernel-plan-generator.ts:457`) — silent divergence risk | both files | Medium |
| 2 | Running/cycling engines hardcode day slots (`'tuesday'`, `'wednesday'`, `'saturday'`) without checking user availability | `running-engine.ts:54`, `cycling-engine.ts:32-55` | High |
| 3 | Swimming engine hardcodes absolute durations (45/55/50/35 min) regardless of pool window length | `swimming-engine.ts:32-52` | Medium |
| 4 | `enforceRequestedTrainingPlanVolume → strengthSupportVariants()` returns hardcoded exercise text strings, bypassing substitution + beginner-safe layer | `training-plan-volume-enforcement.ts:296-341` | **Critical** (drives regression #2) |
| 5 | `buildAvailabilityWindows` gives every day a 90-min strength window — no rest-day enforcement between strength sessions | `training-coach-kernel-plan-generator.ts:1209-1239` | High |
| 6 | `tailored4WeekMinutesBySport` always 4 copies of the same value — ACWR meaningless | `training-coach-kernel-plan-generator.ts` | Critical (Layer 8 foundation) |

---

## Slice plan summary

The overhaul naturally factors into 6-8 slices, each ~60-90 min including deploy:

| # | Slice | Layer | Severity | Independent? |
|---|---|---|---|---|
| 4.A | Session Coherence Validator + estimator | 4 | Critical | yes |
| 4.B | `strengthSupportVariants` → real Session generation | 4+5 | Critical | yes |
| 4.C | Multi-week variant rotation (track recent variants in AthleteState) | 5 | High | depends on 4.A |
| 4.D | Plan lifecycle state machine + ownership table + idempotent sync | 7 | Critical | yes |
| 4.E | Real metrics history reads (replace `tailored4WeekMinutesBySport` synthesis) | 8 | Critical (foundation) | yes |
| 4.F | Goal→split→role mapping for weekly orchestration | 3 | High | depends on 4.A |
| 4.G | Catalog metadata enrichment (Layer 2) | 2 | High | depends on 4.A, blocks 4.H |
| 4.H | Biomechanics-aware substitution + session-order logic | 5+7 | Medium | depends on 4.G |

Each slice ships through the validated-promote pipeline with tests + canonical doc updates, like the slice 3.I-3.M cadence.

---

## What's NOT in the audit (out of scope for this overhaul)

Per the prompt:
- iOS code changes — separate scope
- Diagnostic medical recommendations — explicitly out
- Forced novelty everywhere — intentional repeats acceptable when justified
- UI redesign

Per practical reasoning:
- LLM-driven session generation — none exists today; the engine is rule-based + template-driven, which is a strength to preserve
- Replacement of the existing 8-layer architecture — this rebuild EXTENDS the existing layers (none are torn down)
