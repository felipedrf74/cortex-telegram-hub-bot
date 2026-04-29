# Secretary Agenda Ownership Model

## Status

Implemented as a durable backend ledger contract using `secretary_agenda_items` and `src/services/secretary-scheduling-arbitrator.ts`.

## Ownership Rule

Secretary owns agenda placement and lifecycle for Nexus-created schedule load.

Other skills should submit scheduling intents and consume Secretary decisions instead of writing calendar/provider events directly.

## Agenda Item Identity

Each persisted agenda item carries:

| Field | Meaning |
| --- | --- |
| `agenda_item_id` | Stable Secretary agenda item id. |
| `source_intent_id` | Stable scheduling request id from the source skill/action. |
| `source_skill` | `secretary`, `training`, `cooking`, `finance`, or `content`. |
| `source_action` | Source action such as `schedule_session` or `schedule_bill_review`. |
| `intent_action` | Requested schedule action. |
| `source_entity_id` / `source_entity_type` | Source skill object identity. |
| `owner_user_id` / `tenant_id` | Required user and tenant ownership boundary. |
| `lifecycle_state` | Agenda lifecycle state. |
| `provider_sync_state` | Provider sync lifecycle state. |
| `provider_event_id` / `provider_source` | External Google/Outlook mapping when synced. |
| `version` | Monotonic per source intent. |
| `title`, `start_at`, `end_at`, `duration_minutes` | Placement details. |
| `decision_action` | Secretary decision status. |
| `decision_reason_codes_json` | Machine-readable explanation reasons. |
| `source_shape_hash` | Idempotency and change-detection hash. |
| `scheduled_segments_json` | Current segment payload for split/compressed work. |
| `cancellation_reason` | Cancellation explanation when applicable. |
| `superseded_by_agenda_item_id` | Link to replacement agenda item. |
| `created_at`, `updated_at`, `completed_at` | Lifecycle timestamps. |
| `source_created_at`, `source_updated_at` | Source freshness timestamps. |

## Lifecycle States

Secretary uses the migration `083` lifecycle vocabulary:

- `proposed`
- `scheduled`
- `synced`
- `reflowed`
- `compressed`
- `deferred`
- `canceled`
- `superseded`
- `unscheduled`
- `failed_sync`
- `completed`

Active busy states for capacity are:

- `scheduled`
- `synced`
- `reflowed`
- `compressed`
- `failed_sync`

Inactive states excluded from normal active agenda listings are:

- `canceled`
- `superseded`
- `completed`

`unscheduled` and `deferred` remain visible as agenda/planning state because clients need to show what could not be placed and why.

## Provider Sync States

Provider sync state is explicit:

- `not_synced`
- `synced`
- `create_failed`
- `update_failed`
- `delete_failed`
- `readback_failed`
- `deleted`

The arbitrator currently persists `not_synced`. A provider sync worker should later move rows through create/update/delete/read-back outcomes. This keeps provider retries idempotent and avoids title/date matching.

## Supersession Semantics

When a source intent changes or capacity forces a new placement:

1. Secretary computes a new agenda item id for the next version.
2. The previous active row is marked `superseded`.
3. The previous row receives `superseded_by_agenda_item_id`.
4. The new row is inserted with lifecycle `reflowed`, `scheduled`, `compressed`, `deferred`, or `unscheduled`.
5. The update and insert run in one transaction.

This preserves auditability while ensuring active agenda views do not show stale prior placements.

## Source Skill Boundaries

| Skill | Owns | Secretary Owns |
| --- | --- | --- |
| Training | Plan/session content, training adaptation, workout semantics. | Workout agenda placement, reflow/compression/unscheduled state, source feedback. |
| Cooking | Meal/grocery/fueling content. | Prep/grocery/cooking placement and conflict handling around other commitments. |
| Finance | Financial rules, deadlines, budget/review semantics. | Reminder/review placement and deadline priority arbitration. |
| Content | Content references, workload, writing/editing/publishing semantics. | Focus block placement, publishing/deadline scheduling, overload tradeoff. |
| Secretary | User-created agenda items, planning, reminders/follow-ups. | Full placement/lifecycle authority. |

## Security And Scope

The arbitrator requires both `ownerUserId` and `tenantId` on every intent. Queries against the ledger are scoped by both.

Invalid ownership scope is rejected before placement. This is not a substitute for route-level authorization; every API/tool route that calls the arbitrator must still authenticate the user and verify tenant membership/permissions before submitting an intent.

## Do-Not-Break Rules

- Do not delete provider events by broad date ranges.
- Do not match provider events only by title/date.
- Do not create new provider events on retry without checking the Secretary agenda item/provider mapping.
- Do not hide `unscheduled`, `deferred`, `compressed`, or `reflowed` states from clients.
- Do not let source skills mutate agenda rows that belong to a different skill unless an explicit Secretary policy allows it.
- Do not use frontend filtering as the ownership boundary.

## Remaining Work

- Wire Training plan/session lifecycle through this service.
- Add Cooking, Finance, and Content adapters that submit scheduling intents.
- Add provider sync worker with read-back and precise cleanup.
- Add repair logic for provider-deleted/stale/duplicate external events.
- Expose the ledger through Secretary/iOS-facing APIs.
- Add route-level authorization tests around callers that submit intents.
