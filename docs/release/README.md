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

### First install

A staging host that has never completed a release has no `current` selector and
no `.complete.json` receipt, so the normal transaction refuses it with
`staging predecessor is unavailable`. Bootstrapping that host once requires an
explicit owner-gated opt-in:

```bash
NEXUS_RELEASE_OWNER_AUTHORIZED=1 npm run release:prepare -- --first-install
```

The operator then sends no predecessor identity and sets
`NEXUS_RELEASE_ALLOW_FIRST_INSTALL=1` on the remote transaction. It is also
refused for `promote`, and refused together with the fault drill.

#### What the transaction refuses

First install is the only path that deletes and restarts the role apps with no
recorded predecessor, so its guard fails closed. It answers "has this host ever
released?" by presence, never by validity, and treats every uncertain answer as
"yes". The first install is refused when any of these hold:

- a `current` selector exists in any form, symbolic or not;
- any entry under `releases/` contains a `.complete.json` at all. A truncated,
  symbolic, unparseable, future-schema, or renamed receipt still counts: those
  are corrupted evidence of a release, not evidence of a virgin host;
- any entry under `releases/` exists but cannot be fully inspected, including an
  unreadable release store or release directory, and a dangling symbolic entry;
- PM2 reports any role application, or PM2 cannot be queried or interpreted.

Only a genuinely virgin host is allowed through: `releases/` absent or empty, no
completion marker anywhere, and no role application registered with PM2. The
refusal names which signal fired, and it happens before the transaction arms its
EXIT trap or writes any state, so a refused first install leaves the host's
`staging.json` byte-identical and later normal releases can still read the
predecessor identity out of it.

Nothing else is relaxed. Artifact parity, digest and SHA validation, dependency
extraction receipts, candidate health, the authenticated runtime smoke, SQLite
integrity, and the soak all run unchanged; only the rollback restore is skipped,
because there is nothing to restore. The receipt records
`firstInstall: true`, `predecessor`/`predecessorSha`/`predecessorDigest` as
`null`, and `checks.rollbackReadiness: not_applicable`. A failure after the
runtime switch writes phase `first_install_failed` with
`rollbackResult: unavailable`.

#### The re-check immediately before the switch

The guards above run before the candidate is copied, manifest-verified, and
dependency-extracted. On a real bundle that is minutes, and nothing outside the
transaction takes `.release.lock`, so a host can become live inside that window:
a reboot replays `pm2 resurrect`, or somebody starts the legacy runtime by hand.
A first install that switched `current` and pm2-deleted a live host would have no
restore path at all.

So a first install re-probes the two host-liveness signals immediately before the
switch, and fails closed the same way:

- a `current` selector now exists in any form, including a dangling symlink;
- PM2 now reports a role application, or PM2 cannot be queried or interpreted.

The release-store probe is deliberately not re-run: by this point the transaction
has installed its own candidate, with its own `.complete.json`, into
`releases/`, so it would refuse every first install unconditionally.

The abort happens before `ROLLBACK_ARMED`, `switch_current`, and `start_runtime`,
so nothing on the host has been mutated. It removes only the candidate this run
created — never `current`, another release, `data/`, `logs/`, or `.env` — and
writes phase `first_install_aborted` with `status: failed`,
`candidateRemoved: true`, and a message naming the signal that fired. Read that
phase carefully: `first_install_failed` means the host really is stranded on a
switched, started, known-bad candidate, while `first_install_aborted` means the
run stopped in time and left the host exactly as it found it.

Recovering from `first_install_aborted` is not the runbook below. The host was
found to be live, so it is not a virgin host and must not be first-installed
again. Establish why it is live, then stage it as a normal release. If the
receipt is stale, remove
`/home/dominguez/.local/state/nexus-release/staging.json` before the next run.

#### After a successful first install

A completed bootstrap receipt is a valid staging transaction —
`release-checksum-manifest.mjs validate-state --role staging` accepts it, marker
and null predecessor triple included — but it is **not promotable**. It proved
health, the authenticated smoke, database integrity, and the soak; it never
proved rollback, because the host had nothing to roll back to. `promote` adds
`--require-promotable` to that same validation and refuses it by name, and
production is never first-installed through this path.

