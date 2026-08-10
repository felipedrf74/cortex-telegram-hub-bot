# Continuous deployment

Green CI on protected `main` deploys to production automatically. There is no
owner approval step, no typed `SHA:DIGEST` confirmation, and no
`NEXUS_RELEASE_OWNER_AUTHORIZED` gate in this path.

After the one-time owner-authorized container bootstrap, recovery, not
prevention, is the primary safety mechanism (ADR-0010). Pre-flight gating is
reduced to the failure modes a rollback provably cannot undo: irreversible
migrations, secret leaks, and a release that degrades under observation.
Everything else is caught by restoring the predecessor image pair inside a
120-second objective.

That objective cannot apply before a container predecessor exists. The ordinary
timer refuses the first cutover; a separate non-enabled one-shot requires a
fresh owner baseline and an exact PM2 fallback transaction. The 120-second
automatic objective begins only after the first completed container receipt.

Bad code can reach production briefly. That is the deliberate trade.

## The pipeline

```text
push to main
  │
  ├─ CI (.github/workflows/ci.yml) — TEST RUNNER ONLY
  │    classify · lint/typecheck · risk-selected tests · docs+secrets
  │    migration safety (+ cdEligibility) · six-example backend/iOS fixture test (if owned bytes changed)
  │    no registry credential, no Docker, no deploy path
  │
  ├─ Release (.github/workflows/release.yml) — HOSTED x86_64 ONLY
  │    protected-main push immediately cancels any older in-flight publisher
  │    build job: install dependencies; recompute and compare full migration verdict
  │               publish both application images under source-SHA-only tags
  │               emit only a closed JSON/Compose handoff bound by digest + artifact ID
  │    fresh signer job: no npm install or build lifecycle before key exposure
  │                      verify exact handoff, CI provenance, and current main head
  │                      sign, verify public pin, publish manifest + Compose payload/pointer
  │
  └─ VPS poller (root, every 30s, kernel flock)
       verify signature, identity, digests, exact public protected-main head
       staging: migrator → up → health → smoke
       production: backup → ledger + exact-backup recheck → final head → write-ahead
                   → migrator → up → 60s observation → exact image proof
       pass → completed          fail → restore and prove predecessor topology/images
```

The installed units load `poller.env`, explicitly remove loader controls, then
start every preflight and command through `/usr/bin/env -i`. Poller/bootstrap
forward only the audit host and dedicated Telegram bot/chat; heartbeat forwards
only the Telegram pair. Absolute Node, Git, flock, systemctl, Docker, SQLite,
lsof, scp, and ssh paths are reintroduced by the unit. `poller.env` therefore
cannot substitute a safety probe/runtime command or inject `DOCKER_*`,
`COMPOSE_*`, `NODE_OPTIONS`, `LD_*`, or `GIT_*` control. Compose receives a
second minimal allowlist and `COMPOSE_DISABLE_ENV_FILE=1`, so neither ambient
operator values nor a checkout `.env` becomes render authority. Both lock
pathnames come solely from `config/continuous-deployment.json`; the wrapper has
no environment path override. Both one-shots use `TimeoutStartSec=infinity`: their narrower policy
deadlines still bound migrators, backup, health, observation, and rollback, while
systemd cannot kill the process merely because individually valid discovery and
mutation phases exceeded a guessed aggregate.

The immutable host control plane is built only in its transient staging tree.
Each Git, npm, and Node builder command runs as the dedicated non-login build
account in a collected systemd `Type=exec` service with
`KillMode=control-group`, `SendSIGKILL=yes`, and a read-only host filesystem
except for that staging tree. The installer waits for service termination, then
fails closed unless the whole build account has zero processes and recursive
`lsof` proves the candidate has zero open handles without diagnostics. Those
proofs precede the root `chown`, write-bit removal, immutable-version move, and
active-link swap, so a lifecycle-script descendant or retained descriptor
cannot mutate code after it becomes root-owned or executable by release units.

The lifecycle-controlled Git directory is not publication evidence: the
installer first binds a root-held exact tracked-file manifest to the reviewed
commit, re-proves every tracked byte and rejects all extras except governed
`node_modules`, then removes `.git`. A recursive digest over path, type, mode,
symlink target, and file bytes is stored inside and rechecked against the
root-owned candidate on every activation retry.

Install, upgrade, and rollback share the root-only
`/var/lib/nexus-release/locks/control-plane.lock` transaction boundary. Before
initial installation leaves that boundary, it exclusively creates, verifies,
and syncs the root-only container release mutex and its parent directory; an
exact existing mutex is accepted only for an idempotent retry. Upgrade and
rollback require that mutex to be present and exact rather than recreating it.
Before any timer or selector mutation, the installer syncs the complete candidate
filesystem and durably publishes the exact-schema, root-owned mode-0600
`/var/lib/nexus-release/state/control-plane-transaction.json`. That record binds
the request, original and target selectors, candidate digest and staging inode,
all four original timer active/enabled bits, and the current phase. Its presence
is also a systemd condition gate on bootstrap, poller, and heartbeat, so a crash
between individual selector, fixed-file, daemon-reload, or timer operations
cannot return release authority. A same-request retry acquires the same mutex
before build/admission, re-proves the record and immutable tree, reconciles only
the recorded pre/post identities, and resumes idempotently; a different mode,
SHA, repository, marker, selector, digest, unsafe remnant, or timer probe status
refuses. The gate is sync-retired only after selectors, installed capability,
sudoers and unit bytes, daemon reload, settled services, and the exact four
timer bits are re-proven. Effective systemd authority is closed too: all five
units must resolve to the governed `/etc/systemd/system` fragments with empty
`DropInPaths`; exact-name, dash-prefix, and type-wide drop-in tiers are rejected
across the clean-environment system unit search path. Initial mode additionally
proves all five physical unit definitions absent both before building and
immediately before publishing the gate. Rollback admits only the version
selected by `checkout.previous` and does not need GitHub, Git, or npm.

