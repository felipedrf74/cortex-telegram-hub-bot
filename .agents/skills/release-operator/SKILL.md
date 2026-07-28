---
name: release-operator
description: Prepare, inspect, stage, promote, or recover an exact Nexus Hub backend release. Use for release manifests, immutable bundles, staging parity, PM2 cutover, rollback, production status, or backend and iOS contract-bound promotion. Production mutation always requires explicit owner authorization.
---

# Nexus Release Operator

Start with `git status --short --branch` and
`docs/release/release-state.json`. Operate from a clean checkout whose HEAD is
the exact current protected `origin/main` SHA.

The only supported commands are:

```bash
npm run release:status
npm run release:prepare
npm run release:prepare -- --checkpoint-run <run-id>
NEXUS_RELEASE_OWNER_AUTHORIZED=1 \
  npm run release:promote -- --confirm <full-sha>:<artifact-sha256>
```

The explicit GitHub release checkpoint reuses the protected-main artifact. It
combines the already-passing selected tests with only the untested deterministic
remainder across four shards, runs Python and migration work only when
applicable, and publishes `nexus.release-checksum-manifest.v1`. The manifest is
unsigned: trust comes from exact workflow/SHA binding, authenticated GitHub
artifact download, SHA-256 verification, branch protection, and explicit owner
approval. It also records the sorted test groups from the cumulative deployed
SHA to target SHA diff. Promotion requires an exact-SHA passing local
`local_engine` chat evaluation only when those cumulative groups include
`chat-secretary`; unrelated releases skip it automatically, with no bypass.

`release:prepare` verifies the manifest and original artifact locally, stores
the manifest SHA-256, uploads the bundle once, and submits the staging phase
through `systemd-run --user`.
It stops after staging with `ownerApprovalRequired: true`. `release:promote`
requires the exact SHA and digest confirmation and submits a separate
user-owned production transaction. Losing the Mac or SSH session does not stop
either active server phase.

Never accept an operator-supplied manifest. Before promotion, revalidate the
exact checkpoint run and re-download its exact named manifest artifact. Cached
and re-downloaded bytes and SHA-256 must agree. Run the conditional exact-SHA
chat preflight before the first production SSH, including resume-state queries,
and repeat it independently in the new-transaction helper. The observed
production predecessor SHA must equal the manifest's canonical protected
release-state SHA before mutation.

- Treat the full source SHA plus artifact SHA-256 as the promotion identity.
- Never rebuild, install dependencies, run tests, or run Sonar on the server.
- Keep local evidence under ignored `.local/release/`; remote state lives under
  `/home/dominguez/.local/state/nexus-release/`.
- Use the existing production and staging layouts under
  `/home/dominguez/telegram-hub-bot{,-staging}`.
- Preserve the pre-promotion SQLite backup, atomic `current` switch, PM2
  `startOrReload`, 60-second production soak, and automatic exact-predecessor
  rollback.
- Do not run Sonar concurrently with staging or production; both use the same
  user-owned remote mutex.
- Do not restore signing workflows, `ReleaseManifestV2`, root promotion
  controls, KVM drills, AWS release dependencies, or duplicate state stores.
- Do not deploy, push, expire TestFlight builds, or delete remote branches
  without explicit authorization.
- If a backend/iOS contract changes, prove compatibility through the canonical
  iOS release process before owner approval. Do not mislabel a shared contract
  release to bypass that proof.

Before handoff, run `npm run docs:audit`, the selected risk gate, and the
`verifiable-reward-check` skill. Report missing staging, device, or owner proof
as `MANUAL_REQUIRED`; never convert narrative text into release evidence.
