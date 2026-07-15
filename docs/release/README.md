# Release Runbook

Status: canonical
Owner: Felipe
Last verified: 2026-07-15

Current runtime truth is `release-state.json`. Release evidence is an ignored
artifact, not a Markdown narrative.

## Commands

```bash
npm run release:status
npm run release:prepare -- --base <sha>
npm run release:staging -- --manifest .local/release/manifests/<sha>.json
npm run release:promote -- --manifest .local/release/manifests/<sha>.json
```

`release:prepare` runs the release gate, builds one governed runtime bundle,
and writes `ReleaseManifestV2`. A changed artifact or test policy invalidates
the result. A docs-only commit cannot replace the required check for a runtime
SHA.

## Required Sequence

1. Start from a clean reviewed runtime SHA.
2. Run changed plus critical tests, build, migration rehearsal, artifact
   validation, and reward verification.
3. Sign the manifest and upload the immutable bundle plus evidence as CI
   artifacts.
4. Install and verify the bundle in a versioned staging directory while the
   current service remains online.
5. Record staging smoke against the exact artifact digest.
6. Obtain explicit owner authorization.
7. Copy and hash the immutable runtime backup while production is live; then
   briefly drain writes, checkpoint SQLite, append and verify the database
   snapshot, switch PM2 atomically, and run both process readiness checks.
8. Restore the exact previous release automatically if readiness fails.

Do not rebuild, rsync the repository, or install dependencies while production
is stopped. Promotion copies the already prepared staging release and verifies
every governed artifact byte; it never invokes the legacy deploy wrapper. Keep
that wrapper only as a separately invoked fallback until two staging rehearsals
and two owner-authorized production releases prove the replacement path.

Backend and iOS are independently promotable unless a shared contract or native
integration changed. Build 55 must pass physical-device smoke before build 54
is expired.
