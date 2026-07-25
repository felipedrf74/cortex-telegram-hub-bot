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
npm run release:resume -- --backend-only
```

Prefer `release:resume` for the sequential production path. If a current
protected-main reuse activation exists, store it as a private mode-0600 regular
file and add `--protected-reuse-activation <absolute-path>` on the first
invocation. The coordinator snapshots and digest-binds it before RC intent;
unsafe initial input records full-RC fallback, while later addition,
substitution, or snapshot drift is blocking.

The coordinator owns protected signing dispatch and staging signing
correlation. It persists the unique request and run identity before waiting;
the staging run title includes the exact raw request SHA-256, and the downloaded
signed payload must canonically equal those checkpointed request bytes. Resume
must reconcile or watch that exact request/run, never dispatch a replacement. The
staging operator's internal `--no-sign-request`, `--request-id`, and
`--coordinator-checkpoint` controls are coordinator-only. An already-active
exact staging release may resume only through that private checkpoint and
must first pass the root-installed control v3 pre-switch binding for installed
and recovery identity. Only root-sealed, artifact-bound preflight/readiness
scripts may then run, with generated evidence outside the immutable release
tree; authenticated smoke and PM2 identity repeat without reinstalling or
restarting.

The checkpoint lock is a persistent mode-0600 regular file held with OS
`lockf -k` on macOS or `flock` on Linux. Never delete a presumed stale lock
directory/file or start a second coordinator; lock contention, inode drift,
and lock-holder loss are fail-closed.

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
