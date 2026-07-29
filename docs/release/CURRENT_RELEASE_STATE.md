# Current Release State

Machine-readable truth: `docs/release/release-state.json`.

## Production

- Backend version: `4.14.231`
- Runtime commit: `5828b1a629c68c29a605f5992f25c722af10f7e3`
- Artifact digest: `7172186724a8e54abf6b3ad3b457a3c3675ce08641101b587b532f2bb3b3575a`
- Installed-tree digest: `950ca632781787d4e4e8ddad0c585627d5b176c7daa66dcb129236930f3ec27d`
- Training catalog package: `51c1089cceb8a916abf200b5cb3688b19f5f7553990467ee0f8ef01c7c4f74bb`
- Training release subject: `27b97ebc96e1b3bb1ee3612e63c5609b5572c9d4b58e59b8ea3e77642fb1cea3`
- Production transaction `20260729T164330Z-f37c45f70dfb` completed at
  `2026-07-29T16:44:44.539Z`.
- Backend and content health, exact PM2 runtime identity, artifact parity,
  authenticated smoke, migration startup, SQLite integrity, foreign keys,
  pre-promotion backup, rollback readiness, and the 60-second soak passed.
- The transaction took 73.493 seconds including a measured 61.676-second
  soak; candidate readiness before the soak took 11.816 seconds.
- Rollback was armed but not required. The encrypted backup is
  `nexus-db-20260729T164337Z.sqlite.age`.

## Artifact-Bound Evidence

- Protected-main run: `30466249801`
- Release-checkpoint run: `30467664360`
- Compact manifest SHA-256: `ee0ec6bdc043bc139da0397f9c8e8ae57ada275ac484c724658207f060dfd8c5`
- Staging transaction: `20260729T155511Z-9a1419cf9da2`
- Production transaction: `20260729T164330Z-f37c45f70dfb`
- Encrypted backup SHA-256: `2b5368becac713a3535bdeed7690a553b16b83429ffc604038ccd0a0592b31af`
- Evidence remains under ignored `.local/release/` paths, server transaction
  state, and restricted CI artifacts; this summary is not reusable promotion
  evidence.

## First Lean-Release Measurement

- Main CI took 7m01s; the release checkpoint took 4m21s; their unattended
  handoff took 1m05s.
- Candidate readiness took 12m27s, 7m13s (36.7%) faster than the 19m40s
  observed baseline. Two releases are now observed, still below the ten needed
  for a stable p50/p95 result.
- Main selected roughly 30% of the deterministic inventory. The checkpoint
  ran only the disjoint remainder, so the exact union stayed complete without
  rerunning the selected partition.
- The protected-main artifact was reused unchanged. Staging and production ran
  no build, dependency installation, Vitest, Python test suite, or Sonar work.

## ServerDominguez Services

- Ollama is healthy on `127.0.0.1:11434`; `qwen2.5:3b-instruct-q4_K_M`
  (`357c53fb659c5076de1d65ccb0b397446227b71a42be9d1603d46168015c9e4b`) is
  the sole retained/loaded model; the three larger/unused models are removed.
- SonarQube Community Build `26.7.0.124771` is healthy, private, capped, and
  advisory. Baseline analysis of `f0d4047def0c5838d562f06326d2e6949fe49770`
  passed quality gate `OK`; its local backup and isolated restore drill passed.

## iOS / TestFlight

- iOS version/distributed build: `1.5.0` (259), from source build 59.
- Archived binary source: `f3d868783a52f549c235b11dc0a378fa7adfc43b`
- Final archive-signing PR head: `213e40d08edc84732079c08b1515312b9e9efb30`
- iOS `main`: `7fd4e96e2e0d2b51587777c0454698ea8a3b8b3f`
- Build 259 remains available to the `Nexus Hub Betinha` internal TestFlight
  group. Physical-device smoke remains open.
- App Store review was rejected on 2026-07-24 under Guidelines 2.1(b) and
  5.1.1(v); no resubmission was performed as part of this backend release.
- No iOS build, TestFlight submission, or iOS-main merge was performed as part
  of this backend release.

## Release Process

The lean path is active and proven. Codex and Claude Code must follow
`AGENTS.md`, the shared `release-operator` skill, and
`docs/release/README.md`: selected tests on protected main, one disjoint
four-shard remainder checkpoint, one immutable artifact, exact staging,
explicit owner approval, and one user-owned production transaction with backup,
health checks, a 60-second soak, and automatic predecessor recovery.

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
- Failed-health predecessor recovery passed in 2.705 seconds on the current
  candidate; the operator-disconnect drill still waits for a genuine candidate.
- Two of ten releases are measured; no p50 or p95 target is stable yet.
