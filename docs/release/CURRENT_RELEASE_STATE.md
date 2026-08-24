# Current Release State

> **Process changed 2026-08-07** — see [`continuous-deployment.md`](continuous-deployment.md).
> The signed summary below was observed on 2026-08-24. Superseded PM2 and iOS
> snapshots remain in Git history, not in this current-state document. Authority is VPS state at
> `/var/lib/nexus-release/state/release-state.json` plus `/var/lib/nexus-release/receipts/`.
> Machine-readable projection: `docs/release/release-state.json` (generated, non-authoritative).

## Current signed state — 2026-08-24

- The active completed backend receipt is `e9d222cca5723c5fa22aa23d76c3547f`
  at protected-main source `aa4bfae2b96c98f20df72067c524538ba3318b66`.
  It runs backend digest
  `sha256:33ccf5f8dfaf6c9b585fec6d1600e4d7f57f6e71d20ec34b197af3cae16e9f78`
  and Content Engine digest
  `sha256:db72646164a1888096e26fdb5a760688d4c312dfa047e31eb498e8cd958586e5`.
  Its signed release-payload digest is
  `sha256:c3cb013af7530df9c031aebec7e808e00abe22297ab77cdebbf733bc3fd3e636`;
  the v3 receipt is provable and no release block is active.
- iOS 1.5.0 build 289 from protected-main source
  `3647dcf1447fa1530fe542dbf6bfb979398f1ad2` completed the Xcode Cloud App
  Store Release workflow and is assigned to the internal TestFlight group.
  App Store review submission `9f222cb7-fec9-47c9-988a-5f58cbe9184b`
  contains exactly that build plus the 100-, 250-, and 600-credit consumables;
  all four items are `Waiting for Review` after the required website flow.
  iOS pull request 54 subsequently merged as
  `e2f8e65537fbfa804f292bcf832653d1cfcf3d24`; protected `main` now carries
  build 290 as the next source carrier. Build 290 is not uploaded or submitted
  and does not change the exact build-289 App Review identity above.
- The production website authority is [`https://nexushub.me/`](https://nexushub.me/).
  Prototype or preview deployments are not design or production references.
- Hybrid credits, subscription checkout, Stripe pack fulfillment, Apple pack
  fulfillment, and local-primary rollout remain OFF pending the acceptance,
  economics, and real Apple sandbox evidence recorded in the canonical hybrid
  plan/remediation log. The governed GPT-OSS policy-v4 rerun produced no
  eligible local-primary winner, so the model lane correctly remains OFF.
  Correct deployment is not activation evidence.
- The durable ten-script inventory is fixed at six completed scripts, three
  scheduled for `2026-08-25T03:00:00Z`, and one post-release production smoke.
  No additional complete acceptance scripts may be generated or the scheduled
  jobs moved early merely to accelerate the gate.

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
