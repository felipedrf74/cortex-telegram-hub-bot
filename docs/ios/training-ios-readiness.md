# Training iOS readiness

## Status

PASS WITH CONDITIONS.

Focused Training contract tests passed on one selected iPhone 17 Pro simulator and then on the connected physical iPhone. Static review confirmed duplicate CTA deduplication and plan sync-state rendering are in place.

## Evidence

- `TrainingHomeContractResolverTests`
- `TrainingHomeViewStateBuilderTests`
- `TrainingWeekResponsePlanSyncStatusTests`
- `TrainingTodayCalendarSyncStateTests`

Result: 40/40 passed.

Physical device:

- Device: `iPhone Felipe`
- Destination: `id=00008150-000C0D5101D8401C`
- Focused Training unit/contract tests: 40/40 passed.
- Training fixture XCUITests: 4/4 passed.
- XCUITest flows: no-plan create-plan sheet, strength stepper accepts 5 sessions, rich fixture bypass, weekly plan timeline with `Local Rich Hybrid Block`, count-aware calendar banner.

## Conditions

- True TestFlight/fresh-auth Training smoke remains required before production confidence.
- Account-switch stale-cache behavior was not manually validated.
- Rich sync-state fixtures should be expanded for partial, failed, canceled, and superseded states.
