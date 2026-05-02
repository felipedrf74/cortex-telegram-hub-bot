# Backend runtime open items

## P0

None found in this backend/runtime pass.

## P1

None left as confirmed, safe, scoped backend fixes in this pass after the read-rate-limit fix.

## P2

### RT-P2-1: capture staging p50/p95 for Home and Plan read timings

Status: code support added. Home and Plan routes now emit `Server-Timing` dependency breakdowns.

Next action:

- Track staging p50/p95 for `/api/v1/dashboard/home`, `/api/v1/plan/today`, `/api/v1/plan/week`.
- Correlate these headers with physical-device iOS navigation latency.

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