The push-time superseder is a credential-free no-op in the same constant
repository concurrency group as the publisher. It exists solely to cancel an
older publication as soon as protected `main` advances; it does not wait for the
new commit's CI and cannot publish. The successful push-CI `workflow_run` uses
two separate fresh hosted jobs. The dependency/image builder receives only its
ephemeral package-write token, never the `release-publish` environment or
long-lived manifest key. After publishing backend and content-engine images
under source-SHA tags, it uploads exactly the hosted migration JSON, Compose
file, and a closed-schema digest manifest under one immutable artifact ID. A
fresh signer downloads that ID, rejects extra/non-regular/symlinked or changed
files, checks every job-output identity and digest, revalidates the GitHub-owned
CI/check-suite provenance and public protected-main head, and only then exposes
the key to the built-in-only signer, which verifies its output against the
committed Ed25519 public pin before publication. It runs no dependency
installation or application/image build before that secret step. The signed
release payload's `:main` tag is only a moving discovery pointer: workflow
cancellation is not atomic with an in-flight OCI tag push. The VPS therefore
uses pinned `/usr/bin/git` and a bounded, credential-free `ls-remote` against the canonical
public repository to require the signed source SHA to equal the current
protected-main head at initial admission, after staging, and once more
immediately before production write-ahead. A lookup outage defers without
mutation; a changed head tears down and atomically retires the exact staging
candidate. The exact completed-payload no-op remains receipt-driven and does not
require the network.

The content-engine image and the temporary PM2 fallback dependency archive use
the same generated Python 3.12/linux-amd64 release lock. Every direct and
transitive requirement is exact and carries an accepted SHA-256; both builders
invoke pip with `--require-hashes --only-binary=:all:`. The human-maintained
`content-engine/requirements.txt` remains the reviewed direct dependency
source, and CI rejects source/lock drift before either release artifact can be
published. Required CI checks the committed source digest, direct pins, hashes,
and resolver metadata without depending on runner architecture. The hosted
Security job, image publisher, and owner-triggered fallback publisher each
reproduce both locks with the pinned resolver. Image publication stops before
registry login and fallback publication stops before bundle construction if
either byte stream differs. New fallback artifacts write dependency lock v3 and
extraction receipt v2 only. The explicit predecessor-read command can also
verify an exact paired v2 lock/v1 receipt so the first recovery-first cutover
does not strand the previous runtime; mixed or extra-field schema shapes remain
invalid.

Failures page the owner on a best-effort, non-gating channel. Notification
formatter, configuration, or transport failures are caught by orchestration and
cannot prevent rollback, receipt persistence, or the deployment verdict.
Successes are silent, which is why the weekly heartbeat exists: without it, a
broken notifier is indistinguishable from a quiet quarter.

## What the poller trusts

Two independently pinned facts: the signed release manifest inside the release
payload image, and the current public protected-main head.

`nexus.release-manifest.v2` is an Ed25519 envelope over a canonical-JSON payload
carrying the schema version, source SHA, workflow run identity, both image
digests, the Compose digest, the migration verdict digest, the complete
migration-reconciliation policy, and a timestamp. The poller verifies the
signature against a root-owned pinned public key, then verifies that the
repository, protected ref, workflow name and key id are the governed ones, then
verifies the Compose bytes hash to the signed digest.

Every rejection is fail-closed. An unknown key id, a drifted repository or
workflow, a non-protected ref, a malformed digest, a stale timestamp, or an
unexpected extra field all refuse the release rather than downgrading it to a
warning.

Host policy isolation is containment-aware, not equality-only. Staging and
production environment filesystem identities may not be ancestors or descendants
of one another, and every backend/content-engine environment path is distinct.
The authoritative receipt root may not overlap the audit queue or its
quarantine, exhausted, and delivered evidence roots.
The loader accepts only policy schema `nexus.continuous-deployment-policy.v1`
at implemented version `2026-08-09.2`. Top-level and nested objects have exact
keys; only `paths` is intentionally additive, and its catch-all requires every
added value to be a normalized absolute path. A future field or version cannot
silently acquire control semantics in an older poller.

Each environment has a root-owned mode-0600 backend/migrator file and a separate
minimal content-engine file. Before every Compose render, the host opens both
without following symlinks, requires effective-root ownership, one link, exact
mode and canonical `KEY=value` syntax, rejects Compose topology/release identity
from the backend file, rejects every non-engine key from the content file, and
forbids `NODE_*`, `LD_*`, `DYLD_*`, and TLS/OpenSSL loader controls that could
execute mounted bytes or replace trust before the signed Node entrypoint.
Both must carry the same non-empty `INTERNAL_API_SECRET`. The first accepted
pair of digests is pinned for that release process, so an operator edit cannot
change secrets between staging and production. Compose retains
`NODE_ENV=production` for both while the registry supplies the immutable
application isolation identity `STAGING=true` or `false` outside either file.
All three service mappings require Compose >=2.30.0 and use `format: raw`, so
`$`, backslashes, quotes, and comment-like bytes cannot interpolate from the
root process. Admission accepts only unquoted canonical raw values and rejects
legacy dotenv quote/inline-comment syntax whose effective bytes would change.

The moving `:main` tag on the payload image is only ever used to *discover* a
digest. Tag mutability grants no authority, because the signature covers the
whole release identity. An interrupted pre-production attempt resumes the exact
accepted OCI digest from state instead of reinterpreting a later moving-tag
publication as its evidence.

## Migration eligibility

Unattended deployment accepts only **predecessor-compatible expand and backfill**
migrations. That constraint follows from how rollback works: a rollback restores
the previous image pair and never an older database, so after a rollback the
predecessor code runs against the already-migrated schema.

`scripts/migration-safety-check.mjs` emits an independent `cdEligibility` result:

```json
{ "eligible": true, "predecessorCompatible": true, "reasons": [] }
```

