# Safety Guardrails Test Matrix

## Automated Coverage Added

| Area | Test File | Scenario | Expected Result |
| --- | --- | --- | --- |
| Discomfort-driven substitution | `__tests__/services/coach-kernel-biomechanics-and-ordering.test.ts` | Low-back pain with `front_squat` | Replaces with a safe substitute and preserves prescription fields |
| Equipment-limited substitution | `__tests__/services/coach-kernel-biomechanics-and-ordering.test.ts` | Knee pain + no dumbbells with `dumbbell_reverse_lunge` | Chooses `lunging_iso_hold` instead of unavailable dumbbell candidates |
| Fatigue-safe substitution | `__tests__/services/coach-kernel-biomechanics-and-ordering.test.ts` | Orange readiness/high soreness with high-spinal-loading lift | Downshifts away from the high-loading lift |
| Beginner-safe complexity | `__tests__/services/coach-kernel-biomechanics-and-ordering.test.ts` | Novice athlete prescribed `front_squat` | Chooses `goblet_squat` and records a skill-match note |
| Adherence-friendly adaptation | `__tests__/services/coach-kernel-feedback-analysis.test.ts` | Broken adherence / re-entry week | Strength session becomes minimum-dose, <=2 exercises, <=20 minutes |
| Low-time fallback | `__tests__/services/coach-kernel-feedback-analysis.test.ts` | High time constraint | Strength session becomes <=3 exercises, <=25 minutes, with fallback rationale |

## Regression Risks Covered

- The substitution engine cannot pick unavailable equipment when a safer option exists.
- Broader pattern fallbacks cannot beat explicit safe substitution families unless the explicit family is unusable.
- Minimum-dose plans change actual exercise prescription, not just summary text.
- Beginner-safe changes are test-backed and not dependent on screenshots or one-off special cases.

## Manual QA Scenarios Still Recommended

- Generate a beginner no-gym plan and inspect whether all prescribed movements are realistic at home.
- Generate a hybrid week with orange readiness and confirm lower-body strength no longer stacks heavy spinal loading near endurance stress.
- Generate a low-time week and confirm the UI exposes the minimum-dose rationale and alternative clearly.
- Mark multiple sessions skipped, regenerate, and confirm the next week feels easier to start rather than just shorter.

