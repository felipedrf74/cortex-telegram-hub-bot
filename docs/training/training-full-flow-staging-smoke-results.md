# Training Full-Flow Staging Smoke Results

- Run ID: `training-full-flow-smoke-20260522104916-2ihxsq`
- Started: `2026-05-22T10:49:16.227Z`
- Finished: `2026-05-22T10:49:39.013Z`
- Provider: `google`
- Dry run: `false`
- Staging user ID: `1000013`
- Tenant ID: `1000013`

## Prerequisites

- Status: **ready**

## Operations

| Operation | Expected | Actual | Status | Evidence |
| --- | --- | --- | --- | --- |
| pre_cleanup | Dedicated staging user starts from a clean active Training plan state. | No active plans needed cleanup. | pass | `before=0`<br>`after=0`<br>`cancelStatus=not_needed` |
| preview_non_mutating | Two preview calls return preview payloads and create zero plan/week/session/calendar rows. | All checks passed. | pass | `previewOne=preview`<br>`previewTwo=preview`<br>`beforePlans=0`<br>`afterPlans=0`<br>`beforeSessions=0`<br>`afterSessions=0` |
| generate_idempotent_double_tap | Confirmed generation creates one plan, and an immediate second identical claim replays the first response. | All checks passed. | pass | `firstClaim=claimed`<br>`secondClaim=replay`<br>`planId=24`<br>`totalSessions=44`<br>`eventsCreated=44` |
| plan_shape_and_week_sync | The generated 4-week hybrid plan has 6 run + 5 gym sessions per week and week 1/week 2 are fully linked. | All checks passed. | pass | `week1: active=11, run=6, gym=5, linked=11`<br>`week2: active=11, run=6, gym=5, linked=11`<br>`week3: active=11, run=6, gym=5, linked=11`<br>`week4: active=11, run=6, gym=5, linked=11`<br>`longRunDays=Saturday,Saturday` |
| provider_event_body_and_times | Provider events use useful workout-body content first and exact 12:00 gym time when no conflict was marked. | All checks passed. | pass | `linkedSessions=44`<br>`providerEvents=44`<br>`sampleBodyStart=Half marathon running base plus gym strength block (training-full-flow-smoke-20260522104916-2ihxsq) — Coach Plan ━━━━━━━━━━━━━━━━━━━━━━━━ 🏃 MONDAY RUN — Easy `<br>`gymTimeMismatches=none` |
| sync_idempotent_no_duplicates | Two sync attempts verify/link existing sessions without creating duplicate provider events. | All checks passed. | pass | `firstSync=synced`<br>`firstSyncEventsCreated=0`<br>`firstSyncAlready=44`<br>`secondSync=synced`<br>`eventCountBefore=44`<br>`eventCountAfter=44` |
| cancel_removes_provider_events | Cancel removes active plan rows and every provider event owned by this generated plan. | All checks passed. | pass | `cancelStatus=cancelled`<br>`removedSessions=44`<br>`removedEvents=44`<br>`remainingProviderEvents=0` |

## Cleanup Failures

None.

## Interpretation

The real Training plan flow passed against the requested staging calendar provider: preview stayed read-only, generation/sync were idempotent, event bodies were useful, and cancel cleaned provider events.

