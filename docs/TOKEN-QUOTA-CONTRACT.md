# AI Entitlement and Quota Contract

Status: canonical
Owner: backend cost-guardrail lead (Felipe)
Last verified: 2026-08-18
Update policy: update when entitlement eligibility, AI budget windows, public
quota fields, Nexus Points rules, or provider-call attribution changes.

Rollout state: implemented on the paid-AI cost-controls worktree. This document
does not assert staging or production deployment. Runtime truth remains in
`/var/lib/nexus-release/state/release-state.json` and the immutable receipts
under `/var/lib/nexus-release/receipts/`; checked-in release summaries are
historical, non-authoritative projections.

This is the canonical contract for model-backed access. Deterministic Secretary
reads and actions are token-zero and remain available independently of AI
eligibility or quota state.

The owner-approved target entitlement model (credit-based plans, packs, and
routing) is defined in `docs/release/hybrid-ai-commerce-production-plan.md`.
This contract remains the runtime authority until that plan's credit ledger
ships and is activated.

## Eligibility is the authority

`src/services/entitlement.ts#getEffectiveEntitlement()` is the only authority
for model access, automation access, Nexus Points eligibility, billing windows,
and effective plan. Never make an AI decision from `users.tier`.

| Entitlement | Interactive AI | Automations | Nexus Points overage |
| --- | --- | --- | --- |
| Active Apple/Stripe Pro or Max | yes | yes | yes |
| Founder assigned Pro or Max | yes | yes | yes |
| Apple/Stripe `trialing` | yes | no | no |
| Free, beta/manual grant, expired, past-due | no | no | no |
| Owner | yes | off by default | no |

Owner automation requires `OWNER_AI_AUTOMATIONS_ENABLED=true`. A missing or
invalid Apple/Stripe billing period fails closed for cost-bearing work. Founder
and system windows use UTC calendar months.

Owner AI identity must match the explicit `OWNER_TELEGRAM_ID` bootstrap
identity. A stale `users.tier='owner'` row is not sufficient to grant model
access.

Blocking is rollout-gated by
`PAID_AI_COST_CONTROLS_ENFORCEMENT_ENABLED=true`. The default is observe-only so
the additive schema, attribution, and public fields can land before staging
policy activation. Production enablement is a separate owner-authorized step.

The additive `UserEntitlement` fields used by callers are:

```typescript
interface UserEntitlement {
  plan: 'free' | 'beta' | 'pro' | 'max' | 'owner';
  source: 'owner' | 'founder' | 'apple' | 'stripe' | 'beta' | 'free' | 'error';
  status: 'active' | 'trialing' | 'past_due' | 'expired' | 'none';
  subscriptionStatus: string | null;
  subscriptionProvider: string | null;
  billingPeriodStart: string | null;
  billingPeriodEnd: string | null;
  aiAccessAllowed: boolean;
  automationAllowed: boolean;
  nexusPointsAllowed: boolean;
  blockReason: string | null;
  automationBlockReason: string | null;
  dailyCostCapUsd: number;
  monthlyCostCapUsd: number;
  allowedSkills: ReadonlySet<string>;
}
```

An entitlement lookup error returns a blocked `source='error'` result. Feature
access and model access are separate: Free retains the Secretary product
surface, while active legacy beta/manual grants retain their former Max-style
product skills (`secretary`, `triathlon`, `training`, `content`, `cooking`, and
`finance`). Neither product grant permits a provider call; expired/inactive
grants resolve to Free.

## Included AI budgets

Cost-equivalent provider usage is the hard enforcement unit. It includes token
charges and separately billed provider-hosted search/grounding tools. Raw token
and message counts remain telemetry only.

Subscription display prices remain Pro at `$9.99` and Max at `$14.99`;
included AI cost is bounded independently by both daily and monthly windows.

| Plan | Daily included | Monthly included | Automation ceiling |
| --- | ---: | ---: | ---: |
| Pro | $0.04 | $1.20 | $0.012/day and $0.36/month |
| Max | $0.06 | $1.80 | $0.018/day and $0.54/month |
| Founder | assigned Pro/Max limits | assigned Pro/Max limits | same 30% ceiling |
| Free and beta/manual | $0 | $0 | disabled |
| System jobs | $0.10 | $0.30 | no Nexus Points |
| Owner | internal cap | internal monthly cap | disabled unless explicitly enabled |

- Daily windows reset at 00:00 UTC.
- Apple/Stripe monthly windows use the active subscription's
  `current_period_start` and `current_period_end`.
