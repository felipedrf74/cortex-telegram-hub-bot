# Secretary Calendar Staging Smoke Results

Date: 2026-04-29T12:21:38.032Z

Run ID: `secretary-calendar-google-final-20260429122125`

Verdict: **PASS**

User ID: `1`

Tenant ID: `secretary-calendar-staging-smoke`

Providers requested: google

Providers run: google

Operation summary: 8 pass, 0 fail, 0 blocked.

## Prerequisites

Status: pass

Missing: none

Warnings: none

## Operations

| Provider | Operation | Expected | Actual | Status | Agenda items | Provider events | Cleanup |
| --- | --- | --- | --- | --- | --- | --- | --- |
| google | create | Agenda item creates one provider event with read-back verification. | syncAction=created; providerEventId=6dr6aoku9b32ubm16kbleiauao; readBackCount=1 | pass | `sec_agenda_dec4fc50f6fcceb00d184d34` | `6dr6aoku9b32ubm16kbleiauao` | cleaned |
| google | update_move | Existing provider event updates/moves by exact event ID without duplication. | syncAction=updated; providerEventId=6dr6aoku9b32ubm16kbleiauao; readBackCount=1 | pass | `sec_agenda_dec4fc50f6fcceb00d184d34` | `6dr6aoku9b32ubm16kbleiauao` | cleaned |
| google | retry | Retry sync is idempotent and does not create a duplicate event. | syncAction=updated; providerEventId=6dr6aoku9b32ubm16kbleiauao; readBackCount=1 | pass | `sec_agenda_dec4fc50f6fcceb00d184d34` | `6dr6aoku9b32ubm16kbleiauao` | cleaned |
| google | stale_duplicate_cleanup | Duplicate provider event girrgrk9d09tves782cu3ljc90 is cleaned up by exact event ID. | syncAction=updated; providerEventId=6dr6aoku9b32ubm16kbleiauao; readBackCount=1 | pass | `sec_agenda_dec4fc50f6fcceb00d184d34` | `6dr6aoku9b32ubm16kbleiauao` | cleaned |
| google | external_provider_deletion_repair | Externally deleted provider event is recreated and remapped. | syncAction=recreated; providerEventId=u2h3210svpb68a131gneej1j9k; readBackCount=1 | pass | `sec_agenda_dec4fc50f6fcceb00d184d34` | `u2h3210svpb68a131gneej1j9k` | cleaned |
| google | regenerate_delete_superseded | Superseded agenda item deletes its old provider event precisely. | syncAction=deleted; providerEventId=u2h3210svpb68a131gneej1j9k; readBackCount=0 | pass | `sec_agenda_dec4fc50f6fcceb00d184d34` | `u2h3210svpb68a131gneej1j9k` | cleaned |
| google | replace_create_new | Replacement agenda item creates its own provider event. | syncAction=created; providerEventId=bh0sm82f47lua2k625gma7cdgo; readBackCount=1 | pass | `sec_agenda_c022312ee5b883ef3363828e` | `bh0sm82f47lua2k625gma7cdgo` | cleaned |
| google | cancel | Canceled agenda item deletes provider event by exact event ID. | syncAction=deleted; providerEventId=bh0sm82f47lua2k625gma7cdgo; readBackCount=0 | pass | `sec_agenda_c022312ee5b883ef3363828e` | `bh0sm82f47lua2k625gma7cdgo` | cleaned |

## Cleanup

Cleanup passed. No known staging provider events were left behind by this smoke run.

## Safety Notes

- This smoke requires `SECRETARY_CALENDAR_STAGING_SMOKE=1` and `SECRETARY_CALENDAR_STAGING_ALLOW_LIVE_WRITES=1`.
- The harness rejects `NODE_ENV=production` and requires a staging/test-looking `DATABASE_PATH` unless an explicit non-staging override is set.
- Provider cleanup uses exact provider event IDs and Secretary agenda markers only.
- Test events are clearly titled with `[NEXUS SECRETARY STAGING]` and the run ID.
