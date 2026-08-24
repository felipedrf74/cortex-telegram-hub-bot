# Nexus Hub Hybrid AI, Pricing, Commerce, Security, and Production Plan

Status: owner-approved (canonical implementation plan)
Owner: Felipe Dominguez
Canonicalized: 2026-08-18
Original attachment:
`/Users/felipedominguez/.codex/attachments/79c27f9e-60a7-4177-be0b-4ed3922a25b8/pasted-text.txt`
Scope: backend, iOS, website, providers, billing, local inference, release
Activation status: default OFF pending same-release verification evidence
Update policy: locked decisions change only with explicit owner approval; the
canonicalization addenda at the end record post-approval owner decisions.

The body below reproduces the owner-approved plan verbatim.

---

## 1. Locked product and AI decisions

Nexus Hub will use a blended AI stack:

| Workload | Primary route | Fallback |
|---|---|---|
| Free-user AI | Local model only | Retry/capacity response; never cloud |
| Intent, classification, summaries, lightweight skills | Local model | Gemini 3.1 Flash-Lite |
| Standard script | GPT-5.6 Luna Flex | Approved cloud fallback |
| Scheduled script | GPT-5.6 Luna Batch | Luna Flex |
| Priority script | Luna Standard/Fast | Approved immediate cloud route |
| Deep or guarded reasoning | Approved cloud reasoning model | Existing provider abstraction |
| Current facts | Model plus verified search/tool | Visible failure if unavailable |
| Writes and actions | Deterministic Nexus tools | Never direct model execution |

User-facing script labels remain:

- Standard: “We’ll notify you when your script is ready.”
- Scheduled: “Have it ready tomorrow.”
- Priority: “Starts immediately.”

Provider and model names—including “Luna”—will not appear in product marketing or delivery labels.

### Local-model evaluation and migration

Qwen 2.5 3B remains the current control, but the implementation must include an actual bakeoff and conditional production migration.

Evaluation order:

1. Qwen3.5 9B
2. Ministral 3 14B
3. Gemma 3 12B
4. gpt-oss 20B
5. Qwen 2.5 3B as the control

Kimi K3 C remains offline research only.

The bakeoff will minimize unnecessary generation:

- First pass: 24 compact representative cases per candidate covering all six internal inference profiles behind the five user-facing skills, three supported language patterns, schemas, and runtime.
- Final pass: the top two candidates plus Qwen on a focused set of medium tasks, Content outlines/sections, tool plans, and 100 compact JSON-schema checks.
- Reuse approved historical fixtures and cloud outputs. Do not regenerate a cloud baseline when valid evidence already exists.
- Do not generate complete 15-minute scripts separately for every local candidate.
- Cap output tokens per benchmark case to the minimum needed to judge correctness.

A challenger qualifies as a reasonable production improvement only if it:

- Scores at least 75/100 overall and either beats Qwen by at least eight points or finishes within 5% of the approved cloud baseline.
- Wins at least 60% of blind paired comparisons against Qwen.
- Produces at least 99% valid schemas and has no critical skill category more than 5% worse than Qwen.
- Averages at least four generated tokens/second and respects the 20GB/zero-swap production envelope.
- Produces zero tenant-isolation, privacy, authorization, or safety failures.

Select the highest-quality qualifying model; use lower p95 latency only as a tiebreaker.

If a challenger qualifies:

- Update the signed production model manifest with its immutable digest, quantization, prompt format, runtime version, context policy, license evidence, and rollback metadata.
- Migrate all six specialist profiles and run production smoke verification.
- Keep Qwen temporarily during activation, then remove Qwen and every rejected bakeoff model after the production smoke passes.

If no challenger qualifies:

- Keep Qwen 2.5 3B as the only installed Nexus model.
- Limit it to Free, classification, orchestration, summaries, and other quality-approved lightweight work.
- Remove every downloaded challenger after recording its benchmark result and immutable metadata.

Cleanup must target only models downloaded for the Nexus bakeoff and the explicitly superseded Nexus model. Inventory and digest-check each target before removal; unrelated host models are not deleted.

### Local runtime

