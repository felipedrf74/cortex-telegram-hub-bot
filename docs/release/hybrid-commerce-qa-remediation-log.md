# Hybrid AI Commerce — Adversarial QA Remediation Log

Evidence log for the NH-0037 post-production adversarial QA rounds on the
hybrid AI, pricing, and commerce plan. Current release truth stays in
[`CURRENT_RELEASE_STATE.md`](CURRENT_RELEASE_STATE.md); this file records what
each round found and how it was closed.

## Deploying a release whose delta touches `src/config.ts`

Any change to `src/config.ts` sets `cdEligibility.eligible=false` on the
published payload, and the poller halts that candidate as
`migration_not_cd_eligible`. The owner ack (`npm run release:cd:ack --
--confirm <candidateId>`) clears the *incident*, but it does not deploy that
candidate: the release id now carries a settled `blocked` receipt, so every
later poller pass refuses it with `already_settled_blocked`
(`release-deployment.mjs`, settled-receipt guard). The eligibility verdict is
also baked into the payload at publish time, so re-evaluating it cannot change
the answer.

The deploy therefore takes two steps, and both are required:

1. Owner acks the halted candidate — this authorizes the policy exception.
2. Push a follow-up commit whose own delta is CD-eligible (docs-only is the
   usual choice). CI computes eligibility against the check-suite base, i.e.
   the previous commit on main, so that payload is eligible and it carries the
   preceding release's application code unchanged.

Observed twice: `3970fac7` → acked `d9ac4a92…` → deployed by `c5a7ae67`, and
`a7fe09ce` → acked `84389eb5…` → deployed by its docs-only successor.

Observed again on 2026-08-20: protected-main source `6bbabe0b` halted as
release `8aeaf11bad6acfdeb9a8a670cd49eca7`; the owner acknowledged that exact
release at `2026-08-20T23:23:18.705Z`. This docs-only successor is the
CD-eligible carrier for the unchanged application bytes.

Observed again on 2026-08-22: protected-main source
`ba8bb47c955883b749a156a1d73f7cbaa4c3f7ec` halted as release
`829caa4346f8532b884814132870118a`; the owner acknowledged that exact release
at `2026-08-22T20:44:58.930Z`. The following docs-only successor carries the
same reviewed application bytes through the CD-eligible path.

Audit protocol: every round runs under a promotion freeze (no merges to
protected main until the verdict lands), and the auditor reads the active
receipt from `sudo -n /usr/local/sbin/nexus-release-state-view` at the start
and end of the audit. Backup and receipt evidence is readable without a
password via `sudo -n /usr/local/sbin/nexus-release-audit-evidence`.

## Round 4 — NO-GO (2026-08-19), closed

| Finding | Resolution |
|---|---|
| P0-1 handoff named a superseded receipt | Release state records the receipt chain and authority, not a frozen head; promotion freeze added to the audit protocol |
| P1-2 checkout key-mode guard dead-ended web checkout while the Nexus Points path stayed unguarded | Guard made uniform across all four checkout surfaces |
| P1-3 `CLOUD_REASONING_FALLBACK_ENABLED=true` contradicted the default-OFF claim | Set `false` in production and staging |
| P2-4 / P2-5 restore-packs accepted foreign-bundle and revoked transactions | Both refused with dedicated outcomes |
| P2-6 DB kill switch fails open | Kept fail-open by decision; an unreadable control table now raises a critical operator alert, and the env switch remains the fail-safe stop |

## Round 5 — NO-GO (2026-08-19), closed

**P0-1 — anonymous test-card entitlement.** `STRIPE_SANDBOX_CHECKOUT_ALLOWED=true`
disarmed the guard whose contract is "a test-mode key in a production runtime
lets anyone buy real entitlements with 4242… cards", the legacy
`STRIPE_PRICE_*` ids were configured, and anonymous checkout was open — so an
unauthenticated visitor could mint a permanent Pro/Max entitlement for $0.
Fixed three ways: the hatch is scoped to non-live production (boot refuses it,
`isStripeSandboxCheckoutAllowed()` ignores it), `stripeEventLivemodeMatchesKey`
fails closed in live production including a missing boolean, and the anonymous
sunset defaults CLOSED. **The owner must unset the flag in the production env;
this release refuses to boot while it is set.**

