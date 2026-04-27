# Training Engine — Open Items

Items that remain open after the overhaul, organized by priority.

Last updated: 2026-04-27 after slice 4.H shipped to working branch + staging green.

---

## Critical (blocking beta)

*(none — all three audit-confirmed regressions are closed at root cause; Layers 4, 7, 8 deepened to audit specs)*

## High

*(none — Layers 2, 3, 5 also closed via slices 4.G/4.F/4.C/4.H)*

## Medium

### Layer 6 — Week-level adaptability

`adaptation-engine.ts` handles per-session readiness downshift but no week-level reflow:
- Missed session → next session compensates? Skipped?
- Schedule change mid-week → re-distribute remaining sessions?
- Travel week with hotel gym → swap variants to dumbbell-only?
- Adherence trending low → simpler prescriptions?
- Return after 2-week interruption → reduced re-entry volume?

### Layer 9 — Progression & periodization

`strength-blocks.yaml` has phase-aware templates but the planner doesn't differentiate week 1 from week 8 within the same plan. No rep-range progression, no load progression, no block transitions, no deload weeks, no re-entry logic.

The slice 4.E real-history reads + slice 4.C macro-rotation provide the foundation; a future slice can layer per-block volume/intensity progression on top.

### Goal → split → role mapping (deferred from slice 4.F)

Audit Layer-3 finding called for mapping (goal, days/week) → split shape (e.g. hypertrophy + 4 strength/week → Push/Pull/Legs/Upper, vs hybrid + 3 → Full×3). Slice 4.F focused on the higher-leverage day-availability fix; the split-mapping piece is additive enhancement that can ship independently. The `strengthVariantFor` table already supports 4-/3-/2-session splits but they're hardcoded by sessionsPerWeek; goal→split would parameterize that further.

## Low

### Layer 10 — Explainability polish

Decision trail items appear duplicated in iOS Today hero (`"Training is scheduled but meals are missing"` appears twice). No plan-level explanation card. Explanations not attached to specific plan decisions.

### Code smell — duplicate `scoreToReadinessLevel`

Defined twice (canonical in `readiness-snapshot-adapter.ts:72`, dup in `training-coach-kernel-plan-generator.ts:457`). Silent divergence risk. Owning slice would refactor the plan generator's duplicate to import the canonical version.

---

## Items intentionally deferred

(With rationale for why they're scoped out of this overhaul.)

### LLM-driven session generation

Audit explicitly chose to preserve the rule-based + template-driven engine as a strength. LLM session generation is not considered. Deterministic engines are testable, stable in cost, and produce consistent UX.

### Rebuild of the 8-layer architecture

The overhaul EXTENDS the existing layers — none torn down. The slice cadence preserves shippability per slice and rollback safety.

### iOS code changes

Out of scope per the original prompt. Backend contract changes preserve iOS compatibility:
- New required fields: none
- Removed fields: none
- Changed semantics: `Session.durationMinutes` may be lower (honest), `TrainingPlanGenerationResult` gains a `'cancellation_failed'` branch the iOS error handler can opt into.

### Diagnostic medical recommendations

Explicitly out of scope per the prompt.

### Forced novelty everywhere

Audit prompt explicitly accepted that intentional repeats are fine when justified. The variety fix (slices 4.B + 4.C) targets the unjustified repeats (text-string injection bypassing the catalog + within-week-only rotation).

### UI redesign

Out of scope per the prompt.
