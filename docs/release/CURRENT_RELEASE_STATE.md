# Current Release State

Machine-readable truth: `docs/release/release-state.json`.

## Production

- Backend version: `4.14.230`
- Runtime commit: `36b96fab8d0987696ccd7e2ca35a343bca32da2f`
- Artifact digest: `07a09ffc1dd608710f203493a3bee244c296b2d8126adb5916a5427b28d0de05`
- Installed digest: `df54eea21739749e454153d931cfa01c953d5477f458009483fe4340b7be4aa6`
- Training catalog package: `51c1089cceb8a916abf200b5cb3688b19f5f7553990467ee0f8ef01c7c4f74bb`
- Training release subject: `27b97ebc96e1b3bb1ee3612e63c5609b5572c9d4b58e59b8ea3e77642fb1cea3`
- Completed at `2026-07-22T08:37:34.234Z` with an 81-second cutover.
- Backend health, database connectivity, media origin, PM2 process identity,
  staging parity, and exact installed-tree identity are healthy.
- Exact rollback backup:
  `v4.14.224_before-v4.14.230_20260722_093618.tar.gz`.

## Artifact-Bound Evidence

- Release candidate run: `29876582985`
- Protected signing run: `29878221235`
- Staging run/request: `29878760031` /
  `0a901fee-876d-44e6-ba36-fee8cf273d4a`
- Evidence remains under ignored `.local/release/` paths and restricted CI
  artifacts; this summary is not reusable promotion evidence.

## iOS / TestFlight

- iOS version/distributed build: `1.5.0` (259), from source build 59.
- Archived binary source: `f3d868783a52f549c235b11dc0a378fa7adfc43b`
- Final archive-signing PR head: `213e40d08edc84732079c08b1515312b9e9efb30`
- iOS `main`: `7fd4e96e2e0d2b51587777c0454698ea8a3b8b3f`
- IPA SHA-256: `5eeb35d43ae24fb16ef7d5bb631e8bbbdbe866f527150073a3dcdbf7a74bb2c8`
- Archive binary SHA-256: `b6f0215fab51f0d4d193cd4102e6c542bb56520e65669486af42aa117a1db7b5`
- Distribution attestation SHA-256:
  `35ebc4d1e2a27fc9d09e8ad089409191fc3b01b5e352bcc81c3ee53ff564452d`
- Xcode 26.6 / iPhoneOS 26.5 produced the validated Apple Distribution binary.
- Build 259 is available to the `Nexus Hub Betinha` internal TestFlight group
  and is `Waiting for Review` in App Store Connect with automatic release after
  approval. Builds 54-57 remain retained; physical-device smoke for
  build 259 remains open.

## Release Process

Ten signed staging attestations and six owner-authorized production releases
now prove the signed `ReleaseManifestV2`, immutable staging install, exact-artifact
promotion, atomic PM2 switch, and automatic exact rollback path.
The exact-artifact test, manifest, versioned-release, and documentation path is
the canonical release process. Its legacy repository-sync wrappers are now
retired. The signed root-owned promotion transaction is the sole runtime or
database mutation path for promotion and predecessor recovery. The legacy
`scripts/rollback.sh` and `scripts/restore.sh` commands remain available only
for read-only dry-run inventory; their apply modes are retired.

Every future production deployment, remote branch cleanup, and TestFlight
expiry still requires explicit owner authorization.
