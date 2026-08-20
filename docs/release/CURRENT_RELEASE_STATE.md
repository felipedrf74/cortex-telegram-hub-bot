# Current Release State

> **Process changed 2026-08-07** — see [`continuous-deployment.md`](continuous-deployment.md).
> Figures below are the last recorded, historical, non-authoritative *PM2* snapshot;
> this repository projection proves no completed container receipt. Authority is VPS state at
> `/var/lib/nexus-release/state/release-state.json` plus `/var/lib/nexus-release/receipts/`.
> Machine-readable projection: `docs/release/release-state.json` (generated, non-authoritative).

## Container release — 2026-08-19 (hybrid commerce QA remediation lineage)

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

## Production

- Backend version: `4.14.232`
- Runtime commit: `3ac5ebbe4709a1e568ee9838c70ae3984e857de6`
- Artifact digest: `769f0f46e22d98c3ab5b4397555000434ffb3b56bbbb677dfae721a8167c8467`
- Installed-tree digest: `00d8c5d9f779a5b0c8bf025239f188848c2227adb1512d20cda62bc148a80ee6`
- Training catalog package: `51c1089cceb8a916abf200b5cb3688b19f5f7553990467ee0f8ef01c7c4f74bb`
- Training release subject: `27b97ebc96e1b3bb1ee3612e63c5609b5572c9d4b58e59b8ea3e77642fb1cea3`
- Transaction `20260805T214413Z-61d0c9b8e521` completed 2026-08-05 in 74.134s;
  all health/parity/smoke/migration/integrity/backup/rollback checks passed;
  backup `nexus-db-20260805T214421Z.sqlite.age` (rollback armed, unused).

## Artifact-Bound Evidence

- Protected-main/checkpoint runs: `31047443271` / `31048263279`; compact
  manifest SHA-256 `d3dba958fe9b…`; staging/production transactions
  `20260805T214301Z-16818898b3f6` / `20260805T214413Z-61d0c9b8e521`;
  encrypted backup SHA-256 `83911e31b212…`.
- Fault drill `20260802T133139Z-1d33c71562f6` restored predecessor in 2.696s/120s;
  staging-smoke 24/24; exact-SHA `local_engine` eval 7/7 at $0.
- Evidence: ignored `.local/release/`, server state, restricted CI artifacts.

## Lean-Release Measurement

- Ten of ten measured releases passed; median improvement 3m19s (16.86%);
  test partitions disjoint and complete; protected-main artifact reused unchanged.

## Chat Quality Rollout

- Phases 1–4 deployed; corpus exported with zero provider calls; calibration in `53164d51`.
- Phase 5 staging baseline `chat-eval-2026-07-31T17-19-58-073Z` frozen with
  immutable hashes (`operator_checkout_only` provenance, not production
  evidence). Phase 6 routing gate unmet (report SHA-256 `f8a00055…`).
- Phase 7 hit a genuine classifier gate on the predecessor; the staging
  observation failure was recovered as hash-bound `failure_acknowledged`
  without converting to a pass, and classifier rollback passed. All seven
  capability flags remain OFF; routing-gate evidence does not transfer.

## iOS / TestFlight

- iOS version/distributed build: `1.5.0` (259), from source build 59.
- Archived binary source: `f3d868783a52f549c235b11dc0a378fa7adfc43b`;
  archive-signing PR head: `213e40d08edc84732079c08b1515312b9e9efb30`;
  iOS `main`: `e6f374bdd77bdd5f47afcb82e546bdaa15b69985`.
- Build 259 remains in the `Nexus Hub Betinha` group; physical-device smoke is open.
- Review was rejected on 2026-07-24 under 2.1(b)/5.1.1(v); no resubmission,
  signed notification build, or TestFlight submission occurred in this release.
  Notification PR #35 is merged; signed-build and authorization-upgrade proof
  remain owner-gated.

## Release Process

Unattended recovery-first deployment: protected-main CI authorizes hosted
publication of the signed OCI payload and image pair, then the VPS poller runs
staging, exact backup, migration, production observation, and recovery while
publishing immutable receipts. The checkpoint remainder and owner-promotion
procedure above are PM2-era history, available only as the owner-authorized
first-cutover fallback. Historical staging-receipt polling defect `3b275a72…`
is closed, but its evidence is not a container release receipt.
