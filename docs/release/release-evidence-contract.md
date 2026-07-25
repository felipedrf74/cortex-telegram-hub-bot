# Release Evidence Contract

Status: canonical
Owner: Felipe
Last verified: 2026-07-23

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

Rollback-drill freshness evidence uses the same protected operational signing
boundary as the staging attestation, not a third signing workflow. A completed
isolated dry-run produces a non-secret `nexus.rollback-drill-payload.v1`
request with an exact allowlisted schema, bounded scalar values, the restored
backup SHA-256, and the retained machine-evidence bundle SHA-256. Unknown
fields and free-form logs are rejected. `scripts/request-rollback-drill-signature.sh` binds its exact byte
digest and target SHA, dispatches the protected-main
`sign-staging-attestation.yml` rollback operation, and installs the validated
`nexus.rollback-drill.v1` envelope at the ignored
`.local/release/rollback-drill-latest.json` path. The target commit must be
reachable from protected `main`; the envelope uses the current release-evidence
Ed25519 key and is valid for release gating for at most 30 days. Protected
signing approves the exact reviewed payload but does not replace the underlying
isolated restore, integrity, health, and retained machine evidence.

First-drill staging uses the ordinary recovery schemas with deliberately
separate cryptographic authority. Protected evidence kind
`rollback_drill_staging` downloads and fully validates the exact original
production-signed manifest artifact, then emits:

1. `nexus.release-manifest.v2`, preserving the exact validated manifest payload;
2. `nexus.staging-attestation.v1`, preserving the validated request except for
   its required rebind to the drill-manifest raw digest and protected signing
   provenance; and
3. signed `nexus.rollback-drill-staging-bundle.v1`, which binds all source and
   output raw digests, fixed `isolated-kvm-first-drill` scope, and
   `promotionAllowed: false`.

The two inner envelopes keep the hardcoded ordinary key id
`github-environment-release-signing-2026-07`, because the recovery runtime
requires it, but they are signed exclusively with
`NEXUS_ROLLBACK_DRILL_STAGING_PRIVATE_KEY_PEM`. The distinct public half is a
reviewed non-secret file at
`docs/release/evidence/rollback-drill-staging-public-key.pem`; it is not a
GitHub secret. The workflow fails closed while that tracked path or the private
secret is absent and never exposes the production release private key.

KVM inputs embed only the two ordinary inner envelopes and bind the drill
public key. Production binds the production public key, so both inner
signatures fail there despite sharing schema and key id. The root promotion
bridge runs the production-key recovery verifier before its first
application-runtime mode/ownership mutation. The bridge update must be
installed before any drill; current-source request validation alone is not
sufficient. The outer record is never promotion evidence, and a completed
three-outcome KVM drill must still produce the existing signed
`nexus.rollback-drill.v1` freshness evidence.

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

Exact-SHA protected-main reuse is valid only with a current
`nexus.protected-main-reuse-activation.v1` envelope signed by the existing
GitHub `release-signing` key. That envelope must descend from a
ServerDominguez-root-signed request for exactly the latest five consecutive
successful production promotions. Each entry binds the eligible comparison to
its signed manifest, signed staging attestation, root-owned promotion
journal/result, protected-main CI run, RC run, runtime SHA, and artifact
identity. The protected signer independently refetches the GitHub identities.
The server request expires after 15 minutes. The resulting envelope is
policy-digest-bound, expires after 180 days, cannot authorize one of its own
five shadow SHAs, and never substitutes for current lockfile,
toolchain, selected-file, job, bundle, Python, staging, or promotion evidence.
If any check is unavailable or ambiguous, the ordinary RC Vitest path runs.
Operator-authored ledgers and locally signed evidence are never reusable.

When exact protected-main evidence exists, a newly signed manifest is
accompanied by a separate `nexus.release-protected-timing.v1` envelope. Its
`nexus.release-protected-timing-payload.v1` payload is signed with the existing
GitHub `release-signing` key and binds the exact manifest SHA-256, repository,
runtime SHA, and three sequential stages:

- protected-main CI: workflow, run ID, run attempt, GitHub start and completion,
  and the completion sealed by protected-main evidence;