This is deliberately **separate from `authorization.authorizesPromotion`**, which
answers a different question — whether an owner approved a specific irreversible
operation. Ordinary CD eligibility is never derived from that field. An
owner-approved destructive migration is still ineligible for an unattended
deploy.

| Classified as | Examples | Unattended? |
| --- | --- | --- |
| expand | tables whose foreign keys stay within same-migration objects, plain column indexes, unconstrained nullable columns with no default or a simple literal default, and views/triggers confined to same-migration objects | yes |
| backfill | ordinary `INSERT` and `UPDATE` (including non-destructive `OR IGNORE`/`ABORT`/`FAIL`) | yes |
| contract | `DROP TABLE/COLUMN/INDEX/VIEW/TRIGGER`, `RENAME`, `DELETE FROM`, `REPLACE INTO`, `INSERT OR REPLACE`, `UPDATE OR REPLACE`, or `OR ROLLBACK` writes | no |
| contract | `ADD COLUMN` with `CHECK`, `REFERENCES`, a generated/default expression, or any `NOT NULL` constraint on a pre-existing table; unique, expression, or partial indexes on a pre-existing table; foreign keys from new schema to a pre-existing table | no |
| unknown | anything the classifier does not positively recognize | no |

Only the governed `PRAGMA foreign_keys=ON|OFF|0|1` connection toggle is
classified neutral. Any other pragma that is not given an explicit safety rule
is unknown and therefore ineligible; persistent header, journal, or schema
effects never inherit a broad neutral default.

Objects created earlier in the same migration are tracked: constraints,
expression indexes, triggers, and foreign keys are additive only when every
object whose writes they can affect was definitely created by that migration.
The same syntax against a pre-existing table can reject a write the predecessor
would have made, evaluate an expression that throws for formerly accepted data,
or make a new child row block/cascade a predecessor parent write, so it is not
compatible. `CREATE ... IF NOT EXISTS` never proves ownership.

SQL comments are lexical whitespace for both the CD classifier and the
irreversible-migration scanner. Comment-separated forms such as
`UPDATE OR/**/REPLACE` and `DROP/**/TABLE` receive the same blocking verdict as
their ordinary whitespace spelling; a comment cannot glue tokens into a more
permissive classification.

Migration history is append-only once a file exists in the Git comparison base.
CI rejects modifying, renaming, or deleting that file even when its replacement
would still classify as predecessor-compatible; only a newly added filename may
introduce new bytes. The runtime ledger records filenames, and the staging
database is durable. Rewriting a filename could therefore make staging skip the
replacement bytes it already considers applied while production applies them
for the first time, defeating the rehearsal.

The classifier is itself governed. Changes to CD eligibility, manifest and host
admission, ledger reads, the runtime migration runner, application external-mode
admission, the one-shot migrator, or the release Docker/Compose packaging paths
are reported as migration-governance changes with an exact policy reason. An
eligibility implementation change therefore cannot remove itself from review.

Migration 283 is one deliberately narrow exception to the generic classifier,
not a general permission to run `DROP INDEX`. Its exact SHA-256 and three
ordered index-transition descriptors are bound into the signed reconciliation.
Each descriptor names the obsolete global index's exact unique table/columns
(or permits its absence) and the exact tenant-safe unique replacement that must
be created before the drop. Bootstrap checks each old name globally, so a
same-name index on another table cannot be dropped, and verifies each
replacement's live unique table/column definition before authorization. Any
byte change, reordered create/drop, drifted old definition, missing/wrong/non-
unique replacement, or policy drift restores the generic `contract` verdict
and fails closed. Apart from the one explicit column addition below, the
remainder of 283 is additive schema normalization, so the signed effective kind
is `expand`.

The same digest also binds its one exact
`content_idea_memory.feedback_sentiment TEXT NOT NULL DEFAULT 'generated'`
addition. The generic classifier blocks every pre-existing-table `NOT NULL`
addition; only this exact migration/statement pair is claimed by the 283
exemption. Any second constrained addition, different default, or byte drift
restores the contract verdict.

Contract migrations are deliberately blocked by the unattended poller. The
repository defines the required review, rehearsal, quiescence, snapshot, and
database-plus-runtime recovery contract in
`docs/release/migration-irreversible.md`, but it does **not** yet provide a
post-bootstrap container maintenance executor. The current approval artifact
does not bind an exact release/payload/predecessor or single-use authorization,
and no governed container traffic-drain and exact database-restore transaction
exists. Choosing those authority and recovery primitives is owner-gated. Until
Felipe approves that design and the one-shot path is implemented and proven,
the poller alerts, preserves `unresolvedContractMigrations`, and remains blocked;
the first-bootstrap exception must never be reused as a maintenance bypass.

The legacy PM2 ledger stores filenames rather than executed-byte hashes. In the
secretless hosted builder, ordinary lineage rows are read from their exact full
Git-history source commit and path. Five v4 `repository_archive` rows whose
original commits are not reachable in a hosted clone instead retain
`sourceCommit` as historical provenance metadata and bind the exact retired
bytes at
`docs/release/evidence/retired-migrations/<sourceCommit>/<file>`. The hosted
gate reads that archive only from one regular stage-0 `100644` entry in the
candidate Git index and verifies its SHA-256; it never falls back to a locally
available dangling commit or to worktree bytes. The archive is outside the
executable `migrations/` directory and outside the final runtime image. The
signed source-policy digest binds each mode and locator. CI also requires exact
byte equality for byte-identical renumbers and identical executable SQL after
deterministic comment/whitespace normalization for comment-only renumbers. The
signed environment mappings admit exactly the 19 production legacy rows and
those same 19 plus four notification-renumber rows in staging; a missing or
additional outside-inventory row is rejected. This proves the configured source
evidence bytes and declared replacement relationship, but neither independent
membership of an archived row in its historical `sourceCommit` nor execution by
the old PM2 process.

