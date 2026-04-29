# Calendar Lifecycle Test Results

Date: 2026-04-29

Branch: `feature/secretary-scheduling-arbitrator-batch4`

## Focused Tests

Command:

```bash
npm test -- --run __tests__/services/secretary-agenda-provider-sync.test.ts __tests__/services/secretary-unified-calendar-provider-adapter.test.ts __tests__/services/secretary-scheduling-arbitrator.test.ts
```

Result:

```text
Test Files  3 passed (3)
Tests       23 passed (23)
```

Coverage in this command:

- Secretary scheduling intent creation
- stable agenda item identity
- source intent ownership
- source skill attribution
- lifecycle states
- source shape hash persistence
- provider event create
- provider event update
- provider event move
- provider event cancel/delete
- regenerate/replace cleanup
- retry after provider create failure
- partial-success retry attach
- external provider deletion repair
- stale duplicate provider event cleanup
- precise provider event deletion
- no broad date-range deletion primitive in the Secretary provider adapter
- owner/tenant-scoped provider sync
- unified Google/Outlook adapter marker writing
- bounded provider read-back marker matching

## Typecheck

Command:

```bash
npm run typecheck
```

Result:

```text
tsc --noEmit
PASS
```

## New Test Files

- `__tests__/services/secretary-agenda-provider-sync.test.ts`
- `__tests__/services/secretary-unified-calendar-provider-adapter.test.ts`

## Existing Test Re-run

- `__tests__/services/secretary-scheduling-arbitrator.test.ts`

The existing arbitrator suite still passes after adding scoped agenda lookup/cancel helpers and provider-sync integration points.

## Scenario Evidence

| Scenario | Evidence | Result |
| --- | --- | --- |
| Create | Scheduled agenda item sync creates a provider event and stores `provider_event_id`, `provider_source`, `provider_sync_state='synced'` | PASS |
| Update | Existing provider event is updated by exact event ID | PASS |
| Move | Start/end changes are sent through exact event update | PASS |
| Cancel | Canceled agenda item deletes exact provider event ID and marks sync state `deleted` | PASS |
| Regenerate/replace | Old version is `superseded`, old provider event is deleted, new version gets a new provider event | PASS |
| Retry after failure | Failed create records `create_failed`; retry syncs the same agenda item without creating a second agenda row | PASS |
| Partial-success retry | Existing provider event with the same agenda marker is attached/updated instead of creating a duplicate | PASS |
| Provider deletion | Missing externally deleted provider event is recreated and local mapping is updated | PASS |
| Stale cleanup | Duplicate provider events for the same agenda marker are deleted by exact ID | PASS |
| Duplicate prevention | Canonical provider event is preserved; duplicate IDs are cleaned up | PASS |
| No broad deletion | Adapter exposes exact `deleteEvent(eventId)` only; tests assert exact IDs | PASS |
| Tenant/user scope | Sync requires `agendaItemId + ownerUserId + tenantId`; wrong owner or tenant cannot access the row | PASS |

## Not Run In This Batch

Real staging provider smokes were run in the follow-up gated smoke batch:

- Google: `docs/calendar/google-staging-smoke-results.md`
- Outlook: `docs/calendar/outlook-staging-smoke-results.md`

Both provider runs passed create, update/move, retry, stale duplicate cleanup, external provider deletion repair, superseded cleanup, replacement create, cancel/delete, read-back verification, and final cleanup.

The following were still not run:

- full local Nexus product smoke
- iOS simulator smoke
- production health checks

## Test Verdict

PASS for focused Secretary agenda provider lifecycle hardening.

PASS for TypeScript build validation.

PASS WITH CONDITIONS for production release readiness: provider staging smoke passed from a temporary staging-side build, but the same code still needs normal staging deployment and generic calendar write paths still need migration through Secretary before declaring Secretary the universal agenda/calendar owner.
