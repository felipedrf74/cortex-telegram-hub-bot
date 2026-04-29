# Secretary Agenda Ownership Gaps

Audit date: 2026-04-29
Scope: agenda ownership, scheduling intents, event identity, lifecycle states, stale cleanup, duplicate prevention, and iOS contract readiness.

## Summary

The codebase has the right direction of travel: Training proved a durable ownership/audit pattern, iOS can decode rich Secretary agenda metadata, and migration `083_secretary_agenda_ledger.sql` defines a general `secretary_agenda_items` table with source intent, lifecycle state, provider sync state, cancellation, supersession, and decision metadata.

The gap is runtime authority. The general ledger is not wired into services or routes, so agenda ownership is still split by feature path:
- Training owns Training calendar events through `training_agenda_event_ownership`.
- Content owns content-topic task/calendar refs on `content_topics`.
- Generic calendar events are just provider events.
- Reminders are simple user-scoped rows.
- Weekly/daily planning produces projections, not durable agenda lifecycle transitions.

## Existing Ownership Inventory

| Store/model | What it owns today | Ownership fields | Gaps |
| --- | --- | --- | --- |
| `training_agenda_event_ownership` | Training-created calendar events and cancellation/reconciliation audit. | `plan_id`, `plan_version`, `session_id`, `user_id`, `calendar_event_id`, `calendar_source`, `session_identity_key`, `session_shape_hash`, `status`. | Training-only; no tenant_id; lifecycle states are `active/deleted/orphaned`, not the full Secretary state model. |
| `secretary_agenda_items` | Intended universal Secretary agenda ledger. | `agenda_item_id`, `source_intent_id`, `source_skill`, `owner_user_id`, `tenant_id`, `lifecycle_state`, `provider_sync_state`, provider event metadata, version, reasons, segments, cancellation/supersession fields. | Schema-only. No runtime writer/reader/repair service found. |
| `content_topics` | Content scheduling artifacts. | `secretary_task_external_id`, task list fields, `calendar_event_id`, `calendar_source`, `secretary_sync_status`, `secretary_sync_error`. | Idempotent sync refs, but no universal agenda item ID, source intent ID, lifecycle state, provider sync lifecycle, or repair queue. |
| `training_sessions` | Session-level provider link. | `calendar_event_id`, `calendar_source`, identity/shape hash fields. | Session rows can disappear on plan deletion; Training ownership table mitigates this only for Training. |
| `reminders` | Basic reminders. | `user_id`, `message`, `remind_at`, `recurring`, `status`. | No tenant_id, source skill/entity, lifecycle reason, dedupe fingerprint, snooze/defer/escalation, linked agenda item, or follow-up model. |
| Provider event DTOs | Google/Outlook events surfaced to iOS. | `id`, `title`, `start`, `end`, `source`, categories/color. | Generic calendar API does not join or emit universal agenda metadata. |
| iOS `CalendarEvent` | Client rendering model. | Supports `agendaItemId`, `sourceIntentId`, `sourceSkill`, `lifecycleState`, `providerSyncState`, decision metadata, conflicts, alternatives, segments. | Backend generic calendar responses usually do not populate these fields. |

## Requested Gap Findings

### 1. Skills bypass Secretary

Confirmed.

| Skill/path | Evidence | Gap |
| --- | --- | --- |
| iOS/user calendar blocks | `src/api/routes/calendar.ts` creates/updates/deletes directly through `unified-calendar`. | No `secretary_agenda_items` row; no source intent; no lifecycle state. |
| Secretary tools | `src/services/tool-executor.ts` calls `unifiedCal.createEvent/updateEvent/deleteEvent` directly. | Model/tool output can mutate calendar without durable agenda ownership. |
| Training | `src/api/routes/training-plan-calendar-sync.ts` and cancellation routes own their own lifecycle. | Safe but separate; not universal Secretary arbitration. |
| Content Creation | `src/services/content-topic-secretary-sync.ts` creates tasks and calendar blocks directly. | Content-specific idempotency, no shared Secretary ledger. |
| Cooking | Weekly mesh only. | No durable meal-prep/grocery scheduling intent found. |
| Finance | Weekly mesh only. | No durable bill/budget/subscription review scheduling intent found. |

