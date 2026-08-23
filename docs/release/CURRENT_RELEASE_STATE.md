# Current Release State

> **Process changed 2026-08-07** — see [`continuous-deployment.md`](continuous-deployment.md).
> The signed summary below was observed on 2026-08-23. Superseded PM2 and iOS
> snapshots remain in Git history, not in this current-state document. Authority is VPS state at
> `/var/lib/nexus-release/state/release-state.json` plus `/var/lib/nexus-release/receipts/`.
> Machine-readable projection: `docs/release/release-state.json` (generated, non-authoritative).

## Current signed state — 2026-08-23

- The active completed backend receipt is `a6ef7c948da5999d0762475f80527855`
  at protected-main source `8f75dfa2b2a9f387cf6a9a2999e8c37041605bce`.
  It runs backend digest
  `sha256:ce38af676bf203c48075dd3b63847f439a2c3aefed629d2fff6604448b7089a0`
  and Content Engine digest
  `sha256:db72646164a1888096e26fdb5a760688d4c312dfa047e31eb498e8cd958586e5`.
- iOS 1.5.0 build 279 from source
  `bb26ef7ee849833442e855c69033ff1c63194427` is distributed through
  TestFlight. App Store review submission
  `8fbed07b-db86-4679-9f2c-be8fbcda3c42` contains that build plus all three
  consumable credit packs and was submitted through the required website flow.
- The production website authority is [`https://nexushub.me/`](https://nexushub.me/).
  Prototype or preview deployments are not design or production references.
- Hybrid credits, subscription checkout, Stripe pack fulfillment, Apple pack
  fulfillment, and local-primary rollout remain OFF pending the acceptance,
  economics, model, and real Apple sandbox evidence recorded in the canonical
  hybrid plan/remediation log. Correct deployment is not activation evidence.

## Historical container lineage — 2026-08-19

- Every merge to protected main mints a new receipt, so this file records the
  chain and the authority, never a frozen head: read the active receipt from
  `sudo -n /usr/local/sbin/nexus-release-state-view` at audit time. Backup and
  receipt evidence: `sudo -n /usr/local/sbin/nexus-release-audit-evidence`.
  Lineage: `3970fac7` (halted, acked `d9ac4a92…`) → `c5a7ae67` → `e1c33aa8`
  → `eb851b1b` (QA4 fix) → `202f318a` (env posture) → `a7fe09ce` (QA5 fix,
  halted + acked `84389eb5…`) → `6de40b13` → `03a360ad` (QA6 fix, halted +
  acked `616d5b83…`) → this release.
- A `src/config.ts` delta halts unattended CD, and the owner ack alone never
  deploys that candidate — a fresh CD-eligible payload must follow it. Why,
  and the exact two-step:
  [`hybrid-commerce-qa-remediation-log.md`](hybrid-commerce-qa-remediation-log.md).
- Adversarial QA rounds 4, 5 and 6 (NH-0037) each returned NO-GO; every P0/P1
  and applicable P2 is closed in this release. Full findings and resolutions:
  [`hybrid-commerce-qa-remediation-log.md`](hybrid-commerce-qa-remediation-log.md).
- **Round 5 P0-1 was live in production**: `STRIPE_SANDBOX_CHECKOUT_ALLOWED=true`
  disarmed the guard that stops a test-mode key minting real entitlements, and
  anonymous checkout defaulted open, so an unauthenticated visitor could mint a
  permanent Pro/Max entitlement with a Stripe test card. The hatch is now scoped
  to non-live production, webhook livemode fails closed there, and the
  anonymous sunset defaults CLOSED. The flag is unset in production and boot
  refuses it there; round 6 re-verified all three layers at the runtime.
- Credit admission is now safe to enable: included lots are provisioned lazily
  and anchored to the billing period START, a read failure denies rather than
  re-anchors, and the ledger supersedes so live included credit can never
  exceed the plan allowance (round 6 P1). An audited admin grant route exists
  and startup refuses credits-on with no registered grant path.
- All six plan §5 kill switches now exist: 293 adds `subscription_checkout`
  and `storefront` in an additive table, enforced at the shared checkout choke
  point. Migrations 290–293 are all backfill/expand, predecessor-compatible.

## Release Process

Unattended recovery-first deployment: protected-main CI authorizes hosted
publication of the signed OCI payload and image pair, then the VPS poller runs
staging, exact backup, migration, production observation, and recovery while
publishing immutable receipts. The checkpoint remainder and owner-promotion
procedure above are PM2-era history, available only as the owner-authorized
first-cutover fallback. Historical staging-receipt polling defect `3b275a72…`
is closed, but its evidence is not a container release receipt.
