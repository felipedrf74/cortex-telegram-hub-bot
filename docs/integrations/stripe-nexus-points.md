# Stripe Nexus Points Runbook

Stripe Nexus Points is a web-only add-on purchase flow. iOS keeps using Apple IAP for consumables.

## Dashboard Setup

1. In Stripe Dashboard, create three one-time Prices in USD:
   - Small: `$5`, product `me.nexushub.points.small`, grants `300 NP`.
   - Medium: `$10`, product `me.nexushub.points.medium`, grants `600 NP`.
   - Large: `$20`, product `me.nexushub.points.large`, grants `1200 NP`.
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

Optional:

- `STRIPE_NEXUS_POINTS_SUCCESS_URL`
- `STRIPE_NEXUS_POINTS_CANCEL_URL`

Do not write these values into the repo. Configure them in the runtime secret store.

## Purchase Surfaces

- Website self-serve: authenticated users call `POST /api/v1/billing/nexus-points/stripe-checkout`.
- Portal-admin: operators call `POST /api/users/:userId/billing/nexus-points/stripe-checkout` with a required `note`.
- Stripe Checkout redirect success is informational only. Credits are granted only after a signed Stripe webhook confirms payment.

## Refunds And Disputes

- Full refunds zero remaining Nexus Points for the matching Stripe `PaymentIntent.id`.
- Already-consumed AI cost is not clawed back.
- Partial refunds create an operator alert and do not auto-revoke.
- Disputes create an operator alert and do not auto-revoke. Handle disputes case-by-case until finance/legal defines a policy.

## Test Mode Handover

1. Enable `STRIPE_NEXUS_POINTS_ENABLED=true` in staging only.
2. Use Stripe test-mode price ids and webhook secret.
3. From the website account page, buy each package with Stripe test card `4242 4242 4242 4242`.
4. Verify `nexus_point_credits` contains three active `provider='stripe'` rows.
5. Replay a duplicate `checkout.session.completed` event and verify no duplicate credit is granted.
6. Trigger a full refund and verify the credit status becomes `refunded`.
7. Trigger a partial refund and a dispute, then verify operator alerts were created.

Production should stay disabled until Felipe signs off after staging soak.
