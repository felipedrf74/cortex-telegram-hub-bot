# Current Release State

Machine-readable truth: `docs/release/release-state.json`.

## Production

- Backend version: `4.14.232`
- Runtime commit: `0c4af848349c2cf3c2c89fd4d66f039b481f62ae`
- Artifact digest: `f8d20b5f90c1477ff3fe6178490548828e63ecf872e868b8933bcd104e5e4cd7`
- Installed-tree digest: `3944f37f16dd1a526a53bee80758b4519298e260c6f6596d88dfad6a6dda55ae`
- Training catalog package: `51c1089cceb8a916abf200b5cb3688b19f5f7553990467ee0f8ef01c7c4f74bb`
- Training release subject: `27b97ebc96e1b3bb1ee3612e63c5609b5572c9d4b58e59b8ea3e77642fb1cea3`
- Transaction `20260802T135145Z-f649b11cfc35` completed at
  `2026-08-02T13:53:00.140Z` in 74.058s: readiness 12.220s, soak 61.837s.
- Backend/content health, exact PM2 identity, artifact parity, authenticated
  smoke, migration startup, database integrity, backup, and rollback passed.
- Rollback was armed but not required; backup: `nexus-db-20260802T135153Z.sqlite.age`.

## Artifact-Bound Evidence

- Protected-main/checkpoint runs: `30749642688` / `30749820570`
- Compact manifest SHA-256: `de440266b169506ce921dba0470b0acad71b5966c5469ea5a2fafda59e6ffc93`
- Staging/production transactions: `20260802T133357Z-681ace2c0e8d` /
  `20260802T135145Z-f649b11cfc35`
- Encrypted backup SHA-256: `4c240fe81496a2f897eaf9e301c6d832c662e0ffb00269cc8c744eb3f9067800`
- Fault drill `20260802T133139Z-1d33c71562f6` restored the predecessor in
  2.696s against 120s; normal staging then passed its 15s soak.
- `./scripts/staging-smoke.sh` passed 24/24 checks. Exact-SHA `local_engine`
  evaluation `chat-eval-2026-08-02T13-30-37-799Z` passed 7/7 scenarios at $0 actual cost.
- Evidence remains in ignored `.local/release/`, server state, and restricted
  CI artifacts; this summary is not reusable promotion evidence.

## Lean-Release Measurement

- Current sample: main 4m11s, handoff 55s, checkpoint 5m29s, automated
  readiness 10m35s; all passed.
- Selected/remainder/union: `1,130/15,636/16,766` tests and
  `96/1,036/1,132` files; partitions were disjoint and complete.
- Eight of ten releases are measured. Provisional nearest-rank p50/p95:
  main 4m19s/17m33s; handoff 55s/8m13s; checkpoint 4m21s/5m33s;
  automated readiness 14m10s/21m43s. The sample is not yet stable.
- Median improvement against 19m40s is 5m30s (27.97%); all eight promotions
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
  stage was disabled. Report SHA-256: `f8a00055927cb7596e1f470e619bc8ae5000689264da8c8324a3432eb7f9f842`.
- Phase 7 is paused at `AI_ROUTING_MANIFEST_CLASSIFIER` / `classifierKeyword`.
  No current-release traffic window or later flag ran; the last window was 0/200.
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
