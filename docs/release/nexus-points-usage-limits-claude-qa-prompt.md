# Claude Code QA Prompt: Nexus Points Usage Limits And Model Pricing

You are Claude Code independently reviewing the Nexus Points usage-limit and model-pricing implementation.

## Original Goal

Implement tier daily AI budgets and purchasable Nexus Points:

- Pro at `$19.99` gets `$0.04/day` included AI budget.
- Max at `$24.99` gets `$0.06/day` included AI budget.
- `1 Nexus Point = $0.001` of internal AI provider cost allowance.
- Nexus Points expire 30 days after purchase.
- Points are consumed only after the daily included budget is exhausted.
- Paid AI hard-blocks when both included budget and active Nexus Points are exhausted.
- Raw provider tokens should not be user-facing app copy; Nexus Points are the user-facing usage-credit unit.
- Model pricing must be one central source of truth for input/output/cache prices so usage limits are enforced from exact `api_usage.cost_usd`.

## What Was Implemented

- Added a centralized model-pricing registry in `src/services/model-pricing.ts`.
- Rewired Gemini, OpenAI, Anthropic/internal usage logging, chat action planner estimates, bakeoff reports, and cost scenarios to use the registry.
- Unknown production model pricing no longer silently falls back to another model. Usage is marked unresolved with `pricing_status='unresolved'`, charged at the Sonnet-4.6 sentinel ceiling rate, and deduped operator alerts are emitted.
- Added migration `136_nexus_points_usage_limits.sql` for plan caps, per-user AI budget overrides, Nexus Point credits/debits, and `api_usage` pricing metadata.
- Updated compiled and migration plan caps: Pro `$0.04/day`, Max `$0.06/day`.
- Added `nexus_point_credits` and `nexus_point_debits` ledger support with 30-day expiry, purchase idempotency, and FIFO debit.
- Added Nexus Point packages:
  - `me.nexushub.points.small`: `$5`, `300 NP`, `$0.30` AI allowance.
  - `me.nexushub.points.medium`: `$10`, `600 NP`, `$0.60` AI allowance.
  - `me.nexushub.points.large`: `$20`, `1200 NP`, `$1.20` AI allowance.
- Updated billing status and quota-exceeded payloads with Nexus Point balance, included remaining USD, total remaining USD, expiring-soon metadata, and purchase metadata.
- Updated Apple purchase verification to process Nexus Point product IDs separately from subscription products.
- Preserved portal plan cap editability and added per-user AI budget override support through portal user limits.
- Updated chat quota flow so token-zero deterministic chat shortcuts can still answer after the AI usage limit is reached.
- Added docs for Nexus Points, pricing registry process, and the canonical quota contract.

## Files Changed

Implementation:

- `src/services/model-pricing.ts`
- `src/services/nexus-points.ts`
- `src/services/ai-budget-overrides.ts`
- `src/services/cost-guardrail.ts`
- `src/services/plan-quotas.ts`
- `src/services/gemini-provider.ts`
- `src/services/openai-provider.ts`
- `src/services/chat-action-planner.ts`
- `src/services/chat-model-bakeoff.ts`
- `src/services/scheduler.ts`
- `src/services/stripe-service.ts`
- `src/tools/model-pricing-report.ts`
- `src/api/routes/billing.ts`
- `src/api/routes/chat-message-routes.ts`
- `src/api/routes/chat-message-shortcuts.ts`
- `src/api/routes/dashboard.ts`
- `src/api/routes/internal.ts`
- `src/portal/anthropic-hook.ts`
- `src/portal/provider-routes.ts`
- `src/portal/user-routes.ts`
- `src/portal/portal.html`
- `scripts/chat-cost-scenarios.ts`
- `scripts/test-gemini-ptbr.ts`
- `migrations/136_nexus_points_usage_limits.sql`
- `migrations/137_nexus_points_settlement_hardening.sql`

Tests:

- `__tests__/services/nexus-points.test.ts`
- `__tests__/services/cost-guardrail.test.ts`
- `__tests__/services/cost-validation.test.ts`
- `__tests__/services/gemini-provider.test.ts`
- `__tests__/services/openai-provider.test.ts`
- `__tests__/services/usage-metering-qa-validation.test.ts`
- `__tests__/services/user-service.test.ts`
- `__tests__/security/billing-apple-notifications-jws-verify.test.ts`
- `__tests__/api/auth-routes.test.ts`
- `__tests__/api/billing-routes.test.ts`
- `__tests__/api/chat-message-request.test.ts`
- `__tests__/api/chat-routes.test.ts`
- `__tests__/api/internal-routes.test.ts`
- `__tests__/portal/portal-user-routes.test.ts`

Docs:

- `docs/MODEL-REVIEW-PROCESS.md`
- `docs/TOKEN-QUOTA-CONTRACT.md`
- `docs/agents/claude/handoff.md`
- `docs/ai/model-routing-current-state.md`
- `docs/release/nexus-points-usage-limits.md`
- `docs/release/nexus-points-usage-limits-claude-qa-prompt.md`

## Expected Behavior

- Pro users have `$0.04/day` included AI usage; Max users have `$0.06/day`.
- Portal plan overrides still win over compiled defaults.
- Active per-user AI budget overrides win over plan caps.
- Billing status reports included remaining budget plus active Nexus Points.
- If included daily budget is exhausted, only the overage is debited from active Nexus Points.
- Nexus Point credits expire after 30 days and are debited FIFO by earliest expiry.
- Duplicate Apple transactions do not double-grant points.
- When included budget and points are both exhausted, AI-backed paid chat is blocked with purchase metadata.
- Deterministic token-zero reads still work after the AI usage limit is reached.
- Provider usage logging records exact provider/model/token/cost metadata where schema supports it.
- Unknown models are unresolved instead of being priced as Flash or another fallback, but they are still charged at the sentinel ceiling rate for quota protection.
- Apple refund/revoke notifications revoke remaining Nexus Point credits.
- Batch/Flex cost savings stay in offline eval/backfill reporting, not live chat defaults.

## Tests And Checks Already Performed

- TypeScript:
  - `npx tsc --noEmit`
  - Result: passed.
- Focused vitest pass:
  - `npx vitest run __tests__/services/nexus-points.test.ts __tests__/services/cost-guardrail.test.ts __tests__/services/cost-validation.test.ts __tests__/api/billing-routes.test.ts __tests__/api/chat-routes.test.ts __tests__/api/chat-message-request.test.ts __tests__/api/internal-routes.test.ts __tests__/portal/portal-user-routes.test.ts __tests__/portal/portal-provider-routes.test.ts __tests__/services/gemini-provider.test.ts __tests__/services/openai-provider.test.ts __tests__/services/usage-metering-qa-validation.test.ts __tests__/security/billing-apple-notifications-jws-verify.test.ts`
  - Result: 13 test files, 262 tests passed.
- Full verification:
  - `npm run verify`
  - Result: 612 test files, 9,055 tests passed.
- Bakeoff baseline:
  - `STAGING=true npx tsx src/tools/chat-model-bakeoff.ts`
  - Result: passed, 109 fixtures / 218 bilingual turns.
- Pricing registry report:
  - `npx tsx src/tools/model-pricing-report.ts`
  - Result: passed; local DB unavailable, active `api_usage` scan empty, pricing table printed.
- Cost scenarios:
  - `npx tsx scripts/chat-cost-scenarios.ts`
  - Result: passed with empty report because local `data/bot.db` was absent in this worktree.
- Local-dev sandbox smoke:
  - `./scripts/local-up.sh && ./scripts/local-smoke.sh`
  - Result: blocked before startup because `.env.local` is missing at repo root. This task did not create or modify `.env*` files.
- Staging deploy:
  - `./scripts/deploy-staging.sh`
  - Result: passed after the final cost-validation fix.
