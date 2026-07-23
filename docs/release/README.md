# Release Runbook

Status: canonical
Owner: Felipe
Last verified: 2026-07-22

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
the root-owned one-shot ServerDominguez collector, recursively backed by
mode-0600 raw same-boot samples and exact-window SQLite `api_usage`
provider/model counts. Missing collector provenance or request persistence
fails closed.
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

Customer availability is measured as soon as the exact candidate passes local,
public, PM2/current, and Sentry-SHA identity checks. The transaction then runs
exactly one 60-second post-candidate stability soak while customers are already
served. Encrypted rollback escrow and documentation closeout happen after
availability and cannot extend the measured outage.

### One-time promotion control-plane bootstrap

The owner Ed25519 private key stays off ServerDominguez, mode 0600 on the
owner's Mac. Copy only its public key to a temporary root-readable path on the
server, use a clean reviewed `origin/main` backend checkout, and run:

```bash
sudo scripts/remote-promotion-systemd-install.sh \
  /absolute/path/to/reviewed/cortex-telegram-hub-bot \
  /absolute/path/to/nexus-owner-promotion-public-key.pem
sudo /usr/local/sbin/nexus-release-promotion-control version
sudo systemd-tmpfiles --create /etc/tmpfiles.d/nexus-release-sonar-lock.conf
sudo stat -c '%U:%G:%a %n' /run/lock/nexus-release-sonar.lock
```

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
owner-signed request binds both the predecessor and candidate artifact and
installed-runtime digests.

Before sealing runtimes, arming recovery, or allowing the worker to reach PM2,
the root broker runs the installed application-DR tool's bounded
`--verify-config` check. Missing tooling, an unsafe or invalid root-only config,
or incomplete local encryption/backup prerequisites terminates the journal as
`failed_before_stop`; the existing post-soak upload still provides the
authoritative exact rollback-escrow confirmation.

Root records a wall timestamp, Linux boot ID, and `/proc/uptime` monotonic start
before arming recovery. Candidate availability has a 60-second boundary; a
failure uses only the remainder of the 120-second outage-to-healthy budget for
automatic predecessor recovery. Success evidence records cutover start, actual
service-unavailability start, candidate-available time, and measured duration.
Recovery writes a root-owned `nexus.promotion-recovery-result.v1` record with
predecessor-healthy time and whether the 120-second target was met. After a
reboot, wall time is retained as a diagnostic because a monotonic clock cannot
span boots; the staging reboot drill remains required before activation.

`escrow_pending` means the exact candidate is healthy but encrypted off-host
rollback upload still needs retry. Boot recovery does not create an outage for
that network-only state. An explicit `recover <id>` is different: it persists
the recovery decision and restores the exact predecessor even from
`escrow_pending`. Local rollback pruning runs as `dominguez`, never root, and
only after the exact encrypted plaintext digest is confirmed off-host.

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
it includes the soak plus required post-soak authenticated/PM2 checks; it is
never presented as customer unavailability. Actual unavailability and recovery
KPIs use the root monotonic integer measurements. Wall timestamps must match
those measurements within one second and remain exact provenance bindings, but
are not substituted for the monotonic KPI.
Signed evidence binds protected-main completion, RC completion, manifest
generation/signing completion, and staging verification. Root state binds the
promotion outcome, transaction/Sentry identity, cutover/recovery timestamps,
and the explicit soak start, completion, and observed monotonic duration. A local observation may
not supply a trusted start time or handoff simply by containing a timestamp.
Missing authoritative starts/handoffs return `MANUAL_REQUIRED`, with no p50 or
p95 computed from those fields. A duration-only soak also returns
`MANUAL_REQUIRED`; both root-recorded endpoints are required.

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
Rollback recovery is measured end to end from observed service unavailability
until the predecessor is healthy; trigger-to-healthy timing is reported as a
separate diagnostic and cannot hide delayed rollback initiation.

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
   `/etc/nexus-release/serverdominguez-provenance-private-key.pem` (root:root
   0600) and its public key beside it (0644). Configure that exact public key as
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
   one active persisted owner in a non-global, all-slices write cohort; copy and
   hash the immutable runtime backup; drain writes once, checkpoint SQLite,
   append and verify the database snapshot; automatically validate the final
   migration rehearsal against identities already bound in the signed request;
   switch PM2 atomically; measure customer availability; run the one 60-second
   post-candidate stability soak; then escrow the exact rollback digest off-host
   while the candidate remains available. Network escrow never creates a
   second outage or waits on the Mac.
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
