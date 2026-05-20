# Nexus Points Usage Limits

Status: implemented on `codex/chat-reliability`
Date: 2026-05-20

## Included Daily AI Budgets

| Tier | Monthly price | Daily AI budget | Monthly AI allowance | AI cost % | AI-only margin |
| --- | ---: | ---: | ---: | ---: | ---: |
| Pro | $19.99 | $0.04/day | $1.22/mo | 6.1% | 93.9% |
| Max | $24.99 | $0.06/day | $1.83/mo | 7.3% | 92.7% |

Portal plan caps remain editable through `/api/plans/:planId`. Per-user AI budget overrides can be written through `/api/users/:userId/limits` using `daily_ai_cost_limit_usd`.

## Nexus Points

Nexus Points are the public usage-credit unit. Raw provider tokens should not be used in app copy.

- `1 Nexus Point = $0.001` of internal AI provider cost allowance.
- Credits expire 30 days after purchase.
- Daily included budget is consumed first.
- Nexus Points are debited only for spend above the included daily cap.
- Paid AI is hard-blocked when both included budget and active Nexus Points are exhausted.
- Token-zero reads remain available after AI quota is exhausted.

| Package | Product ID | Price | Points | AI allowance | AI-only margin | Net margin after Apple cut |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Small | `me.nexushub.points.small` | $5 | 300 | $0.30 | 94% | 91.4% |
| Medium | `me.nexushub.points.medium` | $10 | 600 | $0.60 | 94% | 91.4% |
| Large | `me.nexushub.points.large` | $20 | 1,200 | $1.20 | 94% | 91.4% |

Apple subscription products still update `subscriptions`. Nexus Point products are processed separately into the `nexus_point_credits` / `nexus_point_debits` ledger and are idempotent by `(provider, provider_transaction_id)`. Apple refund/revoke server notifications now revoke remaining Nexus Point credit by transaction id and set the credit status to `refunded` or `revoked`.

Stripe Nexus Points purchases are web-only:

- Website self-serve checkout is exposed through authenticated web/JWT calls to `POST /api/v1/billing/nexus-points/stripe-checkout`.
- Portal-admin checkout is exposed through `POST /api/users/:userId/billing/nexus-points/stripe-checkout`, guarded by `requirePortalAdminToken` and `requireOperatorTargetUser('userId')`.
- iOS purchase UI remains Apple IAP-only. Stripe checkout must not be linked from the native iOS purchase surface.
- Stripe Checkout uses hosted one-time `mode='payment'` sessions with dashboard `price_...` IDs as the price source of truth. The backend does not compute Stripe line-item amounts.
- Fulfillment happens only from a verified `/webhooks/stripe` event. Redirect success pages never grant credits.
- Stripe grants use `PaymentIntent.id` as `provider_transaction_id`; retries and duplicate webhooks are idempotent through the existing ledger uniqueness constraint.
- Website CORS is scoped to `https://nexushub.me`, `https://www.nexushub.me`, and Cloudflare Pages preview hosts for the minimum auth/billing routes needed by the web purchase page.

Refund / clawback policy:

- Refunds and revokes zero any remaining Nexus Point balance for the matching Apple transaction.
- Stripe full refunds zero remaining Nexus Point balance for the matching `PaymentIntent.id`.
- Stripe partial refunds and disputes create operator alerts and do not auto-revoke credits in this PR; finance/legal should define the dispute policy before public web volume.
- Already-consumed AI provider cost is not reversed from `nexus_point_debits` and does not restore daily included allowance.
- This matches the current consumable-credit implementation, but finance/legal should explicitly sign off before higher-volume Nexus Point sales.

## Pricing Registry

Model pricing is centralized in `src/services/model-pricing.ts`.