- Staging smoke:
  - `./scripts/staging-smoke.sh`
  - Result: passed 20/20 checks. Evidence: `docs/release/smoke-evidence/staging-smoke-75db3026-20260520T090947Z.json`.
- Production promote:
  - `./scripts/promote-to-prod.sh`
  - Result: passed. The script ran/reused staging smoke evidence `docs/release/smoke-evidence/staging-smoke-75db3026-20260520T091030Z.json`, auto-bumped production to `v4.14.170`, committed `a391479e`, and restarted production successfully.
- External production health:
  - `curl -sS -D - https://api.nexushub.me/health`
  - Result: HTTP 200, `status: healthy`, `cf-cache-status: DYNAMIC`.
- Final stop-gate doc drift check:
  - `rg -n "\\$0\\.20|\\$0\\.60|0\\.20/day|0\\.60/day|limit_usd.: 0\\.20|limit_usd.: 0\\.60|daily.*0\\.20|daily.*0\\.60|Pro.*0\\.20|Max.*0\\.60" docs src migrations __tests__ --glob '!docs/release/eval-evidence/**'`
  - Result: only historical Claude-spend comments remain; the stale Pro-cap handoff line was removed.
- Diff hygiene:
  - `git diff --check`
  - Result: passed.

## Inspect Carefully

- Ensure every production AI usage logging path uses `src/services/model-pricing.ts` and no duplicate provider rate table remains authoritative.
- Confirm `OPENAI_COST_PER_MTK` is now compatibility-only and stays in parity with the central registry.
- Check that `api_usage.pricing_status` and `api_usage.pricing_model_key` are written correctly on new-schema DBs and old-schema fallbacks still work.
- Verify provider usage logging cannot undercount user quota if an unknown production model is deployed.
- Review whether direct provider call sites outside the usual route cost locks need explicit serialization before relying on provider-level Nexus Point settlement.
- Confirm Apple point purchases cannot accidentally update subscriptions and subscription purchases cannot accidentally grant points.
- Confirm point balances and purchase metadata are shaped correctly for iOS and portal consumers.
- Review migration idempotency, indexes, unique purchase transaction constraints, and old database compatibility.
- Verify portal user limit updates clear or set per-user AI budget overrides safely.
- Confirm token-zero deterministic shortcut paths do not invoke the LLM after quota exhaustion.

## Edge Cases To Verify

- Included budget partially remaining and an AI call crosses the cap: only the excess should debit points.
- Multiple credits with different expiries: debit the oldest active credit first.
- Expired credits with remaining points: ignored in balance and debit.
- Duplicate Apple transaction ID: no double grant.
- Unknown model in provider usage logging: `pricing_status='unresolved'`, sentinel cost, deduped operator alert.
- Old DB without `pricing_status` columns: usage logging should still record the historical fields.
- Free user with no subscription and no points: AI remains blocked according to entitlement rules.
- Pro/Max user with points exhausted: AI blocks only after included budget is exhausted too.
- Owner/staging-beta bypass is scoped to owner/beta allowlisted tiers in staging instead of globally applying to all users.
- Dashboard and billing status values stay internally consistent: included remaining + points remaining = total remaining.
- Cost scenario report includes `unmatched_models` instead of silently pricing unknown models.

## Known Risks And Assumptions

- Cost scenarios could not use real last-30-day rows because `data/bot.db` was not present in this worktree; rerun against staging/prod data for financial forecasting.
- Local Docker smoke was blocked by the missing `.env.local`; this is an environment-prep blocker, not an implementation test failure.
- Cache token rates are represented in the registry, but actual cache-read/cache-write accounting depends on provider SDK usage metadata being available in each integration.
- Unknown model pricing is fail-closed for pricing correctness and conservative quota protection: unresolved rows use the sentinel ceiling rate while ops fixes the registry.
- Provider-level Nexus Point settlement assumes normal AI call paths are already inside existing per-user cost locks. Claude should look for any high-volume provider calls that bypass those route-level locks.
- Staging deploy, staging smoke, production promotion, and external production health were performed. A live Apple sandbox purchase was not performed in this pass.
