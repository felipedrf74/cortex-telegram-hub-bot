# Claude Code QA Prompt Pass 2: Nexus Points Usage Limits And Model Pricing

You are Claude Code doing a second independent QA pass on the Nexus Points usage-limit and model-pricing work.

This is a review task first. Do not trust prior summaries. Verify with code, tests, and runtime evidence before accepting any claim. Do not mutate production, staging, `.env*`, `data/`, or `content-engine/.venv/`. If you find issues, report them with file:line evidence, severity, reproduction steps, and a recommended fix.

## Context

Worktree:

```text
/Users/felipedominguez/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot-chat-reliability
```

Branch:

```text
codex/chat-reliability
```

Relevant recent commits:

```text
48b0769a fix(billing): B1-B5 harden Nexus Points limits
a391479e chore: bump version to 4.14.170 [deploy]
75db3026 docs(chat): add review pass 2 follow-up tickets
```

Important release docs:

```text
docs/release/nexus-points-usage-limits.md
docs/release/nexus-points-usage-limits-claude-qa-prompt.md
docs/TOKEN-QUOTA-CONTRACT.md
docs/MODEL-REVIEW-PROCESS.md
```

## Original Goal

Implement tier daily AI budgets and purchasable Nexus Points:

- Pro at `$19.99` gets `$0.04/day` included AI budget.
- Max at `$24.99` gets `$0.06/day` included AI budget.
- `1 Nexus Point = $0.001` of internal AI provider cost allowance.
- Nexus Points expire 30 days after purchase.
- Points are consumed only after the daily included budget is exhausted.
- Paid AI hard-blocks when both included budget and active Nexus Points are exhausted.
- Token-zero deterministic reads still work after AI budget exhaustion.
- Centralize provider/model pricing so all quota enforcement uses exact `api_usage.cost_usd`.
- Unknown production models must never silently receive another model's price.

## What Codex Claims Was Implemented

- Central model pricing registry at `src/services/model-pricing.ts`.
- Conservative unresolved-model pricing: unresolved usage is marked `pricing_status='unresolved'`, charged at Sonnet-4.6 ceiling rates, and operator-alerted.
- Nexus Points ledger in `src/services/nexus-points.ts`.
- Migrations:
  - `migrations/136_nexus_points_usage_limits.sql`
  - `migrations/137_nexus_points_settlement_hardening.sql`
- Chat quota gate moved before LLM-capable planner/reasoning paths.
- Token-zero deterministic chat shortcuts remain available after quota exhaustion.
- Provider usage logging for OpenAI/Gemini/Anthropic/internal usage now uses the central pricing registry.
- Cache read tokens are persisted/priced when provider SDK metadata exposes them.
- Settlement is awaited, transaction-scoped, api_usage-idempotent, and tied to the specific usage row day.
- Billing status and quota-exceeded responses expose canonical Nexus Points purchase metadata.
- Apple Nexus Point purchases are separated from subscriptions.
- Apple refund/revoke notifications revoke remaining Nexus Point credits.
- Plan resolution shared through `src/services/plan-quotas.ts`.
- Staging/paywall-disabled bypass is owner/beta-scoped instead of global.
- Daily expiry sweep runs at 04:00 UTC through `src/services/scheduler.ts`.
- Docs were updated with verification evidence and known limitations.

## Verification Codex Claims Passed

- `npx tsc --noEmit`
- Focused tests:

```bash
npx vitest run \
  __tests__/services/nexus-points.test.ts \
  __tests__/services/cost-guardrail.test.ts \
  __tests__/services/cost-validation.test.ts \
  __tests__/api/billing-routes.test.ts \
  __tests__/api/chat-routes.test.ts \
  __tests__/api/chat-message-request.test.ts \
  __tests__/api/internal-routes.test.ts \
  __tests__/portal/portal-user-routes.test.ts \
  __tests__/portal/portal-provider-routes.test.ts \
  __tests__/services/gemini-provider.test.ts \
  __tests__/services/openai-provider.test.ts \
  __tests__/services/usage-metering-qa-validation.test.ts \
  __tests__/security/billing-apple-notifications-jws-verify.test.ts
```

- `npm run verify` -> 612 files / 9,065 tests passed.
- `STAGING=true npx tsx src/tools/chat-model-bakeoff.ts`
- `npx tsx src/tools/model-pricing-report.ts`
- `npx tsx scripts/chat-cost-scenarios.ts`
- `./scripts/deploy-staging.sh`
- `./scripts/staging-smoke.sh` -> 20/20 checks.
- `./scripts/promote-to-prod.sh`
- `curl -sS -D - https://api.nexushub.me/health` -> HTTP 200, `status: healthy`.

Known blocked gate:

- `./scripts/local-up.sh && ./scripts/local-smoke.sh` was blocked because `.env.local` is missing. This task did not create or modify `.env*`.

## QA Pass 2 Priorities

### P0/P1: Deployment Provenance

1. Verify whether production is actually running the code content from `48b0769a` or only the version bump commit `a391479e`.
   - The deploy script auto-created `a391479e` during promotion.
   - The implementation commit `48b0769a` was created after promotion.
   - Determine whether production artifact was rsynced from the dirty worktree before `48b0769a` and therefore contains the code, or whether another deploy is required so `GIT_COMMIT` and artifact provenance match.
   - Report exact evidence from deploy scripts, git logs, server metadata if available, and release docs.

2. Check whether staging being left on `v4.14.169` while production is `v4.14.170` is acceptable for this release.
   - `promote-to-prod.sh` reported staging remains on `v4.14.169`.
   - Decide whether docs should instruct a follow-up staging sync or whether this is expected.

3. Check whether smoke evidence filenames using `75db3026` are misleading now that the final implementation commit is `48b0769a` and production commit marker is `a391479e`.
   - If misleading, recommend a docs/evidence naming correction.

### Pricing And Quota Correctness

4. Trace every writer to `api_usage`.
   - Verify each row records provider, model, input tokens, output tokens, cache tokens where supported, `cost_usd`, `pricing_status`, and `pricing_model_key` when schema supports it.
   - Confirm unknown models cannot write `cost_usd=0` in production paths.
   - Confirm no provider path still contains an authoritative duplicate pricing table.

5. Validate central registry semantics.
   - Exact model match should work.
   - Future variants like `gpt-5-pro`, `gpt-5-thinking`, `gemini-2.5-flash-pro`, or unknown dated suffixes should not silently inherit base model pricing unless an explicit `acceptVariantSuffix` entry allows it.
   - Verify unresolved pricing emits deduped alerts and does not create log spam.

6. Check the sentinel pricing tradeoff.
   - Confirm Sonnet-4.6 ceiling rates are high enough for current production models.
   - Confirm unresolved sentinel cost is acceptable for quota enforcement and cannot overblock a large number of users without operator visibility.

7. Reconcile estimator vs metered cost.
   - Planner estimates are pre-call; provider rows are post-call.
   - Verify post-call settlement/debit corrects cap crossing and cannot double-debit.
   - Find any path that checks budget using estimates but never reconciles actual cost.

### Nexus Points Ledger

8. Verify purchase grant idempotency.
   - Duplicate Apple transaction id should not double-grant.
   - Apple original transaction id vs transaction id should not create refund/revoke gaps.

9. Verify FIFO debit and expiry.
   - Oldest active credit debits first.
   - Expired credits do not count.
   - Daily expiry sweep covers all users and does not require a user-scoped read first.

10. Verify settlement atomicity.
   - `settleNexusPointOverageForUser` should use a transaction.
   - `nexus_point_debits.api_usage_id` uniqueness should make duplicate settlement idempotent.
   - Race two settlements for the same usage row and verify only one debit row.

11. Verify day-boundary behavior.
   - An `api_usage` row before UTC midnight settled after UTC midnight should still debit the correct overage.
   - Confirm settlement scopes to the usage row's day, not `date('now')`.

12. Verify tenant/user isolation.
   - Points are user-scoped today. Confirm that matches current tenant model.
   - Identify any future account-merge or business/personal tenant transfer risk.

### Billing, Apple, Portal, And API Contracts

13. Verify Apple IAP separation.
   - Point product IDs must update the point ledger only.
   - Subscription product IDs must update subscriptions only.
   - Unknown product IDs should fail closed.

14. Verify Apple refund/revoke handling.
   - Find exact code path that marks credits `refunded` or `revoked`.
   - Check whether consumed points are clawed back, ignored, or recorded as a negative balance risk.
   - Verify remaining credit is not usable after refund/revoke.

15. Verify billing status and quota-exceeded payload shape.
   - `/billing/status` and chat 429 responses should use the same canonical package metadata and remaining allowance fields.
   - Confirm iOS can render the payload without exposing raw provider tokens as app copy.

16. Verify portal admin auth.
   - Every route that reads/writes plan caps or per-user AI overrides must require portal admin/operator auth.
   - Check `src/portal/user-routes.ts`, `src/portal/provider-routes.ts`, and related tests.

17. Verify rollback compatibility.
   - Older code after migrations should still be able to insert `api_usage` rows.
   - Historical rows should be `legacy`, not incorrectly marked `resolved`.

### Chat Runtime Behavior

18. Verify quota gate order.
   - Paid AI planner/reasoning/provider calls should not happen before quota is checked.
   - Token-zero deterministic shortcut reads should still be allowed after quota exhaustion.
   - Confirm streaming paths also debit the real user and do not use `userId=0`.

