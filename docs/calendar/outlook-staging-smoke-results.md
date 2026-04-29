# Secretary Calendar Staging Smoke Results

Date: 2026-04-29T12:23:45.523Z

Run ID: `secretary-calendar-outlook-final-20260429122259`

Verdict: **PASS**

User ID: `1`

Tenant ID: `secretary-calendar-staging-smoke`

Providers requested: outlook

Providers run: outlook

Operation summary: 8 pass, 0 fail, 0 blocked.

## Prerequisites

Status: pass

Missing: none

Warnings: none

## Operations

| Provider | Operation | Expected | Actual | Status | Agenda items | Provider events | Cleanup |
| --- | --- | --- | --- | --- | --- | --- | --- |
| outlook | create | Agenda item creates one provider event with read-back verification. | syncAction=created; providerEventId=AQMkADAwATYwMAItOTc3ADYtZGU2Mi0wMAItMDAKAEYAAAPyYzK-KwxpR6hNJKK7IxbnBwCBvs_GUJaQQKYTWun1Aj3sAAACAQ0AAACBvs_GUJaQQKYTWun1Aj3sAAjyF35SAAAA; readBackCount=1 | pass | `sec_agenda_9b921f34193703c162ceaaa1` | `AQMkADAwATYwMAItOTc3ADYtZGU2Mi0wMAItMDAKAEYAAAPyYzK-KwxpR6hNJKK7IxbnBwCBvs_GUJaQQKYTWun1Aj3sAAACAQ0AAACBvs_GUJaQQKYTWun1Aj3sAAjyF35SAAAA` | cleaned |
| outlook | update_move | Existing provider event updates/moves by exact event ID without duplication. | syncAction=updated; providerEventId=AQMkADAwATYwMAItOTc3ADYtZGU2Mi0wMAItMDAKAEYAAAPyYzK-KwxpR6hNJKK7IxbnBwCBvs_GUJaQQKYTWun1Aj3sAAACAQ0AAACBvs_GUJaQQKYTWun1Aj3sAAjyF35SAAAA; readBackCount=1 | pass | `sec_agenda_9b921f34193703c162ceaaa1` | `AQMkADAwATYwMAItOTc3ADYtZGU2Mi0wMAItMDAKAEYAAAPyYzK-KwxpR6hNJKK7IxbnBwCBvs_GUJaQQKYTWun1Aj3sAAACAQ0AAACBvs_GUJaQQKYTWun1Aj3sAAjyF35SAAAA` | cleaned |
| outlook | retry | Retry sync is idempotent and does not create a duplicate event. | syncAction=updated; providerEventId=AQMkADAwATYwMAItOTc3ADYtZGU2Mi0wMAItMDAKAEYAAAPyYzK-KwxpR6hNJKK7IxbnBwCBvs_GUJaQQKYTWun1Aj3sAAACAQ0AAACBvs_GUJaQQKYTWun1Aj3sAAjyF35SAAAA; readBackCount=1 | pass | `sec_agenda_9b921f34193703c162ceaaa1` | `AQMkADAwATYwMAItOTc3ADYtZGU2Mi0wMAItMDAKAEYAAAPyYzK-KwxpR6hNJKK7IxbnBwCBvs_GUJaQQKYTWun1Aj3sAAACAQ0AAACBvs_GUJaQQKYTWun1Aj3sAAjyF35SAAAA` | cleaned |
| outlook | stale_duplicate_cleanup | Duplicate provider event AQMkADAwATYwMAItOTc3ADYtZGU2Mi0wMAItMDAKAEYAAAPyYzK-KwxpR6hNJKK7IxbnBwCBvs_GUJaQQKYTWun1Aj3sAAACAQ0AAACBvs_GUJaQQKYTWun1Aj3sAAjyF35TAAAA is cleaned up by exact event ID. | syncAction=updated; providerEventId=AQMkADAwATYwMAItOTc3ADYtZGU2Mi0wMAItMDAKAEYAAAPyYzK-KwxpR6hNJKK7IxbnBwCBvs_GUJaQQKYTWun1Aj3sAAACAQ0AAACBvs_GUJaQQKYTWun1Aj3sAAjyF35SAAAA; readBackCount=1 | pass | `sec_agenda_9b921f34193703c162ceaaa1` | `AQMkADAwATYwMAItOTc3ADYtZGU2Mi0wMAItMDAKAEYAAAPyYzK-KwxpR6hNJKK7IxbnBwCBvs_GUJaQQKYTWun1Aj3sAAACAQ0AAACBvs_GUJaQQKYTWun1Aj3sAAjyF35SAAAA` | cleaned |
| outlook | external_provider_deletion_repair | Externally deleted provider event is recreated and remapped. | syncAction=recreated; providerEventId=AQMkADAwATYwMAItOTc3ADYtZGU2Mi0wMAItMDAKAEYAAAPyYzK-KwxpR6hNJKK7IxbnBwCBvs_GUJaQQKYTWun1Aj3sAAACAQ0AAACBvs_GUJaQQKYTWun1Aj3sAAjyF35UAAAA; readBackCount=1 | pass | `sec_agenda_9b921f34193703c162ceaaa1` | `AQMkADAwATYwMAItOTc3ADYtZGU2Mi0wMAItMDAKAEYAAAPyYzK-KwxpR6hNJKK7IxbnBwCBvs_GUJaQQKYTWun1Aj3sAAACAQ0AAACBvs_GUJaQQKYTWun1Aj3sAAjyF35UAAAA` | cleaned |
| outlook | regenerate_delete_superseded | Superseded agenda item deletes its old provider event precisely. | syncAction=deleted; providerEventId=AQMkADAwATYwMAItOTc3ADYtZGU2Mi0wMAItMDAKAEYAAAPyYzK-KwxpR6hNJKK7IxbnBwCBvs_GUJaQQKYTWun1Aj3sAAACAQ0AAACBvs_GUJaQQKYTWun1Aj3sAAjyF35UAAAA; readBackCount=0 | pass | `sec_agenda_9b921f34193703c162ceaaa1` | `AQMkADAwATYwMAItOTc3ADYtZGU2Mi0wMAItMDAKAEYAAAPyYzK-KwxpR6hNJKK7IxbnBwCBvs_GUJaQQKYTWun1Aj3sAAACAQ0AAACBvs_GUJaQQKYTWun1Aj3sAAjyF35UAAAA` | cleaned |
| outlook | replace_create_new | Replacement agenda item creates its own provider event. | syncAction=created; providerEventId=AQMkADAwATYwMAItOTc3ADYtZGU2Mi0wMAItMDAKAEYAAAPyYzK-KwxpR6hNJKK7IxbnBwCBvs_GUJaQQKYTWun1Aj3sAAACAQ0AAACBvs_GUJaQQKYTWun1Aj3sAAjyF35VAAAA; readBackCount=1 | pass | `sec_agenda_a9175d76e9cf8e4e5fdb705a` | `AQMkADAwATYwMAItOTc3ADYtZGU2Mi0wMAItMDAKAEYAAAPyYzK-KwxpR6hNJKK7IxbnBwCBvs_GUJaQQKYTWun1Aj3sAAACAQ0AAACBvs_GUJaQQKYTWun1Aj3sAAjyF35VAAAA` | cleaned |
| outlook | cancel | Canceled agenda item deletes provider event by exact event ID. | syncAction=deleted; providerEventId=AQMkADAwATYwMAItOTc3ADYtZGU2Mi0wMAItMDAKAEYAAAPyYzK-KwxpR6hNJKK7IxbnBwCBvs_GUJaQQKYTWun1Aj3sAAACAQ0AAACBvs_GUJaQQKYTWun1Aj3sAAjyF35VAAAA; readBackCount=0 | pass | `sec_agenda_a9175d76e9cf8e4e5fdb705a` | `AQMkADAwATYwMAItOTc3ADYtZGU2Mi0wMAItMDAKAEYAAAPyYzK-KwxpR6hNJKK7IxbnBwCBvs_GUJaQQKYTWun1Aj3sAAACAQ0AAACBvs_GUJaQQKYTWun1Aj3sAAjyF35VAAAA` | cleaned |

## Cleanup

Cleanup passed. No known staging provider events were left behind by this smoke run.

## Safety Notes

- This smoke requires `SECRETARY_CALENDAR_STAGING_SMOKE=1` and `SECRETARY_CALENDAR_STAGING_ALLOW_LIVE_WRITES=1`.
- The harness rejects `NODE_ENV=production` and requires a staging/test-looking `DATABASE_PATH` unless an explicit non-staging override is set.
- Provider cleanup uses exact provider event IDs and Secretary agenda markers only.
- Test events are clearly titled with `[NEXUS SECRETARY STAGING]` and the run ID.
