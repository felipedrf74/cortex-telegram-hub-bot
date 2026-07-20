# Release Evidence Contract

Status: canonical
Owner: Felipe
Last verified: 2026-07-19

Promotion accepts one signed `nexus.release-manifest.v2` envelope for one exact
runtime artifact. Textual release claims and docs-only commits are not evidence.

The payload binds the full runtime SHA, separate docs head, package and
toolchain versions, artifact and file digests, migration identity, Training
catalog identity and activation, test-policy digest and results, CI run and
attempt, staging digest and smoke, expiry, and an explicit contract scope:
`ios: null` for backend-only or a typed iOS SHA/build/passed-test plus exact
candidate-fixture, contract-subject, and independently signed App Store
distribution binding for a shared release.

The envelope is signed with Ed25519. Validation rejects missing or invalid
signatures, expiry, runtime drift, artifact drift, test-policy drift, failed
release tests, and absent or mismatched staging proof. Older evidence remains
readable for audit but cannot be reused for promotion.

## Commands and Storage

```bash
npm run release:prepare -- --base <sha> --backend-only
gh workflow run release-candidate-evidence.yml --ref <candidate-ref> -f contract_scope=backend_only
scripts/request-release-manifest-signature.sh <sha> <rc-run-id> --backend-only
npm run release:status -- --manifest .local/release/manifests/<sha>.json
npm run release:staging -- --manifest .local/release/manifests/<sha>.json
NEXUS_RELEASE_OWNER_AUTHORIZED=1 npm run release:promote -- --manifest .local/release/manifests/<sha>.json
```

Shared backend/iOS releases replace `--backend-only` with
`--includes-ios --ios-sha <ios-sha> --ios-build-number <build> --ios-contract-result passed`
when preparing and dispatching the RC. These fields express candidate intent;
they are not accepted as signing proof. After the RC artifact exists, derive
its exact iOS evidence request with protected-main tooling:

```bash
node scripts/trusted-release-signer.mjs ios-contract-request \
  --candidate-artifact <downloaded-rc-artifact-root> \
  --runtime-sha <backend-sha>
```

Dispatch `.github/workflows/ios-contract-evidence.yml` on protected iOS `main`
with the emitted backend runtime SHA, artifact digest, fixture digest, and
fixture base64. The workflow validates and materializes those exact canonical
bytes, runs the governed selectors—including a decoder that loads that file
through the production Swift models—and signs only when total equals passed
with zero failed or skipped tests. Download its signed compatibility
attestation.

Compatibility is necessary but is not archive equivalence. For the same iOS
SHA/source build, run the protected `App Store Release` Xcode Cloud workflow. Its
post-archive hook validates the exact clean source, archive and exported
App Store artifact digests, app executable and Info.plist, bundle/team/version,
the preserved archive's verified ad-hoc signature, the exported app's governed
Apple Distribution signature and entitlements, selected stable toolchain/SDK,
and Xcode Cloud workflow/build identity. The archive retains the governed source
build while the exported app must use Xcode Cloud's assigned build number. It
signs that payload with a dedicated
Xcode Cloud secret and emits
`NEXUS_IOS_DISTRIBUTION_EVIDENCE_BASE64URL=<canonical-envelope>`; decode the
marker to `ios-distribution-attestation.json`. Then request backend signing with
both JSON envelopes:

```bash
scripts/request-release-manifest-signature.sh <backend-sha> <rc-run-id> \
  --includes-ios \
  --ios-attestation <ios-contract-attestation.json> \
  --ios-distribution-attestation <ios-distribution-attestation.json>
```

The protected backend signer treats both supplied attestations as untrusted
data, verifies their Ed25519 signatures against distinct pinned iOS public
keys, then requires the compatibility proof's repository/workflow/run/source
SHA/source build, backend SHA, immutable
artifact digest, candidate fixture digest, contract subject, exact selector
set/digest, all-passed counts, and lifetime to match. It also requires the
distribution proof's protected-main source, source/distributed build identities, archive,
exported artifact, signing, toolchain, and Xcode Cloud identity to be valid and
requires both proofs to agree on SHA/source build. It independently reads the same
fixture from the verified RC bundle, copies both attestations into the signed
output, and records their digests in signing provenance. Direct
owner-entered iOS SHA/build/result fields and legacy iOS run metadata inputs are
rejected by the trusted signer. `backend_only` rejects all iOS evidence.

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
It also reconstructs the contract binding from the exact bundle fixture and
signed compatibility attestation; it does not trust the candidate payload or
signing inputs to declare their own iOS identity. The unsigned candidate keeps
`ios.distribution` null and cannot promote. Protected-main tooling enriches the
final signed manifest only after the separate distribution attestation passes.
Neither path needs a cross-repository PAT: the two pinned iOS signing keys are
the trust anchors, and the backend protected environment accepts only the two
compact signed envelopes.

The separate `nexus.content-ios-extraction.v1` artifact remains the behavioral
Content quality proof: it binds the clean iOS source tree and five fixed UI
journeys to one `.xcresult` digest and its attachments. Its declared scope is
`behavioral_not_archive_equivalence`; it does not substitute for the signed
cross-repository compatibility attestation or prove App Store archive identity.

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
current process remains online, verifies env parity and owner bootstrap, then
atomically selects it and records native/database, authenticated Content
Engine, stable PM2 identity, and smoke evidence against the exact digest.
`release:promote` requires a matching staging proof and explicit owner
authorization. State-coupled migrations additionally require a fresh,
aggregate-only `nexus.production-shape-migration-rehearsal.v1` proof created
from a same-host SQLite online backup while the predecessor stays online. After
the exact stopped-state archive exists, promotion reruns the same proof against
the quiescent source and requires its source digest to equal the archived
database digest. The later `nexus.exact-migration-backup-evidence.v2` record
binds both rehearsals before candidate mutation; all three local records are
private, promotion-run-bound, and fail rather than overwrite an existing path.
A candidate introducing the
canonical Content workspace migrations also proves, without logging any
identifier, that exactly one persisted active owner belongs to an explicitly scoped
non-global write cohort with every workspace slice enabled. Strict owner
bootstrap and the same extended readiness checks run while automatic recovery
remains armed.
Repository-sync deployment
wrappers were retired after two staging rehearsals and two owner-authorized
production releases proved this contract on 2026-07-15; exact rollback and
restore remain the emergency recovery paths.

Changed or irreversible migrations still require owner approval and backup
proof. A release manifest does not make an unsafe down-migration safe.
