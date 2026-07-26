# Release Runbook

Status: canonical
Owner: Felipe
Last verified: 2026-07-25

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

The resumable coordinator is the only primary production-release command:

```bash
npm run release:resume -- --backend-only

# Only after the coordinator has persisted its explicit owner stop:
NEXUS_RELEASE_OWNER_AUTHORIZED=1 \
  npm run release:resume -- --owner-authorized --promote
```

For a release that changes a shared backend/iOS contract, use
`npm run release:resume -- --includes-ios` for the first invocation, then
provide the two exact signed iOS attestations when the coordinator requests
them. RC creation and protected signing fail closed when the scope or evidence
is omitted, contradictory, or incomplete. Tag pushes do not infer contract
scope or create RC evidence.

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

The coordinator dispatches and binds the exact RC artifact before requesting
protected signing; it does not call `release:prepare`. The legacy
`release:prepare` command remains a manual diagnostic/fallback only. It repeats
the local release gate, production build, bundle, and unsigned-payload work and
must not precede a normal coordinated release. The RC workflow contains no
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
path first invokes the root-installed promotion control v4 verifier. Before
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
continues to own typecheck and build correctness. The unsigned-candidate job
also performs one production `npm run build`, whose first command is the same
default-project `tsc` compilation; a retained workflow-contract test binds
that equivalence and prevents a separate `tsc --noEmit` pass from returning.

The same sequential lane removes post-test duplication without weakening its
verdict. When exact protected-main reuse is active, the RC job verifies and
uses that signed Ubuntu bundle, safely extracts its locked Node dependency
archive, and skips both network `npm ci` and rebuild. Otherwise it keeps the
normal clean install and production build. Release build, content-engine test,
and nightly Python are pinned to 3.12.3 because the governed production
interpreter is `/usr/bin/python3.12` at exactly that patch and the
network-independent installer rejects patch drift. The release-test image uses a
pinned Buildx cache only as an acceleration hint; Buildx setup failure falls
back once to the ordinary Docker build, while an actual image-build failure is
reported immediately instead of redundantly retrying the same invalid input.
This image is only a pinned Debian 12
sandbox compatibility check: it smokes the compiled tree with dependencies
freshly installed from the lockfile and Python requirements, and a cold cache
may contact the registries. It is never Ubuntu artifact ABI evidence. The exact
archived dependency payload remains governed by its lock/digests, the
network-independent staging install, installed-tree attestation, and runtime
smoke. The sandbox contract does not repeat typecheck, build, migration, the
full/selected Vitest suite, or pytest; it retains one focused
notification/decision fixture as the container-specific release invariant. The
deterministic Node archive uses gzip level 6 because representative measurement
saved about six seconds for roughly one MiB of additional transfer; its bytes
remain part of the signed artifact identity.

Staging also remains serial. Under both staging and global release locks,
`rsync --checksum --copy-dest` finds unchanged predecessor bytes even when
artifact mtimes differ, then copies them into the new release without shared
inodes; the complete bundle and installed tree are still rehashed afterward.
The smoke gate reuses one private, short-lived SSH control socket and one
coherent response per repeated endpoint while retaining every field assertion.
Its domain classifier uses the base SHA from the already validated signed RC
selection, not an empty `origin/main..main` diff, and all database checks
resolve the exact supplied staging directory. No cache, transport socket,
predecessor copy, or classifier result can bypass the existing staging
attestation.

### Sequential optimization activation ledger

Apply release-speed changes in this order and measure their individual stage
durations in the same ten-release window:

1. The RC planner inspects recent successful nightly artifacts newest first
   and stops downloading as soon as the canonical validator finds one fresh,
   same-policy ancestor. The final planner revalidates that file; no candidate
   still means the full-suite fallback.
2. CI and RC `npm ci` retain lockfile and integrity enforcement, prefer the
   setup-node cache, and omit the non-gating audit and funding network calls.
   The exact-SHA security workflow remains the dependency-audit authority.
   Both Python requirement files key the pytest cache, and the artifact job
   separately restores the production-requirements wheel cache.
3. Activate exact protected-main test and artifact reuse only after the five
   signed shadow agreements. Until then, retain one RC execution and use the
   container, compression, staging-transfer, and smoke-I/O reductions above.
4. Report the selected Buildx/fallback path, nightly candidates considered,
   bundle compression time and size, rsync transfer statistics, and smoke
   duration in advisory logs. The authoritative release-stage intervals remain
   in the signed timing evidence. Optimization telemetry is never a verdict
   input, and a missing advisory field never changes a release verdict.

The next serial-path reductions preserve the same jobs and four Vitest shards:

5. The required JavaScript/TypeScript CodeQL job performs source extraction
   without `npm ci` or `npm run build`. GitHub's interpreted-language extractor
   does not need a JavaScript build, while the pinned Node setup remains in the
   same job. SARIF upload and processing remain mandatory, while the
   non-gating CodeQL database archive upload is disabled. Exact-SHA CodeQL
   success remains mandatory before RC dispatch.
   Narrowing extraction to deployed first-party roots remains shadow-only:
   compare two sequential broad and scoped scans, their extracted-file
   inventories, and runtime-source alerts before activating a production-source
   config. Protected-main push scans remain broad; only the explicitly
   dispatched `deployed_source_shadow` mode uses the separate shadow category.
   Do not add a matrix or a second concurrent security lane.
6. Test-policy behavior uses a bounded synthetic repository for inventory
   history/error cases and retains real-repository partition and runner
   contracts. Disposition matching compiles the seven glob rules once and
   indexes exact rules while preserving first-rule-wins order. This reduced the
   focused governance file from the observed nightly 94.85 seconds to 1.93
   seconds locally on Node 22 without deleting a test or changing a disposition.
7. Project-map tests retain two independent real-tree generations for
   determinism and one fail-closed drift invocation, while reusing the first
   immutable parsed result for read-only route/module/document assertions.
   This reduced the focused file from the observed nightly 17.85 seconds to
   2.03 seconds locally without weakening the production `--check` gate.
8. The test-tier launcher may create one private, ordered-migration-digest-bound
   default SQLite template before its existing Vitest process tree. Each test
   receives a fresh in-memory copy; non-default migration shapes retain the
   current full migration fallback. Activate only after symlink, stale-digest,
   tamper, isolation, and focused timing tests pass. This changes neither shard
   count nor worker topology and never replaces the canonical migration
   rehearsal.
9. Retire the blocking Debian release-test image only after the notification
   release fixture is governed as a critical/cannot-skip selection and exact
   protected-main/RC evidence proves it ran. The Ubuntu 24.04 artifact build,
   locked runtime archive verification, network-blocked staging install,
   installed-tree attestation, PM2 identity, authenticated smoke, and rollback
   checks remain the production artifact authority. Until that mapping is
   approved, describe the Docker probe only as a pinned Debian sandbox
   compatibility check; it is not exact Ubuntu artifact ABI evidence.
10. Keep RC pytest mandatory under the current evidence schema. A later schema
   may bind the exact pytest result/count, Python toolchain, both requirement
   digests, workflow/run identity, and exact SHA into protected-main evidence.
   Shadow that comparison for five releases before permitting same-SHA pytest
   reuse; any missing or ambiguous field keeps the existing full pytest
   fallback. This uses the existing Python job and adds no release lane.
11. Add a Linux x86-64/Python 3.12.3 generated runtime requirements lock with
   exact transitive versions and hashes, then bind its digest into the existing
   runtime dependency lock and release evidence. The current artifact already
   binds every resolved wheel by digest, so this is a reproducible-rebuild
   improvement rather than a reason to weaken staging. Activate it only after
   two clean same-SHA rebuilds produce identical wheel identities and the full
   content-engine tests pass; keep the current requirements-driven builder as
   the reversible fallback during that rollout.
