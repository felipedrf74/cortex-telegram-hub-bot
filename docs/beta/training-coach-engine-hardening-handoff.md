# Training Coach Engine Hardening Handoff

Date: 2026-04-25

Status: implemented on backend `main`; production deploy pending until the next deploy script run.

## Summary

Claude Code's Training QA was directionally correct. The high-risk defects were real: Training prompts carried founder-specific coaching defaults, the daily coach briefing cron only generated an owner-scoped briefing, ACWR used a constant stress value instead of real training load, no-wearable users were told `full_intensity`, and orange readiness did not downshift the deterministic coach kernel.

This pass fixes the high-impact backend issues without redesigning the whole coaching engine.

## Implemented

- Removed founder-specific Training prompt defaults from:
  - `prompts/triathlon.md`
  - `prompts/triathlon/gym.md`
  - `prompts/triathlon/running.md`
  - `prompts/triathlon/cycling.md`
  - `prompts/triathlon/swim.md`
- Reworked `src/services/garmin-coach.ts` prompt rules so daily coach briefings:
  - use the current athlete profile instead of assuming Felipe;
  - do not assume a carnivore diet;
  - do not assume Europe/Lisbon or a hardcoded 21:00 delivery time;
  - ask for plain text output instead of Telegram HTML as the canonical format.
- Added `sendCoachBriefings()` in `src/services/scheduler.ts`.
  - Iterates every active canonical tenant, not only owner users.
  - Wraps each user in `runWithContext({ source: 'cron:garmin_coach', userId })`.
  - Calls `generateCoachBriefing(userId)` per tenant.
  - Stores coach state, conversation continuity, durable report, and APNs payload under the canonical tenant id.
  - Keeps legacy Telegram delivery gated and uses `telegram_id` only for delivery, never as the storage tenant.
- Fixed readiness scoring in `src/services/readiness-scorer.ts`.
  - ACWR now uses explicit `activityTrainingLoad`/training-load/TSS fields when available.
  - Training-effect and duration are fallback estimates, not replacements for real load.
  - ACWR remains neutral until there are at least 14 distinct history days, while still reporting real acute/chronic totals.
  - No-wearable fallback now uses `getRecommendation(60)` (`reduce_25pct`) instead of hardcoding `full_intensity`.
  - Sleep scoring now keeps duration as a safety floor when Garmin quality looks good after very short sleep.
- Fixed deterministic coach-kernel behavior in `src/services/coach-kernel/planner-engine.ts`.
  - Moderate/high injury constraints and red readiness force `deload`.
  - Orange readiness downshifts to `maintenance`.
  - Race taper/peak windows are now distance-aware (`5k`, `10k`, half, marathon, `70.3`, Ironman).

## Tests Added Or Updated

- `__tests__/services/readiness-scorer.test.ts`
  - Actual Garmin training load is used instead of constant stress.
  - Short sleep plus high Garmin quality stays low readiness.
  - No-wearable fallback is conservative.
- `__tests__/services/coach-kernel-planner.test.ts`
  - Orange readiness downshifts to maintenance.
  - 5k and marathon taper windows differ.
- `__tests__/services/scheduler-user-scope.test.ts`
  - `sendCoachBriefings()` generates/stores coach reports for every active tenant.
  - Coach state/report storage uses canonical tenant ids, not Telegram ids.
- `__tests__/services/prompt-cleanliness.test.ts`
  - Training prompts reject founder/single-tenant defaults.

## Verification

- `npx vitest run __tests__/services/readiness-scorer.test.ts __tests__/services/coach-kernel-planner.test.ts __tests__/services/scheduler-user-scope.test.ts __tests__/services/prompt-cleanliness.test.ts`
  - Passed: 4 files / 111 tests.
- `npx vitest run __tests__/services/garmin-coach-user-scope.test.ts __tests__/services/training-coach-kernel-plan-generator.test.ts __tests__/services/coach-kernel-guardrails.test.ts __tests__/services/training-home-view-state.test.ts __tests__/api/training-coach-briefing.test.ts __tests__/api/training-plan-generation.test.ts __tests__/api/training-profile-requirements.test.ts`
  - Passed: 7 files / 61 tests.
- `npm run typecheck`
  - Passed.
- `npm run verify`
  - Passed: 345 files / 5,468 tests.

## Deliberately Not Completed In This Pass

- CTL/ATL/TSB model.
- Sport-specific intensity constants by athlete level.
- RRULE-based training-session recurrence.
- Menstrual-cycle-aware adaptation.
- Injury return-to-training ramp beyond forcing deload/maintenance.
- Per-user timezone/preferred briefing delivery time.
- Full nutrition-profile modeling beyond removing unsafe founder/diet defaults.

These are product-depth follow-ups, not blockers for this hardening patch.

## Remaining Release Proof

- Deploy to staging/prod.
- Run a production-safe coach briefing smoke for both founder tenants.
- TestFlight/device validation for Training coach briefing, readiness display, week plan, and action buttons.
