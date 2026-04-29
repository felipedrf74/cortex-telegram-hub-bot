# Secretary Scheduling Intent Model

## Status

Implemented as a backend foundation in `src/services/secretary-scheduling-arbitrator.ts`.

This is the first runtime layer that lets Nexus skills ask Secretary for agenda placement through a typed contract instead of each skill independently creating calendar load. It writes decisions into the existing `secretary_agenda_items` ledger from migration `083_secretary_agenda_ledger.sql`.

## Purpose

Secretary owns schedule placement. Skills own their domain content.

- Training owns workout content and training-plan semantics.
- Cooking owns meal, grocery, and fueling content.
- Finance owns bill, budget, purchase, and subscription semantics.
- Content owns writing, editing, publishing, and reference/campaign semantics.
- Secretary arbitrates time, capacity, conflicts, lifecycle state, and schedule explainability.

## Intent Contract

Each skill submits a `SecretarySchedulingIntent` with:

| Field | Purpose |
| --- | --- |
| `intentId` | Stable idempotency key for the scheduling request. |
| `action` | Requested operation such as `schedule_this`, `reschedule_this`, `cancel_this`, `find_time_for_this`, `protect_time_for_this`, `create_reminder`, `create_follow_up`, or `request_clarification`. |
| `sourceSkill` | One of `secretary`, `training`, `cooking`, `finance`, `content`. |
| `sourceAction` | Skill-local action name, for example `schedule_session`, `schedule_meal_prep`, `schedule_bill_review`, `schedule_writing_block`. |
| `sourceEntityId` / `sourceEntityType` | The source object that created the schedule need. |
| `ownerUserId` / `tenantId` | Required user and tenant scope. Secretary rejects invalid scope. |
| `title` | User-facing agenda title. |
| `requestedDurationMinutes` | Required duration for placement. |
| `minimumDurationMinutes` | Minimum acceptable duration for compressible work. |
| `preferredWindows` | Candidate schedule windows. |
| `hardConstraints` | Unavailable, protected, or hard-commitment windows. |
| `softPreferences` | Domain preferences that can influence future scoring. |
| `deadline` | Deadline used for prioritization and defer decisions. |
| `priority` | `low`, `normal`, `high`, `urgent`, or numeric priority. |
| `flexibility` | `fixed`, `flexible`, `compressible`, or `splittable`. |
| `recurrence` | Reserved for recurring schedule/reminder work. |
| `dependencies` | Intent ids or source ids this request depends on. |
| `energyCost` | Optional load/capacity signal. |
| `reason` / `context` | Human/domain context for explainability. |
| `createdAt` / `updatedAt` | Source timestamps for freshness and audit. |

## Decision Contract

Secretary returns a `SecretarySchedulingDecision` with:

| Field | Purpose |
| --- | --- |
| `status` | `scheduled`, `reflowed`, `compressed`, `deferred`, `unscheduled`, `rejected`, or `needs_more_context`. |
| `agendaItem` | Persisted ledger row with ownership, lifecycle, version, provider sync state, and decision metadata. |
| `reasonCodes` | Machine-readable reasons such as `scheduled_in_available_window`, `finance_deadline_priority`, `compressed_to_fit_capacity`, `unscheduled_no_capacity`, `no_valid_slot`. |
| `explanation` | Short user-facing explanation. |
| `selectedSlot` | Chosen time window, when placement exists. |
| `alternativeSlots` | Other candidate windows, when useful. |
| `conflicts` | Busy/protected windows considered. |
| `downstreamImplications` | What the source skill should do next. |
| `confidence` | `low`, `medium`, or `high`. |
| `feedback` | Source-skill feedback payload. |

## Source Skill Feedback

Every decision includes `SecretarySourceSkillFeedback`:

- `sourceSkill`
- `sourceIntentId`
- `agendaItemId`
- `status`
- `reasonCodes`
- `scheduledStart`
- `scheduledEnd`
- `shouldRefreshSource`
- `downstreamImplications`

`shouldRefreshSource` is true for `reflowed`, `compressed`, `deferred`, `unscheduled`, and `needs_more_context`, because the source skill must update user-facing state or adapt workload.

## Priority And Capacity Foundation

The current scheduler uses explicit capacity inputs:

- persisted active Secretary agenda rows,
- caller-provided existing agenda items,
- additional busy windows,
- accepted slots from the current arbitration batch,
- hard constraints such as unavailable/protected/hard-commitment windows.

Intent priority is scored by:

- priority value,
- deadline presence,
- fixedness,
- source-skill weight.

Finance deadlines receive a specific priority reason code. Training, Cooking, and Content requests receive source-specific reason codes so downstream clients can explain the decision.

## Current Behavior

| Case | Behavior |
| --- | --- |
| Full slot available | `scheduled`. |
| Same intent moves because capacity changed | `reflowed`; previous row becomes `superseded`. |
| Compressible work cannot fit full duration but can fit minimum duration | `compressed`. |
| Flexible work has no current slot but a future deadline remains | `deferred`. |
| Fixed work has no valid slot | `unscheduled`. |
| Missing duration or availability | `needs_more_context`. |
| Invalid source skill or invalid ownership scope | `rejected` / unscheduled ledger state. |

## Idempotency And Versioning

Secretary computes a source shape hash from the intent. If the same intent shape resolves to the same slot, the service returns the existing row instead of duplicating agenda state.

If the same intent changes shape or resolves to a different slot, the prior row is marked `superseded` and a new version is inserted. The supersession update and replacement insert run inside a single DB transaction.

## Current Limitations

- This batch implements the Secretary arbitration foundation, not full provider sync.
- Provider writes still need a follow-up worker/service that consumes `secretary_agenda_items` and updates `provider_sync_state`.
- Existing Training, Cooking, Finance, and Content production flows are not all wired to this service yet. The service is ready for those integrations.
- Splitting multi-segment work is modeled but not implemented yet.
- Recurring reminders/intents are represented but not expanded into occurrences yet.
- iOS changes were not made in this backend-only batch.