For the first container cutover, the owner accepts the quiesced databases as the
historical state boundary. The bootstrap baseline binds each database's exact
canonical inventory prefix, its exact signed legacy rows (currently 19 in
production and 23 in staging), and the remaining exact signed inventory suffix.
Every pending suffix row must be predecessor compatible; for the current
274-file inventory the suffix is the single migration 283. It rejects non-prefix
canonical history, missing or unknown legacy rows, a pending row outside that
exact signed suffix, open handles, and WAL/SHM/journal sidecars. An in-memory
rehearsal applies every exact packaged byte in the signed pending suffix to both
descriptor-bound snapshots, compares v2 semantic schemas that bind column
ordinals and a canonical token projection of each complete `CREATE TABLE`
statement (including collation, generated expressions, and table constraints),
excludes only the signed staging fixture table/index, and proves the fixture
rows and digest are unchanged. The exact legacy and target snapshots are re-hashed before
staging, and production is revalidated again at the mutation boundary. CI's
append-only rule makes the accepted boundary durable.

Measured against this repository: **274 executable up migration files plus 41
down files** under `migrations/`, counted with

```bash
ls -1 migrations | grep -cE '^[0-9]{3}_.*\.sql$'   # 274 up files
ls -1 migrations/down | grep -cE '\.sql$'          # 41 down files
```

The down files are not wired to any runner. Reversal of a governed irreversible
migration is "restore the exact pre-migration snapshot", not "run the down file".

## Application startup cannot migrate

Release containers run with `MIGRATIONS_MODE=external`. In that mode the
application verifies the migration ledger at boot and **refuses to serve** if
anything is pending, rather than applying it. Migrations are applied only by the
profile-gated one-shot `migrator` Compose service. Staging uses its isolated
database; production runs the migrator only after its pre-migration backup is
verified.

The same one-shot owns all governed idempotent data maintenance: legacy iOS
refresh-token hashing/plaintext clearing, Telegram identity archival, owner
seeding, OAuth/finance/Garmin encryption backfills, owner OAuth-token import,
and default-skill seeding. They run with the completion receipt in one SQLite
`IMMEDIATE` transaction. The serving predecessor remains readable, competing
writes serialize behind the migrator, and a failure rolls back every partial
transformation and publishes no receipt.

Completion is an insert-only `kv_store` record keyed by
`release_data_maintenance:<releaseId>` and canonically binds the exact release
ID, protected source SHA, and backend OCI digest. Candidate and predecessor
records therefore remain independently verifiable for rollback; no mutable
global "last completed" marker exists. External boot exact-reads its own record
and verifies the exact migration-028 `kv_store` columns, constraints, default,
primary key, and update index before the persisted model or settings loaders
run. Those loaders and the generic KV-store accessor disable their schema-
creation fallback in external mode. A missing or malformed table or index, or a
mismatched record, fails closed and cannot self-heal through those paths.
Changes to any transformation or its governed config/encryption/skill-metadata
dependencies make unattended migration eligibility fail closed.

Missing, empty, symlinked, or malformed packaged migration sources are hard
errors, never an empty pending set. External mode also refuses a ledger entry
whose migration file is absent from the image. For candidate work, the migrator
and backend require the same read-only v2 release plan and environment selector.
The host materializes it only at the governed digest work directory's direct
`runtime-plan` child (directory mode 0755, regular single-link plan mode 0644);
Compose mounts that exact directory read-only and the registry has no fallback.
Before either opens SQLite or returns a no-op, the plan binds the release identity,
exact packaged inventory, complete signed reconciliation and its digest, and the
environment-specific legacy set. The production migrator still requires this
non-empty plan when nothing is pending. A partial package, partial plan, wrong
environment mapping, missing legacy row, or additional outside-inventory ledger
row cannot be treated as completed.

A silent skip would let the application serve traffic against a schema the
release never migrated. Refusing to boot surfaces a missing migrator run while
the previous container is still answering requests.

## Ordering that must not change

Three boundaries carry the safety argument.

1. **Write-ahead.** `production_observing` is persisted before production
   migration begins. The same state snapshots the verified backup's governed
   artifact name and absolute path, encrypted SHA-256 and size, covered database,
   producer invocation and receipt completion times, plus the outgoing
   predecessor's image-pair and payload/Compose identity. If the poller dies
   during migration or the switch,
   recovery never has to infer which backup bytes or topology were accepted.
   `last-success.json` is used only to admit a fresh pre-promotion backup. The
   admitted fields are carried forward and descriptor-reverified directly before
   write-ahead, so an hourly pointer update cannot redirect or strand the attempt.
2. **Backup → migrate → switch.** The backup is the only artifact that can undo a
   migration, so it must exist before any schema change. A backup failure stops
   the release while the predecessor is still serving. The attended first
   cutover also compares every installed backup producer, unit, timer, and
   sudoers byte with the resolved immutable control-plane root, reloads systemd,
   and proves the effective pre-promotion `ExecStart` before PM2 is stopped.
3. **Protected head → write-ahead.** The exact signed source is compared with
   public protected-main head before admission, after staging, and again after
   backup, ledger reconciliation, and exact backup-evidence revalidation. This
   final lookup is the last non-mutating boundary immediately before
   `production_observing` write-ahead and the migrator. It closes the backup-time
   race without making a settled no-op depend on GitHub availability.

## First container boundary