12. Treat artifact transport as a measured release stage. The latest observed
    protected-main bundle archive was 93,032,715 bytes and its upload occupied
    about 6.9 seconds. The protected-main, RC, and signer uploads now use
    `compression-level: 0` because the payload is dominated by already
    gzip-compressed, digest-bound runtime archives. Immutable bundle assembly
    and signer copying request copy-on-write clones with automatic ordinary
    copy fallback. Staging classifier flags are parsed once rather than by
    repeated Node launches. Promotion retains the early client fail-fast
    capacity sample and the authoritative root-worker sample after it owns the
    release/Sonar mutex; the redundant 10-second client sample between signed
    request creation and durable submission is removed. Record five releases
    before claiming the remaining realized time reduction; artifact content
    verification and GitHub archive-digest binding remain unchanged.
    When either protected signing run is identified, the coordinator persists
    and immediately prints its direct URL plus `approval_required`,
    `workflow_pending`, `already_completed`, or `terminal_failure`; it never
    approves the environment. This targets observed human handoffs where
    manifest signing waited about 6m34s before 32s of runner work and staging
    signing waited about 1m41s before 11s of runner work.
13. Reuse one private SSH ControlMaster for the complete staging command and
    one for the promotion client. Use a mode-0700 temporary directory, a
    `%C`-bound short control path, `ControlMaster=auto`, 15-30 second
    `ControlPersist`, explicit teardown, and the same socket for short-lived
    `ssh`, `scp`, and rsync channels. Preserve normal `known_hosts` and
    `HostKeyAlias` authority. The long-lived release/Sonar mutex must retain
    its own non-multiplexed connection, and no master may survive the explicit
    owner-approval stop. Teardown closes the mutex channel first, removes
    remote then local locks while the short-lived master is usable, explicitly
    exits the master, and removes only its validated private directory. The
    existing staging-smoke pattern is the reference. Shadow connection counts
    and wall time for five releases, then activate only if master loss before
    launch, disconnect after durable launch, stale-socket, signal cleanup, and
    resume tests preserve identical evidence and recovery. Retain a one-flag
    ordinary-SSH fallback. This is expected to remove roughly 6-12 seconds of
    handshake latency; it does not overlap remote work.
14. Keep the self-contained signed artifact as the default. Only after exact
    protected-main reuse, runtime-footprint reduction, and the seal/receipt
    work below are active should five releases shadow a single-upload artifact
    chain; the measured signer upload alone is about seven seconds and does not
    justify weakening recovery. RC evidence must bind repository identity,
    workflow path/name/database ID, push/main/head SHA, run ID and attempt,
    status/conclusion, artifact ID/name/size, GitHub archive digest, extracted
    content digest, and expiry. The protected signer revalidates all of those
    fields live and emits the signed manifest plus transfer provenance without
    copying and uploading the same runtime bundle again. Immediately before
    Mac download, revalidate them again, download the immutable artifact ID as
    a raw ZIP, verify its signed archive digest, then perform bounded safe
    extraction that rejects extra, duplicate, traversal, symlink, and special
    entries before verifying the exact manifest tree. `gh run download` is not
    sufficient for this authority because it selects by run/name and extracts
    before the caller can prove the ZIP bytes. Cover deletion, access failure,
    rate limiting, partial download, and retention shorter than the resume
    window. Availability failures such as confirmed expiry or deletion abort
    and retire the transaction; after owner review, a fresh legacy RC/signing
    run may start with new provenance and approval. Substitution, ambiguity,
    partial bytes, or any digest mismatch is an integrity signal that halts for
    owner investigation and cannot trigger an automatic rerun. There is no
    same-transaction fallback once the self-contained artifact was
    intentionally omitted. This removes two large serial uploads only after
    five exact shadow agreements.
15. Shadow removal of the immediate second full content hash in runtime
    sealing. Retain the first full byte verification, replace only the
    post-permission-change rehash with strict inode, link, size, ownership,
    mode, and metadata-closure checks, and retain the independent full
    pre-switch verification in the root promotion worker. Activate after race,
    symlink, replacement, and mutation fault tests plus five staging
    agreements; any discrepancy keeps both hashes.
16. Reduce signer checkout cost only through a shadowed single-branch history
    design. The signer still needs current protected tooling, an inert exact
    candidate worktree, qualifying-nightly history, and offline ancestry
    verification after credentials are removed. Do not replace the two full
    checkouts merely with shallow or lazy private-repository clones. First
    prove that a single protected object store plus detached candidate
    worktree produces identical source, ancestry, selection, and manifest
    identities for five releases.
17. Create a separate runtime-footprint change replacing the 196-MiB
    `googleapis` meta-package with only the governed Calendar, Gmail, Drive,
    and authentication clients. The observed staged runtime is approximately
    614 MiB with at least 38,120 files, so dependency reduction improves every
    upload, download, extraction, hash, staging copy, rollback bundle, and
    retention operation. Land this as its own exact-SHA dependency PR with
    focused provider tests, one final full suite, and staging parity; never
    mix it into the release-control change or silently alter provider routing.
18. Reduce evidence-tail startup without weakening ancestry. The observed
    protected-main evidence job took about 13.9 seconds after runner start,
    including a 3.9-second full-history checkout and 3.4-second pinned Node
    setup. Shadow a single-main-branch history fetch that still proves an
    arbitrary multi-commit push base is an ancestor. Also evaluate starting
    evidence directly from the already-bound test-lane results while retaining
    whole-workflow success as a reuse prerequisite. Shallow checkout, omitted
    base proof, unpinned Node, and an independently green evidence artifact
    from a failed workflow are prohibited.
19. Coalesce protected-workflow revalidation into one live check at the latest
    pre-RC-dispatch boundary. Successful polling checkpoints exact run
    identities, but cannot authorize dispatch. After the correlation baseline
    is persisted, the coordinator live-revalidates workflow path/database
    identity, latest run/attempt/SHA/URL/conclusion, and CodeQL job identity,
    binds the results, and applies the existing pre-spawn 60-second freshness
    assertion. No remote result is cached or reused at this boundary. This
    removes six duplicate GitHub calls on the normal path without changing
    “latest live attempt at dispatch,” creating another evidence store, or
    adding a release lane.
20. Make coordinator status inspection genuinely local and read-only.
    `--status` must read an existing private checkpoint without fetching,
    creating directories or locks, writing a checkpoint, waiting, dispatching,
    watching, staging, or promoting, and must label the result as unrefreshed.
    `--status --refresh` may perform bounded one-shot repository/workflow reads
    but still must not mutate local or external state. This is an operator
    recovery and safety improvement rather than automated-path latency.
21. Shadow safe resume of a pinned release SHA after protected main advances.
    New releases still start only from the current clean protected tip. After
    an RC run is durably identified, a resume may continue only when the pinned
    SHA is still an ancestor of current main and a protected current-tip
    tooling checkout classifies the intervening delta as release-neutral. The
    delta must not change runtime code, dependencies or lockfiles, migrations,
    test policy, release/security workflows, toolchains, auth or tenant
    isolation, provider routing, or any critical fix. Current-tip required
    checks must be green; package/version and old signed evidence remain exact;
    and authoritative server release history must prove no newer superseding
    release. The owner acknowledgement is single-use, time-bounded, and binds
    pinned/current SHAs, version, artifact and evidence digests. Candidate code
    remains an inert detached worktree. Before RC identification, retain the
    current restart behavior. Compare five releases before activation; this
    prevents an occasional 10-minute-plus RC restart but never silently
    promotes an outdated candidate.
