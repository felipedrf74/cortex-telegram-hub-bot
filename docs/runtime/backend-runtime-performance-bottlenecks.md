# Backend runtime performance bottlenecks

## P1 fixed: shared authenticated rate limit throttled read-heavy navigation

Evidence:

- Before the fix, repeated authenticated `GET` navigation probes started receiving `429` after roughly 60 protected requests/minute.
- The app-facing route handlers were locally fast, but the shared quota made read bursts compete with write/chat quota.
- This matches user symptoms where tab switching or opening Week/Semana feels frozen after repeated navigation.

Impact:

- Home / Tasks / Areas / More / Week can all be affected.
- The app may show loading/error states even though no specific endpoint is slow.
- Users may retry buttons and produce more requests, worsening the loop.

Fix:

- Added a separate authenticated read bucket for `GET`/`HEAD`.
- Kept mutation/chat/model-triggering calls on the existing tighter bucket.

## P2 fixed: Home and Plan reads now expose dependency timing

Local single-request latency was acceptable, but Home/Plan read paths still aggregate several pieces of state synchronously. The routes now emit `Server-Timing` headers so staging and production-safe checks can identify the slow dependency instead of treating the screen as a single opaque request.

Implemented:

- `/api/v1/dashboard`: `calendar`, `tasks`, `training`, `content`
- `/api/v1/dashboard/home`: `dashboard`, `daily_brief`, `home_view_state`, plus nested dashboard section timings
- `/api/v1/plan/today`: `daily_brief`
- `/api/v1/plan/week`: `weekly_plan`

Remaining next action:

- Capture staging/device p50/p95 for `/api/v1/dashboard/home`, `/api/v1/plan/today`, and `/api/v1/plan/week` after this build is deployed.

## P2 open: Skills catalog payload is larger than most app bootstrap calls

Measured local payload:

- `/api/v1/skills/catalog`: about 9.2 KB

This is not currently large enough to explain multi-second UI freezes, but it is a good candidate for ETag or short-lived authenticated read caching if the app refreshes it on tab switches.

Recommended next action:

- Confirm iOS request frequency for Skills/Areas.
- Add `updatedAt`/ETag support if the app re-fetches the catalog repeatedly.

## P3 open: local migration prefix warnings

Local startup emits migration-prefix collision warnings for historical files. This did not block runtime validation, but it adds noise to release diagnostics.

Recommended next action:

- Track as release-process cleanup; do not rename historical migrations without a dedicated migration audit.