`nexus-release-poller.service` never carries bootstrap authority. With no
container predecessor, it returns
`first_container_bootstrap_authorization_required` before staging or migration.
The owner separately creates a root-owned `nexus.release-bootstrap-baseline.v2`
and starts `nexus-release-bootstrap.service`, whose one-shot CLI flag is accepted
only while `state.predecessor` is absent. The verifier requires a baseline less
than 24 hours old, the exact authorized release/payload/manifest target, exact
signed inventory identity, unchanged descriptor-bound legacy and target bytes,
the exact signed environment-specific legacy sets and canonical prefix, only
signed predecessor-compatible pending bytes, a converged post-migration semantic
schema, preserved staging fixture evidence, no open handles, and no SQLite
sidecars. It revalidates production immediately before backup/migration and
records the same whole-baseline digest in both staging admission and production
revalidation.
If the baseline is absent, invalid, expired, changes at revalidation, or targets
a source that is no longer protected-main head, the one-shot does not leave an
ambiguous reusable authorization. It tears down the exact staging project and
atomically retires the target with `bootstrap_target_abandoned`, requiring a
fresh quiesced baseline for the current head. If teardown itself fails, active
evidence remains and `preproduction_teardown_failed` hard-blocks further work.
Baseline generation also requires the owner-supplied exact release ID and OCI
payload digest; resolving mutable `:main` is refused before baseline publication
unless both values match. Before `pm2 stop`, section 1b publishes a root-owned,
no-replace v2 capture of both selected runtime paths, source SHAs, artifact and
marker digests, and canonical legacy-database inodes. A successful copy then
publishes a capture-bound transition checkpoint for both source-equal targets
and the governed-backup destination. If section 1b aborts before the owner
baseline, the attended pre-baseline branch either proves that checkpoint and
continues idempotently or returns only untouched legacy data to PM2. Ordinary
`recover-pm2` leaves every target and temporary file untouched, even when it is
partial or divergent. After incident review, `reset-cutover` preserves and
byte-compares both complete governed data directories in a root-only incident,
retires the archived stale transition checkpoint, and restores exact PM2; a new
section 1b attempt may reuse the runtime capture only when every captured
runtime, artifact, marker, and database identity still matches exactly.

The baseline may authorize the initial publication when its ordinary summary is
ineligible only for the exact signed reconciliation: both databases must have
an exact canonical inventory prefix, their exact signed legacy sets, and only
the remaining exact signed predecessor-compatible suffix, whose in-memory
rehearsal must converge. Migration 283 is the sole row in the current suffix;
the contract does not hardcode that filename or suffix length. This is not a
reusable contract-migration bypass. A successful receipt records the
whole-baseline digest as `owner_bootstrap_baseline` in staging and the matching
`bootstrap_production_revalidation` check in production. If this first switch
fails, automatic image rollback is impossible; the
timer stays disabled and the operator uses the exact SQLite snapshot-back PM2
procedure in `ops/nexus-release/README.md`, preserving writes accepted by the
container database before restarting the recorded legacy runtime. The cutover
disables the known PM2 authorities and applies exact root-owned
`/etc/systemd/system.control/<unit> -> /dev/null` guards until that defined
fallback. These persistent control guards survive reboot and outrank
administrator units in `/etc/systemd/system`; ordinary
`systemctl mask --runtime` links do not. Both
the container poller and legacy PM2 path hold the same root maintenance mutex,
and the bootstrap wrapper refuses mutation unless both PM2 authority units
resolve as masked, non-startable, and inactive through those exact links.
The link target is proved separately with `readlink`; systemd's
`FragmentPath` reports the selected control-link path itself, not `/dev/null`.
Recovery verifies each complete
installed runtime tree and dependencies, release marker, artifact digest,
current selector, restarted PM2 environment, database path, and health endpoint
against immutable capture before accepting the fallback. PM2 commands run from
`/home/dominguez` before entering the existing `sudo -u dominguez pm2 ...`
policy, and restart acceptance waits at most 120 seconds for all four health
endpoints to pass in one bounded iteration. After forced container removal,
the fallback may delete a leftover WAL/SHM pair only after proving no handles,
an exact `0|0|0` checkpoint, no rollback journal, a single-link zero-byte regular
WAL, and a single-link regular SHM; any other shape stops recovery.

The fallback and rebaseline paths are durable resume transactions. First-cutover
fallback records its exact incident, database swap, backup binding, and verified
four-process restoration in `nexus.bootstrap-first-cutover-recovery.v1`.
Rebaseline records admitted runtime/database/baseline identities before its
first `pm2 stop`, archives the complete governed data trees before resetting
them, publishes a coherent fresh runtime-capture/transition pair, and invokes
baseline generation in fixed candidate mode. The validated
`bootstrap-baseline.json.next-<releaseId>` is created without overwriting either
candidate or canonical output. Only after validation does the transaction hard
link the old canonical baseline into root-only evidence and atomically replace
the canonical name. Any interruption leaves PM2 guarded and resumes from the
root-owned phase record; it never moves away the only durable baseline first.

Fallback admission re-proves the persistent control guards after every reboot
and retry. It reads the durable phase first, re-establishes missing guards for
inactive authorities, and accepts
an already-running fallback only when all four PM2 rows, live PIDs, runtime and
database identities, and health endpoints prove exact; a partial proof is
stopped and guarded before resume. A fixed SQLite recovery temporary left by an
interrupted backup is accepted only as incident data: after canonical-path,
single-link, no-handle, and no-sidecar checks, its exact bytes are archived and
SHA/size-bound in durable state, then it is removed before a fresh backup.

## Database integrity is a hard stop, not a rollback

Before any rollback is attempted, the poller runs a read-only integrity probe
against the production database on the host mount:

```sql
PRAGMA integrity_check;
PRAGMA foreign_key_check;
```

If either fails, the release **hard-stops without rolling back** and alerts. That
is deliberate. Rollback restores the previous image pair and never restores an
older database, so it cannot repair corruption — it would put older code in front
of a damaged file and keep serving. And restoring an older database automatically
would discard writes users made after the migration.

Recovery records two clocks and never conflates them. Full crash-incident time
starts before the recovery block, first page, backup revalidation, and interrupted
payload revalidation. The block's durable `since` is reused after another poller
crash, so a retry cannot reset that clock; it settles only when the terminal
integrity or predecessor recovery verdict is proven. The separate 120-second
predecessor-switch objective starts immediately before pulling the exact
predecessor payload and ends only after its Compose digest, start, health, and
both running service image digests settle. Each Docker operation receives only
that switch objective's remaining time; evidence work before the switch stays in
the incident duration without silently consuming the 120-second objective. A
`rolled_back` receipt or history entry is invalid if its restored predecessor
switch duration exceeds that recorded objective.

