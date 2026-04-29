# Training Session Identity: Plan Version + Shape Hash

## Summary

This pass hardens regenerated Training session identity so agenda/calendar sync no longer relies on title/date matching for ownership decisions.

## Previous Weaknesses

- `training_sessions.id` was stable only for a persisted row, not for the same logical session across regeneration.
- `training_agenda_event_ownership` stored `plan_id`, `plan_version`, `session_id`, and event ids, but not a logical session key or material session shape.
- Calendar sync could claim an unlinked event by title/date/duration, which can confuse two sessions with the same display name.
- Cancellation could scan a week range and delete generated-looking events by title/date fallback.
- iOS-facing week payload did not expose plan version, session identity, shape hash, or explicit calendar-sync state.

## New Identity Model

Every newly persisted scheduled Training session now has:

| Field | Location | Purpose |
|---|---|---|
| `plan_id` | `training_sessions`, ownership rows | Tenant-scoped plan ownership anchor. |
| `plan_version` | `fitness_training_plans`, ownership rows | Regeneration/supersession generation counter. |
| `session_identity_key` | `training_sessions`, ownership rows | Stable logical slot for a plan/week/day/type/ordinal. Does not include version or shape. |
| `session_shape_hash` | `training_sessions`, ownership rows | Material coaching-structure hash. |
| `calendar_event_id` + `calendar_source` | `training_sessions`, ownership rows | Provider event identity. |

Calendar event descriptions also receive a compact `NEXUS_TRAINING_IDENTITY` marker with plan id, plan version, session id, identity key, and shape hash. This marker is used for precise orphan-event matching and prevents title/date-only reuse.

## Shape Hash Definition

`session_shape_hash` is a SHA-256-derived 20-character hash built from normalized session structure:

- modality/session type
- normalized role title
- planned duration
- intensity text
- exercise names and prescription fields
- structured description block shape where available

It intentionally ignores volatile prose formatting and is not meant to change for cosmetic copy edits. It should change when the session's coaching structure changes materially, such as primary exercise, interval structure, major duration, or intensity prescription changes.

## Regeneration Rules

| Scenario | Behavior |
|---|---|
| Same plan, same version, same session row | Existing ownership keeps the session idempotent. |
| Same plan, new version, same identity + same shape | Sync reuses/relinks the owned event and updates the event time/title when needed. |
| Same plan, new version, same identity + changed shape | Sync treats the old event as stale, creates a new event, then deletes/marks the old one. |
| Replacement plan with different `plan_id` | Identity key includes plan id, so events are not confused across plans. |
| Cancellation | Deletes linked events and ownership rows precisely; marker-only orphan cleanup is allowed, title/date-only cleanup is not. |
| Partial failure + retry | Ownership rows and identity markers allow retry without duplicate event creation. |

## Agenda Sync Behavior Changes

- New calendar events are created with identity markers.
- Ownership rows record `session_identity_key` and `session_shape_hash`.
- Unlinked provider events are only claimed when their Nexus identity marker matches the active plan/session shape and the event is unclaimed.
- Prior-version same-shape events are reusable through `findReusableOwnershipBySessionIdentity`.
- Changed-shape linked events are replaced precisely and their old ownership row is marked deleted or orphaned.
- Cancellation no longer deletes unowned title/date matches without a Nexus marker.

## iOS/API Compatibility

The read models now include additive fields:

- `plan.id`
- `plan.planVersion`
- `plan.lifecycleState`
- `session.planId`
- `session.planVersion`
- `session.sessionIdentityKey`
- `session.sessionShapeHash`
- `session.lifecycleState`
- `session.calendarSyncState` (`synced`, `stale`, `missing`)

These are additive and preserve existing fields for older clients.

## Files Changed

- `migrations/082_training_session_identity_shape_hash.sql`
- `src/services/training-session-identity.ts`
- `src/services/training-plans.ts`
- `src/services/training-plan-lifecycle.ts`
- `src/api/routes/training-plan-persistence.ts`
- `src/api/routes/training-plan-calendar-sync.ts`
- `src/api/routes/training-plan-cancellation.ts`
- `src/api/routes/training-read-models.ts`

## Validation

- Focused Vitest suite: 63 passing tests across session identity, lifecycle, persistence, sync, and cancellation.
- TypeScript typecheck passed.

## Remaining Risks

- Existing legacy calendar events without identity markers cannot be precisely orphan-matched unless they are still linked in `training_sessions` or ownership rows.
- Provider update APIs currently update title/time only, not the description marker. Same-shape prior-version reuse records the new ownership row, but the external event description may still contain the older version marker until a future richer update API supports description patches.
