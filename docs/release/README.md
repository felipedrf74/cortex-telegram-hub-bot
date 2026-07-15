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
gh workflow run release-candidate-evidence.yml --ref <candidate-ref>
scripts/request-release-manifest-signature.sh <sha> <rc-run-id>
npm run release:staging -- --manifest .local/release/manifests/<sha>.json
npm run release:promote -- --manifest .local/release/manifests/<sha>.json
```

`release:prepare` runs the release gate, builds one governed runtime bundle,
and writes an unsigned candidate payload. The RC workflow also contains no
signing secret. Only the protected-main signer, gated by the `release-signing`
environment, may turn a successful exact-run artifact into a promotable
`ReleaseManifestV2`. A changed artifact or test policy invalidates the result.
A docs-only commit cannot replace the required check for a runtime SHA.

The default RC lane runs the exact union of changed, critical, and cannot-skip
tests only when a successful full nightly from the preceding 36 hours is an
ancestor of the candidate, used the same test policy, and proves the complete
Vitest file set. Protected-main tooling fetches that exact nightly run and
artifact and independently recomputes the candidate's static dependency map.
Missing, stale, mismatched, or forged evidence; test-infrastructure changes;
removed or renamed test files; and unresolved production-code impact all fail
closed to the four-shard full suite. Python remains a full release-artifact
gate.

## Required Sequence

1. Start from a clean reviewed runtime SHA.
2. Resolve the governed conditional tier, then run its exact Vitest selection,
   full Python suite, build, migration rehearsal, artifact validation, and
   reward verification.
3. Run the unprivileged RC workflow, then have protected-main tooling verify
   its exact run, head SHA, jobs, test outputs, bundle bytes, and artifact
   identity before signing. Candidate scripts are data only in the signing
   job and never receive the private key.
4. Under the staging release lock, verify environment mode/owner/key parity,
   install the bundle in a versioned directory while the current service stays
   online, and refuse to rewrite an already-active release.
5. Switch staging only after advisory owner bootstrap succeeds or warns, then
   record native SQLite, database integrity, authenticated Content Engine,
   stable PM2 identity, and domain-smoke evidence against the exact digest.
6. Obtain explicit owner authorization.
7. Run strict owner bootstrap while production is live; copy and hash the
   immutable runtime backup, briefly drain writes, checkpoint SQLite, append
   and verify the database snapshot, switch PM2 atomically, and require the
   extended readiness evidence before declaring recovery complete.
8. Restore the exact previous release automatically if readiness fails.

Do not rebuild, rsync the repository, or install dependencies while production
is stopped. Promotion copies the already prepared staging release and verifies
every governed artifact byte. Repository-sync deployment wrappers were retired
after two staging rehearsals and two owner-authorized production releases.
Emergency `rollback.sh` and `restore.sh` paths remain available.

Backend and iOS are independently promotable unless a shared contract or native
integration changed. Build 56 must pass availability and physical-device smoke
before builds 54 or 55 are expired.