22. Reduce duplicate signer API reads through bounded completion/provenance
    receipts. Before an exact `--run-id` helper may omit a workflow lookup, the
    coordinator must first add and validate remote workflow path, database ID,
    and run attempt; current state does not yet bind all three. A manifest
    helper may replace its post-watch view only with the richer exact REST run
    document already bound into the private, manifest-linked provenance
    receipt. Staging first needs an equivalent private request, attestation,
    run-attempt, and terminal-completion receipt; the signed attestation alone
    is insufficient. Reuse a receipt only when repository, workflow, run
    ID/attempt, tooling SHA, candidate SHA, conclusion, artifact identity,
    original verification time, and an explicit maximum age match. Preserve
    the watch/terminal proof and fail closed on missing, stale, or ambiguous
    fields. Shadow before claiming the estimated two-to-eight-second saving.
23. Avoid repeated full-tree validation on status-only coordinator transitions.
    The current owner-stop and promotion-resume status probes can traverse the
    approximately 614-MiB, 38,120-file bundle before the authoritative
    pre-use validation traverses it again. Split a read-only signed
    envelope/attestation status check from full bundle validation. Retain full
    byte/tree validation after download, immediately before staging transfer,
    and immediately before promotion. Shadow tamper, symlink, manifest,
    checkpoint-resume, and owner-stop cases before removing either redundant
    status traversal; measure the saving rather than estimating it. A
    metadata-only result is never promotable and cannot become reusable release
    evidence.
24. Measure the RC contract-binding job's queue and runner delay before
    changing it. Remove the separate job only if every direct-dispatch path can
    consume one versioned, digest-bound predicate with identical fail-closed
    behavior and without duplicating policy across jobs. Shadow five RCs and
    retain the current job on any mismatch. This may remove the observed
    roughly seven-second fan-out delay, but it must not add a matrix, worker,
    lane, or parallel release path. Whole-workflow required success, exact
    predicate input/tooling identity, and owner-reviewed branch-protection
    changes remain mandatory.
25. Use a single-freeze verification budget while implementing release-control
    changes. Run classifier-selected and directly affected tests after each
    bounded change, freeze the branch once, then run one Node 22 risk gate
    (which owns the single full integration suite when the classifier requires
    it), followed by the science-policy check, docs audit, and verifier. Do not
    rerun the 14,000-plus-test suite for every documentation, shell, or
    workflow edit. If the final suite fails, diagnose and verify the affected
    area first; rerun the full suite only after a test-critical correction
    changes the frozen candidate or an infrastructure failure invalidates the
    run. Protected-main and RC evidence requirements remain unchanged.
26. Remove redundant artifact hashing without removing a verification
    boundary. Bundle verification now computes each file SHA-256 once and
    reuses that value for comparison and returned identity. Next, bind the
    already-verified bundle manifest/receipt into unsigned-manifest creation
    rather than rescanning the workspace. Retain the full verification after
    signer download and the full destination verification after rename: inode
    and size alone cannot detect same-size writes through an already-open
    descriptor, and the measured warm verification is only about 0.5 seconds.
    Existing-destination resume also performs one full governed validation.
    Tamper, duplicate, symlink, undeclared-file, and cross-filesystem cases
    remain fail-closed. Keep this a focused mechanical change.
27. Shadow Node runtime archive gzip level 1 against the current deterministic
    level 6 outside the release path. The observed RC bundle stage spent about
    29 of 36 seconds compressing a 69,610,105-byte archive representing
    436,244,480 uncompressed bytes and 27,552 entries. Compare exact extracted
    inventory and file digests, installed and recovery aggregate digests,
    archive size, compression, GitHub and Mac transfer, staging transfer, and
    extraction time. Compare semantic extracted-tree identities across levels;
    archive bytes and digest chains will differ, so each variant must validate
    its own artifact, runtime-lock, installed, and recovery aggregate chain.
    Activate only when total end-to-end p50/p95 improves; otherwise retain
    level 6. This may save 15-25 build seconds, but extra transfer time is part
    of the decision.
28. Introduce a one-use root staging seal receipt before avoiding immediate
    recomputation. The receipt binds a nonce/ID, request ID, boot ID, runtime
    SHA, artifact digest, canonical base/runtime paths, a complete recursive
    filesystem-identity digest, signed manifest and request digests, installed
    and recovery digests, attestation body digests, sealed timestamp,
    verifier schema/version and tool digest, and a short expiry. Under the root
    release lock, consumption atomically writes and fsyncs a root-owned
    single-use marker before the attestation proceeds. Reboot, expiry, resume,
    replay, identity drift, or missing fields force the current full root
    verification. Shadow five releases and the seal/tamper/reboot drills before
    activation. Expected saving is approximately 4-20 seconds depending on
    ServerDominguez storage cache.
29. Stop recursively resealing already sealed production runtimes only after
    proof. The root worker currently seals both predecessor and candidate even
    though preparation sealed the target and the current predecessor should
    already be immutable. Shadow fail-closed trusted `verify` in place of
    permission-repairing `seal`; wrong mode, owner, byte, link, inode, reboot,
    and legacy-predecessor fixtures must fail rather than self-heal. During
    shadow measurement only, the current seal path remains the control; any
    shadow verify mismatch invalidates that agreement. Once activated, a
    mismatch aborts and never reseals or self-heals. Expected saving is
    approximately 10-40 seconds across both trees.
30. Replace the Mac's terminal heavy recomputation only with richer root-owned
    terminal evidence. Bind post-escrow trusted-attestation and recovery
    digests, verification and tool identities, selector identity, PM2 identity,
    owner-signed request/envelope digest, signed manifest and staging
    attestation digests, boot ID, target device/inode identity, terminal
    journal/result digest, transaction ID, and timestamps into the root result.
    The Mac still checks the signed/root receipt plus lightweight live selector
    and PM2 identity. Disconnect, replay, stale-result, target-replacement,
    tool-drift, and post-result mutation drills must pass before removing the
    duplicate client traversal. Expected saving is approximately 3-15 seconds
    after promotion.
31. Shadow copy-on-write for same-host staging-to-production materialization
    only when `/srv` proves verified reflink support. Clone into the new empty
    root-owned target with `--reflink=always`, then retain the complete trusted
    digest and seal checks. Fall back to current rsync only when an isolated
    preflight proves reflinks unsupported before the governed target is
    populated. Before activation, prove every regular source and target entry
    has `nlink == 1` and distinct inode identity so no hardlink can cross the
    trust boundary. A clone, digest, seal, link-count, or inode mismatch aborts,
    retires the target, and requires a fresh transaction; never use hardlinks.
    The opportunity is approximately 5-30 seconds on a reflink-capable
    filesystem and zero on an unsupported one.
32. Treat protected-workflow authority as a transaction boundary. Immediately
    before RC dispatch, require one live lookup proving that each bound run is
    still the latest exact-SHA attempt and successful. After `dispatch_started`
    is durably written, later resumes validate the immutable bound run,
    workflow path/database identity, attempt, URL, conclusion, and CodeQL job
    directly; they do not require that no newer attempt exists. This removes
    redundant run-list calls from every approval/status resume and prevents a
    benign rerun from stranding an already-bound release. A failed final live
    lookup leaves `intent_persisted`, so resume can safely revalidate and
    dispatch once. Newer runs cannot replace or mutate the transaction's
    evidence, and any drift in the bound run/job remains fail-closed.
