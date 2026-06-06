# Training Calendar Staging Smoke Results

Final gate status: **BLOCKED / NO-GO**.

The staging smoke harness was executed, but it stopped at prerequisite validation. No Google, Outlook, or internal agenda lifecycle operation was run, and no calendar writes/deletes were attempted.

- Run ID: `training-calendar-smoke-20260428094430-r9cyiu`
- Started: `2026-04-28T09:44:30.576Z`
- Finished: `2026-04-28T09:44:30.576Z`
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

## Final Gate Scenario Matrix

Because prerequisites were missing, every lifecycle scenario remains blocked rather than passed.

| Provider / Layer | Scenario | Expected Result | Actual Result | Pass / Fail | Event IDs | Cleanup Status | Evidence | Blocker Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Google Calendar | create plan | Staging Training events are created and found by read-back. | Not run; staging prerequisites missing. | blocked | - | not_needed | Run `training-calendar-smoke-20260428094430-r9cyiu` | release blocker unless Google is explicitly waived |
| Google Calendar | update / reflow one session | Existing event updates in place with no duplicate. | Not run; staging prerequisites missing. | blocked | - | not_needed | Run `training-calendar-smoke-20260428094430-r9cyiu` | release blocker unless Google is explicitly waived |
| Google Calendar | regenerate same shape | Same logical session reuses/update event identity. | Not run; staging prerequisites missing. | blocked | - | not_needed | Run `training-calendar-smoke-20260428094430-r9cyiu` | release blocker unless Google is explicitly waived |
| Google Calendar | regenerate changed shape | Replacement event is created and old owned event is precisely removed. | Not run; staging prerequisites missing. | blocked | - | not_needed | Run `training-calendar-smoke-20260428094430-r9cyiu` | release blocker unless Google is explicitly waived |
| Google Calendar | cancel plan | Owned staging events are deleted and absent on read-back. | Not run; staging prerequisites missing. | blocked | - | not_needed | Run `training-calendar-smoke-20260428094430-r9cyiu` | release blocker unless Google is explicitly waived |
| Google Calendar | replace plan | Old plan events are removed; new plan events exist with distinct identity. | Not run; staging prerequisites missing. | blocked | - | not_needed | Run `training-calendar-smoke-20260428094430-r9cyiu` | release blocker unless Google is explicitly waived |
| Google Calendar | retry sync | Retry does not duplicate events. | Not run; staging prerequisites missing. | blocked | - | not_needed | Run `training-calendar-smoke-20260428094430-r9cyiu` | release blocker unless Google is explicitly waived |
| Outlook Calendar | create plan | Staging Training events are created and found by read-back. | Not run; staging prerequisites missing. | blocked | - | not_needed | Run `training-calendar-smoke-20260428094430-r9cyiu` | release blocker unless Outlook is explicitly waived |
| Outlook Calendar | update / reflow one session | Existing event updates in place with no duplicate. | Not run; staging prerequisites missing. | blocked | - | not_needed | Run `training-calendar-smoke-20260428094430-r9cyiu` | release blocker unless Outlook is explicitly waived |
| Outlook Calendar | regenerate same shape | Same logical session reuses/update event identity. | Not run; staging prerequisites missing. | blocked | - | not_needed | Run `training-calendar-smoke-20260428094430-r9cyiu` | release blocker unless Outlook is explicitly waived |
| Outlook Calendar | regenerate changed shape | Replacement event is created and old owned event is precisely removed. | Not run; staging prerequisites missing. | blocked | - | not_needed | Run `training-calendar-smoke-20260428094430-r9cyiu` | release blocker unless Outlook is explicitly waived |
| Outlook Calendar | cancel plan | Owned staging events are deleted and absent on read-back. | Not run; staging prerequisites missing. | blocked | - | not_needed | Run `training-calendar-smoke-20260428094430-r9cyiu` | release blocker unless Outlook is explicitly waived |
| Outlook Calendar | replace plan | Old plan events are removed; new plan events exist with distinct identity. | Not run; staging prerequisites missing. | blocked | - | not_needed | Run `training-calendar-smoke-20260428094430-r9cyiu` | release blocker unless Outlook is explicitly waived |
| Outlook Calendar | retry sync | Retry does not duplicate events. | Not run; staging prerequisites missing. | blocked | - | not_needed | Run `training-calendar-smoke-20260428094430-r9cyiu` | release blocker unless Outlook is explicitly waived |
| Internal agenda layer | active/cancelled/superseded state | Staging DB records plan lifecycle and ownership mappings correctly. | Not run; staging database/user prerequisites missing. | blocked | - | not_needed | Missing `DATABASE_PATH` and `TRAINING_CALENDAR_STAGING_USER_ID` | release blocker |
| Internal agenda layer | ownership mapping / stale prevention | Ownership rows map exact plan/version/session/event IDs; stale events do not remain active. | Not run; staging database/user prerequisites missing. | blocked | - | not_needed | Missing `DATABASE_PATH` and staging user | release blocker |
| Failure handling | partial sync / provider error / retry / cleanup failure | Failures are visible, retry-safe, and precise cleanup reports exact event IDs. | Not run; provider clients were not loaded. | blocked | - | not_needed | Prerequisite block prevented provider writes | release blocker until staged or explicitly waived |
