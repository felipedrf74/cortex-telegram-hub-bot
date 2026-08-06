# Current Release State

Machine-readable truth: `docs/release/release-state.json`.

## Production

- Backend version: `4.14.232`
- Runtime commit: `3ac5ebbe4709a1e568ee9838c70ae3984e857de6`
- Artifact digest: `769f0f46e22d98c3ab5b4397555000434ffb3b56bbbb677dfae721a8167c8467`
- Installed-tree digest: `00d8c5d9f779a5b0c8bf025239f188848c2227adb1512d20cda62bc148a80ee6`
- Training catalog package: `51c1089cceb8a916abf200b5cb3688b19f5f7553990467ee0f8ef01c7c4f74bb`
- Training release subject: `27b97ebc96e1b3bb1ee3612e63c5609b5572c9d4b58e59b8ea3e77642fb1cea3`
- Transaction `20260805T214413Z-61d0c9b8e521` completed at
  `2026-08-05T21:45:28.188Z` in 74.134s: readiness 12.456s, soak 61.676s.
- Backend/content health, exact PM2 identity, artifact parity, authenticated
  smoke, migration startup, database integrity, backup, and rollback passed.
- Rollback was armed but not required; backup: `nexus-db-20260805T214421Z.sqlite.age`.

## Artifact-Bound Evidence

- Protected-main/checkpoint runs: `31047443271` / `31048263279`
- Compact manifest SHA-256: `d3dba958fe9b690296bd72e7e359b7a119d0b6e952e7ada4fbed6dbec09017f8`
- Staging/production transactions: `20260805T214301Z-16818898b3f6` /
  `20260805T214413Z-61d0c9b8e521`
- Encrypted backup SHA-256: `83911e31b212a4f36524a9e983484d033be9717cf35daf6091c67710ab2f4e6b`
- The latest required fault drill remains `20260802T133139Z-1d33c71562f6`; it
  restored the predecessor in 2.696s against 120s. The current staging
  transaction then passed its normal 15s soak.
- `./scripts/staging-smoke.sh` passed 24/24 checks. Exact-SHA `local_engine`
  evaluation `chat-eval-2026-08-05T21-29-17-164Z` passed 7/7 scenarios at $0 actual cost.
- Evidence remains in ignored `.local/release/`, server state, and restricted CI
  artifacts; this summary is not reusable promotion evidence.

## Lean-Release Measurement

- Final measurement sample: main 13m41s, handoff 21s, checkpoint 4m21s, automated
  readiness 18m23s; all passed.
- Selected/remainder/union: `6,897/10,136/17,033` tests and
  `447/693/1,140` files; partitions were disjoint and complete.
- Ten of ten releases are measured. Stable nearest-rank p50/p95:
  main 7m01s/17m33s; handoff 55s/8m13s; checkpoint 4m21s/5m33s;
  automated readiness 16m21s/21m43s.
- Median improvement against 19m40s is 3m19s (16.86%); all ten promotions
  passed. Escaped-critical-defect review remains monitoring.
- The protected-main artifact was reused unchanged; hosts ran no build or test.

## Chat Quality Rollout

- Phases 1–4 are complete: the 300 reviewed rows, domain-routing snapshot, and
  first corpus calibration are deployed. Bootstrap cache coverage is 25/300,
  with 25/25 secretary rows correct; action-skill accuracy is not claimed.
- The production-bound sanitized corpus export completed with zero provider
  calls. Its plan/receipt-bound monotonic calibration was verified and released
  in `53164d51fa775d287732e71f8fed62cf2604b2a7`.
- Phase 5 staging baseline `chat-eval-2026-07-31T17-19-58-073Z` is frozen with
  immutable hashes. Its acknowledged `operator_checkout_only` provenance is
  surfaced and is not represented as production evidence.
- Phase 6: 0/9 routes pass, two are insufficient and seven blocked; no legacy
  stage was disabled. Report SHA-256: `f8a00055927cb7596e1f470e619bc8ae5000689264da8c8324a3432eb7f9f842`.
- Phase 7 reached a genuine 200/200 (100%) classifier agreement gate on the
  predecessor release. The staging classifier enable passed, but its observation
  failed before receipt publication because missing retirement evidence was
  incorrectly paged as a regression. The classifier rollback passed and all
  seven capability flags are OFF.
- The failed observation plan and canonical smoke remain immutable. Its
  protected-main, hash-bound `failure_acknowledged` recovery published without
  converting the failure into a pass; classifier rollback and the predecessor
  recorder disable both passed.
- Routing-gate evidence does not transfer releases. The current `3ac5ebbe`
  release has no gate yet; HMAC presence was re-attested in both roles and the
  dedicated staging recorder is ON only at USER/TENANT scope while fresh,
  genuine staging traffic is collected.
- All seven capability flags are configured and effective OFF; master kill is
  available and OFF. No later capability flag has started.

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

The proven lean path remains mandatory: protected-main selection, disjoint
checkpoint remainder, one exact artifact, staging, explicit owner approval,
and one production transaction with backup, health, soak, and recovery.
Staging-receipt polling defect `3b275a7209cdc2f73c86c770ac069767848a3b44`
is closed; malformed or identity-drifting receipts fail closed.