33. Reuse one local full-suite result across the manual final gate,
    pre-commit, and pre-push only through an exact candidate receipt. Create
    its snapshot and result atomically under ignored mode-0600 `.local` state
    around one full, unsharded, `--no-cache` deterministic run. Require no
    unstaged tracked or untracked non-ignored files and the same raw staged Git
    blobs, executable/symlink modes, and tree before and after. Bind base HEAD,
    governed test inventory/count, JSON result digest, test policy, locks,
    runner bytes, the complete installed dependency tree except Vitest's
    unused mutable `.vite` cache, resolved core/Python/CloudFormation tools,
    hashed environment and dotenv inputs, Node, Vitest, OS, and architecture,
    with a strict 30-minute maximum age. Pre-commit reuses only an identical
    index; pre-push accepts one exact branch or commit-resolving tag, binds its
    commit/tree before and after the gate, and treats empty retry input as an
    already-complete no-op. Reuse skips only Vitest: typecheck, science-policy,
    notification, Python, and migration checks still run. CI, explicit JSON
    evidence runs, shards, non-default reporters, injection-capable child
    environments, or any missing/stale/partial/dirty/drifting evidence run the
    normal gate. The measured dependency-byte proof costs approximately
    16 seconds on reuse and 25 seconds on initial recording for the current
    503-MiB install, still avoiding up to two duplicate local
    14,000-plus-test executions. This is local advisory evidence only and
    never replaces protected-main or RC evidence.
34. Make local change selection status-aware and fail fast. Pre-commit passes
    the exact staged index through NUL-delimited Git name/status parsing rather
    than a comma-joined path list; both sides of renames and test deletion or
    file-type changes force the required topology coverage. A classifier error
    stops immediately instead of fabricating a “full” result that silently
    disables Python, migration, and cannot-skip gates. Pre-push rejects
    ambiguous multi-ref and deletion updates but returns success for a genuine
    zero-update retry after network ambiguity.
35. Keep one TypeScript compilation at every remaining local fallback
    boundary. The production build's first command is the same default-project
    `tsc`, so the legacy diagnostic release gate and direct-main pre-push run
    the build once and omit standalone `tsc --noEmit`. More importantly,
    `release:resume` is the only primary production-release command; the
    legacy `release:prepare` flow is explicitly diagnostic/manual fallback
    because invoking it before the coordinator repeats a release gate, build,
    bundle, and unsigned-manifest pass.
36. Protect local test evidence paths before spending test time. JSON reporter
    output must resolve strictly below the checkout's real `.local/` tree,
    reject traversal, newline, symlink-parent, symlink-file, hardlink,
    foreign-owner, and non-regular targets, and be recreated mode 0600 on a
    fresh inode. Receipt report paths must normalize to repository-owned
    `__tests__` files; a foreign absolute path with a matching suffix is
    rejected.
37. Shadow an immutable installed-dependency generation receipt to reduce the
    local receipt's 16-25-second byte-hash overhead. `npm ci` would produce one
    atomic generation ID plus lockfile, Node/npm, platform, root realpath,
    complete dependency digest, and read-only/seal evidence. Hook reuse may
    consume it only while the generation remains immutable and all directory,
    symlink, device/inode, and permission checks agree; otherwise retain the
    current full byte scans. Five adversarial shadow comparisons, including a
    same-size dependency rewrite and root replacement, are required before
    activation.
38. Prune generated declaration files from the production artifact.
    TypeScript `.d.ts` and `.d.ts.map` outputs are build-time API metadata, not
    Node runtime inputs; the current `dist` contains roughly 2,000 such files,
    while `.js.map` files remain for Sentry. The artifact manifest omits only
    those two declaration suffixes and binds the smaller file set into its own
    signed identity. Runtime module closure, authenticated staging smoke,
    migration, rollback, and installed/recovery verification remain mandatory;
    record bundle/hash/transfer improvement over the next five releases.
39. Keep remaining runner and smoke reductions conditional and sequential.
    When exact protected-main bundle reuse is active, condition aggregate
    `setup-python` off only if no aggregate step executes Python. In the Debian
    compatibility image, install only production Python requirements because
    its contract imports runtime modules and does not run pytest; the separate
    Python-full job retains dev test dependencies. Combine each staging HTTP
    status/body pair into one authenticated remote response and reuse
    already-validated domain probes, with response-size bounds and identical
    field assertions. Surface the root journal's durable
    `candidate_available` milestone once while continuing through the required
    soak and escrow. A disabled training E2E check must be blocking or signed
    `not_applicable`, never recorded as passed. None of these changes may add a
    worker, shard, matrix, lane, or parallel command.
40. Measure the notification fixture's duplicate execution but do not change
    its mapping without the exact governance acknowledgement
    `APPROVE CI MAPPING FIX`. A notification change currently runs the focused
    notification gate in each of four full shards while the governed
    deterministic inventory also runs that file once. The proposed contract
    removes only the standalone invocation from sharded-full mode after proving
    the exact policy digest and every shard union still contains the test;
    focused/changed mode retains the dedicated gate. Until approval and proof,
    preserve all executions.
41. Keep soak and post-soak reductions shadow-only. During the existing
    staging 60 seconds, record sequential 10/30/60 health and PM2 checkpoints
    for ten real releases; preserve production's 60-second soak, and consider a
    shorter staging interval only with zero missed degradation. In the same
    natural releases, compare a richer one-use root readiness receipt against
    duplicate post-soak probes, benchmark rsync without compression for the
    already-compressed payload, and shadow a signed transitive classifier for
    the training preview. Any mismatch keeps the current checks and timing.

42. Keep mutation analysis outside the release lane, but make its evidence
    deterministic so an advisory verifier cannot create avoidable rework.
    Mutation-only Vitest uses one fork worker, matching the repository's stable
    native-module process boundary. When sequential Stryker batches repeat an
    owner test file, canonicalize each process-local test ID to the normalized
    file plus full Vitest name and rewrite `coveredBy` and `killedBy` before
    merging. Duplicate logical names and unresolved IDs fail closed. Cleanup
    mappings bind one unambiguous full owner name per governed range. Verify
    this with focused tests and one bounded Stryker run; never rerun the full
    deterministic suite solely for mutation analysis.
43. Apply the remaining cheap serial-path reductions before another full
    candidate freeze. The diagnostic `release-verify.sh` relies on the
    production build's existing `tsc` and does not compile twice. Receipt reuse
    compares cheap HEAD/index/pushed-tree identity before hashing the installed
    dependency tree, while an otherwise matching candidate still receives the
    complete byte-level proof. Exact protected-main bundle reuse keeps pinned
    Node setup but does not restore an unused npm cache. Staging HTTP probes use
    bounded connect/overall timeouts and normalize transport failure to one
    `000`. Release tagging reads the package version with runner-provided `jq`;
    best-effort Notion closeout has bounded timeouts and remains after customer
    availability. Together these remove one full local compile, avoid a
    16-25-second stale-receipt scan, save an estimated 1-5 seconds on exact
    reuse, and prevent unbounded smoke/closeout waits.
44. Make post-soak rollback escrow recovery server-owned. The same root-owned
    promotion oneshot performs at most eight journaled monotonic-backoff
    attempts within one strict 1,200-second same-boot budget, records attempt,
    next-attempt time, boot and error class, and caps both each S3 operation
    and its candidate-readiness proofs to the remaining monotonic budget.
    Candidate degradation restores the predecessor immediately; exit 75 is
    reserved for exhausted resumable escrow. The Mac only observes the journal
    and is never required to keep rollback protection alive. Before expensive
    preparation, the transaction also waits a bounded interval for an
    already-running hourly DR backup lease after publishing its active marker.
    It never stops PM2 while waiting, and the existing unit condition prevents
    a new timer backup from entering. Reboot, timeout, recovered-S3,
    degraded-candidate, and Mac-disconnect fault tests are mandatory. This adds
    no timer, worker, or release lane.
