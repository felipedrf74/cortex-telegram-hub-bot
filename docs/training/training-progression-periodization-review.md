# Training progression and periodization review

## What improved

- Advanced marathon users requesting five strength days can now receive a high-frequency strength block when not close to race day.
- Race-close, peak, taper, and triathlon conditions still force strength maintenance dosing so endurance preparation is not overloaded.
- Marathon missing race date is now surfaced as critical missing context rather than silently generating a full-confidence progression.

## Evidence

- `coach-kernel-strength-engine.test.ts` verifies five strength sessions outside peak/taper and two-session maintenance when race day is close.
- `training-coach-kernel-plan-generator.test.ts` verifies a Felipe-style marathon scenario produces five distinct strength sessions plus a long run.
- `training-profile-model.test.ts` verifies missing race date is a critical follow-up.

## Remaining gaps

- Future-week visual explanations in iOS were not manually exercised in this pass.
- The deeper progression harness should add before/after deload, missed-session reflow, race-date-added-later, and poor-recovery adaptation scenarios.
