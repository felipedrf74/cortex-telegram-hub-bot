# Training Production Fixes Applied

Updated: 2026-04-28  
Branch: `release/training-engine-production-hardening`  
Backup branch/tag: `backup/training-prod-hardening-pre-20260428-1004` / `backup-training-prod-hardening-pre-20260428-1004`

## Executive Summary

This hardening pass focused only on production-critical backend Training blockers. It did not deploy and did not modify iOS code.

The key behavior change is that the engine no longer silently turns impossible schedule states into active calendar events. If a constrained/travel/busy week has no valid slot, the session is kept as a real Training item with an explicit inactive state such as `unscheduled`, and calendar creation is skipped.

## Fixes

| Area | Root Cause | Fix | Files |
|---|---|---|---|
| Fully booked calendar days | `scheduleSessionWindow` returned a legacy fallback time even when no valid free slot existed. | Added `noAvailableSlot` / `unavailableReason`; persistence and sync now mark the session `unscheduled` and skip event creation. | `src/api/routes/training-schedule-utils.ts`, `src/api/routes/training-plan-persistence.ts`, `src/api/routes/training-plan-calendar-sync.ts` |
| Inactive state persistence | Persistence skipped rest/mobility-like rows before checking whether they were explicitly `unscheduled`, `deferred`, or `dropped`. | Inactive schedule states are checked first and persisted as rows, while still excluded from active counts and calendar events. | `src/api/routes/training-plan-persistence.ts`, `src/api/routes/training-calendar-utils.ts`, `src/api/routes/training-read-models.ts`, `src/services/training-plans.ts` |
| Calendar sync for inactive states | Calendar sync could attempt to sync sessions that were not actually schedulable. | Sync now skips `unscheduled`, `deferred`, `dropped`, `cancelled`, and `superseded`; fully blocked future sessions are marked `unscheduled`. | `src/api/routes/training-plan-calendar-sync.ts` |
| Stale event identity markers | Same-shape regeneration could update time/title but leave stale Training identity marker text. | `updateEvent` accepts `new_description`; Google and Outlook adapters update provider description/body. | `src/services/unified-calendar.ts`, `src/services/google-calendar.ts`, `src/services/outlook-calendar.ts`, `src/api/routes/training-plan-calendar-sync.ts` |
| Active count inflation | Inactive sessions could be counted as active Training work in read models. | Read-model counts exclude inactive lifecycle states. | `src/api/routes/training-read-models.ts` |
| Profile/follow-up signal loss | The generated plan route did not return profile quality/follow-up prompts. | Route response now includes `profileQuality`. | `src/api/routes/training-plan-generation.ts`, `__tests__/api/training-routes.test.ts` |
| Compression/decision signal loss | The generated plan route did not return structured decision reasons. | Route response now includes `decisionReasons`. | `src/api/routes/training-plan-generation.ts`, `__tests__/api/training-routes.test.ts` |

## Tests Added Or Updated

- `__tests__/api/training-schedule-utils.test.ts`
  - fully booked days report `noAvailableSlot`.
- `__tests__/api/training-plan-persistence.test.ts`
  - inactive sessions persist without calendar events;
  - fully booked sessions become `unscheduled`;
  - unscheduled rows preserve planned duration/content instead of disappearing.
- `__tests__/api/training-plan-calendar-sync.test.ts`
  - inactive sessions do not create events;
  - fully booked sync marks session `unscheduled`;
  - same-shape updates refresh event identity markers;
  - stale mismatched linked events are precisely replaced/deleted.
- `__tests__/api/training-routes.test.ts`
  - plan generation serializes `profileQuality.followUpPrompts`;
  - plan generation serializes `decisionReasons`.

## Validation

- Focused changed suites: passed.
- Focused Training blocker suite: passed, 13 files / 140 tests.
- Full backend verify: passed, 379 files / 5,977 tests.
- Training eval: passed, 99/100 across 156 cases.
- Calendar staging smoke: blocked safely due missing staging credentials/env; no writes made.
- Cross-skill staging smoke: local fixture contracts passed; staging runtime blocked due missing env/test tenant.

## Remaining Risks

- Real Google/Outlook staging read-back is still required before production calendar trust claims.
- iOS rich-payload simulator smoke is still required before iOS release.
- Migration rollback must be rehearsed on a staging clone.
- Final branch must be committed and reviewed before deployment.

