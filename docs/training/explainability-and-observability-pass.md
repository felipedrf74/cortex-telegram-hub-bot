# Training Explainability and Observability Pass

## Summary

This pass makes the Coach kernel's decision trail more explicit, less repetitive, and easier to inspect without turning the user-facing plan into a debug dump.

The previous planner assembled user-facing notes from loose strings such as `Phase`, `Readiness`, and `Compliance`. Guardrail reasons were preserved structurally, but daily rationale could repeat the same warning after plan updates or repeated guardrail passes.

## Changes

- Added a decision-trail utility for user-facing note normalization and deduplication.
- Replaced generic weekly notes with explicit explanations for:
  - weekly structure
  - readiness decision
  - adherence decision
- Rebuilt weekly decision notes from the final post-guardrail plan state so stale phase/readiness summaries are not retained after deload or fatigue adjustment.
- Deduplicated daily rationale lines while preserving all raw guardrail results for downstream inspection.
- Added safe debug logging around:
  - weekly plan generation
  - fatigue adjustment
  - strength session coherence correction
  - biomechanics/equipment/safety substitution evaluation

## Observability Contract

Planner debug logs include only operational metadata:

- athlete id
- week start
- discipline
- phase
- session counts
- adjusted guardrail ids
- feedback decision count
- decision note count

Strength-session debug logs include:

- session id/type
- claimed versus estimated minutes when coherence fails
- selected correction type
- swapped or unresolved exercise ids during safety substitution

No user names, free-form questionnaire text, notes, health values beyond readiness level/score, or raw payloads are logged by this pass.

## Files Changed

- `src/services/coach-kernel/decision-trail.ts`
- `src/services/coach-kernel/planner-engine.ts`
- `src/services/coach-kernel/engines/strength-engine.ts`
- `src/services/coach-kernel/index.ts`
- `__tests__/services/coach-kernel-decision-trail.test.ts`
- `__tests__/services/coach-kernel-planner.test.ts`

## Remaining Work

- Add structured explanation fields to API contracts if iOS needs more than the existing `notes` and `rationale` arrays.
- Consider making guardrail display filtering explicit in a DTO layer instead of relying on planner rationale composition.
- Add request-scoped correlation ids to agenda reconciliation logs if plan lifecycle debugging needs cross-service traces.
