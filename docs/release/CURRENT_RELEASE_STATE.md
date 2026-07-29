# Current Release State

Machine-readable truth: `docs/release/release-state.json`.

## Production

- Backend version: `4.14.231`
- Runtime commit: `13ecc9da8aff96c8bcf512b2143ffdcf0c891467`
- Artifact digest: `027b75e8e5d964f62786a316b4e0c872b210442fa9fdd1e1895a1f12ed0495b6`
- Installed-tree digest:
  `950ca632781787d4e4e8ddad0c585627d5b176c7daa66dcb129236930f3ec27d`
- Training catalog package:
  `51c1089cceb8a916abf200b5cb3688b19f5f7553990467ee0f8ef01c7c4f74bb`
- Training release subject:
  `27b97ebc96e1b3bb1ee3612e63c5609b5572c9d4b58e59b8ea3e77642fb1cea3`
- Production transaction `20260729T085630Z-0a6de404352f` completed at
  `2026-07-29T08:57:45.631Z`.
- Backend and content health, exact PM2 runtime identity, artifact parity,
  authenticated smoke, migration startup, SQLite integrity, foreign keys,
  pre-promotion backup, rollback readiness, and the 60-second soak passed.
- The transaction took 74.311 seconds including a measured 61.636-second
  soak; candidate readiness before the soak took 12.674 seconds.
- Rollback was armed but not required. The encrypted backup is
  `nexus-db-20260729T085639Z.sqlite.age`.

## Artifact-Bound Evidence

- Protected-main run: `30386227503`
- Release-checkpoint run: `30386840581`
- Compact manifest SHA-256:
  `4dfe4cbce805bcb59b79e5cf294c7b53536cc3e63df00dfadc81364ea88fb33c`
- Staging transaction: `20260728T182335Z-209f1e16c020`
- Production transaction: `20260729T085630Z-0a6de404352f`
- Encrypted backup SHA-256:
  `717184285f9a957c7de2222e8a31581c6b3928894b02cc2651675788c1eb4245`
- Evidence remains under ignored `.local/release/` paths, server transaction
  state, and restricted CI artifacts; this summary is not reusable promotion
  evidence.

## First Lean-Release Measurement

- Main CI took 7m01s; the release checkpoint took 4m21s; their unattended
  handoff took 1m05s.
- Candidate readiness took 12m27s, 7m13s (36.7%) faster than the 19m40s
  observed baseline. This is one release, not yet a p50/p95 result.
- Main selected roughly 30% of the deterministic inventory. The checkpoint
  ran only the disjoint remainder, so the exact union stayed complete without
  rerunning the selected partition.
- The protected-main artifact was reused unchanged. Staging and production ran
  no build, dependency installation, Vitest, Python, or Sonar work.

## iOS / TestFlight

- iOS version/distributed build: `1.5.0` (259), from source build 59.
- Archived binary source: `f3d868783a52f549c235b11dc0a378fa7adfc43b`
- Final archive-signing PR head: `213e40d08edc84732079c08b1515312b9e9efb30`
- iOS `main`: `7fd4e96e2e0d2b51587777c0454698ea8a3b8b3f`
- Build 259 remains available to the `Nexus Hub Betinha` internal TestFlight
  group. Physical-device smoke remains open.
- App Store review was rejected on 2026-07-24 under Guidelines 2.1(b) and
  5.1.1(v). The machine state still says `waiting_for_review`; refreshing that
  iOS-only state remains a separate owner action.
- No iOS build, TestFlight submission, or iOS-main merge was performed as part
  of this backend release.

## Release Process

The lean path is active and proven. Codex and Claude Code must follow
`AGENTS.md`, the shared `release-operator` skill, and
`docs/release/README.md`: selected tests on protected main, one disjoint
four-shard remainder checkpoint, one immutable artifact, exact staging,
explicit owner approval, and one user-owned production transaction with backup,
health checks, a 60-second soak, and automatic predecessor recovery.

Legacy server release machinery remains installed pending its separately
authorized audited retirement. Every future production deployment, remote
branch cleanup, and TestFlight expiry still requires explicit owner
authorization.
