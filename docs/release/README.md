# Release paths

Nexus Hub has **one default release path and one fallback**.

| Path | Status | Document |
| --- | --- | --- |
| Continuous deployment (containers, unattended) | **default** | [`continuous-deployment.md`](continuous-deployment.md) |
| Lean PM2 promote (owner-approved, manual) | fallback during cutover only | this document, below |

After the one-time owner-authorized first container cutover, green CI on
protected `main` publishes signed container images and the VPS poller deploys
them: staging, then production with a 60-second observation window and automatic
predecessor rollback. No second per-release owner approval is involved. Read
[`continuous-deployment.md`](continuous-deployment.md) first — it is the canonical
description of how releases now work.

## The PM2 fallback

Everything from "Lean production release" onwards describes the **previous**
owner-approved PM2 promote path. It is retained deliberately, for exactly one
purpose: to be the manual fallback for the first container cutover.

Removal criterion: **14 stable days** after the first successful containerized
production release. That is a calendar criterion, not a release count — a quiet
fortnight with no releases still counts, because what is being proven is that the
container path holds, not that it has been exercised N times.

While it is retained:

- ordinary CI no longer produces a release bundle; the owner-dispatched
  fallback checkpoint rebuilds the exact verified protected-main SHA on its
  Ubuntu 24.04/x86-64 hosted runner, verifies the bundle, and uploads it only
  for this temporary path;
- SonarQube has been decommissioned from the repository and release control
  plane, and its coexistence gate was removed from
  `scripts/remote-user-release-transaction.sh`; references to Sonar below are
  historical, while any real-host remnants still require owner verification;
- `docs/release/release-state.json` is now a generated, non-authoritative
  projection with no authority over signed container CD. The frozen manual
  checkpoint still consumes it only as part of the temporary PM2 fallback
  evidence described below.

Do not extend this path. Fixes belong in the continuous-deployment path.

---

## Lean production release (fallback)

Nexus Hub uses one exact protected-main source, one checkpoint-built artifact,
one explicit release checkpoint, one staging transaction, and one
owner-approved production transaction.
Release work is sequential. SonarQube, mutation analysis, documentation
closeout, and backup retention jobs are not release gates.

## Invariants

- The target is the clean, exact current `origin/main` SHA. The operator
  refetches and reasserts that identity at the final boundary immediately
  before every staging or production transaction submission.
- Protected main must have successful `🧪 Tests`, `🔍 Lint & Type Check`, and
  `🔨 Build` checks.
- The owner-dispatched release checkpoint builds one Ubuntu 24.04/x86-64
  artifact from that exact SHA after verifying the protected-main checks. That
  checkpoint artifact is the only bundle staged or promoted; ordinary CI does
  not build or publish one.
- Protected main runs the selected safety/groups/dependents once. The release
  checkpoint runs only the untested deterministic remainder over four shards
  and proves that selected plus remainder is a disjoint, gap-free inventory.
- Python runs only when `content-engine/` changed since the deployed SHA.
- Migration sequence and cumulative application run only when `migrations/`
  changed since the deployed SHA. A migration-governance-only change requires
  its exact review-subject digest at checkpoint dispatch. The lean path still
  blocks irreversible migration SQL even when that digest is supplied; it
  cannot promote one until the canonical rehearsal and database-restore
  contract is implemented.
- Staging and production must pass health, exact `current`/completion-marker
  binding, an authenticated snapshot whose version equals that marker's
  `packageVersion`, read-only SQLite integrity and foreign-key checks, and
  stability checks.
- Production requires an exact `SHA:DIGEST` confirmation and
  `NEXUS_RELEASE_OWNER_AUTHORIZED=1`.
- The root-owned pre-promotion backup service must succeed before PM2 or
  `current` changes. No other promotion step runs as root.
- A failed health check or 60-second production soak restores the recorded
  predecessor automatically.

## Release checkpoint

Dispatch `.github/workflows/release-candidate-evidence.yml` with the exact
protected-main SHA. The deployed predecessor is read only from the protected
`docs/release/release-state.json`; it is not a dispatch input and must be an
ancestor of the target.

The workflow:

1. resolves one successful exact-SHA protected-main run;
2. verifies the three required check jobs and exact protected-main test
   evidence;
3. classifies the cumulative deployed-to-target diff into sorted release
   groups, then subtracts the exact protected-main selection and runs the deterministic
   remainder over four non-overlapping shards;
