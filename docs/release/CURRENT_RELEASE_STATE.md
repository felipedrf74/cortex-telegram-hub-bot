# Current Release State

Machine-readable truth: `docs/release/release-state.json`.

## Production

- Backend version: `4.14.218`
- Runtime commit: `6a2811bcb65184ee2939f6db9de97cfb166c3433`
- Artifact digest: `503b2e5072b6e7e78eb7a9a614aa77726db4fff4e2ac08e4b3d85f19f62ec2ed`
- Training catalog package: `51c1089cceb8a916abf200b5cb3688b19f5f7553990467ee0f8ef01c7c4f74bb`
- Training release subject: `27b97ebc96e1b3bb1ee3612e63c5609b5572c9d4b58e59b8ea3e77642fb1cea3`
- Verified healthy on 2026-07-14: backend health, database connectivity,
  media origin, PM2 process identity, staging parity, and Training smoke.

## iOS / TestFlight

- iOS version/build: `1.5.0` (55)
- iOS commit: `58069db585ff5e69253ba33051dc779ce19703bf`
- Build 55 is testing in the internal and external beta groups.
- Physical-device install/open/Training smoke is still required.
- Keep build 54 available until build 55 passes that gate.

## Release Process Migration

The exact-artifact test, manifest, versioned-release, and documentation work is
being implemented on `codex/release-test-doc-modernization`. It is not current
production truth. Legacy release wrappers remain available until two staging
rehearsals and two owner-authorized production releases validate the new path.

Production deployment, remote branch cleanup, and TestFlight expiry require
explicit owner authorization.
