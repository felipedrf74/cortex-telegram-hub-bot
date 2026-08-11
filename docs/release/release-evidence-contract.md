# Release evidence contracts

Two generations of release evidence exist in this repository.

- **Continuous deployment** (default) produces a signed release manifest, a
  migration verdict, VPS release state, immutable receipts, and governed Compose
  configuration. The one-time PM2-to-container transition additionally produces
  a bootstrap baseline. Those contracts are specified immediately below.
- **The PM2 fallback** produces the unsigned checksum manifest described from
  "Release checksum evidence contract" onwards. It is retained only for the
  cutover window; see `docs/release/README.md`.

The host control policy is `nexus.continuous-deployment-policy.v1`, implemented
at exact version `2026-08-09.2`. Its top-level and nested objects are exact-key
contracts. `paths` is the sole additive map, and every required or future entry
must be a normalized absolute path; unknown fields elsewhere and future policy
versions fail closed until the poller explicitly implements them.

The policy binds four distinct root-owned application environment paths:
backend/migrator and minimal content-engine files for production and staging.
Their values are intentionally outside signed evidence, but a descriptor-safe
admission gate binds each pair's digests for one release attempt, rejects
topology or signed-identity overrides, limits the content engine to its declared
credential allowlist, forbids Node/dynamic-loader/trust controls, and requires
the same non-empty `INTERNAL_API_SECRET` in both files. Compose `format: raw`
(minimum Compose 2.30.0) makes the admitted
value substring the container value instead of interpolating from the poller;
quote-wrapped and inline-comment legacy dotenv forms are refused. No secret
value or environment-file digest is emitted in receipts.

## `nexus.release-manifest.v3`

The only artifact the deployment host trusts. An Ed25519 envelope over a
canonical-JSON payload; the signature is verified against a root-owned pinned
public key before any field is read as meaningful.

Envelope: `schema`, `keyId`, `signatureAlgorithm` (`ed25519`), `payload`,
`signature` (base64, 64 bytes). Exact-keys — an unexpected field is treated as
tampering, not as a forward-compatible extension.

| Payload field | Contract |
| --- | --- |
| `schema` / `schemaVersion` | `nexus.release-manifest-payload.v3` / `3` |
| `createdAt` | Canonical UTC timestamp; rejected if future-dated beyond 5 minutes of skew or older than `trust.maxManifestAgeSeconds` |
| `source.repository` | Must equal the governed repository |
| `source.ref` | Must equal the protected ref |
| `source.workflow` | Must equal the governed release workflow name |
| `source.sha` | Full lowercase git SHA of the published commit |
| `source.runId` / `source.runAttempt` | Positive integer strings |
| `images.backend` / `images.contentEngine` | `{repository, digest}`; repository must equal the governed image, digest must be `sha256:<64 hex>`, and the two digests must differ |
| `compose.path` / `compose.digest` | Governed Compose filename and the SHA-256 of its exact bytes |
| `controlPlane.schema` / `controlPlane.digest` | `nexus.release-control-plane.v1` and the canonical SHA-256 of the governed controller runtime fingerprint |
| `migrations.digest` | SHA-256 over the canonical eligibility summary, complete ordered migration inventory, and complete reconciliation projection |
| `migrations.upFileCount` / `downFileCount` | Non-negative integers |
| `migrations.cdEligibility` | `{eligible, predecessorCompatible, reasons}` — booleans and a bounded string list |
| `migrations.inventory` | Non-empty, strictly filename-ordered exact-key rows `{file, sha256, kind, predecessorCompatible}`; filenames are slash-free `NNN_*.sql` values with no `..`, every up migration is represented, byte digests are lowercase SHA-256, and compatibility must agree with the classified kind |
| `migrations.reconciliation` | `nexus.release-migration-reconciliation.v2`: source-policy digest (including v4 archive modes/locators); exact production/staging lineage ids and legacy rows; retired SHA-256/source-commit metadata/replacement relationship for each row; exact digest-bound compatibility exemption with ordered old/replacement unique-index transition descriptors; and exact semantic-schema exclusions |

The release identity is `sha256` over `{sha, backend, contentEngine, compose,
migrations, controlPlane}`, truncated to 32 hex characters. It is derived only
from signed, immutable deployable content. Publication metadata is deliberately not an input:
the receipt preserves the exact accepted `runId`, `runAttempt`, full-manifest
digest, and OCI release-payload digest, while a later CI run publishing the same
deployable identity is refused as already settled and cannot overwrite that
first authorizing receipt. A changed source, image pair, Compose digest,
migration digest, or control-plane digest is a different release.

`ops/nexus-release/release-control-plane-inputs.json` defines the controller compatibility
surface. Its fingerprint discovers the complete local-import closure of the
governed controller entrypoints and combines exact file bytes/executable bits
with the continuous-deployment policy, systemd/sudoers/backup-interface inputs,
the exact Node runtime version, and only the production package-lock closure
actually imported by that runtime (`better-sqlite3` and its transitives).
Application code and unrelated package-lock rows are deliberately absent, so an
app-only commit can retain the same controller digest and deploy without an
attended control-plane upgrade. Fingerprinting also requires the executing Node
runtime to equal the descriptor's exact version; a signer or installed poller
running different Node bytes fails instead of merely hashing the claimed value.

The signer computes that identity from its exact hosted checkout. The installed
poller independently computes it from `/opt/nexus-release/checkout` and compares
it with the signed field after signature verification but before Compose
validation, runtime-plan creation, state writes, application-image operations,
or cache pruning. A mismatch returns `deferred`; the immutable payload pull and
extraction required to discover and verify the signed manifest are the only
preceding local materialization. The attended immutable-checkout upgrade makes
the digests equal before the timer can admit that release.

Checkout identity alone does not grant the root backup producer authority. For
every ordinary candidate, the controller also descriptor-reads and byte-compares
the governed producer, five backup/restore units and timers, and sudoers policy
against their installed copies; it requires exact root ownership, modes, and
single-link regular files, validates installed sudoers, and requires each unit's
effective `LoadState`, `FragmentPath`, empty `DropInPaths`, and
`NeedDaemonReload=no`. This read-only proof runs before candidate discovery and
again immediately before the backup unit can start. A mismatch therefore cannot
reach staging on its first observation or cross from an already-staged retry
into backup/production. Receiptless crash recovery deliberately precedes the
gate because it never starts the installed producer and must not be stranded by
unrelated unit drift.