45. Enforce staging dependency installation inside a root-created private
    Linux network namespace while executing artifact-owned installers only as
    the release worker user. Bind host/child namespace identity, the trusted
    `unshare` tool digest, empty route/non-loopback-interface proof, locked
    dependency evidence, and installed-tree digest into the staging evidence.
    DNS and TCP must fail while locked Node extraction and `pip --no-index`
    succeed. Missing namespace support fails closed. Activate only after one
    exact-artifact staging drill proves the installed-tree digest matches the
    current path; normal overhead should remain below one second.
46. Shadow a promotion-specific DR escrow mode against the complete hourly
    maintenance path. Each pre/post release escrow still creates and verifies a
    fresh hourly database point plus the exact candidate, predecessor, version,
    retention, and download-confirmed objects required by that transaction.
    Daily/weekly/monthly reconciliation and unrelated local rollback inventory
    stay in the hourly unit instead of being repeated twice in the customer
    release. Compare all required object keys, VersionIds, ciphertext/plaintext
    digests, and retention fields for five releases plus one restore drill
    before activation. Preserve the current full DR path as fallback on any
    mismatch. Expected saving is 10-60 seconds per escrow phase with fewer S3
    calls.
47. Shadow one deterministic candidate recovery archive per transaction. Pack,
    inspect, and hash the sealed plaintext once under root transaction state;
    revalidate its inode, tool, request, target seal, and digest before fresh
    phase-distinct age encryption for pre-mutation and post-soak keys. The two
    ciphertexts, keys, and retained object versions must remain distinct.
    Durably remove plaintext only after a terminal result. Five byte-identity
    comparisons plus tamper, reboot, stale-tool, and restore drills are required
    before activation. Expected post-soak saving is 15-60 seconds.
48. Optimize actual unavailability independently from the mandatory soak.
    Candidate-availability probes fail fast in the order loopback, content,
    PM2/current identity, then public network; the public timeout is never paid
    for a locally invalid candidate. Next shadow a one-use sealed receipt for
    the online-prestaged predecessor rollback closure and gzip level 1 for that
    outage-window archive, while retaining the quiescent database addition and
    exact extracted manifest/database hashes. PM2 command coalescing is also
    shadow-only. Reboot, failed-health, slow-local, slow-public, and automatic
    rollback drills must pass before activation. Expected customer-unavailable
    reduction is 2-15 seconds; the 60-second post-candidate soak is unchanged.
49. Reconcile the durable systemd promotion without hammering it. Pending or
    recovery-required authority triggers `ensure-started` immediately on each
    status transition and then no more often than every 15 seconds. Ordinary
    running polls remain read-only; server-owned recovery remains authoritative
    if the client disconnects or the transaction unit exits. Journal entries add phase
    sequence, start/end/duration, boot ID, systemd invocation ID, retry state,
    and the latest durable external confirmation. Missing new status fields
    remain `unknown` during a rolling control-plane upgrade and cannot be
    interpreted as healthy. This removes roughly 25 SSH/sudo/systemctl calls
    during a normal soak without introducing a background controller.
50. Publish an encrypted immutable transaction recovery-set locator off-host.
    The bounded descriptor binds transaction and request identity, runtime,
    artifact, installed, signed-manifest and staging-attestation digests, plus
    every database/runtime/rollback object key, VersionId, phase,
    ciphertext/plaintext digest, and retention date. Start advisory; after an
    isolated restore succeeds using only the locator with local host state
    removed, make post-soak locator publication terminal-required. This adds
    less than an estimated two seconds and reduces host-loss pairing ambiguity
    and restore time.
51. Keep the next GitHub and container reductions shadow-only. Coalesce RC
    artifact downloads only behind an exact artifact-name and content
    allowlist, and narrow the current Docker build context only after a
    generated container-contract inventory proves every transitive input.
    Compare five runs and retain separate download/fallback behavior on
    ambiguity. Expected combined saving is 3-11 seconds; neither change may add
    a job, matrix, shard, or parallel command.
52. Optimize the slow release-control test harness before deleting any
    behavior coverage. The latest complete local receipt took 329 seconds of
    wall time; its four slowest files accumulated approximately 489 seconds of
    cold-file work:
    `rollback-drill-legacy-staging-adapter.test.ts` (146 seconds),
    `v2-normalization-attestor-installer-transactions.test.ts` (133 seconds),
    `release-sequence.test.ts` (132 seconds), and
    `persistent-promotion-transaction.test.ts` (78 seconds). These fixtures
    already replace real poll, backoff, and soak waits; their dominant cost is
    repeated Git, Node, key/archive, and durable-filesystem subprocess startup.
    Optimize in this order: create one digest-checked immutable Git seed and
    isolated mutable clone per release-sequence case; replace nested Node in
    its mocks with shell arithmetic, `jq`, and the governed digest utility;
    batch each ordered legacy/V2 test-mode filesystem phase into one bounded
    Node helper call with an asserted operation log; reuse only immutable
    key/archive/SQLite seed inputs; and cache the path-independent signed KVM
    proof while retaining fresh mutable transaction state. Production defaults,
    operation order, every test name, and security-boundary assertions remain
    unchanged. Benchmark each file cold three times before and after and accept
    only a stable median improvement with no flaky retry. Cold timing stays
    advisory and never changes a correctness verdict. The conservative
    four-shard critical-path forecast is 45-80 seconds without adding a shard,
    scheduler, daemon, or release concurrency. The first seed step is active:
    all 47 release-sequence tests retained their names and passed under exact
    Node 22, while measured single-file wall time fell from 101.69 to 93.61
    seconds (8.08 seconds, 7.9%). The remaining mock and installer batching
    steps stay benchmark-gated.
53. Bind post-availability release closeout to production instead of the
    workflow-dispatch branch tip. The closeout accepts the exact promoted
    runtime SHA, artifact digest, root transaction ID, and terminal promotion
    evidence digest; checks out that SHA shallowly; and tags that commit only.
    It is owner-dispatched, passes all free-form inputs as data rather than
    shell source, and creates Notion JSON with `jq`. A retry accepts an existing
    tag only when it peels to the same promoted SHA, then resumes GitHub Release
    publication instead of orphaning the tag. Add this as a checkpointed,
    resumable coordinator phase only after customer availability; missing
    release notes or closeout failure must be visible but cannot change the
    completed production verdict. Shallow checkout saves an estimated 2-5
    seconds of non-customer-blocking closeout while the primary gain is exact
    release identity and recovery from transient publication failure.
54. Remove only byte validations that are immediately and equivalently
    repeated. Runtime dependency `write-lock` already hashes and validates the
    Node archive and every wheel before writing the lock, so the builder does
    not invoke a third immediate full `verify`; the protected signer and
    staging still revalidate the transported bytes. Promotion resolves bounded
    manifest metadata first and lets the enforced release reward check own the
    single immediate full manifest, bundle, and signed-staging validation
    before any remote action. Preserve the later server-owned artifact and
    installed-tree boundaries. Expected combined saving is approximately
    0.7-4 seconds with fewer redundant disk traversals.
55. Shadow one-pass Node dependency extraction in staging. Stream-validate
    every tar member into a fresh owner-only same-filesystem temporary tree,
    reject duplicates, traversal, links, devices, unsupported metadata, and a
    late invalid member, then atomically rename only after the complete archive
    and installed tree validate. Interruption or any invalid member removes the
    temporary tree. Compare the current two-pass Python `getmembers()` plus
    extraction path against the streaming path with adversarial archives and
    exact installed-tree digests for five releases before activation. Expected
    staging saving is 3-10 seconds for the current approximately 436-MiB
    uncompressed dependency tree.
