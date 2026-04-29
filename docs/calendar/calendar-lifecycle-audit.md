# Calendar Lifecycle Audit

Date: 2026-04-29

Branch audited: `feature/secretary-scheduling-arbitrator-batch4`

Scope: Secretary, Training, generic calendar routes, Google Calendar, Outlook Calendar, content-to-calendar sync, reminders, local smoke/runtime support, and the current Secretary scheduling arbitrator foundation.

## Executive Summary

The strongest calendar lifecycle implementation today is the Training lifecycle. Training has stable session identity, plan versioning, provider event IDs, a durable agenda ownership table, precise event deletion by provider event ID, identity-marker reconciliation, stale event repair, and tests around cancellation, sync, and reconciliation.

The broader product is not yet at that standard. Generic calendar API writes, Chat/tool calendar actions, Content topic calendar sync, and reminders can still bypass the universal Secretary agenda ledger. The new Secretary scheduling arbitrator creates a typed agenda ownership foundation in `secretary_agenda_items`, but provider sync and reconciliation are intentionally not wired there yet.

No broad date-range provider deletion was found in the inspected Google, Outlook, generic calendar, or Training paths. Provider deletion is performed by exact provider event ID and source. The main production risk is not reckless deletion; it is fragmented ownership and partial idempotency outside Training.

Verdict for this batch: audit complete, no code changes made, no P0 broad-delete issue found. Several P1 lifecycle gaps remain before Secretary can be treated as the universal agenda owner.

## Files Audited

Core calendar and provider paths:

- `src/services/unified-calendar.ts`
- `src/services/google-calendar.ts`
- `src/services/outlook-calendar.ts`
- `src/api/routes/calendar.ts`
- `src/services/tool-executor.ts`

Training lifecycle paths:

- `src/api/routes/training-plan-calendar-sync.ts`
- `src/api/routes/training-plan-cancellation.ts`
- `src/api/routes/training-calendar-event-writer.ts`
- `src/services/training-plan-lifecycle.ts`
- `src/services/training-agenda-reconciliation.ts`
- `src/services/training-calendar-scope.ts`
- `src/services/training-session-identity.ts`

Secretary and cross-skill paths:

- `src/services/secretary-scheduling-arbitrator.ts`
- `src/services/content-topic-secretary-sync.ts`
- `src/state/reminders.ts`
- `src/api/routes/reminders.ts`

Schema and tests:

- `migrations/081_training_agenda_event_ownership.sql`
- `migrations/082_training_session_identity_shape_hash.sql`
- `migrations/083_secretary_agenda_ledger.sql`
- `__tests__/services/training-plan-lifecycle.test.ts`
- `__tests__/services/training-agenda-reconciliation.test.ts`
- `__tests__/api/training-plan-calendar-sync.test.ts`
- `__tests__/api/training-plan-cancellation.test.ts`
- `__tests__/api/calendar-routes.test.ts`
- `__tests__/services/content-topic-secretary-sync.test.ts`
- `__tests__/services/tool-executor.test.ts`
- `__tests__/services/secretary-scheduling-arbitrator.test.ts`

## Lifecycle Map

| Surface | Agenda identity | Provider identity | Lifecycle state | Cleanup behavior | Repair behavior | Risk |
| --- | --- | --- | --- | --- | --- | --- |
| Training plan calendar sync | `plan_id`, `plan_version`, `session_id`, `session_identity_key`, `session_shape_hash` | `calendar_event_id`, `calendar_source` on session and ownership table | Session status plus ownership status | Exact event ID delete, ownership marked deleted/orphaned | Reconciliation for orphaned/missing/mismatched events | Strongest current implementation |
| Training cancellation | Plan ownership and identity-marker match | Exact event IDs from sessions, ownership, and marker-matched provider events | Ownership `deleted` or `orphaned`; plan hard-deleted after external cleanup attempt | Exact event ID delete only | Orphaned ownership rows retry later | Good, but external delete failure still leaves local plan removed |
| Secretary scheduling arbitrator | `agenda_item_id`, `intent_id`, `source_skill`, `source_entity_id`, `owner_user_id`, `tenant_id` | Field exists but currently null | `proposed`, `scheduled`, `reflowed`, `compressed`, `deferred`, `unscheduled`, `canceled`, `superseded`, `failed_sync`, `completed` | Ledger-only; no provider sync yet | Ledger supersession exists; no provider repair yet | Good foundation, incomplete lifecycle |
| Generic calendar routes | Provider event ID only | Provider event ID and source | None in Secretary ledger | Exact event ID delete | None | Bypasses agenda ownership |
| Chat/tool calendar actions | Provider event ID only | Provider event ID and source | None in Secretary ledger | Exact event ID delete | None | Can duplicate on retry and bypass Secretary |
| Content topic sync | Content topic row stores event ID/source | Provider event ID/source on topic row | `secretary_sync_status` only | Update or create; cleanup limited to topic flow | Failure marked, no universal repair | Stale ref risk |
| Reminders | Reminder row ID and user ID | No provider mapping | `active`, `fired`, `cancelled` | Route-level status updates | No agenda-level dedupe/repair | Not tenant/source/agenda aware |
| Google provider | Provider event ID | Google event ID | Provider-owned | Exact `calendar.events.delete` by event ID | No generic read-back reconciliation | Safe deletion primitive |
| Outlook provider | Provider event ID | Outlook event ID | Provider-owned | Exact `/me/events/{eventId}` delete | No generic read-back reconciliation | Safe deletion primitive |

## What Is Safe Today

