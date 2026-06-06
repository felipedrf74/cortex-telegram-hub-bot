# Home and Week runtime analysis

## Local baseline after fix

Measured against `http://127.0.0.1:8200` with fixture/model-safe routing and a local test user.

| Endpoint | Status | Latency | Payload | Rate-limit bucket |
| --- | ---: | ---: | ---: | --- |
| `/api/v1/dashboard/home` | 200 | 33.3 ms | 8003 bytes | `user-read` |
| `/api/v1/dashboard` | 200 | 3.2 ms | 1302 bytes | `user-read` |
| `/api/v1/plan/today` | 200 | 1.5 ms | 5680 bytes | `user-read` |
| `/api/v1/plan/week` | 200 | 1.6 ms | 7726 bytes | `user-read` |
| `/api/v1/tasks/lists` | 200 | 0.7 ms | 123 bytes | `user-read` |
| `/api/v1/tasks/filtered?filter=dueToday` | 200 | 0.7 ms | 94 bytes | `user-read` |
| `/api/v1/training/home` | 200 | 2.6 ms | 1968 bytes | `user-read` |
| `/api/v1/connections` | 200 | 1.2 ms | 2816 bytes | `user-read` |
| `/api/v1/skills/catalog` | 200 | 2.0 ms | 9213 bytes | `user-read` |

## Burst pattern

Synthetic burst:

- 12 endpoint probes
- 12 rounds
- 144 authenticated `GET` requests

Result after fix:

- 120 valid endpoint responses returned `200`
- 24 invalid probe paths returned `404`
- 0 responses returned `429`
- all authenticated reads used `X-RateLimit-Bucket: user-read`

The invalid paths were `/api/v1/settings/profile` and `/api/v1/inbox/summary`; they were measurement mistakes and are not counted as product failures.

## Before/after interpretation

Before the fix, the same style of rapid protected-route read burst exhausted the authenticated 60/minute bucket. After the fix, read-heavy navigation does not consume mutation/chat quota and has a default 300/minute budget.

This is likely to reduce false “loading forever” states during rapid Home, Week/Semana, and tab navigation.

## Staging timing after `4.14.114`

Staging was aligned to `4.14.114` and passed the standard 17/17 staging smoke before this timing capture. The capture used a staging-only invite/device and sampled each app-facing route 25 times with an iOS-like bearer request.

| Endpoint | Statuses | Rate bucket | Total p50 | Total p95 | Max | Notable `Server-Timing` |
| --- | ---: | --- | ---: | ---: | ---: | --- |
| `/api/v1/dashboard/home` | 25/25 `200` | `user-read` | 2.0 ms | 2.6 ms | 77.6 ms | cold sample: `training=56.1`, `dashboard=57.5`, `daily_brief=68.4`, `home_view_state=3.7` |
| `/api/v1/plan/today` | 25/25 `200` | `user-read` | 1.9 ms | 2.5 ms | 2.8 ms | `daily_brief` p95 0.3 ms |
| `/api/v1/plan/week` | 25/25 `200` | `user-read` | 1.9 ms | 2.4 ms | 2.7 ms | `weekly_plan` p95 0.4 ms |

Interpretation: backend staging read latency for Home and Week/Semana is healthy after cache warm-up. If physical iPhone tab switching still feels multi-second slow, the next investigation should correlate iOS request cadence/render work with these backend timings rather than assuming the route itself is slow.