4. proves the selected/remainder union, then runs conditional Python and
   migration safety, accepting only exact-digest-reviewed governance-only
   changes and failing closed if the candidate contains irreversible SQL;
5. builds the runtime dependency archives and bundle from the exact checkout,
   then independently verifies and uploads that digest-named bundle;
6. publishes `release-checkpoint-<sha>/release-manifest.json`, binding that
   checkpoint-built bundle to the protected-main and checkpoint run identities.

The compact manifest schema is documented in
`docs/release/release-evidence-contract.md`.

## Stage

Once per server, or after ownership drift, run the idempotent preparation from
a reviewed root-owned checkout:

```bash
sudo scripts/lean-release-server-install.sh
```

It validates the two existing `/home/dominguez/telegram-hub-bot*` layouts,
normalizes their top-level ownership and the `releases/`, `data/`, and `logs/`
directory modes to `0700`, preserves their contents, prepares the private
transfer/state directories, and enables user systemd lingering. It does not
switch `current`, install a service, or touch release/data bytes.

From a clean checkout of that exact SHA:

```bash
npm run release:prepare
```

To select a particular successful checkpoint:

```bash
npm run release:prepare -- --checkpoint-run <run-id>
```

`release:prepare` downloads the compact manifest and the exact bundle from the
same successful checkpoint run. It verifies both locally, stores the manifest
SHA-256, and uploads the artifact once to
`/home/dominguez/.local/share/nexus-release/incoming/`, and submits a
`systemd-run --user` staging transaction. Immediately before each submission
(including both transactions in the optional fault drill), it requires a clean
unchanged checkout, refetches `origin/main`, and fails if protected main no
longer equals the prepared SHA.

The transaction copies the pristine bundle into the existing immutable layout:

```text
/home/dominguez/telegram-hub-bot-staging/
  .env
  current -> releases/<sha>-<digest-prefix>
  data/
  logs/
  releases/
```

Production Node modules and Python site-packages are built once in the manual
checkpoint and stored as two digest-bound archives. The transaction only
verifies and safely extracts those archives, recomputes an expanded-tree
receipt, and verifies that receipt before PM2. It does not run npm, pip, venv creation,
Vitest, a build, or Sonar. It atomically switches `current`, recreates only the
two staging PM2 processes from the exact selected runtime, proves artifact
parity, migration-backed startup, exact selector and package-version identity
through an authenticated runtime smoke,
read-only SQLite integrity and foreign-key integrity, and predecessor rollback
readiness, then records:

```text
/home/dominguez/.local/state/nexus-release/staging.json
```

The local operator stops with `ownerApprovalRequired: true`.

For the one required staging rollback proof on a new candidate, run:

```bash
NEXUS_RELEASE_DRILL_AUTHORIZED=1 \
  npm run release:prepare -- --staging-fault-after-switch
```

This explicitly fails the staging transaction after `current` and PM2 switch,
requires predecessor health recovery within the 120-second objective, removes
the failed candidate directory, records the drill journal, and then stages the
same exact uploaded artifact normally. The option is rejected for production
and cannot be applied to an already-passing staging candidate.

## Promote

Inspect the exact identity:

```bash
npm run release:status
```

Then provide explicit approval:

```bash
NEXUS_RELEASE_OWNER_AUTHORIZED=1 \
  npm run release:promote -- \
  --confirm <full-sha>:<artifact-sha256>
```

The Mac submits a user-owned one-shot transaction and polls its state. Losing
the Mac or SSH connection does not stop the server transaction.

Before SSH, promotion independently validates the manifest against the exact
target SHA, artifact digest, and canonical deployed predecessor. It revalidates
the checkpoint run, re-downloads the exact manifest artifact, and requires
byte-for-byte and SHA-256 equality with prepared state. If the cumulative
release groups include `chat-secretary`, the latest `local_engine` evaluation
for that exact target SHA must have passed before even a resume-state SSH
query. An unrelated release skips the chat evaluation automatically. This
decision never uses the protected-main `selectedGroups`, and there is no bypass
environment variable. After these checks and immediately before the production
`systemd-run` submission, the production helper again requires a clean
unchanged checkout, refetches `origin/main`, and rejects a branch advance.

The production transaction:

1. verifies the pristine incoming bundle again;
2. requires the observed production `current` predecessor SHA to equal the
   protected manifest's canonical deployed SHA;