- Founder, owner, and system windows use UTC calendar months.
- Unused automation allowance remains available for interactive usage.
- Automation spend must stay within 30% of both the daily and monthly included
  windows. Coach has first priority, then scheduled Content, then Channel
  Learning. Lower-priority work preserves one expected Coach reservation.

The canonical plan values live in `plan_configs.daily_cost_usd` and
`plan_configs.monthly_cost_usd`. Active user overrides live in
`user_ai_budget_overrides`; overrides can set daily and monthly caps but cannot
make an ineligible entitlement eligible. Free and beta/manual effective caps
are immutable zeroes: stale positive plan rows, runtime setters, and dormant
per-user overrides are ignored until a canonical paid/founder entitlement is
eligible.

Local-primary model operations are admitted separately from cloud dollars.
`plan_configs` owns hourly/daily local operations, long-form script counts,
active Content jobs, ordinary and Content context ceilings, per-section output
ceilings, queue weight, and hard local-to-cloud fallback ceilings. Pro defaults
are 20/hour, 100/day, 6 scripts/day, one active job, 8K ordinary/12K Content
context, 5,120 output tokens per section, queue weight 1, and `$0.15` per
fallback run/`$0.40` per UTC day. Max defaults are 40/hour, 200/day, 20
scripts/day, two active jobs, 12K ordinary/16K Content context, 6,144 output
tokens per section, queue weight 2, and `$0.25` per run/`$0.60` per UTC day.
Owner defaults are `$2.00` per run and `$10.00` per UTC day. The per-section
value applies only to Content;
ordinary Chat and every non-Content skill output is hard-capped at 4,096 tokens
for Pro, Max, and owner. Owner Content sections share the 6,144-token ceiling.
One user-visible operation consumes one fair-use
unit; internal sections, repairs, and continuations remain telemetry but do not
consume extra operations. A failed capacity admission (`LOCAL_CAPACITY_BUSY`,
`LOCAL_QUEUE_FULL`, or `LOCAL_QUEUE_DEADLINE`) remains telemetry but consumes
no operation unit; a user cancellation after admission does consume the unit.
Local Ollama attempts retain `cost_usd=0` and
`local_request_units=1`. Creating a long-form job consumes its daily script
operation once it can be admitted to work; cancellation does not refund that
daily operation, although cancelled jobs no longer occupy an active-job slot.
The owner plan API reads, bounds, updates, and audits every local field,
including both fallback ceilings; no runtime caller may substitute an
environment-only value.

Cloud allowance is not a prerequisite for local admission. It is checked only
after a local failure is eligible for fallback and immediately before a
concrete cloud provider attempt. That boundary enforces entitlement, privacy,
the ordinary daily/monthly cloud windows, and the additional per-run/per-day
local-fallback ceilings. A durable provider-attempt reservation records the
provider/model maximum before dispatch, so retries, sequential fallback hops,
and concurrent callbacks cannot each spend the same remaining headroom.

Long-form Content jobs are private and local-only in the first rollout. They
persist the encrypted pinned creator voice and supplied sources, outline, and
each validated section under one user-visible operation. No cloud budget is
reserved for those stages, and no legacy internal attribution token can
authorize fallback. Cloud fallback for a job remains
disabled until a server-authenticated redaction and escalation claim is stored
with that job; synchronous legacy Content generation retains its existing cloud
budget path.

The same privacy boundary applies to enrolled private Content rewrite/expand,
Chat Content refinement, and local specialist-group calls. After local
admission they do not reserve cloud dollars or export their payload on local
failure; invalid output is withheld and the request degrades, fails visibly,
or remains resumable. With local routing OFF or outside the enrolled cohort,
the pre-existing cloud path retains its normal entitlement, privacy, and
atomic budget guard.

The proposed `$9.99` Pro and `$14.99` Max prices are not active pricing. They
require the separately governed 30-day quality, reliability, local-share,
fallback, contribution-margin, and live Stripe/App Store proof. Until that
owner transaction succeeds, the display prices and billing products remain
`$14.99` and `$19.99`.

Chat, Content specialist batching, script jobs, and automatic rollback have
separate default-OFF environment controls documented in
`docs/engineering/local-primary-inference-standard.md`. Runtime mode remains
the authoritative audited admission switch. Owner reporting exposes actual
cloud/tool spend separately from clearly labelled counterfactual savings.

## Atomic provider-call guard

Every provider call must execute through the SQLite-locked budget wrapper.
Inside one user-scoped lock, it must:

