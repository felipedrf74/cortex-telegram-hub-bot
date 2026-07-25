# Release Runbook

Status: canonical
Owner: Felipe
Last verified: 2026-07-23

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
npm run release:prepare -- --base <sha> --backend-only
gh workflow run release-candidate-evidence.yml --ref <candidate-ref> -f contract_scope=backend_only
scripts/request-release-manifest-signature.sh <sha> <rc-run-id> --backend-only
npm run release:staging -- --manifest .local/release/manifests/<sha>.json
npm run release:promote -- --manifest .local/release/manifests/<sha>.json
```

For a release that changes a shared backend/iOS contract, use
`--includes-ios --ios-sha <ios-sha> --ios-build-number <build> --ios-contract-result passed`
for `release:prepare`. Dispatch the RC workflow with
`contract_scope=shared_backend_ios` plus matching `ios_sha`,
`ios_build_number`, and `ios_contract_result=passed` fields. RC creation and
protected signing both fail closed when the scope is omitted, contradictory,
or incomplete. Tag pushes do not infer contract scope or create RC evidence.
RC iOS fields are untrusted candidate intent, not compatibility evidence.

Once the RC artifact exists, run `trusted-release-signer.mjs
ios-contract-request` against its downloaded root, then dispatch the iOS
repository's protected-main `ios-contract-evidence.yml` with the emitted exact
backend SHA, artifact digest, candidate fixture digest, and fixture base64.
Download the successful run's signed compatibility attestation. Separately run
the protected iOS `App Store Release` Xcode Cloud workflow for that same clean
SHA and source build. Its post-archive gate emits a signed
`nexus.ios-distribution-attestation.v2` only after proving the selected stable
Xcode/iOS SDK, source tree, verified ad-hoc `.xcarchive`, exported App Store
app/IPA, bundle, team, version, source build, Xcode Cloud-assigned distributed
build, Apple Distribution signing identity, entitlements, and Xcode Cloud build
identity. Extract the attestation JSON from
its bounded base64url marker,
then request signing with both proofs:

```bash
scripts/request-release-manifest-signature.sh <backend-sha> <rc-run-id> \
  --includes-ios \
  --ios-attestation <ios-contract-attestation.json> \
  --ios-distribution-attestation <ios-distribution-attestation.json>
```

The signer accepts no direct iOS SHA, build, or result fields and needs no
cross-repository PAT. It verifies each envelope against its separate pinned iOS
public key, independently reads the fixture from the exact RC bundle, and
requires both proofs to name the same iOS SHA/source build; the distribution
proof additionally requires the exported app build to equal the Xcode Cloud
build number. Compatibility proof alone
does not prove archive or App Store binary identity; distribution proof alone
does not prove the backend payload decodes. Missing, expired, or mismatched
proofs make a shared release non-promotable.

`release:prepare` runs the release gate, builds one governed runtime bundle,
and writes an unsigned candidate payload. The RC workflow also contains no
signing secret. Only the protected-main signer, gated by the `release-signing`
environment, may turn a successful exact-run artifact into a promotable
`ReleaseManifestV2`. A changed artifact or test policy invalidates the result.
A docs-only commit cannot replace the required check for a runtime SHA.
The signer independently reconstructs the selected backend-only or shared
backend/iOS compatibility binding from protected CI evidence and requires it to
match the unsigned candidate byte-for-byte. A shared unsigned RC deliberately
contains `ios.distribution: null`; only protected-main tooling may enrich that
field after verifying the second attestation. The final signed output retains
both exact iOS attestations and their digest-bearing signing provenance.

The default RC lane runs the exact union of changed, critical, and cannot-skip
tests only when a successful full nightly from the preceding 36 hours is an
ancestor of the candidate, used the same test policy, and proves the complete
Vitest file set. Protected-main tooling fetches that exact nightly run and
artifact and independently recomputes the candidate's static dependency map.
Missing, stale, mismatched, or forged evidence; test-infrastructure changes;
removed or renamed test files; and unresolved production-code impact all fail
closed to the four-shard full suite. Python remains a full release-artifact
gate.

## Fast, sequential release policy

The observed planning baseline is approximately 12m25s from protected-main CI
through RC plus a median 7m15s avoidable operator handoff. The activation target
is a p50 of at most 9 minutes for the exact interval from protected-main CI
`startedAt` through exact RC `completedAt`; CI and RC stage durations remain
separately reported. For each release, sum every unattended transition, exclude
explicit approval waits, then calculate p50/p95 across exactly ten releases.
The unattended p50 target is at most 1 minute. Do not reinterpret the mandatory
60-second soak as service unavailability.

Keep the existing CI jobs and four Vitest shards. Do not add another matrix,
custom shard scheduler, competing release lane, background release worker, or
parallel Sonar/release execution. The resumable release coordinator is one
sequential command and one checkpoint: it verifies exact source and RC
identity, requests protected signing, validates staging, stops for explicit
production-owner approval, submits one root-owned server transaction, and
polls its journal. It never approves a protected environment or migration.
Restarting the coordinator revalidates completed evidence instead of blindly
repeating the phase.
The local checkpoint lock is a persistent owner-only regular file held for the
coordinator lifetime by the host OS (`lockf -k` on macOS or `flock` on Linux).
It is never deleted and recreated to recover a presumed stale owner. A second
coordinator exits immediately, inode drift is blocking, and loss of the lock
holder aborts the active coordinator before another release phase can start.

Start a backend-only coordinated release from a clean checkout of the exact
protected `origin/main` SHA with:

```bash
npm run release:resume -- --backend-only
```

When a current protected-main reuse activation envelope exists, first place it
in an owner-only regular file, then supply its path:

```bash
chmod 600 /absolute/path/protected-main-reuse-activation.json
npm run release:resume -- --backend-only \
  --protected-reuse-activation /absolute/path/protected-main-reuse-activation.json
