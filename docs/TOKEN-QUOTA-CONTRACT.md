# Token Quota Contract

This document defines the iOS-facing quota contract for AI-backed endpoints
plus the canonical entitlement resolver that gates every paid route.

**Last substantive update: 2026-04-21** (tenant/entitlement/portal hardening
pass — Free cap changed from `$0.00` to `$0.005`, centralized entitlement
resolver added, portal plan-config overrides added).

---

## Plans (compiled defaults)

| Plan    | Daily cost cap | Daily tokens | Daily messages | Allowed skills                                      |
|---------|---------------:|-------------:|---------------:|-----------------------------------------------------|
| `free`  |       `$0.005` |     `100000` |           `40` | `secretary` only                                    |
| `pro`   |        `$0.20` |     `500000` |          `200` | `secretary, training, content, cooking, finance`    |
| `max`   |        `$0.60` |     `500000` |          `500` | `secretary, training, content, cooking, finance`    |
| `owner` |      `$100.00` |   unlimited  |     unlimited  | all                                                 |

- **Free is the default** for any account without an active paid subscription.
  Registration (Apple / Google / email) provisions the user as `free`; tier
  is elevated only by Apple/Stripe webhook, founder assignment via the
  portal, or owner-ref match.
- **`$0.005`** on Free is deliberately small but non-zero. It covers ~1
  Gemini Flash-Lite secretary turn per day, which matches the business rule
  ("let people feel the product, then upsell").
- Owner and staging-beta bypass caps internally.
- These caps are conservative because production is Gemini-first and
  token-zero for deterministic lookups.

### Portal overrides

The canonical source of truth for per-plan caps is the `plan_configs` SQLite
table (migration `075_plan_configs.sql`). On boot, `src/index.ts` hydrates
in-memory overrides from this table via `applyPlanConfigRows()`. Runtime
edits through the portal's `PUT /api/plans/:planId` route update the table
**and** call `setPlanDailyCostCapOverride()` so the change is visible
without a restart.

Precedence used by `getEffectiveDailyCostLimitUsd(plan)`:

```
portal override (setPlanDailyCostCapOverride)
  > plan_configs DB row (hydrated at boot)
  > DEFAULT_EFFECTIVE_DAILY_COST_LIMITS compiled constants
```

If the `plan_configs` migration has not yet been applied on an older
environment, hydration logs a warning and the compiled defaults remain in
effect. Failing closed is intentional — no override never means a higher
cap is accidentally applied.

---

## Entitlement resolver (canonical)

All paid-route gating goes through `src/services/entitlement.ts`.

```typescript
getEffectiveEntitlement(userId: number): UserEntitlement
```

**Precedence** (highest wins):

1. `owner` — `isOwnerUserRef(userId)` returns true, OR `PAYWALL_ENABLED=false`
   globally bypasses paywall (beta/staging only).
2. `founder` — `subscriptions.provider === 'founder'` AND `status === 'active'`.
3. `apple` — `subscriptions.provider === 'apple'` AND `status IN ('active','trialing')`.
4. `stripe` — `subscriptions.provider === 'stripe'` AND `status IN ('active','trialing')`.
5. `beta` — `status === 'trialing'` AND any non-canonical provider (staging sandboxes).
6. `free` — anything else, including missing row, canceled row, or DB error.

**Fail-closed**: DB error returns `{ plan: 'free', source: 'error', ... }`.
Never allow access on exception.

### UserEntitlement shape

```typescript
interface UserEntitlement {
  plan: 'free' | 'pro' | 'max' | 'owner';
  source: 'owner' | 'founder' | 'apple' | 'stripe' | 'beta' | 'free' | 'error';
  status: 'active' | 'trialing' | 'expired' | 'none';
  isOwner: boolean;
  isFounder: boolean;
  allowedSkills: ReadonlySet<string>;           // Free = {'secretary'}, paid = UNRESTRICTED
  dailyCostCapUsd: number;                      // reads plan-quotas override chain
  subscriptionProvider?: string;
  subscriptionExpiresAt?: string;               // ISO-8601 UTC
}
```

### Middleware wiring

```typescript
// src/api/router.ts
router.use('/content',  requireEntitlement({ skill: 'content'  }), contentRoutes());
router.use('/cooking',  requireEntitlement({ skill: 'cooking'  }), cookingRoutes());
router.use('/finance',  requireEntitlement({ skill: 'finance'  }), financeRoutes());
router.use('/invoices', requireEntitlement({ skill: 'finance'  }), invoicesRoutes());
```

Denied requests return HTTP `403 FORBIDDEN` with:

```json
{
  "ok": false,
  "error": {
    "code": "TIER_REQUIRED",
    "message": "This feature requires a Pro or Max plan.",
    "details": {
      "requiredPlan": "pro",
      "currentPlan": "free",
      "skill": "content",
      "source": "free"
    }
  }
}
```

---

## Dashboard contract

`GET /api/v1/dashboard` includes:

```json
{
  "quota": {
    "used_usd": 0.12,
    "limit_usd": 0.20,
    "remaining_usd": 0.08,
    "plan": "pro",
    "resetAt": "2026-04-22T00:00:00.000Z"
  }
}
```

For Free users, `limit_usd` is `0.005`. iOS must render the quota banner
regardless of tier — the difference is only in the numeric cap.

All timestamps are ISO-8601 UTC.

---

## Quota exceeded contract

Any AI-invoking iOS route must check quota before spending tokens. When the
user is over cap, the route returns HTTP `402 Payment Required`:

```json
{
  "ok": false,
  "error": {
    "code": "QUOTA_EXCEEDED",
    "message": "Daily AI quota reached for the free plan. Resets at 2026-04-22T00:00:00.000Z.",
    "details": {
      "plan": "free",
      "resetAt": "2026-04-22T00:00:00.000Z"
    }
  },
  "timestamp": "2026-04-21T21:00:00.000Z"
}
```

For Free users, the message can additionally surface "Upgrade to Pro or Max
for higher limits." iOS renders the upsell.

---

## Product-truth guardrail

Quota enforcement applies only to AI-backed routes. Deterministic token-zero
routes must remain available even when quota is exhausted — the user can
still see their tasks, calendar, and readiness even after the daily $0.005
on Free has been spent.

---

## Covered (AI-backed) routes

- `POST /api/v1/chat/message`
- `POST /api/v1/content/script`
- `POST /api/v1/training/plan/generate`
- `POST /api/v1/finance/parse-receipt`

Structured token-zero endpoints (`GET /api/v1/tasks/*`, `GET /api/v1/dashboard`,
`GET /api/v1/training/home`) remain available even when quota is exhausted.

---

## Admin / portal surface

The admin can manage plan caps and entitlement via:

- `GET /api/plans` — list every plan_config row (plan_id, display_name,
  daily_cost_usd, daily_token_limit, allowed_skills).
- `PUT /api/plans/:planId` — update daily_cost_usd (non-negative), token/
  message limits, allowed skills. Writes to `plan_configs` table, updates
  in-memory override via `setPlanDailyCostCapOverride`, and emits an
  `audit_trail` row with `action = 'admin_mutation'`,
  `resource = 'plan_config.<planId>'`.
- `POST /api/founders` / `DELETE /api/founders/:email` — add or remove
  founder-tier entitlement by email. Validated, lowercased, audited.
- `PUT /api/users/:userId/tier` — manual tier override, audited.
- `PUT /api/users/:userId/limits` — per-user override on daily caps,
  audited.

All portal admin routes require `access_level === 'admin'` via
`requireAdmin` middleware. All mutations write to `audit_trail` so a
security review can reconstruct "who changed what, when."
