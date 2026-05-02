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

