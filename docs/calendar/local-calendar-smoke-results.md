# Local Calendar Smoke Results

Date: 2026-04-29

Branch: `feature/secretary-scheduling-arbitrator-batch4`

Verdict: **PASS**

## Command

```bash
npm test -- --run __tests__/services/secretary-agenda-provider-sync.test.ts __tests__/services/secretary-unified-calendar-provider-adapter.test.ts __tests__/services/secretary-scheduling-arbitrator.test.ts
npm run typecheck
npm run build
```

## Result

```text
Test Files  3 passed (3)
Tests       23 passed (23)
tsc --noEmit PASS
npm run build PASS
```

## Local Smoke Matrix

| Scenario | Expected | Actual | Status |
| --- | --- | --- | --- |
| Create | Scheduled Secretary agenda item creates one provider event and stores mapping. | Mock provider create returned one event; ledger stored `provider_event_id`, `provider_source`, `provider_sync_state='synced'`. | PASS |
| Update | Existing provider event updates by exact event ID. | Adapter called update with exact provider event ID. | PASS |
| Move | Changed start/end updates the same provider event. | Sync updated existing provider event; no duplicate event was created. | PASS |
| Cancel | Canceled agenda item deletes exact mapped provider event. | Provider delete called for the exact event ID; ledger state moved to `deleted`. | PASS |
| Regenerate | Changed source shape creates a replacement agenda row and supersedes the old row. | Old row became `superseded`; replacement row got version `2`. | PASS |
| Replace | Superseded row cleanup deletes old provider event; replacement creates its own provider event. | Old provider event deleted by exact ID; replacement provider event created. | PASS |
| Retry | Failed provider create records failure and retries safely. | First attempt recorded `create_failed`; retry created one event for the same agenda item. | PASS |
| Partial-success retry | Existing provider event with same agenda marker attaches instead of duplicate create. | Sync attached/updated existing provider event; `createEvent` was not called. | PASS |
| Provider deletion | Externally deleted provider event is repaired. | Sync recreated event and updated local mapping. | PASS |
| Stale cleanup | Duplicate provider events for one agenda marker are cleaned up. | Duplicate IDs were deleted; exactly one event remained. | PASS |
| Duplicate prevention | Re-running same intent does not create a second agenda item. | Existing agenda item was reused for unchanged source shape. | PASS |
| No broad date-range deletion | Provider cleanup deletes by exact event ID only. | Tests assert exact `deleteEvent(eventId)` calls. | PASS |
| Google/Outlook adapter marker read-back | Adapter writes Secretary markers and reads back by bounded provider-specific window. | Provider-specific `google-calendar.getEvents` / `outlook-calendar.getEvents` are used; unified dedupe is not used for duplicate repair. | PASS |
| Outlook category safety | Secretary-owned events do not send duplicate Outlook categories. | `['Nexus', 'Secretary']` is sent for `sourceSkill='secretary'`. | PASS |

## Fixes Proven Locally

- Provider read-back is provider-specific, so duplicate repair is not hidden by `unified-calendar` deduplication.
- Outlook category names are deduped case-insensitively before provider create.
- Cleanup sync skips re-deleting already-deleted provider mappings while still checking for marker-matched leftovers.

## Not Covered Locally

- Real Google provider write/read-back/delete.
- Real Outlook provider write/read-back/delete.
- iOS calendar rendering.
- Live PM2 staging service behavior.

Those provider cases are covered by the staging smoke result docs in this same batch.