```

Before writing RC dispatch intent, the coordinator accepts only an
owner-matching, mode-0600, single-link regular file within the bounded input
size. It atomically snapshots those exact bytes under
`.local/release/sequence-inputs/` and checkpoints the snapshot path, SHA-256,
size, and mode. RC base64 is generated only from that bound snapshot. Missing,
oversize, invalid, linked, or permission-unsafe initial input is recorded as an
explicit full-RC fallback. Once RC intent exists, an activation cannot be added
or substituted; any supplied-path or snapshot drift blocks the resume. A
normal restart may omit the original path because the private snapshot remains
the authority.

Protected manifest and staging signing are also dispatch-once phases. Before
dispatch, the coordinator persists the workflow digest, exact main SHA,
baseline run IDs, request UUID, not-before timestamp, expected run title, and
dispatch-command digest. A staging run title and dispatch also bind the
SHA-256 of the exact raw staging-request bytes; a matching UUID with another
digest is not the same request. An uncertain dispatch is reconciled to exactly one
post-baseline run; ambiguity or a missing correlation stops for manual review,
and a started dispatch is never sent again. The signing helpers receive the
checkpointed `--run-id`, so they only watch, download, validate, and publish
that exact run. Manifest publication installs the validated bundle first and
the manifest last; staging-attestation publication is likewise atomic and
mode 0600.

Staging uses one deterministic request UUID bound to repository, runtime,
artifact, and signed-manifest digests. The coordinator calls the operator with
`--no-sign-request`, checkpoints the exact request bytes and installed and
recovery runtime digests, and then performs the protected signing phase
itself. If the Mac disconnects after staging has already switched to the exact
candidate, only the private coordinator checkpoint authorizes resume. That
path first invokes the root-installed promotion control v3 verifier. Before
the original switch, root independently verified and sealed the artifact and
installed tree, computed recovery identity with the root-installed DR helper,
and durably bound those digests, the request UUID, runtime path, SHA, and
artifact under `/var/lib/nexus-release-promotion/staging/`. Resume rejects a
missing or drifted binding before executing any release-owned file. Only then
may the now root-owned, non-writable, artifact-bound preflight and readiness
scripts run. Their generated readiness and PM2 evidence is written below the
staging base's `.release-evidence/<request-id>/`, never into the sealed release
tree. Authenticated smoke and exact PM2 identity are repeated without
reinstalling or restarting an already-active candidate. Failed validation
leaves the active path untouched and blocks signing.

Protected-main exact-SHA reuse remains shadow-only for five production
releases. Each comparison covers workflow/run, toolchain, lockfiles, test
policy, selected files/results, required jobs, and the exact uploaded runtime
bundle identity. Protected-main CI downloads that same named bundle and
re-verifies its manifest, SHA, file closure, and digest before publishing the
shadow evidence; this does not enable reuse.
Only five consecutive exact agreements may activate reuse in the signed
manifest path. Missing, stale, changed, or ambiguous evidence keeps the normal
four-shard RC fallback. The RC planner itself performs no dependency install or
standalone typecheck: its two executable entrypoints have a recursively tested
Node-built-in-only dependency closure, while the trusted protected-main build
continues to own typecheck and build correctness.

SonarQube is advisory quality feedback, not a time-saving release stage. Run
`npm run quality:sonar` only from its Mac-side exact-origin/main launcher and
never during a release; it imports matching coverage and must not rerun tests.
The scanner and release transaction use the same non-waiting host flock, and
release preflight also consumes only the root helper's project-scoped active
Compute Engine count. Sonar start itself requires a fresh same-boot 16-GiB
no-pressure preflight and the exact completed small-model soak/cleanup chain.
That chain is not an operator-authored summary: it is the canonical output of
the root-owned durable ServerDominguez systemd one-shot, which holds the
release/Sonar mutex and owns one foreground collector independently of the
Mac/SSH session. Its request/journal binds phase, exact PM2 SHA, prior evidence
digest, boot identity, and final result. The result is recursively backed by
mode-0600 raw same-boot samples and exact-window SQLite `api_usage`
provider/model counts. The request UUID, immutable request-file SHA-256, and
expected runtime SHA recur in the collector result, request aggregate, and
every raw sample, and every sampled PM2 process must equal that SHA.
Production binds the prior staging control request, cleanup binds both
staging and production requests, and zero-swap binds the cleanup's production
request. Missing or drifting collector/request provenance fails closed.

The Ollama envelope installer is likewise source-bound: it executes only from
the exact root-owned SHA bootstrap, verifies the owner-approved archive digest
and Git PAX commit, and transactionally restores every operational asset plus
the prior drop-in and service state on failure. It never installs an unpinned
Ollama binary or pulls a mutable model tag; the reviewed Ollama 0.24.0 binary
(`b2e45ade9cb754a079f74645e1183d613f582d98f7354b05f4f9a5bd81f8e0c9`),
root-owned service fragment
(`72b23db27bcd69aa9c05226285a928ae8520dac108736072a33cea35bbcccdda`),
and retained 3B model
(`357c53fb659c5076de1d65ccb0b397446227b71a42be9d1603d46168015c9e4b`)
are verified before and after. Commit independently re-queries the bounded
loopback tags endpoint, requires exactly one matching retained tag, and records
the raw response digest plus exact model identity in the mode-0600 receipt.
The reviewed bootstrap installs a permanent root-owned install-state guard;
the installer verifies it and reloads systemd before writing its journal, so a
power loss before candidate publication remains fail-closed on the next boot.
Commit and rollback seal a durable exact-result terminal journal before
best-effort backup garbage collection. If the active/enabled predecessor had
no override, rollback may restart it only through one authorization bound to
the transaction, original candidate digest, current boot, and live helper PID;
the guard consumes that authorization once and rejects replay or reboot drift.
Immediately before Compose starts, the root wrapper also rereads the live
Ollama inventory, retained-model digest, loaded models, and effective systemd
envelope, and it requires a working age-encryption plus authenticated
S3-compatible backup-readiness probe. The canonical staging smoke invokes the
exact release's Ollama smoke sequentially; it creates no additional workflow,
lane, shard, or release concurrency.
Initial rollout additionally requires a successful exact-SHA scan whose bound
before/after p50 and p95 application latency regress by no more than 5%; that
check controls Sonar enablement only. If Sonar becomes required, move it off
ServerDominguez before changing any release gate.

Before any PM2 or production-data mutation, the transaction escrows the exact
candidate recovery runtime under its `phase-pre-mutation` key and records a
fresh database recovery point. Customer availability is measured as soon as
the exact candidate passes local, public, PM2/current, and Sentry-SHA identity
checks. The transaction then runs exactly one 60-second post-candidate
stability soak while customers are already served. It verifies readiness,
escrows the predecessor rollback archive, a newly encrypted phase-distinct
`phase-post-soak` candidate recovery runtime, and a refreshed database point,
then verifies readiness again. That network work and documentation closeout
do not count as customer outage; detected candidate degradation during escrow
triggers automatic predecessor recovery.

### One-time promotion control-plane bootstrap

The owner Ed25519 private key stays off ServerDominguez, mode 0600 on the
owner's Mac. Copy only its public key to the server. Never execute this
installer with `sudo` from `/home/dominguez`, an application checkout, or any
other application-user-writable path. First copy the exact reviewed source
archive and public key into a new root-owned mode-0700 directory, verify their
owner-reviewed SHA-256 values after that copy, extract the verified root-owned
archive with `--no-same-owner --no-same-permissions`, and install the exact
offline PM2 closure before rewiring the application unit.

Build that closure before the maintenance window on a trusted Ubuntu
24.04/x86-64 builder with Node 22.23.1 and npm 10.9.8:

```bash
install -d -m 700 .local/pm2-closure
node scripts/build-pm2-root-closure.mjs \
  --output "$PWD/.local/pm2-closure/pm2-6.0.14.tar.gz" \
  > "$PWD/.local/pm2-closure/build.json"
sha256sum "$PWD/.local/pm2-closure/pm2-6.0.14.tar.gz"
```

Copy the archive into the same exact-SHA, root-owned bootstrap directory and
verify that its server digest equals `archiveSha256` in `build.json`. During the
owner-approved maintenance window, install the trusted lock and closure from
the exact reviewed source. This step performs no production network install:

```bash
sudo install -d -o root -g root -m 755 /usr/local/share/nexus-release
sudo install -o root -g root -m 644 \
  /var/lib/nexus-release-bootstrap/<exact-sha>/source/ops/pm2/package-lock.json \
  /usr/local/share/nexus-release/pm2-package-lock.json
