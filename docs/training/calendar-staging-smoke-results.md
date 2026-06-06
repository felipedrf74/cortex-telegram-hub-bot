# Training Calendar Staging Smoke Results

- Run ID: `training-calendar-smoke-20260522094015-r17jdd`
- Started: `2026-05-22T09:40:16.069Z`
- Finished: `2026-05-22T09:40:25.082Z`
- Dry run: `false`
- Staging user ID: `1000013`
- Providers requested: `google`
- Providers run: `google`

## Prerequisites

- Status: **ready**

## Operations

| Provider | Operation | Expected | Actual | Status | Event IDs | Cleanup |
| --- | --- | --- | --- | --- | --- | --- |
| google | create_plan | Training event is created and visible on read-back. | Read-back found event lffhnm7b969qovb2m4mj7fdc7s. | pass | `lffhnm7b969qovb2m4mj7fdc7s` | pending |
| google | sync_update_time | Existing event updates in place; no duplicate event appears. | Event lffhnm7b969qovb2m4mj7fdc7s updated in place; run event count is 1. | pass | `lffhnm7b969qovb2m4mj7fdc7s` | pending |
| google | regenerate_same_shape | Same-shape regeneration reuses the event identity and updates time/title only. | Event lffhnm7b969qovb2m4mj7fdc7s updated in place; run event count is 1. | pass | `lffhnm7b969qovb2m4mj7fdc7s` | pending |
| google | regenerate_changed_shape_create_replacement | Changed-shape regeneration creates the replacement event. | Read-back found event nerh58qosu1vt4fgnnctl671m4. | pass | `nerh58qosu1vt4fgnnctl671m4` | pending |
| google | regenerate_changed_shape_delete_old | Old shape event is precisely deleted after replacement. | Event lffhnm7b969qovb2m4mj7fdc7s was deleted and absent on read-back. | pass | `lffhnm7b969qovb2m4mj7fdc7s` | cleaned |
| google | retry_sync_no_duplicate | Retry/read-back sees the single current replacement event, not duplicates. | Read-back found 1 active event(s) for this provider/run. | pass | - | not_needed |
| google | replace_plan_create_new | Replacement plan creates its own event with distinct plan identity. | Read-back found event o7cvgumnq8vgq3tdaf08etv11g. | pass | `o7cvgumnq8vgq3tdaf08etv11g` | pending |
| google | cancel_plan_delete_current | Cancel/delete removes the current plan event by exact event ID. | Event nerh58qosu1vt4fgnnctl671m4 was deleted and absent on read-back. | pass | `nerh58qosu1vt4fgnnctl671m4` | cleaned |
| google | replace_plan_delete_old_scope | Replacement cleanup removes only the event owned by this smoke plan. | Event o7cvgumnq8vgq3tdaf08etv11g was deleted and absent on read-back. | pass | `o7cvgumnq8vgq3tdaf08etv11g` | cleaned |

## Cleanup Failures

None.

## Interpretation

All requested provider lifecycle operations passed with read-back and cleanup proof.

