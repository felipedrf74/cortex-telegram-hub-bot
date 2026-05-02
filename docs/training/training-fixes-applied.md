# Training fixes applied

## Fix 1: preserve explicit five-day strength through route and enforcement

Files:
- `src/api/routes/training-plan-generation.ts`
- `src/services/training-plan-volume-enforcement.ts`
- `__tests__/api/training-plan-generation.test.ts`
- `__tests__/services/training-plan-volume-enforcement.test.ts`

Summary:
- Route strength normalization now accepts up to 6.
- Gym-only default can use up to 6 when the objective is gym-only.
- Running plans now treat requested running sessions and explicit strength sessions additively before capacity reconciliation.

Validation:
- Route-level generation pin passed.
- Volume enforcement pin passed.

## Fix 2: allow high-frequency marathon strength outside maintenance windows

Files:
- `src/services/coach-kernel/engines/strength-engine.ts`
- `__tests__/services/coach-kernel-strength-engine.test.ts`
- `__tests__/services/training-coach-kernel-plan-generator.test.ts`

Summary:
- Marathon users with 5+ requested strength sessions receive a high-frequency strength block when the race is not close and the phase is not peak/taper.
- Race-close, peak/taper, and triathlon plans still use maintenance strength.

Validation:
- Five-session marathon strength pin passed.
- Race-close maintenance pin passed.
- Felipe-style advanced marathon scenario passed.

## Fix 3: support explicit five-plus deterministic fallback without changing defaults

Files:
- `src/api/routes/training-fallback-plan.ts`
- `__tests__/api/training-fallback-plan.test.ts`

Summary:
- Added fifth/sixth gym fallback templates and runner-support strength templates.
- Kept unspecified hypertrophy fallback at four sessions.
- Explicit `strengthSessionsPerWeek: 5` or `sessionsPerWeek: 5` now produces five sessions.

Validation:
- Fallback plan test: 6/6 passed.
- Full verify initially caught this regression; fixed before final rerun.

## Fix 4: require marathon race date as critical missing context

Files:
- `src/services/training-profile-model.ts`
- `__tests__/services/training-profile-model.test.ts`

Summary:
- Marathon plans without race date now expose `race_date` as critical missing data.

Validation:
- Missing race date and race date present tests passed.