- release candidate: workflow, run ID, run attempt, GitHub start and completion,
  and the completion sealed by `nexus.release-test-results.v3`;
- protected manifest signing: workflow, run ID, run attempt, protected job
  start, and the protected signing instant.

The signer reads GitHub run/job metadata through its existing read-only
permission. The requester downloads `timing/<runtime-sha>.json` from the same
immutable artifact as the manifest, installs it mode 0600, and rejects any
non-identical existing file. Missing protected-main evidence omits this
advisory timing envelope but does not change manifest signing or release
acceptance.

The automated-readiness KPI is the exact interval from protected-main CI
`startedAt` through release-candidate `completedAt`; it excludes signing and
staging. CI, RC, signing, staging, and promotion stage durations remain separate
evidence and metrics.

Ten-release v2 timing also requires the original root-owned
`staging/<request-id>.evidence.json` and
`requests/<transaction-id>.json` files. Root staging `startedAt` and
`publishedAt` delimit root installation/readiness. The request's `verifiedAt`
is a local chronology claim created only after the exact candidate's
authenticated/domain smoke succeeds and is sealed together with the smoke-log
digest, but it is not the authoritative timing endpoint. The protected
staging-signing workflow reads its exact current GitHub run through the existing
`actions:read` permission, verifies the run ID/attempt, workflow path,
`workflow_dispatch` event, protected-main dispatch SHA and repository, exact
request-digest title, and checked-out tooling SHA, then binds GitHub's
independently sourced raw `created_at` as `protectedSigning.requestedAt`.
That value remains the authoritative staging-validation end and protected
signing approval-wait start. The chronology requires
`publishedAt <= verifiedAt <= signedAt`, `requestedAt <= signedAt`, and
`requestedAt >= verifiedAt - 5 seconds`. The raw request time may precede local
`verifiedAt` by at most five seconds and is never rewritten.

In authoritative observation v2 and activation evidence, transaction identity
is the uniqueness key. A package `releaseId` or version may recur only with
distinct root transaction IDs and distinct transaction-bound evidence. Legacy
observation v1 lacks that authority and conservatively rejects duplicate
`releaseId` values.

The root promotion request binds explicit production-owner authorization and
its canonical payload digest must equal `journal.requestSha256`. These sources
produce six disjoint handoffs. The two protected signing waits and the
production-owner wait are explicit approvals; protected-main-to-RC,
signing-to-staging, and promotion submission are unattended. For each
authoritative release, sum those unattended waits, then calculate p50/p95 over
exactly ten per-release sums; never pool the individual transitions. No metric
endpoint is copied from an operator observation or inferred from an adjacent
completion. Older valid staging attestations without `requestedAt` remain
readable and do not invalidate a release, but staging duration and affected
handoffs stay `MANUAL_REQUIRED`; CI-to-RC readiness remains evaluable when its
signed protected timing exists.

Ten-release quality evaluation uses a separate
`nexus.release-quality-evidence.v1` envelope signed by that same protected
release-evidence key. Its `nexus.release-quality-evidence-payload.v1` payload
fixes the provider to Sentry and the query contract to
`escaped-release-defects-by-release-v1`; binds exactly the preceding ten and
current ten root promotion transaction IDs, journal digests, runtime SHAs, and
completion timestamps; and records only integer escaped-defect totals plus
SHA-256 commitments for each redacted issue set. A protected source-snapshot
digest binds the query result without retaining raw issue IDs, titles, user
data, or event payloads. The root-side observation collector verifies this
envelope and derives failed-promotion counts directly from those same journal
windows. If the protected Sentry query/signing path is unavailable, the metric
remains `MANUAL_REQUIRED`; an operator counter or locally signed replacement
cannot satisfy it.

