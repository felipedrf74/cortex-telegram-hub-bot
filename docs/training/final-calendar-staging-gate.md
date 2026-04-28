# Final Training Calendar Staging Gate

Updated: 2026-04-28
Branch: `release/training-engine-production-hardening`
Result: **PASS**

## Executive Summary

The final Training calendar lifecycle staging gate passed for both Google Calendar and Outlook Calendar using real staging integrations and read-back verification.

No production calendars were used. Every smoke event was created under explicit staging-only guardrails, read back from the provider, updated/regenerated according to identity semantics, deleted by exact event ID, and confirmed absent after cleanup.

## Commands Run

Google:

```bash
STAGING=true \
NODE_ENV=staging \
TRAINING_CALENDAR_STAGING_SMOKE=1 \
TRAINING_CALENDAR_STAGING_ALLOW_LIVE_WRITES=1 \
TRAINING_CALENDAR_STAGING_USER_ID=1 \
TRAINING_CALENDAR_STAGING_PROVIDERS=google \
TRAINING_CALENDAR_STAGING_RESULTS_PATH=docs/training/final-calendar-staging-results-google.md \
node dist/tools/training-calendar-staging-smoke.js
```

Outlook:

```bash
STAGING=true \
NODE_ENV=staging \
TRAINING_CALENDAR_STAGING_SMOKE=1 \
TRAINING_CALENDAR_STAGING_ALLOW_LIVE_WRITES=1 \
TRAINING_CALENDAR_STAGING_USER_ID=1 \
TRAINING_CALENDAR_STAGING_PROVIDERS=outlook \
TRAINING_CALENDAR_STAGING_RESULTS_PATH=docs/training/final-calendar-staging-results-outlook.md \
node dist/tools/training-calendar-staging-smoke.js
```

## Safety Outcome

- Production calendars used: **no**
- Staging calendars written: **yes, explicit staging smoke only**
- Broad date-range deletion used: **no**
- Title/date-only matching used for cleanup: **no**
- Cleanup failures: **none**
- Google run ID: `training-calendar-smoke-20260428165035-7ljwng`
- Outlook run ID: `training-calendar-smoke-20260428165107-7fsbbr`

## Provider Coverage

For both Google and Outlook:

- `create_plan`: passed with read-back event ID.
- `sync_update_time`: passed with same event ID and no duplicate.
- `regenerate_same_shape`: passed with same logical event behavior.
- `regenerate_changed_shape_create_replacement`: passed with replacement event ID.
- `regenerate_changed_shape_delete_old`: passed with old event absent on read-back.
- `retry_sync_no_duplicate`: passed with exactly one active current run event.
- `replace_plan_create_new`: passed with distinct replacement plan identity.
- `cancel_plan_delete_current`: passed with event absent on read-back.
- `replace_plan_delete_old_scope`: passed with precise cleanup.
- `Cleanup Failures`: `None`.

## Harness Fixes Applied

The first live execution exposed a smoke-harness bootstrap bug: runtime services were loaded without calling `initDatabase()`, producing `Database not initialized. Call initDatabase() first.` before provider writes.

Fix:

- `src/tools/training-calendar-staging-smoke.ts` now initializes the runtime database before loading `unified-calendar` and `oauth-store`.

Validation:

- `npx tsc --noEmit` passed.
- `npx vitest run __tests__/tools/training-calendar-staging-smoke.test.ts __tests__/tools/training-cross-skill-staging-smoke.test.ts __tests__/tools/training-cross-skill-staging-fixtures.test.ts` passed: 22 tests.
- Staging deploy rebuilt and restarted staging services before the final provider runs.

## Notes

The provider read-back path uses the unified calendar reader. Because the staging user has both Google and Outlook connected, Google-only reads may still initialize Outlook token-refresh logging. This is noisy but did not cause lifecycle failure or stale cleanup.

## Gate Decision

Calendar lifecycle staging gate: **GO / PASS**.
