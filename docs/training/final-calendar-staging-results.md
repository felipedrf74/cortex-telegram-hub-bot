# Training Calendar Staging Smoke Results

Date: 2026-04-28
Backend staging path: `/home/dominguez/telegram-hub-bot-staging`
Staging user ID: `1`
Production calendars touched: **no**

## Summary

Google Calendar and Outlook Calendar staging lifecycle smokes both passed with real provider write/read-back/update/delete behavior and precise cleanup.

The smokes used explicit staging-only guardrails:

- `STAGING=true`
- `NODE_ENV=staging`
- `TRAINING_CALENDAR_STAGING_SMOKE=1`
- `TRAINING_CALENDAR_STAGING_ALLOW_LIVE_WRITES=1`
- `TRAINING_CALENDAR_STAGING_USER_ID=1`

Provider credentials and OAuth encryption stayed on the staging server. No provider secrets were copied into the repository or logs.

## Google Calendar

- Run ID: `training-calendar-smoke-20260428165035-7ljwng`
- Started: `2026-04-28T16:50:35.958Z`
- Finished: `2026-04-28T16:50:59.756Z`
- Providers run: `google`
- Cleanup failures: **none**

| Operation | Result | Event IDs | Cleanup |
| --- | --- | --- | --- |
| `create_plan` | Pass: event created and visible on read-back | `0olda7dd6quuv0c7d60osk6qvk` | pending during run |
| `sync_update_time` | Pass: same event updated in place; run count remained `1` | `0olda7dd6quuv0c7d60osk6qvk` | pending during run |
| `regenerate_same_shape` | Pass: same-shape regeneration reused event identity | `0olda7dd6quuv0c7d60osk6qvk` | pending during run |
| `regenerate_changed_shape_create_replacement` | Pass: replacement event created | `l96v9b0ajn2lfdd799llm84s34` | pending during run |
| `regenerate_changed_shape_delete_old` | Pass: old event deleted and absent on read-back | `0olda7dd6quuv0c7d60osk6qvk` | cleaned |
| `retry_sync_no_duplicate` | Pass: read-back found exactly `1` active run event | n/a | not needed |
| `replace_plan_create_new` | Pass: replacement-plan event created with distinct identity | `bn4f3o9rflkjd878hck7k05s6k` | pending during run |
| `cancel_plan_delete_current` | Pass: current replacement event deleted by exact event ID | `l96v9b0ajn2lfdd799llm84s34` | cleaned |
| `replace_plan_delete_old_scope` | Pass: replacement-plan cleanup removed only the owned event | `bn4f3o9rflkjd878hck7k05s6k` | cleaned |

## Outlook Calendar

- Run ID: `training-calendar-smoke-20260428165107-7fsbbr`
- Started: `2026-04-28T16:51:07.441Z`
- Finished: `2026-04-28T16:51:36.504Z`
- Providers run: `outlook`
- Cleanup failures: **none**

| Operation | Result | Event IDs | Cleanup |
| --- | --- | --- | --- |
| `create_plan` | Pass: event created and visible on read-back | `AQMkADAwATYwMAItOTc3ADYtZGU2Mi0wMAItMDAKAEYAAAPyYzK-KwxpR6hNJKK7IxbnBwCBvs_GUJaQQKYTWun1Aj3sAAACAQ0AAACBvs_GUJaQQKYTWun1Aj3sAAjwd4IjAAAA` | pending during run |
| `sync_update_time` | Pass: same event updated in place; run count remained `1` | `AQMkADAwATYwMAItOTc3ADYtZGU2Mi0wMAItMDAKAEYAAAPyYzK-KwxpR6hNJKK7IxbnBwCBvs_GUJaQQKYTWun1Aj3sAAACAQ0AAACBvs_GUJaQQKYTWun1Aj3sAAjwd4IjAAAA` | pending during run |
| `regenerate_same_shape` | Pass: same-shape regeneration reused event identity | `AQMkADAwATYwMAItOTc3ADYtZGU2Mi0wMAItMDAKAEYAAAPyYzK-KwxpR6hNJKK7IxbnBwCBvs_GUJaQQKYTWun1Aj3sAAACAQ0AAACBvs_GUJaQQKYTWun1Aj3sAAjwd4IjAAAA` | pending during run |
| `regenerate_changed_shape_create_replacement` | Pass: replacement event created | `AQMkADAwATYwMAItOTc3ADYtZGU2Mi0wMAItMDAKAEYAAAPyYzK-KwxpR6hNJKK7IxbnBwCBvs_GUJaQQKYTWun1Aj3sAAACAQ0AAACBvs_GUJaQQKYTWun1Aj3sAAjwd4IkAAAA` | pending during run |
| `regenerate_changed_shape_delete_old` | Pass: old event deleted and absent on read-back | `AQMkADAwATYwMAItOTc3ADYtZGU2Mi0wMAItMDAKAEYAAAPyYzK-KwxpR6hNJKK7IxbnBwCBvs_GUJaQQKYTWun1Aj3sAAACAQ0AAACBvs_GUJaQQKYTWun1Aj3sAAjwd4IjAAAA` | cleaned |
| `retry_sync_no_duplicate` | Pass: read-back found exactly `1` active run event | n/a | not needed |
| `replace_plan_create_new` | Pass: replacement-plan event created with distinct identity | `AQMkADAwATYwMAItOTc3ADYtZGU2Mi0wMAItMDAKAEYAAAPyYzK-KwxpR6hNJKK7IxbnBwCBvs_GUJaQQKYTWun1Aj3sAAACAQ0AAACBvs_GUJaQQKYTWun1Aj3sAAjwd4IlAAAA` | pending during run |
| `cancel_plan_delete_current` | Pass: current replacement event deleted by exact event ID | `AQMkADAwATYwMAItOTc3ADYtZGU2Mi0wMAItMDAKAEYAAAPyYzK-KwxpR6hNJKK7IxbnBwCBvs_GUJaQQKYTWun1Aj3sAAACAQ0AAACBvs_GUJaQQKYTWun1Aj3sAAjwd4IkAAAA` | cleaned |
| `replace_plan_delete_old_scope` | Pass: replacement-plan cleanup removed only the owned event | `AQMkADAwATYwMAItOTc3ADYtZGU2Mi0wMAItMDAKAEYAAAPyYzK-KwxpR6hNJKK7IxbnBwCBvs_GUJaQQKYTWun1Aj3sAAACAQ0AAACBvs_GUJaQQKYTWun1Aj3sAAjwd4IlAAAA` | cleaned |

## Notes

- Both providers were tested against staging integrations only.
- All test events were marked by the staging harness and cleaned by exact provider event ID.
- No broad date-range cleanup or title-only matching was used.
- The smoke harness had to be patched to initialize the runtime database before loading calendar services; focused tool tests and typecheck passed after the fix.
- The provider read-back path currently uses the unified calendar reader, so Google-only reads may still initialize Outlook token refresh logging if Outlook is connected. This is noisy but did not affect pass/fail or cleanup.

## Verdict

Calendar staging lifecycle gate: **PASS** for Google and Outlook staging create/update/regenerate/cancel/retry with read-back and cleanup proof.