Version 2 envelopes have no controller identity. A v2 controller rejects the v3
envelope and its extra signed field fail-closed. A v3 controller never admits a
v2 manifest as a new candidate; it accepts v2 only when re-verifying an already
recorded predecessor or interrupted legacy release so the first v3 deployment
does not strand the established rollback target. That is a runtime
manifest/receipt recovery contract, not an attended control-plane selector
rollback contract: a retained v2 controller tree is not required to contain or
execute v3 checker entrypoints. Selector rollback uses the version-compatible
transaction proof from the attended installer before returning authority to the
older immutable tree.

The signed envelope version is selected by the closed
`nexus.release-manifest-schema-policy.v1` file. Its generation rows and retained
and candidate reader sets are append-only. Exact Git base/head verification in
CI, the hosted builder, and the fresh signer permits a writer change only to a
generation already candidate-readable in the exact base policy. The writer flip
is a dedicated policy-only change (plus the generated project map), so reader
support must have shipped on protected `main` one release earlier. Fresh
candidates use `candidateReaders`; only an exact content-addressed payload
already persisted in eligible/staging state may use `retainedReaders` to resume.

Publication separates immutable payload availability from moving-pointer
authority. Every signed payload is first published under its exact source SHA.
The automatic publisher signature-verifies the candidate in candidate mode and
the existing `:main` envelope in retained mode, derives both generations from
their signed payloads, and retags only when the generations are equal. A missing
pointer or generation mismatch leaves `:main` unchanged. The owner-only schema
activation workflow can bridge an increasing generation only after binding the
exact protected-main SHA, candidate/current OCI digests, and an attended
owner-observed installed control-plane digest equal to the signed candidate.
That observation is not represented as a machine-generated host attestation.
Both workflows share one concurrency group and reassert the public pointer and
protected-main identity around the retag.

The first v3 pointer activation after an attended controller upgrade may be summary
ineligible solely because the governance inputs used to classify it changed.
That one bridge is admitted only when the installed control plane already equals
the signed candidate and the poller reopens the exact active OCI digest, verifies
its retained v2 or v3 signature, and binds it back to completed receipt and
state. Candidate and retained payloads must have identical image repositories
and digests, Compose identity, complete migration inventory, complete
reconciliation projection, and up/down counts. Only the classifier verdict
fields and `migrations.digest` that encodes those fields are excluded from this
comparison. Missing retained evidence or any deployable drift refuses the
exception; authorization still runs the normal staging, backup, migration, and
production evidence path.

The deployment host recomputes `migrations.digest` from the signed eligibility
summary, inventory, and reconciliation and requires the inventory length to
equal `upFileCount`. It derives `reconciliationDigest` from that exact signed
reconciliation when materializing the runtime migration plan and immutable
receipt; the digest is not a separate manifest field. A changed per-file digest,
classification, compatibility flag, filename, lineage mapping, source commit,
policy exemption, exclusion, or ordering therefore invalidates the manifest
instead of relying on the summary verdict alone.

Signature validity is necessary but not freshness authority. The policy pins
the canonical public repository/ref and bounded timeout; the installed control
plane separately pins `/usr/bin/git`. Credential-free exact-ref `ls-remote`
must report the signed
`source.sha` at initial admission, after staging, and after backup, production
ledger reconciliation, and exact backup-evidence revalidation. The third check
is the last non-mutating boundary immediately before `production_observing`
write-ahead and the migrator. An unavailable lookup defers without mutation; a
mismatch tears down and atomically retires the exact staging target. Teardown
failure retains active evidence under a hard block. A settled exact-payload no-op
is proved by immutable state/receipt and remains offline-safe. Retained active
payload signature verification uses the immutable first-acceptance `startedAt`;
retry/status updates cannot extend or later invalidate that freshness boundary.

Installed control-plane bytes cross from an unprivileged staging tree into the
root trust boundary only after a builder-quiescence proof. Every source,
dependency, and native-module command runs in a transient systemd service whose
entire control group is terminated and collected when its main command ends.
Before ownership changes or activation, the installer requires no process under
the dedicated build UID and no open handle anywhere below the candidate; an
unexpected probe status or any diagnostic is a hard refusal. The resulting
root-owned, non-writable version and its readiness marker therefore have no
surviving lifecycle process or descriptor that can mutate their bytes.

Before lifecycle execution, an explicit-status Git proof binds a root-held
tracked-file manifest to the owner-reviewed SHA. After lifecycle execution,
the installer rechecks that manifest independently of Git metadata, admits no
extra path outside governed `node_modules`, removes `.git`, and records a
recursive digest covering path, type, mode, symlink target, and file bytes. The
manifest, marker, candidate filesystem, and staging parent are synced before
durable transaction admission; the digest is recomputed from the root-owned
tree on every retry.

Control-plane publication evidence is not complete at the version move or link
swap. Initial install, upgrade, and rollback use one root-only mutex and the
mode-0600, single-link
`/var/lib/nexus-release/state/control-plane-transaction.json`. Before its first
authority mutation, that exact-schema record durably binds operation/mode,
source and target identities, original active/previous selectors, candidate
digest and stage inode, phase, the four established timers' eight snapshot
active/enabled bits, the poller timer's target-aware desired pair, and the
backup-liveness timer's prior and target-aware desired pairs: fourteen exact
timer bits. The record is simultaneously the systemd
execution gate for bootstrap, poller, heartbeat, and backup-liveness when that
three-unit set is installed. After SIGKILL or reboot, only the same request may resume: it must
revalidate the record, candidate, exact selector pre/post identities, atomic
fixed-file publications, daemon reload, settled services, and all saved and
desired timer states. Every service and timer must have the governed
`/etc/systemd/system` fragment and an empty effective `DropInPaths`; physical
exact-name, dash-prefix, and type-wide drop-in tiers across the systemd unit
search path are blocking. After a durable complete phase and a second full
reproof, the gating record is atomically renamed to a validated post-gate
journal that continues to gate bootstrap and poller while all five timers remain
inactive. Saved-active heartbeat and backup-liveness require exact successful
oneshot proofs against the selected controller; backup-liveness uses the governed
force-proof service, never the cadence-gated timer service. A final full reproof
then atomically promotes the record to terminal finalization state. Before any
timer start, finalization recomputes the complete immutable tree digest, signed
control-plane identity, Node-22 native dependency proof, installed authority,
and exact effective units; a retry admits only the pending inactive state or the
exact terminal state for each timer. Initial mode proves all
physical unit definitions absent before build and again before gate publication;
rollback is admitted only when the requested immutable target is exactly
`checkout.previous`; a retained target without the signed three-unit liveness
set removes only the exact outgoing installed set and forces desired liveness
bits to 0/0.
A retained target without the post-gate poller condition preserves its enabled
bit but forces desired active to 0; restarting that timer is a separate attended
action after all journals are absent.
Any malformed state/stage object, request mismatch,
third selector identity, candidate drift, or unknown timer/service probe status
is blocking evidence, never a reason to resnapshot or rebuild.