The producer begins with
`nexus.serverdominguez-release-quality-request.v1`, signed by the existing
ServerDominguez provenance key from exactly the latest 20 terminal root
journals. It requires a 24-hour-mature current window and expires after 15
minutes. A completed release's half-open exposure interval starts at its
journal completion and ends at the next completed release; non-production
outcomes bind an empty interval and zero/empty-set commitment. The Mac requester
holds the existing release/Sonar mutex for the entire protected operation.
`sign-staging-attestation.yml` validates that server request, refuses active
release workflows before and after collection, and resolves every successful
runtime SHA sequentially through Sentry's exact organization release endpoint.
The response must bind that exact version and every configured production
project ID before the issue query can run. A 404, malformed or mismatched
release response, or missing project membership fails closed without signing a
zero-defect result. It then queries issues sequentially by exact runtime SHA,
production environment, project allowlist, start, and end, and signs only the
aggregate payload with the existing `release-signing` key. The read-only
`NEXUS_SENTRY_QUALITY_READ_TOKEN` carries only `project:read` and `event:read`;
the token, raw release metadata, and raw issue responses never enter workflow
inputs or artifacts. This operation remains owner-dispatched, advisory, and
outside all merge and release gates.

`release:staging` installs the signed bundle in a versioned directory while the
current process remains online, verifies env parity and owner bootstrap, then
atomically selects it and records native/database, authenticated Content
Engine, stable PM2 identity, and smoke evidence against the exact digest.
`release:promote` requires a matching staging proof and explicit owner
authorization. State-coupled migrations additionally require a fresh,
aggregate-only `nexus.production-shape-migration-rehearsal.v2` proof created
from a same-host SQLite online backup while the predecessor stays online. After
the exact stopped-state archive exists, promotion reruns the same proof against
the quiescent source and requires its source digest to equal the archived
database digest. The later `nexus.exact-migration-backup-evidence.v2` record
binds both rehearsals before candidate mutation; all three local records are
private, promotion-run-bound, and fail rather than overwrite an existing path.
Each rehearsal binds the signed retired-migration policy and either the empty
canonical lineage or one exact historical ledger set. It rejects unknown or
partial retired rows while requiring all non-retired rows to remain an exact
candidate prefix; no production ledger mutation is used as a release shortcut.
A candidate introducing the
canonical Content workspace migrations also proves, without logging any
identifier, that exactly one persisted active owner belongs to an explicitly scoped
non-global write cohort with every workspace slice enabled. Strict owner
bootstrap and the same extended readiness checks run while automatic recovery
remains armed.

Before any PM2 or production-data mutation, the root transaction requires an
encrypted, transaction-bound `phase-pre-mutation` candidate recovery runtime
and fresh database point. After candidate availability and the exact 60-second
soak, readiness is checked, then the predecessor rollback archive, a newly
encrypted `phase-post-soak` candidate recovery runtime, and a refreshed
database point are confirmed off-host before readiness is checked again. Both
recovery objects bind the same runtime, artifact, installed-tree,
recovery-runtime, release-manifest, and staging-attestation identities but
require distinct phase keys, ciphertext identities, and exact AWS VersionIds
or the explicit R2 unversioned variance. The private
`nexus.production-promotion-evidence.v1` coordinator proof binds these objects,
both readiness records, and their chronology and is revalidated on resume; it
does not replace the root journal as promotion authority.

The durable promotion journal also binds exact predecessor and candidate
artifact/installed-runtime digests, a root-owned monotonic cutover budget, and
separate cutover-start, actual-unavailability, candidate-available, and
predecessor-recovered timestamps. Successful candidate availability must occur
within 60 seconds; automatic recovery consumes only the remaining portion of
the original 120-second outage-to-healthy budget. Degradation detected after
availability uses a distinct 120-second detection-to-healthy scope while
retaining the original cutover history. A recovery archive is accepted only
after exact path, size, whole-archive digest, safe-entry extraction, SQLite
integrity/foreign-key checks, and stopped-state database digest agreement.
These controls are implemented locally; live SSH-loss, failed-health, and
reboot timing remain `MANUAL_REQUIRED` until their staging drills are retained.
Repository-sync deployment
wrappers were retired after two staging rehearsals and two owner-authorized
production releases proved this contract on 2026-07-15; exact rollback and
restore remain the emergency recovery paths.

Changed or irreversible migrations still require owner approval and backup
proof. A release manifest does not make an unsafe down-migration safe.