sudo /var/lib/nexus-release-bootstrap/<exact-sha>/source/scripts/remote-pm2-root-install.sh \
  /var/lib/nexus-release-bootstrap/<exact-sha>/pm2-6.0.14.tar.gz \
  <owner-approved-64-hex-pm2-closure-sha256> \
  6.0.14
```

The closure installer is first-install only and refuses an implicit
replacement. If its root-owned attestation already exists, do not delete or
overwrite it. Run
`sudo /var/lib/nexus-release-bootstrap/<exact-sha>/source/scripts/remote-promotion-control.sh assert-root-pm2-ready`
instead; a mismatch requires owner inspection and a separate replacement
procedure.

Only after that command succeeds, run the five-argument control-plane
bootstrap:

```bash
sudo /var/lib/nexus-release-bootstrap/<exact-sha>/source/scripts/remote-promotion-systemd-install.sh \
  /var/lib/nexus-release-bootstrap/<exact-sha>/source \
  <exact-40-hex-protected-main-sha> \
  /var/lib/nexus-release-bootstrap/<exact-sha>/source.tar.gz \
  <owner-approved-64-hex-source-archive-sha256> \
  /var/lib/nexus-release-bootstrap/<exact-sha>/nexus-owner-promotion-public-key.pem
sudo /usr/local/sbin/nexus-release-promotion-control version
sudo /usr/local/sbin/nexus-release-promotion-control assert-root-pm2-ready
sudo systemd-tmpfiles --create /etc/tmpfiles.d/nexus-release-sonar-lock.conf
sudo stat -c '%U:%G:%a %n' /run/lock/nexus-release-sonar.lock
```

The source archive must be the exact protected-main Git archive created with
`--prefix=source/`; its PAX commit identity, SHA-256, unique regular members,
and every installed release, DR, Ollama, PM2, and systemd input are verified
before privileged mutation. The installer independently rejects any source,
archive, key, or ancestor directory
that is not canonical, root-owned, and non-writable by group/other. A
pre-copy digest check against the `/home` input is not sufficient because the
application identity can change that file between checking and privileged
use. It also writes
`/var/lib/nexus-release-promotion/bootstrap-in-progress.v1` before replacing
the DR/control compatibility set. While that marker exists, promotion commands
and units fail closed and the sudo contract is withheld; rerun the same
reviewed bootstrap to finish and clear it.
The bootstrap refuses to rewire or accept `pm2-dominguez.service` unless the
root-owned PM2 6.0.14 closure, regular `/usr/local/bin/pm2` launcher, Node
22.23.1 identity, trusted lock, and installation attestation all validate.

The promotion bootstrap first invokes the exact
`application-dr-systemd-install.sh` from that same reviewed source. This
transactionally installs the compatible root-owned backup, recovery-runtime,
version-retention, restore-drill, service, and timer assets and creates the
isolated `nexus-drill` identity. It deliberately does not write
`/etc/nexus-application-dr/backup.env`, install provider credentials, or enable
a previously disabled timer. The DR installer durably journals an in-progress
compatibility-set replacement.
If its host is interrupted, both systemd and direct backup invocation remain
fail-closed until the owner reruns that exact reviewed installer successfully.
Complete the provider-control and root-only configuration procedure in
`ops/application-dr/OPERATIONS.txt`, then require:

```bash
sudo /usr/local/libexec/nexus-application-dr/application-dr-backup.sh \
  --config /etc/nexus-application-dr/backup.env --verify-config
```

For a fresh AWS namespace, the first verification reports
`lifecyclePhase=disabled-bootstrap bootstrapReceipt=absent`. Keep the timer
disabled and run exactly one owner-observed backup directly; the systemd unit
cannot supply this single-use flag:

```bash
sudo /usr/local/libexec/nexus-application-dr/application-dr-backup.sh \
  --config /etc/nexus-application-dr/backup.env \
  --bootstrap-first-backup \
  --bootstrap-rollback-bundle /home/dominguez/backups/nexushub/v<exact>.tar.gz \
  --bootstrap-rollback-sha256 <owner-reviewed-exact-sha256>