Recovery from that state is an operator decision made against the pre-migration
backup, which is why the alert names the backup artifact. The rollback outcome is
recorded as `not_attempted`, distinct from `failed`: the pipeline chose not to.

The probe opens the file through a `file:...?mode=ro` URI with `-readonly`, and
runs against the host mount rather than through a container that is already
failing its health check.

## Release state and receipts

The VPS is authoritative. `/var/lib/nexus-release/state/release-state.json`
carries the release id, current status, active and predecessor digests,
timestamps, attempt count, and last evidence. Statuses are `eligible`,
`staging_healthy`, `production_observing`, `completed`, `rolled_back`,
`rollback_failed`.
Settled rollback history entries persist `recoveryTiming` with
`incidentRecoveryDurationMs`, `predecessorSwitchDurationMs`, and
`predecessorSwitchObjectiveSeconds`. The generated state view reports the latest
such entry and projects the same explicit receipt fields.

Receipts are immutable and written atomically —  per-writer temp file, `fsync`,
`rename`, parent-directory `fsync` — so a reader sees either no receipt or a
complete one. Writing over an existing receipt is refused.

**Evidence outranks a stale state projection.** The state file is written by a
process that can die between two writes; a receipt is only written once a phase
has settled. So a completed receipt that is bound to a `production_observing` or
`completed` active release is proof and projects effective status `completed`.
Binding requires the addressed and
embedded release ids, recomputed source/image/Compose/migration identity, and the
exact OCI release-payload digest to agree with write-ahead state. A separate
signed-evidence digest binds repository/ref/workflow, run id and attempt,
manifest/key identity, OCI payload, images, Compose, and migration verdict; it is
recomputed on receipt read and must equal the digest persisted at acceptance.
Rollback proof also agrees with the snapshotted predecessor. An unreadable,
malformed, or
mismatched receipt or state file is an error, never treated as absent, because
"absent" is what authorizes a fresh deployment. A receipt mismatch makes the
active release unprovable and enters crash recovery; it cannot authorize the
quiet exact-payload no-op.

Receipt outcome and active status are an exact compatibility contract. A
`staging_failed` receipt can settle only `eligible`; `blocked` can settle only
`eligible`, `staging_healthy`, or `production_observing`; terminal rollback
receipts can settle mutation-admitting states because crash recovery publishes
the receipt before its final status projection. Any other pair is unprovable.
An independent preproduction block may still exist without a receipt.

A mutation-admitting active status with no terminal receipt starts crash
recovery before the moving release pointer is considered. This is true even if
an ordinary `rollback_fired`, `rollback_failed`, database, or receipt block was
written immediately before the crash: a block is not immutable terminal
evidence. The poller first
persists `unprovable_active_release` and pages, re-verifies the interrupted
release's exact signed payload against write-ahead state, and opens both the
governed backup root (`O_DIRECTORY | O_NOFOLLOW`) and artifact (`O_NOFOLLOW`)
once. Containment is resolved from those held descriptors, not a mutable root
pathname. The artifact is hashed twice in bounded positioned reads; nanosecond
mtime/ctime where available, link count, size, descriptor identity, artifact
pathname, and root pathname are reasserted before acceptance. This uses the
persisted evidence without consulting the mutable `last-success.json` pointer,
then checks production database integrity read-only. Missing, deleted,
substituted, concurrently changed, or tampered
backup evidence hard-stops without a terminal receipt that claims backup
success. If integrity passes, it restores the snapshotted predecessor's own
payload by pulling its exact OCI digest before extraction, verifies its signed
manifest identity and Compose digest, and materializes a v3 rollback plan before
any predecessor Compose render. That plan binds the predecessor's exact v2
identity/inventory/reconciliation plus the root-projected successor identity and
the exact ordered filename/digest prefix of verified predecessor-compatible
successor migrations already present in the production ledger. Ordinary
candidate plans remain v2; unknown or non-prefix rows fail. It then verifies the
two running image digests, writes a terminal receipt, and replaces the recovery block with
`rollback_fired`. Normal rollback uses the same re-extraction, reverification,
and plan-rematerialization path, so pruning or a crash cannot leave backend boot
dependent on a candidate or stale plan. It never restores a database
automatically. Missing payload, backup, predecessor, plan, integrity, topology,
or runtime-identity proof stays blocked; the unprovable block cannot be
acknowledged away before recovery.

Pre-production crashes are retryable: the exact accepted OCI payload and signed
evidence for the active `eligible` or `staging_healthy` release resume even though
its run id was already recorded. A later CI publication with the same deployable
release id is non-superseding; its changed run metadata, manifest digest, and OCI
payload never replace the evidence accepted mid-attempt. A genuinely different
protected-main head is detected at both post-staging boundaries. A mismatch
tears staging down and atomically records supersession; teardown failure retains
active evidence under a hard block. A transient public-head lookup failure
defers that exact active candidate without adding it to the permanent rejection
list. Manifest freshness likewise gates first acceptance. Retained
pre-production and crash-recovery payloads reverify at the active state's
immutable `startedAt`, never its retry-mutated `updatedAt`; a quiet completed
payload is proven by its immutable receipt and state. A different stale payload
is still rejected.

`docs/release/release-state.json` is retained only as a **non-authoritative**
projection. `npm run release:cd:state` prints a fresh host-derived view to stdout;
pass `--output docs/release/release-state.json` to refresh the checked-in path
explicitly. Until that happens from the real host, its legacy contents predate
this container cutover and are not evidence. Nothing in the deployment path
reads the file. Gating on it is what produced the bot-PR reconciliation subsystem
that ADR-0011 removed; treating it as truth again would re-derive that mistake.