Re-running `prepare` on the exact bootstrapped artifact cannot fix that: that
artifact is the release now installed, so it can never be staged against a
predecessor on this host. `prepare` therefore refuses it rather than reporting it
staged, and names the next step.

The real sequence is:

```bash
# 1. Bootstrap the virgin host once.
NEXUS_RELEASE_OWNER_AUTHORIZED=1 npm run release:prepare -- --first-install

# 2. The next release stages normally against it. The bootstrapped release is
#    now the predecessor, so this run proves rollback readiness and produces a
#    promotable receipt. No flag, no owner variable for prepare.
npm run release:prepare

# 3. Promote that release, not the bootstrap.
NEXUS_RELEASE_OWNER_AUTHORIZED=1 \
  npm run release:promote -- --confirm <sha>:<digest>
```

Step 2 requires a different artifact from step 1 — the next protected-main
checkpoint. There is no way to promote the bootstrap artifact itself from a host
it bootstrapped; if it must reach production, promote it from a later staging
run that carries a real predecessor.

#### Recovering a failed first install

A first install that fails after the runtime switch leaves the host with a
`current` selector pointing at a known-bad candidate, the role apps started from
that candidate, and no predecessor to restore. There is nothing to roll back to,
so recovery is not a rollback: it is returning the host to the virgin shape the
guard accepts, then staging again. There is no tooling for this and none is
needed; run the sequence below on the host as `dominguez`.

Confirm the receipt really is a stranded first install before touching anything.
`firstInstall` must be `true`, `phase` must be `first_install_failed`, and
`rollbackResult` must be `unavailable`. If `firstInstall` is `false`, this is a
normal release failure: stop here and use rollback instead.

```bash
ssh dominguez@ServerDominguez
cat /home/dominguez/.local/state/nexus-release/staging.json
```

Note the `releaseDir` value from that receipt; it is the failed candidate and the
only release directory that may be removed. Then:

```bash
# 1. Stop the half-started role apps. Delete rather than restart: the candidate
#    is the only runtime this host has ever had, and it is known bad. `pm2 save
#    --force` is required, or the resurrect list starts it again on reboot.
pm2 delete nexus-hub-staging content-engine-staging
pm2 save --force

# 2. Drop the selector that points at the failed candidate.
rm -f /home/dominguez/telegram-hub-bot-staging/current

# 3. Remove the failed candidate, using the releaseDir from the receipt.
rm -rf /home/dominguez/telegram-hub-bot-staging/releases/<runtimeSha>-<digest12>

# 4. Remove the failed transaction receipt. This is required before retrying the
#    same exact artifact: release-operator.sh otherwise stops with `the exact
#    staging transaction previously failed`.
rm -f /home/dominguez/.local/state/nexus-release/staging.json
```

Never remove `/home/dominguez/telegram-hub-bot-staging/data/`, its `logs/`, or
its `.env`. They are persistent host state that every release shares, and the
release path deliberately symlinks each candidate at them rather than copying
them.

Verify the host is virgin again before retrying. Each command must produce the
output noted, and each corresponds to one refusal signal above:

```bash
ls -A /home/dominguez/telegram-hub-bot-staging/releases   # prints nothing
ls -ld /home/dominguez/telegram-hub-bot-staging/current   # No such file
pm2 jlist | grep -c '"name":"nexus-hub-staging"'          # prints 0
```

Then retry the first install from the operator machine. If any step was skipped,
the retry refuses and names the signal that is still present, which is the
intended outcome; clear that signal rather than working around it.

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
It preserves `/var/lib/nexus-release`, Ollama, SonarQube, and the lean
transaction state, and intentionally never mutates AWS paths. The separately
authorized AWS closeout removed the server AWS callers, configuration, and
credentials; only the compliance-locked application bucket remains until its
retention can be reverified after `2027-02-03T16:24:28Z`.

AWS is not part of release, backup, SonarQube, or promotion.