3. safely extracts the prebuilt dependency archives into the immutable
   production release and verifies the expanded-tree receipt without touching
   `current`;
4. records the predecessor path, SHA, and digest in durable state;
5. runs only
   `sudo -n /usr/bin/systemctl start nexus-local-backup-pre-promotion.service`;
6. atomically switches `current`;
7. recreates the two production PM2 processes from the exact release directory
   and release SHA;
8. after candidate health passes, proves the authenticated snapshot version,
   exact `current` target, completion marker, and read-only SQLite integrity and
   foreign-key results;
9. checks both health endpoints for 60 seconds;
10. restores and health-checks the predecessor on failure;
11. retains five production and three staging releases after availability.

Production keeps the existing layout:

```text
/home/dominguez/telegram-hub-bot/
  .env
  current -> releases/<sha>-<digest-prefix>
  data/
  logs/
  releases/
```

Remote transaction state is
`/home/dominguez/.local/state/nexus-release/production.json`; local evidence is
under ignored `.local/release/`.

The transaction journal records the configured stability interval and exact
soak start/completion timestamps. A passing production journal is invalid
unless it proves at least 60 seconds. Candidate and predecessor health budgets
are recorded as 45 seconds each; predecessor recovery has a hard 120-second
deadline and records its measured duration.

## Shared backend/iOS closeout

An iOS release that consumes a changed backend contract adds a post-promotion
gate; it does not add fields to the backend checkpoint manifest. Before backend
promotion, the protected iOS contract workflow decodes the exact release-bound
fixture and emits a signed `nexus.ios-contract-attestation.v2`. After the exact
backend production transaction passes, Xcode Cloud may build the same iOS SHA
and source build number and emit signed
`nexus.ios-distribution-attestation.v2` evidence.

Before TestFlight group assignment, App Store submission, or user release,
dispatch the owner-only protected-main workflow
`.github/workflows/shared-ios-release-gate.yml` in the `production-release`
environment. Supply the exact successful checkpoint run identity plus canonical
base64 for the passing production transaction and both signed iOS
attestations. The workflow resolves the checkpoint manifest and checkpoint-built
bundle by immutable GitHub artifact IDs, runs the gate below, revalidates the
receipt identity, and publishes the only governed release-authorization
artifact. A local CLI receipt is diagnostic evidence and cannot substitute for
that successful workflow run.

The workflow invokes the equivalent of:

```bash
node scripts/shared-ios-release-gate.mjs \
  --manifest <release-manifest.json> \
  --bundle <exact-pristine-release-bundle> \
  --production-state <passing-production.json> \
  --ios-contract-attestation <ios-contract-attestation.json> \
  --ios-distribution-attestation <ios-distribution-attestation.json> \
  --expect-backend-runtime-sha <full-backend-sha> \
  --expect-ios-sha <full-ios-sha> \
  --expect-ios-build-number <source-build-number> \
  --output .local/release/shared-ios-release-gate.json
```

The command reuses the canonical backend manifest and transaction validators,
recomputes the exact artifact and fixture identities, verifies both Ed25519
signatures against the pinned public keys, requires matching iOS SHA/build
identity, and proves the distribution attestation was generated after backend
production completed. Only a `result: "passed"`
`nexus.shared-ios-release-gate.v1` receipt closes the shared release only when
it is uploaded by the successful owner-dispatched workflow. Contract
compatibility evidence may predate backend promotion; distribution evidence
may not. Record the workflow run ID and receipt artifact before any App Store
Connect mutation.

## Chat capability transactions

After the governed chat-flag operator is merged into protected main and its
exact artifact is deployed, use only:

```bash
npm run release:chat-flags -- inspect ...
NEXUS_RELEASE_OWNER_AUTHORIZED=1 npm run release:chat-flags -- apply ...
npm run release:chat-flags -- inspect-secrets ...
NEXUS_RELEASE_OWNER_AUTHORIZED=1 npm run release:chat-flags -- apply-secrets ...
npm run release:chat-flags -- inspect-shadow-hook ...
NEXUS_RELEASE_OWNER_AUTHORIZED=1 \
  npm run release:chat-flags -- apply-shadow-hook ...
npm run release:chat-flags -- inspect-observation ...
NEXUS_RELEASE_OWNER_AUTHORIZED=1 \
  npm run release:chat-flags -- apply-observation ...
```

