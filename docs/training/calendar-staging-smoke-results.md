# Training Calendar Staging Smoke Results

- Run ID: `training-calendar-smoke-20260428124302-69m2w3`
- Started: `2026-04-28T12:43:02.450Z`
- Finished: `2026-04-28T12:43:02.450Z`
- Dry run: `true`
- Staging user ID: `not configured`
- Providers requested: `google, outlook`
- Providers run: `none`

## Prerequisites

- Status: **blocked**
- Missing: `STAGING=true or NODE_ENV=staging`, `TRAINING_CALENDAR_STAGING_SMOKE=1`, `TRAINING_CALENDAR_STAGING_ALLOW_LIVE_WRITES=1`, `TRAINING_CALENDAR_STAGING_USER_ID=<staging user id>`, `OAUTH_ENCRYPTION_KEY`, `DATABASE_PATH=<staging database path>`, `GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET`, `OUTLOOK_CLIENT_ID and OUTLOOK_CLIENT_SECRET`

## Operations

| Provider | Operation | Expected | Actual | Status | Event IDs | Cleanup |
| --- | --- | --- | --- | --- | --- | --- |
| google | dry_run | All staging credentials and explicit live-write guardrails are present. | Blocked: dry run requested; no provider writes attempted. | blocked | - | not_needed |
| outlook | dry_run | All staging credentials and explicit live-write guardrails are present. | Blocked: dry run requested; no provider writes attempted. | blocked | - | not_needed |

## Cleanup Failures

None.

## Interpretation

Real calendar staging validation was **not** run because this was a dry run. No provider write/read-back/delete proof exists from this run.

