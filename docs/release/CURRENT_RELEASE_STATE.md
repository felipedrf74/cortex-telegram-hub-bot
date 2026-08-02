# Current Release State

Machine-readable truth: `docs/release/release-state.json`.

## Production

- Backend version: `4.14.232`
- Runtime commit: `d3f0db389458ecee3a2c6dff3249469d1c4228b2`
- Artifact digest: `abb492153eba81f192829d390aaaa660cde6a08cca26f145578cb283e9412375`
- Installed-tree digest: `3944f37f16dd1a526a53bee80758b4519298e260c6f6596d88dfad6a6dda55ae`
- Training catalog package: `51c1089cceb8a916abf200b5cb3688b19f5f7553990467ee0f8ef01c7c4f74bb`
- Training release subject: `27b97ebc96e1b3bb1ee3612e63c5609b5572c9d4b58e59b8ea3e77642fb1cea3`
- Transaction `20260802T093404Z-7ebfe6c05ca1` completed at
  `2026-08-02T09:35:19.247Z` in 73.884s: readiness 12.224s, soak 61.659s.
- Backend/content health, exact PM2 identity, artifact parity, authenticated
  smoke, migration startup, database integrity, backup, and rollback passed.
- Rollback was armed but not required; backup: `nexus-db-20260802T093412Z.sqlite.age`.

## Artifact-Bound Evidence

- Protected-main/checkpoint runs: `30736935248` / `30737533142`
- Compact manifest SHA-256: `06edea4e4af078ba8e0dbcf423ff981fe7c23f8b4e521dc10dd1a07acd282762`
- Staging/production transactions: `20260802T073100Z-dc324ff40f22` /
  `20260802T093404Z-7ebfe6c05ca1`
- Encrypted backup SHA-256: `7952c0c9b3fa4338ebb0c81cc70079460b91928aaa4161f4b0c55752fac5b4b9`
- Fault drill `20260802T072848Z-e4274563fa40` restored the predecessor in
  2.714s against 120s; normal staging then passed its 300s soak.
- `./scripts/staging-smoke.sh` passed 24/24 checks. Exact-SHA `local_engine`
  evaluation `chat-eval-2026-08-02T07-26-40-918Z` passed 7/7 scenarios at $0 actual cost.
- Evidence remains in ignored `.local/release/`, server state, and restricted
  CI artifacts; this summary is not reusable promotion evidence.

## Lean-Release Measurement

- Current sample: main 4m18s, handoff 7m08s, checkpoint 4m55s, automated
  readiness 16m21s; all passed.
- Selected/remainder/union: `1,115/15,635/16,750` tests and
  `95/1,036/1,131` files; partitions were disjoint and complete.
- Seven of ten releases are measured. Provisional nearest-rank p50/p95:
  main 7m01s/17m33s; handoff 1m05s/8m13s; checkpoint 4m21s/5m33s;
  automated readiness 16m21s/21m43s. The sample is not yet stable.
- Median improvement against 19m40s is 3m19s (16.86%); all seven promotions
  passed. Escaped-critical-defect review remains monitoring.
- The protected-main artifact was reused unchanged; hosts ran no build or test.

## Chat Quality Rollout

- Phases 1–4 are complete: the 300 reviewed rows, domain-routing snapshot, and
  corpus calibration are deployed. Bootstrap cache coverage is 25/300, with
  25/25 secretary rows correct; action-skill accuracy is not claimed.
- Phase 5 staging baseline `chat-eval-2026-07-31T17-19-58-073Z` is frozen with
  immutable hashes. Its acknowledged `operator_checkout_only` provenance is
  surfaced and is not represented as production evidence.
- Phase 6: 0/9 routes pass, two are insufficient and seven blocked; no legacy
  stage was disabled. Report SHA-256: `a1f4d81c58911083578d9fefe8179d2a431e5f1e2a317f024842716b64c15f5f`.
- Phase 7 is paused at `AI_ROUTING_MANIFEST_CLASSIFIER` / `classifierKeyword`:
  0/200 eligible comparisons against the fixed 99% gate. No later flag ran.
- The deterministic shadow recorder is absent in every staging scope, so live
  turns cannot yet generate gate evidence; it needs a governed staging enable.
- HMAC prerequisites pass in both roles. All seven flags are configured and
  effective OFF; master kill is available and OFF. Only genuine staging chat
  traffic can advance the gate.

## ServerDominguez Services

- Ollama is healthy on `127.0.0.1:11434`; sole model
  `qwen2.5:3b-instruct-q4_K_M` (`357c53fb659c5076de1d65ccb0b397446227b71a42be9d1603d46168015c9e4b`);
  the three larger/unused models are removed.
- SonarQube `26.7.0.124771` is healthy, private, capped, and advisory. Baseline
  `f0d4047def0c5838d562f06326d2e6949fe49770`, gate `OK`, backup, and restore passed.

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

## Notification Release Owner Gates

- Two notification feature states still require owner-only `.env` inspection.
- Production APNs, signed TestFlight delivery, and physical-device notification
  authorization-upgrade proof remain blocked.
- Staging database/port isolation remains unproven; PM2 shares user-level state.
