# Current Release State

Machine-readable truth: `docs/release/release-state.json`.

## Production

- Backend version: `4.14.223`
- Runtime commit: `0005595477f2b798b36d13f2b9b53fd71c9b89b0`
- Artifact digest: `acced4e5dc3f0421e6d9cbdb92259227ebbfcedbc22cb3f4b24ec23e221c89e6`
- Installed digest: `a24e79aa2b9b91ff94d6df5aceccf333fd019b0af6ddf43c42b3d95c5f326cf2`
- Training catalog package: `51c1089cceb8a916abf200b5cb3688b19f5f7553990467ee0f8ef01c7c4f74bb`
- Training release subject: `27b97ebc96e1b3bb1ee3612e63c5609b5572c9d4b58e59b8ea3e77642fb1cea3`
- Completed at `2026-07-16T19:53:48.202Z` with a 25-second cutover.
- Backend health, database connectivity, media origin, PM2 process identity,
  staging parity, and exact installed-tree identity are healthy.
- Exact rollback backup:
  `v4.14.222_before-v4.14.223_20260716_205327.tar.gz`.

## Artifact-Bound Evidence

- Release candidate run: `29528861007`
- Protected signing run: `29529407372`
- Staging run/request: `29529675073` /
  `fc940429-81e8-4533-8250-a80c45d41dd7`
- Evidence remains under ignored `.local/release/` paths and restricted CI
  artifacts; this summary is not reusable promotion evidence.

## iOS / TestFlight

- iOS version/build: `1.5.0` (57)
- Archived binary source: `d2558f557a1852db92879303b57e86e07c72182a`
- Capacity refresh fix: `8ad3cc32b541e61682a4da2198cf9fe5dbf61970`
- PR head: `1ef4c6f22ca10bfb7393d2b45e1f5745903736f6`
- iOS `main`: `ebf836496e622f683bbea99efdb201ade5f04939`
- IPA SHA-256: `e4dd6648b0c2254439284d0dac8e88cf11b490fcbc45ec3d35d8615f9cddd3d2`
- Archive binary SHA-256: `5b6d5cac3d27017d0202c3739d4f6fe343d9bffadbfae9645480c498cc9774dc`
- Build 57 is `Testing` for `Nexus Hub Betinha` and `Betinhas`; builds 54, 55,
  and 56 remain available. Physical-device install/open/Training/media smoke
  for build 57 remains open.

## Release Process

Four staging rehearsals and four owner-authorized production releases have now
proved the signed `ReleaseManifestV2`, immutable staging install, exact-artifact
promotion, atomic PM2 switch, and automatic exact rollback path.
The exact-artifact test, manifest, versioned-release, and documentation path is
the canonical release process. Its legacy repository-sync wrappers are now
retired; emergency exact rollback and restore paths remain available.

Every future production deployment, remote branch cleanup, and TestFlight
expiry still requires explicit owner authorization.
