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

The reviewed remediation moves production and screening to the shared
`nexus-skill-inference-v2` policy artifact. It adds reason-bearing refusal
instructions for tenant privacy, unprovided copyrighted material, acute medical
symptoms, and declared severe allergies; the runner records the exact policy
SHA-256 in every new artifact. The immutable corpus, positive refusal-language
checks, prohibited-leakage checks, and all thresholds remain unchanged. This
code change is not qualification evidence: GPT-OSS still requires a fresh,
complete attended first pass after the v2 policy reaches the signed production
release, followed by the full blind-paired bakeoff and rollout gates.

## VPS GPT-OSS v3 policy rerun — still ineligible (2026-08-23)

Production release `138e3a5f80d7e602cd17c598447687d8` at protected-main
source `5d7e36103c48a97c6692444108567886d98b1acf` exercised
`gpt-oss-20b-candidate` through a fresh attended first pass after the shared
`nexus-skill-inference-v2` policy shipped. The installed `gpt-oss:20b` digest
matched the signed manifest exactly. The v3 artifact completed the governed
attended first-pass corpus defined by
`docs/engineering/local-primary-inference-standard.md`, recorded 100% schema
validity, 6.12 generated tokens/second, a 20,046 ms p95
first token, a 46,710 ms p95 total duration, and score 76.51, but remained
ineligible because a safety or tenant-isolation refusal failed.

The root-only artifact SHA-256 is
`a07e179a7edfd50684c2707072f4fcadd2083929e20b9bb1b16386048bb9badc`.
The receipt-bound rollback restored the permanent 18GB/20GB, 8-CPU,
zero-swap envelope and produced rollback receipt digest
`sha256:d459afd5e09024934db9018d8d4b06dc26dae162a0b422f5515f3999b9a62dd4`.
The rejected 13GB candidate was removed; only the signed Qwen control remains.
This evidence closes the policy-rerun item but does not authorize a full
bakeoff, winner signing, gateway/socket activation, or a public flag change.

## Apple first-consumable submission (2026-08-23)

App Store Connect submission `8fbed07b-db86-4679-9f2c-be8fbcda3c42`
contains exactly iOS 1.5.0 build 279 plus the 100, 250, and 600-credit
consumables. The required website-only first-IAP flow submitted all four items
for App Review; the duplicate one-pack draft was removed before submission.
Production Apple fulfillment
remains OFF until Apple approves the catalog and a real sandbox signed-JWS
grant, exact binding, idempotent replay, and retained retry pass against the
isolated staging backend.

## Stripe live-account readiness (2026-08-23)

The live `Cigarra Esbelta Unipessoal LDA` dashboard binds to expected account
`acct_1U54u33I2RHPBZcJ`. Its active catalog contains exactly the Pro and Max
monthly plans plus the 100, 250, and 600-credit packs at the canonical prices;
all five products carry the expected SaaS tax category and report Managed
Payments eligibility. The active `nexus-hub-api` destination targets
`https://api.nexushub.me/webhooks/stripe`, listens to the required checkout,
subscription, invoice, refund, and dispute event families, and showed no
delivery errors at inspection time.

Stripe now reports no active account tasks; Payments, Payouts, Transfers, and
the required payment methods are active. A direct live API probe confirmed the
expected account, `charges_enabled`, `payouts_enabled`, submitted account
details, all five active Price IDs, and the active target destination.

The existing target-account live API key and existing destination signing
secret were installed in the root-owned production environment without
creating or rotating credentials. The expected account and five live Price
IDs are complete there. Subscription checkout, Stripe pack fulfillment, Apple
pack fulfillment, hybrid credits, and anonymous checkout remain OFF: loading
correct credentials is necessary release readiness, not authorization to skip
the remaining acceptance, economics, Apple, or local-model gates. The owner
later disclosed the live API key in an operator chat; rotation is therefore a
security prerequisite before public commerce, but remains explicitly deferred
under the owner's no-rotation instruction.

### Account-specific Stripe economics and tax posture (2026-08-24)

The live account's **Plans and fees** view now supplies the Stripe-specific
economics inputs that were previously missing: Billing is `Pay as you go` at
`0.7%` of Billing volume, Radar Standard is `EUR 0.05` per screened
transaction, and Tax Basic is `0.5%` for Checkout/Billing transactions. These
charges are additive to the applicable Portugal Payments schedule. The
conservative card-rate envelope is therefore built from the live account plan
plus the applicable standard, premium, UK, international, and currency-
conversion schedules; it must not model only the headline card-processing
fee.

The account has no live transaction or fee samples yet, so an empirical card
mix, effective refund rate, and realized fixed-fee currency conversion cannot
be claimed. The Tax **Locations** view also shows no collecting registration.
Because the product creates Checkout Sessions with automatic tax and every
Price is tax-exclusive, public checkout remains fail-closed until the owner or
their accountant confirms the company's Portugal/OSS registration posture and
the corresponding Stripe Tax registration is recorded. Stripe monitoring does
not infer the account's home-jurisdiction obligation.

Do not enable public controls until an eligible signed local-model winner
completes the full VPS bakeoff, the actual-account rate card and economics
simulation pass, the ten-script acceptance cycle completes, and applicable
Stripe/Apple gates pass. The owner approved the narrow non-sensitive,
resumable script-job OpenAI fallback on 2026-08-21; raw private Content
fallback remains outside that decision and stays unavailable. Local-primary
rollout must then follow the governed staged progression; deployment alone
does not authorize an all-user flip.

## Production completion audit (2026-08-23)

The root-owned observer proved release
`fa747e0968de874015ee5fb8754c3fcf` at protected-main source
`438a99d730bd1e875843c160f6810e59840043d2` completed with a bound v3
receipt and no active release block. This proves the reviewed backend bytes are
running; it does not prove the plan's still-disabled user behavior.

The root-owned production environment keeps hybrid credits, subscription
checkout, Stripe pack fulfillment, Apple pack fulfillment, and free-tier
local-only routing OFF. `OLLAMA_ENABLED` is on for the retained Qwen control,
but no `LOCAL_PRIMARY_*` rollout value is present. Standard scripts bind to
OpenAI Flex, Scheduled scripts also bind to Flex, and Priority binds to the
Priority service tier. Scheduled Batch therefore remains unimplemented: the
provider boundary deliberately refuses `batch` until a durable
submit/poll/cancel/resume adapter exists.

App Store Connect now reports the W-8BEN, U.S. Certificate of Foreign Status
of Beneficial Owner, Paid Apps Agreement, and bank account as `Active`. iOS
1.5.0 and its three first consumable IAPs remain `Waiting for Review`. Apple
approval and a real
transaction-bearing TestFlight sandbox purchase are external prerequisites;
the signed TEST notification is not fulfillment evidence.

The corrected website source at `5553f9e2335aa1d80061316d6b7c1f40548e7cbb`
was promoted to the Cloudflare Pages production branch. A cache-busted read of
`https://nexushub.me/` returned the five-skill contract and `5→1`, with
Triathlon contained inside Training; the previous six-skill production drift
is closed.

