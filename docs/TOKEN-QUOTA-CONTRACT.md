# Token Quota Contract

This document defines the iOS-facing quota contract for AI-backed endpoints.

## Plans

- `free` -> `$0.00/day`
- `pro` -> `$0.20/day`
- `max` -> `$0.60/day`

Owner and staging beta accounts bypass these caps internally.

These caps are intentionally conservative because the current production
architecture is Gemini-first and token-zero for deterministic lookups.
They are designed to leave healthy margin headroom while still allowing
normal assistant use plus heavier creator flows within the paid tiers.

## Dashboard contract

`GET /api/v1/dashboard` now includes:

```json
{
  "quota": {
    "used_usd": 0.12,
    "limit_usd": 0.2,
    "remaining_usd": 0.08,
    "plan": "pro",
    "resetAt": "2026-04-15T00:00:00.000Z"
  }
}
```

All timestamps are ISO-8601 UTC.

## Quota exceeded contract

Any AI-invoking iOS route must check quota before spending tokens. When the
user is over cap, the route returns HTTP `402 Payment Required`:

```json
{
  "ok": false,
  "error": {
    "code": "QUOTA_EXCEEDED",
    "message": "Daily AI quota reached for the pro plan. Resets at 2026-04-15T00:00:00.000Z.",
    "details": {
      "plan": "pro",
      "resetAt": "2026-04-15T00:00:00.000Z"
    }
  },
  "timestamp": "2026-04-14T21:00:00.000Z"
}
```

For free users, the message states that AI access requires Pro or Max.

## Product-truth guardrail

Quota enforcement applies only to AI-backed routes. Deterministic token-zero
routes must remain available even when quota is exhausted.

## Covered routes

- `POST /api/v1/chat/message`
- `POST /api/v1/content/script`
- `POST /api/v1/training/plan/generate`
- `POST /api/v1/finance/parse-receipt`

Structured token-zero endpoints remain available even when quota is exhausted.