| Control | Production |
|---|---:|
| CPU quota | 8 CPUs |
| `MemoryHigh` | 18GB |
| `MemoryMax` | 20GB |
| Benchmark maximum | 24GB |
| Required host headroom | 6GB |
| Swap | Disabled |
| Active generation | 1 |
| Interactive waiting queue | 4 |
| Maximum context | 16K |
| Resident models after cleanup | 1 |

Docker reaches host Ollama through a signed, least-privilege Unix-socket gateway. The gateway has separate staging/production sockets, no application secrets or database access, model/path allowlists, dropped capabilities, immutable digest enforcement, and strict body, response, deadline, and resource limits.

## 2. Plans, shared credits, scripts, and purchases

### Subscriptions

| Capability | Free | Pro — $9.99 | Max — $14.99 |
|---|---:|---:|---:|
| Monthly AI credits | 60 local-only | 500 shared | 1,200 shared |
| Daily credit cap | 5 | 50 | 100 |
| Standard chat/skill operation | 1 credit | 1 credit | 1 credit |
| Deep reasoning/research | Unavailable | 3 credits | 3 credits |
| Standard/scheduled 15-minute script | Unavailable | 10 credits | 10 credits |
| Priority 15-minute script | Unavailable | 12 credits | 12 credits |
| Daily long-form scripts | 0 | 2 | 4 |
| Active Content jobs | 0 | 1 | 2 |
| Ordinary context | Local policy | 8K | 12K |
| Content/research context | Local policy | 12K | 16K |
| Queue weight | Free capacity | 1 | 2 |

Credits use one shared pool:

- Thirty Pro standard scripts consume 300 credits and leave 200 standard interactions.
- Sixty Max standard scripts consume 600 credits and leave 600 standard interactions.
- “Up to 30/60 scripts from included credits” is an illustration, not a protected script bucket.
- Purchased credits permit additional scripts subject to daily and active-job limits.
- Annual plans remain hidden from new purchase until separately approved; historical receipts and renewals remain supported.

### Credit ledger

Credits are reserved atomically when an operation is admitted, captured once after a validated user-visible result, and released on cancellation or failure. Internal sections, retries, continuations, repairs, validation, or provider fallback never charge the user twice.

Included monthly credits reset and do not roll over. Promotional credits expire after a configured 30, 60, or maximum 90 days. Purchased credits never expire. Debit order is monthly credits, nearest-expiry promotional credits, then purchased credits FIFO.

Insufficient balance returns the exact required and available amount plus an eligible pack CTA. The request does not start. Purchased credits do not bypass daily limits; audited, time-limited administrative overrides are reserved for support or incident recovery.

### AI-credit packs

| Pack | Price |
|---|---:|
| 100 credits | $4.99 |
| 250 credits | $9.99 |
| 600 credits | $19.99 |

Packs require an authenticated, active Pro or Max subscription. Refunds, revocations, disputes, and chargebacks affect only the originating credit lot and cannot corrupt other balances.

### Content generation

A 15-minute script targets 1,900–2,400 spoken words and uses a durable background job:

1. Pin request, sources, language, voice profile, route, and model version.
2. Generate a validated outline with per-section word budgets.
3. Generate and checkpoint validated sections.
4. Assemble and validate the final artifact deterministically.
5. Repair an invalid section once, then use an eligible fallback at that uncommitted checkpoint or return a reviewable failure.

Per-section output ceilings are 5,120 tokens for Pro and 6,144 for Max. Reaching the ceiling triggers continuation from the last validated boundary, never silent truncation.

Owner privacy decision (2026-08-21): packets from the resumable script-job
path, including short Reel jobs, are classified as non-sensitive and may be
sent to an approved OpenAI route when
local-primary inference needs an authorized cloud delivery or fallback path.
This narrow exception does not cover private Content history, rewrites,
refinements, specialist work, or Finance, Training, Triathlon, and Secretary
data; those retain their existing minimization and cloud-authority controls.

The seven Content roles execute in four dependency groups while preserving separate role outputs, provenance, summaries, and validation:

