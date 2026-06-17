# Secretary Agenda Ownership Status And Gaps

Status: current architecture memo
Last reviewed: 2026-06-16
Scope: agenda ownership, scheduling intents, event identity, lifecycle states, stale cleanup, duplicate prevention, provider smoke readiness, and iOS contract readiness.

## Summary

The universal Secretary ledger is no longer schema-only. The backend now has a runtime scheduling layer over `secretary_agenda_items`:

- `src/services/secretary-scheduling-arbitrator.ts` normalizes skill scheduling intents, selects slots, persists agenda lifecycle state, stores decision reasons, and emits source-skill feedback.
- `src/services/secretary-agenda-provider-sync.ts` owns provider create/update/attach/recreate/delete, duplicate cleanup, read-back repair, and provider sync state transitions.
- `src/services/scheduler.ts` invokes Secretary agenda provider sync for the scheduled lifecycle path.
- `src/services/secretary-unified-calendar-provider-adapter.ts` adapts Secretary agenda items to Google/Outlook calendar providers.
- `src/state/reminders.ts` now carries `tenant_id`, `timezone`, and `agenda_item_id` for agenda-linked reminders.

The remaining gap is **universal authority**. Secretary-owned structured intents have a ledger and lifecycle, but not every Nexus-created calendar/reminder path is forced through that ledger yet. Generic user calendar routes and some tool-executor calendar mutations can still write provider events without a universal `secretary_agenda_items` row.

Live Google/Outlook proof is also a gated release item. `src/tools/secretary-calendar-staging-smoke.ts` exists and covers live create/update/move/retry/duplicate cleanup/external-delete repair/supersede/cancel/cleanup, but it requires explicit staging-only env, live-write approval flags, staging OAuth identities, and cleanup verification before it can be claimed as passed.

## Existing Ownership Inventory

| Store/model | What it owns today | Ownership fields | Current gaps |
| --- | --- | --- | --- |
| `secretary_agenda_items` | Runtime ledger for Secretary/cross-skill structured scheduling intents. | `agenda_item_id`, `source_intent_id`, `source_skill`, `owner_user_id`, `tenant_id`, lifecycle/provider sync state, provider event metadata, version, reasons, segments, cancellation/supersession fields, reasoning trail. | Not yet the sole write authority for every calendar/reminder path; generic calendar API metadata join is incomplete; live provider proof remains gated. |
| `training_agenda_event_ownership` | Training-created calendar events and cancellation/reconciliation audit. | `plan_id`, `plan_version`, `session_id`, `user_id`, `calendar_event_id`, `calendar_source`, `session_identity_key`, `session_shape_hash`, `status`. | Still Training-specific. It is useful as an audit mirror but not the universal Secretary model. |
| `content_domain_objects` / `content_topics` | Content scheduling artifacts and some Secretary agenda linkage. | `secretary_agenda_item_id`, task/calendar refs, sync fields. | Content has partial integration; older topic/task paths may still rely on content-specific ids rather than full universal repair. |
| `training_sessions` | Session-level provider link and Training read model. | `calendar_event_id`, `calendar_source`, identity/shape hash fields. | Training-specific rows still need audit mirror alignment when plans are regenerated or canceled. |
| `reminders` | Agenda-linked and free-form reminders. | `user_id`, `tenant_id`, `timezone`, `message`, `remind_at`, `recurring`, `status`, `agenda_item_id`. | Agenda-linked dedupe is improved; free-form reminders still lack source/entity fingerprinting, snooze/defer/escalation, and richer follow-up lifecycle. |
| Provider event DTOs | Google/Outlook events surfaced to app clients. | `id`, `title`, `start`, `end`, `source`, categories/color; Secretary adapter can include agenda markers for Secretary-owned events. | Generic calendar responses do not consistently join and emit the full agenda metadata expected by iOS. |
| iOS `CalendarEvent` | Client rendering model. | Supports `agendaItemId`, `sourceIntentId`, `sourceSkill`, `lifecycleState`, `providerSyncState`, decision metadata, conflicts, alternatives, segments. | Decoder support is ahead of backend emission for generic calendar results. |

## Requested Gap Findings

### 1. Skills bypass Secretary

Partially mitigated, still a gap.