56. Shadow signer-resume validation consolidation. A newly downloaded signer
    result, an already published destination, and the final installed
    destination each retain one governed full validation, but an unchanged
    destination is not traversed twice within the same resume attempt. Prove
    same-size mutation, symlink substitution, inode drift, interrupted
    publication, and resume equivalence before removing the extra pass.
    Expected resume-only saving is approximately 0.5-1 second.
57. Treat the server-owned retry and DR-lease contract as a new privileged
    control-plane capability. The installer and every staging, production,
    legacy-adapter, and KVM readiness consumer require exact
    `nexus-release-promotion-control.v4`; an installed v3 must fail preflight
    rather than masquerade as capable. Bootstrap and re-read exact v4 on
    ServerDominguez before the first v4 staging install, then run a no-mutation
    status/version probe and the disconnect/retry fault case. The v4 bump adds
    no release work after installation, but prevents a rolling-upgrade stall in
    which the Mac observes retries that an old server worker cannot perform.

The non-cumulative planning opportunity for compatible items 12-57 is
approximately 135-365 seconds on the common exact-evidence-reuse path, separate
from the larger saved RC test run. Several items overlap or depend on
filesystem, object-store, and network behavior; items 20, 21, 44, and 50
primarily improve recovery rather than the common automated path; and items
23, 37-41, 45, and 49 are deliberately unestimated. This is
not a release promise: replace it with signed p50/p95 stage measurements after
the five-release shadows, and revert any item that increases failed releases,
artifact ambiguity, or rollback time.

Additional candidates remain measurement-only. Before downloading nightly
artifacts, the RC planner may use GitHub run metadata to discard only
provably stale or non-ancestor candidates; the downloaded signed evidence
remains the authority, and any uncertainty keeps the current newest-first
probe and full-suite fallback. Do not remove the
protected-main upload/download proof until a versioned evidence schema binds
the GitHub artifact ID and archive digest and five shadow downloads prove the
same extracted bundle digest. Do not collapse the pre-secret signer validation
and signing passes until a protected immutable prevalidation receipt preserves
the current private-key isolation and is independently reviewed. Retain both
steps by default. Full Python release testing, migration rehearsal, the
production-owner stop, the 60-second soak, pre-mutation recovery escrow, and
post-soak rollback escrow are not optimization candidates.

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

The expected control version is `nexus-release-promotion-control.v4`; the lock
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
exposed to this branch. After the governed legacy staging broker has produced
the exact drill-only request, the sequential operator reads
`.local/release/signing-provenance/<sha>.json`. The release-manifest requester
installs that mode-0600 SHA-scoped receipt atomically from the exact downloaded
signer artifact. It binds the repository, SHA, manifest and payload digests,
candidate run, protected signer workflow/path/run/attempt, and GitHub artifact
ID/digest. Drill staging re-fetches that run and artifact metadata from GitHub
and rejects missing, stale, partial, RC-run, or mismatched receipts. It never
mistakes the manifest's deliberately RC-bound `payload.ci.runId` for the
protected manifest-signing run. The lower-level protected signing request is:

```bash
scripts/request-rollback-drill-staging-attestation.sh \
  .local/release/rollback-drill-staging/<sha>-<digest>.request.json \
  .local/release/manifests/<sha>.json \
  .local/release/rollback-drill-staging/<sha>-<digest>.bundle \
  --manifest-signing-run-id <exact-protected-run-id>
```

The operator supplies `<exact-protected-run-id>` only from the validated
SHA-scoped receipt; it is not a caller-selected release argument.

`npm run release:drill-staging -- --acknowledge-first-drill-bootstrap` now has a
dedicated, sequential adapter for the exact control-v2 legacy base
`/home/dominguez/telegram-hub-bot-staging`. Source presence does not install or
activate it. Before non-dry execution, an owner must bootstrap the reviewed
protected-main archive and install the root assets:

```bash
sudo /var/lib/nexus-release-bootstrap/<sha>/source/scripts/remote-rollback-drill-legacy-staging-install.sh \
  install \
  /var/lib/nexus-release-bootstrap/<sha>/source \
  <40-hex-protected-main-sha> \
  /var/lib/nexus-release-bootstrap/<sha>/source.tar.gz \
  <64-hex-root-side-archive-sha256>
```

The installer proves the archive's Git PAX commit and byte identity before it
transactionally installs the mode-0700 broker/tooling, static systemd
transaction and boot-recovery units, fail-closed PM2 dependency drop-ins,
mode-0440 `NOSETENV` allowlisted sudoers entry, and mode-0600 receipt. It also
requires the application-DR-owned
`/usr/local/libexec/nexus-application-dr/application-dr-sqlite.py` to be a
root-owned mode-0644 regular file with reviewed SHA-256
`e1f1a92d4dc49bd6fe6c1d8c1a3573ec2db61f6374a1831b2765a5541943708d`.
The helper is verified against the SHA-bound source archive and recorded in
the install receipt; this installer does not overwrite the application-DR
asset. The application account can invoke only `version`,
`inspect`, `prepare`, `launch`, `status`, and `fetch-evidence`; it cannot invoke
the root worker or recovery command directly.

The operator uploads the exact signed artifact before submitting one bounded
request to the root broker, then only polls its durable journal. The broker
requires the reviewed control-v2 digest, holds the ordinary-promotion and
release/Sonar locks, pins the dependency attestations before candidate code,
seals both candidate and predecessor trees root-owned and non-writable, and
revalidates their root-pinned installed/recovery identities immediately before
each selector or PM2 mutation. It persists and fsyncs the predecessor plus
outage clock before either allowlisted
staging PM2 process is changed. It stops only `nexus-hub-staging` and
`content-engine-staging`, proves that no process holds `data/bot.db` or its
WAL/SHM sidecars, creates and verifies a mode-0600 SQLite recovery point in the
root-private transaction directory, and fsyncs its bounded digest, size,
original uid/gid/mode, and creation time into the journal before changing
`current`. Database and
recovery-point inputs above 2 GiB fail closed; that is more than seven times
the currently observed 275,808,256-byte staging database while keeping the
120-second recovery target credible. It then runs the
existing 60-second readiness soak. That root-held readiness record is also the
required drill smoke: it binds each allowlisted PM2 name, cwd, executable,
Sentry/release SHA, stable PID/restart counters, database integrity, backend
health, and authenticated Content Engine readiness to the candidate. It
finishes under the same locks before the journal may become `completed`; the
Mac no longer runs a required post-terminal smoke for this legacy path. SSH
loss does not own the transaction.
Failed readiness and boot recovery stop the candidate, verify the journaled
backup, recreate a deleted or truncated database with the journaled original
uid/gid/mode, restore it atomically after removing WAL/SHM sidecars,
restore the exact predecessor selector, and prove predecessor health. A
missing, corrupt, unbound, helper-invalid, or drifted predecessor identity
fails closed before the predecessor is started. Both PM2 units require
successful boot recovery and execute a final no-unfinished-journal guard, so
ordering alone cannot permit application start after failed recovery. The
dependency installation and preflight occur before the outage is armed.

The resulting request contains
`nexus.rollback-drill-legacy-staging-bootstrap.v1`, fixed scope
`isolated-kvm-first-drill`, exact broker/control/predecessor/journal evidence,
the database recovery-point SHA-256 and byte count (never database contents or
its host path), and `promotionAllowed: false`. The protected drill signer binds the canonical
bootstrap digest in its outer record. `release-staging-attestation.mjs`
explicitly rejects any `drillBootstrap`, so even a production-key-shaped
envelope cannot satisfy ordinary staging or promotion. The actual drill
envelopes remain signed only by the distinct drill key. This branch never calls
the v3 `/srv` implementation and adds no promotion command.