```

The selected path and expected SHA-256 must come from root promotion
transaction/backup evidence, or from a separately owner-reviewed root-side
strict-normalization receipt for an older artifact. A new hash printed only by
the application account is not authority. The receipt binds exactly one
selected, descriptor-stable, locally verified and off-host rollback identity.
Bind its exclusive root-owned, owner-reviewed digest into the reviewed
`LifecycleActivation=ENABLED` change set, replace the bootstrap observation
with ordinary enabled v2 storage-control evidence, and rerun `--verify-config`.
Require `lifecyclePhase=enabled bootstrapReceipt=not-applicable`; only then
enable the timer:

```bash
sudo systemctl enable --now nexus-application-dr-backup.timer
```

Do not launch a release until that final exact `--verify-config` command passes
with the enabled/not-applicable state and the owner-observed backup has verified
its database and release objects off-host. The root promotion broker accepts
only the exact ordinary AWS enabled/not-applicable output or the exact approved
R2 variance/not-applicable output before it can arm recovery or stop PM2.
Disabled bootstrap, missing fields, additional output, or older provisioning
ends only as `failed_before_stop`.

The expected control version is `nexus-release-promotion-control.v3`; the lock
identity is `root:dominguez:660`. Remove the temporary public-key input after
the installed copy is verified. Never copy the private key, a signing command,
or a reusable owner decision onto the server. `dominguez` may submit a signed
request and query/recover its exact transaction, but only the root broker may
write authoritative state, seal results, or confirm rollback escrow.

The same bootstrap installs a root-owned, built-ins-only runtime attestor. The
narrow `prepare-runtime-target` operation makes the production base
root-owned/sticky and `releases/` root-owned and non-writable to `dominguez`,
then creates or resumes only the canonical exact target. After the staging copy,
`seal-runtime` verifies artifact bytes, dependency trees, installed-runtime
identity, bounded symlink targets, and exact `.env`/`data`/`logs` links before
removing every application write bit. The broker repeats trusted predecessor
and candidate attestation immediately before cutover and after candidate
readiness; candidate-provided verification code cannot authorize itself. The
owner-signed request binds both predecessor and candidate artifact and
installed-runtime digests plus the candidate recovery-runtime digest and exact
signed release-manifest and staging-attestation SHA-256 values.

Control v3 also permits only the narrow
`prepare-staging-runtime-target`, `seal-staging-runtime`, and
`verify-staging-runtime` commands through sudo. The bootstrap verifies that
the DR recovery-identity helper is root-owned, creates the non-enumerable
root-only staging-binding directory, and installs all three commands in the
same reviewed sudoers transaction. `dominguez` cannot replace the installed
attestors or the binding. Re-run this exact bootstrap before using the updated
staging path; an older control version is a hard staging stop.

The Mac seals the copied runtime before submitting the durable transaction.
Inside that transaction, and before recovery is armed or the worker can reach
PM2, the root broker runs the installed application-DR tool's bounded
`--verify-config` check. Missing tooling, an unsafe or invalid root-only config,
or incomplete local encryption/backup prerequisites terminates the journal as
`failed_before_stop`. A passing
`nexus.pre-mutation-current-recovery-escrow.v2` must then prove the
phase-pre-mutation candidate recovery object and fresh database point before
cutover. Success later requires the separate post-soak rollback, candidate
recovery, and database confirmations; neither phase substitutes for the other.

Root records a wall timestamp, Linux boot ID, and `/proc/uptime` monotonic start
before arming recovery. Candidate availability has a 60-second boundary. An
original-cutover failure uses only the remainder of the shared 120-second
outage-to-healthy budget. Its
`nexus.promotion-recovery-attempt-timing.v1` scope is `original_cutover`.
Candidate degradation detected after availability receives a separate
`post_availability_detection` 120-second detection-to-healthy measurement
while retaining `originalCutoverStartedAt`; it cannot rewrite the original
customer-outage history. Recovery writes a root-owned
`nexus.promotion-recovery-result.v1` with predecessor-healthy time and whether
the applicable target was met. After a reboot, wall time is diagnostic because
a monotonic clock cannot span boots; the staging reboot drill remains required
before activation.

`escrow_pending` is the non-terminal retry state for the complete post-soak DR
set: predecessor rollback archive, phase-post-soak candidate recovery runtime,
and refreshed database point. A retry first re-proves the exact live candidate
and readiness, makes at most eight exact-transaction retry requests, and
automatically recovers the predecessor if the candidate is invalid or
degraded. Boot recovery does not intentionally create an outage solely for a
network-only pending state. An explicit `recover <id>` is different: it
persists the recovery decision and restores the exact predecessor even from
`escrow_pending`. The systemd unit timeout is 28 minutes, each DR attempt is
bounded to 300 seconds, and the Mac polls the durable transaction for at most
2,100 seconds. Terminal statuses are `completed`, `recovered`,
`failed_before_stop`, and `recovery_failed`; only an owner-initiated governed
retry may replace an eligible terminal client checkpoint with a freshly signed
transaction. Local rollback pruning runs as `dominguez`, never root, and only
after the exact encrypted plaintext digest is confirmed off-host.

The 30-day rollback gate accepts only an exact signed
`nexus.rollback-drill.v1` envelope. After completing the isolated dry-run
restore, database-integrity check, and authenticated health check, record their
non-secret machine result as a `nexus.rollback-drill-payload.v1` request under
the ignored release-evidence tree. The payload is an exact, bounded schema and
must bind both the restored backup SHA-256 and the retained machine-evidence
bundle SHA-256; free-form notes, logs, credentials, and unknown fields are
rejected. Request its protected signature with:

```bash
scripts/request-rollback-drill-signature.sh \
  .local/release/rollback-drill-request.json
node scripts/rollback-drill-check.mjs validate \
  --release-gate --max-age-days 30 --json
```

The request helper reuses `sign-staging-attestation.yml` as the single
protected operational signer. It binds the exact request digest and target SHA,
requires the target to be reachable from protected `main`, stops at the
existing `release-signing` approval, then validates and atomically installs the
mode-0600 result at `.local/release/rollback-drill-latest.json`. Signing an
operator-authored claim does not prove a drill happened; retain the underlying
isolated-host machine evidence and never include production rows, user content,
credentials, or raw logs in the request.

#### Cryptographically isolated first-drill staging evidence

The first rollback drill has a bootstrap dependency: normal staging requires a
fresh signed rollback drill, but rollback freshness cannot exist until the
isolated staging candidate has been installed and verified. The bounded
signer records that result without changing either ordinary recovery schema.
It first downloads and fully validates the exact production-signed
`ReleaseManifestV2` artifact named by the request. It then clones that manifest
payload into an ordinary `nexus.release-manifest.v2` envelope and clones the
validated staging request into an ordinary `nexus.staging-attestation.v1`
envelope. Both inner envelopes retain key id
`github-environment-release-signing-2026-07` but are signed only by the
dedicated drill private key. The staging payload changes only its manifest
digest, which must bind the drill-signed manifest bytes, and protected signing
provenance.

A signed `nexus.rollback-drill-staging-bundle.v1` outer record binds the raw
source-manifest, source-request, drill-manifest, and drill-attestation digests.
It carries fixed scope `isolated-kvm-first-drill` and
`promotionAllowed: false`, but it is never embedded in a promotion request.
The KVM request generator consumes only the two ordinary inner files and binds
the drill public key as its release-evidence key. The recovery verifier accepts
that pair with the drill public key. Production retains the production public
key, so both drill signatures fail cryptographically before the first
application-runtime mode/ownership mutation.

Only `NEXUS_ROLLBACK_DRILL_STAGING_PRIVATE_KEY_PEM` is a protected
`release-signing` environment secret. The public half is a reviewed non-secret
file at
`docs/release/evidence/rollback-drill-staging-public-key.pem`; signing fails
closed while that file is absent. The production release private key is not
exposed to this branch. After the future governed staging adapter has produced
the exact ordinary request, protected signing is requested with:

```bash
scripts/request-rollback-drill-staging-attestation.sh \
  .local/release/rollback-drill-staging/<sha>-<digest>.request.json \
  .local/release/manifests/<sha>.json \
  .local/release/rollback-drill-staging/<sha>-<digest>.bundle \
  --manifest-signing-run-id <exact-protected-run-id>
