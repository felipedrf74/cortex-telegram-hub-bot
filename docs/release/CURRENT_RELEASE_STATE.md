# Current Release State

Machine-readable truth: `docs/release/release-state.json`.

## Production

- Backend version: `4.14.220`
- Runtime commit: `23ff10062c9f0c5aa2cdc43a3f24779f41472fda`
- Artifact digest: `f5bb5bd2a54f5a5420fcb9abab8d0d261a19eefc3d8e3756a01bc7ba4f65f596`
- Installed digest: `749a051e25310b7c0959252053f6d21d05b16e2f6e669a60162d9b947ea67696`
- Training catalog package: `51c1089cceb8a916abf200b5cb3688b19f5f7553990467ee0f8ef01c7c4f74bb`
- Training release subject: `27b97ebc96e1b3bb1ee3612e63c5609b5572c9d4b58e59b8ea3e77642fb1cea3`
- Completed at `2026-07-15T17:07:29.687Z` with a 13-second cutover.
- Backend health, database connectivity, media origin, PM2 process identity,
  staging parity, and exact installed-tree identity are healthy.
- Exact rollback backup:
  `v4.14.219_before-v4.14.220_20260715_180720.tar.gz`.

## Artifact-Bound Evidence

- Release candidate run: `29434399413`
- Protected signing run: `29434920029`
- Staging run/request: `29435069770` /
  `f2ca4bd4-9257-4d6d-b111-8c626548cd04`
- Evidence remains under ignored `.local/release/` paths and restricted CI
  artifacts; this summary is not reusable promotion evidence.

## iOS / TestFlight

- iOS version/build: `1.5.0` (56)
- Archived binary source: `dc57440ee2943d2dc80c2922e631ef681b13dcae`
- Refresh fix: `2fa5f47791b76f522d5c60eb398cee4a05bcf04a`
- PR head: `859e134e2645cdf70ce1c93c1386695da26c5a21`
- iOS `main`: `af9de2883c298d7c9683983865a00f973fc00259`
- Build 56 was uploaded and accepted for processing by App Store Connect; this
  does not prove availability. Availability and physical-device
  install/open/Training/media smoke remain open.
- Keep builds 54 and 55 available until build 56 passes that gate.

## Release Process

Two staging rehearsals and two owner-authorized production releases have now
proved the signed `ReleaseManifestV2`, immutable staging install, exact-artifact
promotion, atomic PM2 switch, and automatic exact rollback path.
The exact-artifact test, manifest, versioned-release, and documentation path is
the canonical release process. Its legacy repository-sync wrappers are now
retired; emergency exact rollback and restore paths remain available.

Every future production deployment, remote branch cleanup, and TestFlight
expiry still requires explicit owner authorization.
