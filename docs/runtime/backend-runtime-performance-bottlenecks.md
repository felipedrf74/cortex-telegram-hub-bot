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

Staging evidence after deploying `4.14.114`:

- Generic staging smoke passed 17/17.
- Authenticated staging timing capture sampled each route 25 times with an iOS-like bearer request.
- `/api/v1/dashboard/home`: 25/25 `200`, total p50 2.0 ms, p95 2.6 ms, max 77.6 ms. Cold-path `Server-Timing` sample showed `training;dur=56.1`, `dashboard;dur=57.5`, `daily_brief;dur=68.4`, and `home_view_state;dur=3.7`.
- `/api/v1/plan/today`: 25/25 `200`, total p50 1.9 ms, p95 2.5 ms, max 2.8 ms. `daily_brief` p95 was 0.3 ms.
- `/api/v1/plan/week`: 25/25 `200`, total p50 1.9 ms, p95 2.4 ms, max 2.7 ms. `weekly_plan` p95 was 0.4 ms.

Remaining next action:

- Correlate physical-device iOS navigation latency with request timing. The backend staging p95 for these read paths is now too low to explain multi-second tab lag by itself.

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