| Finding | Resolution |
|---|---|
| P1-2 no runtime path minted included monthly credits, so enabling credits denied 100% of paid AI | `ai-credit-provisioning` grants the period lot lazily at admission and wallet read; audited admin-grant route at `/api/v1/admin/ai-credit-grants`; startup refuses credits-on with no registered grant path |
| P1-3 web pack checkout gated on the cross-channel OR, so the Stripe kill switch did nothing while Apple was live | Route gates on `stripePurchasable` |
| P1-4 free-tier policy refusals counted as provider failures and opened the shared circuit breaker | Refusals are re-thrown before any circuit/metric bookkeeping and classified non-retryable |
| P1-5 daily long-form scripts seeded 6/20 against the plan-locked 2/4 | Migration 290 corrects the seed; the code fallback is pinned to match |
| P1-6 the plan §3 anonymous-checkout sunset defaulted open | Defaults CLOSED; explicit `true` re-opens it |
| P2 restore-packs credited a transaction the inbox already recorded as refunded | Restoration consults the durable inbox for a REFUND/REVOKE, failing closed if that lookup errors |
| P2 JWS accepted any Apple-rooted certificate and ignored `alg` | Leaf must be an App Store end entity (OID 1.2.840.113635.100.6.11.1, not a CA) and `alg` is pinned to ES256 |
| P2 retry-exhausted inbox rows could never be selected, so their alert was unreachable | The scheduled pass raises one deduped operator alert per exhausted row |
| P2 deferred pack rows that reached `failed` starved the retry head | Exclusion no longer requires `state='pending' AND attempts=0` |
| P2 a reversal for a pack with an unset product id was swallowed silently | Alerts critically and stays retryable |
| P2 reconciliation window was shorter than Apple's refund horizon and re-checked the same head | 90-day window plus a progress cursor (migration 291) |
| P2 DSAR export omitted `subscriptions` and `stripe_web_checkouts` | Both included in the Article 15 bundle |

**Deferred at the time:** plan §5 names six kill switches and four existed.
Round 6 closed this — see below.

**Accepted P3s (not re-blocking):** deep-class enforcement is a repo-grep pin
rather than a runtime guard; the apple-verify subscription path's bundleId
check is conditional; the DSAR Apple-inbox scan caps at the newest 5,000 rows.

## Validation before Apple activation

The App Store leaf policy (OID + end-entity check) mirrors what Apple's own
server library enforces, but it has not been exercised against a real Apple
notification because pack fulfillment is off and no App Store products exist
yet. Validate it against a live sandbox notification as part of Apple
activation, before enabling `APPLE_PACK_FULFILLMENT_ENABLED`.

## Round 6 — NO-GO (2026-08-20), closed

Round 6 confirmed the round-5 P0 dead at the runtime (all three layers, plus a
`410` at the public edge where round 5 measured an open `400`) and confirmed
twelve of the round-5 items closed. It found that the P1-2 remediation had
introduced a new money bug, plus two P2s and four P3s.

**P1 — included credits double-granted through an unstable period key.** The
lot's idempotency key was `sub:<period END>`, and any subscription read failure
fell back to a `cal:<month>` anchor. The key therefore moved underneath a user
who had paid once, and the ledger's one-lot-per-key rule stopped protecting
anything. Three reproduced paths: a single transient read error (grant under a
second anchor), a late renewal webhook (calendar stopgap plus the real period),
and a mid-period upgrade (the plan change moves `current_period_end`, so the
key moved with it — falsifying the module's own docstring claim that excluding
the plan from the key made cycling useless). Up to 142% over-grant on a Max
upgrade, reachable through ordinary webhook lag rather than only by attack.

Closed with three changes, defence in depth rather than one fix:

1. **Anchor on the period START** (`stripe-service` now exposes
   `currentPeriodStart`). A mid-period re-price moves the end, never the start,
   so an upgrade is a no-op and cycling mints nothing.
2. **A subscription read failure denies provisioning** instead of switching
   anchors. Admission denies that one operation and the next call retries; a
   lost read can no longer become a second lot.