Control-v2 pinning remains exact. Before retiring or replacing this adapter,
root must run
`nexus-rollback-drill-legacy-staging-broker assert-terminal-retirement-ready`.
It succeeds only with no unfinished transaction and explicitly requires the
`nexus.release-layout-fault-drill.v1` successor integration to be installed
before the active adapter is removed.

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
independent overlays, cloud-init seeds, VM identities, and newly generated
lab-only SSH host identities. Each host identity is bound to exactly one guest
slot in the provision set; all three must be distinct from each other and from
the production identity. An optional unprivileged staging directory is copied
through no-follow file descriptors into root-private state before the same
checks; the staged files are never executed.

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
`/opt/nexus-release/pm2/6.0.14` and launched through the root-owned
`/usr/local/bin/pm2`.

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

The protected-main
`scripts/rollback-drill-kvm-readiness-sequence.mjs` control adds the offline
admission boundary for this manual phase. One root-owned ledger is derived from
the exact plan SHA and snapshots the generation, provision, owner-key, and
three signed runtime-authorization identities. Its fixed non-waiting lock and
durable active checkpoint admit exactly
`ssh-loss/guest-1 -> failed-health/guest-2 -> guest-reboot/guest-3`.
Out-of-order, cross-plan, cross-guest, stale, replayed, or drifted requests fail
closed. Completion re-verifies the owner and guest signatures, collector
journal nonce/challenge, and exact live QEMU tuple before atomically advancing.
An interrupted completion on the same boot resumes from immutable receipts and
the same active request; it never clears the active guest implicitly. The
authorization and ledger bind the Linux boot-ID digest plus `/proc/uptime`
start/deadline, so a reboot, decreasing monotonic clock, or elapsed 24-hour
window requires a newly prepared and owner-authorized sequence.

This ledger deliberately starts no unit, opens no SSH connection, performs no
network action, invokes no evidence coordinator, and cannot activate
production. It is a durable operator checkpoint only. The existing root-owned
systemd locks remain the physical one-QEMU boundary, and a later reviewed
adapter must consume the exact active request before this checkpoint can
authorize automation. Full operator commands and recovery rules remain in
`ops/rollback-drill-vm/OPERATIONS.txt`.

The real evidence bundle requires the exact `execution.json` receipt in
addition to all three outcomes. Each outcome binds the receipt digest and
repeats its strictly-sequential mode and `testMode=false` identity; the receipt
binds their ordered payload digests plus the immutable completed readiness
ledger's generation, provision, and ordered readiness digests. Isolation
contains that same ledger, and the owner signature binds the exact isolation.
The coordinator verifies the signed chain and live boot/monotonic deadline
before its first guest-unit start. The final machine-evidence bundle includes a
separate canonical readiness-ledger file and repeats those identities.
Collection and verification reject a missing, substituted, reordered, stale,
different-boot, or test-mode receipt before rollback freshness evidence can be
produced.

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

## Release-layout normalization and activation status

The repository contains the inactive v2 production-only bridge for the exact
installed e168 promotion v2 control and strict attestor identities:

- `scripts/trusted-release-runtime-attestation-v2-bridge.mjs` accepts a legacy
  installed-tree identity only for the exact predecessor named by one
  owner-signed, single-use, active promotion request. The request's ordinary
  release manifest and staging attestation must also verify under the current
  production release-evidence key before any filesystem metadata changes.
- The strict target never receives a legacy exception. Its artifact,
  network-independent dependency evidence, installed-tree identity, and
  inventory are verified read-only first. During strict target sealing only,
  the shared production `.env` changes from the exact legacy
  worker:worker `0600` policy to root:worker `0440`. The bridge first requires
  the production base's parent to be a canonical root-owned directory with no
  group/world write bit. It then binds every source entry by device, inode,
  link count, type, owner, group, and mode; opens non-symlinks with
  `O_NOFOLLOW`; preflights the complete runtime and environment graph; pins the
  base root-only at mode `0700`; locks every descendant directory
  shallow-first; re-proves the complete graph; and re-proves each original
  logical ancestor chain before and after descriptor-bound changes. The base
  receives its final metadata only after all descendants. It then copies the
  frozen source into fresh root-owned inodes.
  The original runtime and environment are quarantined before atomic
  name replacement. A writable descriptor retained by the application
  therefore refers only to the quarantined/unlinked source and cannot mutate
  the sealed target. Later strict verification requires `0440`.
- Before the first runtime metadata change, the bridge fsyncs a private
  transaction/authority/runtime/inode-bound normalization journal. Every
  freeze, rematerialization, runtime swap, environment swap, and commit
  checkpoint is replaced atomically and parent-directory fsynced. Every
  `seal` or `verify` invocation runs recovery first; boot/start recovery may
  also call `recover-normalization`. A committed checkpoint is finished
  idempotently. Any earlier checkpoint restores the exact verified bytes and
  original owner/group/mode tuple, or leaves the durable journal fail-closed
  when an adversarial path replacement makes exact recovery impossible.
- A predecessor under the modern environment is readable only while the same
  accepted transaction is in `recovery_required`, or is `running` in the
  `recovering` phase. A terminal recovered predecessor remains blocked and
  requires a new owner-authorized remediation. An expired bridge envelope is
  usable only when it was durably accepted before expiry and the allowed
  nonterminal journal now exists.
- `scripts/remote-v2-normalization-attestor-install.sh` is an exact-SHA/PAX
  source-bound, root transaction. It pins the e168 v2 control and replaced
  attestor hashes, requires the control to be idle, and holds both the
  descriptor-reproved root:root `0600` promotion control lock and the existing
  root:dominguez `0660` release/Sonar mutex through receipt publication,
  rollback, and marker removal. Under those locks it requires the recovery
  service and every promotion transaction unit to be provably inactive,
  repeats that check immediately before either attestor swap, and fails closed
  if systemd state cannot be queried.
- Install and strict restore publish a root-owned mode-`0600` maintenance
  marker both in bridge state and at the control plane's existing
  `bootstrap-in-progress.v1` boundary. Promotion systemd units therefore stay
  disabled across process death or reboot until the reviewed recovery command
  finishes or rolls back the exact transaction. Only the same exact-SHA
  normalization installer `recover` command may interpret and clear that
  maintenance schema; the general promotion bootstrap must remain fail-closed
  rather than treating it as its own bootstrap journal. Installation preserves
  the strict attestor and journals before replacement. A durable active receipt
  is finished rather than spuriously rolled back. Strict restoration writes
  and fsyncs its own bridge/strict/receipt-bound journal before the swap, then
  resumes an exact terminal restore or restores the bridge at every earlier
  phase. Strict restoration additionally requires completed promotion, v3
  escrow, observed 60-second soak, exact target, and production `0440`
  environment evidence.

That v2 bridge remains a substrate, not an activation path. No current release
command can create its `v2_layout_normalization` owner envelope, and it must not
be installed independently.

The currently observed legacy production base below `/home/dominguez` does not
meet the root-exclusive-parent prerequisite because its parent is application
owned. The bridge intentionally rejects that layout before creating a
normalization journal or changing runtime metadata. Activation therefore also
requires a separately reviewed move to a root-exclusive parent (for example,
the governed `/srv/nexus-release` layout); weakening the parent check or
normalizing the existing home-directory path in place is not permitted.