| Skill/path | Current state | Gap |
| --- | --- | --- |
| Training | Plan calendar sync and persistence call `submitSecretarySchedulingIntent` for Secretary agenda ownership, while keeping Training ownership as a safety mirror. | Generic Training event ownership and Secretary ownership need continued alignment during regeneration/cancellation. |
| Content | Editorial workflow can create/update `secretary_agenda_item_id` through Secretary scheduling. | Some legacy content-topic task/calendar paths can still rely on content-local sync ids. |
| Cooking | Meal-prep scheduling integration exists through `cooking-secretary-integration.ts`. | Not every advisory cooking plan is guaranteed to become an executable Secretary agenda item. |
| Finance | Finance scheduling integration exists through `finance-secretary-integration.ts`. | Advisory finance planning still needs full conversion to durable agenda/follow-up items. |
| iOS/user calendar blocks | `src/api/routes/calendar.ts` still has direct generic calendar create/update/delete behavior. | Generic user calendar writes can bypass `secretary_agenda_items`. |
| Secretary tools | Tool-executor calendar mutations can still call the unified calendar provider directly. | Model/tool calendar writes need forced ledger ownership or an explicit non-Nexus-owned escape hatch. |

### 2. Events lack source ownership

Partially mitigated.

Secretary-owned items now carry `sourceSkill`, `sourceIntentId`, `sourceAction`, `sourceEntityId`, lifecycle state, provider sync state, decision reasons, and reasoning trail. Training and Content also have domain-specific ownership fields.

The remaining gap is generic provider events returned through standard calendar APIs. Those responses can still lack `agendaItemId`, `sourceSkill`, `sourceIntentId`, lifecycle, provider sync, and decision reason metadata.

### 3. Agenda items lack lifecycle state

Mostly mitigated for Secretary intents.

`secretary-scheduling-arbitrator.ts` persists lifecycle states such as `scheduled`, `synced`, `reflowed`, `compressed`, `deferred`, `canceled`, `superseded`, `unscheduled`, `failed_sync`, and `completed`. `secretary-agenda-provider-sync.ts` transitions provider sync states such as `synced`, `create_failed`, `update_failed`, `delete_failed`, `readback_failed`, and `deleted`.

The remaining issue is coverage: generic provider calendar events that bypass Secretary do not have that lifecycle state machine.

### 4. Cancellations leave stale events

Mitigated for Secretary-owned and Training-owned paths, still a generic gap.

Secretary provider sync deletes by exact provider event ID for canceled, superseded, unscheduled, deferred, and completed agenda items. Training cancellation also reads both Training ownership rows and Secretary-owned rows and handles provider cleanup.

Generic calendar deletion and direct tool calendar writes still need the same universal stale-event repair and lifecycle guarantees.

### 5. Conflicts are not repaired

Partially mitigated.

The arbitrator can select alternatives, compress/reflow/defer/unschedule, and persist decision reasons. Provider sync can repair missing provider events and remove duplicates for Secretary-owned items.

What is still missing is a universal repair worker that continuously reconciles every Nexus-owned calendar/reminder item, including older generic events and non-Secretary writes.

### 6. Reminders duplicate

Partially mitigated.

Agenda-linked reminders now include `agenda_item_id`, `tenant_id`, and `timezone`, and `cancelRemindersForAgendaItem` / `updateRemindersForAgendaItem` allow agenda lifecycle cleanup.

Free-form reminders can still duplicate if they do not carry a durable source/entity fingerprint. Snooze, defer, escalation, and follow-up semantics remain incomplete.

### 7. Daily/weekly planning is unrealistic as executable schedule

Partially mitigated.

The planning layer now has a better path to executable scheduling because skills can submit typed Secretary scheduling intents. The limitation is conversion coverage: advisory weekly/daily directives are not guaranteed to become agenda items unless the flow calls the Secretary scheduling contract.

## Implemented Secretary Agenda Contract

Current implemented foundation:

- `submitSecretarySchedulingIntent`
- `previewSecretarySchedulingIntent`
- `listSecretaryAgendaItems`
- `getSecretaryAgendaItemById`
- `cancelSecretaryAgendaItem`
- `syncSecretaryAgendaItemToProvider`
- `syncSecretaryAgendaItemsToProvider`
- `markCompletedSecretaryAgendaItems`
- source-skill feedback consumers for Training and cross-skill state
- agenda-linked reminder cancellation/update helpers

The service contract supports:

- `intentId`
- `sourceSkill`
- `sourceAction`
- `sourceEntityId`
- `sourceEntityType`
- `ownerUserId`
- `tenantId`
- `action`
- `requestedDurationMinutes`
- `minimumDurationMinutes`
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
- `goalPhase`

Response/state fields include:

- `status`
- `agendaItemId`
- `selectedSlot`
- `alternativeSlots`
- `conflicts`
- `reasonCodes`
- `explanation`
- `confidence`
- `downstreamImplications`
- `lifecycleState`
- `providerSyncState`
- `scheduledSegments`
- `reasoningTrail`