| Group | Roles |
|---|---|
| 1 | Strategy and Research |
| 2 | Writer |
| 3 | Structural Editor, Factuality, Platform Adapter |
| 4 | Quality Reviewer |

## 3. Interfaces, commerce, and migration

Preserve existing Chat, WebSocket, Content history, confirmation, idempotency, and read-back contracts. Complete the async Content endpoints:

- `POST /api/v1/content/script-jobs`
- `GET /api/v1/content/script-jobs/:jobId`
- `POST /api/v1/content/script-jobs/:jobId/cancel`
- `POST /api/v1/content/script-jobs/:jobId/retry`

Job states are `queued`, `running`, `waiting_capacity`, `completed`, `failed`, and `cancelled`.

Add an authenticated server-owned billing catalog, subscription/pack checkout contracts, and a wallet response separating included, promotional, purchased, reserved, and available credits. Clients submit catalog item IDs only; they cannot select amounts, price IDs, providers, models, credit quantities, or account ownership.

### Stripe and website

- Require authentication before subscription or credit-pack checkout.
- Display Pro $9.99, Max $14.99, five user-facing skills (Training includes the Triathlon profile), shared credits, script delivery modes, and the three packs.
- Remove stale $14.99/$19.99 pricing, “unlimited” claims, duplicate sixth-skill descriptions, Power Packs, and hardcoded regional prices.
- Use new Stripe Price objects with explicit `tax_behavior=exclusive` and Products classified as personal-use SaaS (`txcd_10103000`). Provisioning repairs the Product tax code before it reuses an existing Price. Every subscription, AI-credit pack, and retained Nexus Points Checkout Session enables Stripe automatic tax, and reused customers update their stored address from Checkout. Retained externally provisioned Nexus Points Prices must also be active, exclusive, and attached to a Product with that tax code. Archive old prices from new sale while preserving historical billing and webhook compatibility.
- Keep new subscription checkout closed unless `SUBSCRIPTION_CHECKOUT_ENABLED=true`, both runtime stop controls are disengaged, `STRIPE_EXPECTED_ACCOUNT_ID` is valid, and canonical plan slots do not contain webhook-only historical Price IDs. Before creating any Checkout Session, retrieve the key's own Stripe account and require an exact match. A configured Price ID alone never opens sales.
- Keep built-in historical monthly subscription Price IDs and operator-configured `STRIPE_PRICE_PRO_MONTHLY`/`STRIPE_PRICE_MAX_MONTHLY` bindings for signed-webhook renewal recognition only. Reject them from canonical checkout slots, and emit a critical operator alert for any other unknown signed subscription Price.
- Convert Stripe account-binding, Price/tax-readiness, and Checkout-provider failures into a controlled `503` response and a safe operator alert; never expose the provider response to the client.
- Keep checkout success in `processing` until the signed webhook fulfills it; provide Stripe Customer Portal for web-managed subscriptions.

Anonymous email checkout stops accepting new sessions at launch. Existing in-flight claim sessions remain behind a compatibility flag for 30 days, after which the path is disabled. Previously verified subscriptions remain valid.

### Apple

Retain existing monthly subscription identifiers for webhook/renewal recognition only, plus historical yearly receipt support; never route a new checkout through those identifiers. Put Pro and Max in the same subscription group with Max ranked above Pro. Create new versioned consumable IDs for the three AI-credit packs rather than changing the economics of old points products.

iOS prices come dynamically from StoreKit. In-app digital purchases use StoreKit and never redirect to Stripe. Web-bought entitlements remain usable in iOS, while equivalent products remain available through IAP.

Migrate purchased credit lots to nonexpiring. Restore identifiable unspent expired Apple lots unless refunded or revoked. Replace best-effort Apple notification acknowledgement with verified JWS processing, a durable inbox, error responses that permit retries, and scheduled App Store reconciliation.

The required real sandbox proof runs against the isolated staging backend with
`APPLE_ALLOW_SANDBOX_GRANTS=true`, the exact production bundle and product IDs,
and an Apple-signed StoreKit JWS. Production keeps that switch false. The test
must prove one credit grant, exact transaction/account binding, idempotent
replay, and a retained retry for every unrecognized or refused outcome before
the production fulfillment switch is enabled.

