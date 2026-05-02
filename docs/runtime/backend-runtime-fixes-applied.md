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