The repository now also contains a separate, sequential release-layout
activation transaction. It does not weaken that parent rule. Instead, while
each role is stopped, it atomically renames the complete legacy application
base into a root-only transaction below
`/srv/nexus-release/layout-predecessors/<migration-id>/`, rematerializes the
strict `/srv/nexus-release/{staging,production}` bases, and exposes them at the
unchanged `/home/dominguez` application paths with exact bind mounts. The
worker home itself is never renamed, re-owned, or made non-traversable. A boot
recovery command reconstructs missing compatibility mounts only after it
revalidates the terminal attestation, home identity, and authoritative target
inodes.

The migration takes an advisory online SQLite recovery point before outage,
then, after PM2 is stopped and `/proc` proves there are no process references
to the protected predecessor, checkpoints WAL and saves an exact private
stopped-boundary database copy. The root journal binds the source inode, digest,
size, observation evidence, and copy evidence. During recovery, the exact live
inode is stopped, checkpointed, and re-attested first so writes accepted after
availability returned are preserved. An unhealthy or identity-drifted live
database falls back to the stopped copy; the earlier online point is used only
when failure occurred before the stopped boundary. Snapshot restore
removes the bounded SQLite WAL, shared-memory, and rollback-journal sidecars
before restart so superseded pages cannot replay. Both recovered role roots
remain root-pinned while runtime and database bytes are re-attested. Their
original metadata is restored only immediately before the guarded process
start.

Activation installation is two-phase and checkpointed. Phase A installs exact
protected-main source bytes, the exact preflight, boot-first recovery unit, PM2
startup guard, layout controls, and sudoers surface while leaving the running
PM2 and ingress process identity unchanged. It requires the already-installed
root-owned PM2 closure, holds the ordinary control and release/Sonar locks,
then consumes the legacy installer's canonical, receipt-bound retirement plan.
That plan must bind every legacy-v2 transaction as terminal, all 12 adapter
targets and their predecessor dispositions, the v2 control and service state,
and the shared application-DR SQLite helper as a retained dependency. Phase A
independently validates the fixed target allowlist, journals every active byte
and metadata field, applies the predecessor dispositions, and checkpoints
completed asset retirement before removing the v2 receipt or replacing its
control. The shared SQLite helper is never removed or restored and must remain
byte-for-byte and metadata-identical before and after both installation and
recovery. An interrupted Phase A restores its journaled targets and PM2 remains
blocked until the retained recovery anchors publish a verifiable rollback
receipt.
Phase B is a separate reversible handover after a successful layout
attestation. It validates layout readiness before taking the shared locks,
then revalidates the attestation digest and inactive promotion state while
holding them. It also proves the PM2 and ingress PID/start/restart identity is
unchanged across the unit-file handover; it does not restart either service and
requires a reboot.

The activation path is production-capable but remains fail-closed until its
live prerequisites exist. Phase A invokes `assert-root-pm2-ready` from the
exact archive-verified protected-main source before replacing an older
installed promotion control, then invokes the installed reviewed control and
requires byte-identical PM2 closure proof. This permits a safe upgrade from the
legacy interface without trusting it to implement the new assertion. The
Phase A receipt binds that proof and the installed deep KVM verifier.

KVM provisioning generates one dedicated Ed25519 hypervisor evidence key and
one distinct guest evidence key inside each fixed guest seed. It publishes the
canonical public keys and immutable scenario-to-guest mapping in the
root-owned, mode-0600
`/var/lib/nexus-rollback-drill-vm/release-layout-evidence-trust.v1.json`.
That manifest binds the active provision receipt digest, provision set ID,
guest SSH host-key digests, QEMU digest, reviewed runner digest, and the exact
SHA-256 digests of the root controller, controller unit, deep verifier, guest
executor, and guest boot-recovery unit. The fixed
mapping is `ssh_disconnect_after_pm2_stop` to `guest-1`,
`failed_health_check` to `guest-2`, and
`host_reboot_during_migration` to `guest-3`.

`release:layout-fault-drill prepare` accepts only that trust manifest. It
creates a random 256-bit challenge and binds its raw digest, active provision
receipt digest and set ID, all four canonical public keys, exact source
identities, fixed producer paths/digests, strict sequential execution policy,
and migration ID. Each
hypervisor isolation observation and guest execution result repeats the
challenge and canonical plan SHA-256. Sign the exact JSON bytes inside the
matching lab authority: the hypervisor private key remains root-only in the
provisioned set and each guest private key remains inside its isolated guest.
The root controller is the only production scenario-result producer. It starts
one fixed guest at a time, observes the live QEMU process, SSH/boot boundary,
and recovery interval, then asks the guest root executor to seal its measured
transaction. The guest executor cannot emit production evidence in test mode.
The controller invokes `collect`, which re-verifies every nested producer
digest, observation, signature, and result digest before producing the
owner-signable `nexus.release-layout-fault-drill.v1` payload. There is no
operator-facing `record` command.

```bash
npm run release:layout-fault-drill -- prepare \
  --migration-id <uuid-v4> \
  --source <exact-source-identities.json> \
  --trust-manifest \
    /var/lib/nexus-rollback-drill-vm/release-layout-evidence-trust.v1.json \
  --output <plan.json>

sudo /usr/local/libexec/nexus-rollback-drill-vm/\
release-layout-fault-controller submit <plan.json>

sudo /usr/local/libexec/nexus-rollback-drill-vm/\
release-layout-fault-controller status <plan-id>

# After status=completed, copy the immutable owner-signable payload from:
# /var/lib/nexus-rollback-drill-vm/release-layout-fault-drills/
#   <plan-id>/fault-drill.json
```

The hypervisor controller signs the isolation observation together with the
exact guest-execution digest, guest boot identity, and monotonic observer
record. Each guest signs only its own execution result. Do not move a guest
private key to the host, reuse a production key, or use one key for two roles.
Before submission, install the dedicated lab SSH private key that corresponds
to the provisioned public key as the root-owned, single-link, mode-0600
`/etc/nexus-release/rollback-drill-vm-ssh-private.pem`. The evidence JSON is the
controller's collector output; do not hand-author success booleans or use
OpenSSL to manufacture scenario records.

The root broker first verifies the active root trust manifest and provision
receipt, owner request/drill signatures, and every nested hypervisor/guest
signature. It refuses activation while KVM provisioning is incomplete. It
then copies the exact envelopes, re-verifies both proof layers, revalidates
Phase A and the PM2 closure, and binds all verification digests into the
durable submitted journal. The journal records the acceptance instant and it
must fall inside the signed request's creation/expiry window before the active
marker can be published. The systemd transaction repeats those checks
immediately before changing the journal to `running`; after the accepted
request later expires, recovery must supply the root-owned accepted transaction
journal and its exact immutable request envelope to the narrow
`--accepted-recovery-journal`/`--accepted-request-envelope` verifier mode.
There is no fresh expired-submission path. A Mac or SSH loss after
submission cannot weaken or own recovery. If power is lost after the submitted
journal is durable but before the active marker is published, boot recovery
accepts at most one nonterminal orphan, repeats admission verification,
reconstructs the marker, and resumes the one transaction. Ambiguous, unsafe,
multiple, or out-of-window orphan journals fail closed. Operator-authored
unsigned JSON, arbitrary plan-controlled keys, the ordinary promotion drill,
repository tests, reused keys, cross-plan evidence, and an owner signature
over evidence with invalid machine signatures all fail closed.

ServerDominguez must still install Phase A from protected main, retain the
three real KVM outcomes, and receive explicit owner authorization before the
one-time migration. Until those live facts exist, report the environment as
`NOT_ACTIVATED`; do not describe repository tests as production evidence.

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
