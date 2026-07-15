# Release Evidence Contract

Status: canonical
Owner: Felipe
Last verified: 2026-07-15

Promotion accepts one signed `nexus.release-manifest.v2` envelope for one exact
runtime artifact. Textual release claims and docs-only commits are not evidence.

The payload binds the full runtime SHA, separate docs head, package and
toolchain versions, artifact and file digests, migration identity, Training
catalog identity and activation, test-policy digest and results, CI run and
attempt, staging digest and smoke, expiry, and optional iOS contract identity.

The envelope is signed with Ed25519. Validation rejects missing or invalid
signatures, expiry, runtime drift, artifact drift, test-policy drift, failed
release tests, and absent or mismatched staging proof. Older evidence remains
readable for audit but cannot be reused for promotion.

## Commands and Storage

```bash
npm run release:prepare -- --base <sha>
gh workflow run release-candidate-evidence.yml --ref <candidate-ref>
scripts/request-release-manifest-signature.sh <sha> <rc-run-id>
npm run release:status -- --manifest .local/release/manifests/<sha>.json
npm run release:staging -- --manifest .local/release/manifests/<sha>.json
NEXUS_RELEASE_OWNER_AUTHORIZED=1 npm run release:promote -- --manifest .local/release/manifests/<sha>.json
```

Bundles, manifests, test results, smoke results, reward output, and rollback
evidence stay under `.local/release/` and are uploaded as restricted CI
artifacts. Only the public verification key, current release state, and durable
policy are tracked.

`release:prepare` creates the governed bundle and an unsigned payload. The RC
workflow has no private-key access. A separate workflow dispatched on protected
`main`, approved through the `release-signing` environment, independently
checks the exact RC run, jobs, head SHA, artifact identity, test outputs, and
bundle bytes before signing with protected-main code. The same boundary signs
staging attestations; candidate code is never executed with the key.

A policy-selected RC is valid only when protected-main tooling also fetches and
validates the referenced successful nightly run and immutable evidence
artifact. The nightly must be an ancestor, no more than 36 hours old, use the
same test-policy digest, and prove that every Vitest file at its SHA ran. The
signer statically recomputes changed dependencies from inert candidate files
and verifies the exact `changed ∪ critical ∪ cannot-skip` result. Missing or
stale nightly evidence, test-infrastructure changes, or unresolved impact force
the four-shard full suite. Removing or renaming a test also forces the current
remaining full suite and binds the removed paths into signed selection evidence;
no raw test-count floor can substitute for this identity proof.

`release:staging` installs the signed bundle in a versioned directory while the
current process remains online, then atomically selects it and records smoke
against the exact digest.
`release:promote` requires a matching staging proof and explicit owner
authorization. Two staging rehearsals and two owner-authorized production
releases proved this contract on 2026-07-15. Legacy deployment wrappers remain
available only as a separately invoked fallback while their workflow, test, and
runbook dependents are migrated; they are not yet retired.

Changed or irreversible migrations still require owner approval and backup
proof. A release manifest does not make an unsafe down-migration safe.