The plan is not complete. The durable Batch adapter and owner-approved Apple
Foundation Models device lane have completed final post-hardening verification
and signed publication as recorded below. The remaining acceptance gates are:
complete the ten-script acceptance inventory and production script smoke; use
those measured p95 values with actual account rates to pass the economics
simulation; complete the real Apple sandbox fulfillment/replay/retry proof
after the products become available; and rotate the live Stripe credential
disclosed in chat. The owner has now authorized final tests and releases but
continues to forbid credential rotation, so the security exception remains and
public activation remains OFF.

## Batch and Apple device-lane local closeout (2026-08-23)

The durable OpenAI Scheduled Batch adapter and the Apple Foundation Models
device lane are now implemented in isolated local worktrees. Batch binds every
provider job to one tenant, owner, Content job, stage, and request digest,
resumes and cancels durably, and records provider usage exactly once. Provider
idempotency keys include that complete scope, so byte-identical stages from two
tenants cannot alias the same OpenAI file or Batch. A daily reconciler deletes
terminal Batch input, output, and error files after the 30-day private-job
recovery window while retaining content-free accounting identity. The device lane adds
server-owned default-OFF policy, credit-first admission/settlement, a seventh
independent kill switch, content-free runtime evidence, iOS fallback routing,
and a physical-hardware acceptance test bound byte-for-byte to the canonical
24-case corpus. Completed admissions remain replayable after a lost settlement
reply, the iOS client persists only a scoped SHA-256 retry fingerprint and
operation id across restart, abandoned reservations expire on the admission's
short TTL, and the midnight sweep deletes device admission/evidence metadata
after 90 days.

Final backend verification passed the governed changed-area suite, TypeScript
gate, changed-branch threshold, and 100% coverage for the critical changed
files. Protected-main CI run `32655435458` then passed at source
`5035a61e9246961345b27320e1873c6e4af47aee`; its exact focused gate completed
in 18m59s. Final iOS verification passed the simulator build, six device-lane
unit tests, the canonical-corpus bundle test, and Xcode Cloud archive run
`38be20ad-edd0-48f4-bdd8-d4122ad76088` for build 279 at source
`bb26ef7ee849833442e855c69033ff1c63194427`. The physical Apple test is
intentionally unavailable on the simulator. During privacy review, migration
296 was corrected so device evidence remains immutable to update while Article
17 and the 90-day telemetry-retention path can delete it; subject access now
exports only scoped metadata and no prompt/output.

Signed backend release workflow `32656475261` published source
`5035a61e9246961345b27320e1873c6e4af47aee`, backend digest
`sha256:ce38af676bf203c48075dd3b63847f439a2c3aefed629d2fff6604448b7089a0`,
content-engine digest
`sha256:db72646164a1888096e26fdb5a760688d4c312dfa047e31eb498e8cd958586e5`,
and signed payload
`sha256:58c9a60af26aa25b2f32f4eb1dc8c4a2cca6d2955154009fe6912248a3e51c80`.
The pointer decision was `move_main`; as required for the `src/config.ts`
delta, `cdEligibility.eligible=false`. One attended poll recorded signed
release `06386bb225dd1e700cd6fd3cf58bdae6` as
`migration_not_cd_eligible`, and the owner-authorized exact acknowledgement
completed at `2026-08-23T18:01:06.917Z`. This docs-only successor is the
CD-eligible carrier for those unchanged reviewed application images.

The CD-eligible carrier subsequently completed signed deployment as release
`a6ef7c948da5999d0762475f80527855` at source
`8f75dfa2b2a9f387cf6a9a2999e8c37041605bce`. Production therefore contains the
reviewed Batch and Apple device-policy implementation. The earlier iPad
constraint is superseded: device acceptance now targets a physical iPhone
only, and no iPad result is accepted for the StoreKit proof.

Remaining gates are unchanged where implementation cannot create external
evidence: an eligible signed VPS local-model winner/full bakeoff; the physical
Apple 24-case run; nine pre-release scripts plus one post-deploy smoke and their
p95 economics; Apple catalog approval plus a real sandbox signed-JWS
fulfillment/replay/retry; and public activation only after those pass. The
backend and iOS signed-release gate is closed. The owner's no-rotation decision
leaves the disclosed Stripe live key as an explicit security exception to the
canonical plan rather than a completed gate.

## Governed final release candidate and fail-closed production posture (2026-08-24)

Protected-main source `4b475e1bc078af9a7116cc1de4333b2b1486429b`
completed CI run `32690312328`, security run `32690312329`, and signed release
run `32690840203`. The release published backend digest
`sha256:a7f44e8f4c1e2667d3d891eb17fff5affe70aa434a82477650e99217c85775a8`,
Content Engine digest
`sha256:db72646164a1888096e26fdb5a760688d4c312dfa047e31eb498e8cd958586e5`,
and signed payload digest
`sha256:13baa951b5f83d99f5818dc9df56bdd0ff2173e3f7f5497af5dd7245361e18e0`.
The manifest resolved to release
`ead21b94c6d080c6c8884e800f918809`, was predecessor-compatible, and was
unattended-CD eligible because it carried no migration changes.

The first staging rehearsal failed before any production mutation. Its
immutable receipt records `staging unhealthy`: the migrator and Content Engine
passed, while the backend health request failed. A content-free reproduction
proved the backend was waiting on the signed Ollama Unix gateway, which refused
the host-created `/run/nexus-inference/staging` boundary because Docker had
created it as `root:root 0755` instead of the reviewed UID/GID `10001:10001`
mode `0700`. The poller timer was stopped, the empty incorrect directory was
removed, and the exact installed `nexus-local-inference-sockets.conf` bytes were
copied into tmpfiles policy. `systemd-tmpfiles` then created both staging and
production leaves with the reviewed numeric ownership and mode. A bounded
gateway probe reached `ollama_gateway_ready` and removed its socket on exit.
The failed immutable release remains non-retryable by design; the next signed
source must carry the corrected host prerequisite through a fresh release ID.

The public runtime remains deliberately fail-closed while that transaction and
acceptance evidence are pending. A live authenticated catalog read returned the
canonical Pro, Max, and three credit-pack prices with every item
`purchasable=false`, and the anonymous website checkout returned HTTP `410`.
Production reports healthy while keeping hybrid credits, subscription checkout,
Stripe pack fulfillment, Apple pack fulfillment, and local-primary rollout OFF.
The isolated staging backend alone keeps Apple sandbox grants and pack
fulfillment enabled for the required real signed-JWS proof.

The complete local verification tier, governed changed-area pre-commit tier,
pre-push tier, migration checks, docs audit, protected-main CI, and security
workflow passed for this source. The immutable workflow records retain their
exact case counts. The staging failure is operational evidence, not a reason to
weaken the gateway ownership check or retry rejected bytes. It also is not a
substitute for the nine pre-release scripts, production smoke, economics gate,
attended local-model evidence, or Apple sandbox transaction.

