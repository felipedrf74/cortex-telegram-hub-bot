---
name: release-operator
description: Prepare, inspect, stage, promote, or recover an exact Nexus Hub backend release. Use for release manifests, immutable bundles, staging parity, PM2 cutover, rollback, production status, or backend and iOS contract-bound promotion. Production mutation always requires explicit owner authorization.
---

# Nexus Release Operator

Start with `git status --short --branch` and `docs/release/release-state.json`.

Use the stable commands:

```bash
npm run release:status
npm run release:prepare -- --base <sha>
npm run release:staging -- --manifest <path>
npm run release:promote -- --manifest <path>
```

- Treat `ReleaseManifestV2` plus its artifact digest as the promotion identity.
- Never reuse evidence after governed artifact or test-policy drift.
- Keep evidence under `.local/release/` and CI artifacts.
- Preserve fail-closed backup and exact rollback behavior.
- Do not deploy, push, expire TestFlight builds, or delete remote branches without explicit authorization.
- If backend/iOS contracts changed, require the iOS SHA, build number, and contract result in the manifest.

Before handoff, run `npm run docs:audit`, the selected risk gate, and the
`verifiable-reward-check` skill. Report missing staging, device, or owner proof
as `MANUAL_REQUIRED`; never convert narrative text into release evidence.