```

This is preparation only. `npm run release:drill-staging` currently requires
`--acknowledge-first-drill-bootstrap` and then exits with code 78 before any
remote action because ServerDominguez still has promotion control v2 and the
legacy `/home` staging layout. It must remain disabled until a separately
reviewed v2 legacy-base adapter binds those exact paths and control semantics.
It must not silently reuse the v3 `/srv` staging implementation.

The outer record is not rollback-freshness evidence and cannot authorize
production. The two inner files are ordinary recovery inputs, but their drill
signatures are invalid under the production public key. The root promotion
bridge verifies both with that production key before its first
application-runtime mode/ownership mutation. The reviewed bridge change must
be installed before any live drill; current-source authorization alone is
insufficient. After the three real KVM fault outcomes pass, use the existing
`nexus.rollback-drill.v1` protected signer to establish freshness. Converting
the resulting isolated staging state into a normal production-promotable
staging attestation is a separate future protected normalization action; this
wrapper neither implements nor implies that normalization.

Before the first owner-authorized production use, run these three drills on an
isolated staging host and retain machine evidence under the normal ignored
release-evidence path. These are required procedures, not claims that the
drills have already run:

1. **SSH loss after stop:** launch a signed staging transaction, wait until the
   isolated PM2 pair is stopped, terminate the Mac coordinator/SSH process,
   then reconnect and run
   `sudo /usr/local/sbin/nexus-release-promotion-control status <id>`.
   The server transaction must either complete or restore the exact predecessor
   without another launch and within the 120-second recovery bound.
2. **Failed candidate health:** use a staging-only candidate whose health probe
   deterministically fails. The broker must reject completion, restore the
   exact predecessor and database backup, and leave authoritative status
   `recovered`; no production evidence may be emitted.
3. **Reboot during promotion:** reboot the isolated host only after recovery
   intent exists and the predecessor is stopped. On boot,
   `nexus-release-promotion-recovery.service` must finish its blocking recovery
   before either PM2 unit starts, and the predecessor's symlink/SHA/health must
   be exact.

#### ServerDominguez KVM drill host

The reviewed KVM environment in `ops/rollback-drill-vm/OPERATIONS.txt` is the
supported production-shaped isolation boundary for those three drills when a
separate physical staging host is unavailable. It does not create another
release lane and cannot sign or authorize production evidence.

Bootstrap only from the same exact protected-main archive pattern used for the
promotion controls. The root installer validates a root-owned, non-writable
source chain, transactionally installs the fixed helpers and static systemd
template, creates a nologin `nexus-drill-vm` identity whose sole supplemental
group is `kvm`, and leaves every guest disabled and inactive:

```bash
sudo /var/lib/nexus-release-bootstrap/<sha>/source/scripts/rollback-drill-vm-systemd-install.sh \
  /var/lib/nexus-release-bootstrap/<sha>/source \
  <40-hex-protected-main-sha> \
  /var/lib/nexus-release-bootstrap/<sha>/source.tar.gz \
  <64-hex-root-side-archive-sha256>
```

The archive must use the exact `source/` Git archive prefix and Git PAX commit
comment. The installer checks that commit identity, the root-side archive
digest, and every privileged source file against its regular archive member
before syntax/unit prevalidation and any transactional commit.

Provisioning requires an owner-reviewed Canonical image SHA-256 and byte size,
one dedicated lab-only Ed25519 public key, and three unique loopback ports. It
independently verifies `SHA256SUMS.gpg` with
`/usr/share/keyrings/ubuntu-cloudimage-keyring.gpg`, requires the exact signed
`noble-server-cloudimg-amd64.img` entry to match both owner-reviewed values,
validates the qcow2, and publishes one root-owned immutable base plus three
independent overlays, cloud-init seeds, and VM identities. One newly generated
lab-only SSH host identity is scoped to that provision set and shared by its
three strictly sequential loopback endpoints; it is never a production key.
An optional unprivileged staging directory is copied through no-follow file
descriptors into root-private state before the same checks; the staged files
are never executed.

Only one guest can hold the non-waiting runtime lock. A separate admission
lock serializes guest starts with readiness collection. QEMU uses KVM, fixed
regular-file drives, `restrict=on` user networking, and exactly one
`127.0.0.1:<port>` SSH forward. The units expose no bridge, tap, shared
filesystem, host block device, public listener, serial console, monitor, or
production mount. Password and root SSH login are disabled. Use synthetic data
and lab-only SSH/promotion keys inside the guest. The provision receipt also
binds the installed QEMU executable digest, version output, owning Debian
package, package version, and architecture; the runner revalidates them before
every boot. Before a readiness receipt exists, the selected overlay must retain
its exact initial digest. After readiness v2 is published, only its exact
stopped-overlay current digest is accepted.

QEMU advertises 14,336 MiB of logical guest RAM so the unmodified production
capacity preflight can prove at least 12 GiB `MemAvailable` inside the guest.
The host cgroup bounds actual pressure with `MemoryHigh=10G`,
`MemoryMax=12G`, and `MemorySwapMax=512M`. A root preflight requires at least
25 GiB host `MemAvailable`, load-15 below 6, and no kernel OOM evidence in the
prior 24 hours; the unprivileged runner repeats the memory/load check. At the
hard physical-memory bound this preserves 13 GiB on the host, keeping the
existing 12-GiB production release floor plus a 1-GiB guard band. The logical
RAM/cgroup combination is intentionally fail-closed and must prove real
cloud-init, application, and fault-drill behavior before `drillReady` can
become true.

The static unit receives both the existing
`/run/lock/nexus-release-sonar.lock` and the root-owned single-guest lock
through named systemd file descriptors. The single-guest lock lives below a
root:nexus-drill-vm mode-0750 directory and cannot be replaced by the service
identity. The runner proves the exact descriptor names, paths, inode/device
identities, owners, groups, modes, and link counts, acquires both non-waiting
flocks, and supervises QEMU while retaining them. Installation and
provisioning also acquire the release/Sonar lock. A release, Sonar operation,
or second rollback drill guest therefore cannot overlap.

The initial provision receipt deliberately reports
`status=ssh_only_bootstrap_required` and `drillReady=false`. `restrict=on`
prevents the guest from fetching the required Node 22.23.1 and PM2 6.0.14
toolchain, and the signed release artifact supplies locked application
dependencies rather than those executables. For each guest, the first boot
collects host-key-signed Python 3.12 provenance. While that same boot remains
active, a trusted Ubuntu 24.04/x86-64 builder creates a guest-bound,
owner-signed, content-addressed bundle from clean protected `origin/main`,
pinned Node 22.23.1 release inputs, an offline PM2 6.0.14 lock closure, and the
exact promotion controls. PM2 is installed at
`/opt/nexus-rollback-drill-vm/runtime/pm2-6.0.14/bin/pm2`.

The host independently pins the lab owner public key, registers the signed
bundle, and accepts one canonical owner authorization valid for at most 24
hours. The root collector proves the live systemd/QEMU/loopback/lock identity,
installs and measures the guest without network access, verifies a fresh
challenge-bound guest host-key signature and the exact effective recovery
unit with no drop-ins, durably journals the transaction, and stops QEMU
through a nonce-bound runner handoff. The runner retains its
active and release/Sonar locks while the collector retains admission. The
collector opens the qcow2 once with `O_NOFOLLOW`, rejects any other process or
mapping holding that inode, hashes that same descriptor, and checks device,
inode, size, mtime, and ctime before and after the full hash. Only the resulting
immutable `nexus.rollback-drill-vm-runtime-readiness.v2` receipt can set
`drillReady=true`.

The old caller-supplied guest-attestation path is absent. A collector or host
restart can resume only from the root-owned journal and must reacquire all
locks and re-prove the stopped overlay. A crash after receipt publication must
finish validating and promoting the journal-bound evidence before removing the
handoff request. SSH readiness alone is not promotion
readiness; do not enable guest egress or copy production data to close this
gate. The exact commands and authorization schema are in
`ops/rollback-drill-vm/OPERATIONS.txt`.

The real evidence bundle requires the exact `execution.json` receipt in
addition to all three outcomes. Each outcome binds the receipt digest and
repeats its strictly-sequential mode and `testMode=false` identity; the receipt
binds their ordered payload digests. Collection and verification reject a
missing, substituted, reordered, or test-mode receipt before rollback freshness
evidence can be produced.

The installer and provisioner do not start a guest. Starting an explicit slot
remains a separate owner-observed drill action:

```bash
sudo systemctl start nexus-rollback-drill-vm@guest-1.service
```

An install/provision journal, occupied port, unsafe path/mode, changed signed
digest, ambiguous existing state, missing KVM device, or second active guest
fails closed. A leftover journal after host interruption requires root
inspection. Do not remove it merely to make a unit start. Repository tests and
a successful VM boot are not fault-drill evidence: retain the three actual
machine results and pass only the bounded request through the existing
protected rollback-drill signer.

### Ten-release measurement and shadow readiness

Evaluate the success window from exactly ten chronological, terminal root
promotion transactions. Do not hand-author the ten release records. The
root-side collector selects the latest ten terminal transactions, discovers
their uniquely matching signed manifests and staging attestations, and emits the governed
`nexus.release-plan-observation-window.v2` schema. It also requires the
immediately preceding ten root journals. Collection and evaluation fail closed
on missing or ambiguous evidence, unknown fields, malformed identity,
contradictory promotion/recovery state, copied promotion evidence, or a
recomputed digest:

- `baseline` contains only `releaseCount: 10`; failed-promotion counts are
  derived from the preceding root journals and cannot be supplied by an
  operator.
- `qualityEvidence` references one
  `nexus.release-quality-evidence.v1` envelope signed by the existing protected
  release-evidence key. Its redacted payload binds the exact preceding and
  current transaction IDs, root-journal digests, runtime SHAs, completion
  timestamps, per-release escaped-defect counts, and SHA-256 issue-set
  commitments to the fixed Sentry query
  `escaped-release-defects-by-release-v1`. Raw issue IDs and issue content do
  not belong in this evidence.
- Each of the ten `releases` contains its package `releaseId`, canonical UTC
  `completedAt`, evidence/manifest/staging/production SHA and digest identity,
  automated-readiness timestamps, the exact ordered automated stages
  `protected_main_ci`, `release_candidate`, `protected_signing`,
  `staging_validation`, and `promotion`, ordered handoffs with a nullable
  governed `approvalKind`, cutover/outage/soak timestamps, promotion outcome and
  rollback evidence, an integer escaped-defect count, and SHA-256 references to
  the signed manifest, signed staging attestation, signed protected timing
  envelope, root staging evidence, root promotion request, root promotion
  journal, and root sealed result. Stage intervals must be positive,
  sequential, non-overlapping, and disjoint from handoff waits.
- Transaction identity is the v2 uniqueness key. A package version may repeat
  for a retry only when the root transaction ID and transaction-bound evidence
  are distinct. A repeated transaction ID or copied transaction evidence fails
  closed. Legacy v1 observations lack that transaction authority and therefore
  conservatively retain unique-`releaseId` validation.
- A passed candidate requires production identity and the completed soak; a
  recovered candidate requires matching rollback and restored-availability
  timestamps; a pre-stop failure has no cutover; failed recovery is explicit.
  The collector refuses a failed-recovery record when no sealed healthy
  endpoint exists instead of inventing one.

#### Protected Sentry quality evidence

Quality collection is advisory and never runs from CI, RC, signing, staging,
or promotion automatically. Configure only the existing GitHub
`release-signing` environment:

- secret `NEXUS_SENTRY_QUALITY_READ_TOKEN`: a read-only Sentry
  internal-integration token limited to `project:read` for exact organization
  release identity and `event:read` for issue aggregation;
- variable `NEXUS_SENTRY_ORGANIZATION`: the lowercase organization slug;
- variable `NEXUS_SENTRY_PROJECT_IDS`: a comma-separated allowlist of numeric
  production project IDs;
- variable `NEXUS_SENTRY_API_BASE_URL`: the organization region origin, such
  as `https://us.sentry.io` (an empty value uses `https://sentry.io`).