The earlier iPad constraint is superseded. A developer-enabled physical iPhone
13 is connected and accepts signed test builds. Its attended Foundation Models
probe returns Apple's `deviceNotEligible`, which is expected for that hardware;
the 24-case device-lane bakeoff therefore still requires the paired iPhone 17
Pro Max to be physically connected and unlocked. The StoreKit sandbox proof is
explicitly restricted to the connected iPhone and rejects simulator/iPad runs.
The authenticated App Store Connect website now confirms submission
`8fbed07b-db86-4679-9f2c-be8fbcda3c42` contains iOS 1.5.0 build 279 and exactly
the 100-, 250-, and 600-credit IAPs; all four items remain `Waiting for Review`.
The Paid Apps Agreement, bank account, W-8BEN, Certificate of Foreign Status,
DSA, and DAC7 rows all report `Active`. The individual API key's earlier
`401 NOT_AUTHORIZED` no longer blocks website verification, and no new legal
declaration was inferred or submitted automatically.

The policy-v4 iOS carrier merged through PR 48 at protected-main source
`1a94e7eed2d599308c8b9e68097be4099c648f80`. Governed Xcode Cloud workflow
`App Store Release` completed build 285 successfully, App Store Connect reports
the 1.5.0 (285) upload `Complete`, and the build is assigned to the internal
`Nexus Hub Betinha` TestFlight group. The existing build-279 App Review
submission was not cancelled or modified.

## Policy-v4 and commerce-gate release candidate (2026-08-24)

The next reviewed carrier shares one exact EN/PT refusal/profile artifact across
the VPS candidate runner and iOS Foundation Models harness. The signed local
model manifest now records commercial-use approval separately from license
identity; installation, winner selection, runtime activation, and final Ollama
dispatch all fail closed if the selected live-production model is not explicitly
commercially approved. GPT-OSS 20B is the only approved challenger in this
manifest revision; Qwen remains a research/control license and cannot become a
production winner through legacy dispatch.

Credit-pack purchase and first-time fulfillment now delegate eligibility to
`getEffectiveEntitlement()`, the canonical billing-window authority. Only an
active, non-trial Pro or Max entitlement from Apple, Stripe, or Founder with
Nexus Points eligibility may start or receive a new pack grant. Malformed
periods, Free/Beta/Owner rows, trialing/past-due/cancelled/expired rows, and
unknown providers fail closed. An already-created provider transaction lot
still replays idempotently, so later subscription expiry cannot make a settled
purchase non-repeatable.

The live Stripe account probe continues to resolve the expected account and the
current five exclusive-tax prices. The downloaded `prices.csv` is historical:
its Pro row names a superseded unspecified-tax Price; production is instead
bound to the current exclusive-tax Pro Price verified by the provisioning
dry-run. The owner continues to prohibit rotation of the disclosed live key;
this remains a recorded security exception, not a completed canonical control.

The iOS carrier hides credit packs unless the server-backed entitlement is
active Pro/Max, rechecks before purchase, maps `paid_plan_required` as a
retryable settlement outcome, and contains an opt-in real StoreKit harness that
opens the isolated staging account, buys the 100-credit consumable on a physical
iPhone, and waits for exactly one +100 server wallet grant. The harness skips
simulators and every non-phone device. The real Apple sheet, signed-JWS binding,
idempotent replay, and retained-retry assertions remain sequenced after this
carrier and its matching backend reach signed staging.

Provisioning that isolated account exposed a staging-only identity collision:
the explicit synthetic fixture row advanced SQLite's `users` AUTOINCREMENT into
the reserved `1000000-1099999` range, so the tenancy guard correctly rejected
the next ordinary account's JWT. The fixture seeder now advances (and never
decreases) the sequence to the end of the reserved range inside the same seed
transaction. The next ordinary staging account therefore starts at `1100000`
or later, while fixture JWTs retain their exact reserved-ID plus
`staging_fixture=true` binding.

## Policy-v4 VPS and physical-iPhone activation evidence (2026-08-24)

Protected-main source `5ab56a6a08e4344353d8b594dad608008a1c88bf`
completed as signed release `74e063e907d74a8b5fb54e11ce1a3316`. The
provable v3 receipt binds backend digest
`sha256:33ccf5f8dfaf6c9b585fec6d1600e4d7f57f6e71d20ec34b197af3cae16e9f78`,
the unchanged Content Engine digest
`sha256:db72646164a1888096e26fdb5a760688d4c312dfa047e31eb498e8cd958586e5`,
and signed payload digest
`sha256:f0bbb7a63a57a7c7b698a7b624430454e386484f813f4591a24c4e211a1951c0`.
The controller's Git virtual-filesystem proof is present on the VPS, staging
and production are healthy, and no release block is active.

The exact 24-case governed GPT-OSS 20B policy-v4 first pass completed against
that release. It scored 84.76 with 100% schema validity, 6.19 generated
tokens/second, 22,449 ms p95 first token, and 46,663 ms p95 total duration.
The run remained ineligible because a safety or tenant-isolation case failed.
Its root-only raw artifact digest is
`bdf1cc4a28827a9d650089c0c5cb00f97ac809ced2d774ab47a818ce530d3211`.
The full blind-paired bakeoff therefore did not run, the benchmark envelope
rolled back with both gateways healthy, the rejected GPT-OSS tag was removed,
and only the signed Qwen control remains installed. Local-primary remains OFF;
this is the required fail-closed outcome, not an unfinished activation.

On the physical iPhone 13, StoreKit returned the real
`me.nexushub.credits.pack100` product and opened Apple's purchase sheet. This
closes product-discovery and UI reachability, but not fulfillment: App Store
Connect currently has no Sandbox Tester, so there is no transaction JWS to
bind, grant, replay, or retry. Production Apple fulfillment remains OFF until
an attended tester purchase completes against the isolated staging account.
The app now keeps the server-owned pack catalog mounted while StoreKit loads
and renders an explicit disabled card when Apple omits a product, preventing a
conditional `EmptyView` from suppressing its own catalog task.

The ten-script acceptance inventory remains immutable at ten cases: six are
completed, three scheduled cases are queued for exactly
`2026-08-25T03:00:00Z`, and the post-release production smoke remains pending
until those nine pre-release cases pass. The root-owned
`nexus-content-acceptance-v3.timer` is enabled and active, and its oneshot
automatically runs the production smoke when ready. The jobs must not be moved
early or replaced with extra completed scripts merely to accelerate the gate.

## Final evidence refresh and policy-v5 safety candidate (2026-08-24)

The current provable production receipt is signed release
`e9d222cca5723c5fa22aa23d76c3547f` at protected-main source
`aa4bfae2b96c98f20df72067c524538ba3318b66`. It binds backend digest
`sha256:33ccf5f8dfaf6c9b585fec6d1600e4d7f57f6e71d20ec34b197af3cae16e9f78`,
Content Engine digest
`sha256:db72646164a1888096e26fdb5a760688d4c312dfa047e31eb498e8cd958586e5`,
and signed payload digest
`sha256:c3cb013af7530df9c031aebec7e808e00abe22297ab77cdebbf733bc3fd3e636`.
The receipt completed at `2026-08-24T14:24:48.491Z`; both runtimes are healthy
and no release block is active. Public hybrid credits, checkout, Stripe packs,
Apple packs, free-tier local-only routing, and local-primary activation remain
OFF as required while the acceptance gates are incomplete.

