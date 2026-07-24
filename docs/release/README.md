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

The observed planning baseline is approximately 12m25s for protected-main CI
plus RC and a median 7m15s avoidable operator handoff. The activation target is
automated readiness in at most 9 minutes and unattended phase-transition delay
in at most 1 minute, excluding explicit owner approval. Record per-stage p50
and p95 for ten releases; do not reinterpret the mandatory 60-second soak as
service unavailability.

Keep the existing CI jobs and four Vitest shards. Do not add another matrix,
custom shard scheduler, competing release lane, background release worker, or
parallel Sonar/release execution. The resumable release coordinator is one
sequential command and one checkpoint: it verifies exact source and RC
identity, requests protected signing, validates staging, stops for explicit
production-owner approval, submits one root-owned server transaction, and
polls its journal. It never approves a protected environment or migration.
Restarting the coordinator revalidates completed evidence instead of blindly
repeating the phase.

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
archive with `--no-same-owner --no-same-permissions`, and then run:

```bash
sudo /var/lib/nexus-release-bootstrap/<exact-sha>/source/scripts/remote-promotion-systemd-install.sh \
  /var/lib/nexus-release-bootstrap/<exact-sha>/source \
  /var/lib/nexus-release-bootstrap/<exact-sha>/nexus-owner-promotion-public-key.pem
sudo /usr/local/sbin/nexus-release-promotion-control version
sudo systemd-tmpfiles --create /etc/tmpfiles.d/nexus-release-sonar-lock.conf
sudo stat -c '%U:%G:%a %n' /run/lock/nexus-release-sonar.lock
```

The installer independently rejects any source, key, or ancestor directory
that is not canonical, root-owned, and non-writable by group/other. A
pre-copy digest check against the `/home` input is not sufficient because the
application identity can change that file between checking and privileged
use. It also writes
`/var/lib/nexus-release-promotion/bootstrap-in-progress.v1` before replacing
the DR/control compatibility set. While that marker exists, promotion commands
and units fail closed and the sudo contract is withheld; rerun the same
reviewed bootstrap to finish and clear it.

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
sudo systemctl enable --now nexus-application-dr-backup.timer
```

Do not launch a release until the exact `--verify-config` command passes and
one owner-observed backup run has verified its database and release objects
off-host. The root promotion broker repeats this exact check before it can arm
recovery or stop PM2, so missing or older DR provisioning ends only as
`failed_before_stop`.

The expected control version is `nexus-release-promotion-control.v2`; the lock
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

Evaluate the success window from exactly ten chronological production journal
records. The evaluator is deterministic, accepts only the governed
`nexus.release-plan-observation-window.v1` schema, and fails closed on unknown
fields, malformed identity, contradictory promotion/recovery state, copied
promotion evidence, or a recomputed operator-owned digest:

- `baseline` contains `releaseCount: 10`, `failedPromotions`, and
  `escapedReleaseDefects` for the preceding comparison window.
- Each of the ten `releases` contains a unique `releaseId`, canonical UTC
  `completedAt`, evidence/manifest/staging/production SHA and digest identity,
  automated-readiness timestamps, the exact ordered automated stages
  `protected_main_ci`, `release_candidate`, `protected_signing`,
  `staging_validation`, and `promotion`, ordered handoffs with a nullable
  governed `approvalKind`, cutover/outage/soak timestamps, promotion outcome and
  rollback evidence, an integer escaped-defect count, and SHA-256 references to
  the signed manifest, signed staging attestation, root promotion journal, and
  root sealed result. Stage intervals must be positive, sequential,
  non-overlapping, and disjoint from handoff waits.
- A passed candidate requires production identity and the completed soak; a
  recovered candidate requires matching rollback and restored-availability
  timestamps; a pre-stop failure has no cutover; failed recovery is explicit.

Run the evaluator on ServerDominguez, not against promotion files copied to the
Mac. `--evidence-root` contains the signed manifest/staging files and every
reference is relative, non-symlinked, and digest checked. Promotion references
must be the canonical
`transactions/<transaction-id>/state/{journal.json,result.env,recovery-result.json}`
paths below the original root-owned state directory. The evaluator verifies
root UID, non-writable modes, and every path component, so this command needs
read-only root access:

Run only a reviewed protected-main evaluator tree whose files and parent
directories are root-owned and non-writable by the application account; never
run a user-writable checkout as root. For example:

```bash
sudo /usr/bin/node \
  /opt/nexus-release-evaluator/current/scripts/release-plan-evaluator.mjs evaluate \
  --input /var/lib/nexus-release-observations/observation-window.json \
  --evidence-root /var/lib/nexus-release-observations/signed \
  --promotion-evidence-root /var/lib/nexus-release-promotion \
  --output /var/lib/nexus-release-observations/observation-evaluation.json