The token is never a workflow input, CLI argument, artifact, or log value.
Before counting issues for any successful runtime SHA, the protected job calls
Sentry's exact organization release endpoint and requires the response version
to equal that SHA and its project membership to include every configured
production project ID. A 404, malformed or mismatched release response, or
missing project binding fails closed and produces no signed zero-defect claim.
Release metadata and issue response bodies remain in memory; the job uploads
only the existing signed aggregate schema. It never runs tests for this
purpose.

After at least 20 terminal root promotion journals exist and the latest one is
at least 24 hours old, create a fresh request on ServerDominguez from the
reviewed, root-owned evaluator tree:

```bash
sudo install -d -o root -g root -m 0700 \
  /var/lib/nexus-release-observations/quality

sudo /usr/bin/node \
  /opt/nexus-release-evaluator/current/scripts/release-quality-evidence.mjs \
  build-server-request \
  --source-root /opt/nexus-release-evaluator/current \
  --promotion-evidence-root /var/lib/nexus-release-promotion \
  --request-id <lowercase-uuid> \
  --server-private-key /etc/nexus-release/serverdominguez-provenance-private-key.pem \
  --output /var/lib/nexus-release-observations/quality/<lowercase-uuid>.server-request.json
```

Request creation reads exactly the latest 20 chronological terminal journals,
uses the first 10 as baseline and the last 10 as current, and fails while
`active.json` exists. A completed production release is observed from its root
journal completion until the next completed production release; intervening
failed or recovered attempts do not shorten that deployed release's exposure.
A non-production outcome has an empty interval and a governed zero/empty-set
commitment. The current successful release ends at the request's fixed
`observedThrough` cutoff. Sentry is queried sequentially with exact
`release:<runtime-sha>`, `production`, project allowlist, start, and end
filters. Only unique issue groups whose `firstSeen` falls in the half-open
`[start,end)` interval count as escaped defects.

Copy the non-secret server request and server public key to the Mac, then run
the requester from an exact protected-main checkout:

```bash
mkdir -p .local/release/quality
chmod 700 .local/release/quality

scripts/request-release-quality-evidence.sh \
  /absolute/path/server-request.json \
  /absolute/path/serverdominguez-provenance-public-key.pem \
  .local/release/quality/release-quality.json \
  --server ServerDominguez
```

The requester validates the server signature, holds the existing
`/run/lock/nexus-release-sonar.lock` for the whole protected approval, query,
sign, and download cycle, and refuses local or remote release locks. The
existing `sign-staging-attestation.yml` job also rejects known queued or active
release workflows both before and after collection. No new workflow, job,
matrix, scheduler, or release lane is created. The root request expires after
15 minutes; create a fresh request rather than extending or editing it.

Copy the resulting mode-0600 `release-quality.json` into the signed
observation evidence root. The observation collector then verifies its
protected release-evidence signature and exact 10+10 journal bindings.
Provider outage, pagination overflow, malformed issue identity, missing
configuration, active release state, or a query/signature mismatch remains
`MANUAL_REQUIRED`; never substitute an operator count.

Run the collector and evaluator on ServerDominguez, not against promotion files
copied to the Mac. `--evidence-root` contains the signed manifest, staging, and
protected Sentry evidence files; every reference is relative, non-symlinked,
and digest checked. Promotion references must be the canonical
`transactions/<transaction-id>/state/{journal.json,result.env,recovery-result.json}`
paths below the original root-owned state directory. The evaluator verifies
root UID, non-writable modes, and every path component, so this command needs
read-only root access:

Run only a reviewed protected-main evaluator tree whose files and parent
directories are root-owned and non-writable by the application account; never
run a user-writable checkout as root. For example:

```bash
sudo /usr/bin/node \
  /opt/nexus-release-evaluator/current/scripts/release-plan-evaluator.mjs \
  collect-observation \
  --quality-evidence quality/release-quality.json \
  --evidence-root /var/lib/nexus-release-observations/signed \
  --promotion-evidence-root /var/lib/nexus-release-promotion \
  --output /var/lib/nexus-release-observations/observation-window.json

sudo /usr/bin/node \
  /opt/nexus-release-evaluator/current/scripts/release-plan-evaluator.mjs evaluate \
  --input /var/lib/nexus-release-observations/observation-window.json \
  --evidence-root /var/lib/nexus-release-observations/signed \
  --promotion-evidence-root /var/lib/nexus-release-promotion \
  --output /var/lib/nexus-release-observations/observation-evaluation.json
```

The result reports R-7 median/p50 and p95 for the exact protected-main-CI-start
to RC-completion readiness interval and separately for every canonical CI, RC,
signing, staging, and promotion stage. It sums unattended transitions within
each release, excludes explicit approval waits, and computes p50/p95 over the
ten per-release totals. Approval time remains separately reported as excluded
time. It also reports actual service unavailability separately from total
cutover and the successful-promotion soak.
The promotion-stage duration ends at the root journal's terminal completion, so
it includes the soak, post-soak DR network escrow, and the required
before/after-escrow authenticated/PM2 checks; it is never presented as customer
unavailability. Actual unavailability and original-cutover recovery KPIs use
the root monotonic integer measurements. Wall timestamps must match those
measurements within one second and remain exact provenance bindings, but are
not substituted for the monotonic KPI.
When exact protected-main evidence exists, the protected manifest signer
fetches the protected-main, RC, and current signing run identities from GitHub.
Alongside the manifest it writes
`timing/<runtime-sha>.json`, a
`nexus.release-protected-timing.v1` envelope signed by the existing release
evidence key. It binds the manifest digest, repository, SHA, run IDs and
attempts, GitHub job starts, evidence completion instants, and signing instant.
The manifest requester installs that file mode 0600 beside the manifest and
refuses a conflicting existing copy. Missing protected-main evidence does not
block manifest signing or release acceptance; it omits this advisory envelope,
and the affected v2 timing window cannot be collected.

Root state contributes
`staging/<request-id>.evidence.json`,
`requests/<transaction-id>.json`, the promotion journal, and the sealed result.
The staging attestation signature also binds the protected staging-signing run
and signing instant. Root `publishedAt` proves installation/readiness completed.
The request's `verifiedAt` is created locally only after the richer
authenticated/domain smoke and is signed with its log digest, but it is
chronology evidence rather than the metric boundary. The protected workflow
fetches its exact current GitHub run through `actions:read`, pins protected
tooling to the dispatch SHA, validates the run/request identity, and binds the
run's independently sourced raw `created_at` as
`protectedSigning.requestedAt`. That raw value remains the authoritative end of
staging validation and start of the staging-signing approval wait. The collector
requires `publishedAt <= verifiedAt <= signedAt`, `requestedAt <= signedAt`, and
`requestedAt >= verifiedAt - 5 seconds`; it never rewrites the timestamp.
Automated readiness is independent of this staging boundary: it starts at exact
protected-main CI `startedAt` and ends at exact RC `completedAt` from the signed
protected timing envelope. All five stage intervals and six transition waits
remain separately derived from governed evidence.
It marks `release-signing` and `production-owner` waits as explicit approvals
and excludes them from the unattended-delay KPI. The other transitions remain
unattended and must not overlap stage execution. The canonical promotion
request digest must equal the digest sealed by the root journal.

The v2 collector never fills a missing start with an adjacent completion or a
one-millisecond placeholder. If any signed timing envelope, root staging file,
root request, or protected staging-signing identity is missing, v2 collection
fails. A valid older staging attestation whose protected-signing identity lacks
`requestedAt` remains readable and does not invalidate release acceptance, but
its staging duration and affected handoffs are `MANUAL_REQUIRED`; authoritative
CI-to-RC readiness remains evaluable when signed protected timing exists. Its
locally supplied `verifiedAt` is never promoted into an authoritative staging
endpoint. Existing v1 operator windows remain readable
only for backward compatibility; each timing phase without independent
authority remains `MANUAL_REQUIRED`, with no p50 or p95 computed from it. Root
state additionally binds promotion outcome, transaction/Sentry identity,
cutover/recovery timestamps, and the explicit soak start, completion, and
observed monotonic duration. A duration-only soak also returns
`MANUAL_REQUIRED`; both root-recorded endpoints are required.

The protected Sentry envelope is an explicit authority input, not a locally
trusted counter. If no protected process can query Sentry, bind the exact
transaction windows, and sign the redacted aggregate, do not fabricate or
locally sign it: collection remains blocked and the legacy v1 evaluation
continues to report both quality comparisons as `MANUAL_REQUIRED`.

For each successful release, the Mac coordinator also writes a private
mode-0600 `nexus.production-promotion-evidence.v1` proof and
`release-sequence.mjs` revalidates it before advancing or resuming. It binds the
runtime, artifact, installed-runtime, and recovery-runtime digests; signed
manifest and staging-attestation digests; rollback encrypted identity and
exact AWS VersionId or approved R2 variance; both phase-specific candidate
recovery objects; both database encrypted identities; before/after readiness;
and the promotion timeline. Its `completedAt` equals the after-escrow readiness
timestamp. This is coordinator proof copied from exact fetched root results,
not canonical root authority.

The ten-release evaluator currently reads only the root `journal.json` and the
outcome-specific `result.env` or `recovery-result.json`. It does not yet consume
`preflight-current-recovery.json`, `escrow-confirmation.json`,
`recovery-attempt-timing.json`, or the rich Mac proof. Therefore its threshold
result proves runtime/artifact/installed-tree parity and original-cutover
timing, but does not independently authorize the two DR object identities or a
`post_availability_detection` recovery scope. Those remain separately
fail-closed per-release checks and `MANUAL_REQUIRED` for a root-authoritative
ten-release aggregate until the evaluator contract is explicitly extended.

Threshold evaluation covers the p50 of the exact protected-main-CI-start to
RC-completion interval (at most 9 minutes), p50 of the ten per-release
unattended-transition sums (at most 1 minute, approvals excluded), 120-second
rollback recovery, the full 60-second soak, exact SHA/artifact/installed-tree
parity, and no increase over the preceding ten authoritative promotions in
failed promotions or escaped defects. The evaluator emits
`nexus.release-plan-evaluation.v2` and accepts the legacy
`nexus.release-plan-observation-window.v1` schema for existing evidence, but
ignores its operator-authored failed-promotion and defect counters; those
metrics remain `MANUAL_REQUIRED`. Only v2 with the exact root baseline and
signed Sentry aggregate makes them machine-evaluable.
No observed rollback also produces `MANUAL_REQUIRED`; absence of failure is not
recovery evidence. With the current evidence schemas the ten-release declaration
therefore cannot return `PASS` solely from the observation JSON. Exit status is
0 for `PASS`, 2 for `FAIL`, 3 for `MANUAL_REQUIRED`, and 1 for malformed input.
Original-cutover rollback recovery is measured end to end from observed service
unavailability until the predecessor is healthy; trigger-to-healthy timing is
reported separately and cannot hide delayed rollback initiation. A
post-availability recovery retains that original history and uses its distinct
detection-to-healthy scope; the current evaluator does not aggregate that scope.