## Pre-baseline transition evidence

Section 1b publishes `nexus.bootstrap-legacy-runtime-capture.v2` with an atomic
no-replace link before its first `pm2 stop`. The root-owned, mode-0600,
single-link record binds both canonical current-runtime paths, their source SHA,
artifact digest, complete-marker SHA-256, and each legacy database's device/inode
identity. All four PM2 rows must match those runtime, executable, role, artifact,
and database identities before the first writer is stopped.

After both target snapshots and the governed-backup repoint are proven, section
1b publishes `nexus.bootstrap-database-transition.v1`. It binds the entire
runtime-capture SHA-256, both fixed legacy and target paths, all four
device/inode identities and logical-dump digests, and the exact container
production backup path. The owner baseline requires both records. Before a
baseline exists, `recover-pm2` never moves, replaces, or removes a target or
temporary file; every remnant, including partial or divergent data, stays
offline in place for incident review. `resume-baseline` requires the
completed checkpoint and re-proves its target identities, digests, distinct
inodes, fresh governed backup, zero handles, and absent sidecars while PM2 stays
behind exact high-priority persistent control guards. A PM2 restart additionally
verifies the full installed source
tree and dependency attestation, not only the completion marker. After review,
`reset-cutover` copies and byte-compares both complete governed data directories
into a root-only incident, binds backups to the exact legacy production inode,
archives and retires the stale transition checkpoint, and restores exact PM2.
Section 1b may then reuse only a v2 runtime capture that still exactly matches
all current runtime, marker, artifact, and legacy database identities.

Baseline-dependent fallback progress is recorded in root-owned
`nexus.bootstrap-first-cutover-recovery.v1`; its phases bind the original
baseline/capture bytes, incident snapshots, database identities and logical
digests, backup binding, and final exact PM2 restoration. Rebaseline uses a
separate `nexus.bootstrap-rebaseline.v1` record keyed by the owner-expected
release ID. It keeps PM2 guarded, archives complete pre-reset governed data
trees, publishes a coherent new v2 runtime capture and transition checkpoint,
and generates only the fixed `bootstrap-baseline.json.next-<releaseId>`
candidate. The old baseline gains a durable archive hard link before an atomic
canonical swap; the sole canonical baseline is never moved away first. The
terminal fallback state is retired only after its exact incident copy and the
new baseline/evidence trio are durably validated.

Recovery admission reads this durable phase before trusting control guards.
After reboot or if SIGKILL landed after PM2 start, inactive authorities receive
exact root-owned persistent
`/etc/systemd/system.control/<unit> -> /dev/null` guards; an active authority is
accepted only after exact
four-row status, SHA, artifact, cwd, executable, role/base, database inode, PID,
installed-tree, and health proof. Only that complete proof may advance
`backup_repointed` to `pm2_restored`; every partial proof is stopped and guarded
before resume. An interrupted fixed SQLite recovery candidate is never trusted
on retry: only a canonical, non-symbolic, single-link, no-handle/no-sidecar file
is copied byte-for-byte into the durable incident, bound by SHA-256 and size in
the recovery state, and then removed before a fresh SQLite backup is created.

## `nexus.release-bootstrap-baseline.v2` (one-time transition)

This root-owned, mode-0600 file is explicit owner authorization for the first
PM2-to-container cutover; the ordinary poller timer cannot create or use it. It
contains a canonical creation time, the complete migration-inventory and
reconciliation digests,
the exact authorized target (release id, source SHA, OCI release-payload digest,
and signed-manifest digest), the recorded production/staging PM2 source SHAs,
and evidence for both legacy sources and both governed targets: exact path,
descriptor-bound byte and normalized-snapshot digests, raw schema digest, and an
environment-specific ledger split into canonical applied rows, exact signed
legacy rows, and signed pending rows. It also carries the semantic-schema proof:
each environment's exact pending migrations, its normalized post-migration
schema digest, the exact signed exclusions, the common converged digest, and
staging fixture row-count/digest preservation. The semantic proof is
`nexus.release-bootstrap-semantic-schema-proof.v2`: columns retain their ordinal
and each table retains a canonical token projection of its complete
`CREATE TABLE` statement, including collation, generated expressions, and table
constraints.

Generation and admission require each environment's canonical ledger to be an
ordered inventory prefix; production to contain exactly the signed 19 legacy
rows and staging exactly those 19 plus four notification aliases; and every
pending row to be signed and predecessor-compatible. Production and staging may
begin with different raw schemas. The verifier applies the exact pending bytes
to private in-memory snapshot copies, normalizes semantic schema descriptors,
excludes only the signed staging fixture table/index, requires convergence, and
requires the staging fixture data evidence to remain unchanged. Both source and
target must be matching single-link regular database snapshots with no open
handles and no WAL, SHM, or rollback-journal sidecar (including an empty WAL
left by a live connection).
Admission reopens the exact governed files without following symlinks, reads the
database snapshot through the verified descriptor, and compares all evidence to
the owner baseline and signed inventory. The file expires after 24 hours and is
published with an atomic no-replace link, so concurrent owner commands cannot
overwrite one another. Admission verifies all four snapshots before staging;
the production source/target pair is verified again immediately before backup
and migration. A successful receipt includes `owner_bootstrap_baseline` in
staging and `bootstrap_production_revalidation` in production, both carrying the
same whole-baseline SHA-256 (not merely the inventory digest).
An invalid, expired, revalidation-drifted, or no-longer-current target has its
exact staging project torn down and is atomically retired with a durable
`bootstrap_target_abandoned` owner-action block. Failure to tear down retains
the active target and records `preproduction_teardown_failed`; neither state can
be reused as authorization for another head.

