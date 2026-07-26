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

The coordinated exact-artifact flow is canonical:

```bash
npm run release:resume -- --backend-only

# Run only after the persisted owner stop and a fresh explicit decision:
NEXUS_RELEASE_OWNER_AUTHORIZED=1 \
  npm run release:resume -- --owner-authorized --promote
```

Shared backend/iOS releases replace the initial `--backend-only` with
`--includes-ios`, then supply the two signed attestations when the coordinator
requests them. Those proofs are not inferred from candidate intent. After the
RC artifact exists, derive
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

For the control-v2 legacy staging bootstrap, the source request additionally
contains exact `nexus.rollback-drill-legacy-staging-bootstrap.v1` evidence:
root broker and control digests, predecessor/current selector identities, the
fsynced transaction journal digest, the stopped-state SQLite recovery-point
SHA-256 and byte count, the 60-second soak, and the 120-second recovery target.
The root journal retains only the bounded recovery-point schema, digest, size,
original uid/gid/mode, and creation time; staging evidence exposes only digest
and size and never database bytes or a database or backup path. Selector
mutation is forbidden until both allowlisted staging
PM2 apps are stopped, file-handle checks pass, the exact reviewed
application-DR SQLite helper has created and verified the recovery point, and
that identity is fsynced. Recovery verifies the same journal-bound bytes,
removes WAL/SHM sidecars while the apps remain stopped, recreates a missing or
truncated database with its journaled metadata, restores the database and
predecessor selector, and only then starts and proves the root-pinned,
re-attested predecessor. Missing or corrupt recovery bytes fail closed.
Candidate completion also requires the in-lock exact-SHA PM2/service identity
and authenticated readiness record; that root record is the legacy drill
smoke, so no required Mac smoke occurs after terminal completion. The
protected signing request
and outer bundle bind the canonical `drillBootstrap` SHA-256. Unknown fields or any
`promotionAllowed` value other than `false` fail closed.

The two inner envelopes keep the hardcoded ordinary key id
`github-environment-release-signing-2026-07`, because the recovery runtime
requires it, but they are signed exclusively with
`NEXUS_ROLLBACK_DRILL_STAGING_PRIVATE_KEY_PEM`. The distinct public half is a
reviewed non-secret file at
`docs/release/evidence/rollback-drill-staging-public-key.pem`; it is not a
GitHub secret. The workflow fails closed while that tracked path or the private
secret is absent and never exposes the production release private key.

`scripts/release-staging-attestation.mjs` rejects `drillBootstrap` before
ordinary signing or promotion validation. Thus the drill-only source cannot be
normalized merely by substituting a production signature; normalization
remains a separate future owner-authorized contract.

KVM inputs embed only the two ordinary inner envelopes and bind the drill
public key. Production binds the production public key, so both inner
signatures fail there despite sharing schema and key id. The root promotion
bridge runs the production-key recovery verifier before its first
application-runtime mode/ownership mutation. The bridge update must be
installed before any drill; current-source request validation alone is not
sufficient. The outer record is never promotion evidence, and a completed
three-outcome KVM drill must still produce the existing signed
`nexus.rollback-drill.v1` freshness evidence.

The reviewed layout-freshness adapter is the only normalization from that
three-outcome evidence into the unchanged ordinary rollback request. It
accepts the exact owner-signed
`nexus.release-layout-fault-drill-envelope.v1`, the root-pinned trust manifest
and provision receipt, and production-signed release manifests matching the
plan's production and staging SHA/artifact identities. It independently
verifies the owner signature against the installed protected server key,
every nested hypervisor and guest signature, descriptor-pinned root
trust/provision digests, pairwise key separation, the 120-second recovery
bound, and a completion no more than 30 days old. Release-manifest expiry
does not make an old manifest promotable again; the adapter uses that
historical signature only to bind the package version to the already signed
runtime SHA and artifact digest.

Guest execution evidence v2 signs one bounded canonical pre-fault synthetic
target-backup artifact containing the exact `release.json`, `health`, and real
isolated SQLite bytes used by guest recovery. The execution repeats the raw
artifact base64, byte count, and SHA-256. All three scenarios must carry
byte-identical artifacts and must prove exact release and database restoration
from those bytes. The adapter publishes those exact bytes without rewrapping;
their raw SHA-256 becomes `targetBackupSha256`. It separately derives
`nexus.rollback-drill-layout-recovery-set.v1` as cross-bound machine evidence,
whose canonical containing-record SHA-256 becomes `machineEvidenceSha256`.

For this isolated synthetic drill, `targetBackup` names the governed synthetic
target-release and SQLite archive, not a production-data backup.
`backupContainsDatabase: true` is emitted only after all three signed
executions agree on the archive and prove exact before/after recovery. The
adapter publishes the archive first, machine evidence second, and the exact
ordinary `nexus.rollback-drill-payload.v1` request last. All are owner-only,
no-overwrite outputs. Interrupted publication may resume only from an exact
contiguous prefix. The adapter has no caller-key/test-mode bypass, no protected
signing key, and creates no staging or promotion authority; the existing
protected rollback signer must still validate and sign that request.