The website App Store CTA has `unavailable`, `approved`, and `public` states. The official badge and allowlisted `apps.apple.com` URL activate only after the listing is independently verified. Apple review latency does not block backend and web production launch, but the iOS public-release item remains externally pending until Apple approves it.

## 4. Security and margin controls

### Security controls

| Area | Required behavior |
|---|---|
| Identity and tenancy | Derive ownership from authenticated context; bind Apple transactions with `appAccountToken`; reject client-supplied ownership |
| Money and credits | Append-only lots, atomic reserve/capture/release, unique provider events, durable webhook inboxes, idempotency, and daily reconciliation |
| Model safety | Model output never executes tools directly; deterministic capability checks, confirmations, execution, and read-back remain authoritative |
| Privacy | Sensitive Finance, Training, Triathlon, Secretary, and private Content data require minimization and explicit cloud-routing authority; the owner-classified non-sensitive resumable script-job packet follows the narrow §2 exception |
| Infrastructure | Signed OCI/model digests, SBOM and secret scanning, encrypted storage/backups, CSP/HSTS/CSRF, strict redirect allowlists, rate limits, and independent kill switches |

Do not log private prompts, scripts, financial values, calendar contents, receipts, tokens, provider payloads, or secrets. Push notifications use generic messages such as “Your script is ready.”

Rotate credentials previously pasted into chat before production. Production access uses SSH keys, MFA, and managed secrets; no password is placed in automation, CI, logs, receipts, or repository files.

Default retention is 30 days for private job material, 90 days for content-free inference telemetry, 12 months for security/admin audit records, and statutory retention for billing evidence. Privacy Policy, Terms, AI disclosure, subprocessors, App Privacy information, GDPR/LGPD handling, and adult-only declarations must be updated before release.

### Pre-release economics

The previous 30-day production gate is removed. Economics are approved before release using actual Nexus provider-account rates, ten measured scripts, existing usage data, and conservative simulations.

Required simulations include:

| Profile | Simulated monthly usage |
|---|---|
| Pro script-heavy | 30 standard scripts plus 200 standard interactions |
| Max script-heavy | 60 standard scripts plus 600 standard interactions |
| Chat-heavy | Entire monthly pool used as one-credit interactions |
| Reasoning-heavy | Entire pool used in three-credit operations |
| Priority/pack buyer | Priority scripts plus purchased-credit consumption and channel fees |

Use 95th-percentile measured token consumption, actual OpenAI/Gemini account pricing, search/tool costs, VPS allocation, Stripe fees, Apple proceeds, refunds, and taxes. Do not rely on inconsistent public Luna pricing when the account contract or invoice provides the applicable rate.

Launch requires at least 80% projected blended contribution margin and at least 80% on web subscriptions. Apple is reported separately; a 70–75% initial Apple channel floor is acceptable only when blended margin remains at least 80%.

If simulation fails, adjust routing, credit costs, included allowances, or pack pricing before release. Do not silently lower output quality or hide fallback behavior.

## 5. Execution, verification, production release, and adversarial QA

### Execution sequence

1. **Baseline and security:** verify live provider/store pricing, rotate exposed credentials, capture billing/ledger preimages, and establish versioned catalog and provider-rate records.
2. **Credits and commerce:** implement reservations, packs, authenticated Stripe Checkout, durable webhooks, Apple consumables/notifications, StoreKit restoration, and Nexus Points compatibility.
3. **Inference and model migration:** complete the Ollama gateway, evaluate all candidates, migrate to the qualifying winner or retain Qwen, then delete rejected Nexus bakeoff models.
4. **Content, skills, and clients:** complete async scripts, delivery modes, specialist profiles, privacy routing, website pricing/checkout, iOS paywalls, and App Store CTA controls.
5. **Verification and direct release:** complete the efficient acceptance suite, deploy through protected-main signed delivery, verify migrations and production smoke, then activate the completed behavior for all eligible users without a 30-day or percentage-cohort delay.

