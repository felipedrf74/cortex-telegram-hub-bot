# Training Calendar Staging Smoke Results

- Run ID: `training-calendar-smoke-20260522094451-56acw8`
- Started: `2026-05-22T09:44:51.494Z`
- Finished: `2026-05-22T09:44:51.495Z`
- Dry run: `false`
- Staging user ID: `1000013`
- Providers requested: `outlook`
- Providers run: `none`

## Prerequisites

- Status: **ready**

## Operations

| Provider | Operation | Expected | Actual | Status | Event IDs | Cleanup |
| --- | --- | --- | --- | --- | --- | --- |
| outlook | provider_connection | outlook OAuth tokens exist for the staging smoke user. | outlook is not connected for user 1000013. | blocked | - | not_needed |

## Cleanup Failures

None.

## Interpretation

Calendar staging validation is partially blocked. See the operation table for the exact provider/prerequisite gap.

