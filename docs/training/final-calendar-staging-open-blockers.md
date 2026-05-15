# Final Calendar Staging Open Blockers

Updated: 2026-04-28  
Run ID: `training-calendar-smoke-20260428094430-r9cyiu`

## Summary

The final calendar lifecycle staging gate is blocked before provider execution. These blockers must be resolved before Training calendar lifecycle can be production-cleared.

## Blockers

| ID | Severity | Provider / Layer | Blocker | Impact | Required Resolution | Waiver Policy |
| --- | --- | --- | --- | --- | --- | --- |
| CAL-P0-01 | P0 | Global staging | No staging mode configured: missing `STAGING=true` or `NODE_ENV=staging`. | Harness refuses live writes, so no provider lifecycle can be proven. | Run with staging-mode env only. | Cannot waive globally; protects production data. |
| CAL-P0-02 | P0 | Global staging | Missing explicit write guardrails: `TRAINING_CALENDAR_STAGING_SMOKE=1` and `TRAINING_CALENDAR_STAGING_ALLOW_LIVE_WRITES=1`. | Harness refuses writes. | Set both flags only for isolated staging smoke. | Cannot waive globally. |
| CAL-P0-03 | P0 | Internal agenda / OAuth | Missing `TRAINING_CALENDAR_STAGING_USER_ID=<staging user id>`. | No user-scoped OAuth tokens or agenda ownership can be verified. | Provide isolated staging user with Google/Outlook connected. | Provider-specific waiver possible only if that provider is not in release scope. |
| CAL-P0-04 | P0 | Internal agenda DB | Missing `DATABASE_PATH=<staging database path>`. | Plan lifecycle, ownership mapping, and OAuth token lookup cannot run. | Provide staging/test database path. It must look like staging/test unless explicitly overridden. | Cannot waive if backend calendar lifecycle ships. |
| CAL-P0-05 | P0 | OAuth security | Missing `OAUTH_ENCRYPTION_KEY`. | OAuth tokens cannot be decrypted for staging provider calls. | Provide staging OAuth encryption key matching staging DB token encryption. | Cannot waive for real provider smoke. |
| CAL-P0-06 | P0 | Google Calendar | Missing `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. | Google create/update/read/delete cannot be run. | Provide staging Google OAuth app credentials and connected staging user tokens. | Google may be waived only by explicit owner decision; otherwise release blocker. |
| CAL-P0-07 | P0 | Outlook Calendar | Missing `OUTLOOK_CLIENT_ID` and `OUTLOOK_CLIENT_SECRET`. | Outlook create/update/read/delete cannot be run. | Provide staging Outlook OAuth app credentials and connected staging user tokens. | Outlook may be waived only by explicit owner decision; otherwise release blocker. |
| CAL-P0-08 | P0 | Provider read-back | No provider read-back evidence exists for create/update/regenerate/cancel/retry. | Calendar lifecycle trust remains unproven despite local tests. | Rerun smoke and archive event IDs/read-back/cleanup status. | Cannot waive unless provider is out of release scope. |
| CAL-P0-09 | P0 | Cleanup proof | No real cleanup proof exists because no events were created. | Stale event cleanup is unproven. | Rerun smoke; cleanup must be `cleaned` or exact failures documented. | Cannot waive for provider in release scope. |

## Required Pass Conditions

For each provider in release scope:

- `create_plan`: pass with read-back event ID.
- `sync_update_time`: pass with same event ID and no duplicate.
- `regenerate_same_shape`: pass with same logical event behavior.
- `regenerate_changed_shape_create_replacement`: pass with replacement event ID.
- `regenerate_changed_shape_delete_old`: pass with old event absent on read-back.
- `retry_sync_no_duplicate`: pass with exactly one active current run event.
- `replace_plan_create_new`: pass with distinct replacement plan identity.
- `cancel_plan_delete_current`: pass with event absent on read-back.
- `replace_plan_delete_old_scope`: pass with precise cleanup.
- `Cleanup Failures`: `None`.

## Current Release Recommendation

Do not mark Training calendar lifecycle production-ready. The backend hardening branch can proceed to staging validation, but not production promotion, until this gate passes or provider scope is explicitly waived.