The generator requires the owner-supplied exact 32-hex release ID and exact OCI
release-payload digest. It may resolve the mutable publication tag for discovery,
but a mismatch is rejected before the no-replace baseline publication. During
collection and admission, the PM2 fallback and container poller share one root
maintenance mutex; the known PM2 systemd authorities remain disabled and
protected by exact high-priority persistent control guards. A defined fallback
must match the capture-bound installed legacy
runtime tree, artifact digest and marker plus every restarted PM2 app, database
path, and health endpoint before it is accepted. The restore caller changes to
`/home/dominguez` before invoking the allowed `sudo -u dominguez pm2 ...`
command, and all four health endpoints must pass in the same bounded retry
iteration within 120 seconds. If forced container removal leaves WAL/SHM
pathnames, fallback may remove them only after no-handle, exact zero-WAL
checkpoint, no-journal, regular-file, single-link, and zero-byte-WAL proofs.

The historical PM2 ledger stored filenames, not executed-byte hashes. Before
the signing handoff, the secretless hosted full-history builder reads ordinary
rows from their exact `sourceCommit` and migration path. A v4
`repository_archive` row keeps `sourceCommit` only as historical provenance
metadata and verifies the digest from the candidate-index archive at the one
canonical `<sourceCommit>/<file>` locator. The locator must be one stage-0
regular `100644` Git entry; untracked, missing, duplicate, symlink, wrong-path,
or worktree-only bytes fail, and an available dangling source commit is never a
fallback. The source-policy digest binds the archive mode and locator while the
runtime v2 projection intentionally remains locator-free. The builder requires
byte-identical replacements to match exactly and comment-only replacements to
have the same executable token stream after deterministic SQL
comment/whitespace normalization. The signed projection therefore proves the
governed source-evidence bytes and declared replacement relationships. It does
not independently prove that archived bytes belong to the historical
`sourceCommit`, or that an old PM2 process executed them. The baseline still
records the owner's acceptance of the current quiesced database state, and the
append-only migration gate makes that accepted boundary enforceable for every
later release.

`nexus.release-signing-handoff.v1` is the only builder output the signing job
accepts. Its closed manifest binds protected source SHA, successful CI run ID,
GitHub-owned push comparison base, both immutable application-image digests,
and the SHA-256 of `hosted-migration-safety.json` and
`docker-compose.release.yml`. Those two data files plus the handoff manifest are
the artifact's exact file set; no script, binary, package tree, or lifecycle
output crosses the job boundary. The hosted-result SHA must still equal the
digest emitted at the earlier secretless recomputation, so image-build-time
mutation cannot be rebound into a new handoff. The builder exposes the raw
manifest digest and immutable artifact ID as separate job outputs.

The dependent `release-publish` job starts on a fresh GitHub-hosted VM, checks
out the exact bound source, installs no dependencies, and downloads only that
artifact ID. Its built-in-only verifier rejects unknown JSON fields, extra
files, symlinks, non-regular or oversized inputs, identity drift, byte-digest
drift, an incomplete hosted verdict, a different comparison base, or Compose
bytes that differ from the exact checkout. The last secretless step independently
rechecks the CI run/check-suite identity and current public protected-main head.
Only the following signer step receives the Ed25519 private key; its output must
verify against the committed public pin before the scratch release payload can
be published. Thus a dependency lifecycle process from the image builder cannot
survive into the signing VM or read the long-lived key.

## Migration result

`scripts/migration-safety-check.mjs --json` retains its existing
`authorization` object unchanged and adds an independent sibling:

```json
"cdEligibility": {
  "schema": "nexus.migration-cd-eligibility.v1",
  "eligible": false,
  "predecessorCompatible": false,
  "reasons": ["migrations/282_x.sql:create_unique_index"],
  "files": [{ "file": "…", "kind": "contract", "statementCount": 42,
              "predecessorCompatible": false, "blockingReasons": ["…"] }]
}
```

`authorization.authorizesPromotion` is specific to approved irreversible
operations and must never be used to derive ordinary CD eligibility. Without a
change scope (`--changed-only`), `cdEligibility` reports
`reasons: ["change_scope_not_evaluated"]` and `eligible: false`: guessing would
authorize an unattended deploy over unknown schema work.

The changed-scope gate also enforces append-only migration history. A migration
present in the Git comparison base may not be modified, renamed, or deleted;
only a new filename may add SQL. The ledger is filename-only and staging is
durable, so allowing bytes behind an applied name to change would mean staging
could skip bytes that production later executes without rehearsal.

Every module that can classify, package, admit, reconcile, or apply that signed
inventory is itself a migration-governance path. In particular,
`scripts/lib/migration-cd-eligibility.mjs` maps to
`POLICY_CD_ELIGIBILITY_CHANGED`; runtime runner, external application,
one-shot migrator, manifest/ledger/deployment, Dockerfile, and Compose changes
have their own exact policy reasons.

## Release state

`/var/lib/nexus-release/state/release-state.json`, schema
`nexus.release-host-state.v1`. The VPS is authoritative.