Every provider usage path should record `provider`, `model`, input/output/cache token counts, `cost_usd`, `pricing_status`, and `pricing_model_key` when the DB schema supports it. Unknown production models must not silently inherit another model's price. They are marked `pricing_status='unresolved'`, charged at the Sonnet-4.6 sentinel ceiling rate (`$3/M` input, `$15/M` output), and emit a deduped operator alert until `src/services/model-pricing.ts` is updated.

Run:

```bash
npx tsx src/tools/model-pricing-report.ts
npx tsx scripts/chat-cost-scenarios.ts
```

`chat-cost-scenarios.ts` uses Batch estimates only for offline eval/backfill rows. Batch and Flex are not production live-chat defaults.

## Claude QA Pass 1 Review

Part A findings:

| ID | Status | Evidence / files | Summary |
| --- | --- | --- | --- |
| B1 | Fixed | `src/services/model-pricing.ts`, provider usage writers | Unresolved models now charge a sentinel ceiling cost and emit deduped operator alerts instead of writing free usage. Model names still come from server-side config/routing, not request payloads. |
| B2 | Fixed | `src/api/routes/chat-message-routes.ts` | Chat quota gate now runs immediately after acquiring the per-user cost lock; token-zero deterministic shortcut replies remain available after quota exhaustion. |
| B3 | Fixed | `src/services/nexus-points.ts`, providers, migration `137` | Settlement is awaited, transaction-scoped, api_usage-idempotent, and OpenAI streaming passes the real user id. |
| B4 | Fixed | `src/services/nexus-points.ts` | Settlement scopes overage to the specific `api_usage.ts` day, preventing UTC rollover loss. |
| B5 | Fixed | `src/services/database.ts`, migration `137` | Migration runner skips already-added columns; new default is `legacy` for historical pricing rows. |
| H1 | Fixed | `src/services/model-pricing.ts` | Pricing resolution is exact-match first; prefix variants require explicit opt-in. |
| H2 | Fixed | `src/services/plan-quotas.ts` | Quota enforcement and Nexus Points settlement share `resolveBillingPlanForUser()`. |
| H3 | Fixed | `src/services/plan-quotas.ts` | Staging/paywall-disabled bypass is scoped to owner/beta allowlist in staging. |
| H4 | Fixed | `src/services/cost-guardrail.ts`, `src/api/routes/billing.ts` | Billing and quota-exceeded routes use the canonical quota/Nexus Points payload shape. |
| H5 | Fixed | OpenAI/Gemini providers | Cache read tokens are read from SDK usage payloads, persisted, and priced. |
| M1-M5 | Fixed | planner, migrations, pricing report, provider warnings, quota math | Planner passes provider into estimates; immutable migrations restored; pricing report flags unused registry rows; provider unresolved logs are deduped; USD-to-points conversion uses the exported helper. |
| M6 | Fixed | `__tests__/services/nexus-points.test.ts` | Added idempotent settlement, UTC rollover, cap-crossing debit, and refund/revoke tests. |
| M7 | Fixed | `src/services/scheduler.ts` | Daily all-user Nexus Points expiry sweep scheduled for 04:00 UTC. |
| M8 | Fixed | `src/services/nexus-points.ts` | Nexus Point display rounding increased to 5 decimal places. |

Part B independent scan:

| Area | Severity | Status | Notes |
| --- | --- | --- | --- |
| Apple refund/revoke for Nexus Points | High | Fixed | Refund/revoke App Store notifications now revoke remaining point credit; signed webhook test added. |
| Stripe Nexus Points purchases | Medium | Fixed in Stripe follow-up | Web self-serve and portal-admin Stripe Checkout sessions now grant Nexus Points through the signed Stripe webhook path. |
| Tenant isolation | Low | Verified acceptable | Ledger is intentionally user-scoped; current tenant model maps one canonical tenant per iOS user. Revisit if users can transfer points across business/personal tenants. |
| Owner/staging bypass spoofing | Low | Verified acceptable | Owner detection uses server-side owner refs/users table after authenticated `userId`; no request-controlled owner flag was found. |
| Apple transaction replay | Low | Hardened | Purchase grant remains idempotent by `(provider, provider_transaction_id)`; refund handler now tries both transaction id and original transaction id. |
| Portal per-user override auth | Low | Verified acceptable | `/api/users/:userId/limits` is protected by `requirePortalAdminToken` and `requireOperatorTargetUser`. |
| iOS purchase metadata | Low | Verified acceptable | Server exposes package points and USD reference price; StoreKit remains source of localized display price. |
| Logging hygiene | Low | Verified acceptable | No full Apple receipt/JWS body or provider prompt content is logged in the changed billing paths. |
| Concurrent purchase + debit | Low | Known race | A chat request that checks quota before a purchase commit can still block once; retry after purchase status refresh succeeds. This is a UX follow-up, not a ledger consistency bug. |
| Rollback behavior | Low | Documented | Older code can still insert into `api_usage`; pricing status defaults to `legacy` after migration `137`. |
| Boot validation | Low | Verified acceptable | `model-pricing.ts` is a required module; malformed registry code fails process boot rather than silently pricing all rows as unresolved. |

Verification gates:

| Gate | Status | Evidence |
| --- | --- | --- |
| TypeScript | Passed | `npx tsc --noEmit` |
| Focused tests | Passed | `npx vitest run __tests__/services/nexus-points.test.ts __tests__/services/cost-guardrail.test.ts __tests__/services/cost-validation.test.ts __tests__/api/billing-routes.test.ts __tests__/api/chat-routes.test.ts __tests__/api/chat-message-request.test.ts __tests__/api/internal-routes.test.ts __tests__/portal/portal-user-routes.test.ts __tests__/portal/portal-provider-routes.test.ts __tests__/services/gemini-provider.test.ts __tests__/services/openai-provider.test.ts __tests__/services/usage-metering-qa-validation.test.ts __tests__/security/billing-apple-notifications-jws-verify.test.ts` -> 13 files / 262 tests passed |
| Full verification | Passed | `npm run verify` -> 612 files / 9,065 tests passed |
| Bakeoff baseline | Passed | `STAGING=true npx tsx src/tools/chat-model-bakeoff.ts` |
| Pricing report | Passed | `npx tsx src/tools/model-pricing-report.ts`; local DB scan empty because no local DB was configured |
| Cost scenarios | Passed | `npx tsx scripts/chat-cost-scenarios.ts`; emitted a zero-row local report because `data/bot.db` is absent in this worktree |
| Local-dev sandbox smoke | Blocked | `./scripts/local-up.sh && ./scripts/local-smoke.sh` stopped at `.env.local not found at repo root`; `.env*` files are intentionally not created or modified in this task |
| Staging deploy | Passed | `./scripts/deploy-staging.sh` completed after the final cost-validation fix |
| Staging smoke | Passed | `./scripts/staging-smoke.sh` -> 20/20 checks passed; evidence `docs/release/smoke-evidence/staging-smoke-75db3026-20260520T090947Z.json` |
| Promote-to-prod preflight smoke | Passed | `./scripts/promote-to-prod.sh` reused/ran staging smoke -> 20/20 checks passed; evidence `docs/release/smoke-evidence/staging-smoke-75db3026-20260520T091030Z.json` |
| Production promotion | Passed | `./scripts/promote-to-prod.sh` completed; deploy auto-bumped production to `v4.14.170` at commit `a391479e` |
| External production health | Passed | `curl -sS -D - https://api.nexushub.me/health` returned HTTP 200 with `{"status":"healthy" ...}` and `cf-cache-status: DYNAMIC` |

Notes:

- An earlier production promotion attempt correctly failed during deploy validation because the lazy operator-alert import made `__tests__/services/cost-validation.test.ts` miss the alert mock. That test seam was fixed with `_setRecordOperatorAlertForTests()`, then focused tests, `npx tsc --noEmit`, `npm run verify`, bakeoff, pricing report, cost scenarios, staging deploy/smoke, and promotion were rerun.
- Production is running `v4.14.170`; staging remains on `v4.14.169` after the production auto-bump, as reported by `promote-to-prod.sh`.

