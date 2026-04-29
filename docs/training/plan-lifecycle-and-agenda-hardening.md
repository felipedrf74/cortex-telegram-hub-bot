# Training Plan Lifecycle and Agenda Hardening

Date: 2026-04-28

## Summary

This pass hardens the Training plan calendar lifecycle around the durable agenda ownership table. The goal is boring reliability: every generated calendar event must have a recoverable owner, every cancellation must delete precise owned events, and retries must avoid duplicate events.

## Lifecycle Model

Current plan rows still use the existing `fitness_training_plans.status` values (`active`, `completed`, `paused`, `cancelled`) plus hard-delete cancellation for the user-facing "remove everything" contract.

Calendar lifecycle is tracked separately in `training_agenda_event_ownership`:

| Status | Meaning | Recovery behavior |
| --- | --- | --- |
| `active` | A plan/session owns the provider event. | Used for idempotent relink and exact deletion. |
| `orphaned` | Local plan/session cleanup happened, but provider deletion failed. | Reconciler retries exact provider delete. |
| `deleted` | Provider deletion was confirmed or the stale event was repaired. | Audit only; never used for future sync. |

`plan_version` remains the versioning primitive for distinguishing event ownership across plan regeneration attempts.

## Hardened Behavior

### Ownership-first cancellation

Cancellation now builds deletion targets from:

1. Session `calendar_event_id` / `calendar_source`.
2. `training_agenda_event_ownership` rows for the plan that are still `active` or `orphaned`.
3. Legacy generated-event matching by title/date/duration only as fallback for pre-ownership data.

The fallback path now refuses to delete a matched event if it is owned by another Training plan or another user.

### Scoped ownership transitions

`markCalendarOwnershipDeleted` now accepts `userId`, `planId`, and `ownershipId` filters. New callers pass these scopes so a provider event-id collision cannot mark another user's or another plan's ownership row.

### Orphan reconciliation

The reconciler now retries both:

- rows already marked `orphaned`
- `active` ownership rows whose session row disappeared after hard delete

If deleting an active orphan fails, it is transitioned to `orphaned` so future reconciler runs keep retrying it.

### Stale linked event repair

Calendar sync already repaired stale session links by creating or linking a replacement event. It now also deletes the old mismatched linked event precisely after the replacement succeeds. If that provider delete fails, the ownership row is marked `orphaned` for retry instead of leaving an invisible duplicate.

### Calendar scope protection

Calendar scope checks now consider both live `training_sessions` links and active/orphaned ownership rows. This prevents a new plan from claiming a stale event as "unclaimed" just because its old session row was removed.

## Operational Invariants

- A provider event is never considered safe to claim if an active/orphaned ownership row exists.
- Cancellation deletes exact ownership rows before relying on legacy generated-event matching.
- Marking an ownership row terminal is scoped by user/plan where the caller has that context.
- A stale linked event is not left behind when sync creates a replacement.
- Reconciliation is exact-event only; no broad date-range deletion.

## Observability

The sync/cancel paths now emit structured logs for:

- stale linked event deletion success/failure
- ownership-recording failure
- partial cancellation provider-delete failures
- orphan reconciliation failures
- skipped unsupported calendar sources

Useful keys include `userId`, `planId`, `planVersion`, `sessionId`, `ownershipId`, `eventId`, and `source`.

## Validation

Focused tests covered:

- ownership insertion and idempotency
- scoped ownership transitions
- active orphan detection
- orphan reconciliation retries
- exact ownership-table cancellation
- cross-plan deletion protection
- stale linked event cleanup during sync repair
- calendar scope claim protection for orphaned events