19. Verify action mutation guarantees.
   - No model-generated "done" message should be shown before deterministic executor success.
   - Confirm quota-exceeded path does not let an action planner call slip through.

20. Verify direct provider calls outside chat.
   - Search callers of OpenAI/Gemini/Anthropic completion helpers.
   - Any high-volume or user-triggered provider call outside `chat-message-routes.ts` should have quota enforcement or a clear reason why not.

### Observability And Ops

21. Verify operator alerts.
   - Unresolved pricing should create an actionable alert.
   - Alert dedupe should be per provider/model/hour or equivalent, not permanent for process lifetime if ops need recurring signal.

22. Verify dashboard/reporting.
   - Portal/dashboard cost numbers should include Nexus Point debits and unresolved sentinel cost.
   - `src/tools/model-pricing-report.ts` should surface unknown models and stale/unused registry entries.

23. Verify cache-token claims.
   - OpenAI `prompt_tokens_details.cached_tokens` and Gemini `cachedContentTokenCount` should be captured when present.
   - Confirm no claim says cache savings are realized unless the provider call actually uses cache/prompt cache settings.

24. Verify logging hygiene.
   - No full Apple receipt/JWS, provider prompts, raw user message body, API keys, or provider error payloads should leak in new logs.

### Test Quality And Gaps

25. Review tests for over-mocking.
   - Especially `__tests__/services/nexus-points.test.ts`, provider tests, and billing route tests.
   - Flag tests that only assert mocks were called but do not prove database state.

26. Review the fixed `__tests__/api/chat-routes.test.ts` assertion.
   - Codex narrowed a brittle full-body regex to `messageRes.body.text`.
   - Confirm this still catches the intended regression without depending on random message ids.

27. Re-run focused tests and report counts.
   - If you cannot run all gates, state exactly why.

## Suggested Commands

Start with:

```bash
pwd
git status --short
git log --oneline -8
git show --stat 48b0769a
git diff --stat a391479e..48b0769a
```

Searches:

```bash
rg -n "INSERT INTO api_usage|cost_usd|pricing_status|pricing_model_key|computeModelUsageCostUsd|estimateModelCostUsd" src __tests__ scripts
rg -n "nexus_point_credits|nexus_point_debits|settleNexusPointOverageForUser|debitNexusPoints|grantNexusPoints|refund|revoke" src __tests__ migrations
rg -n "sendChatQuotaExceededIfNeeded|tryHandleChatActionPlan|tryHandleChatReasoningAction|tryBuildTokenZeroChatMessageShortcutResponse|stream" src/api src/services __tests__
rg -n "NEXUS_POINT|points.small|points.medium|points.large|productId|original_transaction|transaction_id" src __tests__ docs
rg -n "OPENAI_COST_PER_MTK|GEMINI|ANTHROPIC|\\$0\\.04|\\$0\\.06|0\\.04/day|0\\.06/day|0\\.20/day|0\\.60/day" src __tests__ docs scripts migrations
```

Verification:

```bash
npx tsc --noEmit
npx vitest run \
  __tests__/services/nexus-points.test.ts \
  __tests__/services/cost-guardrail.test.ts \
  __tests__/services/cost-validation.test.ts \
  __tests__/api/billing-routes.test.ts \
  __tests__/api/chat-routes.test.ts \
  __tests__/api/chat-message-request.test.ts \
  __tests__/api/internal-routes.test.ts \
  __tests__/portal/portal-user-routes.test.ts \
  __tests__/portal/portal-provider-routes.test.ts \
  __tests__/services/gemini-provider.test.ts \
  __tests__/services/openai-provider.test.ts \
  __tests__/services/usage-metering-qa-validation.test.ts \
  __tests__/security/billing-apple-notifications-jws-verify.test.ts
npm run verify
STAGING=true npx tsx src/tools/chat-model-bakeoff.ts
npx tsx src/tools/model-pricing-report.ts
npx tsx scripts/chat-cost-scenarios.ts
```

Do not run deploy/promote commands unless Felipe explicitly asks. For live health, read-only curls are acceptable:

```bash
curl -sS -D - https://api.nexushub.me/health | head -c 1200
```

## Deliverable Format

Return a concise QA report with:

1. Verdict: pass / pass with issues / fail.
2. Findings ordered by severity.
3. For each finding:
   - severity
   - file:line
   - evidence command/result
   - why it matters
   - recommended fix
4. Verification commands run and exact result counts.
5. Any claims you could not verify and why.
6. Explicit answer to the deployment provenance question:
   - Is production artifact aligned with `48b0769a`?
   - Is another staging deploy/promote required?

