# Backend runtime fixes applied

## Fix 1: separate authenticated read rate limit from mutation/chat quota

Severity: P1

Root cause:

Authenticated iOS routes used a single per-user `60/minute` bucket for all protected requests. Real iOS navigation can legitimately issue many `GET` requests during initial bootstrap, rapid tab switching, Home refresh, Tasks refresh, Areas load, and Week/Semana open. Once exhausted, the backend returned `429` and the app could appear frozen or stuck loading.

Files changed:

- `src/api/rate-limiter.ts`
- `src/config.ts`
- `.env.example`
- `__tests__/api/rate-limiter.test.ts`

Implementation:

- Added `IOS_API_READ_RATE_LIMIT`, default `300`.
- Added a separate in-memory `userReadRequestLog` bucket.
- Routed authenticated `GET`/`HEAD` requests to `user-read`.
- Kept all other authenticated methods on the existing `user` bucket.
- Preserved unauthenticated/IP, internal, webhook, and internal AI route limit behavior.

Why it improves usability:

Read-heavy navigation can no longer starve the tighter mutation/chat budget. The app should see fewer false `429` loading failures during tab switching and Home/Week navigation.

Regression tests:

- `uses a higher separate bucket for authenticated GET navigation reads`
- `keeps authenticated GET bursts from consuming the tighter mutation/chat bucket`
- existing authenticated/IP/internal limiter tests still pass

Validation:

- Focused rate-limiter tests: 16/16 passed.
- App-facing API sample tests: 111/111 passed.
- TypeScript typecheck: passed.
- Local engine burst: 144 authenticated reads, 0 rate-limit responses.

## Fix 2: add Server-Timing dependency breakdowns for Home and Plan reads

Severity: P2

Root cause:

The backend had good local latency numbers, but staging and production did not expose which dependency dominated a slow iOS-facing read. Home and Week/Semana aggregate calendar, tasks, training, content, and daily/weekly planning state; without per-step timing, the next real-user latency report would still require guesswork.

Files changed:

- `src/api/route-timing.ts`
- `src/api/routes/dashboard.ts`
- `src/api/routes/plan.ts`
- `__tests__/api/dashboard-routes.test.ts`
- `__tests__/api/plan-routes.test.ts`

Implementation:

- Added a small `Server-Timing` helper.
- `/api/v1/dashboard` now reports `calendar`, `tasks`, `training`, and `content` timings on uncached reads.
- `/api/v1/dashboard/home` now reports `dashboard`, `daily_brief`, and `home_view_state` timings, plus nested dashboard section timings.
- `/api/v1/plan/week` now reports `weekly_plan`.
- `/api/v1/plan/today` now reports `daily_brief`.
- Cached dashboard reads emit `cache_hit`.

Why it improves usability:

This does not change payloads or product behavior. It gives staging/device validation enough evidence to distinguish backend dependency latency from iOS rendering, network, or animation latency.

Regression tests:

- Dashboard route test asserts uncached dashboard/home reads include the expected timing labels.
- Plan route test asserts `/week` and `/today` include planner timing labels.

Validation:

- TypeScript typecheck: passed.
- Focused dashboard + plan tests: 2 files / 30 tests passed.

## Fix 3: add private ETag validation to Skills catalog reads

Severity: P2

Root cause:

`/api/v1/skills/catalog` is a stable, deterministic, user-access-annotated payload around 9.2 KB. It was fast locally, but repeated Areas tab refreshes had to download and decode the full catalog every time.

Files changed:

- `src/api/routes/skills.ts`
- `__tests__/api/skills-routes.test.ts`

Implementation:

- Added `ETag` computed over the final per-user catalog payload.
- Added `Cache-Control: private, max-age=30`.
- Added `If-None-Match` handling that returns `304` with no body when the payload has not changed.
- Kept the existing success response shape unchanged for normal `200` reads.

Why it improves usability:

Repeated Areas/Skills refreshes can now avoid transferring and decoding the catalog when tier/override state has not changed. The validator remains private and user-specific, so it does not weaken skill entitlement or tenant boundaries.

Regression tests:

- `supports private ETag validation for repeated catalog reads`

Validation:

- TypeScript typecheck: passed.
- `npx vitest run __tests__/api/skills-routes.test.ts`: 21/21 passed.
