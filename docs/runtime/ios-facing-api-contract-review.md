# iOS-facing API contract review

## Route contract summary

The iOS API is mounted under `/api/v1`. Public auth routes are rate limited before JWT auth; protected routes run:

1. `authMiddleware`
2. `rateLimitMiddleware`
3. `requestTimerMiddleware`
4. per-request AsyncLocalStorage user context
5. route handlers

The route comments explicitly preserve token-zero behavior: data lookups go through REST routes, while chat is the only route allowed to touch the AI pipeline.

## App-facing endpoint inventory

| Section | Endpoint examples | Local result | Notes |
| --- | --- | --- | --- |
| Home | `GET /api/v1/dashboard/home`, `GET /api/v1/dashboard` | Fast locally | Aggregated response; no model call observed in fixture mode. |
| Week/Semana | `GET /api/v1/plan/week`, `GET /api/v1/plan/today` | Fast locally | Should stay read-only and not block on provider calendar sync. |
| Tasks | `GET /api/v1/tasks/lists`, `GET /api/v1/tasks/filtered` | Fast locally | Needs continued iOS retry/backoff sanity after read-limit fix. |
| Chat | `POST /api/v1/chat`, `GET /api/v1/chat/history` | Not performance-smoked in this pass | Chat remains the correct AI pipeline boundary. |
| Areas | `GET /api/v1/skills/catalog` | Fast locally, ~9.2 KB | Consider ETag if fetched often. |
| More | `GET /api/v1/connections`, `GET /api/v1/settings/status`, settings routes | Connections fast locally | The audit probe used two invalid paths and excluded them from pass counts. |
| Training | `GET /api/v1/training/home`, `GET /api/v1/training/today`, `GET /api/v1/training/week` | Fast locally | Calendar sync remains a separate write/sync concern. |
| Cooking | `GET /api/v1/cooking/*` | Auth smoke passed | Entitlement-gated. |
| Finance | `GET /api/v1/finance/monthly-summary` | Auth smoke passed | Entitlement-gated. |
| Content | `GET /api/v1/content/home`, `GET /api/v1/content/pipeline` | Auth smoke passed | Content generation routes are separate POSTs. |

## Contract findings

### Fixed

Authenticated read traffic now exposes:

- `X-RateLimit-Bucket: user-read`
- `X-RateLimit-Limit: 300` by default

This gives iOS a safer budget for tab navigation and repeated read refreshes.

### Open follow-ups

- iOS should avoid treating `429` as a generic long-loading state; it should surface retry/backoff where possible.
- Add endpoint dependency timing to make slow fan-out visible in staging logs.
- Consider ETags or `If-None-Match` for stable read surfaces such as Skills catalog and Settings.