## Remaining Contract Work

1. Force all Nexus-owned generic calendar creates/updates/deletes through Secretary, or tag them explicitly as external/user-owned events.
2. Force tool-executor calendar mutations through Secretary agenda ownership.
3. Join Secretary metadata into generic `/api/v1/calendar/events` responses for Secretary-owned provider events.
4. Extend reminders with source/entity fingerprint, snooze/defer/escalation, and follow-up lifecycle semantics for non-agenda reminders.
5. Add a universal reconciliation job that repairs stale, missing, duplicated, or externally moved provider events outside Training-only paths.
6. Convert accepted daily/weekly planning directives into Secretary agenda items when the user approves executable schedule changes.
7. Run and record the live/sandbox Google/Outlook Secretary calendar staging smoke with staging identities and cleanup proof.

## Backend API Contract Gap

iOS can already decode rich agenda metadata:

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

The generic backend calendar route can still emit only provider basics for many events:

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

So iOS readiness is mostly a backend emission and authority-coverage issue, not a decoder issue.

## Priority Matrix

| Priority | Gap | Why it matters |
| --- | --- | --- |
| P1 | Generic calendar/tool writes can bypass Secretary. | Provider events can still lack source, lifecycle, decision, and repair metadata. |
| P1 | Live Google/Outlook Secretary agenda proof is gated. | The harness exists, but release claims need real staging/sandbox credentials, live-write gates, and cleanup evidence. |
| P1 | Reminder/follow-up free-form model lacks source fingerprint, snooze/defer/escalation. | Secretary cannot fully own accountability loops without duplicate/noise control. |
| P1 | Calendar API does not consistently emit agenda metadata. | iOS cannot show real source/lifecycle/reason data for normal agenda items. |
| P2 | No universal stale/duplicate repair worker for all schedule load. | Broken provider/local states can persist outside Secretary-owned and Training-owned paths. |
| P2 | Daily/weekly accepted directives are not always converted into agenda items. | Planning can remain advisory instead of executable. |
| P2 | Secretary calendar staging smoke lacks a checked-in shell wrapper/package script. | The TypeScript smoke exists, but release operators need a standard script/evidence path like Training. |
| P2 | Full product A-AN Secretary + Decision Center E2E evidence is not repo-canonical. | Temporary `/tmp` QA evidence should not be treated as durable release truth unless indexed. |
| P3 | iOS polish for future Secretary states. | Backend emission and live provider proof are the main remaining blockers. |

## Current Coverage

Backend coverage already present in the repo includes:

- `__tests__/services/secretary-scheduling-arbitrator.test.ts`
- `__tests__/services/secretary-agenda-provider-sync.test.ts`
- `__tests__/services/scheduler-secretary-agenda-sync.test.ts`
- `__tests__/services/training-plan-cancellation-cascade.test.ts`
- `__tests__/services/secretary-source-skill-feedback-consumers.test.ts`
- `__tests__/services/secretary-reasoning-trail.test.ts`
- `__tests__/services/decision-center-secretary-trail.test.ts`
- Content/Cooking/Finance tests that exercise Secretary scheduling integrations.

Coverage still needed before universal release claims:

- generic calendar create/update/delete creates or transitions Secretary ledger rows,
- direct tool-executor calendar writes cannot bypass Secretary for Nexus-owned events,
- generic calendar list joins and emits agenda metadata,
- free-form reminder dedupe by source/entity fingerprint,
- universal stale/duplicate provider repair outside Training,
- daily/weekly accepted directives become agenda items,
- live/sandbox Google Secretary agenda create/update/move/cancel/read-back/cleanup,
- live/sandbox Outlook Secretary agenda create/update/move/cancel/read-back/cleanup,
- iOS unit/UI coverage for full agenda metadata display on generic calendar responses.

## Recommended Cutover Strategy

1. Keep existing Training ownership as a safety/audit mirror.
2. Keep using `secretary_agenda_items` for new structured cross-skill scheduling intents.
3. Move generic calendar routes and tool-executor calendar writes behind Secretary agenda ownership.
4. Join ledger metadata into generic calendar responses.
5. Add a standard `scripts/secretary-calendar-staging-smoke.sh` wrapper and release-gate evidence path around `src/tools/secretary-calendar-staging-smoke.ts`.
6. Add the universal repair worker and free-form reminder lifecycle model.
7. Re-run changed-area tests and live/sandbox provider smoke before claiming universal Secretary agenda ownership.