The rejected policy-v4 GPT-OSS first pass exposed one substantive safety gap:
the Portuguese acute-symptom triathlon response refused the unsafe workout but
did not explicitly tell the user to stop activity and seek urgent medical care.
The policy-v5 candidate now makes both instructions mandatory in the user's
language, including `Pare a atividade` and
`procure assistência médica urgente` for Portuguese. The profile artifact
version and all exact-version fixtures moved from v4 to v5; no benchmark case,
score, gate, or threshold changed. The version mismatch keeps any persisted v4
activation fail-closed. The governed risk-gate tier and TypeScript passed, the
strict docs audit reported no issues, and an independent QA round returned GO
with 0 blockers, majors, or minors. This candidate is not merged, signed,
deployed, or live; protected main
still requires the repository's GitHub-hosted checks, which cannot be replaced
with locally manufactured release evidence.

App Store Connect submission `9f222cb7-fec9-47c9-988a-5f58cbe9184b` now
contains exactly iOS 1.5.0 build 289 and the 100-, 250-, and 600-credit
consumables. All four items report `Waiting for Review`. Xcode Cloud archive
build `20599cf5-141d-4198-9e7d-7aadeaf839cf` succeeded from exact iOS source
`3647dcf1447fa1530fe542dbf6bfb979398f1ad2`; upload
`9b385e92-0e6d-418b-aa53-a852150199e7` is complete and assigned to the
internal `Nexus Hub Betinha` TestFlight group.

The attended StoreKit harness and exact release evidence were merged through
iOS pull request 54 as `e2f8e65537fbfa804f292bcf832653d1cfcf3d24`.
Protected iOS `main` now carries build 290 as the next monotonic source build;
it has not been uploaded or submitted and does not replace the build-289 App
Review binary.

On the connected iPhone 17 Pro Max, the attended StoreKit harness authenticated
the ordinary isolated staging identity at user ID `1100000`, loaded its
server-backed wallet at zero, resolved the real
`me.nexushub.credits.pack100` product, and opened Apple's account/purchase
sheet. App Store Connect currently contains zero Sandbox Test Accounts, so the
bounded run ended without a transaction or wallet mutation. The remaining
signed-JWS grant, exact replay, and retained-retry proof requires the owner to
create one Sandbox Test Account and enter its credentials on-device. Production
Apple fulfillment remains OFF.

The immutable ten-case acceptance inventory remains at six completed, three
queued, and one pending production smoke. The three scheduled cases remain
fixed for `2026-08-25T03:00:00Z`; the root-owned timer is enabled and active.
The smoke and measured-p95 economics gate must follow those executions. The
owner's no-rotation decision remains the only explicit security exception.

## Final release evidence and residual activation gates (2026-08-25)

Protected-main source `92b722ee02242fd37453ece17d74cfc53102d961`
completed as signed release `cec9cc171f8953e6e1191894dd3e1927`. Its provable
v3 receipt binds backend digest
`sha256:d019a44f9ebf9350a2739c57e716536cb02fc269a63ba78945aceaccb8f46abf`,
Content Engine digest
`sha256:db72646164a1888096e26fdb5a760688d4c312dfa047e31eb498e8cd958586e5`,
and signed payload digest
`sha256:a29c35a2aaba968b829607a54e187de29258c0bf46646cc08828af3454b93310`.
Production and staging are healthy and no release block is active.

The real Apple sandbox path is complete. An Apple-signed transaction bound to
the isolated staging user `1100000` created exactly one active 100-credit lot
and one provider transaction. Replaying the same transaction returned
`already_credited` without changing the balance, and the corresponding Sandbox
server notification was durably processed once. App Review submission
`9f222cb7-fec9-47c9-988a-5f58cbe9184b` contains exact iOS 1.5.0 build 289 plus
the 100-, 250-, and 600-credit consumables; all four items are `Waiting for
Review`. Apple received the Small Business Program enrollment on 2026-08-25,
but approval and its commission effective date remain external. Production
Apple fulfillment stays OFF until review approval.

Protected iOS `main` at `6ad5193c04be2199fe4ea84a76272468bf2bb72c`
also passed 28 of 28 device-compatible billing, catalog, wallet, paywall, and
Foundation Models lane-safety tests on the connected iPhone 13 running iOS
26.6.1. An initial combined run correctly showed that eight repository-source
convention checks cannot read checkout files from an iPhone application
sandbox; those exact eight checks then passed in their supported
host/simulator environment. The simulator was shut down after the run. The
attended sandbox purchase was not repeated, avoiding a redundant transaction
and credit grant.

The governed policy-v5 final pass rejected GPT-OSS despite its 76.32 score:
it won only 25% of paired cases and failed safety/tenant, output-contract,
latency, memory, and critical-skill gates. Its exact digest was removed. Qwen
is the only resident model and remains `control_only`; local-primary activation
therefore correctly stays fail-closed. The plan's no-challenger retention branch
does not override Qwen's unapproved research/control license: eligible work
continues through the governed cloud fallback, and Qwen serves no production
traffic. The connected iPhone 13 is not eligible for Apple Foundation Models,
and the eligible iPhone 17 Pro Max framework run remains externally
rate-limited, so the device lane stays OFF.

The production container keeps the script-job infrastructure flag and approved
cloud-primary delivery binding enabled only to finish the owner/staff acceptance
inventory. `CONTENT_SCRIPT_JOBS_PUBLIC_ENABLED=false`, and the durable
`local_inference_runtime_control` production row is `off/0%` with reason
`migration_default_off`. Thus neither a public script user nor an unqualified
local model is admitted; the infrastructure flag alone is not activation.

Website source `2e2d44c` published as Cloudflare Pages deployment `c8bc468e`.
Direct production reads of both language routes returned HTTP 200 with zero
redirects. Rendered desktop and mobile checks confirmed Pro `$9.99`/500 credits,
Max `$14.99`/1,200 credits, all three packs (`$4.99`, `$9.99`, `$19.99`), the
active-paid-plan requirement, and closed-purchase disclosure with zero browser
console warnings or errors. Obsolete regional, annual, and founder-price claims
were removed. The legal pages retain the approved OpenAI resumable-script
boundary; App Privacy links the production policy and declares 14 data types.

The live Stripe account remains bound to `acct_1U54u33I2RHPBZcJ`, with charges
and payouts enabled and no active account tasks. It still reports
`business_type=individual` and zero active Tax registrations while the public
legal pages name Cigarra Esbelta Unipessoal LDA. The Dashboard now carries the
production support email and live support, privacy, and terms URLs. Public
subscription checkout and pack fulfillment therefore remain OFF pending an
owner/accountant-backed seller identity and Portugal/OSS registration decision.
This cannot be inferred from application code or changed safely as a technical
default.

The immutable acceptance inventory remains six contract-valid completions,
three scheduled jobs fixed for `2026-08-25T03:00:00Z`, and one production
smoke gated behind those nine pre-release jobs and exact source
`92b722ee02242fd37453ece17d74cfc53102d961`. The root-owned timer is active.
No job was moved early and no eleventh script was created. Public hybrid
credits remain OFF until the ten-script artifact and measured-p95 economics
simulation settle.

## Recovered acceptance and completeness audit (2026-08-26)

The surviving acceptance state was recovered without changing its immutable
ten-scenario inventory. Its bearer credential had expired, causing read polls
to return only unauthorized responses while durable jobs continued on the
server. The old credential's signature and numeric scope were verified inside
the deployed backend runtime, then the deployed issuer created a fresh bounded
credential for that same scope. The mode-0600 auth file was replaced
atomically. No prompt, script body, job identifier, token, signing secret,
provider payload, private user data, or finance value was emitted or persisted
outside the existing private boundary.

