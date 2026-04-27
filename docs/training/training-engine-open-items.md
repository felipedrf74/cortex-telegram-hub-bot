# Training Engine — Open Items

Items that remain open after this overhaul, organized by priority.

Last updated: 2026-04-27 after slice 4.D shipped to working branch + staging green.

---

## Critical (blocking beta)

*(none — all three audit-confirmed regressions are closed at root cause)*

## High

### Slice 4.D follow-up — saga for cancel-then-persist on regenerate

The audit identified four compounding root causes for regression #3.
Slice 4.D addressed (2) idempotency and (3) supersession in the
durability layer. Two remain:

- **Root cause #1**: no transaction wrapping cancel + persist on regeneration. If `cancelTrainingPlanForUser` succeeds but `persistGeneratedTrainingPlan` throws partway through its loop, the user ends up with no plan + partial calendar events. With the new ownership audit table, the orphan case is now *recoverable* (the events are queryable), but the saga itself is still missing.
- **Root cause #4**: silent error suppression on the regeneration cancel catch in `generateTrainingPlanForUser` (audit reference: `training-coach-kernel-plan-generator.ts` lines 254-265). The new ownership audit makes silent failure observable, but the catch block itself is unchanged.

Recommended approach for a follow-up slice 4.D.2:
1. Wrap regen in a saga: increment plan_version → persist new plan → cancel old plan; if persist fails, rollback (`incrementPlanVersion` would need to be undoable, or use a fresh planId for the new attempt).
2. Replace the silent catch with an explicit failure-mode taxonomy: `cancellation_failed_external_delete` → continue with new plan + queue reconciliation; `cancellation_failed_local_delete` → bail and re-run.
3. Surface the failure mode on the response so iOS can render an actionable banner.

### Slice 4.E — Real metrics history reads

Audit Layer 8 finding (Critical, blocks credible long-term coaching).
`tailored4WeekMinutesBySport` is currently 4 copies of one computed
value, making ACWR meaningless. The engine needs to read real
adherence + RPE + load history from `training_completions` at plan
generation time. Without this, the system can't detect plateau,
under-recovery, or progression.

### Slice 4.C — Multi-week variant rotation

Slice 4.B closed the within-week variety failure. The audit also flagged a multi-week rotation gap: `strengthVariantFor`'s `index` resets to 0 every week, so Week 1 day 1 = Week 5 day 1 = Week 12 day 1 across an 8-week plan. Fix: track `recentStrengthVariants` in `AthleteState` and skip recently-used variants.

### Slice 4.F — Goal→split→role mapping for weekly orchestration

Audit Layer 3 finding (High, drives regression #2 from a different angle). The planner doesn't map (goal, days/week) → split shape (Push/Pull/Legs vs. Upper/Lower×2 vs. Full×3). Hardcoded day slots in running/cycling engines ignore user availability windows.

### Slice 4.G — Catalog metadata enrichment

Audit Layer 2 finding (High, blocks 4.H). Exercise catalog is shallow
— missing `primaryPurpose`, `complexity`, `spinalLoading`,
`unilateral`, `roleCompatibility`, `contraindicationFlags`,
`expectedSetMinutes`, `warmupNeeds`, `interferenceCompatibility`. Layer
5/7 quality is gated by this.

## Medium

### Slice 4.H — Biomechanics-aware substitution + session-order logic

Depends on 4.G (catalog enrichment). Add: substitution by movement
role (not just muscle name), rotation pool per movement family
(goblet_squat → DB step-up → split squat), spinal-loading-aware
substitution for users with discomfort flags, exercise-order logic
within a session (compound first, isolation last), warmup-relevance
check tied to session content.

### Layer 6 week-level adaptability

Audit finding (High). `adaptation-engine.ts` handles per-session
readiness downshift but no week-level reflow:
- Missed session → next session compensates? Skipped?
- Schedule change mid-week → re-distribute remaining sessions?
- Travel week with hotel gym → swap variants to dumbbell-only?
- Adherence trending low → simpler prescriptions?
- Return after 2-week interruption → reduced re-entry volume?

### Layer 9 progression & periodization

Audit finding (High). `strength-blocks.yaml` has phase-aware templates
but the planner doesn't differentiate week 1 from week 8 within the
same plan. No rep-range progression, no load progression, no block
transitions, no deload weeks, no re-entry logic.

### Code smells from the audit (deferred until owning slice lands)

| Smell | Owning slice |
|---|---|
| `scoreToReadinessLevel` defined twice (canonical in `readiness-snapshot-adapter.ts:72`, dup in `training-coach-kernel-plan-generator.ts:457`) | Slice 4.E (will refactor the plan generator) |
| Running/cycling engines hardcode day slots ignoring user availability | Slice 4.F |
| Swimming engine hardcodes 45/55/50/35 min regardless of pool window length | Slice 4.F |
| `buildAvailabilityWindows` gives every day a 90-min strength window — no rest-day enforcement | Slice 4.F |

## Low

### Layer 10 — Explainability polish

Decision trail items appear duplicated in iOS Today hero (`"Training is scheduled but meals are missing"` appears twice). No plan-level explanation card. Explanations not attached to specific plan decisions.

---

## Items intentionally deferred

(With rationale for why they're scoped out of this overhaul.)

### LLM-driven session generation

Audit explicitly chose to preserve the rule-based + template-driven
engine as a strength, not a weakness. LLM session generation is not
considered. (Rationale: deterministic engines are testable, stable in
cost, and produce consistent UX. The overhaul deepens the
deterministic engine rather than replacing it.)

### Rebuild of the 8-layer architecture

The overhaul EXTENDS the existing layers — none are torn down. The
slice cadence preserves shippability per slice and rollback safety.

### iOS code changes

Out of scope per the prompt. Backend contract changes preserve iOS
compatibility (no new required fields, no removed fields, only honest
duration claims and richer ownership audit data).

### Diagnostic medical recommendations

Explicitly out of scope per the prompt.

### Forced novelty everywhere

Audit prompt explicitly accepted that intentional repeats are fine when justified. The variety fix targets the unjustified repeats (text-string injection bypassing the catalog).

### UI redesign

Out of scope per the prompt.