```

The result reports R-7 median/p50 and p95 for overall automated readiness and
for each canonical CI, RC, signing, staging, and promotion stage across all ten
records. It reports unattended phase-transition delay while keeping explicit
approval time as a separately excluded quantity. It also reports actual service
unavailability separately from total cutover and the successful-promotion soak.
The promotion-stage duration ends at the root journal's terminal completion, so
it includes the soak, post-soak DR network escrow, and the required
before/after-escrow authenticated/PM2 checks; it is never presented as customer
unavailability. Actual unavailability and original-cutover recovery KPIs use
the root monotonic integer measurements. Wall timestamps must match those
measurements within one second and remain exact provenance bindings, but are
not substituted for the monotonic KPI.
Signed evidence binds protected-main completion, RC completion, manifest
generation/signing completion, and staging verification. Root state binds the
promotion outcome, transaction/Sentry identity, cutover/recovery timestamps,
and the explicit soak start, completion, and observed monotonic duration. A local observation may
not supply a trusted start time or handoff simply by containing a timestamp.
Missing authoritative starts/handoffs return `MANUAL_REQUIRED`, with no p50 or
p95 computed from those fields. A duration-only soak also returns
`MANUAL_REQUIRED`; both root-recorded endpoints are required.

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

Threshold evaluation covers the
9-minute readiness median, 1-minute unattended handoff median, 120-second
rollback recovery, the full 60-second soak, exact SHA/artifact/installed-tree
parity, and no increase over the supplied ten-release baseline in failed
promotions or escaped defects. Operator-authored baseline counts and escaped
defect totals are never sufficient for `PASS`; they remain `MANUAL_REQUIRED`
until independently bound baseline journal and Sentry issue evidence are added.
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
numbers, unique release IDs and runtime SHAs, canonical comparison/completion
timestamps, and independently recorded production runtime SHA and manifest
SHA-256 for each release. The comparison runtime SHA must match that production
identity exactly. Even five exact matches in this operator-readable ledger
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
   root-owned evaluator on ServerDominguez. It validates the complete ten-record
   observation window, takes only its last five successful exact agreements,
   and requires those transaction IDs to be the latest five completed
   root-owned promotion journals:

   ```bash
   sudo /usr/bin/node \
     /opt/nexus-release-evaluator/current/scripts/release-plan-evaluator.mjs \
     activation-request \
     --input /var/lib/nexus-release-observations/observation-window.json \
     --evidence-root /var/lib/nexus-release-observations/signed \
     --promotion-evidence-root /var/lib/nexus-release-promotion \
     --request-id <lowercase-uuid> \
     --server-private-key /etc/nexus-release/serverdominguez-provenance-private-key.pem \
     --output /var/lib/nexus-release-observations/protected-main-reuse-request.json
   ```

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
4. Supply that envelope as canonical base64 in the existing RC input
   `protected_reuse_activation_b64`. The test-plan job revalidates it and the
   current exact protected-main evidence. It may skip the existing RC Vitest
   jobs only for a later SHA, only while the activation is unexpired, and only
   when policy/workflow digest, lockfiles, toolchains, selected-file coverage,
   required jobs, and exact runtime bundle agree. Python and the remaining
   release gates still run. The protected manifest signer independently fetches
   the current protected-main run/artifacts and repeats validation.

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