3. **The ledger supersedes rather than stacks.** `grantMonthlyAiCredits`
   revokes every other live included lot inside the same immediate transaction
   (`revoke_reason = 'superseded_by_period_change'`, preserving the
   append-only history) before minting. The invariant is now structural: a user
   has at most one live included lot, carrying exactly the plan allowance,
   whatever the key says. It also self-heals a wallet a previous defect left
   holding more than one.

`ai-credit-provisioning.ts` now has its own suite covering anchor
TRANSITIONS — the gap the auditor identified, since the prior tests asserted
anchor selection in isolation.

| Finding | Resolution |
|---|---|
| P2 the reversal lookup scanned only the newest 2,000 refunds and returned a CLEAN verdict past the cap — permanent, since migration 286 forbids deletes | Transaction ids are extracted at ingest into indexed columns (migration 292) and probed by equality with no window; legacy rows are backfilled, and the lookup fails CLOSED while any reversal row is still unresolved |
| P2 the App Store leaf marker was `raw.includes(oidDer)` — a byte search that could not tell the marker extension from those bytes anywhere else, and accepted non-certificates | Real DER walk: Certificate → TBSCertificate → `[3]` extensions → each Extension's `extnID`, compared as a parsed extension identifier. Malformed DER fails closed |
| P3 a second Stripe webhook entry point dispatched without the livemode gate | Deleted. It was routed nowhere and kept alive only by its own test; the single routed entry point (`POST /webhooks/stripe`) gates livemode before any handler |
| P3 `STAGING=true` on the production container silently disabled every live-production payment guard | Boot refuses a runtime whose two independent identity signals disagree (`NEXUS_RELEASE_ENVIRONMENT` vs `STAGING`), so no single env var flip downgrades production |
| P3 exhausted-row alerting capped at 50 oldest-first and inflated its own counter | No cap — every stuck row alerts, deduped per uuid — and the sweep reports a separate `stuckExhausted` gauge instead of being summed into the `exhausted` counter |

**Kill switches: no longer deferred.** Round 6 sharpened why this mattered —
subscription catalog items compute `purchasable` from the price id alone, so
*before* a live Stripe key exists there is no way to stop subscription sales
without an env edit and a restart. Migration 293 adds `subscription_checkout`
and `storefront` in an **additive table**: widening the original table's CHECK
constraint would rebuild it and classify as a contract migration, while a new
table is expand-only and predecessor-compatible. Reads union both tables, so
callers see one flat set of six keys. `storefront` is enforced at
`assertStripeCheckoutKeyMode()` — the one choke point every session-minting
path already calls — deliberately not per route, since per-route gating is how
the round-5 P1-3 pack-switch gap happened.

**Still open, and honestly so:** the App Store leaf policy has never seen a
real Apple notification. Validate it against a live sandbox notification before
enabling Apple pack fulfillment. The ten-script acceptance cycle and the §4
economics simulation remain sequenced after activation — and the round-6 P1
changed an input the economics simulation consumes.

## Production activation audit — blocked (2026-08-20)

The protected-main application release is healthy, but the plan is not active
for users. A live container/database inspection found production runtime mode
`off`, every hybrid/local-primary activation flag unset, no gateway socket,
the signed local-model manifest still `control_only`, and no live Stripe pack,
plan, Apple product, or App Store Server API identifiers. This is the intended
fail-closed state, not proof of activation.

The audit also found that the per-class ScriptGen binding stopped before the
provider boundary: `approveCloudScriptGeneration()` did not pass
`scriptDeliveryMode`, the OpenAI adapter did not send `service_tier`, and tests
used nonexistent suffix ids such as `gpt-5.6-luna-batch`. The OpenAI account
probe returned 200 for `gpt-5.6-luna` and 404 for the Flex/Batch/Standard/Fast
suffix variants. The remediation separates model identity from processing
tier, binds the tier into the one-use permit and SDK request, verifies the
provider-reported tier, prices Luna, and rejects partial or Batch bindings.
Batch remains blocked until a durable adapter exists.

Fresh independent QA then found that the SkillInference fallback boundary still
dropped the selected tier before the provider call and that the Luna registry
held its pre-2026-07-30 price. The boundary now forwards the tier, explicit-tier
calls reserve the Priority ceiling until the response tier is verified, and the
central Luna rates match the current direct-API short-context price.

