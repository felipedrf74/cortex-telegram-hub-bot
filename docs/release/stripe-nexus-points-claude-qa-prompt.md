# Claude Code QA Prompt: Stripe Nexus Points Purchase Flow

You are Claude Code performing an independent QA review of the Stripe Nexus Points purchase flow on branch `codex/chat-reliability`.

## Original Goal

Implement Stripe Nexus Points purchases through two web-only surfaces:

- Self-serve website flow on `nexushub.me` where logged-in users can buy Nexus Points and have the credit applied to their authenticated Nexus account.
- Portal-admin flow where Felipe/operators can create Stripe Checkout sessions for a selected user for beta/customer support.

Stripe must remain absent from the iOS purchase UI. iOS continues to use Apple IAP only.

## Implementation Commits

- `3615f145 feat(billing): add Stripe Nexus Points checkout`
- `48e36685 docs(billing): record Stripe staging smoke`

## What Was Implemented

- Added `config.stripe.nexusPoints` with enable flag, Stripe price IDs, success/cancel URLs, and fail-fast validation when `STRIPE_NEXUS_POINTS_ENABLED=true`.
- Added `src/services/stripe-nexus-points-service.ts` for hosted one-time Stripe Checkout sessions and signed Stripe webhook event handling.
- Extended `grantNexusPoints` so Stripe metadata is persisted in `nexus_point_credits.metadata_json`.
- Extended the existing raw-body `/webhooks/stripe` route so existing subscription events still work and Nexus Points events are handled by the new service.
- Added authenticated website checkout route: `POST /api/v1/billing/nexus-points/stripe-checkout`.
- Added scoped website CORS for `https://nexushub.me`, `https://www.nexushub.me`, and Cloudflare Pages preview hosts on the minimum auth/billing routes.
- Added portal-admin routes:
  - `GET /api/billing/nexus-points/packages`
  - `POST /api/users/:userId/billing/nexus-points/stripe-checkout`
- Added Nexus Points purchase controls to `src/portal/user-login.html`.
- Added portal user slideout checkout controls in `src/portal/portal.html`.
- Added documentation and operator runbook.

## Files Changed

- `src/config.ts`
- `src/services/stripe-nexus-points-service.ts`
- `src/services/nexus-points.ts`
- `src/api/router.ts`
- `src/api/routes/billing.ts`
- `src/api/routes/webhooks.ts`
- `src/portal/user-routes.ts`
- `src/portal/user-login.html`
- `src/portal/portal.html`
- `__tests__/services/stripe-nexus-points-service.test.ts`
- `__tests__/services/config-runtime-validation.test.ts`
- `__tests__/services/nexus-points.test.ts`
- `__tests__/api/billing-routes.test.ts`
- `__tests__/api/webhooks.test.ts`
- `__tests__/api/website-cors.test.ts`
- `__tests__/portal/portal-user-routes.test.ts`
- `__tests__/portal/portal-admin-scope.test.ts`
- `docs/integrations/stripe-nexus-points.md`
- `docs/release/nexus-points-usage-limits.md`
- `docs/release/smoke-evidence/staging-smoke-3615f145-20260520T115720Z.json`

## Expected Behavior

