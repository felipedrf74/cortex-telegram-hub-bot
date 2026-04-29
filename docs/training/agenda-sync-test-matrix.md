# Training Agenda Sync Test Matrix

Date: 2026-04-28

| Area | Scenario | Expected Result | Covered By |
| --- | --- | --- | --- |
| Plan activation | Unsynced future sessions are created on calendar. | Events are created, sessions linked, ownership rows recorded. | `__tests__/api/training-plan-calendar-sync.test.ts` |
| Idempotent retry | Existing live `calendar_event_id` is verified. | No duplicate event; ownership recorded/reused. | `training-plan-calendar-sync.test.ts` |
| Idempotent relink | Ownership row exists but session lost link. | Session relinks to owned event without creating duplicate. | `training-plan-calendar-sync.test.ts` |
| Stale link repair | Stored event exists but title/date/duration no longer matches. | Replacement event is created; stale event is precisely deleted or queued. | `training-plan-calendar-sync.test.ts` |
| Cancellation | Linked sessions have provider events. | Exact events deleted before hard-delete; ownership rows marked deleted. | `__tests__/api/training-plan-cancellation.test.ts` |
| Cancellation fallback | Session link missing but ownership row exists. | Ownership-table event is deleted even if provider list fails. | `training-plan-cancellation.test.ts` |
| Cross-plan safety | Legacy title match belongs to another active plan. | Event is not deleted. | `training-plan-cancellation.test.ts` |
| Orphan retry | Provider delete failed during cancellation. | Row remains queued and reconciler retries exact event. | `__tests__/services/training-agenda-reconciliation.test.ts` |
| Active orphan retry | Plan/session hard-deleted before row marked orphaned. | Reconciler attempts exact delete and marks deleted on success. | `training-agenda-reconciliation.test.ts` |
| Retry failure | Active orphan provider delete fails. | Row is transitioned to `orphaned` for later retry. | `training-agenda-reconciliation.test.ts` |
| Scope protection | Orphaned ownership row exists for event. | Event is not treated as unclaimed by future sync. | `__tests__/services/training-calendar-scope.test.ts` |
| Tenant safety | Same event id/source appears in another user's row. | Scoped terminal update touches only requested user/plan. | `__tests__/services/training-plan-lifecycle.test.ts` |

## Commands Run

```bash
npm test -- --run __tests__/services/training-plan-lifecycle.test.ts __tests__/services/training-agenda-reconciliation.test.ts __tests__/services/training-calendar-scope.test.ts __tests__/api/training-plan-cancellation.test.ts __tests__/api/training-plan-calendar-sync.test.ts
npm run typecheck
```

## Recommended Future Coverage

- End-to-end route smoke with a real SQLite database and mocked Google/Outlook adapters.
- Concurrent sync requests for the same active plan.
- Plan replacement where cancellation succeeds locally but one provider delete fails, followed by a later reconciliation run.
- Manual calendar edit that moves a training event while session identity remains the same.

