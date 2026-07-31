# Current Release State

Machine-readable truth: `docs/release/release-state.json`.

## Production

- Backend version: `4.14.231`
- Runtime commit: `77f92f6deb39f7419c24e73426fd338e6529b490`
- Artifact digest: `93e499e1fa819978f513bd4868fa23b1feb1706645013a5277e20121728b76b1`
- Installed-tree digest: `ce2014ae2398e10c287e9f2936f05dda98e9d2e77129d7a64401c872ac07259c`
- Training catalog package: `51c1089cceb8a916abf200b5cb3688b19f5f7553990467ee0f8ef01c7c4f74bb`
- Training release subject: `27b97ebc96e1b3bb1ee3612e63c5609b5572c9d4b58e59b8ea3e77642fb1cea3`
- Production transaction `20260731T162955Z-dc9b4daab9c8` completed at `2026-07-31T16:31:12.334Z`.
- Backend/content health, exact PM2 identity, artifact parity, authenticated
  smoke, migration startup, SQLite integrity, foreign keys,
  pre-promotion backup, rollback readiness, and the 60-second soak passed.
- The transaction took 74.549 seconds: 12.784 seconds to readiness and a
  measured 61.764-second soak.
- Rollback was armed but not required; backup: `nexus-db-20260731T163005Z.sqlite.age`.

## Artifact-Bound Evidence

- Protected-main run: `30644753549`
- Release-checkpoint run: `30645655928`
- Compact manifest SHA-256: `f5049c97ec870e60750f6c16e335cfca5d9208265732d965a0c4059821294f5a`
- Staging transaction: `20260731T162318Z-b43ce4561ee3`
- Production transaction: `20260731T162955Z-dc9b4daab9c8`
- Encrypted backup SHA-256: `6b4748a09c2a3708bc7ea974a84a0344ce4dd71fe9698641c586e5dce39610cc`
- Evidence remains in ignored `.local/release/`, server state, and restricted
  CI artifacts; this summary is not reusable promotion evidence.

## Lean-Release Measurement

- Current sample: main 4m19s (pass), unattended handoff 8m13s (miss), checkpoint
  5m17s (pass), and automated readiness 17m49s.
- Selected/remainder/union was `1,984/14,207/16,191` tests across
  `143/951/1,094` files; partitions were disjoint and complete.
- Four of ten releases are measured. Nearest-rank provisional p50/p95 values
  are 7m01s/16m32s for main, 29s/8m13s for unattended handoff,
  3m32s/5m17s for the checkpoint, and 14m10s/19m01s for automated readiness; the sample is not yet stable.
- The exact-`e256` cold core pack passed with files/cases `6/124` in 13.657
  seconds (14s wall) against 30s; one sample does not establish local p50/p95.
- Against the 19m40s readiness baseline, provisional median improvement is
  5m30s (27.97%). Promotion passed for all four observed releases; review for
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
- iOS `main`: `7fd4e96e2e0d2b51587777c0454698ea8a3b8b3f`
- Build 259 remains in the `Nexus Hub Betinha` group; physical-device smoke is open.
- Review was rejected on 2026-07-24 under 2.1(b)/5.1.1(v); no resubmission,
  iOS build, TestFlight submission, or iOS-main merge occurred in this release.

## Release Process

The lean path is active and proven. Codex and Claude Code must follow `AGENTS.md`,
the shared `release-operator` skill, and `docs/release/README.md`: selected
verification on protected main, one disjoint four-shard remainder checkpoint,
one artifact, exact staging, explicit owner approval, and one user-owned
production transaction with backup, health, soak, and predecessor recovery.

The canonical PM2 handoff and exact KVM cleanup transaction
`nexus-release-retirement-20260729T113728Z.service` passed. The final audit
planned no changes, found no retired UID/GID ownership, preserved lean/Sonar
state, and verified exact PM2/runtime identity plus four healthy endpoints.
Legacy retirement is complete. Future production, branch deletion, TestFlight
expiry, and post-retention bucket deletion require explicit owner authorization.

## Operational Closeout

- AWS export and restore proof passed for all 17 versions. Both Nexus stacks,
  the empty Sonar bucket, and Cost Anomaly monitor/subscription are deleted.
- ServerDominguez AWS writers were removed at `2026-07-29T11:33:44Z`; the
  export was preserved and all four application processes remained healthy.
- Only the compliance-locked application bucket is intentionally retained; its
  17 versions remain immutable through `2027-02-03T16:24:28Z`; writer access is
  revoked and deletion waits for an exact retention check after that timestamp.
- Owned IAM roles, Roles Anywhere trust anchors/profiles, CloudWatch alarms,
  and Cost Anomaly resources are gone; paid Cost Explorer granularity is off.
- Failed-health recovery passed in 2.705s. The disconnect proof captured unit
  `nexus-release-production-e256df55c446.service` (InvocationID
  `e94d806c22d74ed095bd20b4aec98178`, MainPID `371150`) and running soak before
  one local Ctrl-C interrupted polling. No post-disconnect active sample was
  captured because the unit completed before that read; the same transaction
  completed remotely and identical promote reused it without a second unit.
- Current staging first refused before mutation on a transient predecessor health
  timeout; the fault drill restored the predecessor in 2.699s, then normal staging passed.
