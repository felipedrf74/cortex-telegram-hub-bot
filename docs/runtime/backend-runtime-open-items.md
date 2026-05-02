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

### RT-P2-2: evaluate ETag/short-lived cache for stable read surfaces

`/api/v1/skills/catalog` measured about 9.2 KB locally. If iOS fetches it frequently during Areas/tab navigation, add ETag or a short-lived authenticated cache.

Next action:

- Correlate iOS request cadence.
- Add conditional GET if repeated fetches are confirmed.

### RT-P2-3: iOS retry/backoff for `429`

The backend fix reduces false rate limits, but iOS should still render explicit retry/backoff instead of a generic loading state for any future `429`.

Next action:

- Audit iOS network error mapping for `RATE_LIMITED`.

## P3

### RT-P3-1: historical migration prefix warnings

Local startup warns about duplicate migration numeric prefixes. This is release diagnostic noise, not a runtime usability blocker.

Next action:

- Document in release-process cleanup backlog.