## Claude QA Pass 2 Review

Status: pass with issues. Follow-up work in progress on top of `48b0769a`.

Findings and action:

| ID | Status | Evidence / files | Summary |
| --- | --- | --- | --- |
| P0-PR1 | Action required | `scripts/deploy.sh`, `scripts/promote-to-prod.sh`, smoke evidence names | `v4.14.170` contains the implementation by rsync working-tree snapshot, but the implementation commit `48b0769a` was created after production promotion. A clean committed deploy should be run so the audit trail is implementation commit -> deploy version bump. |
| P0-PR2 | Documented | `promote-to-prod.sh` output | Staging remaining on `v4.14.169` while production is `v4.14.170` is expected after `deploy.sh` auto-bumps production, but the next clean deploy should resync staging first. |
| I1 | Fixed in follow-up | background AI callers | User-owned background calls now pass `userId`/`tenantId` through Gemini/OpenAI wrapper options and Anthropic fallback `trackedCreate` options. System-owned autoresearch calls explicitly use `{ userId: 0, tenantId: 0 }` with an inline comment. |
| I3 | Fixed in follow-up | `chat-message-shortcuts.ts`, `chat-message-routes.ts` | Independent follow-up scan found content refinement shortcuts passed `userId` but omitted `tenantId`; non-default tenant refinements now meter against the active tenant scope. |
| I2 | Documented | refund / clawback policy section above | Refund/revoke handling zeros remaining Nexus Points only; already-consumed AI spend is not clawed back. |
| M-G1 | Accepted | migrations `136` and `137` | Migration `137` rebuilds `api_usage` with `pricing_status DEFAULT 'legacy'`; migration `136` is immutable and may have a transient `resolved` default only if migration execution stops between 136 and 137. |

Historical smoke evidence note:

- `docs/release/smoke-evidence/staging-smoke-75db3026-*` was generated while the working tree contained the uncommitted Nexus Points implementation. The filenames reflect the parent HEAD used by the smoke script, not the later implementation commit. A clean redeploy from the committed follow-up should generate new evidence with the correct commit lineage.

Known remaining risk:

- `channel-learner` synthesis still accepts only `userId` and treats the default tenant as `tenantId=userId`; non-default tenant synthesis is deliberately skipped until that function accepts an explicit tenant scope.

Follow-up verification:

- `npx tsc --noEmit` passed.
- Focused billing/chat/provider suite passed: 14 files / 280 tests.
- `npm run verify` passed: 612 files / 9067 tests.
- `STAGING=true npx tsx src/tools/chat-model-bakeoff.ts` passed with 109 fixtures / 218 bilingual turns.
- `npx tsx src/tools/model-pricing-report.ts` passed against the local no-DB path; it emitted an empty usage report with all registry rows listed as unused.
- `npx tsx scripts/chat-cost-scenarios.ts` passed against the local no-DB path; it emitted a zero-row scenario report because `data/bot.db` is intentionally absent in this worktree.
- Clean staging deploy from `0b5a7989` passed, then `./scripts/staging-smoke.sh` passed 21/21 checks and wrote `docs/release/smoke-evidence/staging-smoke-0b5a7989-20260520T102027Z.json`.
- Clean promote-to-prod from `cfe7799d` passed, including its staging smoke gate (21/21 checks, evidence `docs/release/smoke-evidence/staging-smoke-cfe7799d-20260520T102119Z.json`), full `npm run verify` preflight (612 files / 9067 tests), production deploy, and post-deploy health check.
- Production is running `v4.14.171` from deploy/version commit `c0de6eda`; `curl https://api.nexushub.me/health` returned HTTP 200 with `status=healthy` and `database=connected`.
- This docs-only evidence entry was recorded after the clean production promotion; the runtime artifact remains `c0de6eda`.