`active`: release id, source SHA, status, active image digests, release-payload
digest and Compose digest, the accepted signed-evidence digest, started/updated
timestamps, attempt count, sanitized last evidence, verified pre-migration
backup evidence (governed artifact name and absolute path, encrypted SHA-256 and
size, covered database, and producer-start/receipt-completion times), and the
snapshotted `rollbackTarget` identity. The rollback target carries the outgoing
completed release's source SHA, image pair, release-payload digest, and Compose digest; it
survives even when a later `completed` state promotes the interrupted candidate
into `predecessor`, and a successful crash rollback reinstates that target as
`predecessor`. `predecessor`: release id, source SHA, image digests,
release-payload digest and Compose digest — only a *completed* release becomes the
predecessor, so a rolled-back candidate never displaces the rollback target. `blocked`:
release id, governed reason, since. `unresolvedContractMigrations` survives an
acknowledgement so pending contract work cannot be erased, and
`lastAcceptedRunId` enforces monotonic source ordering. Bounded `history` and
`rejected` lists retain settled and refused identities. New settled history
entries carry nullable `recoveryTiming`
`{incidentRecoveryDurationMs, predecessorSwitchDurationMs,
predecessorSwitchObjectiveSeconds}`; the original three-key v1 history entries
remain readable during host upgrade.

Statuses: `eligible`, `staging_healthy`, `production_observing`, `completed`,
`rolled_back`, `rollback_failed`.

Written write-ahead: the status that admits a mutation is persisted before the
mutation is attempted. Reads fail closed — an unparseable state file is an error,
never treated as absent.

The backup unit's `last-success.json` is a mutable fresh-admission pointer, not a
recovery identity. Fresh admission returns the complete verified fields to the
deployment, which descriptor-reverifies those exact bytes before persisting
them; crash recovery uses only persisted `active.backupEvidence`, even if the
pointer has since been overwritten or removed.
A separate weekly heartbeat descriptor-binds that pointer, the current encrypted
artifact, and the latest restore-verification receipt. It rehashes the current
artifact and requires it to be no older than two hours; restore evidence must be
no older than eight days. A restored artifact that remains present is rehashed,
while safe hourly-retention pruning leaves its immutable restore receipt as the
accepted proof. Invalid, mismatched, future-dated, or stale evidence fails the
heartbeat and pages through sanitized fields. Hourly backup and weekly restore
`ExecStopPost` hooks page immediately on unit failure, and the Python jobs run
under `env -i` so only the alert helper receives dedicated release-channel
credentials.
The producer records canonical `startedAt` before attempting its lock or opening
the source database. Admission requires that timestamp to be at or after the
release's `systemctl start` request and requires `completedAt >= startedAt`, so
an already-activating oneshot cannot satisfy a later release request merely by
finishing after it. First-cutover and PM2-recovery backup admission additionally
requires the installed producer, unit, timer, and sudoers bytes to match the
resolved immutable active control-plane tree, with exact root metadata, no unit
drop-ins, and the expected effective pre-promotion `ExecStart`. The backup unit
filesystem sandbox grants write access only to the encrypted backup root and the
governed legacy/container production data directories. The producer binds the
source database and sidecar inodes, does not replace, reown, or repermission
stable source-owned sidecars, and normalizes only safe root-created sidecars to
the source UID/GID/mode before copying and in its close-time finalizer. Normal
SQLite reader coordination may update SHM contents. Admission and
cutover still require the exact cleanup proofs before database publication or
transition evidence.
The backup producer fsyncs each encrypted artifact and checksum before rename,
fsyncs their final files and parent namespace, and only then durably publishes
the receipt with the same file/rename/parent ordering. A passed pointer cannot
therefore precede the recovery bytes it authorizes.

If a mutation-admitting status has no terminal receipt, the poller writes an
`unprovable_active_release` block before recovery, replacing any ordinary block
that may have been written just before the receiptless crash. State-store
acknowledgement independently recomputes effective receipt proof, so a stale
ordinary reason cannot clear an unprovable mutation. Recovery accepts only the exact
signed active payload and exact snapshotted rollback target, requires read-only
database integrity, opens the governed backup root once with
`O_DIRECTORY | O_NOFOLLOW`, and opens the artifact once with `O_NOFOLLOW`.
Containment comes from those held descriptors. Two complete bounded positioned
hash passes must agree with the persisted digest, and post-read descriptor/path
identity, single-link count, size, and nanosecond mtime/ctime are reasserted for
the artifact while root descriptor/path identity is reasserted for the trust
boundary. It then pulls the exact
predecessor payload digest before extraction,
verifies predecessor Compose and running image identities, and
publishes a `rolled_back` or `rollback_failed` receipt. Missing or mismatched
backup bytes leave the release blocked without a terminal receipt claiming a
passed backup. The block cannot be acknowledged while it remains unprovable. A
verified integrity failure records
`rollback.result: not_attempted`; database bytes are never restored automatically.
The full incident clock begins before the recovery block, notification, and
evidence revalidation; an existing exact recovery block retains its durable
`since` across poller retries. A separate predecessor-switch clock and
120-second deadline begin immediately before the exact predecessor pull.

An accepted `eligible` or `staging_healthy` attempt resumes from its exact
persisted OCI payload and signed-evidence digest. A newer payload publication with
the same deployable release id is non-superseding and cannot replace those
mid-attempt claims. Public protected-head checks after staging and again at the
last non-mutating pre-write-ahead boundary supersede an outdated signed source;
the moving publication tag cannot do so by itself.

## `nexus.release-receipt.v3`

Immutable, one per release identity, written atomically (per-writer temp file,
`fsync`, `rename`, parent-directory `fsync`). Overwriting one is refused.

Fields: release id, source SHA, created/completed timestamps; `evidenceDigest`;
verified identity (repository, ref, workflow, run id, run attempt, manifest
digest, key id, and the
exact OCI release-payload digest extracted by the poller); both image digests;
Compose path and digest; the signed control-plane identity; the migration
verdict and reconciliation digest;
`staging` and `production`
phases each with `{result, checks[], durationMs}`; `backup` `{result, artifact}`;
`rollback` `{result, restored, incidentRecoveryDurationMs,
predecessorSwitchDurationMs, predecessorSwitchObjectiveSeconds}`; `outcome`;
`failureCode`.

Receipt v3 requires the signed `controlPlane` field. Retained receipt v2 is an
explicit legacy read shape and forbids that field. New v3 candidates always
write v3; the only writer of v2 is crash recovery settling an already-active,
signature-verified manifest v2 payload, because inventing a controller identity
would change its historical release and evidence digests. Schema and field
presence are checked bidirectionally, so adding `controlPlane` to v2 or removing
it from v3 is rejected rather than interpreted as a downgrade.

