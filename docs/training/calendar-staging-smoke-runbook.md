# Training Calendar Staging Smoke Runbook

## Purpose

This smoke verifies the Training calendar lifecycle against real Google Calendar and Outlook staging integrations. It is intentionally separate from normal CI because it performs live provider writes.

## Audit Summary

Before adding the harness, the relevant calendar paths were audited:

- Google writes go through `src/services/google-calendar.ts` via `events.insert`, `events.patch`, `events.delete`, and `events.list`.
- Outlook writes go through `src/services/outlook-calendar.ts` via Microsoft Graph `/me/events`, `/me/events/{id}`, and `/me/calendarView`.
- Training calendar writes flow through `src/services/unified-calendar.ts` and `src/api/routes/training-calendar-event-writer.ts`.
- Training backfill/sync currently lives in `src/api/routes/training-plan-calendar-sync.ts` and relies on `NEXUS_TRAINING_IDENTITY` markers plus `training_agenda_event_ownership`.
- Cancellation cleanup lives in `src/api/routes/training-plan-cancellation.ts`; current safe behavior is ownership/marker based, not broad title/date cleanup.
- OAuth connection truth comes from `src/services/oauth-store.ts`; the smoke requires a staging user with fresh per-user OAuth tokens.

The harness covers:

- Google create, update, same-shape regeneration, changed-shape replacement, cancel/delete, replacement cleanup, and retry/no-duplicate read-back.
- Outlook create, update, same-shape regeneration, changed-shape replacement, cancel/delete, replacement cleanup, and retry/no-duplicate read-back.
- Read-back after each provider write.
- Precise cleanup by the exact event IDs created by the run.

## Safety Guardrails

The smoke refuses live writes unless all of these are present:

- `STAGING=true` or `NODE_ENV=staging`
- `TRAINING_CALENDAR_STAGING_SMOKE=1`
- `TRAINING_CALENDAR_STAGING_ALLOW_LIVE_WRITES=1`
- `TRAINING_CALENDAR_STAGING_USER_ID=<staging user id>`
- `OAUTH_ENCRYPTION_KEY`
- `DATABASE_PATH=<staging database path>`
- Provider OAuth app credentials for the requested provider(s)

`DATABASE_PATH` must look like a staging/test database path unless `TRAINING_CALENDAR_STAGING_ALLOW_NON_STAGING_DB=1` is set explicitly. Do not set that override for production data.

Every event created by the smoke includes:

- Title prefix: `[NEXUS TRAINING STAGING]`
- Unique run ID
- Synthetic plan ID
- Plan version
- Synthetic session ID
- Session identity key
- Session shape hash
- `NEXUS_TRAINING_IDENTITY` marker in the event description

Cleanup never scans broad date ranges and deletes by title alone. The normal cleanup path deletes only event IDs created by the current smoke run. If the process crashes, use provider event IDs from the result report for manual cleanup.

## Command

From the backend repo:

```bash
npm run build
TRAINING_CALENDAR_STAGING_ENV_FILE=/path/to/staging.env \
TRAINING_CALENDAR_STAGING_SMOKE=1 \
TRAINING_CALENDAR_STAGING_ALLOW_LIVE_WRITES=1 \
TRAINING_CALENDAR_STAGING_USER_ID=<staging-user-id> \
TRAINING_CALENDAR_STAGING_PROVIDERS=google,outlook \
TRAINING_CALENDAR_STAGING_RESULTS_PATH=docs/training/calendar-staging-smoke-results.md \
node dist/tools/training-calendar-staging-smoke.js
```

Or:

```bash
TRAINING_CALENDAR_STAGING_ENV_FILE=/path/to/staging.env \
TRAINING_CALENDAR_STAGING_SMOKE=1 \
TRAINING_CALENDAR_STAGING_ALLOW_LIVE_WRITES=1 \
TRAINING_CALENDAR_STAGING_USER_ID=<staging-user-id> \
TRAINING_CALENDAR_STAGING_PROVIDERS=google,outlook \
scripts/training-calendar-staging-smoke.sh
```

Dry run:

```bash
scripts/training-calendar-staging-smoke.sh --dry-run
```

## Required Staging Account Setup

The selected `TRAINING_CALENDAR_STAGING_USER_ID` must have fresh per-user OAuth tokens stored in `user_oauth_tokens` for each provider being tested:

- `provider='google'` for Google Calendar
- `provider='outlook'` for Outlook Calendar

The provider OAuth apps must have calendar read/write scopes:

- Google: Calendar events read/write scope via the configured Google OAuth app.
- Outlook: Microsoft Graph `Calendars.ReadWrite`.

## Expected Result

The report should show `pass` for each provider operation:

- `create_plan`
- `sync_update_time`
- `regenerate_same_shape`
- `regenerate_changed_shape_create_replacement`
- `regenerate_changed_shape_delete_old`
- `retry_sync_no_duplicate`
- `replace_plan_create_new`
- `cancel_plan_delete_current`
- `replace_plan_delete_old_scope`

`Cleanup Failures` must be `None`.

## Failure Handling

If cleanup fails, the report lists exact provider event IDs. Do not run a broad cleanup by date/title. Delete only the reported event IDs or rerun with a provider-specific cleanup script that verifies the smoke run ID and `NEXUS_TRAINING_IDENTITY` marker before deleting.

If the smoke is blocked, fix the missing prerequisites listed in `docs/training/calendar-staging-smoke-results.md` and rerun.
