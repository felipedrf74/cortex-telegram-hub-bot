# Training Calendar Staging Smoke Results

- Run ID: `training-calendar-smoke-20260513224802-csg768`
- Started: `2026-05-13T22:48:02.612Z`
- Finished: `2026-05-13T22:48:02.612Z`
- Dry run: `false`
- Staging user ID: `not configured`
- Providers requested: `google, outlook`
- Providers run: `none`

## Prerequisites

- Status: **blocked**
- Missing: `STAGING=true or NODE_ENV=staging`, `TRAINING_CALENDAR_STAGING_SMOKE=1`, `TRAINING_CALENDAR_STAGING_ALLOW_LIVE_WRITES=1`, `TRAINING_CALENDAR_STAGING_USER_ID=<staging user id>`, `OAUTH_ENCRYPTION_KEY`, `DATABASE_PATH=<staging database path>`, `GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET`, `OUTLOOK_CLIENT_ID and OUTLOOK_CLIENT_SECRET`

## Operations

| Provider | Operation | Expected | Actual | Status | Event IDs | Cleanup |
| --- | --- | --- | --- | --- | --- | --- |
| google | prerequisites | All staging credentials and explicit live-write guardrails are present. | Blocked: STAGING=true or NODE_ENV=staging, TRAINING_CALENDAR_STAGING_SMOKE=1, TRAINING_CALENDAR_STAGING_ALLOW_LIVE_WRITES=1, TRAINING_CALENDAR_STAGING_USER_ID=<staging user id>, OAUTH_ENCRYPTION_KEY, DATABASE_PATH=<staging database path>, GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, OUTLOOK_CLIENT_ID and OUTLOOK_CLIENT_SECRET | blocked | - | not_needed |
| outlook | prerequisites | All staging credentials and explicit live-write guardrails are present. | Blocked: STAGING=true or NODE_ENV=staging, TRAINING_CALENDAR_STAGING_SMOKE=1, TRAINING_CALENDAR_STAGING_ALLOW_LIVE_WRITES=1, TRAINING_CALENDAR_STAGING_USER_ID=<staging user id>, OAUTH_ENCRYPTION_KEY, DATABASE_PATH=<staging database path>, GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, OUTLOOK_CLIENT_ID and OUTLOOK_CLIENT_SECRET | blocked | - | not_needed |

## Cleanup Failures

None.

## Interpretation

Real calendar staging validation was **not** run because prerequisites are missing. Do not treat this report as provider lifecycle proof.

