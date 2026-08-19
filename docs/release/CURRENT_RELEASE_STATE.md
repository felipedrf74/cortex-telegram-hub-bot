# Current Release State

> **Process changed 2026-08-07** — see [`continuous-deployment.md`](continuous-deployment.md).
> Figures below are the last recorded, historical, non-authoritative *PM2* snapshot;
> this repository projection proves no completed container receipt. Authority is VPS state at
> `/var/lib/nexus-release/state/release-state.json` plus `/var/lib/nexus-release/receipts/`.

Machine-readable projection: `docs/release/release-state.json` (generated, non-authoritative).

## Container release — 2026-08-19 (QA4 remediation lineage)

- Every merge to protected main mints a new receipt, so this file records the
  chain and the authority, never a frozen head: read the active receipt from
  `sudo -n /usr/local/sbin/nexus-release-state-view` at audit time. Last
  read: source `e1c33aa8ccb3e50ce06b926faa94f94d75e148fc`, release id
  `7f8808b8e9aed6c30976a301a879bcb7`, completed `2026-08-19T16:23:59.542Z`,
  payload `sha256:21e94aa00d87…`, backup `nexus-db-20260819T162247Z.sqlite.age`.
  It superseded the docs-only `c5a7ae67` receipt `0899260290…` (retained as
  rollbackTarget) with identical images: backend `sha256:5ade7861…`, content
  engine `sha256:db726461…`; migrations 283–289 applied. Governance halt on
  `3970fac7` (`migration_not_cd_eligible`, config.ts delta) owner-acked as
  `d9ac4a92…`; poller GHCR read credential replaced 2026-08-19.
- Adversarial QA round 4 (NH-0037) returned NO-GO. Findings and state: P0-1
  handoff named a superseded receipt (corrected above; audits now run under a
  promotion freeze — no merges to main until the verdict lands). P1-2 the
  checkout key-mode guard dead-ends all web checkout on the test key while the
  Nexus Points path stayed unguarded (guard now uniform; owner must set
  `STRIPE_SANDBOX_CHECKOUT_ALLOWED=true` deliberately or install a live key).
  P1-3 `CLOUD_REASONING_FALLBACK_ENABLED=true` in production contradicts the
  default-OFF claim (owner env action pending; claim withdrawn here). P2-4/
  P2-5 restore-packs now refuses foreign-bundle and revoked transactions.
  P2-6 decided: the DB kill switch fails open to env-only behavior by design,
  now monitored — an unreadable control table raises a critical operator
  alert; the env switch remains the fail-safe stop.

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

- Protected-main/checkpoint runs: `31047443271` / `31048263279`
- Compact manifest SHA-256: `d3dba958fe9b690296bd72e7e359b7a119d0b6e952e7ada4fbed6dbec09017f8`
- Staging/production transactions: `20260805T214301Z-16818898b3f6` / `20260805T214413Z-61d0c9b8e521`
- Encrypted backup SHA-256: `83911e31b212a4f36524a9e983484d033be9717cf35daf6091c67710ab2f4e6b`
- Fault drill `20260802T133139Z-1d33c71562f6` restored predecessor in 2.696s/120s.
- staging-smoke 24/24; exact-SHA `local_engine` eval `chat-eval-2026-08-05T21-29-17-164Z` 7/7 at $0.
- Evidence remains in ignored `.local/release/`, server state, and restricted CI
  artifacts; this summary is not reusable promotion evidence.

## Lean-Release Measurement

- Ten of ten measured releases passed; median improvement 3m19s (16.86%);
  test partitions disjoint and complete; protected-main artifact reused unchanged.

## Chat Quality Rollout

- Phases 1–4 deployed (300 reviewed rows, routing snapshot, first calibration;
  bootstrap cache 25/300 with 25/25 secretary rows). Sanitized corpus exported
  with zero provider calls; calibration released in `53164d51`.
- Phase 5 staging baseline `chat-eval-2026-07-31T17-19-58-073Z` frozen with
  immutable hashes (`operator_checkout_only` provenance, not production
  evidence). Phase 6: 0/9 routes pass (report SHA-256 `f8a00055…`).
- Phase 7 hit a genuine 200/200 classifier gate on the predecessor; the staging
  observation failure was recovered as hash-bound `failure_acknowledged`
  without converting to a pass; classifier rollback passed. All seven
  capability flags remain OFF (master kill available); routing-gate evidence
  does not transfer releases, and `3ac5ebbe` has no gate yet.

## iOS / TestFlight

- iOS version/distributed build: `1.5.0` (259), from source build 59.
- Archived binary source: `f3d868783a52f549c235b11dc0a378fa7adfc43b`
- Final archive-signing PR head: `213e40d08edc84732079c08b1515312b9e9efb30`
- iOS `main`: `e6f374bdd77bdd5f47afcb82e546bdaa15b69985`
- Build 259 remains in the `Nexus Hub Betinha` group; physical-device smoke is open.
- Review was rejected on 2026-07-24 under 2.1(b)/5.1.1(v); no resubmission,
  signed notification build, or TestFlight submission occurred in this release.
- Notification PR #35 is merged; signed-build and authorization-upgrade proof
  remain owner-gated.

## Release Process

The current default is unattended recovery-first deployment: protected-main
selected CI authorizes hosted publication of the signed OCI payload and image
pair, then the VPS poller runs staging, exact backup, migration, production
observation, and recovery while publishing immutable receipts. The checkpoint
remainder and explicit owner-promotion procedure represented above are PM2-era
history and remain available only as the owner-authorized first-cutover fallback
during the initial 14 stable days. Historical staging-receipt polling defect
`3b275a7209cdc2f73c86c770ac069767848a3b44` is closed, but its evidence is not a
container release receipt.