### 2. Events lack source ownership

Partially confirmed.

Training-generated events have durable source ownership in `training_agenda_event_ownership`. Content topics retain provider IDs on topic rows. Generic calendar events returned by `/api/v1/calendar/events` do not include `sourceSkill`, `sourceIntentId`, `agendaItemId`, or decision reasons because `formatEvent` emits only provider basics.

### 3. Agenda items lack lifecycle state

Confirmed for generic agenda.

The intended lifecycle states exist in migration `083`, and iOS has matching enums. The runtime generic calendar API does not populate those states, and no backend service currently transitions `secretary_agenda_items`.

Training has narrower lifecycle/status semantics (`active`, `deleted`, `orphaned`; session statuses such as `pending`, `completed`, `skipped`, `deferred`, `unscheduled`), but those are not yet normalized into Secretary’s universal lifecycle model.

### 4. Cancellations leave stale events

Mitigated for Training, still a gap generally.

Training cancellation:
- builds deletion targets from linked sessions and ownership rows,
- deletes by provider event ID/source,
- marks ownership rows `deleted` or `orphaned`,
- keeps orphan reconciliation available.

Generic calendar deletion and Content topic cancellation/update do not have a universal stale-event repair queue. Content can update an existing event if `calendar_event_id/source` remain valid, but there is no general read-back repair or orphan lifecycle outside Training.

### 5. Conflicts are not repaired

Confirmed outside Training-specific sync.

The planning mesh can detect conflicts and shadow lower-priority directives. `focus-planner` can find better focus windows. Training calendar sync can repair stale linked Training events. There is no general Secretary repair engine that takes conflicts and performs durable move/compress/defer/unscheduled transitions across all agenda items.

### 6. Reminders duplicate

Risk confirmed.

No dedupe key or source/entity identity exists in the reminders table. Repeated calls to `setReminder` with the same message/time/source can create duplicate rows. The route is user-scoped, but not lifecycle-rich enough for Secretary accountability.

### 7. Daily/weekly planning is unrealistic as executable schedule

Partially confirmed.

The planning layer is materially better than an optimistic list: it uses mesh contexts, conflict priority, Training load, calendar pressure, content/cooking/finance signals, and focus recommendations. The limitation is that it does not persist executable agenda blocks or prove that selected work fits into real time windows. It is realistic as advisory planning, not yet reliable as an agenda state machine.

## Universal Agenda Contract Needed

Secretary should become the only write owner for new Nexus-created schedule load by adding a service around `secretary_agenda_items`.

Minimum service operations:
- `createSchedulingIntent`
- `createAgendaItemFromIntent`
- `transitionAgendaItem`
- `syncAgendaItemToProvider`
- `cancelAgendaItem`
- `markAgendaItemSuperseded`
- `repairAgendaItemProviderState`
- `listActiveAgendaItems`
- `listAgendaItemsBySource`
- `listProviderMappingsNeedingRepair`

Minimum input contract:
- `intentId`
- `sourceSkill`
- `sourceEntityId`
- `sourceEntityType`
- `ownerUserId`
- `tenantId`
- `action`
- `requestedDurationMinutes`
- `preferredWindows`
- `hardConstraints`
- `softPreferences`
- `deadline`
- `priority`
- `flexibility`
- `recurrence`
- `dependencies`
- `energyCost`
- `reason`
- `sourceShapeHash`

Minimum response contract:
- `status`: `scheduled | reflowed | compressed | deferred | unscheduled | rejected | needs_more_context`
- `agendaItemId`
- `selectedSlot`
- `alternatives`
- `conflicts`
- `reasonCodes`
- `explanation`
- `confidence`
- `downstreamImplications`

## Backend API Contract Gap