The next review found three more end-to-end gaps: OpenAI cache-write tokens
were recorded as zero, GPT-5.6 long-context rates were not applied above
272,000 input tokens, and the retained PM2 fallback omitted the nine class
binding variables. Chat Completions and Responses usage now validate and meter
both cache counters, actual long-context usage applies the 2x input/1.5x output
schedule while preflight reserves the conservative ceiling, and PM2 forwards
all class bindings (explicitly empty when the still-unactivated protected env
does not define them).

## VPS local-model first-pass rerun — no eligible winner (2026-08-22)

Release `b564531c37b023b938378d9c2e6749c7` at protected-main source
`fdcebe8e6b8723da50735f24e44cff7ee5d95b48` exercised every model in signed
manifest `2026-08-12.1` through the attended benchmark-envelope transaction.
Each installed tag matched its pinned model digest before generation. Raw
responses remain root-only under
`/var/lib/nexus-release/private-model-artifacts/2026-08-22/`; the repository
records only aggregate evidence and immutable artifact digests.

| Model | Cases | Score | Schema | Tokens/s | Screening result | Raw v2 artifact SHA-256 |
|---|---:|---:|---:|---:|---|---|
| `qwen2.5-3b-control` | 24 | 82.73 | 100% | 12.13 | refused: structured action plus safety/tenant failures | `55f4a6f551da1ad333fbdf3b5c3a70038a96dff31055b885fd86b391381db181` |
| `qwen3.5-9b-candidate` | 24 | 74.02 | 66.67% | 3.49 | refused: schema, safety/tenant, and throughput | `26645b73f90414bb3f4004b91d991839152454374939f7cab44909acfb2475cf` |
| `gpt-oss-20b-candidate` | 24 | 77.55 | 100% | 5.90 | refused: safety/tenant failures | `f6f919cbd0ee1def8cbbf4c9b436feee2ca3762588978424e77b58891b25c3e0` |
| `gemma-3-12b-candidate` | 24 | 79.36 | 100% | 3.19 | refused: safety/tenant and throughput | `63ea5d232257bbb57401066cf93175a858ebcd9af851a0c41d0299a6639b059b` |
| `ministral-3-14b-candidate` | 4 | n/a | 100% | 3.34 | refused: request timeout and incomplete run | `8d3a020cd74247160ffe7e489800e30a4bc7986a0c6c33c583c617417fe8cee3` |

Every transaction restored the permanent 18GB/20GB, 8-CPU, zero-swap
envelope. The rollback-receipt digests, in table order, are
`sha256:59d5c6808a0f1795e15563eac2a9f4c5baae951b56ed3910adac66787db2c63b`,
`sha256:5f9c6d677ee633173107c6a392e7f6eebc4991b16dde0e13bf272a511fce4b54`,
`sha256:b1c2353c4dcc2f36ada0042f3103d1217349abf902aa8d50b110640ab879571f`,
`sha256:3127103338dd1e70b6fe36c8efd3dc376dcc13634cd6556e84208f42fd0cf7a3`,
and
`sha256:ef3d55f6f1bcdec8a9ae3cf27ab5331acdde9bd4ab8fd2002d48f82e2d84f8c0`.
Rejected challenger models were removed from the host; only the signed Qwen
control remains installed. Because no candidate passed screening, the manifest
correctly remains `control_only`, the gateway/socket transaction must not run,
and local-primary activation remains OFF. The next attempt requires a new
candidate or a reviewed prompt/profile-policy change followed by a fresh
complete first pass; failed evidence cannot be promoted or rescored into a
winner.

Do not enable public controls until an eligible signed local-model winner
completes the full VPS bakeoff, the actual-account rate card and economics
simulation pass, the ten-script acceptance cycle completes, and applicable
Stripe/Apple gates pass. The owner approved the narrow non-sensitive,
resumable script-job OpenAI fallback on 2026-08-21; raw private Content
fallback remains outside that decision and stays unavailable. Local-primary
rollout must then follow the governed staged progression; deployment alone
does not authorize an all-user flip.
