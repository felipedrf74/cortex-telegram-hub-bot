# Training strength, running, cycling catalog review

## Strength catalog

The deterministic fallback strength catalog now includes additional upper/lower accessory sessions so explicit five- and six-day gym requests do not collapse into repeated four-day templates.

Runner-support fallback now includes:
- Runner Strength D: upper-body and trunk support.
- Runner Strength E: calf, hip, and trunk durability.

Gym fallback now includes:
- Upper Body C.
- Lower Body C.

## Running catalog

Existing deterministic running fallback keeps recovery, threshold, base, intervals/economy, and long run roles. The long run uses canonical day selection from `training-schedule-utils`.

## Cycling/hybrid catalog

No new cycling catalog work landed in this pass. Existing hybrid fallback covers swim, bike, run, and strength. A deeper cycling progression/catalog pass remains P2.

## Tests

- `training-fallback-plan.test.ts` pins default four-day gym fallback and explicit five-day fallback.
- `training-coach-kernel-plan-generator.test.ts` pins distinct strength-session titles in the advanced marathon scenario.