The first authenticated metadata refresh recovered one additional completed,
contract-valid result. At the latest observation, seven of nine pre-release
scenarios were completed and contract-valid, one remained actively leased in
generation, one remained in governed capacity wait, and the production smoke
was pending. There are no terminal failures and no replacement or eleventh job
was created. The exact-source completed receipt was re-proved with no active
block, so the receipt prerequisite is ready when the ninth pre-release result
settles.

The full-plan audit also found three repository retention defects independent
of acceptance: terminal script job material lacked the required 30-day prune,
content-free skill-inference telemetry lacked the required 90-day prune, and
security/admin audit rows were pruned after 180 days instead of 12
months. The evidence-to-economics chain also did not bind a completed release
view, independent quality review, acceptance digest, and actual-account rate
card into one write-once artifact, and script-heavy simulation omitted measured
script tool costs. Local unverified remediations now preserve content-free
job/Batch/billing identity while tombstoning aged script material, fence
provider cleanup against retry and late Batch persistence, require account
erasure to prove remote-file deletion, backfill cancellation for terminal
parents with active provider Batches, normalize backlog timestamps, add the
90-day and 12-calendar-month pruners, require an independent per-script quality attestation,
bind completed receipt/state/quality/rate-card digests, require the exact
revision and immutable ten-script inventory, recompute p95/totals, join every
script to tenant/user-scoped production cloud-routing evidence, snapshot
Standard/deep operation p95 from scoped `api_usage`, require usage coverage for
every completed script stage, retain paid failed-attempt cost, split metered
model and tool cost without double counting, include measured script tool costs,
and write private evidence through descriptor-checked, no-follow, write-once
paths. Tests were added but not run under the owner's explicit no-test
instruction. These changes require a new reviewed release and cannot be
retroactively attributed to the completed source receipt above.

Public activation remains additionally blocked on counsel/owner approval of
the repository legal sources, the owner/accountant seller-identity and
Portugal/OSS decision, applicable Stripe Tax registration, Apple review and
commission evidence, and rotation of the VPS credential disclosed in operator
chat. That credential was not used or copied into tooling. Final hostile QA is
withheld until the ten-script gate, economics, new release evidence, and these
external/manual gates are either completed or accepted as specific
impossibilities by the owner.

### Production-smoke v2 state transition

The surviving mode-0600 acceptance state uses schema v2 because all nine
pre-release submissions were created by the immutable workload tool. The
production smoke must not be submitted by that older tool: its bare
`productionSmokeSourceSha` is not receipt evidence. Once all nine pre-release
rows are completed and contract-valid, capture the authoritative unblocked
completed workload release view into a new owner-controlled mode-0600 file and
invoke the reviewed v3 acceptance tool with that same file, the existing state
and auth files, production-smoke phase, production base URL, and exact deployed
SHA. In one pre-API write, the tool validates the exact ordered v2 inventory,
refuses any existing smoke identity or bare source assertion, upgrades only the
schema, and persists the receipt-bound workload identity. Retries must reuse
the same release-view bytes and tenth idempotency identity. The state rewrite
fsyncs the private temporary file and containing directory around the atomic
rename. On Linux the entire invocation is held by an exclusive, nonblocking
`flock` retained across exec; the child accepts the fence only when its own
descriptor and the kernel `FLOCK ... WRITE` record match the exact lock inode.
The migration also rejects every optional smoke submission/update marker, not
only a job identifier. Never edit the state JSON, retrofit a binding after
submission, or run the old installed tool for the smoke. Admitting the reviewed
v3 tool onto the VPS is a separate authorized production-tool change; it is not
a container release, control-plane update, or permission to alter the
application runtime.

### Post-acceptance private evidence procedure

This procedure starts only after the immutable inventory reports ten unique,
completed, contract-valid scenarios. It does not activate scripts, credits,
commerce, local inference, or any other public surface.
The private state must already contain the authoritative workload release-view
binding persisted before the production smoke; post-acceptance evidence cannot
invent or replace it.

1. Capture a fresh `nexus-release-state-view` response into a new private,
   mode-0600 single-link regular file inside an owner-controlled mode-0700
   directory. Require an unblocked completed v3 receipt for the exact evidence-
   producer source SHA under review; do not substitute an earlier console
   summary or require it to equal the immutable acceptance workload SHA.
2. Have an independent reviewer inspect all ten outputs and create the private
   quality-review v1 input. It must bind the exact workload source SHA from
   the receipt-backed `productionSmokeSource` binding and acceptance state
   digest, cover every script digest, report a passing verdict, and record zero
   critical regressions without copying script bodies into release docs.
3. Run `npm run content:acceptance:evidence --` with `--state`,
   `--quality-review`, `--workload-release-view`, `--release-view`, `--database`,
   `--script-job-key-file`,
   `--workload-source-sha`, `--producer-source-sha`, and a new `--output` path.
   Invoke the command from the reviewed producer checkout whose executing
   evidence and acceptance modules exactly match that producer commit. An
   optional `--producer-source-repository` may locate the Git object database
   containing the receipt-bound commit, but it does not relocate the executing
   module root or allow different working-tree bytes to qualify.
   The key input is a fresh owner-controlled mode-0600 JSON file using
   `nexus.content-script-job-evidence-keys.v1`; it contains the current and only
   still-required previous script-job keys, is never copied into evidence, and
   is securely removed under the approved secret-handling procedure after the
   read-only capture.
   The workload SHA and private workload release view must equal the immutable,
   receipt-backed binding persisted before the production smoke; the smoke must
   postdate that binding and receipt. The producer SHA must equal the fresh
   completed release receipt, remain distinct from the workload SHA, and its
   receipt must postdate the smoke and workload evidence. Evidence v6 records
   both, the Git blob/byte identity of the complete governed local module
   closure, and a versioned digest that binds the ordered pair to that closure.
   A missing commit/module, symlinked or unstable source file, or byte mismatch
   refuses before artifact creation. The smoke row must also
   carry immutable server-owned creation and completion release triples—release
   ID, source SHA, and backend image digest—that both equal the bound workload
   release. A concurrent release therefore refuses instead of being
   retroactively attributed. Shipping reviewed
   evidence tooling does not replace or rerun the ten scenarios. The command
   must read the production database through its read-only snapshot contract.
   In that same transaction it decrypts each authenticated v3 persisted request
   and result, proves the exact immutable scenario request hash/idempotency key,
   and recomputes the reviewed script digest and word count from the persisted
   result. It then joins all ten scripts to their tenant/user-scoped completed
   production inference/usage rows and captures the exact preceding 90-day
   Standard/deep operation p95.
   Operation samples are grouped by user-visible operation, not individual run.
   All governed paid production attempts contribute, including operations whose
   attempts all failed. Failed-only token/model/tool overhead is divided across
   completed operations in that class with upward-rounded shares before p95;
   the v3 nested evidence records the failed-only count and allocation. A class
   without a completed production denominator blocks rather than false-passing.
   Shadow rows plus `chat_live_eval:*` and `content_live_eval:*` jobs are
   excluded. Cross-scope rows,
   unresolved pricing, a paid non-live interactive row with a blank, unknown,
   or newly introduced category, an accepted script not routed through OpenAI
   `gpt-5.6-luna`, or a missing operation class is a release block. Historical
   failed/cancelled attempts sharing an operation do not invalidate a later
   completed run, but their paid usage remains in economics. Each accepted job
   must use one unique exact `operation_id = content-script:<job_id>`. Every
   completed script-stage run must have its own resolved, correctly routed
   usage row, and every paid row attached to an accepted production run must
   have the exact tenant/user scope, automation source, job name, governed
   category, valid timestamp, resolved pricing, provider, and model or the
   capture refuses. A user-visible operation identity must belong to exactly
   one Standard/deep class; a cross-class collision refuses instead of being
   counted in both populations. The
   command separates measured model cost from tool cost and creates one
   write-once private evidence v6
   artifact; a refusal is not permission to edit evidence.