The command is hardcoded to `ServerDominguez` and has no host override. AWS is
not a release or flag target. Run from a clean checkout of the exact installed
runtime SHA and pass the full runtime SHA and artifact digest. Inspect creates
one redacted, exact-release-bound, sequence-bound plan; apply accepts and
consumes only that exact `sha256:<plan-digest>`. It runs detached through user
systemd and publishes a strict durable receipt. A failed or partial claim is
never replayable.

The sole historical exception is the exact 4.14.232 staging shadow-hook claim
whose rollback predated explicit effective-state persistence. Follow
`docs/release/chat-quality-operations.md` section “One-time 4.14.232
shadow-hook claim recovery”: protected-main inspect, owner acknowledgement of
the exact hash-bound repair plan, repair only the missing deterministic claim
field, then let the exact installed operator finish normal rollback recovery.
The exception does not authorize manual marker deletion or a new release over
unresolved state.

The second and only other historical exception is the exact failed staging
observation `20260805T163302Z-2522779e6416` on runtime `39965e357d19...`.
Follow the one-time failed observation publication recovery in
`docs/release/chat-quality-operations.md`: protected-main inspect, owner
acknowledgement of the exact hash-bound plan, then publication of a distinct
`failure_acknowledged` receipt and byte-identical sidecar. That receipt closes
the incomplete attempt for release serialization only; it is never passing
flag evidence and cannot authorize a production flag enable.

Gate evidence is collected natively on ServerDominguez from the installed
artifact, isolated staging `.env` and SQLite database, authenticated health,
and `/chat-quality`; the operator accepts no evidence file and makes no
provider call. Routing enables require an explicit immutable canonical UTC
`--since`/`--until` window and always use the fixed minimum of 200 comparisons
at 0.99 or greater agreement. The manifest-prompt enable runs the compiled
installed action-skill evaluator cache-only, requiring 300/300 exact-bound
rows, at least 0.95 agreement, and zero provider calls. Cross-skill staging
inspect binds the compiled preflight JSON.

The four routing surfaces first require a separately governed staging-only
shadow-recorder transaction. `inspect-shadow-hook` attests the dedicated
synthetic evaluation principal in the isolated staging database, both evidence
HMACs present, every capability and master-kill assignment OFF, and every
shadow-planner scope OFF. `apply-shadow-hook` changes only that principal's
exact USER and TENANT route-hook assignments; the global hook remains OFF and
the planner remains OFF. A routing window may begin only after the immutable
passed enable receipt. The divergence report binds that receipt, authenticated
live release-attestation v2 bytes, the dedicated effective scope, target flag
OFF, and telemetry `recorderState` for every eligible bundle. Missing, mixed,
or planner-enabled recorder state fails the complete gate. Disable the
recorder through the same exact-plan transaction after routing collection.

The staging observation is a separate, owner-gated transaction. After the
exact staging ON receipt is at least five minutes old, `inspect-observation`
creates a one-hour, sequence-bound plan for that exact release and flag;
`apply-observation` acknowledges and consumes only its exact digest. It
revalidates the ON receipt and contiguous configured/effective prefix, master
kill OFF, the expected next production sequence, installed smoke bytes, and
every ChatV2 shadow-planner scope effectively OFF. It then runs the canonical
staging smoke exactly once and publishes immutable raw smoke plus a strict
observation receipt.

The canonical v2 locale profile uses token-zero authenticated-identity turns
for English and Portuguese plus a legacy Spanish-request-to-English
compatibility turn. It proves that exact identity/language contract; it no
longer claims task-write planner or model-authored locale coverage. Before any
dependent fixture write, users `1000014` and `1000016` must be absent or match
their exact synthetic ID/Telegram/email/username/auth-provider markers. A
collision fails closed; an absent fixture uses a plain insert, an exact fixture
uses a guarded update, and neither principal is ever replaced. The
observation additionally requires zero all-status durable alert activity for
the chat-quality and ChatV2 retirement sources since enable, and zero
staging-database-wide `api_usage` and hard-ceiling reservation row/cost deltas
during the observation. The hard-ceiling table is one governed pre-network
reservation ledger, not a universal claim about every possible
provider-attempt path. For
`AI_CROSS_SKILL_EXECUTION`, the same owner-gated observation also runs and
binds the installed dedicated Training cross-skill staging smoke. All runtime
reads share one directly opened readonly, `query_only` SQLite handle through
the standalone global-database scope. The smoke never initializes the
application database, runs migrations/backfills, or writes; it restores the
scope and closes its owned handle.