## Pass 3: Stripe Nexus Points Addition

Status: implementation in progress on `codex/chat-reliability`.

Implemented:

- Added `config.stripe.nexusPoints` with fail-fast validation when `STRIPE_NEXUS_POINTS_ENABLED=true`.
- Added `src/services/stripe-nexus-points-service.ts` for hosted Checkout session creation and signed webhook event handling.
- Extended the provider-neutral Nexus Points ledger grant path to persist Stripe reconciliation metadata.
- Extended `/webhooks/stripe` so existing subscription events continue to work while Nexus Points events are handled by the new service.
- Added authenticated website checkout at `POST /api/v1/billing/nexus-points/stripe-checkout`.
- Added portal package listing and portal-admin checkout creation routes with required support notes and audit logging.
- Added Nexus Points purchase controls to the web sign-in/account page and a checkout panel to the portal user slideout.
- Added focused tests for service behavior, API checkout, webhook routing, portal guards, CORS, runtime config validation, and ledger metadata.

Deferred:

- Public unauthenticated purchase-to-email matching.
- Stripe Tax, adaptive pricing, and localization.
- Automatic dispute revocation or clawback of already-consumed AI spend.
- Stripe-vs-internal ledger reconciliation script.

Verification for this pass:

- `npx tsc --noEmit` passed.
- Initial focused local tests passed: `npx vitest run __tests__/services/stripe-nexus-points-service.test.ts __tests__/api/billing-routes.test.ts __tests__/api/webhooks.test.ts __tests__/api/website-cors.test.ts __tests__/portal/portal-user-routes.test.ts __tests__/portal/portal-admin-scope.test.ts __tests__/services/config-runtime-validation.test.ts __tests__/services/nexus-points.test.ts` -> 8 files / 75 tests passed.
- Expanded focused gate passed: `npx vitest run __tests__/services/stripe-nexus-points-service.test.ts __tests__/api/billing-routes.test.ts __tests__/api/webhooks.test.ts __tests__/api/website-cors.test.ts __tests__/portal/portal-user-routes.test.ts __tests__/portal/portal-admin-scope.test.ts __tests__/services/nexus-points.test.ts __tests__/services/cost-guardrail.test.ts __tests__/services/cost-validation.test.ts __tests__/api/chat-routes.test.ts __tests__/api/internal-routes.test.ts __tests__/services/config-runtime-validation.test.ts __tests__/security/billing-apple-notifications-jws-verify.test.ts` -> 13 files / 192 tests passed.
- Final post-cleanup affected tests passed: `npx vitest run __tests__/api/webhooks.test.ts __tests__/services/stripe-nexus-points-service.test.ts __tests__/api/billing-routes.test.ts __tests__/api/website-cors.test.ts __tests__/portal/portal-user-routes.test.ts` -> 5 files / 46 tests passed.
- Final full verification passed after the webhook cleanup: `npm run verify` -> 614 files / 9,090 tests passed.
- `STAGING=true npx tsx src/tools/chat-model-bakeoff.ts` passed with 109 fixtures / 218 bilingual turns.
- `npx tsx src/tools/model-pricing-report.ts` passed; local DB path was not configured, so usage observations were empty and registry entries were reported as unused.
- `npx tsx scripts/chat-cost-scenarios.ts` passed; local `data/bot.db` is absent, so it emitted a zero-row scenario report.
- Staging deploy passed from commit `3615f145`.
- Staging smoke passed 21/21 checks; evidence: `docs/release/smoke-evidence/staging-smoke-3615f145-20260520T115720Z.json`.
- Stripe test-mode smoke, production promote, and live Stripe smoke were not run in this implementation pass because the required Stripe Dashboard test products/webhook setup and Felipe live-purchase signoff are external operational gates. See `docs/integrations/stripe-nexus-points.md`.