Receipts are mirrored asynchronously to a separate root-owned Pi audit account. A
mirror failure alerts but **cannot alter the deployment verdict** — coupling them
would let an unreachable audit host roll back a healthy production release.
Every poll reconciles validated immutable local receipts into missing durable
queue obligations before delivery. An `scp` exit code is never success: the Pi
hashes the uploaded temporary file, fsyncs it, finalizes with an atomic
no-replace hard link, fsyncs the final file and directory, hashes the final path
again, and returns an exact digest/path proof. Only then does the VPS write and
fsync a local acknowledgement bound to the local receipt digest and current
remote host, account, and final path before dequeue. A stale or mismatched
acknowledgement retries; crashes neither lose the receipt-to-enqueue obligation
nor repeat an exactly acknowledged transfer.
Queue enumeration does not filter unexpected names. Invalid filenames and
malformed or filename-mismatched bodies move into exclusive, randomly named
quarantine bundles that cannot overwrite earlier evidence; the bundle, source
queue, and quarantine namespaces are fsynced. Any quarantine publication failure
makes queue reading fail closed: before the rename the source remains queued,
and after the rename the unique quarantine bundle remains visible.
Retry exhaustion is reported only after its `failed/<releaseId>.json` evidence is
durable. If that marker cannot be published, the obligation remains queued and
`deferred`, so neither the direct attempt nor queue drain emits an exhaustion
alert.
Every transfer outcome also runs a best-effort remote cleanup restricted to the
validated `.<releaseId>.<receiptDigest>.<32-hex-nonce>.upload` namespace. It
removes stale exact temporary uploads when transport recovers, never matches the
immutable `<releaseId>.json` receipt, and cannot settle, exhaust, or otherwise
change the durable queue obligation.

Release detail sanitization deliberately chooses the conservative option for
word-like residual secrets. Bare integers with six or more digits, unbroken
lowercase runs of 12 or more letters, arbitrary snake/kebab passphrases, and bare
32/40/64-hex tokens are redacted even without a credential keyword; terminal
sentence punctuation is removed before safe-token matching. Numeric, raw-hex,
and segmented-passphrase checks also apply per path segment, so a leading slash
cannot reclassify them as safe. Only the exact reviewed hyphenated components of
governed Nexus, backup, audit, and legacy paths are exempted. This can replace
some harmless prose with `[redacted]`, but bounded operational integers, exact
enumerated release codes, `sha256:<64 hex>` digests, backup artifact names, and
governed absolute paths remain available as evidence. Exact 32-hex release ids
and full 40-character source SHAs are rendered only from their validated
structured notification fields, never admitted by the generic free-text rule.
Preserving more free-form prose is not worth retaining plausible PIN,
passphrase, segmented-token, or opaque-hex credential material.

## Halts that need a human

Continuous deployment stops and waits for acknowledgement when:

| Condition | Block reason |
| --- | --- |
| Rollback fired and the predecessor was restored | `rollback_fired` |
| Rollback failed, or there was no predecessor | `rollback_failed` |
| Interrupted mutation has no terminal receipt and exact recovery proof is not yet available | `unprovable_active_release` |
| Pre-migration backup, production-ledger read, production migrator, or database-integrity verification failed | `database_integrity_failed` |
| Migration is not CD-eligible | `migration_not_cd_eligible` |
| An immutable terminal receipt could not be written | `receipt_unwritable` |

```bash
npm run release:cd:ack -- --show                    # what is blocked, and why
npm run release:cd:ack -- --confirm <releaseId>     # resume deployments
```

Acknowledgement names the exact blocked release id, so clearing one incident
cannot silently clear a different one that arrived meanwhile. A release identity
that already failed stays refused: retrying identical digests would re-run a
known failure every 30 seconds. Any mutation-admitting active release without a
matching terminal receipt is not acknowledgeable, regardless of the currently
projected block reason: run the locked poller to complete or hard-stop its
evidence-backed recovery first.

## Idempotency and supersession

The release id is derived only from signed, immutable content — source SHA, both
image digests, Compose digest, migration digest. So:

- another CI run publishing the same deployable identity resolves to the same
  release and is refused as already settled, or treated as non-superseding while
  the exact earlier accepted payload is still pre-production; the immutable
  receipt retains the exact run id, run attempt, manifest digest, and OCI payload
  actually accepted;
- arrival of a newer protected-main push immediately supersedes and cancels an
  in-flight publisher through their shared repository concurrency group, without
  waiting for the newer commit's CI; exact-main checks immediately before signing
  and pointer publication also refuse a stale candidate;
- failed digests stay blocked.

Supersession is re-checked after staging and before any production mutation.

## Runner topology

The repository is public, so pull-request code never runs on the persistent
Raspberry Pi. After its readiness probe passes, the Pi has CI-verification
authority only for trusted pushes to `develop`: classification, compile/build
verification, lint/type checks, selected and mutation tests, Python and
shared-contract fixtures, docs/secrets checks, and migration/science policy
checks. Every pull request and protected `main` push is forced onto ephemeral
GitHub-hosted CI. An untrusted fork therefore cannot persist on the Pi, and the
Pi cannot indirectly authorize release signing. It is granted no container-build
daemon, production secrets, deploy key, registry/publication path, or access to
production audit receipts.
CI asserts that on every self-hosted run:

```bash
/usr/local/sbin/nexus-pi-guardrails --json
```

That root-owned guard runs before checkout, so repository code cannot weaken its
own boundary. `node scripts/pi-runner-readiness.mjs --capabilities-only` remains
a repository-side diagnostic, not the CI trust anchor.

The same machine may host `/var/lib/nexus-release-audit/receipts` for the
separate `nexus-audit` account. The runner guard permits that root-owned
namespace only when the runner account has no read, write, or traverse access
to the account-owned 0700 final directory.

