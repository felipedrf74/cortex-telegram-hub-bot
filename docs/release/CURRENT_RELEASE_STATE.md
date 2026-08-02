# Current Release State

Machine-readable truth: `docs/release/release-state.json`.

## Production

- Backend version: `4.14.232`
- Runtime commit: `8783409632073c87ee49eaac99e91ddf6bfa6880`
- Artifact digest: `a786b16a0e199db736b3846b0100b486bd932ae652072718a7458f0faac23c38`
- Installed-tree digest: `3944f37f16dd1a526a53bee80758b4519298e260c6f6596d88dfad6a6dda55ae`
- Training catalog package: `51c1089cceb8a916abf200b5cb3688b19f5f7553990467ee0f8ef01c7c4f74bb`
- Training release subject: `27b97ebc96e1b3bb1ee3612e63c5609b5572c9d4b58e59b8ea3e77642fb1cea3`
- Production transaction `20260802T030916Z-9cafc1d52544` completed at `2026-08-02T03:10:31.429Z`.
- Backend/content health, exact PM2 identity, artifact parity, authenticated
  smoke, migration startup, SQLite integrity, foreign keys,
  pre-promotion backup, rollback readiness, and the 60-second soak passed.
- The transaction took 73.917 seconds: 12.212 seconds to readiness and a
  measured 61.704-second soak.
- Rollback was armed but not required; backup: `nexus-db-20260802T030924Z.sqlite.age`.

## Artifact-Bound Evidence

- Protected-main run: `30729143268`
- Release-checkpoint run: `30729700062`
- Compact manifest SHA-256: `3dd9c748883523a807f55c0dcb525e45802f08068a480b42df0ceb61c0927952`
- Staging transaction: `20260802T030237Z-87ea25e958b6`
- Production transaction: `20260802T030916Z-9cafc1d52544`
- Encrypted backup SHA-256: `07a9eab44be961461f4cdd58f5012e54038f617ec3a8d2b20dae6d56403cc982`
- Staging fault drill `20260802T025941Z-2ed894227116` restored the predecessor in 2.700 seconds against the 120-second objective; the normal staging transaction then passed its 300-second soak.
- `./scripts/staging-smoke.sh` passed 28/28 checks. Exact-SHA `local_engine`
  evaluation `chat-eval-2026-08-02T02-45-18-816Z` passed 7/7 scenarios.
- Evidence remains in ignored `.local/release/`, server state, and restricted
  CI artifacts; this summary is not reusable promotion evidence.

## Lean-Release Measurement

- Current sample: main 17m33s (pass), unattended handoff 1m45s (pass), checkpoint
  2m25s (pass), and automated readiness 21m43s.
- Selected/remainder/union was `13,417/3,220/16,637` tests across
  `875/247/1,122` files; partitions were disjoint and complete.
- Six of ten releases are measured. Nearest-rank provisional p50/p95 values
  are 7m01s/17m33s for main, 29s/8m13s for unattended handoff,
  3m32s/5m33s for the checkpoint, and 14m10s/21m43s for automated readiness; the sample is not yet stable.
- The exact-`e256` cold core pack passed with files/cases `6/124` in 13.657
  seconds (14s wall) against 30s; one sample does not establish local p50/p95.
- Against the 19m40s readiness baseline, provisional median improvement is
  5m30s (27.97%). Promotion passed for all six observed releases; review for
  escaped critical defects remains in monitoring and makes no zero-defect claim.
- The protected-main artifact was reused unchanged. Staging and production ran
  no build, dependency installation, Vitest, Python test suite, or Sonar work.

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
- Notification PR #35 merged into iOS `main`; signed-build and provisional-to-full
  authorization-upgrade proof remain owner-gated.

## Release Process

The lean path is active and proven. Codex and Claude Code must follow `AGENTS.md`,
the shared `release-operator` skill, and `docs/release/README.md`: selected
verification on protected main, one disjoint four-shard remainder checkpoint,
one artifact, exact staging, explicit owner approval, and one user-owned
production transaction with backup, health, soak, and predecessor recovery.

The prior staging-receipt polling defect is closed by
`3b275a7209cdc2f73c86c770ac069767848a3b44`. Polling now ignores a valid
non-matching predecessor transaction ID until the requested transaction appears
or the deadline expires, while malformed state and matching-ID release-identity
drift remain fail-closed.

## Notification Release Owner Gates

- `DECISION_TYPE_SUPPRESSION_ENABLED` production state is blocked on owner-only
  `.env` inspection.
- `NOTIFICATION_PRIORITY_SHADOW_SCORING_ENABLED` production state is blocked on
  owner-only `.env` inspection.
- Production APNs credentials and physical-device delivery proof (`PROD-APNS`)
  remain blocked.
- A signed TestFlight build and manual provisional-to-full notification upgrade
  remain blocked.
- Staging database/port isolation remains unproven; the staging environment is
  owner-readable only, and PM2 still shares the user-level state directory.