Production inspect does not run staging traffic. It is selector-only,
read-only, and provider-free: it selects the exact strict observation receipt
and bound raw smoke already published by the staging observation transaction.
Production apply re-fetches and revalidates those exact bytes and the live
staging flag evidence immediately before mutation.

Operate the seven flags strictly in runbook order, one new flag at a time:
staging gate inspect, owner-authorized staging apply, five-minute maturity,
observation inspect and owner-authorized observation apply, production
inspect, owner-authorized production apply, then another minimum five-minute
production observation. A production enable plan binds the exact passing
staging ON and observation receipts. Production apply revalidates them, the
complete configured/effective prefix, master-kill state, exact staging
release, and live staging health immediately before mutation.

Every staging and production release transaction starts only when all seven
capability flags are omitted (runtime-default OFF) or canonically configured
`false`, and when every global, USER, and TENANT route-hook and shadow-planner
scope is effectively OFF. Return any enabled flags and the dedicated recorder
to OFF through their governed rollback transactions before staging or
promoting a later candidate; ON receipts and evidence never transfer to a new
release identity.

Provision `CLASSIFY_SHADOW_HASH_SECRET` and
`CHAT_CORE_V2_SHADOW_ROUTE_HMAC_SECRET` through `inspect-secrets` and
`apply-secrets`, never argv values. Existing values are preserved. Staging may
generate either missing value; production must preserve an existing classifier
HMAC but may generate the missing ChatV2 route HMAC. Plans and receipts expose
actions only, never secret values or derived hashes, fingerprints, or lengths.

During `.env` mutation, a short-lived runtime permit binds the exact
transaction, plan, release, environment bytes, configured state, controller,
phase, and expiry. Runtime flag readers fail closed when a durable transaction
marker exists without that exact live permit. Failed activation restores the
private preimage atomically, restarts only the backend, and health-checks the
restored state. Unresolved backups or unpublished receipts block the next
release. Use a one-flag OFF transaction for ordinary rollback.
`AI_ROUTING_MANIFEST_KILL=true` is the emergency all-capability rollback;
clear it only after all seven individual flags are configured OFF.

This section defines the required process. It does not assert that any Phase 7
flag has been enabled in staging or production; only exact transaction
receipts and live evidence can establish that state. Full gate details are in
`docs/release/chat-quality-operations.md`.

## Failure handling

- A host without a verified predecessor is not eligible for the lean release
  path. `NEXUS_RELEASE_ALLOW_FIRST_INSTALL` is explicitly unsupported; use a
  separately reviewed bootstrap or adoption process instead.
- A missing or ambiguous exact-SHA CI/checkpoint run fails closed.
- Artifact or manifest drift fails before upload.
- A staging failure restores its predecessor when one exists and cannot become
  promotable.
- A backup failure stops before production mutation.
- A production start, health, or soak failure switches `current` back to the
  predecessor, reloads its PM2 processes, and verifies health. Candidate and
  predecessor health waits are each capped at 45 seconds, and recovery
  duration is recorded against the 120-second objective.
- If automatic predecessor recovery also fails, the transaction state is
  `rollback_failed`; do not retry promotion until service health is restored.
- A governance-only migration-safety change is promotable only when the
  checkpoint input exactly matches its generated review-subject SHA-256; that
  digest is recorded separately in the compact manifest. Irreversible
  migration SQL is not promotable through the lean path. Supplying its exact
  review subject does not replace the rehearsal, stopped-state backup, or
  database-restore contract in `docs/release/migration-irreversible.md`.

## Advisory quality and timing

SonarQube is decommissioned (ADR-0012). `npm run quality:sonar`, the
`scripts/quality-sonar-*` scripts and `ops/sonarqube/` no longer exist, and
nothing in this path consults a Compute Engine state. Static quality evidence is
now CI-native: the changed-area classifier, the risk gate, lint, typecheck,
tests, dependency/security scanning and the docs audit. See
`docs/release/continuous-deployment.md > Static quality evidence`.

Record protected-main, checkpoint, staging, approval, promotion, and soak
timestamps for ten releases. Targets are p50/p95 of 3/5 minutes for normal CI
and 7/9 minutes for the checkpoint, excluding queue and owner approval.