Before activating the Pi, run the full read-only probe on it. It checks ARM64
Linux, at least 6 GiB usable memory, 20 GiB free storage, Node 22.23.1, outbound
GitHub/npm connectivity, and focused-suite completion inside 10 minutes:

```bash
node scripts/pi-runner-readiness.mjs
```

Only after it passes, set the repository variable `NEXUS_CI_TEST_RUNNER=pi`.
That variable affects trusted `develop` pushes only; pull requests and protected
`main` remain hosted. Until then every CI run is hosted — never on production
hardware. Keep the Raspberry Pi Connect URL operator-only.

Application image production runs only on a GitHub-hosted x86_64 runner, which
asserts its own architecture and has no signing environment. The dependent
sign-and-pointer job receives a different fresh hosted VM and is the only job
bound to `release-publish`; that environment is a signing-secret and
protected-branch boundary with no reviewer, wait timer, or custom protection
rule, so ordinary green-main publication remains unattended. The signer
installs no dependencies and accepts no executable build artifact. Production
runs no build or CI work; it only pulls digests.

## Running the serialization tests locally

The kernel-flock tests need util-linux `flock`, which macOS does not ship. They
skip cleanly without it and run on the Linux CI runner, which is the platform the
poller actually targets. To run them on a Mac:

```bash
brew install util-linux
```

`scripts/lib/release-lock.mjs` already probes `/opt/homebrew/opt/util-linux/bin/flock`,
so no further configuration is needed. `NEXUS_RELEASE_FLOCK_BIN` overrides the
lookup if the binary lives elsewhere.

## Static quality evidence

SonarQube is decommissioned from the repository and release control plane: no
checked-in hosted JVM service or coexistence gate can block a deployment.
Whether old service or backup remnants still exist on the real production host
requires separate owner verification before uninstall or pruning; repository
state is not evidence of that live-host fact. Quality evidence is CI-native:
the changed-area classifier, the risk gate, the lint entry point
(currently a typecheck alias), typecheck, tests,
the dependency/security workflow (CodeQL, `npm audit`, `pip-audit`, Scorecard),
and the docs audit.

Workspace ADR-0012 is aligned with this implementation: hosted protected-main
CI owns release authority, the Pi lane is optional and test-only, the classifier
and test groups remain enforced, and `npm run lint` remains the typecheck alias.
Adding ESLint and typescript-eslint is a separate quality change, not a hidden
precondition for this release path.

The shared root maintenance mutex at `/run/lock/nexus-release-sonar.lock` is
retained. Its name is historical; the poller takes it after the release lock so
container releases cannot overlap retained root-maintenance transactions. Those
transactions also use it to serialize against each other. This mutual exclusion
is not about Sonar. Its tmpfiles definition lives at
`ops/nexus-release/nexus-release-maintenance-lock.conf`. The poller resolves both
this pathname and its release-lock pathname only from the governed CD policy, so
an ambient variable cannot split manual and systemd invocations across mutexes.

## iOS is decoupled

Backend releases do not wait on a human holding a phone (ADR-0013). The five
manual iOS gates are out of the backend release path.

In their place, CI runs one **six-example backend/iOS fixture test** when an
exact source that produces, packages, validates, or tests the release-bound
fixture changes. The governed examples are Dashboard Home, Training Home,
Content Home, Training plan created, Training plan needs-clarification, and
Training plan generation-attempt created. The exact file owners are listed in
`config/continuous-deployment.json > iosContractPaths`. Classification:

```bash
node scripts/ios-contract-change-check.mjs --base origin/main --json
```

This is a backend fixture test. It is **not** an iOS test run: no simulator, no
signed build, no device. It does not cover health, authentication, push/APNs, or
the capability manifest, so changes isolated to those surfaces do not trigger
it. Their own suites remain responsible for them. Broad iOS smoke belongs to
app distribution on the iOS repository's own cadence.

## PM2 during cutover

PM2 stays stopped but available as the manual fallback for the first cutover.
The source databases are checkpointed and copied with SQLite `.backup`, never a
raw main-file copy that can omit committed WAL frames. If the first container
switch fails, the live container database is likewise snapshot back to the PM2
path before PM2 starts; blindly starting PM2 against its untouched old copy can
discard or diverge writes. The exact commands and evidence checks are in
`ops/nexus-release/README.md`.

Remove it after **14 stable days** — a calendar criterion, not a release count.
The PM2 path (`scripts/release-operator.sh`, `ecosystem*.config.js`,
`scripts/remote-user-release-transaction.sh`) is retained for that window and is
documented in `docs/release/README.md`. It is fallback-only; the continuous
pipeline above is the default.

## Current container retention

During an attempt the VPS protects the candidate, accepted active release, and
immediate predecessor across backend, content-engine, and signed
release-payload OCI images. After settlement it protects the current release
and immediate predecessor. Settled quiet polls take that outgoing identity from
the active release's snapshotted `rollbackTarget`, because the `predecessor`
projection names the completed current release for the next attempt. The
governed image limit may retain recent extras,
but it never counts those extras ahead of a mutation or rollback identity.
Extracted payload work directories are bounded by `retention.workDirs`, counting
all protected candidate/current/predecessor directories in that total. Pruning
runs during discovery/admission as well as after completion, so repeated
invalid, refused, or staging-failed candidates cannot grow those local stores
without bound.
Immutable local receipts are not automatically deleted: they remain the
authoritative terminal record and the source for audit-mirror reconciliation.
There is intentionally no receipt-retention knob that suggests otherwise.

## Change scope of this refactor

Measured on this branch against `origin/main` at `65a87ae2a0514e0fe2ad117412d23ca3f0da8d39`:

```bash
git diff --shortstat origin/main
git diff --stat origin/main -- 'scripts/quality-sonar-*' ops/sonarqube '__tests__/scripts/quality-sonar-*'
```

The Sonar removal accounts for 2,416 deleted lines across 26 files. Any other
line count quoted about this pipeline should carry its own selector and commit
the same way; unattributed totals have been wrong before.