1. Resolve the canonical entitlement and window.
2. Classify the request as `interactive`, `automation`, or `system`.
3. Reserve 125% of the workload-wide (`request_source` + `base_category`)
   rolling 30-day p95 cost, using centrally configured conservative defaults
   when history is absent. The active partial run is not a history sample;
   later stages reserve only the unspent remainder of the 125% whole-run
   envelope, with a conservative unexpected-stage floor.
4. Check daily, monthly, and (for background work) automation headroom before
   every concrete provider attempt. Governed local-to-cloud work additionally
   checks the active plan's hard run and UTC-day fallback ceilings against both
   settled usage and durable in-flight provider-attempt reservations.
   Automation also supplies the full-quality request's provider-enforced
   maximum cost as a floor, so a call defers rather than crossing either 30%
   ceiling.
5. Invoke the provider only when allowed. Opaque SDK retries are disabled where
   the runtime has an explicit retry loop, so each retry repeats the check.
6. Persist actual `api_usage` before releasing the lock and settle only an
   eligible interactive Nexus Points overage.

`api_usage` is quota truth. `usage_metering` is retained for analytics and must
not block a request. Provider writes add:

- `request_source`
- `job_name`
- `base_category`
- `run_id`
- `provider_tool_cost_usd`
- `web_search_requests`
- `grounded_search_prompts`

`ai_provider_attempt_reservations` is conservative dispatch evidence for hard
run/job/fallback ceilings, not a second billed-usage ledger. Reservations stay
committed because a timed-out or abandoned provider request may still be
billed; actual invoices and `api_usage` remain economics truth.

Anthropic and OpenAI web search are metered at their per-call list prices;
Gemini grounding is metered at its post-free-tier per-prompt list price. The
Gemini free allowance is project-wide and may be consumed outside this runtime,
so it is not allocated to individual user budgets by default. An operator may
override the centralized fee only after independently guaranteeing project
isolation and tracking the shared allowance. Unknown provider models fail
preflight closed until a hard price is registered; the unresolved-model
sentinel remains an analytics fallback, not a dispatch ceiling.
Gemini token cost includes the SDK's separate tool-result input tokens and
thinking output tokens; unexplained positive `totalTokenCount` remainder is
conservatively booked as output rather than discarded.

Provider fallback suffixes must not split the base workload category. Scheduled
and system work never consumes Nexus Points.

The rolling p95 reservation history is intentionally workload-wide by request
source and normalized base category, not tenant-specific. This gives new and
low-volume tenants a conservative shared envelope; it is not a tenant cost
allocation metric and must not be exposed as one.

## Nexus Points

Nexus Points extend interactive usage only for active paid/founder users. They
do not unlock Free, beta/manual, trial, expired, or past-due access and they do
not fund automations or system jobs.

| Package | Product ID | Price | Points | AI allowance | Expiry |
| --- | --- | ---: | ---: | ---: | --- |
| Small | `me.nexushub.points.small` | $4.99 | 100 | $0.10 | 30 days |
| Medium | `me.nexushub.points.medium` | $9.99 | 250 | $0.25 | 30 days |
| Large | `me.nexushub.points.large` | $19.99 | 600 | $0.60 | 30 days |

`1 Nexus Point = $0.001` of internal provider-cost allowance. App copy uses
Nexus Points rather than raw tokens or dollar values.

## Public billing and status payload

Billing/status responses preserve the legacy fields and add the following
fields. Exact cost values are owner/admin-only.

```json
{
  "enforcementEnabled": false,
  "aiAccessAllowed": true,
  "blockReason": null,
  "dailyUsageFraction": 0.45,
  "dailyUsagePercent": 45,
  "dailyIsOverLimit": false,
  "dailyResetsAt": "2026-07-10T00:00:00.000Z",
  "monthlyUsageFraction": 0.31,
  "monthlyUsagePercent": 31,
  "monthlyIsOverLimit": false,
  "monthlyResetsAt": "2026-08-01T00:00:00.000Z",
  "unblocksAt": null,
  "usageFraction": 0.45,
  "usagePercent": 45,
  "isOverLimit": false,
  "resetAt": "2026-07-10T00:00:00.000Z",
  "resetsAt": "2026-07-10T00:00:00.000Z"
}
```

Legacy `usageFraction` and `usagePercent` represent the maximum of the daily and
monthly fractions. Legacy `isOverLimit` remains the effective blocking verdict,
so it stays false while an eligible interactive user still has Nexus Points
headroom even if an included-window flag is true. `unblocksAt` is the
authoritative reset for a blocked request; plan blocks have no time-based
unblock and therefore return it as `null`.

iOS treats absent/false `enforcementEnabled` as observe-only during rollout;
stable plan/quota errors from the server remain authoritative.