Application changes remain default OFF until the same release’s production verification is complete. Activation then moves directly to all final users. Independent kill switches remain available for subscriptions, packs, Apple fulfillment, local inference, cloud fallback, and storefront links.

Host inference changes use the attended `plan → inspect → apply → verify → receipt` transaction under the maintenance mutex. No manual application promotion replaces protected-main continuous delivery.

### Token-efficient verification

Use mocks, provider fixtures, compact outputs, and deterministic simulations for concurrency, queue pressure, billing replay, cancellation, recovery, and security tests. Do not generate long scripts merely to load-test infrastructure.

Generate no more than ten new complete 15-minute scripts across the entire acceptance cycle—not ten per provider or model:

| Delivery coverage | Scripts |
|---|---:|
| Standard | 4 |
| Scheduled | 3 |
| Priority | 3 |
| Language split | 5 PT-BR and 5 English |
| Total | 10 |

Nine may run before release and one as the production smoke artifact. Reuse those outputs for quality, token-cost, margin, continuation, notification, and final-artifact validation. Load and failure tests use mocked or short capped completions.

Acceptance requires:

- All ten scripts complete at 1,900–2,400 words, remain source-consistent, and show no critical quality regression.
- At least 99% schema validity from compact structured tests, with zero tenant, receipt, credit, privacy, or authorization failures.
- Correct duplicate/out-of-order webhook, replay, refund, dispute, restore, reservation, cancellation, restart, and provider-reconciliation behavior.
- Local runtime maintains zero swap, 6GB headroom, at least four tokens/second, and configured queue/deadline limits.
- Website, Stripe, StoreKit, server catalog, subscriptions, packs, expiration rules, and displayed prices agree.

A production deployment is complete only when the signed release receipt, database migrations, Stripe catalog, local model digest, gateway health, website, credit ledger, cloud routing, and one production script smoke are verified. Production failures trigger the corresponding kill switch or signed-release rollback without reversing valid billing records.

### Mandatory “angry QA” handoff

Only after implementation, verification, external billing configuration, model cleanup, production deployment, and release receipts are complete, generate a repository-specific Claude Code QA prompt containing:

- The original business goal, approved architecture, exact release SHA, model digest, files changed, migrations, catalog changes, deployed behavior, and rollback controls.
- Every test/check performed with exact commands and results, including the ten-script inventory and production evidence.
- Explicit instructions to distrust the implementation summary and independently inspect code, migrations, configuration, provider routing, deployment receipts, Stripe/Apple setup, and compatibility paths.
- Adversarial cases covering stolen/replayed receipts, cross-tenant credits, concurrent spending, duplicate webhooks, refunds after consumption, provider-price errors, fallback loops, token amplification, prompt injection, local-model overload, cancelled jobs, partial scripts, and forged catalog values.
- A mandatory evidence-backed `GO` or `NO-GO` verdict, with P0–P3 findings, exact paths/lines, reproduction steps, financial exposure, and required remediation.

The prompt must tell Claude Code to behave as a hostile release auditor whose objective is to prove the system can lose money, leak data, mischarge users, exhaust cloud budgets, or ship incorrect AI results. Unsupported implementation or test claims are blocking findings.

If Claude returns `NO-GO`, remediate every validated P0/P1 and applicable P2, rerun focused verification without exceeding the ten-script total, redeploy when required, and generate a new adversarial QA prompt. Final handoff occurs only with a Claude `GO` or with a specifically documented external impossibility that the owner accepts.

---

## Canonicalization addenda

These addenda record owner decisions made on 2026-08-18, in the session that
canonicalized this plan. They extend the locked decisions above without
modifying them.

### Addendum A — Apple on-device inference lane (owner-approved 2026-08-18)

Add a device-local execution lane to the AI routing table using Apple's
Foundation Models framework (iOS 26+ APIs; the any-provider protocol at
iOS 27 GA). Activation is default OFF behind server policy, like every other
plan capability.

- The server catalog/policy remains the only routing authority. It declares
  which operation classes are device-eligible; clients execute policy and
  never choose providers or models. A dedicated device-lane kill switch joins
  the independent kill-switch set.
