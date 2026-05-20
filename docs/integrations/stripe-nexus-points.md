# Stripe Nexus Points Runbook

Stripe Nexus Points is a web-only add-on purchase flow. iOS keeps using Apple IAP for consumables.

## Dashboard Setup

1. In Stripe Dashboard, create three one-time Prices in USD:
   - Product name: `Nexus Points Small`; product metadata/internal SKU `me.nexushub.points.small`; price `$5 USD`; grants `300 NP`.
   - Product name: `Nexus Points Medium`; product metadata/internal SKU `me.nexushub.points.medium`; price `$10 USD`; grants `600 NP`.
   - Product name: `Nexus Points Large`; product metadata/internal SKU `me.nexushub.points.large`; price `$20 USD`; grants `1200 NP`.
2. Copy each `price_...` id into the runtime environment:
   - `STRIPE_PRICE_ID_POINTS_SMALL`
   - `STRIPE_PRICE_ID_POINTS_MEDIUM`
   - `STRIPE_PRICE_ID_POINTS_LARGE`
3. Set the webhook endpoint to:
   - Staging: `https://<staging-host>/webhooks/stripe`
   - Production: `https://api.nexushub.me/webhooks/stripe`
4. Subscribe the endpoint to:
   - `checkout.session.completed`
   - `checkout.session.async_payment_succeeded`
   - `charge.refunded`
   - `charge.dispute.created`
   - Existing subscription events already used by the app.
5. Copy the webhook secret into `STRIPE_WEBHOOK_SECRET`.

## Env Checklist

Required when `STRIPE_NEXUS_POINTS_ENABLED=true`:

- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `STRIPE_PRICE_ID_POINTS_SMALL`
- `STRIPE_PRICE_ID_POINTS_MEDIUM`
- `STRIPE_PRICE_ID_POINTS_LARGE`
- `PORTAL_ADMIN_ACTOR_SIGNATURE_SECRET`

Optional:

- `STRIPE_NEXUS_POINTS_SUCCESS_URL`
- `STRIPE_NEXUS_POINTS_CANCEL_URL`

Do not write these values into the repo. Configure them in the runtime secret store.

Safety checks:

- Staging/dev must use `sk_test_...` keys. The app refuses to boot with an `sk_live_...` key unless `NODE_ENV=production`.
- Test-mode and live-mode webhook secrets are swapped entirely through runtime env (`STRIPE_WEBHOOK_SECRET`); no rebuild is required.
- The Stripe SDK is pinned in code to API version `2026-02-25.clover`. Update this deliberately with a focused webhook/Checkout regression pass whenever the SDK API version is changed.

## Purchase Surfaces

- Website self-serve: authenticated users on `https://nexushub.me` call `POST https://api.nexushub.me/api/v1/billing/nexus-points/stripe-checkout`.
- Portal-admin: operators call `POST /api/users/:userId/billing/nexus-points/stripe-checkout` with a required `note`.
- Stripe Checkout redirect success is informational only. Credits are granted only after a signed Stripe webhook confirms payment.

Deployment topology:

- `user-login.html` can be served from the website domain and call the API cross-origin.
- The user-login CSP allows `connect-src 'self' https://api.nexushub.me https://*.nexushub-landing.pages.dev`.
- The API CORS policy is scoped to `https://nexushub.me`, `https://www.nexushub.me`, and Cloudflare Pages preview origins for only the auth/billing routes required by the website flow.
- Stripe checkout links must not be exposed in the native iOS purchase UI.

## Refunds And Disputes

- Full refunds zero remaining Nexus Points for the matching Stripe `PaymentIntent.id`.
- Already-consumed AI cost is not clawed back.
- Partial refunds create an operator alert and do not auto-revoke.
- Disputes create an operator alert and do not auto-revoke. Handle disputes case-by-case until finance/legal defines a policy.
- Refunds are intended to be handled inside the 30-day Nexus Points expiry window. Stripe may allow longer refund windows, but out-of-window refunds should be reviewed manually.
- Stripe is a trusted payment processor and receives customer email only when no existing Stripe customer id is available. The Nexus backend must not log customer email from Checkout/session creation responses.

## Test Mode Handover

1. Enable `STRIPE_NEXUS_POINTS_ENABLED=true` in staging only.
2. Use Stripe test-mode price ids and webhook secret.
3. From the website account page, buy each package with Stripe test card `4242 4242 4242 4242`.
4. Verify `nexus_point_credits` contains three active `provider='stripe'` rows.
5. Replay a duplicate `checkout.session.completed` event and verify no duplicate credit is granted.
6. Trigger a full refund and verify the credit status becomes `refunded`.
7. Trigger a partial refund and a dispute, then verify operator alerts were created.

Useful test cards:

- Success: `4242 4242 4242 4242`
- Insufficient funds: `4000 0000 0000 9995`
- Dispute: `4000 0000 0000 0259`
- Refund smoke: `4000 0000 0000 1976`

Webhook behavior:

- `/webhooks/stripe` requires the raw request body and Stripe signature verification.
- Invalid signatures return `400`; valid but irrelevant events return `200` and are ignored.
- The webhook rate limit is currently `120/min/IP`. This is enough for normal retries, but a large Stripe Dashboard backfill/replay should be scheduled during low traffic and watched. Temporarily raise the webhook rate limit before replaying a large historical batch.
- If Stripe retries exhaust after several days of 5xx responses, use Stripe Dashboard's webhook delivery log to identify missed events and manually replay available events. If a delivery can no longer be replayed, reconcile the PaymentIntent in Stripe Dashboard against `nexus_point_credits` and grant/revoke manually through an audited operator path.

Follow-up ticket:

- `STRIPE-NP-FOLLOWUP-001`: build a reconciliation script that compares Stripe successful Nexus Points PaymentIntents/refunds/disputes with internal `nexus_point_credits` and operator alerts.

Production should stay disabled until Felipe signs off after staging soak.