The iOS model expects:
- `agendaItemId`
- `sourceIntentId`
- `sourceSkill`
- `sourceAction`
- `lifecycleState`
- `providerSyncState`
- `providerEventId`
- `providerSource`
- `version`
- `durationMinutes`
- `decisionAction`
- `decisionReasonCodes`
- `sourceShapeHash`
- `scheduledSegments`
- `cancellationReason`
- `supersededByAgendaItemId`
- `decisionExplanation`
- `conflicts`
- `alternatives`
- `agendaDate`

The backend generic calendar route currently emits:
- `id`
- `title`
- `description`
- `start`
- `end`
- `location`
- `source`
- `categories`
- `color`
- `isAllDay`

This means iOS readiness is mostly blocked by backend ownership wiring, not decoder support.

## Priority Matrix

| Priority | Gap | Why it matters |
| --- | --- | --- |
| P1 | `secretary_agenda_items` has no runtime service. | Central agenda ownership cannot be claimed until the ledger is authoritative. |
| P1 | Generic calendar/tool writes bypass agenda ledger. | Provider events can lack source, lifecycle, decision, and repair metadata. |
| P1 | No structured skill scheduling intent contract. | Cooking/Finance/Content/Training cannot consistently request time through Secretary. |
| P1 | Calendar API does not emit agenda metadata. | iOS cannot show real source/lifecycle/reason data for normal agenda items. |
| P1 | Reminder/follow-up model lacks source, tenant, dedupe, lifecycle. | Secretary cannot own accountability loops without duplicate/noise control. |
| P1 | No universal stale/duplicate repair worker. | Broken provider/local states can persist outside Training. |
| P2 | Daily/weekly accepted directives are not converted into agenda items. | Planning remains advisory instead of executable. |
| P2 | Provider staging smoke is Training-oriented. | Secretary agenda lifecycle still needs its own Google/Outlook proof. |
| P2 | Local calendar mock is not universal Secretary lifecycle coverage. | Full-product local smoke cannot prove non-Training agenda repair yet. |
| P3 | More iOS polish for future Secretary states. | The main missing piece is backend emission; frontend already has the core model. |

## Tests To Add Before Release Claims

Backend unit/integration:
- create agenda item from scheduling intent,
- source skill attribution persists,
- user/tenant ownership enforced,
- lifecycle transition matrix,
- provider sync state transition matrix,
- duplicate intent retry does not duplicate provider event,
- canceled/superseded items excluded from active agenda,
- generic calendar write creates agenda ledger row,
- generic calendar delete transitions agenda row precisely,
- Content topic sync writes/updates Secretary agenda row,
- Cooking meal-prep intent scheduled/unscheduled,
- Finance deadline reminder deduped and prioritized,
- unauthorized mutation of another user/tenant agenda item denied.

Repair/reflow:
- provider event deleted externally,
- provider event moved externally,
- provider update fails,
- local source entity canceled while provider event remains,
- duplicate provider events for same source intent,
- no valid slot produces `unscheduled`,
- overloaded day produces defer/compress/reflow decision,
- stale ledger item repaired from read-back.

iOS contract:
- calendar API decodes full agenda metadata,
- unknown lifecycle/provider state fallback,
- reflowed/compressed/deferred/unscheduled presentation,
- canceled/superseded hidden from active timeline,
- decision explanation rendering,
- source skill label rendering.

Provider smoke:
- Google Secretary agenda create/update/move/cancel/read-back/cleanup,
- Outlook Secretary agenda create/update/move/cancel/read-back/cleanup,
- duplicate retry,
- stale mapping cleanup,
- precise deletion by provider event ID,
- no unrelated event cleanup.

## Recommended Cutover Strategy

1. Keep existing Training ownership as a proven safety lane.
2. Add universal Secretary agenda service and dual-write Training/Content events into it behind a feature flag.
3. Teach generic calendar routes/tools to create ledger rows for Nexus-owned events.
4. Join ledger metadata into `/api/v1/calendar/events` responses.
5. Add repair worker using universal ledger.
6. Move Cooking/Finance scheduling into structured intents.
7. When universal ledger is proven, decide whether Training-specific ownership remains as an audit mirror or is migrated.
