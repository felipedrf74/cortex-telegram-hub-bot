# Current Release State

> **Process changed 2026-08-07** — see [`continuous-deployment.md`](continuous-deployment.md).
> Figures below are the last recorded, historical, non-authoritative *PM2* snapshot;
> this repository projection proves no completed container receipt. Authority is VPS state at
> `/var/lib/nexus-release/state/release-state.json` plus `/var/lib/nexus-release/receipts/`.

Machine-readable projection: `docs/release/release-state.json` (generated, non-authoritative).

## Container release — completed 2026-08-19

- Active release (authoritative VPS receipt `nexus.release-receipt.v3`):
  source `c5a7ae674e09effc796363be6e1a2df044c7eb7d`, release id
  `0899260290ed401a0a262e35a5ea4484`, completed `2026-08-19T16:12:53.991Z`,
  payload `sha256:14a807f4f7129209f76545778bcbb1b68f99fa894d7ca7072e04a89f92b428d1`.
- Ships the hybrid AI commerce lineage (QA3 remediation `a7964fbe`,
  NH-0040/41 `3970fac7`) with every activation flag default-OFF; backend image
  `sha256:5ade7861…`, content engine `sha256:db726461…`; migrations 283–289
  applied; pre-promotion backup `nexus-db-20260819T161141Z.sqlite.age`
  (sha256 `1483715055da…`).
- Deployment history: the `3970fac7` payload halted unattended CD by design
  (`migration_not_cd_eligible`: its delta touched `src/config.ts`); the owner
  acknowledged candidate `d9ac4a92…` and this clean-delta docs payload
  deployed the identical application code. Poller GHCR read credential
  replaced `2026-08-19` (read:packages-only). Post-deploy: `/public-status`
  ok, production and staging containers healthy, `blocked: null`.

## Production

- Backend version: `4.14.232`
- Runtime commit: `3ac5ebbe4709a1e568ee9838c70ae3984e857de6`
- Artifact digest: `769f0f46e22d98c3ab5b4397555000434ffb3b56bbbb677dfae721a8167c8467`
- Installed-tree digest: `00d8c5d9f779a5b0c8bf025239f188848c2227adb1512d20cda62bc148a80ee6`
- Training catalog package: `51c1089cceb8a916abf200b5cb3688b19f5f7553990467ee0f8ef01c7c4f74bb`
- Training release subject: `27b97ebc96e1b3bb1ee3612e63c5609b5572c9d4b58e59b8ea3e77642fb1cea3`
- Transaction `20260805T214413Z-61d0c9b8e521` completed at `2026-08-05T21:45:28.188Z`
  in 74.134s: readiness 12.456s, soak 61.676s.
- Backend/content health, PM2 identity, artifact parity, smoke, migration startup, database integrity, backup, and rollback passed.
- Rollback was armed but not required; backup: `nexus-db-20260805T214421Z.sqlite.age`.

## Artifact-Bound Evidence

- Protected-main/checkpoint runs: `31047443271` / `31048263279`
- Compact manifest SHA-256: `d3dba958fe9b690296bd72e7e359b7a119d0b6e952e7ada4fbed6dbec09017f8`
- Staging/production transactions: `20260805T214301Z-16818898b3f6` / `20260805T214413Z-61d0c9b8e521`
- Encrypted backup SHA-256: `83911e31b212a4f36524a9e983484d033be9717cf35daf6091c67710ab2f4e6b`
- Fault drill `20260802T133139Z-1d33c71562f6` restored the predecessor in 2.696s
  against 120s; the current staging transaction then passed its 15s soak.
- `./scripts/staging-smoke.sh` passed 24/24 checks. Exact-SHA `local_engine`
  evaluation `chat-eval-2026-08-05T21-29-17-164Z` passed 7/7 scenarios at $0 actual cost.
- Evidence remains in ignored `.local/release/`, server state, and restricted CI
  artifacts; this summary is not reusable promotion evidence.

## Lean-Release Measurement

- Ten of ten measured releases passed (p50/p95: main 7m01s/17m33s, handoff
  55s/8m13s, checkpoint 4m21s/5m33s, readiness 16m21s/21m43s); median
  improvement 3m19s (16.86%). Partitions `6,897/10,136/17,033` tests were
  disjoint and complete; the protected-main artifact was reused unchanged.

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
