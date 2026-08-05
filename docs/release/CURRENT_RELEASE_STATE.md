# Current Release State

Machine-readable truth: `docs/release/release-state.json`.

## Production

- Backend version: `4.14.232`
- Runtime commit: `53164d51fa775d287732e71f8fed62cf2604b2a7`
- Artifact digest: `dca700c000ad44cada7ed4af7e5eb9c4507d729851f137bf3e16320bd571fe29`
- Installed-tree digest: `3944f37f16dd1a526a53bee80758b4519298e260c6f6596d88dfad6a6dda55ae`
- Training catalog package: `51c1089cceb8a916abf200b5cb3688b19f5f7553990467ee0f8ef01c7c4f74bb`
- Training release subject: `27b97ebc96e1b3bb1ee3612e63c5609b5572c9d4b58e59b8ea3e77642fb1cea3`
- Transaction `20260803T095052Z-bfd98c408c52` completed at `2026-08-03T09:52:07.851Z` in 74.374s: readiness 12.702s, soak 61.671s.
- Backend/content health, exact PM2 identity, artifact parity, authenticated
  smoke, migration startup, database integrity, backup, and rollback passed.
- Rollback was armed but not required; backup: `nexus-db-20260803T095101Z.sqlite.age`.

## Artifact-Bound Evidence

- Protected-main/checkpoint runs: `30800191821` / `30801186575`
- Compact manifest SHA-256: `cd51e786ee7656360bd330fbd17f8361a99b8d46d95f35ab16d7b3ad1c8ff98d`
- Staging/production transactions: `20260803T093209Z-3bb0ceb9547f` /
  `20260803T095052Z-bfd98c408c52`
- Encrypted backup SHA-256: `0f47c92279def2736f9a8391c82e6037fb7bed69ecb636efcf7721b2404fca4b`
- The latest required fault drill remains `20260802T133139Z-1d33c71562f6`; it
  restored the predecessor in 2.696s against 120s. The current staging
  transaction then passed its normal 15s soak.
- `./scripts/staging-smoke.sh` passed 24/24 checks. Exact-SHA `local_engine`
  evaluation `chat-eval-2026-08-03T09-30-21-240Z` passed 7/7 scenarios at $0 actual cost.
- Evidence remains in ignored `.local/release/`, server state, and restricted CI
  artifacts; this summary is not reusable promotion evidence.

## Lean-Release Measurement

- Current sample: main 13m41s, handoff 21s, checkpoint 4m21s, automated
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
