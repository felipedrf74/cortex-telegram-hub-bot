---
name: release-operator
description: Prepare, inspect, stage, promote, or recover an exact Nexus Hub backend release. Use for release manifests, immutable bundles, staging parity, PM2 cutover, rollback, production status, or backend and iOS contract-bound promotion. Production mutation always requires explicit owner authorization.
---

# Nexus Release Operator

Start with `git status --short --branch` and `docs/release/release-state.json`.

Use the stable commands:

```bash
npm run release:status
npm run release:prepare -- --base <sha> --backend-only
npm run release:staging -- --manifest <path>
npm run release:promote -- --manifest <path>
```

For a shared backend/iOS contract candidate, replace `--backend-only` with
`--includes-ios --ios-sha <ios-sha> --ios-build-number <build> --ios-contract-result passed`
for preparation and the RC workflow. Those values are untrusted intent until
the protected signer validates the exact signed iOS Contract Evidence
attestation. Derive the evidence request from the downloaded RC bundle; it
contains the canonical candidate fixture bytes and digest that iOS must decode.
Run the protected Xcode Cloud `App Store Release` workflow for the same iOS
SHA/build and extract its signed distribution envelope. Request signing with
`--includes-ios`, `--ios-attestation <compatibility-json>`, and
`--ios-distribution-attestation <distribution-json>`; an omitted scope, either
attestation, or an exact SHA/build/fixture/archive match failure is hard.

- Treat `ReleaseManifestV2` plus its artifact digest as the promotion identity.
- Never reuse evidence after governed artifact or test-policy drift.
- Keep evidence under `.local/release/` and CI artifacts.
- Preserve fail-closed backup and exact rollback behavior.
- Do not deploy, push, expire TestFlight builds, or delete remote branches without explicit authorization.
- If backend/iOS contracts changed, require the exact iOS SHA, positive build
  number, and passed contract result in the manifest, all derived by protected
  tooling from signed iOS CI evidence rather than owner-entered signing fields.
  The manifest must also bind the exact backend candidate fixture and contract
  subject digests. Every governed selector must pass; failures and skips are
  not passing evidence. Separately require the Xcode Cloud-signed clean source,
  archive, exported App Store artifact, production signing, toolchain, and CI
  identity proof for the same SHA/build. Compatibility is not archive proof,
  and archive proof is not decoder compatibility.
  Never relabel a shared release as backend-only to bypass this gate.

Before handoff, run `npm run docs:audit`, the selected risk gate, and the
`verifiable-reward-check` skill. Report missing staging, device, or owner proof
as `MANUAL_REQUIRED`; never convert narrative text into release evidence.
