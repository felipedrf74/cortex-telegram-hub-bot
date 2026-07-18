# Release Runbook

Status: canonical
Owner: Felipe
Last verified: 2026-07-17

Current runtime truth is `release-state.json`. Release evidence is an ignored
artifact, not a Markdown narrative.

State-coupled and forward-only database changes additionally follow
`migration-irreversible.md`; it defines snapshot rollback and rehearsal gates but
does not assert that any listed migration is deployed. Its machine-enforced
registry is `config/irreversible-migrations.json`; changing either the registry
or its enforcement module requires the same explicit migration approval and
backup evidence as a governed cutover. Registry v2 pins the exact reviewed SQL
bytes by SHA-256; a missing path or digest mismatch is a blocking registry
identity error, and the migration 248 syntax exemption applies only to its
registered digest.

Ordinary PR and CI migration checks run in non-authorizing scan mode: they
validate sequence, cumulative apply, governed SQL identity, and the exact
review subject without consuming or implying owner approval. Irreversible
review approval is supplied later as an ignored, digest-bound artifact, not as
source text or a claimed future backup, and is consumed only by release
preparation and promotion. Exact backup evidence is generated later by the
canonical promotion path after writes are drained; promotion revalidates the
approval and backup records before the candidate can mutate production.

## Canonical Content workspace rollout controls

Production defaults to `CONTENT_WORKSPACE_V1_MODE=read_only`. `write` mode is
still ineligible until either `CONTENT_WORKSPACE_V1_GLOBAL_WRITE=true` or the
authenticated owner/tenant appears in the corresponding positive-integer
allowlist. Per-slice `*_WRITES` controls default true but can only narrow an
eligible write cohort; they cannot enable one. Invalid modes and boolean values
fail closed. `recovery_only` enables only the separately controlled Trash
restore slice. Keep reads and exports available during an emergency pause, and
record every operator change in governed release evidence without copying the
allowlists into logs or Markdown.

When an exact production candidate introduces migrations 239–253, promotion
automatically requires the stricter scoped-owner rollout preflight while the
predecessor is still online. That check opens the production database read-only,
resolves the canonical persisted owner, rejects global write, and proves every
write slice is explicitly enabled for that owner without emitting identifiers
or environment values. Later emergency deployments remain free to use the
documented read-only kill switch because this requirement is tied to the first
canonical migration cutover, not every future release.

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
6. Obtain explicit owner authorization bound to the migration gate's exact
   review-subject digest; do not claim backup evidence at review time.
7. Run strict owner bootstrap while production is live; rehearse the exact
   candidate migrations and all Content readiness assertions against a private
   same-host SQLite online-backup clone; validate its fresh aggregate-only
   write-once evidence; for the first Content workspace cutover, require exactly
   one active persisted owner in a non-global, all-slices write cohort; copy and
   hash the immutable runtime backup; briefly drain writes,
   checkpoint SQLite, append and verify the database snapshot; rerun migration
   and Content readiness against the quiescent source and prove its digest
   equals the archived database; bind both rehearsals into the machine-readable
   exact-backup record; switch PM2
   atomically; and require the extended readiness evidence before declaring
   recovery complete.
8. Restore the exact previous release automatically if readiness fails.

Do not rebuild, rsync the repository, or install dependencies while production
is stopped. Promotion copies the already prepared staging release and verifies
every governed artifact byte. Repository-sync deployment wrappers were retired
after two staging rehearsals and two owner-authorized production releases.
Emergency `rollback.sh` and `restore.sh` paths remain available.

Backend and iOS are independently promotable unless a shared contract or native
integration changed. Build 57 is available to both TestFlight groups; its
physical-device smoke remains open, and builds 54 through 56 remain active.