All timestamps are ISO-8601 UTC. Optional iOS decoding must retain conservative
defaults when a cached or older server payload lacks the additive fields.

## Stable model-access errors

Cost-bearing routes use these stable codes:

| HTTP | Code | Meaning |
| ---: | --- | --- |
| 403 | `AI_PLAN_REQUIRED` | entitlement cannot use model-backed AI |
| 429 | `AI_DAILY_LIMIT_REACHED` | daily included/eligible overage is exhausted |
| 429 | `AI_MONTHLY_LIMIT_REACHED` | monthly included/eligible overage is exhausted |
| 429 | `SERVICE_DEGRADED` | global cost breaker or budget-lock/metering/reservation-integrity protection is active |

Every stable 429 includes `Retry-After`. Daily, monthly, and global-budget
denials derive it from the known reset. Lock, usage-persistence, or outer
reservation-marker failures use a bounded 60-second retry when no deterministic
reset exists. Responses expose the relevant `window`, reset timestamp, and
`unblocksAt` when known, and never expose dollar values. iOS maps the codes to
upgrade, daily-reset, monthly-reset, or service-degradation messaging.
WebSocket errors use the same codes and details.

Content Engine calls preserve this contract across both service hops. Python
forwards the original status, code, safe details, and `Retry-After`; the
TypeScript client reconstructs the stable denial and never retries it. JSON and
script repair calls reuse the original signed category, source, and run so they
remain inside the same outer reservation instead of becoming system spend.

Token-zero routes are evaluated before the model gate where a mixed endpoint
contains both deterministic and model-backed behavior.

## Workload policy

- Coach retains the last valid report when deferred and emits no more than one
  notice per blocked window.
- Scheduled Content requires eligible automation entitlement and Content access,
  fills only missing seven-day pending inventory, and produces Friday's package
  in one validated JSON call with strict within-batch deduplication. Grounded
  interactive research starts with one provider-capped, low-context OpenAI
  search while enforcement is active and can compare Gemini only after a
  non-budget provider failure. Because provider-injected search context has no
  contractual token ceiling, scheduled generation never uses hosted search
  under enforcement: it reuses fresh signals or switches to an explicitly
  evergreen prompt rather than claiming current grounding.
- Channel Learning skips ineligible user scopes before YouTube/provider work,
  runs shared platform scope only when an eligible Content user consumes that
  knowledge, preserves fingerprint/backoff skips, and performs one validated
  synthesis call per changed scope.
  The current consumer-evidence query and `synthesizeKnowledge` user scope use
  `tenant_id = user_id`; shared Channel Learning is therefore limited to the
  default single-user tenant mapping. Multi-user tenant sharing must not be
  enabled until those entry points accept and propagate an explicit tenant ID.
- Production Autoresearch runs `evaluate_only`, only for changed prompt/eval
  hashes, with local deterministic checks and batched semantic scoring. It never
  writes prompts or runs Git operations.

## Admin and portal surface

- `GET /api/plans` returns daily and monthly plan caps plus telemetry limits.
- `PUT /api/plans/:planId` updates daily/monthly caps and in-memory overrides;
  the Free row is display-only for cost because both caps must remain zero.
- `GET /api/users/:userId/ai-budget` returns exact effective caps, daily/monthly
  progress, automation share, entitlement state, active override, and recent
  skip reasons to an authorized portal admin.
- `PUT /api/users/:userId/limits` accepts daily and monthly AI overrides.
- Portal `users.tier` labels and token/message counters are legacy telemetry;
  the adjacent effective-plan/entitlement panel is the access authority.

Plan and user mutations are audited. Portal exact-cost reads and writes require
`PORTAL_ADMIN_TOKEN` (or an equivalent signed admin session). Public app routes
must never reuse the admin budget shape.

## Verification requirements

Tests must cover Free and beta zero-provider behavior, trial interactive-only
behavior, active/founder billing windows, invalid paid bounds, stale
`users.tier`, dormant Points, daily/monthly rollover, concurrent reservations,
automation ceilings, no background Points debit, token-zero availability, and
the stable HTTP/WebSocket contracts.

Backend deployment evidence follows the recovery-first release contract:
classifier-selected protected-main CI, signed OCI artifacts, exact-candidate
staging, and validated root-host state and immutable receipts. Changed shared
app contracts run backend fixture checks; iOS build and device evidence belong
to the iOS distribution cadence and are not a backend deployment gate. Manual
infrastructure or maintenance mutations still require separate owner
authorization; ordinary governed continuous deployment does not.
