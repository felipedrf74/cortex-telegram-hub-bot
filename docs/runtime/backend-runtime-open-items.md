# Backend runtime open items

## P0

None found in this backend/runtime pass.

## P1

None left as confirmed, safe, scoped backend fixes in this pass after the read-rate-limit fix.

## P2

### RT-P2-1: capture staging p50/p95 for Home and Plan read timings

Status: closed for backend staging evidence on 2026-05-02.

Evidence:

- Staging was aligned to `4.14.114`.
- Generic staging smoke passed 17/17.
- Authenticated timing capture used a staging-only invite/device and sampled each route 25 times.
- `/api/v1/dashboard/home`: 25/25 `200`, `user-read`, total p50 2.0 ms, p95 2.6 ms, max 77.6 ms.
- `/api/v1/plan/today`: 25/25 `200`, `user-read`, total p50 1.9 ms, p95 2.5 ms, max 2.8 ms.
- `/api/v1/plan/week`: 25/25 `200`, `user-read`, total p50 1.9 ms, p95 2.4 ms, max 2.7 ms.

Follow-up:

- Correlate these backend timings with physical-device iOS navigation latency. Backend staging p95 no longer points to a multi-second server bottleneck on these reads.

### RT-P2-2: add private ETag support for stable Skills catalog reads

Status: closed in code on 2026-05-02.

Evidence:

- `/api/v1/skills/catalog` now returns `ETag` and `Cache-Control: private, max-age=30`.
- Matching `If-None-Match` returns `304` with no response body.
- The ETag is computed from the per-user catalog payload, preserving tier/override-specific access truth.
- Focused regression test passed: `npx vitest run __tests__/api/skills-routes.test.ts` (21/21).

Follow-up:

- Correlate physical-device Areas tab request cadence. Backend now supports conditional reads, but iOS still needs to send `If-None-Match` to realize the payload savings.

### RT-P2-3: iOS retry/backoff for `429`

Status: closed in iOS on 2026-05-02.

Evidence:

- iOS `NexusHTTPClient` maps HTTP 429 responses to `NexusError.rateLimited(retryAfter:)`.
- `NexusHTTPClientTests` pins both JSON-body `retryAfter` and `Retry-After` header precedence.
- The Tasks workspace now escapes first-load warmup after the three-second grace window and shows a retryable unavailable state instead of an indefinite loader.
- Focused iOS validation passed on `main` at `b5fc073`: `TasksWorkspaceStateResolverTests` + `NavigationPerformanceSourcePinsTests` (16/16).

## P3

### RT-P3-1: historical migration prefix warnings

Status: closed in code on 2026-05-02.

Evidence:

- The migration runner now suppresses only the five known historical duplicate-prefix groups: `008`, `009`, `022`, `023`, and `024`.
- The guardrail remains active for any new duplicate numeric prefix, and also warns if one of the historical groups gains another unexpected file.
- Focused regression test passed: `npx vitest run __tests__/services/database-migration-prefix-collisions.test.ts` (3/3).
