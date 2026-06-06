# Final Training Calendar Staging Gate

Updated: 2026-04-28  
Branch: `release/training-engine-production-hardening`  
Run ID: `training-calendar-smoke-20260428094430-r9cyiu`  
Result: **NO-GO / BLOCKED**

## Executive Summary

The final Training calendar lifecycle staging gate did **not** pass.

The real staging smoke harness was executed, but the process stopped at prerequisite validation because this shell has no staging env file and none of the required staging/calendar variables are configured. No provider writes were attempted, no provider reads were attempted, and no cleanup was needed.

This is the correct safe behavior. The gate remains a release blocker until Google and Outlook are either:

1. validated against real staging calendars with read-back and precise cleanup; or
2. explicitly waived by provider with owner approval.

## Command Run

```bash
TRAINING_CALENDAR_STAGING_RESULTS_PATH=docs/training/final-calendar-staging-results.md \
npm run smoke:training-calendar:staging
```

The command built the backend first, then executed `dist/tools/training-calendar-staging-smoke.js`.

## Safety Outcome

- Production calendars used: **no**
- Staging calendars written: **no**
- Broad date-range deletion used: **no**
- Unrelated events deleted: **no**
- Cleanup failures: **none**

The harness did not load the runtime calendar client because prerequisites were not satisfied.

## Missing Prerequisites

The final run reported these missing requirements:

- `STAGING=true` or `NODE_ENV=staging`
- `TRAINING_CALENDAR_STAGING_SMOKE=1`
- `TRAINING_CALENDAR_STAGING_ALLOW_LIVE_WRITES=1`
- `TRAINING_CALENDAR_STAGING_USER_ID=<staging user id>`
- `OAUTH_ENCRYPTION_KEY`
- `DATABASE_PATH=<staging database path>`
- `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`
- `OUTLOOK_CLIENT_ID` and `OUTLOOK_CLIENT_SECRET`

The local environment check also found no `.env`, `.env.staging`, `staging.env`, or `*staging*.env` file inside the backend repo search depth used for this gate.

## Gate Coverage Intended By Harness

The existing smoke harness is designed to validate, per provider:

- create Training plan event;
- read-back by event ID;
- update/reflow event time/title;
- same-shape regeneration update behavior;
- changed-shape regeneration replacement behavior;
- cancellation deletion;
- replacement-plan identity separation;
- retry/no-duplicate behavior;
- precise cleanup by exact event IDs created in the run.

It also marks every smoke event with:

- `[NEXUS TRAINING STAGING]` title prefix;
- unique run ID;
- synthetic plan ID;
- plan version;
- synthetic session ID;
- session identity key;
- session shape hash;
- `NEXUS_TRAINING_IDENTITY` description marker.

## Release Decision

Calendar lifecycle staging gate: **NO-GO**.

Backend unit/contract tests can prove local logic, but they do not replace real provider read-back. Production release must not claim final calendar lifecycle confidence until this gate passes against staging Google and Outlook calendars or the missing provider is explicitly waived.

## Rerun Command Once Credentials Exist

```bash
npm run build
TRAINING_CALENDAR_STAGING_ENV_FILE=/path/to/staging.env \
TRAINING_CALENDAR_STAGING_SMOKE=1 \
TRAINING_CALENDAR_STAGING_ALLOW_LIVE_WRITES=1 \
TRAINING_CALENDAR_STAGING_USER_ID=<staging-user-id> \
TRAINING_CALENDAR_STAGING_PROVIDERS=google,outlook \
TRAINING_CALENDAR_STAGING_RESULTS_PATH=docs/training/final-calendar-staging-results.md \
node dist/tools/training-calendar-staging-smoke.js
```

The staging user must have fresh Google and Outlook OAuth tokens in the staging database.