The deep verifier continues to read legacy guest execution v1 for historical
layout-activation evidence, but the freshness adapter rejects it because it
lacks signed target-backup bytes. Before guest producer v2 or journal v3 is
installed, active v1 transactions must finish or be explicitly retired.
Producer/verifier digests, the runtime bundle, trust/provision evidence, owner
plan, and all three scenario results must be regenerated. A legacy signed
envelope cannot be normalized into freshness evidence.

Release-layout activation has a separate, stricter evidence boundary. Its three
required results must bind a fresh plan nonce to independently signed
hypervisor isolation facts, guest boot identity, exact layout-control
execution, stopped-boundary database restoration, health restoration, and a
trusted monotonic observer. KVM provisioning creates a random dedicated
Ed25519 hypervisor evidence key and three distinct dedicated guest evidence
keys, then publishes their public identities in a root-owned mode-0600 trust
manifest. That manifest independently binds the active provision receipt and
set ID, QEMU/runner digests, fixed scenario-to-guest mapping, and each guest
SSH host-key digest. It also binds the exact root controller, controller unit,
deep verifier, guest executor, and guest boot-recovery unit digests; the
protected plan cannot nominate its own trusted keys or producer code.
The plan uses a random 256-bit challenge. Every isolation and execution record
repeats the challenge, canonical plan digest, and scenario identity; the
canonical plan binds the migration identity, and the guest execution also
repeats it directly. The hypervisor-signed record additionally binds the exact guest
execution digest, guest boot identity, monotonic observer record, and live QEMU
process/command-line observation. Only the fixed root controller may create
scenario results; the public verifier exposes no manual `record` command.
`collect` re-verifies the producer digests, nested evidence, signatures,
ordering, recovery timing, and canonical result digests before emitting
`nexus.release-layout-fault-drill.v1`.

The owner signature is necessary but not sufficient. The root activation
broker verifies the immutable trust manifest and active provision receipt,
then independently verifies the nested machine proof before and after copying
the signed envelopes, revalidates the exact Phase A receipt and root-owned PM2
closure, and journals the authority, machine-proof, PM2, and Phase A receipt
digests. It also records an acceptance instant that must be within the signed
request's creation/expiry window before publishing active authority. The
systemd worker repeats all those checks before `submitted` may transition to
`running`. An accepted transaction may be resumed after wall-clock expiry only
when its immutable journal and bounded acceptance instant revalidate; this is
not a new authorization decision. Invalid signatures, arbitrary plan keys,
reused signer keys, challenge drift, cross-plan results, self-reported unsigned
JSON, and stale or incomplete plans fail before a transaction can mutate the
layout. If the host stops after journal durability but before active-marker
publication, boot recovery revalidates and resumes at most one nonterminal
orphan transaction. Multiple, malformed, permission-unsafe,
identity-inconsistent, or out-of-window orphan journals remain fail-closed.

After terminal activation, ordinary promotion may pass `--allow-expired` only
to the nested machine-proof verifier used alongside the already-expired owner
authority path. This relaxes current wall-clock freshness only; the verifier
still revalidates every plan, nonce, digest, signer identity, raw signature,
scenario, and recovery outcome.

The coordinator binds the governed RC bundle and requests the protected
unsigned/signing transition without invoking legacy `release:prepare`.
`release:prepare` remains a diagnostic/manual fallback and repeats local gate,
build, bundle, and unsigned-payload work, so it must not precede a normal
coordinated release. The RC workflow has no private-key access. A separate
workflow dispatched on protected `main`, approved through the
`release-signing` environment, independently
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

The same exact signer artifact contains
`.local/release/signing-provenance.json`. The requester validates it against
the authenticated completed GitHub run and unique digest-bearing artifact,
then atomically installs a mode-0600 SHA-scoped receipt at
`.local/release/signing-provenance/<runtime-sha>.json`. That receipt binds the
repository, runtime SHA, RC candidate run/attempt, protected manifest-signing
workflow path/run/attempt, manifest and payload digests, release artifact
digest, and downloaded GitHub artifact ID/digest. Drill staging verifies the
receipt against the exact manifest and fresh GitHub run/artifact metadata
before it may request drill-only protected signing. The RC run stored in the
release manifest is never accepted as the protected manifest-signing run.

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

Before expensive preparation or any PM2 mutation, the same journal enters
`waiting_for_dr_lease` after revalidating the durable active marker. Its
additive `drLease` record binds probe count, 120-second same-boot monotonic
deadline, two-second cadence, boot and invocation identity, next/last probe,
acquisition time, and failure class. The broker requires both the existing
hourly backup service to be idle and the root-owned application-DR flock to be
available, rechecks service state while holding the flock, then releases it
before promotion-owned recovery work. The active marker prevents a new timer
backup from starting. A timeout or probe/identity failure becomes
`failed_before_stop`; reboot starts one fresh bounded monotonic segment because
neither the old backup process nor its kernel lock can survive the boot.

