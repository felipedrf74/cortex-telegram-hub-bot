# Calendar Lifecycle Fixes

Date: 2026-04-29

Branch: `feature/secretary-scheduling-arbitrator-batch4`

## Summary

This batch hardens the Secretary agenda/calendar lifecycle by adding a provider-sync layer over the `secretary_agenda_items` ledger. The fix keeps Secretary as the schedule decision owner and treats calendar providers as sync targets, not as the source of agenda truth.

No production deploy was performed. No iOS files were changed.

## Implemented

### Secretary provider sync service

Added `src/services/secretary-agenda-provider-sync.ts`.

The service syncs persisted Secretary agenda items to a provider adapter and supports:

- create
- update
- move
- cancel/delete
- replace/regenerate cleanup
- retry after provider failure
- external provider deletion repair
- stale duplicate provider event cleanup
- owner/tenant scoped access before sync
- provider sync state updates
- provider event mapping persistence

Provider lifecycle is driven by stable agenda identity, not title/date matching:

- `agenda_item_id`
- `source_intent_id`
- `source_skill`
- `source_entity_id`
- `source_entity_type`
- `owner_user_id`
- `tenant_id`
- `version`
- `source_shape_hash`
- provider event ID/source

### Unified calendar adapter

Added `src/services/secretary-unified-calendar-provider-adapter.ts`.

This adapter lets the Secretary sync service target the existing unified Google/Outlook calendar layer without hardcoding provider-specific logic into Secretary.

The adapter:

- creates Google/Outlook events through `unified-calendar.createEvent`
- updates by exact provider event ID
- deletes by exact provider event ID
- writes Secretary identity markers into event descriptions
- performs bounded read-back around the scheduled window
- finds existing provider events by Secretary agenda marker
- avoids broad date-range deletion

Identity markers written to provider events:

- `NEXUS_SECRETARY_AGENDA_ITEM`
- `NEXUS_SECRETARY_SOURCE_INTENT`
- `NEXUS_SECRETARY_SOURCE_SKILL`
- `NEXUS_SECRETARY_SOURCE_ENTITY`
- `NEXUS_SECRETARY_VERSION`
- `NEXUS_SECRETARY_SHAPE`

### Scoped ledger helpers

Updated `src/services/secretary-scheduling-arbitrator.ts`.

Added:

- `getSecretaryAgendaItemById`
- `cancelSecretaryAgendaItem`

Both helpers require `ownerUserId` and `tenantId`, so provider sync and cancellation cannot fetch or mutate agenda rows by global ID alone.

### Retry and duplicate prevention

Provider sync now checks for existing provider events with the same Secretary agenda marker before creating a new event. This covers the partial-success case where a provider event exists but the local provider mapping was not recorded.

If multiple provider events exist for the same agenda item, the sync keeps one canonical event and deletes the duplicates by exact provider event ID.

### Regenerate/replace cleanup

When the Secretary arbitrator creates a replacement agenda row, the prior version is marked `superseded`. The provider sync layer treats superseded rows as cleanup targets and deletes their mapped provider event precisely before syncing the new version.

### External provider deletion handling

If an active agenda item has a mapped provider event ID but read-back cannot find the event, provider sync recreates the event and updates the local provider mapping.

## What Stayed Intact

Training lifecycle hardening remains intact:

- plan/session identity
- plan versioning
- session identity key
- session shape hash
- training agenda ownership table
- exact provider event deletion
- orphan reconciliation
- generated event marker matching

This batch did not rewrite Training sync. It adds a Secretary-level provider lifecycle so other skills can reach the same reliability standard.

## Explicit Non-Goals In This Batch

The following remain outside this implementation batch:

- routing every generic calendar API write through Secretary
- migrating Content topic calendar sync into the Secretary ledger
- migrating reminders into the Secretary ledger
- changing iOS calendar DTOs
- adding a background worker that automatically drains all pending Secretary agenda sync rows

Those are still tracked as follow-up release items.

Real Google/Outlook staging writes were run in the follow-up smoke batch. See:

- `docs/calendar/google-staging-smoke-results.md`
- `docs/calendar/outlook-staging-smoke-results.md`

## Remaining Open Risks

The main remaining lifecycle risks are:

- Generic calendar REST writes can still bypass Secretary unless the route is migrated.
- Chat/tool direct calendar actions can still bypass Secretary unless tool execution is migrated.
- Content topic calendar sync still has its own provider-event reference model.
- Reminders are still user-scoped rather than tenant/source/agenda-owned.
- The staging provider smoke passed from a temporary staging-side build; the same code still needs normal staging deployment before production promotion.

## Release-Gate Interpretation

This batch closes the provider-sync foundation gap for Secretary agenda items. It does not yet close the broader product-routing gap where older generic calendar surfaces bypass Secretary.

Recommended next release step: deploy this branch to staging through the normal release path, rerun focused provider smoke against that deployed artifact, and migrate generic calendar writes plus Chat/tool calendar actions to create Secretary intents.