Five shadow comparisons use a separate strictly consecutive production ledger:

```bash
npm run release:shadow:readiness -- --input .local/release/shadow-ledger.json \
  --output .local/release/shadow-readiness.json
```

The advisory ledger must contain exactly five full
`nexus.release-evidence-shadow-comparison.v1` records with consecutive sequence
numbers, unique release IDs and runtime SHAs because this operator-readable v1
ledger lacks authoritative root transaction identity. It also requires canonical
comparison/completion timestamps and independently recorded production runtime
SHA and manifest SHA-256 for each release. The comparison runtime SHA must match
that production identity exactly. Even five exact matches in this
operator-readable ledger
return `MANUAL_REQUIRED`, `activationAllowed: false`, and
`independent_github_provenance_required`. The local evaluator is deliberately
non-authorizing.

Activation uses the existing root evaluator, protected operational signer, RC
workflow, and manifest signer. It adds no workflow, job, matrix, release lane,
scheduler, or worker:

1. The reviewed promotion-control bootstrap generates a ServerDominguez-only
   Ed25519 private key at
   `/etc/nexus-release/serverdominguez-provenance-private-key.pem` (root:root 0600) and its public key beside it (0644). Configure that exact public key as
   the `release-signing` environment secret
   `NEXUS_SERVERDOMINGUEZ_PROVENANCE_PUBLIC_KEY_PEM`. Never copy the private key
   from the server.
2. After five eligible production comparisons exist, run the reviewed,
   root-owned collector on ServerDominguez. It emits the separate
   `nexus.release-plan-activation-window.v1` contract from exactly the latest
   five completed root-owned promotions. Activation therefore does not require
   an unrelated ten-release KPI window, but it still requires all five signed
   manifest/staging/GitHub comparison bindings. The activation records omit
   escaped-defect counters because quality comparison belongs only to the
   separately authorized ten-release observation contract:

   ```bash
   sudo /usr/bin/node \
     /opt/nexus-release-evaluator/current/scripts/release-plan-evaluator.mjs \
     collect-activation \
     --evidence-root /var/lib/nexus-release-observations/signed \
     --promotion-evidence-root /var/lib/nexus-release-promotion \
     --output /var/lib/nexus-release-observations/activation-window.json

   sudo /usr/bin/node \
     /opt/nexus-release-evaluator/current/scripts/release-plan-evaluator.mjs \
     activation-request \
     --input /var/lib/nexus-release-observations/activation-window.json \
     --evidence-root /var/lib/nexus-release-observations/signed \
     --promotion-evidence-root /var/lib/nexus-release-promotion \
     --request-id <lowercase-uuid> \
     --server-private-key /etc/nexus-release/serverdominguez-provenance-private-key.pem \
     --output /var/lib/nexus-release-observations/protected-main-reuse-request.json
   ```

   The activation collector keys these entries by distinct root promotion
   transaction IDs, not package version. A `releaseId` may repeat for a retry
   only when its transaction ID, journal digest, and transaction-bound evidence
   are distinct; duplicate transaction authority fails closed.

   Each entry binds its signed manifest, signed staging attestation, root
   journal/result, protected-main run, RC run, SHA, artifact, installed tree,
   and comparison digest. The root-signed request expires after 15 minutes so
   it cannot be replayed after the latest production sequence changes; generate
   a fresh request if protected approval is not completed in that window.

3. Dispatch `sign-staging-attestation.yml` on protected `main` with
   `evidence_kind=protected_main_reuse_activation`, the same request UUID and
   fifth runtime SHA, plus canonical request base64 and SHA-256. The existing
   `release-signing` job verifies the ServerDominguez signature, independently
   fetches all five protected-main CI and all five RC run/artifact identities,
   and emits a GitHub-signed activation envelope.
4. Supply the private envelope path through the coordinator's
   `--protected-reuse-activation` option. The coordinator snapshots and binds
   the exact bytes before RC intent and forwards their canonical base64 through
   the existing `protected_reuse_activation_b64` input. The test-plan job
   revalidates it and the current exact protected-main evidence. It may skip
   the existing RC Vitest jobs only for a later SHA, only while the activation
   is unexpired, and only when policy/workflow digest, lockfiles, toolchains,
   selected-file coverage, required jobs, and exact runtime bundle agree.
   Python and the remaining release gates still run. The protected manifest
   signer independently fetches the current protected-main run/artifacts and
   repeats validation.

Any missing, invalid, ambiguous, policy-drifted, or expired input, an explicit
`force_full`, or an attempt to reuse one of the five shadow-window SHAs leaves
`reuse_allowed=false` and runs the existing RC Vitest fallback. An unsigned
operator ledger or locally generated JSON can never activate reuse. No
activation envelope is created by implementation itself; with the currently
available one eligible production comparison, the path remains shadow-only at
1/5.

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
   one active persisted owner in a non-global, all-slices write cohort; escrow
   the exact candidate recovery runtime under the transaction-bound
   `phase-pre-mutation` key plus a fresh database point; copy and hash the
   immutable runtime backup; drain writes once, checkpoint SQLite, append and
   verify the database snapshot; automatically validate the final migration
   rehearsal against identities already bound in the signed request; switch
   PM2 atomically; measure customer availability; run the one 60-second
   post-candidate stability soak; verify candidate readiness; then escrow the
   exact rollback archive, a newly encrypted `phase-post-soak` candidate
   recovery object with the same runtime identity but a distinct key/ciphertext,
   and a refreshed database point; finally verify candidate readiness again.
   Network escrow does not intentionally stop service or wait on the Mac, but
   detected degradation during escrow triggers automatic predecessor recovery
   under the post-availability timing scope.
8. Restore the exact previous release automatically if readiness fails. Before
   touching production data, revalidate the recorded archive path, byte size,
   whole-archive SHA-256, and stopped-state database SHA-256. Extraction rejects
   traversal, duplicate paths, links, devices, and unsupported archive entries;
   the root-installed attestor separately re-proves predecessor runtime bytes.

Do not rebuild, rsync the repository, or install dependencies while production
is stopped. Promotion copies the already prepared staging release and verifies
every governed artifact byte. Repository-sync deployment wrappers were retired
after two staging rehearsals and two owner-authorized production releases.
Emergency `rollback.sh` and `restore.sh` paths remain available.

Backend and iOS are independently promotable unless a shared contract or native
integration changed. Build 57 is available to both TestFlight groups; its
physical-device smoke remains open, and builds 54 through 56 remain active.