### Provider deletes are precise

Google deletion uses `calendar.events.delete` with an explicit `eventId`. Outlook deletion uses `client.api('/me/events/{eventId}').delete()`. The generic calendar route also requires an event ID and provider source for deletion.

No inspected path deletes provider events by broad date range. Training cancellation may scan provider events in a date span to discover old generated events, but it only deletes events that pass identity-marker ownership checks and then deletes by exact event ID.

### Training owns its generated events well

Training sync and cancellation use several layers of identity:

- Plan ID
- Plan version
- Session ID
- Session identity key
- Session shape hash
- Provider event ID
- Provider source
- Ownership table row
- Embedded generated event markers

This makes Training cancellation and regeneration materially safer than simple title/date matching.

### Training has stale-event repair

`training-agenda-reconciliation.ts` explicitly avoids broad date/title matching and uses the ownership table to retry precise deletion of orphaned events. Calendar sync marks missing or mismatched linked events for repair instead of silently trusting stale local pointers.

### Secretary now has a typed ledger foundation

`secretary-scheduling-arbitrator.ts` creates a tenant/user-scoped agenda ledger with source skill attribution, lifecycle states, decision reasons, confidence, selected slots, conflicts, and supersession. That is the right foundation for making Secretary the central scheduling owner.

## Main Gaps

### Generic calendar writes bypass Secretary ownership

`src/api/routes/calendar.ts` creates, updates, and deletes provider events directly through `unified-calendar`. `src/services/tool-executor.ts` does the same for tool actions. These paths do not create `secretary_agenda_items`, do not record source intent IDs, and do not expose lifecycle state.

This means a user or Chat/tool action can create calendar state that Secretary cannot reason about as owned agenda state.

### Secretary ledger is not provider-synced yet

The Secretary arbitrator service records agenda intent and placement decisions, but `provider_event_id` remains null and `provider_sync_state` remains `not_synced`. There is no Secretary provider sync worker, no read-back verification, and no universal repair pass for `secretary_agenda_items`.

### Generic retries can duplicate provider events

Generic calendar create is not protected by a Secretary intent ID or provider idempotency key. If a request succeeds at the provider and fails before the client observes success, a retry can create a second provider event.

Training has partial mitigation through generated markers and ownership reconciliation. Generic calendar writes do not.

### Content calendar sync has its own lifecycle

Content topic sync stores `calendar_event_id`, `calendar_source`, and `secretary_sync_status` on the topic row. It updates if a provider event ID exists and creates otherwise. That is useful, but it is not the universal Secretary ownership model and has weaker repair semantics if provider update fails or the external event disappears.

### Reminders are not agenda-owned

Reminders are user-scoped and status-driven, but they do not carry tenant ID, source intent ID, source skill, provider sync state, duplicate group, or agenda item linkage. That limits cross-skill reminder cleanup and duplicate prevention.

### iOS-facing calendar payloads are still provider-shaped

The generic calendar route formats provider events into a simplified event response. It does not return Secretary lifecycle state, decision reasons, source skill attribution, sync state, stale/orphaned flags, or unscheduled/reflowed/compressed state.

## Title/Date Matching Assessment

No deletion path was found that matches only by title and date.

Training still has a legacy relink fallback that can use title/date/duration matching for older generated events when `allowLegacyTitleMatch` is true. The safer create-path matching disables legacy title matching and requires generated markers. The legacy fallback is acceptable for backward compatibility, but should be retired after old events are migrated or reconciled.

## Replacement and Regeneration Assessment

Training regeneration is materially safer than generic replacement:

- Plan versions are incremented.
- Session identity and shape hashes identify whether a linked event can be reused.
- Stale linked events can be deleted or marked orphaned.
- Existing generated events can be consumed only when identity checks pass.
- Canceled or superseded training state is excluded from active scheduling.

Secretary generic replacement is not yet provider-backed. The ledger supersedes old agenda rows, but provider events are not created, moved, canceled, or repaired through that ledger yet.

## Local Mock Provider Assessment

The local runner and smoke docs support fixture/degraded local product validation, and tests mock provider functions for targeted units. There is not yet a first-class local mock calendar provider that implements the full Secretary create/update/move/cancel/read-back lifecycle against `secretary_agenda_items`.

That makes full local proof of Secretary provider lifecycle weaker than the Training-specific tests.

## Recommended Implementation Sequence

1. Route generic calendar create/update/delete and Chat/tool calendar actions through Secretary intents, or explicitly mark them as provider-only escape hatches with audit logs.
2. Add a Secretary provider sync service for `secretary_agenda_items`, including create, update/move, cancel, retry, read-back verification, and precise cleanup.
3. Add idempotency on scheduling intents and provider writes so retries cannot duplicate events.
4. Add a local mock calendar provider for Secretary lifecycle tests.
5. Migrate Content topic calendar sync and reminders to use Secretary ownership, or add bridging records into the Secretary ledger.
6. Extend iOS-facing API responses to include agenda lifecycle, source skill, decision reason, sync state, and stale/unscheduled indicators.
7. Retire Training legacy title/date relink fallback after migration/reconciliation of old generated events.

## Audit Verdict

No broad date-range deletion or title-only deletion P0 was found.

Training calendar lifecycle is production-grade relative to the inspected risks, with one partial-failure duplicate risk still worth hardening. Secretary has a strong ledger foundation but cannot yet be called the universal provider-backed agenda owner. Generic calendar, Chat/tool calendar actions, Content sync, and reminders remain the key lifecycle reliability gaps.