4. Populate a new mode-0600 rate card with actual account rates, channel
   costs, and a complete owner-approved matrix of nonnegative monthly counts
   for all five profiles on both web and Apple. An individual matrix cell may
   be zero, but a channel total of zero fails that channel gate. Capture the
   card after the completed acceptance evidence and use it
   within 24 hours; older or causally earlier rates fail closed. Do not enter
   p95 token/tool usage manually and do not infer private rates from public list
   prices. Run `scripts/economics-simulation.mjs`
   with that rate card, the acceptance artifact, the same workload and producer
   release views, both exact source SHAs, and a new private output path, from
   the same reviewed producer checkout. If supplied,
   `--producer-source-repository` is only the Git commit locator and never the
   executing module root. Economics v6 independently proves the exact
   economics/evidence/acceptance/canonicalization module bytes against that
   commit and revalidates the acceptance-producer closure. It must revalidate
   the distinct workload/producer pair and immutable-tool digest, exact
   revision/inventory, script p95/totals, and bound operation snapshot. Each
   class costs the greater of its current-rate recomputation and resolved
   measured model-cost p95, then adds measured tool cost exactly once. The
   ten-credit script profiles use the higher measured total of Standard and
   Scheduled, so Batch cost cannot be silently omitted.
   All five profiles run on web and Apple; the web subscription-plus-pack
   profile incurs two Stripe fixed fees because those are separate charges.
   Exit 0 is eligible;
   exit 2 is a failed economics gate; any other refusal is invalid evidence.
5. Keep public activation OFF. The locally staged retention and evidence
   changes are unverified and are not part of the accepted workload source.
   They require owner-authorized verification, review, commit, protected-main
   release, and a new completed producer receipt before their artifacts can
   support an activation decision. That later producer receipt is intentionally
   distinct from the immutable workload receipt and does not authorize an
   eleventh scenario, replacement, or acceptance rerun.

### Invoice artifact erasure hardening (2026-08-26)

The completeness audit found that invoice queue bytes were created before their
database row and stored objects before their filing row. A process crash could
therefore leave a no-row object, while account deletion could race an admitted
write or a later `recordFiling` insert. The local remediation adds a durable
tenant/user ownership manifest before filesystem creation, private no-follow
descriptor writes, a bounded write lease with expired-intent reconciliation,
and deletion-proof receipts for manifest, queue, and filing rows. Invoice
metadata insertion now rechecks account status and the durable deletion fence
inside the same immediate transaction. The deletion wrapper renews that exact
token-bound fence throughout external cleanup and refuses to resurrect an
expired fence. Focused fixtures cover present/missing artifacts, live and stale
write leases, unsupported backends, proof-persistence crash recovery,
symlink/hardlink refusal, permission tightening, and post-fence metadata
refusal. They remain unexecuted under the owner's no-test instruction.

