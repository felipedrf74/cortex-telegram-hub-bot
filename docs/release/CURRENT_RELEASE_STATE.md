# Current Release State

Machine-readable truth: `docs/release/release-state.json`.

## Production

- Backend version: `4.14.224`
- Runtime commit: `74f89adc0f1cbb5657cf42808b9ac6dce18713ca`
- Artifact digest: `e7662f9d995fb0df38becb390ac3c54c31fe3c97347ebd104d03a9bcbad88c41`
- Installed digest: `f425e991e203a584ba99d4551550a9b021e4e0500fcdd36666c0da45a37d961b`
- Training catalog package: `51c1089cceb8a916abf200b5cb3688b19f5f7553990467ee0f8ef01c7c4f74bb`
- Training release subject: `27b97ebc96e1b3bb1ee3612e63c5609b5572c9d4b58e59b8ea3e77642fb1cea3`
- Completed at `2026-07-19T12:43:05.167Z` with a 48-second cutover.
- Backend health, database connectivity, media origin, PM2 process identity,
  staging parity, and exact installed-tree identity are healthy.
- Exact rollback backup:
  `v4.14.223_before-v4.14.224_20260719_134147.tar.gz`.

## Artifact-Bound Evidence

- Release candidate run: `29684934809`
- Protected signing run: `29685452278`
- Staging run/request: `29687437451` /
  `522c7ecc-2953-40f8-b2dd-93a51c69388b`
- Evidence remains under ignored `.local/release/` paths and restricted CI
  artifacts; this summary is not reusable promotion evidence.

## iOS / TestFlight

- iOS version/build: `1.5.0` (57)
- Archived binary source: `d2558f557a1852db92879303b57e86e07c72182a`
- Capacity refresh fix: `8ad3cc32b541e61682a4da2198cf9fe5dbf61970`
- PR head: `1ef4c6f22ca10bfb7393d2b45e1f5745903736f6`
- iOS `main`: `5486d5f69ebb1f80b417945fa2411a3b63c7681c`
- IPA SHA-256: `e4dd6648b0c2254439284d0dac8e88cf11b490fcbc45ec3d35d8615f9cddd3d2`
- Archive binary SHA-256: `5b6d5cac3d27017d0202c3739d4f6fe343d9bffadbfae9645480c498cc9774dc`
- Build 57 is `Testing` for `Nexus Hub Betinha` and `Betinhas`; builds 54, 55,
  and 56 remain available. Physical-device install/open/Training/media smoke
  for build 57 remains open.

## Release Process

Five staging rehearsals and five owner-authorized production releases have now
proved the signed `ReleaseManifestV2`, immutable staging install, exact-artifact
promotion, atomic PM2 switch, and automatic exact rollback path.
The exact-artifact test, manifest, versioned-release, and documentation path is
the canonical release process. Its legacy repository-sync wrappers are now
retired; emergency exact rollback and restore paths remain available.

Every future production deployment, remote branch cleanup, and TestFlight
expiry still requires explicit owner authorization.
