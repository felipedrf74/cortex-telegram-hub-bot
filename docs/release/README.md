# Lean production release

Nexus Hub uses one protected-main artifact, one explicit release checkpoint,
one staging transaction, and one owner-approved production transaction.
Release work is sequential. SonarQube, mutation analysis, documentation
closeout, and backup retention jobs are not release gates.

## Invariants

- The target is the clean, exact current `origin/main` SHA.
- Protected main must have successful `🧪 Tests`, `🔍 Lint & Type Check`, and
  `🔨 Build` checks.
- The Ubuntu 24.04/x86-64 artifact uploaded by that build is the only artifact
  staged or promoted. The release checkpoint never rebuilds it.
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
2. verifies the three required check jobs and the exact runtime artifact;
3. classifies the cumulative deployed-to-target diff into sorted release
   groups, then subtracts the exact protected-main selection and runs the deterministic
   remainder over four non-overlapping shards;
4. proves the selected/remainder union, then runs conditional Python and
   migration safety, accepting only exact-digest-reviewed governance-only
   changes and failing closed if the candidate contains irreversible SQL;
5. downloads and verifies the original protected-main bundle;
6. publishes `release-checkpoint-<sha>/release-manifest.json`.

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

`release:prepare` downloads the compact manifest and the original protected-main
artifact. It verifies both locally, stores the manifest SHA-256, and uploads
the artifact once to
`/home/dominguez/.local/share/nexus-release/incoming/`, and submits a
`systemd-run --user` staging transaction.

The transaction copies the pristine bundle into the existing immutable layout:

```text
/home/dominguez/telegram-hub-bot-staging/
  .env
  current -> releases/<sha>-<digest-prefix>
  data/
  logs/
  releases/
```

Production Node modules and Python site-packages are built once in protected
CI and stored as two digest-bound archives. The transaction only verifies and
safely extracts those archives, recomputes an expanded-tree receipt, and
verifies that receipt before PM2. It does not run npm, pip, venv creation,
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
environment variable.

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

## Failure handling

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

SonarQube is intentionally outside this path. `npm run quality:sonar` consumes
available exact-SHA coverage but does not run tests, and it must not overlap an
active release transaction.

Record protected-main, checkpoint, staging, approval, promotion, and soak
timestamps for ten releases. Targets are p50/p95 of 3/5 minutes for normal CI
and 7/9 minutes for the checkpoint, excluding queue and owner approval.

## Retired machinery

The previous signed `ReleaseManifestV2`, separate signing workflows, staging
signatures, evidence-shadow activation, duplicate RC build/test path,
root-owned promotion control, KVM fault-drill environment, layout migration,
and legacy rollback/restore scripts are retired. Git history is the recovery
source for their code; installed old server units are removed only after the
lean path completes its first staging and production proof.

After that proof, inspect the exact allowlisted retirement plan:

```bash
sudo scripts/retire-legacy-release-machinery.sh
```

Then apply it with the exact passing production identity and explicit owner
authorization:

```bash
sudo /usr/bin/env NEXUS_RELEASE_OWNER_AUTHORIZED=1 \
  scripts/retire-legacy-release-machinery.sh \
  --apply --confirm <full-sha>:<artifact-sha256>
```

The retirement command fails closed unless the passing production transaction,
completion marker, `current` symlink, PM2 cwd/SHA identity, and both production
health endpoints still agree. It removes only its audited legacy allowlists.
It preserves `/var/lib/nexus-release`, every AWS unit/configuration path,
Ollama, SonarQube, and the lean transaction state.

AWS is not part of release, backup, SonarQube, or promotion.