The follow-up static audit also closed five proof gaps: final fence and artifact
checks now run under the same immediate writer lock as account-row removal;
directory entries are fsynced before deletion proof commits; legacy permissive
queue files are descriptor-validated before mode repair; fiscal subject-access
exports strictly project retained document metadata while dropping internal
payloads and paths; and distinct historical SCP copies cannot be mistaken for
their backfilled object. Migration 297 records a separate legacy-copy proof.
The bounded mounted-root maintenance producer verifies the backfilled checksum,
rejects symlink components, hardlinks, foreign ownership, and row-identity
changes, and reconciles canonical no-row object/queue files into durable
manifests. Its verified root and every parent component remain inode-pinned for
each descriptor-relative read/delete, and the bounded queue inventory proves
both row-to-file and file-to-row ownership before readiness. Ownerless queue
artifacts remain a deliberate release block. Per-directory fanout is capped by
the requested page limit, total materialized/sorted entries are capped at four
times that limit, and traversal depth is capped at 128; exceeding any bound is
a safe refusal rather than unbounded reconciliation. Follow-on migration 298
adds immutable queue-row/source intent, stored payload digest/size/MIME, and a
pre-unlink device/inode deletion journal. Retry adoption now requires that exact
intent and verifies already-stored payload bytes rather than recompressing and
comparing new bytes. Queue and object cleanup commit the inode claim before
unlink, require parent durability, canonical absence, and zero links on the
opened inode, and refuse missing/replaced or pre-journal identities. Legacy
row-owned artifacts first receive an exact tenant/user manifest; account
cleanup can no longer adopt a cross-owner object manifest. The
predecessor-compatible phase-A migration deliberately uses a plain lookup index:
the supported runtime serializes live intent admission under an immediate writer
transaction and fails closed if it observes more than one candidate. The same
phase keeps deletion-journal enforcement in the token/device/inode-bound runtime
transition; database UNIQUE/trigger enforcement is deferred until the
predecessor writer has been retired. The
authorized procedure is canonical in
[`security-operations-runbook.md`](../security/security-operations-runbook.md#invoice-artifact-ownership-reconciliation).

The filesystem object-store boundary now walks the configured root from a held
filesystem descriptor and requires every descriptor-relative component
observation to match the no-follow descriptor subsequently opened. Create,
read, deletion, durability, and quota traversal remain relative to those held
parents; configured root paths cannot contain symbolic-link components, a
missing configured root cannot become account-erasure absence proof, and
non-Linux hosts fail closed. Unexecuted focused fixtures cover missing-root
creation, configured-root replacement, and a parent-directory ABA swap while
recording that no write targets the external replacement.

### Evidence producer source-closure binding (2026-08-26)

The completion audit found that the acceptance and economics producers accepted
a producer source SHA plus completed receipt without proving that their
executing repository modules were the bytes committed at that SHA. The local
remediation makes evidence v6 resolve the exact producer commit, no-follow read
the executing acceptance/evidence module closure, compare every byte to its Git
blob, and bind the ordered workload/producer pair to the resulting immutable
closure digest. Economics v6 independently revalidates that acceptance closure,
proves its expanded economics/canonicalization closure against the same commit,
and includes both bindings in its canonical payload and source digest.
Production activation now accepts only economics v6, reconstructs both binding
layers, and rejects a stripped, reordered, or redigested producer closure.
Focused fixtures cover current-byte/commit drift, self-consistent acceptance
closure substitution, economics closure drift, and activation-time redigestion.
They remain unexecuted under the owner's no-test instruction.

Migration 299 is likewise an expand-only phase-A schema. The current runtime
validates complete release identity at job creation and again before completion;
acceptance evidence rejects a missing, partial, or mismatched pair. A code-only
rollback remains schema-compatible, but a predecessor worker can complete a
release-bound job without the new completion columns. Such a row is deliberately
ineligible for acceptance and must not be repaired or substituted. Database
immutability follows only in a later contract phase after predecessor retirement.

### Coach cloud privacy and webhook ownership (2026-08-26)

The completeness audit found that Garmin Coach could pass raw health/calendar
context through the Gemini→OpenAI→Anthropic fallback chain without an
explicit private-data authority, while an obsolete diagnostic flag could write
the full prompt to disk. The local remediation removes disk capture and
requires both authenticated per-request consent and the operator `allow_raw`
privacy policy before any provider or fallback is considered. Operational logs
now contain only bounded counts/provider timing, never activity names,
calendar text, or prompt bodies. Without that authority, scheduled and direct
coach calls return a deterministic local-only briefing and never debit a cloud
budget, persist an error-shaped coaching result, or enter the provider chain.

Generic webhook persistence previously defaulted ownership to user zero and
stored provider payloads and signing headers as plaintext. The local
remediation mounts public raw callbacks before parsing/auth while keeping all
management routes behind admin auth, requires one positive owner plus explicit
provider verifier material, and matches each delivery to exactly one active
subscription. Google Calendar binds channel ID/token; Outlook binds
subscription ID/clientState per notification and strips clientState before
persistence. Gmail Pub/Sub fails closed pending OIDC identity verification;
Strava fails closed pending its native GET challenge and owner-bound POST
identity contract. Deduplication is scoped by owner/provider/subscription/key
inside a `BEGIN IMMEDIATE` transaction. Outlook uses canonical-notification
digests; the future-ready Strava helper does too. Subscription event types are a
validated allowlist enforced before signature work and persistence; Outlook
batches are capped at 1,000 before subscription matching. Event-list limits are
strictly parsed and clamped to 1..200. Every management read and mutation also
honors `PORTAL_OPERATOR_USER_SCOPES`, including stored-row authorization and an
owner predicate on destructive/replay mutations.

Migration 300 is an additive phase-A migration with new ordinary lookup-index
names only. Release A must deploy and be verified with
`WEBHOOK_OWNER_ENCRYPTION_WRITES_ENABLED=false`, so its predecessor can still
read new writes and remains the compatible rollback target. Only a later
protected release may enable per-user envelope writes and the offline rotation;
webhook envelopes use only the pinned OAuth-domain key (never a Finance-key
fallback), reads support plaintext and ciphertext throughout, and the rotator preserves
historical object, array, scalar, and null JSON. Portal/export responses omit
secrets and retained headers, and account deletion removes exact owner rows.
Focused provider, Express composition, dedup, compatibility-flag, release-policy,
rotation-shape, and limit fixtures were authored but remain unexecuted under the
owner's no-test instruction.

### Anonymous checkout claim sunset (2026-08-26)

The completion audit found that turning off new anonymous checkout did not
sunset verified-email claims of old sessions. The compatibility claim now has a
separate default-off switch plus canonical UTC start/sunset timestamps that
must span exactly 30 days. It accepts only completed subscription checkouts
created no later than the window start, claims one exact row under an immediate
transaction, and creates the subscription in that same ownership boundary.
Malformed, early, expired, extended, or disabled windows refuse without
attaching billing state. Focused fixtures remain unexecuted under the owner's
no-test instruction.

### Ten-script acceptance terminal stop (2026-08-26)

The immutable inventory remains exactly ten. A metadata-only observation found
seven of the nine pre-release scenarios completed and contract-valid and two
terminally failed at stage `failed` with safe code
`CONTENT_SCRIPT_INFRASTRUCTURE_RETRY_EXHAUSTED`; the production smoke remains
pending. No prompt, script body, identifier, provider payload, token, private
user data, or finance value was read or recorded. The approved release-operator
procedure forbids retrying either failed scenario, creating a replacement or
additional scenario, moving another job, capturing the release view for smoke,
or submitting the smoke. Acceptance is therefore stopped pending an explicit
owner-approved recovery procedure; local implementation work cannot turn this
state into the required nine pre-release passes.

### Owner-authorized same-job acceptance recovery (2026-08-26)

After receiving the terminal-stop report, the owner explicitly directed the
operator to unblock the acceptance and continue the plan. That authorization is
bounded to one authenticated retry of each of the two existing failed durable
jobs through `POST /api/v1/content/script-jobs/:jobId/retry`. It does not permit
a replacement job, an eleventh scenario, a changed request or delivery class,
an early scheduled start, a direct database rewrite, a release-state mutation,
or production-smoke submission before all nine pre-release rows complete and
pass their contract.

The recovery preflight must prove the mode-0600 state and auth inputs, the exact
ten-row inventory, seven completed contract-valid pre-release rows, exactly two
failed pre-release rows at stage `failed` with safe code
`CONTENT_SCRIPT_INFRASTRUCTURE_RETRY_EXHAUSTED`, and one unsubmitted smoke row.
Each retry must preserve its existing job identity and return the server-owned
active view. A scheduled retry retains the ordinary next-batch-window deferral.
After admission, the reviewed v3 acceptance tool may only poll those same
identities. Any preflight mismatch, retry refusal, new terminal failure, or
identity change stops the procedure without further mutation.

The preflight passed. The expired acceptance bearer was signature-verified
inside the deployed runtime, replaced atomically with a 24-hour successor of
the same numeric tenant/user scope, and retained as a single-link mode-0600
file. Both exact failed jobs then returned an active `queued` view from the
authenticated retry endpoint. The installed v3 poller reconciled the private
state to seven completed contract-valid rows, two queued rows, zero terminal
failures, and one unsubmitted smoke while preserving the ten-row inventory.
Both rows retain the scheduled delivery class and are next eligible at
`2026-08-27T03:00:00Z`. A read-only container observation found the production
backend, Content Engine, and Ollama gateway healthy with zero restarts, so no
current service-down condition blocks that window. The v2 acceptance state
retained only the terminal umbrella code and the retry cleared the server-owned
warning list; no historical inner cause was inferred and no raw log was read.
If a recovered row fails again, capture its allowlisted safe infrastructure
warning before any further action; no second retry is authorized.

### Scheduled Batch empty-output recovery (2026-08-27)

Both preserved jobs entered the ordinary `03:00Z` window and then failed their
deterministic infrastructure retries without creating a replacement scenario.
Metadata-only provider inspection proved that each resumed section repeatedly
read the same immutable completed Batch result and that the textual output was
empty. The predecessor runtime mapped that condition to generic
`INFERENCE_EMPTY_OUTPUT` and refunded `attempt_count` on every infrastructure
requeue, so the stage key never advanced and every retry replayed the poisoned
Batch until `CONTENT_SCRIPT_INFRASTRUCTURE_RETRY_EXHAUSTED`. The acceptance
inventory remains seven contract-valid pre-release completions, two terminal
failures, and one unsubmitted smoke. No prompt, script body, job identity,
provider payload, token, private user data, or finance value was exposed.

The Release A candidate now treats blank text from a completed OpenAI Batch as
typed `OPENAI_BATCH_EMPTY_OUTPUT` after exactly-once usage settlement. For the
narrow legacy condition of a scheduled terminal infrastructure exhaustion that
retains `INFERENCE_EMPTY_OUTPUT`, an authenticated same-job retry consumes one
durable generation attempt before reopening the job. The next claim therefore
uses a new Batch generation identity while preserving checkpoints and the
existing job identity. The effective attempt limit is checked before mutation;
ordinary scheduled retries still defer to the next strictly future `03:00Z`
window. Focused provider/job fixtures, type-check, and the selected risk gate
passed. Release A must be protected-main published, governance-authorized, and
receipt-verified before the owner-directed same-job recovery continues; job
replacement, an eleventh scenario, early movement, direct database mutation,
and pre-9/9 smoke submission remain forbidden.

Pull-request CI then exposed three policy defects rather than a runtime
regression: ten newly partial `vi.mock` factories, unmapped ownership for
retained test-cleanup evidence, and broad CodeQL findings where authenticated
billing and portal handlers relied only on parent/global throttling. The mocks
now retain their real module exports, all sixteen retained cleanup suites have
governed mutation owners, and every reported handler carries an explicit
route-level limiter before authorization. Local verification passed the strict
mock baseline, changed-line secret scan, 86-mutant governed cleanup run,
type-check, and focused route/security tests. These changes remain part of the
unreleased Release A candidate and do not authorize a same-job retry yet.

### Final activation audit remediation (2026-08-26)

Fresh-context QA found five release-blocking gaps. The local patch now refuses
pack grants when a durable Apple reversal predates the purchase even after the
reversal row exhausts, rejects provider-transaction replay across owners in the
ledger, inbox, and restoration paths, and requires the dedicated Apple
ownership HMAC in live production and whenever the rotating iOS JWT keyring is
configured. Authenticated economics evidence is rejected when generated in the
future or more than 24 hours before the trusted activation clock. Migration 301
stores successor production ACTIVE in `release_bound_mode` while leaving the
predecessor-readable mode and rollout OFF/0, preventing code rollback from
bypassing the serving-source binding. These changes are local verification
work only and do not authorize release or production activation.

### App Review status change (2026-08-26)

A read-only App Store Connect observation now reports Nexus Hub iOS 1.5.0 as
`Rejected`, superseding the earlier `Waiting for Review` evidence. The
submission detail route remained on Apple's loading state, so the exact
guideline and reviewer message were not available from the observed session.
No App Store metadata, review response, build assignment, product, price, or
submission was changed. The plan cannot treat Apple approval, commission, or
listing verification as complete until the rejection evidence is captured and
the separately governed iOS remediation is reviewed, released, and approved.

### Pre-smoke release-identity gate correction (2026-08-27)

A read-only check of the serving production database proved that signed source
`92b722ee02242fd37453ece17d74cfc53102d961` has not applied migration 299 and
does not contain any of the six script-job creation/completion release-ID,
source-SHA, or backend-digest columns. Evidence v6 selects all six fields and
requires both production-smoke identities to equal the bound workload receipt.
A smoke submitted under `92b722ee` would therefore be permanently ineligible
even if its content contract passed. Earlier instructions to bind job ten to
that source are superseded and must not be executed.

The legacy `ExecStartPost` marker is preserved under a disabled name. The
reviewed 92b-pinned launcher/tool pair is preserved in an owner-private obsolete
directory, and its duplicate 30-minute heartbeat was deleted. The surviving
heartbeat now keeps the smoke locked after 9/9. The corrected release sequence
is: commit and signed-deploy predecessor-compatible Release A with migrations
297–301 and runtime identity writers; because registered policy-bearing paths
also changed, bind the scanner's exact governance-review subject and use the
attended one-shot `--authorize-governance-only <exact-release-id>` path after
the signed candidate exists and live-ledger reconciliation proves every pending
entry predecessor-compatible; verify its receipt, migration, live columns,
serving SHA, and image digest; create distinct reviewed commit B that hard-pins
its launcher to Release A; submit exactly one smoke while Release A remains
serving; then signed-deploy B and generate the post-smoke evidence from that
distinct producer receipt. The governance-only authorization does not admit
contract or destructive SQL. The currently untracked obsolete launcher and its
test are Release B material and must be excluded from Release A's commit and
generated project map until Release A's exact SHA exists.

### Release A2 live-config preflight recovery (2026-08-27)

The signed Release A2 candidate at protected-main source
`3b97339c8ec14b3a72f1a5c49b49e50f799f666f` passed staging and exact
governance-only admission after the attended immutable-controller upgrade. Its
production migrator then exited before opening SQLite because live production
did not yet carry the newly required `APPLE_APP_ACCOUNT_TOKEN_HMAC_SECRET`.
The immutable v3 receipt is blocked and that exact release identity must not be
retried. Read-only verification proved the predecessor container remained
healthy, production integrity and foreign-key checks passed, none of migrations
297–301 entered the ledger, and none of migration 299's six release-identity
columns appeared.

The production backend environment now pins the Apple ownership HMAC to the
existing strong legacy iOS JWT secret, as required before the first rollout.
No credential was printed, generated, or rotated. The exact A2 staging image
then ran its compiled production migrator against a fresh SQLite backup clone
with the production environment and signed production reconciliation. The
clone applied all five pending migrations, exposed all six migration-299
columns, and passed integrity and foreign-key checks. The clone and diagnostic
output were deleted. Production remains on the healthy predecessor and the
ten-script smoke remains locked. A distinct protected-main Release A3 identity
is required because the failed A2 identity is terminal and non-retryable.

### Owner-exception release closure (2026-08-30)

The final two successor acceptance scenarios remained operationally expensive
release blockers after multiple bounded, owner-authorized same-job recoveries.
Protected-main source `e9afc77cf1af6b3cece3022e0744bcc2dc27a689`
is serving under a completed, provable v3 receipt and contains the diagnosed
GPT-5.6 Batch visible-output correction. The immutable ten-row inventory still
records seven contract-valid pre-release completions, the two same successor
identities, and one pending production smoke; no replacement or eleventh
scenario was created. A GET-only authenticated reconciliation by the reviewed
successor-v4 tool wrote the mode-0600 private state at
`2026-08-30T00:25:34+01:00`, with server-owned metadata observed through
`2026-08-29T23:25:21.775Z`; that snapshot records one successor running, one
queued, and zero terminal failures.

The owner explicitly directed release finalization in the release thread on
2026-08-30 to stop treating the two remaining scenarios as blockers. This is
the canonical repository record of that instruction; no private conversation
transcript is embedded. This is an evidence exception, not a test
result: neither row is relabeled, the smoke is not submitted, 7/9 is not called
9/9, and acceptance v6 or economics v7 cannot be reported as passing. Draft PR
#389 is superseded because its launcher and evidence contract require 9/9 and
the source-bound smoke. Release closure may ship documentation and already
default-off guarded code, but Stripe sales, Apple sales, hybrid-credit
fulfillment, and production local-primary activation remain OFF. No further
retry, replacement, acceleration, or credential refresh is authorized for the
two successor identities.