A `completed` receipt requires passing production observation plus exact running
image-digest checks for both governed services. `incidentRecoveryDurationMs`
covers the complete recovery incident, including paging and crash-evidence
revalidation. `predecessorSwitchDurationMs` covers only predecessor payload and
Compose proof, start, health, and both exact running-image checks; registry and
Compose subprocesses receive only `predecessorSwitchObjectiveSeconds` time
remaining. The switch duration cannot exceed the incident duration.
For a restored rollback, receipt and rolled-back history validation additionally
require the switch duration not to exceed the recorded objective.
`rollback_failed` serializes the rollback-specific topology, Compose, health,
identity, or deadline failure code rather than masking it with the candidate's
original failure.

`evidenceDigest` is SHA-256 over every claim admitted from the verified signed
manifest: full repository/ref/workflow/run provenance, source SHA, manifest and
key identity, exact OCI payload, images, Compose, control-plane identity, the
complete migration summary, and the signed reconciliation digest. It is
separate from `releaseId`:
the latter remains the idempotent deployable-content identity, while the
evidence digest binds which CI run, signed verdict, and exact legacy/drift policy
authorized it.

Receipt reads validate the exact schema, field types, numeric bounds, governed
artifact names, phase/result consistency, Compose and migration digests, and
rollback image identity. The requested filename id must equal the embedded id,
and the release id is recomputed from source SHA, both image digests, Compose
digest, migration digest, and (for receipts generated from v3 manifests)
control-plane identity. Pre-controller-binding receipts omit that field and
retain their original release-id calculation so an installed upgrade can still
prove the current predecessor. The evidence digest is independently recomputed
from every signed claim. Before a receipt can outrank active state, those same
fields, its OCI release-payload digest, and its evidence digest must match the
write-ahead active identity; a `rolled_back` receipt must also match the
snapshotted rollback target.
Any malformed, substituted, or state-mismatched receipt makes the active release
unprovable and enters fail-closed recovery instead of authorizing a quiet no-op.

Outcome/status compatibility is also exact:

| Receipt outcome | Compatible active status | Effective status |
| --- | --- | --- |
| `completed` | `production_observing`, `completed` | `completed` |
| `rolled_back` | any mutation-admitting status | `rolled_back` |
| `rollback_failed` | any mutation-admitting status | `rollback_failed` |
| `blocked` | `eligible`, `staging_healthy`, `production_observing` | unchanged active status |
| `staging_failed` | `eligible` | `eligible` |

Receiptless crash recovery writes its terminal receipt before updating the
recovered status projection, which is why either rollback result may temporarily
accompany any mutation-admitting status. Every other outcome/status pair is contradictory
and unprovable. The separate `blocked` state field may still name a preproduction
candidate without a receipt; that block is not active terminal evidence and does
not weaken this mapping.

`outcome` is one of `completed`, `rolled_back`, `rollback_failed`, `blocked`,
`staging_failed`. `rollback.result` is one of `not_required`, `restored`,
`failed`, `not_attempted` — `not_attempted` records a database-integrity hard
stop, where the pipeline deliberately declined to roll back because swapping
images cannot repair corrupt data. `staging_failed` is kept distinct from
`blocked`: one means the rehearsal rejected the candidate; the other is a hard
halt without a completed or rollback terminal result and can occur before or
after staging or production mutation. Collapsing them would erase whether the
candidate failed rehearsal or the control plane stopped on an unresolved safety
condition.

Every free-text field passes through a one-line, 200-character token allowlist.
Credential contexts and URLs carrying userinfo redact the whole value; unknown
tokens, six-or-more-digit bare numbers, long lowercase runs, arbitrary
snake/kebab passphrases, and bare 32/40/64-hex values become `[redacted]`.
The numeric, raw-hex, and segmented-passphrase checks repeat per path segment,
so a leading slash cannot bypass them. Only exact reviewed hyphenated components
of governed release, backup, audit, and legacy paths bypass that residual-secret
rule. Governed absolute paths, exact enumerated
release codes, prefixed
`sha256:<64 hex>` digests, and backup artifact names remain available. Exact
32-hex release ids and full 40-character source SHAs bypass free text only after
their structured notification fields pass exact validators. Multiline content
is cut at the first line break and terminal sentence punctuation is removed
before matching. This deliberately prefers losing harmless prose over retaining
a plausible credential, provider payload, PIN, passphrase, or opaque token.

There is deliberately **no audit-mirror field**: the mirror copies this exact
file, so any mirror outcome recorded inside it could not be accurate at write
time, and a receipt rewritten afterwards is not immutable. Mirror outcomes live
in the durable queue, delivery acknowledgements, exhausted/quarantine evidence,
logs, and failure notifications — not in release state or the immutable receipt.
Every poll first reconciles validated immutable local receipts against those
terminal markers, then drains the queue. A crash after receipt publication but
before enqueue is repaired, while a fsynced delivery acknowledgement suppresses
a duplicate transfer after a crash in the acknowledgement-to-dequeue window.
Unexpected queue filenames and malformed or filename-mismatched bodies are
never filtered out. They are moved into exclusive unique quarantine bundles
without overwriting prior evidence, then the target bundle, source queue, and
quarantine parent are fsynced. Any publication failure throws rather than
reporting a clean queue: before the rename the source remains queued, and after
the rename the unique quarantine bundle remains visible.
Exhaustion becomes terminal and alertable only after its failed-entry evidence is
durable. A failed exhausted-marker publication leaves the source queued and the
attempt deferred for a later poll.
Local receipts are not subject to automatic count-based pruning: deleting them
would remove the authoritative settled-release and mirror-reconciliation proof.
Any future archive or retention policy therefore needs its own durable handoff
contract rather than a numeric runtime knob.
The acknowledgement is not derived from transport exit status: the remote host
must hash and fsync a temporary upload, perform a no-replace atomic finalize,
fsync the final file and parent directory, and return an exact final-path digest
readback. Local acknowledgement fields bind the local receipt digest and the
current remote host, account, final path, and observed digest; any mismatch is a
new delivery obligation.
Failed upload, finalize, and proof attempts invoke a non-gating cleanup on the
remote host. Cleanup validates the exact release ID and receipt digest before
examining only `.<releaseId>.<receiptDigest>.<32-hex-nonce>.upload` names; it
leaves the immutable `<releaseId>.json` final and unrelated or malformed names
untouched. A cleanup transport failure leaves retry and exhaustion accounting
unchanged, and the next attempt repeats cleanup when connectivity returns.

