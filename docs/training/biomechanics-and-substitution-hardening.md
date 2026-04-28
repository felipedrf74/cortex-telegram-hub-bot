# Biomechanics and Substitution Hardening

## Summary

This pass strengthens the Coach kernel's strength-session safety layer so exercise substitutions are no longer driven by pain flags alone. The substitution pass now evaluates equipment availability, readiness/fatigue, user experience level, spinal loading, exercise complexity, movement pattern, session role, and short-window fit before surfacing a prescription.

The goal is not to medicalize the coach. The engine should avoid obviously poor prescriptions for a user's declared context and produce safer, more repeatable training alternatives.

## Changed Behavior

- Pain/discomfort conflicts still force a substitution attempt.
- Equipment conflicts now force a substitution attempt even if pain is absent.
- Novice athletes are routed away from advanced/expert technique lifts when safer candidates exist.
- Orange/red readiness, high soreness, or low readiness score downshift high-fatigue or high-spinal-loading exercises.
- Short sessions prefer lower-setup, lower-complexity candidates.
- Direct substitution families are preferred before broader same-pattern fallbacks.
- The note on a substituted prescription now explains the reason class: pain/discomfort, equipment, fatigue safety, skill match, or short-window fit.

## Selection Rules

1. Reject candidates that conflict with the user's pain flags.
2. Reject candidates whose equipment is unavailable.
3. Prefer candidates in the original exercise's explicit substitution family.
4. Use same-pattern catalog fallback only if the explicit family has no safe candidate.
5. Score remaining candidates by:
   - movement-pattern preservation
   - purpose preservation
   - lower complexity for novices/fatigued users
   - lower spinal loading for fatigued users
   - lower fatigue cost for low-readiness or short-window sessions
   - session-role fit

## Examples Covered

- `front_squat` with low-back pain: substitutes to a safer squat-pattern option.
- `dumbbell_reverse_lunge` with knee pain and no dumbbells: bypasses unavailable dumbbell options and chooses `lunging_iso_hold`.
- `front_squat` with orange readiness/high soreness: downshifts away from high spinal loading even without a pain flag.
- Novice `front_squat`: routes to `goblet_squat` as a lower-skill, lower-risk entry point.

## Files Changed

- `src/services/coach-kernel/biomechanics-and-ordering.ts`
- `src/services/coach-kernel/engines/strength-engine.ts`
- `__tests__/services/coach-kernel-biomechanics-and-ordering.test.ts`

