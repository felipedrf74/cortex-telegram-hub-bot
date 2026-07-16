# Current Release State

Machine-readable truth: `docs/release/release-state.json`.

## Production

- Backend version: `4.14.222`
- Runtime commit: `73c8ef18d39cf4d37f118fc0e5f0f5956b708fd6`
- Artifact digest: `cc3f282a34e8a0c581caf19b8b2253f436b2d5960f7666612251efd31bc89baf`
- Installed digest: `07493cacf290076d2640368392c59d82efda005484ee85dc84b0b2f30854d5b4`
- Training catalog package: `51c1089cceb8a916abf200b5cb3688b19f5f7553990467ee0f8ef01c7c4f74bb`
- Training release subject: `27b97ebc96e1b3bb1ee3612e63c5609b5572c9d4b58e59b8ea3e77642fb1cea3`
- Completed at `2026-07-16T15:45:23.011Z` with a 24-second cutover.
- Backend health, database connectivity, media origin, PM2 process identity,
  staging parity, and exact installed-tree identity are healthy.
- Exact rollback backup:
  `v4.14.220_before-v4.14.222_20260716_164502.tar.gz`.

## Artifact-Bound Evidence

- Release candidate run: `29511246434`
- Protected signing run: `29511811545`
- Staging run/request: `29512377896` /
  `85cf19d7-7c7d-442e-a8a9-d847cb229b8b`
- Evidence remains under ignored `.local/release/` paths and restricted CI
  artifacts; this summary is not reusable promotion evidence.

## iOS / TestFlight

- iOS version/build: `1.5.0` (57)
- Archived binary source: `d2558f557a1852db92879303b57e86e07c72182a`
- Capacity refresh fix: `8ad3cc32b541e61682a4da2198cf9fe5dbf61970`
- PR head: `1ef4c6f22ca10bfb7393d2b45e1f5745903736f6`
- iOS `main`: `d2558f557a1852db92879303b57e86e07c72182a`
- IPA SHA-256: `e4dd6648b0c2254439284d0dac8e88cf11b490fcbc45ec3d35d8615f9cddd3d2`
- Archive binary SHA-256: `5b6d5cac3d27017d0202c3739d4f6fe343d9bffadbfae9645480c498cc9774dc`
- Build 57 is `Testing` for `Nexus Hub Betinha` and `Betinhas`; builds 54, 55,
  and 56 remain available. Physical-device install/open/Training/media smoke
  for build 57 remains open.

## Release Process

Three staging rehearsals and three owner-authorized production releases have now
proved the signed `ReleaseManifestV2`, immutable staging install, exact-artifact
promotion, atomic PM2 switch, and automatic exact rollback path.
The exact-artifact test, manifest, versioned-release, and documentation path is
the canonical release process. Its legacy repository-sync wrappers are now
retired; emergency exact rollback and restore paths remain available.

Every future production deployment, remote branch cleanup, and TestFlight
expiry still requires explicit owner authorization.
