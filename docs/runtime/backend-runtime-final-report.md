# Backend/runtime QA and usability performance report

## Executive summary

Verdict: PASS WITH CONDITIONS

Biggest root cause: authenticated iOS read traffic shared the same 60/minute quota as mutations and chat/model-triggering requests.

Biggest fix: split authenticated `GET`/`HEAD` requests into a separate `user-read` bucket with default `IOS_API_READ_RATE_LIMIT=300`, while preserving the existing tighter mutation/chat bucket.

Remaining risk: iOS interaction validation still needs to confirm the perceived app improvement on a physical device. Staging p95 validation is now captured for Home and Plan reads and does not show a multi-second backend bottleneck.

Backend/runtime likely contributed to iOS lag: yes, especially when repeated navigation caused read bursts to hit `429`.

## Execution behavior

The pass prioritized the confirmed P1 user-facing runtime issue before lower-priority docs and polish. No task was skipped because it was difficult.

## Branch and backup

Repo: `/tmp/nexus-backend-runtime-ios-audit`

Branch: `feature/backend-runtime-ios-usability-performance-audit`

Base commit: `53f580a chore: bump version to 4.14.112 [deploy]`

Backup branch/tag: `backup/backend-runtime-ios-usability-before-audit-20260502-0218`

Primary backend repo was dirty before work, so changes were made in a clean worktree.

## Local engine

Startup:

```bash
NEXUS_LOCAL_ALLOW_MODEL_CALLS=0 scripts/full-nexus-local-engine.sh up
```

Local fixture/provider mode was active. No production data, production calendars, or real provider/model calls were used.

Authenticated local smoke passed 13/13.

## iOS-facing endpoint inventory

Measured local reads after fix:

- Home: `/api/v1/dashboard/home`, 200, 33.3 ms, 8003 bytes
- Dashboard shell: `/api/v1/dashboard`, 200, 3.2 ms, 1302 bytes
- Week/Semana: `/api/v1/plan/week`, 200, 1.6 ms, 7726 bytes
- Plan today: `/api/v1/plan/today`, 200, 1.5 ms, 5680 bytes
- Tasks: `/api/v1/tasks/lists`, 200, 0.7 ms
- Tasks due today: `/api/v1/tasks/filtered?filter=dueToday`, 200, 0.7 ms
- Training: `/api/v1/training/home`, 200, 2.6 ms
- Connections: `/api/v1/connections`, 200, 1.2 ms
- Areas/Skills: `/api/v1/skills/catalog`, 200, 2.0 ms, 9213 bytes
- Areas/Skills repeated reads: `/api/v1/skills/catalog` now supports private `ETag`/`If-None-Match` and can return `304` when the per-user catalog payload is unchanged.

No model/provider calls were observed on simple navigation reads in fixture mode.

## Root causes found

Cause: read-heavy navigation could exhaust shared authenticated quota.

Affected service: `src/api/rate-limiter.ts`

Evidence: synthetic rapid read baseline previously hit `429` near 60 authenticated requests/minute. After the fix, a 144-request read burst returned 0 rate-limit responses.

User impact: app tabs and Week/Semana can appear frozen or unresponsive when backend returns `429` during normal read refreshes.

Severity: P1.

## Fixes implemented

Files:

- `src/api/rate-limiter.ts`
- `src/config.ts`
- `.env.example`
- `src/api/routes/skills.ts`
- `__tests__/api/rate-limiter.test.ts`
- `__tests__/api/skills-routes.test.ts`

Summary:

- Added `IOS_API_READ_RATE_LIMIT`.
- Added separate authenticated read bucket.
- Preserved mutation/chat, unauthenticated, internal, webhook, and internal-AI rate limits.
- Added regression tests for read bursts and bucket independence.
- Added private ETag validation for the stable Skills catalog response.

## Runtime performance evidence

After fix:

- 144 authenticated read probes
- 0 `429` responses
- valid endpoints returned `200`
- authenticated read responses exposed `X-RateLimit-Bucket: user-read`
- follow-up POST used `X-RateLimit-Bucket: user`, proving separate buckets

## Cross-skill/shared-context findings

No confirmed model/provider calls during simple navigation reads in local fixture mode.

Remaining follow-up:

- Correlate physical-device Areas tab request cadence. iOS now sends `If-None-Match` for repeated Skills catalog reads and keeps cached catalog data on backend `304`.

## iOS contract findings

The backend now exposes separate read rate-limit metadata. iOS already maps 429 responses to `NexusError.rateLimited(retryAfter:)`; the latest iOS follow-up also turns slow first-load Tasks warmup into a retryable unavailable state after the grace window.

## Tests and smoke

Focused results:

- `npx tsc --noEmit`: passed
- `__tests__/api/rate-limiter.test.ts`: 16/16 passed
- `__tests__/api/skills-routes.test.ts`: 21/21 passed
- app-facing route focused sample: 8 files / 111 tests passed
- local authenticated API smoke: 13/13 passed
- full `npm run verify`: 429 files / 6447 tests passed
- dashboard + plan timing focused tests: 2 files / 30 tests passed

## iOS interaction correlation

iOS was not launched in this backend-only pass. The backend evidence supports a likely improvement, but final perceived responsiveness must be validated by running the iOS app against this backend build and by staging/physical-device testing.

## Open items

P0: none.

P1: none confirmed after this fix.

P2:

- correlate physical-device iOS navigation latency with backend request counts and the new Home/Plan `Server-Timing` headers.
- physical-device Areas tab cadence should still be checked, but iOS conditional Skills catalog reads are in place.

P3:

- historical migration prefix warnings.

## Next priority

Run iOS against this backend branch in local/staging mode and repeat:

- 10x bottom tab switching
- 5x Home to Week/Semana open/close
- Tasks load
- Chat open
- Areas open

Correlate perceived latency with backend request counts, status codes, and p95 route timings.

## Final verdict

PASS WITH CONDITIONS

The confirmed backend/runtime P1 was fixed and tested without weakening tenant/security or model routing. Production is running `4.14.114`, staging is aligned to `4.14.114`, staging smoke passed 17/17, and authenticated staging timing for Home/Plan reads is healthy. Remaining release confidence depends on iOS interaction correlation on a physical device.