- Admission order is unchanged: credit-bearing operations require server
  admission (entitlement, then reservation, then daily-cap accounting) before
  on-device execution. Device execution never bypasses caps or wallets. A
  zero-credit device-convenience class (on-device parse/summarize of
  already-local content) may run without admission but consumes no credits
  and no provider dollars.
- Writes and actions stay deterministic: Foundation Models `Tool`
  implementations wrap existing token-zero REST endpoints behind the existing
  confirmation and read-back contracts. Model output never executes actions.
- Scope guardrails: no 15-minute scripts, no deep-reasoning class, and no
  commerce operations on device. When Foundation Models is unavailable
  (ineligible device, Apple Intelligence disabled, model not downloaded, OS
  below floor), the operation falls back to the server lane.
- Bakeoff: Apple's on-device model enters the evaluation as a sixth candidate
  under the same 24-compact-case harness, executed on Apple hardware rather
  than the VPS envelope. PT-BR quality is measured, not assumed.
- Governance: the device model is OS-provided and cannot be digest-pinned.
  Evidence records device model, OS build, and framework availability as the
  version identity; the local-model manifest standard gains a device-model
  appendix before any activation.

### Addendum C — Delivery modes and script routing composition (owner-authorized 2026-08-18)

Resolves the conflict between the §1 script routing table and the landed
local-primary inference standard:

- The local-primary runtime remains the primary script route for enrolled
  users; the §1 cloud delivery classes define the eligible cloud
  fallback/delivery tiers at activation. Provider and model names stay out of
  every label.
- Standard, Scheduled, and Priority are queue-and-scheduling semantics with
  the §2 pricing (10/10/12 credits): priority jobs order ahead of other
  queued jobs within the same plan queue-weight class at candidate selection
  (plan fairness — the 2:1 high-weight burst — still applies across classes);
  scheduled jobs defer their start to the next off-peak batch window ("Have
  it ready tomorrow") and re-defer on user retry; standard jobs run in
  arrival order. The runtime executes ONE generation at a time and never
  preempts: "Starts immediately" therefore means "takes the next generation
  slot, ahead of every queued job in its class" — an in-flight generation
  finishes first. Job creation is refused entirely when the local runtime is
  not admitting, so priority can never be charged where the selector cannot
  order it. The user-facing labels remain exactly the §1 strings; whether the
  Priority label should say "Jumps the queue" instead is an owner copy
  decision (QA3 P1-6).
- Per-class cloud provider bindings are configured at activation together
  with the cloud-fallback rate evidence; they are not hardcoded in the
  runtime. Provider model identity and processing tier are separate values:
  use the real model id `gpt-5.6-luna` plus `default`, `flex`, `priority`, or
  `batch` in the corresponding `CLOUD_SCRIPT_*_SERVICE_TIER` control. Invented
  model ids such as `gpt-5.6-luna-flex` are invalid. Batch remains fail-closed
  until the durable submit/poll/cancel/resume adapter is implemented and
  verified; a synchronous completion must never masquerade as Batch.

### Addendum B — Interim pricing vs credit-ledger reconciliation (2026-08-18)

Branch `feature/hybrid-ai-plan-pricing-20260818` stages display repricing
(Pro $9.99, Max $14.99, pack price points) and Stripe Managed
Payments/Adaptive Pricing on top of the legacy Nexus Points scheme, including
30-day point expiry. That work is transitional website/billing-display work
only. Section 2 remains authoritative for launch: purchased credits never
expire, and existing purchased lots migrate to nonexpiring per Section 3. No
new purchased lot may ship with an expiry after the credit-ledger cutover.

### Addendum D — owner-deferred credential rotation (2026-08-24)

The owner explicitly instructed the release operator not to rotate credentials
during this plan closeout. The live Stripe credential later disclosed in an
operator chat therefore remains a documented security exception to §4 and
execution-sequence step 1, not evidence that the rotation control passed. Never
copy that credential into source, documentation, receipts, tests, commands, or
logs. Continue to enforce exact Stripe account binding, root-owned runtime
storage, webhook verification, checkout kill switches, and least privilege;
only the owner may later withdraw this exception and authorize rotation.