## Retired machinery

The previous signed `ReleaseManifestV2`, separate signing workflows, staging
signatures, evidence-shadow activation, duplicate RC build/test path,
root-owned promotion control, KVM fault-drill environment, layout migration,
and legacy rollback/restore scripts are retired. Git history is the recovery
source for their code. The installed legacy units were removed after the lean
path completed its first staging and production proof.

After that proof, inspect the exact allowlisted retirement plan:

```bash
sudo scripts/retire-legacy-release-machinery.sh
```

Then apply it with the exact passing production identity and explicit owner
authorization. Run this from the reviewed checkout on ServerDominguez. The
named root transaction is detached from SSH; do not add `--wait` or `--pipe`:

```bash
RETIREMENT_IDENTITY='<full-sha>:<artifact-sha256>'
(
set -euo pipefail
RETIREMENT_UNIT="nexus-release-retirement-$(date -u +%Y%m%dT%H%M%SZ)"
RETIREMENT_SERVICE="${RETIREMENT_UNIT}.service"
RETIREMENT_CHECKOUT="$(pwd -P)"

sudo /usr/bin/systemd-run \
  --unit="$RETIREMENT_UNIT" \
  --no-block \
  --property=Type=exec \
  --property=RemainAfterExit=yes \
  --working-directory="$RETIREMENT_CHECKOUT" \
  --setenv=NEXUS_RELEASE_OWNER_AUTHORIZED=1 \
  "$RETIREMENT_CHECKOUT/scripts/retire-legacy-release-machinery.sh" \
  --apply --confirm "$RETIREMENT_IDENTITY"

RETIREMENT_TERMINAL=false
for ((attempt=1; attempt<=90; attempt++)); do
  RETIREMENT_ACTIVE="$(
    sudo /usr/bin/systemctl show "$RETIREMENT_SERVICE" \
      --property=ActiveState --value 2>/dev/null || true
  )"
  RETIREMENT_SUB="$(
    sudo /usr/bin/systemctl show "$RETIREMENT_SERVICE" \
      --property=SubState --value 2>/dev/null || true
  )"
  case "$RETIREMENT_ACTIVE:$RETIREMENT_SUB" in
    active:exited|failed:*)
      RETIREMENT_TERMINAL=true
      break
      ;;
    *) sleep 2 ;;
  esac
done

sudo /usr/bin/systemctl show "$RETIREMENT_SERVICE" \
  --property=ActiveState,SubState,Result,ExecMainStatus,InvocationID \
  --no-pager
sudo /usr/bin/journalctl --unit="$RETIREMENT_SERVICE" \
  --output=short-iso --no-pager

if [ "$RETIREMENT_TERMINAL" != true ]; then
  echo "retirement transaction is still running; leave it detached and inspect again" >&2
  exit 1
fi

test "$(sudo /usr/bin/systemctl show "$RETIREMENT_SERVICE" \
  --property=ActiveState --value)" = active
test "$(sudo /usr/bin/systemctl show "$RETIREMENT_SERVICE" \
  --property=SubState --value)" = exited
test "$(sudo /usr/bin/systemctl show "$RETIREMENT_SERVICE" \
  --property=Result --value)" = success
test "$(sudo /usr/bin/systemctl show "$RETIREMENT_SERVICE" \
  --property=ExecMainStatus --value)" = 0
sudo /usr/bin/systemctl stop "$RETIREMENT_SERVICE"
)
```

The retirement command fails closed unless the passing production transaction,
completion marker, `current` symlink, PM2 cwd/SHA identity, and both production
health endpoints still agree. It also refuses direct apply outside the named
detached service, holds both release/Sonar locks, and keeps a persistent
blocker backup guarded until the canonical PM2 handoff succeeds. It removes
only its audited legacy allowlists.
It preserves `/var/lib/nexus-release`, Ollama, any separately owner-gated Sonar
host remnants or backups, and the lean transaction state; it neither proves
Sonar uninstall nor prunes that evidence. It intentionally never mutates AWS
paths. The separately
authorized AWS closeout removed the server AWS callers, configuration, and
credentials; only the compliance-locked application bucket remains until its
retention can be reverified after `2027-02-03T16:24:28Z`.

AWS is not part of release, backup, SonarQube, or promotion.