Post-soak escrow retry is likewise server-owned inside the existing promotion
oneshot. The additive `escrowRetry` record binds a transaction-wide maximum of
eight consumed attempts, a 1,200-second same-boot monotonic budget, next/last
attempt, error and exhaustion class, boot ID, and systemd invocation identity.
Attempt state is durable before each off-host call, and exact live candidate
identity plus authenticated readiness are reproved before every attempt. Each
off-host call, PM2 identity proof, runtime attestation, and authenticated
readiness proof is capped to the remaining budget. Candidate degradation
restores the predecessor immediately. An exhausted relaunch cannot make a
ninth call and returns 75; the Mac reads the journal but does not run a second
retry controller. This contract requires exact
`nexus-release-promotion-control.v4`; v3 is rejected before staging or
promotion. `phaseTiming` and `invocation` fields add monotonic segment timing,
boot ID, systemd invocation/PID, and resume lineage.

After the local production proof passes, the coordinator checkpoint binds its
mode-0600 path and SHA-256 together with runtime, artifact, installed/recovery
runtime, manifest, staging, package-version, and root transaction identities.
Post-availability release closeout consumes that exact runtime SHA, artifact
digest, transaction ID, and production-proof digest. It checks out the runtime
SHA directly and may reuse an existing tag only when the remote tag peels to
that same commit. GitHub Release and documentation publication remain
resumable closeout evidence; they cannot replace or retroactively change the
terminal production verdict.

Repository-sync deployment
wrappers were retired after two staging rehearsals and two owner-authorized
production releases proved this contract on 2026-07-15; exact rollback and
restore remain the emergency recovery paths.

The one-time `/home/dominguez` to `/srv/nexus-release` layout transaction uses
its own root journal and does not replace ordinary promotion evidence. Before
the stopped predecessor is moved, an online recovery point binds its path,
digest, size, source device/inode, and SQLite integrity evidence. After PM2 is
stopped and a root `/proc` scan proves no descriptor, mapping, executable, cwd,
or root reference remains below the protected predecessor, the transaction
checkpoints WAL and creates a separate mode-0600 stopped-boundary copy through
no-follow descriptors. The journal binds that copy's digest, size, source
device/inode, observation-evidence digest, and copy-evidence digest. Recovery
first checkpoints and re-attests the stopped live database at the same bound
inode, preserving writes accepted after cutover. An unhealthy or
identity-drifted live database falls back to the stopped copy; it may use the
earlier online point only if failure preceded the stopped boundary. Snapshot
restore rejects unsafe sidecars and removes exact regular WAL, shared-memory,
and rollback-journal sidecars before the predecessor starts.

Terminal layout evidence additionally binds the exact protected predecessor
and rematerialized runtime SHA/artifact/installed-tree identities, PM2 dump,
readiness records, same-boot monotonic unavailability, worker-home identity,
and live compatibility mount source/target/options plus mount and target
device/inode. Publication consists of one terminal journal, result, and
attestation whose raw digests cross-bind. Ordinary promotion remains blocked
while the activation, migration, Phase A install, Phase B handover, or recovery
marker exists, and after publication it revalidates all three records and the
live bind mounts.

Phase A activation-install evidence is a root-only exact-source transaction
receipt. Its durable journal snapshots every replaceable file, original
owner/group/mode/bytes, source archive identity, legacy adapter state, and
systemd enablement before control replacement. Legacy retirement additionally
requires the canonical plan emitted from the receipt-valid v2 installer while
both release locks are held. Phase A revalidates its exact schema and byte
digest, active receipt/control, terminal-journal aggregate, fixed 12-target
allowlist, active target identities, and predecessor backups. The plan binds
the shared application-DR SQLite helper separately as a retained dependency;
it is not a retirement target and must remain byte/metadata-identical before
and after installation and rollback. Phase A records completed adapter-asset
retirement in its durable journal before removing the v2 receipt.

The boot recovery executable, unit, PM2 guard, and machine-proof verifier remain as digest-bound
recovery anchors if rollback is needed, and PM2 cannot start until either the
complete Phase A receipt or the recovery-anchor rollback receipt verifies.
Phase A also records the existing PM2 and ingress runtime identity before and
after installation, the exact installed asset digests, root-PM2 prerequisite
result, and legacy-v2 retirement receipt. Phase A evaluates the PM2 closure
with the exact reviewed source control before replacing an older installed
control, then requires the newly installed control to return byte-identical
proof. None of these repository or installation receipts proves live
activation. The environment remains `NOT_ACTIVATED` until all three real KVM
outcomes, explicit owner authorization, and the terminal root transaction
evidence are retained.

Changed or irreversible migrations still require owner approval and backup
proof. A release manifest does not make an unsafe down-migration safe.
