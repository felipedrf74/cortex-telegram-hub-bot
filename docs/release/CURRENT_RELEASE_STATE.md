# Current Release State

Machine-readable truth: `docs/release/release-state.json`.

## Production

- Backend version: `4.14.232`
- Runtime commit: `f4fe405aca2ce94e72ba809574f99d041bcb3bcd`
- Artifact digest: `26ca938a98c9270b0d5daefce6fdaed679a3a53132da904d448924f6c8f53f2d`
- Installed-tree digest: `3944f37f16dd1a526a53bee80758b4519298e260c6f6596d88dfad6a6dda55ae`
- Training catalog package: `51c1089cceb8a916abf200b5cb3688b19f5f7553990467ee0f8ef01c7c4f74bb`
- Training release subject: `27b97ebc96e1b3bb1ee3612e63c5609b5572c9d4b58e59b8ea3e77642fb1cea3`
- Transaction `20260803T054254Z-2a4481391b3d` completed at `2026-08-03T05:44:09.614Z` in 74.340s: readiness 12.644s, soak 61.695s.
- Backend/content health, exact PM2 identity, artifact parity, authenticated
  smoke, migration startup, database integrity, backup, and rollback passed.
- Rollback was armed but not required; backup: `nexus-db-20260803T054302Z.sqlite.age`.

## Artifact-Bound Evidence

- Protected-main/checkpoint runs: `30778758910` / `30779260105`
- Compact manifest SHA-256: `ce6b37c922885fe6045bb90020fdafdc3d4aca0b6382b2b572d4e9af8b0237ad`
- Staging/production transactions: `20260803T053850Z-22e8feffc812` /
  `20260803T054254Z-2a4481391b3d`
- Encrypted backup SHA-256: `01a55204e57711aa50b8cf35b24562c70d0e55212aa1cdd587128bc1caddfcc0`
- The latest required fault drill remains `20260802T133139Z-1d33c71562f6`; it
  restored the predecessor in 2.696s against 120s. The current staging
  transaction then passed its normal 15s soak.
- `./scripts/staging-smoke.sh` passed 24/24 checks. Exact-SHA `local_engine`
  evaluation `chat-eval-2026-08-03T02-35-30-360Z` passed 7/7 scenarios at $0 actual cost.
- Evidence remains in ignored `.local/release/`, server state, and restricted CI
  artifacts; this summary is not reusable promotion evidence.

## Lean-Release Measurement

- Current sample: main 11m05s, handoff 1m08s, checkpoint 4m23s, automated
  readiness 16m36s; all passed.
- Selected/remainder/union: `5,132/11,747/16,879` tests and
  `361/779/1,140` files; partitions were disjoint and complete.
- Nine of ten releases are measured. Provisional nearest-rank p50/p95:
  main 7m01s/17m33s; handoff 1m05s/8m13s; checkpoint 4m23s/5m33s;
  automated readiness 16m21s/21m43s. The sample is not yet stable.
- Median improvement against 19m40s is 3m19s (16.86%); all nine promotions
  passed. Escaped-critical-defect review remains monitoring.
- The protected-main artifact was reused unchanged; hosts ran no build or test.

## Chat Quality Rollout

- Phases 1–4 are complete: the 300 reviewed rows, domain-routing snapshot, and
  first corpus calibration are deployed. Bootstrap cache coverage is 25/300,
  with 25/25 secretary rows correct; action-skill accuracy is not claimed.
- The production-bound sanitized corpus export completed with zero provider
  calls. Its plan/receipt-bound monotonic calibration is generated and
  verified, but remains pending the final routing batch release.
- Phase 5 staging baseline `chat-eval-2026-07-31T17-19-58-073Z` is frozen with
  immutable hashes. Its acknowledged `operator_checkout_only` provenance is
  surfaced and is not represented as production evidence.
- Phase 6: 0/9 routes pass, two are insufficient and seven blocked; no legacy
  stage was disabled. Report SHA-256: `f8a00055927cb7596e1f470e619bc8ae5000689264da8c8324a3432eb7f9f842`.
- Phase 7 is paused at `AI_ROUTING_MANIFEST_CLASSIFIER` / `classifierKeyword`.
  No current-release traffic window or later flag ran; the last window was 0/200.
- The deterministic shadow recorder is deployed and effectively OFF (absent)
  in every staging scope; a governed enable is required before fresh traffic.
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
