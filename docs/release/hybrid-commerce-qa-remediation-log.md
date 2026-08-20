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

**Deferred:** plan §5 names six kill switches and four exist; adding the
subscription and storefront switches requires rebuilding the control table's
CHECK constraint, which classifies as a contract migration and would halt
unattended CD. It ships as its own owner-acked change before activation.
Subscription checkout remains stoppable through the environment meanwhile.

**Accepted P3s (not re-blocking):** deep-class enforcement is a repo-grep pin
rather than a runtime guard; the apple-verify subscription path's bundleId
check is conditional; the DSAR Apple-inbox scan caps at the newest 5,000 rows.

## Validation before Apple activation

The App Store leaf policy (OID + end-entity check) mirrors what Apple's own
server library enforces, but it has not been exercised against a real Apple
notification because pack fulfillment is off and no App Store products exist
yet. Validate it against a live sandbox notification as part of Apple
activation, before enabling `APPLE_PACK_FULFILLMENT_ENABLED`.