- Stripe Nexus Points are disabled unless `STRIPE_NEXUS_POINTS_ENABLED=true`.
- If enabled, boot fails fast unless `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, and all three Nexus Points Stripe price IDs are configured.
- Website checkout requires authenticated JWT scope; request bodies cannot choose `userId` or `tenantId`.
- Portal checkout requires `requirePortalAdminToken`, `requireOperatorTargetUser('userId')`, and a non-empty support note.
- Stripe Checkout uses configured `price_...` IDs only. The backend never computes Stripe line-item prices.
- Credits are granted only after verified Stripe webhook fulfillment, never after redirect success.
- `PaymentIntent.id` is used as `provider_transaction_id` for idempotency.
- Duplicate webhook deliveries do not double-grant points.
- Full refunds revoke only remaining points. Consumed AI spend is not clawed back.
- Partial refunds and disputes create operator alerts and do not auto-revoke.
- Existing Stripe subscription checkout/webhook behavior is preserved.
- Stripe checkout is not exposed in native iOS purchase UI.

## Tests And Checks Already Performed

- `npx tsc --noEmit` passed.
- Initial focused tests passed: 8 files / 75 tests.
- Expanded focused tests passed: 13 files / 192 tests.
- Final post-cleanup affected tests passed: 5 files / 46 tests.
- Final full verification passed: `npm run verify` -> 614 files / 9,090 tests.
- `STAGING=true npx tsx src/tools/chat-model-bakeoff.ts` passed with 109 fixtures / 218 bilingual turns.
- `npx tsx src/tools/model-pricing-report.ts` passed with local no-DB observations.
- `npx tsx scripts/chat-cost-scenarios.ts` passed with local zero-row report because `data/bot.db` is absent.
- `./scripts/deploy-staging.sh` passed from commit `3615f145`.
- `./scripts/staging-smoke.sh` passed 21/21 checks and wrote `docs/release/smoke-evidence/staging-smoke-3615f145-20260520T115720Z.json`.

## Areas To Inspect Carefully

- Webhook routing in `src/api/routes/webhooks.ts`: verify subscription events still route exactly as before and Nexus Points events do not steal subscription sessions.
- Signature verification: invalid Stripe signatures must return 400, while valid events that fail during processing should return non-2xx so Stripe retries.
- Checkout session metadata: ensure `userId`, `tenantId`, `packageId`, `source`, optional `actor`, optional `note`, and `stripePriceId` are present and not user-spoofable.
- Strict price ID mapping: unknown or mismatched Stripe prices should fail closed and alert, not map to a default package.
- Portal route authorization and audit logging: every portal-admin checkout route must require admin auth and target-user scope.
- Website CORS: only the intended origins and minimal routes should receive CORS headers.
- Ledger idempotency: duplicated `checkout.session.completed` and `checkout.session.async_payment_succeeded` events should not double-grant.
- Refund/dispute handling: full refund revokes remaining points; partial refund/dispute alert only.
- Logging hygiene: no raw webhook body, Stripe signature header, full Stripe response, card data, or user secrets should be logged.
- Token-zero boundary: no chat-pipeline command path should buy, grant, or mutate Stripe/Nexus Points.

## Edge Cases To Verify

- `STRIPE_NEXUS_POINTS_ENABLED=false` with missing price IDs still boots.
- `STRIPE_NEXUS_POINTS_ENABLED=true` with any missing required key fails boot with clear env-var names.
- Checkout for all three packages uses the correct configured Stripe price ID.
- Checkout body containing `userId` or `tenantId` is ignored.
- Portal checkout without note returns 400.
- `checkout.session.completed` with `mode='subscription'` still reaches existing subscription handler.
- `checkout.session.completed` with `mode='payment'` but unpaid/pending payment does not grant points.
- `checkout.session.async_payment_succeeded` grants once.
- Full refund for a non-Nexus charge does not crash.
- Partial refund does not revoke.
- Dispute alert is deduped enough to avoid alert storms.
- Existing Apple Nexus Points purchase/refund tests still pass.

## Known Risks Or Assumptions

- Stripe test-mode smoke was not completed by Codex because it requires external Stripe Dashboard setup: test `price_...` ids, webhook endpoint, webhook secret, test-card purchases, test refund, and test dispute.
- Production promote was intentionally blocked until Stripe test-mode smoke passes.
- Live Stripe smoke requires Felipe signoff and a real $5 purchase/refund flow.
- USD-only pricing is intentional for this PR.
- Stripe Tax, adaptive pricing, public unauthenticated purchase-to-email matching, dispute clawback, and Stripe/internal ledger reconciliation are deferred.
- The website implementation assumes `src/portal/user-login.html` or the equivalent deployed `nexushub.me` account page is the self-serve purchase surface.

## QA Request

Please verify the implementation against the original goal, run focused tests if needed, and look for issues beyond the existing coverage. Prioritize security, payment idempotency, webhook correctness, CORS/auth boundaries, existing Stripe subscription regression risk, and any doc-vs-code drift.