## Release discovery alert state

`/var/lib/nexus-release/state/release-discovery-alert.json` is the closed
`nexus.release-discovery-alert-state.v1` source for failures before a release
identity is trusted. It is a root-owned mode-0600 single-link regular file under
the existing mode-0700 release state directory. Every operation rebinds the
inherited held release-lock descriptor to the governed lock pathname. Writes
use exclusive mode-0600 temporary files, file `fsync`, atomic rename, and parent
directory `fsync`; exact safe crash leftovers are removed under the same lock,
while unknown names or metadata refuse the source.

The record contains one condition and at most one
`release_discovery:poll_failed` event. The event carries only governed
`controller_schema_incompatible` or `release_discovery_failed` codes plus fixed
source, phase, outcome, action, severity, runbook, lifecycle, attempt count, and
canonical timestamps. It is persisted before attempt one; attempts two and
three are due after 60 and 120 seconds. Attempt three failure is
`dead_letter`; delivery or dead-letter suppresses repeated poll failures. A
closed deployment result that can only follow signed discovery, an exact
completed-payload no-op, or an ordinary completed/blocked/staging receipt
changes the condition to healthy and rearms the next incident. Early durable blocks,
crash-recovery returns, and receiptless failures are not recovery proof. Open
delivery remains retryable across that edge and becomes `recovered` only after
its terminal delivery state is persisted.

The file is notification evidence, not deployment authority. Malformed or
unsafe state prevents a direct fallback notification but cannot change a
release result. Before signature verification there is no trusted release id or
source SHA, so those message fields are intentionally `unknown`; no moving-tag
value, exception text, log, credential, or provider response may fill them.

## Compose configuration

One `docker-compose.release.yml` serves both environments, because the signed
manifest carries a single Compose digest and staging must rehearse the exact
topology production will run. Per-environment values arrive as required
environment variables: digest-pinned images, root-owned env file, host-mounted
data directory, and the loopback ports (production 8200/8100, staging 8201/8101).
Every Compose render — including `config`, `ps`, `up`, `down`, and the migrator —
also requires the exact release ID, source SHA, backend image digest,
environment, and plan directory. Both backend and migrator mount the same
read-only `migration-plan.json`. It must be a single-link mode-0644 regular file
inside the mode-0755 direct `runtime-plan` child of the exact digest work
directory. Normal candidate work uses the signed candidate identity; normal and
crash rollback use the recorded predecessor identity. The registry wrapper
rejects an absent or unsafe plan directory and has no unmanaged or
candidate-default fallback.

`migrator` is a profile-gated one-shot service with `restart: "no"` and no
`depends_on`, so `docker compose up` can never start it. Staging migrates its
isolated staging database. Production runs the same one-shot service only after
the pre-migration backup is verified, while the previous release is still
serving. Before it opens SQLite or returns an idempotent no-op, the candidate
migrator requires the complete non-empty v2 plan and matches its ordered
filenames and every byte digest to the packaged migration source. The plan also binds the
complete signed reconciliation, its digest, the exact environment, and that
environment's legacy set. Missing, empty, symlinked, partial, byte-drifted, or
wrong-environment sources and plans fail closed. Application external mode
independently loads that same plan and rejects a missing source, a missing or
extra legacy ledger row, and any applied canonical filename absent from the
image. The plan and Compose environment also bind the exact backend image
digest. After SQL completion, all eight governed data-maintenance
transformations and an insert-only `release_data_maintenance:<releaseId>` receipt commit in one
`IMMEDIATE` transaction. External app boot accepts only the canonical receipt
whose release ID, source SHA, and backend digest exactly match its own required
environment, and performs none of those transformations itself.
It also proves the exact migration-028 `kv_store` columns, constraints, default,
primary key, and update index before loading persisted model or application
settings. Those loaders and the generic KV-store accessor disable their
schema-creation fallback in external mode, so those paths cannot create or
repair missing runtime state.

Rollback payload extraction may replace or recreate the retained work
directory, and the payload intentionally does not ship a materialized plan.
Before either normal or crash rollback renders predecessor Compose, the host
re-verifies the predecessor's signed manifest identity and Compose digest, then
materializes `nexus.release-migration-plan.v3`. It embeds the predecessor's
exact v2 identity, inventory, and reconciliation plus a root-projected
`rollbackSuccessor` identity and the exact ordered filename/digest prefix of
verified predecessor-compatible successor rows already applied. External-mode
predecessor boot admits only that signed forward suffix; unknown, digest-drifted,
or non-prefix rows still fail, and the one-shot migrator refuses v3 because the
plan is verification-only. A stale candidate plan or absent retained plan can
never be used to boot the predecessor backend.

---

## Release checksum evidence contract (PM2 fallback)

The release checkpoint publishes one unsigned checksum manifest. Trust comes
from protected GitHub workflow identity, exact SHA binding, SHA-256
verification, branch protection, and explicit production-owner approval.

## `nexus.release-checksum-manifest.v1`

Required fields:

| Field | Contract |
| --- | --- |
| `sourceSha` | Full lowercase SHA equal to the protected-main checkout |
| `version` | Version from the exact bundle completion marker |
| `createdAt` | Checkpoint timestamp |
| `artifact.name` | `release-bundle-<sourceSha>-<artifact.sha256>` |
| `artifact.sha256` | Aggregate SHA-256 from the checkpoint-built bundle manifest |
| `protectedMain` | Workflow/run identity, docs-only flag, and exact selected-test file/result counts and digests |
| `releaseCheckpoint` | Workflow name, run ID, and attempt |
| `releaseImpact` | Canonical protected release-state predecessor SHA plus sorted, deduplicated groups selected from the cumulative `deployedSha..sourceSha` diff |
| `testPolicySha256` | SHA-256 of the exact group policy used by the SHA |
| `selectedGroups` | Sorted, deduplicated protected-main test groups; empty only for a docs-only SHA |
| `fullSuite` | Exact deterministic inventory plus selected/remainder partition proof and four ordered, passing remainder-shard receipts |
| `python` | `passed` when required, otherwise `skipped` |
| `migrations` | `passed` when compatible migration files changed, otherwise `skipped`; governance-only changes bind an exact review-subject SHA-256, while irreversible migration SQL blocks checkpoint completion |

