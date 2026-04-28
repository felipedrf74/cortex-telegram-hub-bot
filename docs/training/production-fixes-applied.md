# Training Production Fixes Applied

Updated: 2026-04-28  
Branch: `release/training-engine-production-hardening`  
Backup branch/tag: `backup/training-prod-hardening-pre-20260428-1004` / `backup-training-prod-hardening-pre-20260428-1004`

## Executive Summary

This hardening pass focused on production-critical Training blockers and the local iOS proof needed to validate the richer payloads safely before production. It did not deploy.

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
| Missing operational kill switches | Release rollback docs could not identify a safe config-only way to pause Training generation, calendar writes, or Training-originated cross-skill signals. | Added explicit env-controlled switches for plan generation, calendar writes/sync, and cross-skill signal publishing. Defaults remain enabled; emergency disable returns route-level 503s or skips signal writes without deleting user data. | `src/services/training-operational-switches.ts`, `src/api/routes/training-plan-routes.ts`, `src/api/routes/training-calendar-event-writer.ts`, `src/services/training-signals.ts` |
| Staging smoke false-green risk | Dry-run cross-skill/calendar smoke reports could look like successful staging proof. | Dry-run reports now mark runtime provider/staging checks as `blocked` and state that no staging proof was produced. | `src/tools/training-calendar-staging-smoke.ts`, `src/tools/training-cross-skill-staging-smoke.ts` |

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
- `__tests__/services/training-operational-switches.test.ts`
  - global and per-surface Training switches default enabled and disable explicitly.
- `__tests__/api/training-calendar-event-writer.test.ts`
  - calendar writes stop before provider calls when disabled.
- `__tests__/services/training-signals.test.ts`
  - Training-originated cross-skill signal publish skips DB writes when disabled.
- `__tests__/tools/training-calendar-staging-smoke.test.ts` and `__tests__/tools/training-cross-skill-staging-smoke.test.ts`
  - dry-run reports cannot be mistaken for staging success.

## Validation

- Focused changed suites: passed.
- Operational-switch and staging-harness safety suites: passed, 23 tests.
- Focused Training blocker suite: passed, 13 files / 140 tests.
- Full backend verify: passed, 383 files / 6,001 tests.
- Training eval: passed, 99/100 across 156 cases.
- Focused iOS Training/importer suites: passed.
- Full iOS scheme: passed after aligning dashboard hero presentation tests with the localized calendar display contract.
- Authenticated local iOS simulator journey: passed, 43 authenticated REST calls across 19 endpoints with local runner user `2`, all HTTP 200.
- Calendar staging smoke: Google and Outlook staging provider lifecycles passed with read-back and exact-event cleanup.
- Cross-skill staging smoke: seeded staging runtime passed for Secretary, Cooking, Finance, Content workload, Training-to-Content milestone, and shared-context scope; fixture cleanup verified.

## Remaining Risks

- Real Google/Outlook staging read-back is still required before production calendar trust claims.
- iOS local proof is still pre-release proof only; signed TestFlight/device and post-deploy production-safe validation remain required.
- Migration rollback must be rehearsed on a staging clone.
- Final branch must be committed and reviewed before deployment.