The partition commits the deterministic, protected-main selected, and
checkpoint remainder file counts and inventory SHA-256 values. Manifest
creation independently parses the selected and four shard Vitest JSON results
and fails unless selected and remainder are disjoint and their exact union is
the deterministic inventory. Each shard receipt records its `I/4` identity,
passing test/file counts, inventory SHA-256, and SHA-256 of the original Vitest
JSON result. A gap, overlap, failed, duplicated, or out-of-order shard
invalidates the manifest.

`scripts/release-checksum-manifest.mjs validate` additionally verifies the
bundle's declared file bytes, file inventory, completion marker, source SHA,
version, and aggregate artifact digest. An undeclared file in the pristine
bundle is rejected. Promotion derives conditional quality requirements from
`releaseImpact.groups`, never from `selectedGroups`, because only the former
covers every change since the deployed predecessor. Validation rejects a
`releaseImpact.deployedSha` that differs from the protected
`docs/release/release-state.json`.

## Transaction evidence

Both server phases write `nexus.lean-release-transaction.v1` with:

- role (`staging` or `production`);
- transaction ID;
- runtime SHA and artifact digest;
- exact release directory;
- predecessor path, SHA, and digest recorded before mutation;
- phase and terminal status;
- start, update, and completion timestamps;
- candidate health result;
- configured stability seconds and soak start/completion timestamps;
- rollback result and measured recovery duration;
- candidate/recovery health budgets and the 120-second rollback objective;
- artifact parity, migration startup, authenticated smoke, database integrity,
  pre-promotion backup, and rollback-readiness results;
- bounded failure message.

Writes use a temporary private file, file fsync, atomic rename, and parent
directory fsync. Local state binds the same artifact, checkpoint run, canonical
deployed SHA, and manifest SHA-256. Promotion revalidates the checkpoint run
and requires a fresh download of its exact named manifest artifact to match
those cached bytes and that SHA-256 before any server SSH.

Terminal success is only `phase=completed,status=passed`, with passing health,
authenticated runtime smoke and read-only SQLite integrity/foreign-key checks
for both roles, and rollback marked `not_required`. The authenticated smoke
binds the live snapshot version to `.complete.json.packageVersion` and verifies
that `current` still resolves to that exact candidate before and after the
request. `prePromotionBackup` is `passed` only for production and `skipped` for
staging; it is independent from `databaseIntegrity`. A failed production
candidate is recovered only when state says `rolled_back`, rollback is
`restored`, and the measured predecessor health recovery is recorded.
`rollback_failed` requires manual recovery and blocks another promotion.
Production success additionally requires a timestamped soak of at least 60
seconds and a predecessor SHA equal to `releaseImpact.deployedSha`. A staging
fault drill records `faultInjection=staging-health`, exact
predecessor recovery, and removal of the deliberately failed candidate before
the same bundle may be staged normally.

Validate a successful phase against its exact manifest with:

```bash
node scripts/release-checksum-manifest.mjs validate-state \
  --manifest <release-manifest.json> \
  --state <staging-or-production.json> \
  --role staging
```

## `nexus.shared-ios-release-gate.v1`

Backend CI produces a release-bound fixture with exactly six examples:
Dashboard Home, Training Home, Content Home, Training plan created, Training
plan needs-clarification, and Training plan generation-attempt created. Its
change classifier watches only the exact payload builders/contracts plus its
packaging, validation/digest helper, and test. It does not attest health,
authentication, push/APNs, or capability-manifest behavior.

Shared backend/iOS releases add a separate post-promotion receipt. The gate
accepts the exact backend checkpoint manifest, pristine bundle, passing
production journal, expected backend SHA, expected iOS SHA/source build, and
two signed iOS inputs:

- `nexus.ios-contract-attestation.v2`, produced by the protected-main iOS
  contract workflow against the fixture embedded in that exact backend bundle;
- `nexus.ios-distribution-attestation.v2`, produced for the same iOS SHA and
  source build by the governed Xcode Cloud distribution workflow.

The canonical producer is the owner-dispatched protected-main workflow
`.github/workflows/shared-ios-release-gate.yml` in the `production-release`
environment. It resolves the exact successful checkpoint manifest and bundle
from the same checkpoint run by artifact ID, materializes bounded canonical
evidence, and invokes `scripts/shared-ios-release-gate.mjs`. The CLI first runs
the canonical backend manifest and production-state validators over immutable
private snapshots. It then recomputes the bundle aggregate and
`dist/release/backend-ios-contract-fixture.v1.json` digest, verifies both
Ed25519 signatures against the pinned release public keys, and requires the
compatibility attestation's backend SHA, artifact digest, fixture digest, iOS
SHA, build number, and nine-selector suite to match exactly. The distribution
attestation must bind that same iOS SHA/source build and must be generated at or
after production `completedAt`; compatibility evidence must be generated no
later than production `startedAt`.

The receipt records only immutable identities and digests: backend runtime,
artifact, manifest and fixture; production transaction and completion time;
iOS source/distributed build identity, attestation digests, contract selection
digest, and exported artifact digest; plus the ordered chronology timestamps. It
contains no credentials or provider payloads. A failed signature, expired
attestation, substituted fixture, failed production transaction, SHA/build
drift, or reversed chronology fails closed.

Only the receipt artifact uploaded by a successful run of that workflow is a
shared-release authorization record. Direct CLI output is useful for local
diagnosis but cannot authorize TestFlight group assignment, App Store
submission, or user release.

## Deliberate exclusions

The manifest is not cryptographically signed, contains no secrets, and does
not authorize production by itself. SonarQube, mutation results, AWS, KVM
drills, documentation closeout, and timing targets are not fields or gates.
iOS compatibility evidence, distribution evidence, and the shared receipt are
intentionally not checkpoint-manifest fields or prerequisites: they form the
separate post-promotion gate and therefore cannot create a cross-repository
checkpoint cycle.
