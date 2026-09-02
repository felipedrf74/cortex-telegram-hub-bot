# Release host installation

Root-owned installation for the continuous-deployment poller on
`dominguez@serverdominguez`. The behaviour it installs is documented in
`docs/release/continuous-deployment.md`.

Everything here is **manual verification required**: it needs root on the host
and credentials only the owner holds. Nothing in CI performs these steps.

## Canonical first-install order

The section numbers group related procedures; they are not the execution order
for the first container cutover. Follow this sequence exactly:

1. On a trusted machine and in GitHub, complete the key-creation portion of
   section 2: generate the signing pair, create the `release-publish`
   environment with protected-branch policy but no reviewers, wait timer, or
   custom protection rule, add the private-key secret, and commit the public
   pin. Merge to protected `main` and require a successful signed
   `nexus-hub-release:main` publication before touching production.
2. On the host, complete sections 0, 1, and 1a for the exact published
   protected-`main` SHA. The initial control-plane install must start and enable
   no release unit.
3. Finish the host portion of section 2 from the committed public pin, then
   complete section 3 registry access and section 5 maintenance-mutex setup.
   Prove the hardened host can pull the exact signed payload before stopping
   PM2.
4. Run the complete quiesced database transition in section 1b, then create the
   target-bound owner baseline in section 3a and install the section 4
   environment files.
5. Complete section 6: install the units, enable—but do not yet start—only the
   heartbeat timer, run the heartbeat service immediately, and require its
   invocation-scoped journal proof of delivery to the dedicated release channel.
   Only then start the heartbeat timer, start the non-enabled bootstrap one-shot,
   and prove its completed immutable receipt. Only then enable the ordinary
   poller timer and complete section 7 verification.

Sections 8 through 10 are non-gating observability and test-runner procedures;
they do not change this first-cutover authority order.

## 0. Host prerequisites

The poller runs directly on the host, not in a container, so these must exist:

| Installed binary | Used for | Installed override |
| --- | --- | --- |
| `/usr/bin/node` (exactly 22.23.1) | every installed control-plane unit | none |
| `/usr/bin/npm` (npm 10+) | locked production dependency install | none |
| `/usr/bin/git` | exact protected-main control-plane checkout | none |
| `/usr/bin/systemd-run` | transient, whole-cgroup control-plane builds | none |
| `/usr/bin/pgrep` | prove the dedicated build account is quiescent | none |
| `/usr/bin/flock` (util-linux) | installed-host release serialization | none |
| `/usr/bin/docker` + Compose >=2.30.0 | pulling digests, raw env files, running stacks | none |
| `/usr/bin/sqlite3` | read-only pre-rollback database integrity probe | none |
| `/usr/bin/lsof` | prove legacy SQLite files have no open handles at cutover | none |
| `/usr/bin/systemctl` | starting the pre-migration backup unit | none |
| `/usr/bin/scp` | asynchronous receipt mirroring (optional) | none |
| `/usr/bin/ssh` | durable remote receipt finalize and readback (optional) | none |
| `/usr/bin/jq` | exact JSON evidence and registry-config admission | none |
| `/usr/bin/sha256sum` + `/usr/bin/date` | cutover/evidence identity and freshness | none |
| `/usr/bin/awk` | one-time least-privilege environment split | none |
| `/usr/bin/ssh-keygen` + `/usr/bin/ssh-keyscan` | audit identity and host pin | none |
| `/usr/bin/cmp` | prove installed operator wrappers equal reviewed source | none |
| `/usr/sbin/visudo` | validate the exact read-only state-view sudo rule | none |

```bash
test -x /usr/bin/node && test "$(/usr/bin/node --version)" = v22.23.1 \
  || echo 'MISSING OR WRONG VERSION: /usr/bin/node v22.23.1'
test -x /usr/bin/npm || echo 'MISSING: /usr/bin/npm'
test -x /usr/bin/git || echo 'MISSING: /usr/bin/git'
for bin in flock docker sqlite3 lsof systemctl scp ssh jq sha256sum date awk \
  ssh-keygen ssh-keyscan cmp; do
  test -x "/usr/bin/$bin" || echo "MISSING: /usr/bin/$bin"
done
test -x /usr/sbin/visudo || echo 'MISSING: /usr/sbin/visudo'
COMPOSE_VERSION="$(/usr/bin/docker compose version --short 2>/dev/null || true)"
/usr/bin/node -e '
  const match = process.argv[1].match(/^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  if (!match) process.exit(1);
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major < 2 || (major === 2 && minor < 30)) process.exit(1);
' "$COMPOSE_VERSION" \
  || echo "MISSING OR TOO OLD: /usr/bin/docker Compose >=2.30.0 (found $COMPOSE_VERSION)"
```

Absolute paths are part of host admission, not PATH preferences. The units load
`poller.env` only as a source for its three declared operator values, explicitly
unset dynamic-loader controls, and start every preflight and command through
`/usr/bin/env -i`. Poller/bootstrap forward only the audit host plus dedicated
Telegram bot/chat; heartbeat forwards only the Telegram pair. Pinned `PATH`,
`HOME`, `DOCKER_CONFIG`, and `NEXUS_RELEASE_*_BIN` values are then added from the
unit, so an arbitrary or stale `DOCKER_HOST`, `DOCKER_CONTEXT`, `COMPOSE_*`,
`NODE_OPTIONS`, `LD_*`, `GIT_*`, lock, PM2, database, or executable variable in
the file reaches no release child. The Compose registry applies a second
allowlist and disables automatic work-directory `.env` loading. All three units
refuse any Node version other than `v22.23.1`; binary overrides remain
developer/test seams only and grant no installed-host authority.

`flock` and `sqlite3` are load-bearing safety controls, not conveniences: without
`flock` releases are not serialized, and without `sqlite3` the pre-rollback
integrity gate cannot run. The poller fails closed if `flock` is absent.
Compose 2.30.0 is the minimum because the governed topology uses
`env_file.format: raw`; older clients must not reinterpret `$`, quotes, escapes,
or comment-like bytes inside root-owned secrets.

## 1. Layout

```text
/opt/nexus-release/control-plane/<sha>/ immutable root-owned installed versions
/opt/nexus-release/checkout             atomic symlink to the active version
/opt/nexus-release/checkout.previous    atomic symlink to the preserved predecessor
/etc/nexus-release/poller.env           0600 root:root — operator values
/etc/nexus-release/production-backend.env       0600 root:root — backend/migrator only
/etc/nexus-release/production-content-engine.env 0600 root:root — content engine only
/etc/nexus-release/staging-backend.env          0600 root:root — backend/migrator only
/etc/nexus-release/staging-content-engine.env   0600 root:root — content engine only
/etc/nexus-release/trust/               pinned signing key, audit-mirror key
/var/lib/nexus-release/state/           authoritative release state
/var/lib/nexus-release/state/control-plane-transaction.json 0600 root transaction gate
/var/lib/nexus-release/receipts/        immutable receipts
/var/lib/nexus-release/locks/           kernel flock target
/var/lib/nexus-release/locks/control-plane.lock 0600 root install/upgrade/rollback mutex
/srv/nexus-backups/application/         governed encrypted recovery points + receipt
/var/lib/nexus-release/work/            extracted release payloads
/var/lib/nexus-hub/production/data/     production SQLite + backups mount
/var/lib/nexus-hub/staging/data/        staging SQLite mount
```

`/opt/nexus-release` is a shared root-owned namespace, not the confidentiality
boundary for the control plane. Keep that parent `root:root 0711`: the legacy
root-owned `/usr/local/bin/pm2` launcher must traverse it to reach the pinned PM2
runtime during the first-cutover fallback window. The restricted boundaries are
`control-plane` (`root:root 0700`) and the transient build `staging` directory
(`root:<build-group> 0710`). A future install must not make the shared parent
group-searchable only by the build account, because that silently disables the
required PM2 fallback before the database transition begins.

```bash
# Release control plane: root-only. Only the governed root control-plane tools
# (poller, bootstrap, acknowledgement, heartbeat/state views) may read or write
# these paths; application containers have no control-plane authority.
sudo install -d -o root -g root -m 700 \
  /etc/nexus-release /etc/nexus-release/trust /etc/nexus-release/docker \
  /var/lib/nexus-release/state /var/lib/nexus-release/receipts \
  /var/lib/nexus-release/locks /var/lib/nexus-release/work \
  /var/lib/nexus-release/mirror-queue /var/lib/nexus-release/home

# Application data: owned by the container's numeric UID/GID, NOT root.
#
# The backend and migrator run as uid=10001 gid=10001 (Dockerfile.release.node).
# A root-owned 0700 mount is unreadable to them, and SQLite would fail to open —
# or, worse, a bind mount over an empty directory starts an EMPTY database and the
# app migrates from scratch, which looks like a successful release.
sudo install -d -o 10001 -g 10001 -m 700 \
  /var/lib/nexus-hub/production/data /var/lib/nexus-hub/staging/data
```

The numeric IDs are deliberate: the container's `nexus` user does not exist on the
host, so ownership must be expressed numerically. Secret and env files stay
`root:root 0600` — Compose reads them as root before dropping privileges, so
loosening them is neither needed nor acceptable.

The two data directories are separate on purpose: staging rehearses the migration
against its own database, and a shared mount would make the rehearsal meaningless.

## 1a. Immutable control-plane install or upgrade

The checkout is executable root control-plane code, not an application release
artifact. Never point `/opt/nexus-release/checkout` at a developer worktree and
never run `git pull` or `npm install` in the active directory. An owner first
reviews one exact protected-`main` SHA from the canonical repository. The
transaction below then fetches that exact source, runs the lockfile install as a
dedicated unprivileged build account under the same Node identity the units use.
Every builder command is a fresh transient systemd service with whole-cgroup
termination and collection. After the last command, the transaction proves the
entire build account has no process and the candidate has no open handle, proves
the eager native dependency, removes all write bits, and only then makes the
candidate visible to root services.

Set `CONTROL_PLANE_MODE=initial` only on a host where all five release unit
definitions are absent and both selectors are absent. Use `upgrade` afterward,
or `rollback` only for the exact immutable version selected by
`checkout.previous`. While holding the root control-plane mutex, initial mode
exclusively creates and durably publishes the exact root-only container release
mutex if it is absent; an exact existing mutex is accepted for an idempotent
retry. Upgrade and rollback require that mutex to exist already. The
placeholder SHA is deliberately invalid, so a pasted block cannot select moving
`main` by accident. Run the complete fenced block from one root shell (`sudo -i`);
opening the root-owned mutex from an ordinary operator shell is not equivalent.
The build environment intentionally disables prompts and Git credential helpers,
so the canonical repository must be anonymously readable. If that changes, stop
and define a separately owner-reviewed source transport; do not add a token to
the command, repository URL, checkout, or npm configuration.

The only legacy guard bridge accepted by `upgrade` is the exact immutable
`852116a7ee17562418779ee396095de2cd05e699` predecessor: its bootstrap,
poller, and heartbeat units all carry the durable transaction existence guard,
while its bootstrap and poller units uniformly predate the post-gate guard.
Current controllers require both existence and symlink guards for both gates.
Any other legacy, mixed, partial, marker-drifted, or selector-drifted state
refuses before the durable transaction record is published. Rollback retains
its separately governed compatibility semantics.

```bash
set -euo pipefail
umask 077
PATH=/usr/bin:/bin:/usr/sbin:/sbin
export PATH

die() { printf 'CONTROL-PLANE PROVISION REFUSED: %s\n' "$*" >&2; exit 1; }
test "$EUID" -eq 0 || die 'run the complete transaction from one root shell (sudo -i)'

# Owner-reviewed inputs. Choose exactly one mode and replace the SHA.
CONTROL_PLANE_MODE=initial # initial | upgrade | rollback
SOURCE_SHA='<owner-reviewed 40-lowercase-hex protected-main SHA>'
SOURCE_REPOSITORY='https://github.com/felipedrf74/cortex-telegram-hub-bot.git'
SOURCE_REF='refs/heads/main'

BUILD_USER=nexus-release-build
CONTROL_ROOT=/opt/nexus-release
VERSION_ROOT=/opt/nexus-release/control-plane
STAGING_ROOT=/opt/nexus-release/staging
ACTIVE_LINK=/opt/nexus-release/checkout
PREVIOUS_LINK=/opt/nexus-release/checkout.previous
RELEASE_LOCK=/var/lib/nexus-release/locks/release.lock
MAINTENANCE_LOCK=/run/lock/nexus-release-sonar.lock
CONTROL_PLANE_LOCK=/var/lib/nexus-release/locks/control-plane.lock
STATE_ROOT=/var/lib/nexus-release/state
TRANSACTION_STATE=/var/lib/nexus-release/state/control-plane-transaction.json
TRANSACTION_STAGE=/var/lib/nexus-release/state/control-plane-transaction.json.next
POST_GATE_STATE=/var/lib/nexus-release/state/control-plane-post-gate.json
FINALIZATION_STATE=/var/lib/nexus-release/state/control-plane-finalization.json
EXPECTED_MARKER="$SOURCE_SHA $SOURCE_REPOSITORY /usr/bin/node:v22.23.1"
LEGACY_UPGRADE_PREDECESSOR_SHA=852116a7ee17562418779ee396095de2cd05e699
LEGACY_UPGRADE_PREDECESSOR_MARKER="$LEGACY_UPGRADE_PREDECESSOR_SHA $SOURCE_REPOSITORY /usr/bin/node:v22.23.1"
STAGE_DIR=
TIMER_FAILSAFE_ARMED=0
TRANSACTION_DURABLE=0
TRANSACTION_PHASE=
RESUME_FROM_PHASE=
ORPHAN_STAGE_PRESENT=0
SOURCE_LIST_TEMP=
SOURCE_MANIFEST_TEMP=
FORBID_UNTRACKED_MARKER=0

disable_control_plane_timers_fail_safe() {
  local backup_status heartbeat_status liveness_status poller_status restore_status
  test "$TIMER_FAILSAFE_ARMED" -eq 1 || return 0
  # Keep failures inside conditionals so the ERR trap cannot recursively invoke
  # this fail-safe while it is already handling an error.
  if disable_timer_if_present nexus-release-poller.timer; then
    poller_status=0
  else
    poller_status=$?
  fi
  if disable_timer_if_present nexus-release-heartbeat.timer; then
    heartbeat_status=0
  else
    heartbeat_status=$?
  fi
  if disable_timer_if_present nexus-local-backup.timer; then
    backup_status=0
  else
    backup_status=$?
  fi
  if disable_timer_if_present nexus-local-backup-restore-verify.timer; then
    restore_status=0
  else
    restore_status=$?
  fi
  if disable_timer_if_present nexus-release-backup-liveness.timer; then
    liveness_status=0
  else
    liveness_status=$?
  fi
  if test "$poller_status" -ne 0 || test "$heartbeat_status" -ne 0 \
      || test "$backup_status" -ne 0 || test "$restore_status" -ne 0 \
      || test "$liveness_status" -ne 0; then
    printf 'CONTROL-PLANE FAIL-SAFE: timer disable failed (poller=%s heartbeat=%s backup=%s restore=%s liveness=%s)\n' \
      "$poller_status" "$heartbeat_status" "$backup_status" "$restore_status" \
      "$liveness_status" >&2
  fi
  return 0
}

control_plane_error() {
  local status=$?
  disable_control_plane_timers_fail_safe
  return "$status"
}

cleanup_stage() {
  local status=$?
  if test -n "$SOURCE_LIST_TEMP"; then rm -f -- "$SOURCE_LIST_TEMP"; fi
  if test -n "$SOURCE_MANIFEST_TEMP"; then rm -f -- "$SOURCE_MANIFEST_TEMP"; fi
  if test "$TIMER_FAILSAFE_ARMED" -eq 1; then
    disable_control_plane_timers_fail_safe
    # A clean exit while armed is itself a refused partial activation.
    if test "$status" -eq 0; then status=1; fi
  fi
  if test -n "$STAGE_DIR" && test "$TRANSACTION_DURABLE" -eq 0; then
    case "$STAGE_DIR" in
      "$STAGING_ROOT/$SOURCE_SHA".*) sudo rm -rf -- "$STAGE_DIR" ;;
      *) printf 'unsafe staging cleanup path retained: %s\n' "$STAGE_DIR" >&2 ;;
    esac
  fi
  exit "$status"
}
trap control_plane_error ERR
trap cleanup_stage EXIT

case "$CONTROL_PLANE_MODE" in
  initial|upgrade) TRANSACTION_OPERATION=install ;;
  rollback) TRANSACTION_OPERATION=rollback ;;
  *) die 'CONTROL_PLANE_MODE must be initial, upgrade, or rollback' ;;
esac
[[ "$SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]] || die 'SOURCE_SHA is not one exact full SHA'
test "$SOURCE_REPOSITORY" = \
  'https://github.com/felipedrf74/cortex-telegram-hub-bot.git' \
  || die 'canonical source repository changed'
if test "$CONTROL_PLANE_MODE" != rollback; then
  test "$SOURCE_REF" = refs/heads/main || die 'source ref is not protected main'
fi
test -x /usr/bin/node || die '/usr/bin/node is missing'
test "$(/usr/bin/node --version)" = v22.23.1 \
  || die '/usr/bin/node is not exactly v22.23.1'
if test "$CONTROL_PLANE_MODE" != rollback; then
  test -x /usr/bin/npm || die '/usr/bin/npm is missing'
  test -x /usr/bin/git || die '/usr/bin/git is missing'
  test -x /usr/bin/systemd-run || die '/usr/bin/systemd-run is missing'
  test -x /usr/bin/pgrep || die '/usr/bin/pgrep is missing'
  test -x /usr/bin/lsof || die '/usr/bin/lsof is missing'
  test -x /usr/bin/findmnt || die '/usr/bin/findmnt is missing'
  test -x /usr/bin/timeout || die '/usr/bin/timeout is missing'
  test -x /usr/bin/sleep || die '/usr/bin/sleep is missing'
fi
test -x /usr/bin/flock || die '/usr/bin/flock is missing'
test -x /usr/bin/jq || die '/usr/bin/jq is missing'
test -x /usr/bin/systemd-analyze || die '/usr/bin/systemd-analyze is missing'
if test "$CONTROL_PLANE_MODE" != rollback; then
  test "$(cd / && /usr/bin/env -i HOME=/root PATH=/usr/bin:/bin \
    NPM_CONFIG_USERCONFIG=/dev/null /usr/bin/npm --version | cut -d. -f1)" -ge 10 \
    || die 'npm 10 or newer is required'
fi

transaction_file_is_valid() {
  local file
  file="$1"
  test -f "$file" && test ! -L "$file" \
    && test "$(stat -Lc '%U:%G:%a:%h' -- "$file")" = root:root:600:1 \
    || return 1
  jq -e '
    keys == ["backupTimerWasActive","backupTimerWasEnabled",
      "candidateDigest","controlPlaneDigest","controlPlaneSchema",
      "createdAt","expectedMarker",
      "heartbeatTimerWasActive","heartbeatTimerWasEnabled",
      "livenessTimerDesiredActive","livenessTimerDesiredEnabled",
      "livenessTimerWasActive","livenessTimerWasEnabled",
      "mode","operation",
      "originalActivePath","originalPreviousPath","phase",
      "pollerTimerDesiredActive","pollerTimerDesiredEnabled",
      "pollerTimerWasActive","pollerTimerWasEnabled",
      "restoreVerifyTimerWasActive","restoreVerifyTimerWasEnabled",
      "schema","sourceRepository",
      "stageIdentity","stagePath","targetPath","targetSha","updatedAt"]
    and .schema == "nexus.control-plane-transaction.v1"
    and (.operation == "install" or .operation == "rollback")
    and (.mode == "initial" or .mode == "upgrade" or .mode == "rollback")
    and (.operation == (if .mode == "rollback" then "rollback" else "install" end))
    and (.targetSha | type == "string" and test("^[0-9a-f]{40}$"))
    and (.candidateDigest | type == "string" and test("^[0-9a-f]{64}$"))
    and (.controlPlaneDigest | type == "string" and test("^[0-9a-f]{64}$"))
    and (.controlPlaneSchema == "nexus.release-control-plane.v1"
      or (.mode == "rollback"
        and .controlPlaneSchema == "nexus.control-plane-tree.v1"
        and .controlPlaneDigest == .candidateDigest))
    and .sourceRepository == "https://github.com/felipedrf74/cortex-telegram-hub-bot.git"
    and .expectedMarker == (.targetSha + " " + .sourceRepository
      + " /usr/bin/node:v22.23.1")
    and .targetPath == ("/opt/nexus-release/control-plane/" + .targetSha)
    and ((.stagePath == "" and .stageIdentity == "")
      or (.stagePath == ("/opt/nexus-release/staging/" + .targetSha + ".candidate")
        and (.stageIdentity | type == "string" and test("^[0-9]+:[0-9]+$"))))
    and (.originalActivePath == ""
      or (.originalActivePath | type == "string"
        and test("^/opt/nexus-release/control-plane/[0-9a-f]{40}$")))
    and (.originalPreviousPath == ""
      or (.originalPreviousPath | type == "string"
        and test("^/opt/nexus-release/control-plane/[0-9a-f]{40}$")))
    and (if .mode == "initial" then
        .originalActivePath == "" and .originalPreviousPath == ""
        and .pollerTimerWasActive == 0 and .pollerTimerWasEnabled == 0
        and .pollerTimerDesiredActive == 0
        and .pollerTimerDesiredEnabled == 0
        and .heartbeatTimerWasActive == 0 and .heartbeatTimerWasEnabled == 0
        and .livenessTimerWasActive == 0 and .livenessTimerWasEnabled == 0
        and .livenessTimerDesiredActive == 0
        and .livenessTimerDesiredEnabled == 0
        and .backupTimerWasActive == 0 and .backupTimerWasEnabled == 0
        and .restoreVerifyTimerWasActive == 0
        and .restoreVerifyTimerWasEnabled == 0
      elif .mode == "upgrade" then
        .originalActivePath != "" and .originalActivePath != .targetPath
      else
        .stagePath == "" and .stageIdentity == ""
        and .originalActivePath != "" and .originalActivePath != .targetPath
        and .originalPreviousPath == .targetPath
      end)
    and ([.pollerTimerWasActive,.pollerTimerWasEnabled,
          .pollerTimerDesiredActive,.pollerTimerDesiredEnabled,
          .heartbeatTimerWasActive,.heartbeatTimerWasEnabled,
          .livenessTimerWasActive,.livenessTimerWasEnabled,
          .livenessTimerDesiredActive,.livenessTimerDesiredEnabled,
          .backupTimerWasActive,.backupTimerWasEnabled,
          .restoreVerifyTimerWasActive,.restoreVerifyTimerWasEnabled]
      | all(. == 0 or . == 1))
    and (.phase == "prepared" or .phase == "candidate_installed"
      or .phase == "previous_selected" or .phase == "active_selected"
      or .phase == "capabilities_installed"
      or .phase == "backup_interface_installed" or .phase == "units_reloaded"
      or .phase == "timers_restored" or .phase == "complete")
    and (.createdAt | type == "string"
      and test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$"))
    and (.updatedAt | type == "string"
      and test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$"))
  ' "$file" >/dev/null
}

require_transaction_file() {
  transaction_file_is_valid "$1" \
    || die "control-plane transaction record is unsafe or malformed: $1"
}

release_lock_is_exact() {
  test -f "$RELEASE_LOCK" && test ! -L "$RELEASE_LOCK" \
    && test "$(stat -Lc '%U:%G:%a:%h' -- "$RELEASE_LOCK")" = root:root:600:1
}

require_release_lock() {
  release_lock_is_exact || die 'release mutex is absent or unsafe'
}

prepare_release_lock() {
  if test "$CONTROL_PLANE_MODE" = initial; then
    if test -e "$RELEASE_LOCK" || test -L "$RELEASE_LOCK"; then
      require_release_lock
    else
      ( umask 077; set -o noclobber; : >"$RELEASE_LOCK" ) 2>/dev/null \
        || die 'exclusive initial release mutex creation failed'
      require_release_lock
    fi
    # Re-sync an exact retry too: a previous shell may have exited after the
    # exclusive create but before durably publishing the directory entry.
    sync -f "$RELEASE_LOCK"; sync -f "$(dirname "$RELEASE_LOCK")"
    require_release_lock
  else
    require_release_lock
  fi
}

trusted_destination_ancestor_identity() {
  /usr/bin/node --input-type=module - 0 0 / "$@" <<'NODE'
import fs from 'node:fs';
import path from 'node:path';
const expectedUid = Number(process.argv[2]);
const expectedGid = Number(process.argv[3]);
const boundary = process.argv[4];
const destinations = process.argv.slice(5);
if (!Number.isSafeInteger(expectedUid) || expectedUid < 0
    || !Number.isSafeInteger(expectedGid) || expectedGid < 0
    || !path.isAbsolute(boundary) || path.resolve(boundary) !== boundary
    || destinations.length === 0) process.exit(10);
const identities = new Map();
for (const destination of destinations) {
  if (!path.isAbsolute(destination) || path.resolve(destination) !== destination) {
    throw new Error(`destination is not a normalized absolute path: ${destination}`);
  }
  const relative = path.relative(boundary, destination);
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`)
      || path.isAbsolute(relative)) {
    throw new Error(`destination escaped its ancestor boundary: ${destination}`);
  }
  let ancestor = path.dirname(destination);
  for (;;) {
    const before = fs.lstatSync(ancestor);
    if (!before.isDirectory() || before.isSymbolicLink()
        || before.uid !== expectedUid || before.gid !== expectedGid
        || (before.mode & 0o022) !== 0) {
      throw new Error(`destination ancestor is unsafe: ${ancestor}`);
    }
    const after = fs.lstatSync(ancestor);
    if (after.dev !== before.dev || after.ino !== before.ino
        || after.mode !== before.mode || after.uid !== before.uid
        || after.gid !== before.gid) {
      throw new Error(`destination ancestor changed during proof: ${ancestor}`);
    }
    const identity = `${before.dev}:${before.ino}:${before.mode & 0o7777}`;
    if (identities.has(ancestor) && identities.get(ancestor) !== identity) {
      throw new Error(`destination ancestor identity conflicted: ${ancestor}`);
    }
    identities.set(ancestor, identity);
    if (ancestor === boundary) break;
    if (ancestor === path.parse(ancestor).root) {
      throw new Error(`destination ancestor escaped its boundary: ${destination}`);
    }
    ancestor = path.dirname(ancestor);
  }
}
for (const [ancestor, identity] of [...identities].sort(([left], [right]) => (
  left < right ? -1 : left > right ? 1 : 0
))) process.stdout.write(`${ancestor}\t${identity}\n`);
NODE
}

test -d "$STATE_ROOT" && test ! -L "$STATE_ROOT" \
  && test "$(stat -Lc '%U:%G:%a' -- "$STATE_ROOT")" = root:root:700 \
  || die 'control-plane state root is unsafe'
test -d "$(dirname "$CONTROL_PLANE_LOCK")" \
  && test ! -L "$(dirname "$CONTROL_PLANE_LOCK")" \
  && test "$(stat -Lc '%U:%G:%a' -- "$(dirname "$CONTROL_PLANE_LOCK")")" \
    = root:root:700 || die 'control-plane lock root is unsafe'
test ! -L "$CONTROL_PLANE_LOCK" || die 'control-plane mutex is symbolic'
if test ! -e "$CONTROL_PLANE_LOCK"; then
  ( set -o noclobber; : >"$CONTROL_PLANE_LOCK" ) 2>/dev/null || true
fi
test -f "$CONTROL_PLANE_LOCK" && test ! -L "$CONTROL_PLANE_LOCK" \
  && test "$(stat -Lc '%U:%G:%a:%h' -- "$CONTROL_PLANE_LOCK")" = root:root:600:1 \
  || die 'control-plane mutex is unsafe'
exec 7<>"$CONTROL_PLANE_LOCK"
test "$(stat -Lc '%d:%i' -- /proc/$$/fd/7)" = \
  "$(stat -Lc '%d:%i' -- "$CONTROL_PLANE_LOCK")" \
  || die 'control-plane mutex changed identity before acquisition'
/usr/bin/flock -n 7 || die 'another control-plane transaction is active'
test "$(stat -Lc '%d:%i' -- /proc/$$/fd/7)" = \
  "$(stat -Lc '%d:%i' -- "$CONTROL_PLANE_LOCK")" \
  || die 'control-plane mutex changed identity after acquisition'
prepare_release_lock

if test -e "$FINALIZATION_STATE" || test -L "$FINALIZATION_STATE"; then
  require_transaction_file "$FINALIZATION_STATE"
  test "$(jq -er .phase "$FINALIZATION_STATE")" = complete \
    || die 'control-plane finalization is not at the durable complete phase'
  for conflicting in "$TRANSACTION_STATE" "$TRANSACTION_STAGE" "$POST_GATE_STATE"; do
    test ! -e "$conflicting" && test ! -L "$conflicting" \
      || die "control-plane finalization conflicts with another journal: $conflicting"
  done
  jq -e --arg mode "$CONTROL_PLANE_MODE" --arg sha "$SOURCE_SHA" \
    --arg repository "$SOURCE_REPOSITORY" --arg marker "$EXPECTED_MARKER" \
    --arg target "$VERSION_ROOT/$SOURCE_SHA" \
    --arg operation "$TRANSACTION_OPERATION" '
      .operation == $operation and .mode == $mode and .targetSha == $sha
      and .sourceRepository == $repository and .expectedMarker == $marker
      and .targetPath == $target
    ' "$FINALIZATION_STATE" >/dev/null \
    || die 'control-plane finalization belongs to a different request'

  FINAL_TARGET="$VERSION_ROOT/$SOURCE_SHA"
  FINAL_ORIGINAL_ACTIVE="$(jq -r .originalActivePath "$FINALIZATION_STATE")"
  test -L "$ACTIVE_LINK" \
    && test "$(readlink -f -- "$ACTIVE_LINK")" = "$FINAL_TARGET" \
    || die 'finalization active selector changed'
  if test -n "$FINAL_ORIGINAL_ACTIVE"; then
    test -L "$PREVIOUS_LINK" \
      && test "$(readlink -f -- "$PREVIOUS_LINK")" = "$FINAL_ORIGINAL_ACTIVE" \
      || die 'finalization previous selector changed'
  else
    test ! -e "$PREVIOUS_LINK" && test ! -L "$PREVIOUS_LINK" \
      || die 'initial finalization unexpectedly has a predecessor'
  fi
  test -d "$FINAL_TARGET" && test ! -L "$FINAL_TARGET" \
    && test "$(<"$FINAL_TARGET/.nexus-control-plane-ready")" = "$EXPECTED_MARKER" \
    || die 'finalization immutable target evidence changed'
  test -z "$(find "$FINAL_TARGET" -xdev \( ! -user root -o ! -group root \
    -o ! -type l -perm /222 \) -print -quit)" \
    || die 'finalization immutable target ownership or mode changed'
  FINAL_JOURNAL_DIGEST="$(jq -er .candidateDigest "$FINALIZATION_STATE")"
  test -f "$FINAL_TARGET/.nexus-control-plane-tree.sha256" \
    && test ! -L "$FINAL_TARGET/.nexus-control-plane-tree.sha256" \
    && test "$(stat -Lc '%U:%G:%a:%h' -- \
      "$FINAL_TARGET/.nexus-control-plane-tree.sha256")" = root:root:444:1 \
    && test "$(<"$FINAL_TARGET/.nexus-control-plane-tree.sha256")" = \
      "$FINAL_JOURNAL_DIGEST" \
    || die 'finalization recorded candidate digest changed'
  FINAL_CALCULATED_DIGEST="$(/usr/bin/node --input-type=module - \
    "$FINAL_TARGET" <<'NODE'
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
const root = resolve(process.argv[2]);
const hash = createHash('sha256');
const fileDigest = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const visit = (relative = '') => {
  const absolute = relative ? join(root, relative) : root;
  const stat = lstatSync(absolute);
  const type = stat.isDirectory() ? 'directory'
    : stat.isFile() ? 'file' : stat.isSymbolicLink() ? 'symlink' : 'unsupported';
  if (type === 'unsupported') throw new Error(`unsupported candidate object: ${relative}`);
  if (relative !== '.nexus-control-plane-tree.sha256') {
    hash.update(`${JSON.stringify({
      path: relative || '.', type, mode: stat.mode & 0o7777,
      value: type === 'file' ? fileDigest(absolute)
        : type === 'symlink' ? readlinkSync(absolute) : '',
    })}\n`);
  }
  if (type === 'directory') {
    for (const name of readdirSync(absolute).sort()) {
      visit(relative ? `${relative}/${name}` : name);
    }
  }
};
visit();
process.stdout.write(`${hash.digest('hex')}\n`);
NODE
  )" || die 'finalization candidate digest recomputation failed'
  test "$FINAL_CALCULATED_DIGEST" = "$FINAL_JOURNAL_DIGEST" \
    || die 'finalization immutable candidate differs from its durable digest'

  FINAL_IDENTITY_DESCRIPTOR="$FINAL_TARGET/ops/nexus-release/release-control-plane-inputs.json"
  FINAL_IDENTITY_MODULE="$FINAL_TARGET/scripts/lib/release-control-plane.mjs"
  if { test -e "$FINAL_IDENTITY_DESCRIPTOR" || test -L "$FINAL_IDENTITY_DESCRIPTOR"; } \
      || { test -e "$FINAL_IDENTITY_MODULE" || test -L "$FINAL_IDENTITY_MODULE"; }; then
    test -f "$FINAL_IDENTITY_DESCRIPTOR" && test ! -L "$FINAL_IDENTITY_DESCRIPTOR" \
      && test -f "$FINAL_IDENTITY_MODULE" && test ! -L "$FINAL_IDENTITY_MODULE" \
      || die 'finalization target has a partial signed control-plane identity pair'
    FINAL_CONTROL_PLANE_IDENTITY="$(/usr/bin/node --input-type=module - \
      "$FINAL_TARGET" <<'NODE'
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = process.argv[2];
if (process.version !== 'v22.23.1') process.exit(10);
const { computeReleaseControlPlaneIdentity } = await import(pathToFileURL(
  join(root, 'scripts/lib/release-control-plane.mjs'),
));
const identity = computeReleaseControlPlaneIdentity(root, { runtimeVersion: '22.23.1' });
const require = createRequire(join(root, 'package.json'));
const Database = require('better-sqlite3');
const database = new Database(':memory:');
database.prepare('SELECT 1').get();
database.close();
process.stdout.write(`${identity.schema} ${identity.digest}\n`);
NODE
    )" || die 'finalization signed control-plane/native dependency proof failed'
  else
    test "$CONTROL_PLANE_MODE" = rollback \
      || die 'finalization target lacks a signed control-plane identity outside rollback'
    FINAL_CONTROL_PLANE_IDENTITY="nexus.control-plane-tree.v1 $FINAL_JOURNAL_DIGEST"
  fi
  test "$FINAL_CONTROL_PLANE_IDENTITY" = \
    "$(jq -r '[.controlPlaneSchema,.controlPlaneDigest] | join(" ")' \
      "$FINALIZATION_STATE")" \
    || die 'finalization control-plane identity changed'

  for unit in nexus-release-bootstrap.service nexus-release-poller.service \
    nexus-release-poller.timer nexus-release-heartbeat.service \
    nexus-release-heartbeat.timer; do
    test -f "/etc/systemd/system/$unit" && test ! -L "/etc/systemd/system/$unit" \
      && test "$(stat -Lc '%U:%G:%a:%h' -- "/etc/systemd/system/$unit")" = \
        root:root:644:1 \
      && cmp -s -- "$FINAL_TARGET/ops/nexus-release/$unit" \
        "/etc/systemd/system/$unit" \
      && test "$(systemctl show "$unit" --property=LoadState --value)" = loaded \
      && test "$(systemctl show "$unit" --property=FragmentPath --value)" = \
        "/etc/systemd/system/$unit" \
      && test -z "$(systemctl show "$unit" --property=DropInPaths --value)" \
      && test "$(systemctl show "$unit" --property=NeedDaemonReload --value)" = no \
      || die "finalization release-unit proof failed: $unit"
  done
  FINAL_CAPABILITY_ANCESTORS="$(trusted_destination_ancestor_identity \
    /usr/local/sbin/nexus-release-state-view \
    /etc/sudoers.d/nexus-release-state-view)" \
    || die 'finalization capability ancestor proof failed'
  for final_capability in \
    'ops/nexus-release/nexus-release-state-view|/usr/local/sbin/nexus-release-state-view|755' \
    'ops/nexus-release/nexus-release-state-view.sudoers|/etc/sudoers.d/nexus-release-state-view|440'; do
    IFS='|' read -r final_relative final_destination final_mode \
      <<<"$final_capability"
    test -f "$final_destination" && test ! -L "$final_destination" \
      && test "$(stat -Lc '%U:%G:%a:%h' -- "$final_destination")" = \
        "root:root:$final_mode:1" \
      && cmp -s -- "$FINAL_TARGET/$final_relative" "$final_destination" \
      || die "finalization installed capability changed: $final_destination"
  done
  /usr/sbin/visudo -cf /etc/sudoers.d/nexus-release-state-view >/dev/null \
    || die 'finalization state-view sudoers proof failed'
  /usr/bin/sudo -u dominguez /usr/bin/sudo -n \
    /usr/local/sbin/nexus-release-state-view >/dev/null \
    || die 'finalization delegated state-view proof failed'
  test "$(trusted_destination_ancestor_identity \
    /usr/local/sbin/nexus-release-state-view \
    /etc/sudoers.d/nexus-release-state-view)" = \
      "$FINAL_CAPABILITY_ANCESTORS" \
    || die 'finalization capability ancestor identity changed'
  if test -f "$FINAL_TARGET/ops/nexus-release/nexus-release-backup-liveness-force.service" \
      && test -f "$FINAL_TARGET/ops/nexus-release/nexus-release-backup-liveness.service" \
      && test -f "$FINAL_TARGET/ops/nexus-release/nexus-release-backup-liveness.timer" \
      && test -f "$FINAL_TARGET/scripts/release-backup-liveness-launcher.sh"; then
    for unit in nexus-release-backup-liveness-force.service \
      nexus-release-backup-liveness.service \
      nexus-release-backup-liveness.timer; do
      test -f "/etc/systemd/system/$unit" && test ! -L "/etc/systemd/system/$unit" \
        && test "$(stat -Lc '%U:%G:%a:%h' -- "/etc/systemd/system/$unit")" = \
          root:root:644:1 \
        && cmp -s -- "$FINAL_TARGET/ops/nexus-release/$unit" \
          "/etc/systemd/system/$unit" \
        && test "$(systemctl show "$unit" --property=LoadState --value)" = loaded \
        && test "$(systemctl show "$unit" --property=FragmentPath --value)" = \
          "/etc/systemd/system/$unit" \
        && test -z "$(systemctl show "$unit" --property=DropInPaths --value)" \
        && test "$(systemctl show "$unit" --property=NeedDaemonReload --value)" = no \
        || die "finalization liveness unit proof failed: $unit"
    done
  else
    test ! -e /etc/systemd/system/nexus-release-backup-liveness-force.service \
      && test ! -L /etc/systemd/system/nexus-release-backup-liveness-force.service \
      && test ! -e /etc/systemd/system/nexus-release-backup-liveness.service \
      && test ! -L /etc/systemd/system/nexus-release-backup-liveness.service \
      && test ! -e /etc/systemd/system/nexus-release-backup-liveness.timer \
      && test ! -L /etc/systemd/system/nexus-release-backup-liveness.timer \
      || die 'finalization retained liveness authority for an old target'
  fi
  for final_backup_spec in \
    'scripts/local-backup.py|/usr/local/libexec/nexus-local-backup/local-backup.py|755' \
    'scripts/local-backup-retry-launcher.sh|/usr/local/libexec/nexus-local-backup/local-backup-retry-launcher.sh|755' \
    'ops/local-backup/systemd/nexus-local-backup.service|/etc/systemd/system/nexus-local-backup.service|644' \
    'ops/local-backup/systemd/nexus-local-backup.timer|/etc/systemd/system/nexus-local-backup.timer|644' \
    'ops/local-backup/systemd/nexus-local-backup-pre-promotion.service|/etc/systemd/system/nexus-local-backup-pre-promotion.service|644' \
    'ops/local-backup/systemd/nexus-local-backup-restore-verify.service|/etc/systemd/system/nexus-local-backup-restore-verify.service|644' \
    'ops/local-backup/systemd/nexus-local-backup-restore-verify.timer|/etc/systemd/system/nexus-local-backup-restore-verify.timer|644' \
    'ops/local-backup/nexus-local-backup.sudoers|/etc/sudoers.d/nexus-local-backup|440'; do
    IFS='|' read -r final_relative final_destination final_mode \
      <<<"$final_backup_spec"
    test -f "$final_destination" && test ! -L "$final_destination" \
      && test "$(stat -Lc '%U:%G:%a:%h' -- "$final_destination")" = \
        "root:root:$final_mode:1" \
      && cmp -s -- "$FINAL_TARGET/$final_relative" "$final_destination" \
      || die "finalization installed backup authority changed: $final_destination"
  done
  /usr/sbin/visudo -cf /etc/sudoers.d/nexus-local-backup >/dev/null \
    || die 'finalization local-backup sudoers proof failed'
  for unit in nexus-local-backup.service nexus-local-backup.timer \
    nexus-local-backup-pre-promotion.service \
    nexus-local-backup-restore-verify.service \
    nexus-local-backup-restore-verify.timer; do
    test "$(systemctl show "$unit" --property=LoadState --value)" = loaded \
      && test "$(systemctl show "$unit" --property=FragmentPath --value)" = \
        "/etc/systemd/system/$unit" \
      && test -z "$(systemctl show "$unit" --property=DropInPaths --value)" \
      && test "$(systemctl show "$unit" --property=NeedDaemonReload --value)" = no \
      || die "finalization effective backup unit changed: $unit"
  done
  if test -f "$FINAL_TARGET/scripts/release-installed-backup-interface-check.mjs" \
      && test ! -L "$FINAL_TARGET/scripts/release-installed-backup-interface-check.mjs"; then
    /usr/bin/env -i PATH=/usr/bin:/bin HOME=/var/lib/nexus-release/home \
      /usr/bin/node \
      "$FINAL_TARGET/scripts/release-installed-backup-interface-check.mjs" >/dev/null \
      || die 'finalization installed backup-interface proof failed'
  else
    test "$CONTROL_PLANE_MODE" = rollback \
      || die 'finalization backup-interface checker is absent outside rollback'
  fi

  final_timer_bits() {
    local active enabled fragment load_state unit
    unit="$1"
    load_state="$(systemctl show "$unit" --property=LoadState --value)"
    if test "$load_state" = not-found; then
      active="$(systemctl show "$unit" --property=ActiveState --value)"
      fragment="$(systemctl show "$unit" --property=FragmentPath --value)"
      test "$active" = inactive && test -z "$fragment" \
        || die "finalization timer is not exactly absent: $unit"
      printf '0 0\n'
      return
    fi
    test "$load_state" = loaded \
      || die "finalization timer load state is inadmissible: $unit ($load_state)"
    active="$(systemctl show "$unit" --property=ActiveState --value)"
    enabled="$(systemctl show "$unit" --property=UnitFileState --value)"
    case "$active" in active) active=1 ;; inactive) active=0 ;;
      *) die "finalization timer active state is inadmissible: $unit ($active)" ;; esac
    case "$enabled" in enabled) enabled=1 ;; disabled) enabled=0 ;;
      *) die "finalization timer enabled state is inadmissible: $unit ($enabled)" ;; esac
    printf '%s %s\n' "$active" "$enabled"
  }

  require_final_timer_pending_or_terminal() {
    local current desired_active desired_enabled pending terminal unit
    unit="$1"; desired_active="$2"; desired_enabled="$3"
    current="$(final_timer_bits "$unit")"
    pending="0 $desired_enabled"
    terminal="$desired_active $desired_enabled"
    test "$current" = "$pending" || test "$current" = "$terminal" \
      || die "finalization timer is neither pending nor terminal: $unit"
  }

  FINAL_POLLER_ACTIVE="$(jq -er .pollerTimerDesiredActive "$FINALIZATION_STATE")"
  FINAL_POLLER_ENABLED="$(jq -er .pollerTimerDesiredEnabled "$FINALIZATION_STATE")"
  FINAL_HEARTBEAT_ACTIVE="$(jq -er .heartbeatTimerWasActive "$FINALIZATION_STATE")"
  FINAL_HEARTBEAT_ENABLED="$(jq -er .heartbeatTimerWasEnabled "$FINALIZATION_STATE")"
  FINAL_LIVENESS_ACTIVE="$(jq -er .livenessTimerDesiredActive "$FINALIZATION_STATE")"
  FINAL_LIVENESS_ENABLED="$(jq -er .livenessTimerDesiredEnabled "$FINALIZATION_STATE")"
  FINAL_BACKUP_ACTIVE="$(jq -er .backupTimerWasActive "$FINALIZATION_STATE")"
  FINAL_BACKUP_ENABLED="$(jq -er .backupTimerWasEnabled "$FINALIZATION_STATE")"
  FINAL_RESTORE_ACTIVE="$(jq -er .restoreVerifyTimerWasActive "$FINALIZATION_STATE")"
  FINAL_RESTORE_ENABLED="$(jq -er .restoreVerifyTimerWasEnabled "$FINALIZATION_STATE")"
  if test "$FINAL_LIVENESS_ACTIVE" -eq 1; then
    test "$(systemctl show nexus-release-backup-liveness-force.service \
        --property=LoadState --value)" = loaded \
      && test "$(systemctl show nexus-release-backup-liveness-force.service \
        --property=ActiveState --value)" = inactive \
      && test "$(systemctl show nexus-release-backup-liveness-force.service \
        --property=Result --value)" = success \
      && test "$(systemctl show nexus-release-backup-liveness-force.service \
        --property=ExecMainStatus --value)" = 0 \
      || die 'finalization lacks the durable forced backup-liveness proof'
  fi
  require_final_timer_pending_or_terminal nexus-release-poller.timer \
    "$FINAL_POLLER_ACTIVE" "$FINAL_POLLER_ENABLED"
  require_final_timer_pending_or_terminal nexus-release-heartbeat.timer \
    "$FINAL_HEARTBEAT_ACTIVE" "$FINAL_HEARTBEAT_ENABLED"
  require_final_timer_pending_or_terminal nexus-release-backup-liveness.timer \
    "$FINAL_LIVENESS_ACTIVE" "$FINAL_LIVENESS_ENABLED"
  require_final_timer_pending_or_terminal nexus-local-backup.timer \
    "$FINAL_BACKUP_ACTIVE" "$FINAL_BACKUP_ENABLED"
  require_final_timer_pending_or_terminal nexus-local-backup-restore-verify.timer \
    "$FINAL_RESTORE_ACTIVE" "$FINAL_RESTORE_ENABLED"
  if test "$(final_timer_bits nexus-release-poller.timer)" = \
      "0 $FINAL_POLLER_ENABLED" && test "$FINAL_POLLER_ACTIVE" -eq 1; then
    test "$(systemctl show nexus-release-poller.service --property=ActiveState --value)" = \
      inactive \
      && test "$(systemctl show nexus-release-poller.service --property=Result --value)" = \
        success \
      && test "$(systemctl show nexus-release-poller.service --property=ExecMainStatus --value)" = \
        0 \
      || die 'finalization found a poller attempt or failure before terminal activation'
  fi

  if test "$CONTROL_PLANE_MODE" != initial; then
    require_release_lock
    test -f "$MAINTENANCE_LOCK" && test ! -L "$MAINTENANCE_LOCK" \
      && test "$(stat -Lc '%U:%G:%a:%h' -- "$MAINTENANCE_LOCK")" = \
        root:dominguez:660:1 \
      || die 'finalization maintenance mutex is unsafe'
    exec 9<>"$RELEASE_LOCK"
    test "$(stat -Lc '%d:%i' -- /proc/$$/fd/9)" = \
      "$(stat -Lc '%d:%i' -- "$RELEASE_LOCK")" \
      || die 'release mutex changed before finalization acquisition'
    /usr/bin/flock -n 9 || die 'release authority is active during finalization'
    test "$(stat -Lc '%d:%i' -- /proc/$$/fd/9)" = \
      "$(stat -Lc '%d:%i' -- "$RELEASE_LOCK")" \
      || die 'release mutex changed after finalization acquisition'
    exec 8<>"$MAINTENANCE_LOCK"
    test "$(stat -Lc '%d:%i' -- /proc/$$/fd/8)" = \
      "$(stat -Lc '%d:%i' -- "$MAINTENANCE_LOCK")" \
      || die 'maintenance mutex changed before finalization acquisition'
    /usr/bin/flock -n 8 || die 'root maintenance is active during finalization'
    test "$(stat -Lc '%d:%i' -- /proc/$$/fd/8)" = \
      "$(stat -Lc '%d:%i' -- "$MAINTENANCE_LOCK")" \
      || die 'maintenance mutex changed after finalization acquisition'
    exec 8>&-; exec 9>&-
  fi
  resume_final_timer() {
    local current desired_active desired_enabled unit
    unit="$1"; desired_active="$2"; desired_enabled="$3"
    current="$(final_timer_bits "$unit")"
    if test "$current" = "0 $desired_enabled" && test "$desired_active" -eq 1; then
      systemctl start "$unit" || die "terminal timer activation failed: $unit"
    fi
    test "$(final_timer_bits "$unit")" = "$desired_active $desired_enabled" \
      || die "terminal timer bits differ from durable desired state: $unit"
  }
  resume_final_timer nexus-release-heartbeat.timer \
    "$FINAL_HEARTBEAT_ACTIVE" "$FINAL_HEARTBEAT_ENABLED"
  resume_final_timer nexus-release-backup-liveness.timer \
    "$FINAL_LIVENESS_ACTIVE" "$FINAL_LIVENESS_ENABLED"
  resume_final_timer nexus-local-backup.timer \
    "$FINAL_BACKUP_ACTIVE" "$FINAL_BACKUP_ENABLED"
  resume_final_timer nexus-local-backup-restore-verify.timer \
    "$FINAL_RESTORE_ACTIVE" "$FINAL_RESTORE_ENABLED"
  resume_final_timer nexus-release-poller.timer \
    "$FINAL_POLLER_ACTIVE" "$FINAL_POLLER_ENABLED"
  FINAL_POLLER_RESTART_DEFERRED=0
  if test "$(jq -er .pollerTimerWasActive "$FINALIZATION_STATE")" -eq 1 \
      && test "$FINAL_POLLER_ACTIVE" -eq 0; then
    FINAL_POLLER_RESTART_DEFERRED=1
  fi
  require_transaction_file "$FINALIZATION_STATE"
  rm -f -- "$FINALIZATION_STATE"
  sync -f "$STATE_ROOT"
  test ! -e "$FINALIZATION_STATE" && test ! -L "$FINALIZATION_STATE" \
    || die 'terminal control-plane finalization journal was not retired'
  TRANSACTION_DURABLE=0
  printf 'completed immutable control-plane finalization %s; mode=%s; pollerRestartDeferred=%s\n' \
    "$SOURCE_SHA" "$CONTROL_PLANE_MODE" "$FINAL_POLLER_RESTART_DEFERRED"
  exit 0
fi

if test -e "$POST_GATE_STATE" || test -L "$POST_GATE_STATE"; then
  require_transaction_file "$POST_GATE_STATE"
  test "$(jq -er .phase "$POST_GATE_STATE")" = complete \
    || die 'post-gate transaction is not at the durable complete phase'
  test ! -e "$TRANSACTION_STATE" && test ! -L "$TRANSACTION_STATE" \
    || die 'gating and post-gate transaction records both exist'
  test ! -e "$TRANSACTION_STAGE" && test ! -L "$TRANSACTION_STAGE" \
    || die 'post-gate transaction conflicts with a staged transaction record'
  test ! -e "$FINALIZATION_STATE" && test ! -L "$FINALIZATION_STATE" \
    || die 'post-gate transaction conflicts with finalization state'
  jq -e --arg mode "$CONTROL_PLANE_MODE" --arg sha "$SOURCE_SHA" \
    --arg repository "$SOURCE_REPOSITORY" --arg marker "$EXPECTED_MARKER" \
    --arg target "$VERSION_ROOT/$SOURCE_SHA" \
    --arg operation "$TRANSACTION_OPERATION" '
      .operation == $operation and .mode == $mode and .targetSha == $sha
      and .sourceRepository == $repository and .expectedMarker == $marker
      and .targetPath == $target
    ' "$POST_GATE_STATE" >/dev/null \
    || die 'post-gate transaction belongs to a different request'
  mv -T -- "$POST_GATE_STATE" "$TRANSACTION_STATE"
  sync -f "$TRANSACTION_STATE"; sync -f "$STATE_ROOT"
  require_transaction_file "$TRANSACTION_STATE"
fi

if test -e "$TRANSACTION_STAGE" || test -L "$TRANSACTION_STAGE"; then
  test -f "$TRANSACTION_STAGE" && test ! -L "$TRANSACTION_STAGE" \
    && test "$(stat -Lc '%U:%G:%a:%h' -- "$TRANSACTION_STAGE")" = root:root:600:1 \
    || die 'staged transaction path is unsafe'
  if ! transaction_file_is_valid "$TRANSACTION_STAGE"; then
    # The fixed stage is never authority. A killed install may leave a partial
    # root-only file; retire it and keep/rebuild only the atomic final record.
    rm -f -- "$TRANSACTION_STAGE"
    sync -f "$STATE_ROOT"
  fi
fi
if test -e "$TRANSACTION_STAGE" || test -L "$TRANSACTION_STAGE"; then
  jq -e --arg mode "$CONTROL_PLANE_MODE" --arg sha "$SOURCE_SHA" \
    --arg repository "$SOURCE_REPOSITORY" --arg target "$VERSION_ROOT/$SOURCE_SHA" \
    --arg operation "$TRANSACTION_OPERATION" '
      .operation == $operation and .mode == $mode and .targetSha == $sha
      and .sourceRepository == $repository and .targetPath == $target
    ' "$TRANSACTION_STAGE" >/dev/null \
    || die 'staged transaction belongs to a different request'
  if test -e "$TRANSACTION_STATE" || test -L "$TRANSACTION_STATE"; then
    require_transaction_file "$TRANSACTION_STATE"
    jq -e --slurpfile current "$TRANSACTION_STATE" '
      del(.phase,.updatedAt) == ($current[0] | del(.phase,.updatedAt))
    ' "$TRANSACTION_STAGE" >/dev/null \
      || die 'staged transaction differs from durable transaction identity'
  fi
  mv -T -- "$TRANSACTION_STAGE" "$TRANSACTION_STATE"
  sync -f "$TRANSACTION_STATE"; sync -f "$STATE_ROOT"
fi

RESUME_TRANSACTION=0
if test -e "$TRANSACTION_STATE" || test -L "$TRANSACTION_STATE"; then
  require_transaction_file "$TRANSACTION_STATE"
  jq -e --arg mode "$CONTROL_PLANE_MODE" --arg sha "$SOURCE_SHA" \
    --arg repository "$SOURCE_REPOSITORY" --arg marker "$EXPECTED_MARKER" \
    --arg target "$VERSION_ROOT/$SOURCE_SHA" \
    --arg operation "$TRANSACTION_OPERATION" '
      .operation == $operation and .mode == $mode and .targetSha == $sha
      and .sourceRepository == $repository and .expectedMarker == $marker
      and .targetPath == $target
    ' "$TRANSACTION_STATE" >/dev/null \
    || die 'durable transaction belongs to a different request'
  RESUME_TRANSACTION=1
  TRANSACTION_DURABLE=1
fi

if test "$CONTROL_PLANE_MODE" != rollback && ! getent passwd "$BUILD_USER" >/dev/null; then
  test "$CONTROL_PLANE_MODE" = initial \
    || die 'dedicated build account is absent during upgrade'
  sudo useradd --system --user-group --no-create-home \
    --home-dir /nonexistent --shell /usr/sbin/nologin "$BUILD_USER"
fi
if test "$CONTROL_PLANE_MODE" != rollback; then
BUILD_RECORD="$(getent passwd "$BUILD_USER")"
test "$(printf '%s\n' "$BUILD_RECORD" | cut -d: -f6)" = /nonexistent \
  || die 'build account has an unexpected home'
test "$(printf '%s\n' "$BUILD_RECORD" | cut -d: -f7)" = /usr/sbin/nologin \
  || die 'build account has an interactive shell'
test "$(id -u "$BUILD_USER")" -ne 0 || die 'build account is root'
BUILD_UID="$(id -u "$BUILD_USER")"
BUILD_GID="$(id -g "$BUILD_USER")"
test "$BUILD_GID" -ne 0 || die 'build account uses the root group'
test "$(id -G "$BUILD_USER")" = "$BUILD_GID" \
  || die 'build account has supplementary host privileges'
else
  BUILD_UID=
  BUILD_GID=
fi

require_no_builder_processes() {
  local error_file pids process_status
  error_file="$(mktemp)"
  if pids="$(/usr/bin/pgrep -u "$BUILD_UID" 2>"$error_file")"; then
    process_status=0
  else
    process_status=$?
  fi
  if test -s "$error_file"; then
    rm -f -- "$error_file"
    die 'build-account process proof emitted diagnostics'
  fi
  rm -f -- "$error_file"
  case "$process_status" in
    0) die 'dedicated build account has a live process' ;;
    1) test -z "$pids" || die 'build-account process proof is incoherent' ;;
    *) die 'cannot prove the dedicated build account is quiescent' ;;
  esac
}

test ! -L "$CONTROL_ROOT" && test ! -L "$STAGING_ROOT" \
  && test ! -L "$VERSION_ROOT" \
  || die 'a control-plane directory is symbolic'
sudo install -d -o root -g root -m 711 "$CONTROL_ROOT"
sudo install -d -o root -g root -m 700 "$VERSION_ROOT"
if test "$CONTROL_PLANE_MODE" != rollback; then
  sudo install -d -o root -g "$BUILD_GID" -m 710 "$STAGING_ROOT"
fi
test "$(sudo stat -c '%U:%G:%a' -- "$CONTROL_ROOT")" = root:root:711 \
  || die 'shared control root is not root-owned mode 0711'
if test "$CONTROL_PLANE_MODE" != rollback; then
  test "$(sudo stat -c '%U:%g:%a' -- "$STAGING_ROOT")" = "root:$BUILD_GID:710" \
    || die 'build staging root has unsafe ownership or mode'
fi
test "$(sudo stat -c '%U:%G:%a' -- "$VERSION_ROOT")" = root:root:700 \
  || die 'version root is not root-owned mode 0700'
if test -d "$CONTROL_ROOT/pm2"; then
  test ! -L "$CONTROL_ROOT/pm2" \
    || die 'preserved PM2 runtime root is symbolic'
  test "$(sudo stat -c '%U:%G' -- "$CONTROL_ROOT/pm2")" = root:root \
    || die 'preserved PM2 runtime root is not root-owned'
  sudo -u dominguez test -x "$CONTROL_ROOT" \
    && sudo -u dominguez test -x "$CONTROL_ROOT/pm2" \
    || die 'legacy PM2 account cannot traverse its root-owned runtime'
fi
if test "$CONTROL_PLANE_MODE" != rollback; then require_no_builder_processes; fi
if test "$RESUME_TRANSACTION" -eq 1; then
  STAGE_DIR="$(jq -r .stagePath "$TRANSACTION_STATE")"
elif test "$CONTROL_PLANE_MODE" = rollback; then
  STAGE_DIR=
elif test -e "$VERSION_ROOT/$SOURCE_SHA" || test -L "$VERSION_ROOT/$SOURCE_SHA"; then
  STAGE_DIR=
else
  STAGE_DIR="$STAGING_ROOT/$SOURCE_SHA.candidate"
  if test -e "$STAGE_DIR" || test -L "$STAGE_DIR"; then
    test -d "$STAGE_DIR" && test ! -L "$STAGE_DIR" \
      || die 'orphan candidate staging path is unsafe'
    ORPHAN_STAGE_PRESENT=1
  fi
fi

as_builder() {
  /usr/bin/systemd-run \
    --wait --pipe --quiet --collect \
    --property=Type=exec \
    --property=User="$BUILD_USER" \
    --property=Group="$BUILD_GID" \
    --property=WorkingDirectory="$STAGE_DIR" \
    --property=UMask=0077 \
    --property=NoNewPrivileges=yes \
    --property=PrivateDevices=yes \
    --property=PrivateTmp=yes \
    --property=ProtectControlGroups=yes \
    --property=ProtectHome=yes \
    --property=ProtectKernelModules=yes \
    --property=ProtectKernelTunables=yes \
    --property=ProtectSystem=strict \
    --property=RestrictSUIDSGID=yes \
    --property=Delegate=no \
    --property=RemainAfterExit=no \
    --property=KillMode=control-group \
    --property=SendSIGKILL=yes \
    --property=TimeoutStopSec=15s \
    --property=ReadWritePaths="$STAGE_DIR" \
    /usr/bin/env -i \
    HOME="$STAGE_DIR/.build-home" PATH=/usr/bin:/bin \
    GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 \
    GIT_TERMINAL_PROMPT=0 NPM_CONFIG_CACHE="$STAGE_DIR/.npm-cache" \
    "$@"
}

normalize_builder_tracked_modes() {
  local candidate
  candidate="$1"
  as_builder /usr/bin/node --input-type=module - "$candidate" <<'NODE'
import { spawnSync } from 'node:child_process';
import { chmodSync, lstatSync } from 'node:fs';
import { join, posix, resolve } from 'node:path';
import { TextDecoder } from 'node:util';

const root = resolve(process.argv[2]);
const listed = spawnSync(
  '/usr/bin/git', ['-C', root, 'ls-files', '--stage', '-z'],
  { maxBuffer: 16 * 1024 * 1024 },
);
if (listed.error || listed.signal || listed.status !== 0 || listed.stderr.length !== 0) {
  throw new Error('tracked-mode inventory failed');
}
if (listed.stdout.length === 0 || listed.stdout.at(-1) !== 0) {
  throw new Error('tracked-mode inventory is empty or unterminated');
}
const rows = new TextDecoder('utf-8', { fatal: true })
  .decode(listed.stdout.subarray(0, -1)).split('\0');
for (const row of rows) {
  const separator = row.indexOf('\t');
  if (separator < 0) throw new Error('tracked-mode row is malformed');
  const header = row.slice(0, separator);
  const path = row.slice(separator + 1);
  const matched = /^(100644|100755|120000) (?:[0-9a-f]{40}|[0-9a-f]{64}) 0$/
    .exec(header);
  if (!matched || path.length === 0 || path.startsWith('/') || path.includes('\\')
      || posix.normalize(path) !== path || path.split('/').includes('..')) {
    throw new Error('tracked-mode entry is unsafe');
  }
  const absolute = join(root, ...path.split('/'));
  const before = lstatSync(absolute);
  if (matched[1] === '120000') {
    if (!before.isSymbolicLink()) throw new Error(`tracked symlink changed type: ${path}`);
    continue;
  }
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error(`tracked file changed type: ${path}`);
  }
  const mode = matched[1] === '100755' ? 0o755 : 0o644;
  chmodSync(absolute, mode);
  const after = lstatSync(absolute);
  if (!after.isFile() || after.isSymbolicLink() || (after.mode & 0o7777) !== mode
      || after.dev !== before.dev || after.ino !== before.ino) {
    throw new Error(`tracked file mode normalization failed: ${path}`);
  }
}
NODE
}

require_safe_candidate_tree() {
  local candidate link link_file resolved special
  candidate="$1"
  if ! special="$(find "$candidate" -xdev \
      ! \( -type d -o -type f -o -type l \) -print -quit)"; then
    die 'candidate special-object scan failed'
  fi
  test -z "$special" || die "candidate contains a special filesystem object: $special"
  if ! special="$(find "$candidate" -xdev -type f ! -links 1 -print -quit)"; then
    die 'candidate hard-link scan failed'
  fi
  test -z "$special" || die "candidate contains a hard-linked file: $special"
  link_file="$(mktemp)"
  if ! find "$candidate" -xdev -type l -print0 >"$link_file"; then
    rm -f -- "$link_file"; die 'candidate symlink scan failed'
  fi
  while IFS= read -r -d '' link; do
    if resolved="$(readlink -f -- "$link")"; then
      case "$resolved" in
        "$candidate"/*) ;;
        *) die "candidate symlink escapes its version root: $link" ;;
      esac
    else
      die "candidate contains a broken symlink: $link"
    fi
  done <"$link_file"
  rm -f -- "$link_file"
}

require_root_readonly_candidate_tree() {
  local candidate proof_file
  candidate="$1"
  require_safe_candidate_tree "$candidate"
  proof_file="$(mktemp)"
  if ! find "$candidate" -xdev \( ! -user root -o ! -group root \) \
      -print -quit >"$proof_file"; then
    rm -f -- "$proof_file"
    die 'candidate ownership scan failed'
  fi
  test ! -s "$proof_file" \
    || { rm -f -- "$proof_file"; die 'candidate contains a non-root-owned path'; }
  # Linux symlinks retain lstat mode 0777. Their separately verified internal
  # targets and root ownership govern them; only material objects need no writes.
  if ! find "$candidate" -xdev ! -type l -perm /222 \
      -print -quit >"$proof_file"; then
    rm -f -- "$proof_file"
    die 'candidate permission scan failed'
  fi
  test ! -s "$proof_file" \
    || { rm -f -- "$proof_file"; die 'candidate contains a writable material path'; }
  rm -f -- "$proof_file"
}

require_builder_quiescent() {
  local candidate error_file gvfs_identity gvfs_inventory_status gvfs_mount
  local gvfs_mount_file handles handle_status portal_identity portal_mount
  local portal_inventory_status portal_mount_file
  local -a lsof_args
  candidate="$1"
  require_no_builder_processes
  lsof_args=(-nP -F pfn)
  portal_mount_file="$(mktemp)"
  if /usr/bin/findmnt -rn -t fuse.portal -o TARGET >"$portal_mount_file"; then
    portal_inventory_status=0
  else
    portal_inventory_status=$?
  fi
  case "$portal_inventory_status" in
    0|1) ;;
    *)
      rm -f -- "$portal_mount_file"
      die 'portal-mount inventory failed before open-handle proof'
      ;;
  esac
  while IFS= read -r portal_mount; do
    test -n "$portal_mount" || {
      rm -f -- "$portal_mount_file"
      die 'portal-mount inventory contains an empty path'
    }
    [[ "$portal_mount" =~ ^/run/user/[0-9]+/doc$ ]] || {
      rm -f -- "$portal_mount_file"
      die 'portal-mount inventory contains an unexpected path'
    }
    if ! portal_identity="$(
      /usr/bin/findmnt -rn -M "$portal_mount" -o SOURCE,FSTYPE
    )"; then
      rm -f -- "$portal_mount_file"
      die 'portal-mount identity proof failed'
    fi
    test "$portal_identity" = "portal fuse.portal" || {
      rm -f -- "$portal_mount_file"
      die 'portal-mount identity changed during open-handle proof'
    }
    case "$candidate" in
      "$portal_mount"|"$portal_mount"/*)
        rm -f -- "$portal_mount_file"
        die 'candidate overlaps an exempt portal mount'
        ;;
    esac
    # lsof cannot stat desktop portal mounts even as root. Exempt only the
    # exact, independently verified fuse.portal mountpoints; every other
    # diagnostic remains a hard refusal and the candidate stays fully scanned.
    lsof_args+=(+e "$portal_mount")
  done <"$portal_mount_file"
  rm -f -- "$portal_mount_file"
  gvfs_mount_file="$(mktemp)"
  if /usr/bin/findmnt -rn -t fuse.gvfsd-fuse -o TARGET >"$gvfs_mount_file"; then
    gvfs_inventory_status=0
  else
    gvfs_inventory_status=$?
  fi
  case "$gvfs_inventory_status" in
    0|1) ;;
    *)
      rm -f -- "$gvfs_mount_file"
      die 'GVFS-mount inventory failed before open-handle proof'
      ;;
  esac
  while IFS= read -r gvfs_mount; do
    test -n "$gvfs_mount" || {
      rm -f -- "$gvfs_mount_file"
      die 'GVFS-mount inventory contains an empty path'
    }
    [[ "$gvfs_mount" =~ ^/run/user/[0-9]+/gvfs$ ]] || {
      rm -f -- "$gvfs_mount_file"
      die 'GVFS-mount inventory contains an unexpected path'
    }
    if ! gvfs_identity="$(
      /usr/bin/findmnt -rn -M "$gvfs_mount" -o SOURCE,FSTYPE
    )"; then
      rm -f -- "$gvfs_mount_file"
      die 'GVFS-mount identity proof failed'
    fi
    test "$gvfs_identity" = "gvfsd-fuse fuse.gvfsd-fuse" || {
      rm -f -- "$gvfs_mount_file"
      die 'GVFS-mount identity changed during open-handle proof'
    }
    case "$candidate" in
      "$gvfs_mount"|"$gvfs_mount"/*)
        rm -f -- "$gvfs_mount_file"
        die 'candidate overlaps an exempt GVFS mount'
        ;;
    esac
    # Like the document portal, root cannot stat the canonical desktop GVFS
    # mount. Exempt only its independently verified mountpoint; candidate
    # handles and every other diagnostic remain fail-closed.
    lsof_args+=(+e "$gvfs_mount")
  done <"$gvfs_mount_file"
  rm -f -- "$gvfs_mount_file"
  lsof_args+=(+D "$candidate")
  error_file="$(mktemp)"
  if handles="$(/usr/bin/lsof "${lsof_args[@]}" 2>"$error_file")"; then
    handle_status=0
  else
    handle_status=$?
  fi
  if test -s "$error_file"; then
    rm -f -- "$error_file"
    die 'open-handle proof emitted diagnostics'
  fi
  rm -f -- "$error_file"
  test "$handle_status" -eq 1 \
    || die 'cannot prove the candidate has no open handles'
  test -z "$handles" || die 'candidate still has an open handle'
}

require_builder_git_exact() {
  local allow_marker candidate head_file ignored_file index_file path status_file
  local -a ignored_paths index_rows untracked_paths
  candidate="$1"; allow_marker="$2"
  head_file="$(mktemp)"; status_file="$(mktemp)"
  index_file="$(mktemp)"; ignored_file="$(mktemp)"
  if ! as_builder /usr/bin/git -C "$candidate" rev-parse --verify HEAD \
      >"$head_file"; then
    rm -f -- "$head_file" "$status_file" "$index_file" "$ignored_file"
    die 'cannot rebind candidate HEAD after lifecycle execution'
  fi
  test "$(<"$head_file")" = "$SOURCE_SHA" || {
    rm -f -- "$head_file" "$status_file" "$index_file" "$ignored_file"
    die 'candidate HEAD changed during lifecycle execution'
  }
  if ! as_builder /usr/bin/git -C "$candidate" update-index --really-refresh; then
    rm -f -- "$head_file" "$status_file" "$index_file" "$ignored_file"
    die 'candidate index/worktree refresh failed after lifecycle execution'
  fi
  as_builder /usr/bin/git -C "$candidate" diff-files --quiet -- \
    || { rm -f -- "$head_file" "$status_file" "$index_file" "$ignored_file";
      die 'candidate worktree differs from its index'; }
  as_builder /usr/bin/git -C "$candidate" diff-index --cached --quiet \
    "$SOURCE_SHA" -- \
    || { rm -f -- "$head_file" "$status_file" "$index_file" "$ignored_file";
      die 'candidate index differs from the exact source commit'; }
  if ! as_builder /usr/bin/git -C "$candidate" status --porcelain=v1 \
      --untracked-files=no >"$status_file"; then
    rm -f -- "$head_file" "$status_file" "$index_file" "$ignored_file"
    die 'candidate tracked-status proof failed after lifecycle execution'
  fi
  test ! -s "$status_file" || {
    rm -f -- "$head_file" "$status_file" "$index_file" "$ignored_file"
    die 'tracked source changed during dependency installation'
  }
  if ! as_builder /usr/bin/git -C "$candidate" ls-files -v -z >"$index_file"; then
    rm -f -- "$head_file" "$status_file" "$index_file" "$ignored_file"
    die 'candidate index-flag proof failed after lifecycle execution'
  fi
  mapfile -d '' -t index_rows <"$index_file"
  for path in "${index_rows[@]}"; do
    case "$path" in
      'H '*) ;;
      *) rm -f -- "$head_file" "$status_file" "$index_file" "$ignored_file"
        die "candidate index contains a non-canonical entry flag: $path" ;;
    esac
  done
  if ! as_builder /usr/bin/git -C "$candidate" ls-files --others \
      --exclude-standard -z >"$status_file"; then
    rm -f -- "$head_file" "$status_file" "$index_file" "$ignored_file"
    die 'candidate untracked-path proof failed after lifecycle execution'
  fi
  mapfile -d '' -t untracked_paths <"$status_file"
  if test "$allow_marker" -eq 1; then
    test "${#untracked_paths[@]}" -eq 1 \
      && test "${untracked_paths[0]}" = .nexus-control-plane-ready || {
      rm -f -- "$head_file" "$status_file" "$index_file" "$ignored_file"
      die 'candidate contains an unexpected untracked path'
    }
  else
    test "${#untracked_paths[@]}" -eq 0 || {
      rm -f -- "$head_file" "$status_file" "$index_file" "$ignored_file"
      die 'dependency installation created an unexpected untracked path'
    }
  fi
  if ! as_builder /usr/bin/git -C "$candidate" ls-files --others --ignored \
      --exclude-standard -z >"$ignored_file"; then
    rm -f -- "$head_file" "$status_file" "$index_file" "$ignored_file"
    die 'candidate ignored-path proof failed after lifecycle execution'
  fi
  mapfile -d '' -t ignored_paths <"$ignored_file"
  for path in "${ignored_paths[@]}"; do
    case "$path" in
      node_modules/*) ;;
      *) rm -f -- "$head_file" "$status_file" "$index_file" "$ignored_file"
        die "dependency installation created an unexpected ignored path: $path" ;;
    esac
  done
  rm -f -- "$head_file" "$status_file" "$index_file" "$ignored_file"
}

source_tree_manifest() {
  /usr/bin/node --input-type=module - "$@" <<'NODE'
import { createHash } from 'node:crypto';
import {
  lstatSync, readFileSync, readdirSync, readlinkSync,
} from 'node:fs';
import { dirname, join, posix, relative, resolve } from 'node:path';

const [mode, rootInput, sourceSha, manifestPath, listPath, phase = 'build'] =
  process.argv.slice(2);
const root = resolve(rootInput);
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const exactKeys = (value, keys) => value && typeof value === 'object'
  && !Array.isArray(value)
  && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
const validPath = (value) => typeof value === 'string' && value.length > 0
  && value !== '.' && !value.startsWith('/') && !value.includes('\\')
  && posix.normalize(value) === value && !value.split('/').includes('..');
const describe = (path) => {
  const stat = lstatSync(join(root, path));
  const sourceMode = stat.mode & 0o7777;
  if (stat.isFile()) {
    return {
      path, type: 'file', sourceMode,
      publishedMode: sourceMode & ~0o222,
      sha256: digest(readFileSync(join(root, path))),
    };
  }
  if (stat.isSymbolicLink()) {
    return {
      path, type: 'symlink', sourceMode,
      publishedMode: sourceMode, linkTarget: readlinkSync(join(root, path)),
    };
  }
  throw new Error(`tracked path has unsupported type: ${path}`);
};

if (mode === 'create') {
  const raw = readFileSync(listPath);
  const paths = raw.toString('utf8').split('\0').filter(Boolean).sort();
  if (new Set(paths).size !== paths.length || paths.some((path) => !validPath(path))) {
    throw new Error('tracked path inventory is malformed');
  }
  const entries = paths.map(describe);
  process.stdout.write(`${JSON.stringify({
    schema: 'nexus.control-plane-source-tree.v1', sourceSha, entries,
  })}\n`);
  process.exit(0);
}

if (mode !== 'verify' || !['build', 'published'].includes(phase)) {
  throw new Error('source-tree mode is invalid');
}
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
if (!exactKeys(manifest, ['schema', 'sourceSha', 'entries'])
    || manifest.schema !== 'nexus.control-plane-source-tree.v1'
    || manifest.sourceSha !== sourceSha || !Array.isArray(manifest.entries)) {
  throw new Error('source-tree manifest identity is invalid');
}
const expected = new Map();
for (const entry of manifest.entries) {
  const common = ['path', 'type', 'sourceMode', 'publishedMode'];
  const keys = entry?.type === 'file' ? [...common, 'sha256'] : [...common, 'linkTarget'];
  if (!exactKeys(entry, keys) || !validPath(entry.path) || expected.has(entry.path)
      || !['file', 'symlink'].includes(entry.type)
      || !Number.isInteger(entry.sourceMode) || !Number.isInteger(entry.publishedMode)) {
    throw new Error('source-tree manifest entry is invalid');
  }
  const observed = describe(entry.path);
  const expectedMode = phase === 'published' ? entry.publishedMode : entry.sourceMode;
  if (observed.type !== entry.type
      || (lstatSync(join(root, entry.path)).mode & 0o7777) !== expectedMode
      || (entry.type === 'file' && observed.sha256 !== entry.sha256)
      || (entry.type === 'symlink' && observed.linkTarget !== entry.linkTarget)) {
    throw new Error(`tracked source differs from exact pre-lifecycle bytes: ${entry.path}`);
  }
  expected.set(entry.path, true);
}
const allowedDirectories = new Set();
for (const path of expected.keys()) {
  let parent = dirname(path);
  while (parent !== '.') {
    allowedDirectories.add(parent);
    parent = dirname(parent);
  }
}
const special = new Set(phase === 'published' ? [
  '.nexus-control-plane-ready',
  '.nexus-control-plane-source-tree.json',
  '.nexus-control-plane-tree.sha256',
] : []);
const walk = (directory = '') => {
  const absolute = directory ? join(root, directory) : root;
  for (const name of readdirSync(absolute).sort()) {
    const path = directory ? `${directory}/${name}` : name;
    const stat = lstatSync(join(root, path));
    if (path === 'node_modules' || path.startsWith('node_modules/')) {
      continue;
    }
    if (phase === 'build' && (path === '.git' || path.startsWith('.git/'))) {
      continue;
    }
    if (stat.isDirectory()) {
      if (!allowedDirectories.has(path)) {
        throw new Error(`unexpected directory outside node_modules: ${path}`);
      }
      walk(path);
    } else if (!expected.has(path) && !special.has(path)) {
      throw new Error(`unexpected path outside node_modules: ${path}`);
    }
  }
};
walk();
NODE
}

candidate_tree_digest() {
  /usr/bin/node --input-type=module - "$1" <<'NODE'
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
const root = resolve(process.argv[2]);
const hash = createHash('sha256');
const fileDigest = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const visit = (relative = '') => {
  const absolute = relative ? join(root, relative) : root;
  const stat = lstatSync(absolute);
  const type = stat.isDirectory() ? 'directory'
    : stat.isFile() ? 'file' : stat.isSymbolicLink() ? 'symlink' : 'unsupported';
  if (type === 'unsupported') throw new Error(`unsupported candidate object: ${relative}`);
  if (relative !== '.nexus-control-plane-tree.sha256') {
    hash.update(`${JSON.stringify({
      path: relative || '.', type, mode: stat.mode & 0o7777,
      value: type === 'file' ? fileDigest(absolute)
        : type === 'symlink' ? readlinkSync(absolute) : '',
    })}\n`);
  }
  if (type === 'directory') {
    for (const name of readdirSync(absolute).sort()) {
      visit(relative ? `${relative}/${name}` : name);
    }
  }
};
visit();
process.stdout.write(`${hash.digest('hex')}\n`);
NODE
}

candidate_control_plane_identity() {
  local candidate candidate_digest descriptor module
  candidate="$1"; candidate_digest="$2"
  descriptor="$candidate/ops/nexus-release/release-control-plane-inputs.json"
  module="$candidate/scripts/lib/release-control-plane.mjs"
  if { test -e "$descriptor" || test -L "$descriptor"; } \
      || { test -e "$module" || test -L "$module"; }; then
    test -f "$descriptor" && test ! -L "$descriptor" \
      && test -f "$module" && test ! -L "$module" \
      || die 'immutable candidate has a partial signed control-plane identity pair'
    /usr/bin/node --input-type=module - "$candidate" <<'NODE'
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = process.argv[2];
if (process.version !== 'v22.23.1') process.exit(10);
const { computeReleaseControlPlaneIdentity } = await import(pathToFileURL(
  join(root, 'scripts/lib/release-control-plane.mjs'),
));
const identity = computeReleaseControlPlaneIdentity(root, { runtimeVersion: '22.23.1' });
const require = createRequire(join(root, 'package.json'));
const Database = require('better-sqlite3');
const database = new Database(':memory:');
database.prepare('SELECT 1').get();
database.close();
process.stdout.write(`${identity.schema} ${identity.digest}\n`);
NODE
  else
    test "$CONTROL_PLANE_MODE" = rollback \
      || die 'new controller candidate lacks its signed control-plane identity'
    printf 'nexus.control-plane-tree.v1 %s\n' "$candidate_digest"
  fi
}

require_installed_backup_verifier_pair() {
  local candidate
  candidate="$1"
  if test -e "$candidate/scripts/release-installed-backup-interface-check.mjs" \
      || test -L "$candidate/scripts/release-installed-backup-interface-check.mjs" \
      || test -e "$candidate/scripts/lib/release-installed-backup-interface.mjs" \
      || test -L "$candidate/scripts/lib/release-installed-backup-interface.mjs"; then
    test -f "$candidate/scripts/release-installed-backup-interface-check.mjs" \
      && test ! -L "$candidate/scripts/release-installed-backup-interface-check.mjs" \
      && test -f "$candidate/scripts/lib/release-installed-backup-interface.mjs" \
      && test ! -L "$candidate/scripts/lib/release-installed-backup-interface.mjs" \
      || die 'immutable candidate has a partial installed-backup verifier'
  else
    test "$CONTROL_PLANE_MODE" = rollback \
      || die 'new controller candidate lacks its installed-backup verifier'
  fi
}

candidate_liveness_pair_state() {
  local candidate force launcher service timer
  candidate="$1"
  launcher="$candidate/scripts/release-backup-liveness-launcher.sh"
  force="$candidate/ops/nexus-release/nexus-release-backup-liveness-force.service"
  service="$candidate/ops/nexus-release/nexus-release-backup-liveness.service"
  timer="$candidate/ops/nexus-release/nexus-release-backup-liveness.timer"
  if { test -e "$launcher" || test -L "$launcher"; } \
      || { test -e "$force" || test -L "$force"; } \
      || { test -e "$service" || test -L "$service"; } \
      || { test -e "$timer" || test -L "$timer"; }; then
    test -f "$launcher" && test ! -L "$launcher" \
      && test "$(stat -Lc '%U:%G:%a:%h' -- "$launcher")" = root:root:555:1 \
      && test -f "$service" && test ! -L "$service" \
      && test "$(stat -Lc '%U:%G:%a:%h' -- "$service")" = root:root:444:1 \
      && test -f "$force" && test ! -L "$force" \
      && test "$(stat -Lc '%U:%G:%a:%h' -- "$force")" = root:root:444:1 \
      && test -f "$timer" && test ! -L "$timer" \
      && test "$(stat -Lc '%U:%G:%a:%h' -- "$timer")" = root:root:444:1 \
      || die 'immutable candidate has a partial or unsafe backup-liveness unit set'
    printf 'present\n'
  else
    printf 'absent\n'
  fi
}

candidate_post_gate_guards_state() {
  local absent candidate full legacy exists_guard symlink_guard unit
  candidate="$1"; absent=0; full=0; legacy=0
  for unit in nexus-release-bootstrap.service nexus-release-poller.service; do
    exists_guard=0; symlink_guard=0
    if grep -Fx \
        'ConditionPathExists=!/var/lib/nexus-release/state/control-plane-post-gate.json' \
        "$candidate/ops/nexus-release/$unit" >/dev/null; then
      exists_guard=1
    fi
    if grep -Fx \
        'ConditionPathIsSymbolicLink=!/var/lib/nexus-release/state/control-plane-post-gate.json' \
        "$candidate/ops/nexus-release/$unit" >/dev/null; then
      symlink_guard=1
    fi
    if test "$exists_guard:$symlink_guard" = 1:1; then
      full=$((full + 1))
    elif test "$exists_guard:$symlink_guard" = 1:0; then
      legacy=$((legacy + 1))
    elif test "$exists_guard:$symlink_guard" = 0:0; then
      absent=$((absent + 1))
    else
      die "immutable candidate has an unpaired post-gate workload guard: $unit"
    fi
  done
  case "$full:$legacy:$absent" in
    2:0:0) printf 'present\n' ;;
    0:2:0) printf 'legacy\n' ;;
    0:0:2) printf 'absent\n' ;;
    *) die 'immutable candidate has a partial post-gate workload guard' ;;
  esac
}

candidate_transaction_guards_state() {
  local candidate expected liveness_state symlink_count unit
  candidate="$1"; expected=3; symlink_count=0
  for unit in nexus-release-bootstrap.service nexus-release-poller.service \
    nexus-release-heartbeat.service; do
    grep -Fx \
      'ConditionPathExists=!/var/lib/nexus-release/state/control-plane-transaction.json' \
      "$candidate/ops/nexus-release/$unit" >/dev/null \
      || die "candidate unit lacks the durable transaction gate: $unit"
    if grep -Fx \
        'ConditionPathIsSymbolicLink=!/var/lib/nexus-release/state/control-plane-transaction.json' \
        "$candidate/ops/nexus-release/$unit" >/dev/null; then
      symlink_count=$((symlink_count + 1))
    fi
  done
  liveness_state="$(candidate_liveness_pair_state "$candidate")"
  if test "$liveness_state" = present; then
    expected=5
    for unit in nexus-release-backup-liveness-force.service \
      nexus-release-backup-liveness.service; do
      grep -Fx \
        'ConditionPathExists=!/var/lib/nexus-release/state/control-plane-transaction.json' \
        "$candidate/ops/nexus-release/$unit" >/dev/null \
        || die "candidate backup-liveness service lacks the durable transaction gate: $unit"
      if grep -Fx \
          'ConditionPathIsSymbolicLink=!/var/lib/nexus-release/state/control-plane-transaction.json' \
          "$candidate/ops/nexus-release/$unit" >/dev/null; then
        symlink_count=$((symlink_count + 1))
      fi
    done
  fi
  if test "$symlink_count" -eq "$expected"; then
    printf 'present\n'
  elif test "$symlink_count" -eq 0; then
    printf 'legacy\n'
  else
    die 'immutable candidate has partial transaction symlink guards'
  fi
}

require_immutable_candidate() {
  local calculated candidate expected_digest liveness_state post_gate_state \
    recorded relative transaction_guard_state unit
  candidate="$1"; expected_digest="${2:-}"
  test -d "$candidate" && test ! -L "$candidate" \
    || die "immutable candidate is absent or symbolic: $candidate"
  require_root_readonly_candidate_tree "$candidate"
  for relative in .nexus-control-plane-ready \
    .nexus-control-plane-source-tree.json .nexus-control-plane-tree.sha256; do
    test -f "$candidate/$relative" && test ! -L "$candidate/$relative" \
      && test "$(stat -Lc '%U:%G:%a:%h' -- "$candidate/$relative")" = root:root:444:1 \
      || die "immutable candidate evidence is unsafe: $relative"
  done
  test "$(<"$candidate/.nexus-control-plane-ready")" = "$EXPECTED_MARKER" \
    || die 'immutable candidate readiness marker changed'
  test ! -e "$candidate/.git" && test ! -L "$candidate/.git" \
    || die 'immutable candidate retained lifecycle-controlled Git metadata'
  source_tree_manifest verify "$candidate" "$SOURCE_SHA" \
    "$candidate/.nexus-control-plane-source-tree.json" /dev/null published \
    || die 'immutable candidate differs from its exact source-tree manifest'
  recorded="$(<"$candidate/.nexus-control-plane-tree.sha256")"
  [[ "$recorded" =~ ^[0-9a-f]{64}$ ]] \
    || die 'immutable candidate tree digest evidence is malformed'
  calculated="$(candidate_tree_digest "$candidate")" \
    || die 'immutable candidate tree digest recomputation failed'
  test "$calculated" = "$recorded" \
    || die 'immutable candidate tree digest changed'
  if test -n "$expected_digest"; then
    test "$calculated" = "$expected_digest" \
      || die 'immutable candidate differs from the durable transaction digest'
  fi
  for relative in package.json package-lock.json scripts/release-poll.sh \
    scripts/release-deploy.mjs scripts/release-state-view.mjs \
    scripts/local-backup-systemd-install.sh scripts/local-backup.py \
    scripts/local-backup-retry-launcher.sh \
    scripts/lib/release-bootstrap.mjs scripts/lib/release-environment.mjs \
    scripts/lib/release-protected-head.mjs \
    ops/nexus-release/nexus-release-state-view \
    ops/nexus-release/nexus-release-state-view.sudoers \
    ops/nexus-release/nexus-release-bootstrap.service \
    ops/nexus-release/nexus-release-poller.service \
    ops/nexus-release/nexus-release-poller.timer \
    ops/nexus-release/nexus-release-heartbeat.service \
    ops/nexus-release/nexus-release-heartbeat.timer \
    ops/local-backup/systemd/nexus-local-backup.service \
    ops/local-backup/systemd/nexus-local-backup.timer \
    ops/local-backup/systemd/nexus-local-backup-pre-promotion.service \
    ops/local-backup/systemd/nexus-local-backup-restore-verify.service \
    ops/local-backup/systemd/nexus-local-backup-restore-verify.timer \
    ops/local-backup/nexus-local-backup.sudoers; do
    test -f "$candidate/$relative" && test ! -L "$candidate/$relative" \
      || die "critical immutable candidate path is absent or symbolic: $relative"
  done
  require_installed_backup_verifier_pair "$candidate"
  liveness_state="$(candidate_liveness_pair_state "$candidate")"
  post_gate_state="$(candidate_post_gate_guards_state "$candidate")"
  transaction_guard_state="$(candidate_transaction_guards_state "$candidate")"
  if test "$CONTROL_PLANE_MODE" != rollback; then
    test "$liveness_state" = present \
      || die 'new controller candidate lacks its backup-liveness unit set'
    test "$post_gate_state" = present \
      || die 'new controller candidate lacks its post-gate workload guards'
    test "$transaction_guard_state" = present \
      || die 'new controller candidate lacks transaction symlink guards'
  fi
  /usr/bin/node --input-type=module -e "
    import { createRequire } from 'node:module';
    if (process.version !== 'v22.23.1') process.exit(10);
    const require = createRequire('$candidate/package.json');
    const Database = require('better-sqlite3');
    const db = new Database(':memory:');
    db.prepare('SELECT 1').get();
    db.close();
    await import('file://$candidate/scripts/lib/release-bootstrap.mjs');
    await import('file://$candidate/scripts/lib/release-environment.mjs');
    await import('file://$candidate/scripts/lib/release-protected-head.mjs');
  " || die 'immutable candidate Node/native proof failed'
  if test -f "$candidate/scripts/lib/release-installed-backup-interface.mjs"; then
    /usr/bin/node --input-type=module -e \
      "await import('file://$candidate/scripts/lib/release-installed-backup-interface.mjs')" \
      || die 'immutable candidate installed-backup verifier import failed'
  fi
}

read_timer_bits() {
  local active load_state unit unit_file_state
  unit="$1"
  if ! load_state="$(systemctl show --property=LoadState --value "$unit")"; then
    die "cannot read timer load state: $unit"
  fi
  test "$load_state" = loaded || die "timer is not exactly loaded: $unit ($load_state)"
  if ! active="$(systemctl show --property=ActiveState --value "$unit")"; then
    die "cannot read timer active state: $unit"
  fi
  if ! unit_file_state="$(systemctl show --property=UnitFileState --value "$unit")"; then
    die "cannot read timer unit-file state: $unit"
  fi
  case "$active" in active) active=1 ;; inactive) active=0 ;;
    *) die "timer active state is not admissible: $unit ($active)" ;; esac
  case "$unit_file_state" in enabled) unit_file_state=1 ;; disabled) unit_file_state=0 ;;
    *) die "timer unit-file state is not admissible: $unit ($unit_file_state)" ;; esac
  printf '%s %s\n' "$active" "$unit_file_state"
}

read_timer_bits_or_absent() {
  local active fragment load_state unit
  unit="$1"
  load_state="$(systemctl show --property=LoadState --value "$unit")" \
    || die "cannot read timer load state: $unit"
  if test "$load_state" = loaded; then
    read_timer_bits "$unit"
    return
  fi
  active="$(systemctl show --property=ActiveState --value "$unit")" \
    || die "cannot read absent timer active state: $unit"
  fragment="$(systemctl show --property=FragmentPath --value "$unit")" \
    || die "cannot read absent timer fragment: $unit"
  test "$load_state" = not-found && test "$active" = inactive && test -z "$fragment" \
    || die "timer is neither exactly loaded nor exactly absent: $unit"
  printf '0 0\n'
}

disable_timer_if_present() {
  local load_state unit
  unit="$1"
  load_state="$(systemctl show --property=LoadState --value "$unit")" || return 1
  case "$load_state" in
    loaded) systemctl disable --now "$unit" ;;
    not-found)
      test "$(systemctl show --property=ActiveState --value "$unit")" = inactive \
        && test -z "$(systemctl show --property=FragmentPath --value "$unit")"
      ;;
    *) return 1 ;;
  esac
}

require_no_physical_unit_dropins() {
  local dropin_name unit_path unit_paths_output
  if ! unit_paths_output="$(/usr/bin/env -i PATH=/usr/bin:/bin \
      /usr/bin/systemd-analyze unit-paths)"; then
    die 'cannot enumerate systemd unit search paths for drop-in proof'
  fi
  test -n "$unit_paths_output" || die 'systemd unit search path list is empty'
  while IFS= read -r unit_path; do
    case "$unit_path" in /*) ;; *) die "systemd returned a relative unit path: $unit_path" ;; esac
    for dropin_name in \
      nexus-release-bootstrap.service.d nexus-release-poller.service.d \
      nexus-release-poller.timer.d nexus-release-heartbeat.service.d \
      nexus-release-heartbeat.timer.d \
      nexus-release-backup-liveness-force.service.d \
      nexus-release-backup-liveness.service.d \
      nexus-release-backup-liveness.timer.d \
      nexus-release-.service.d nexus-.service.d service.d \
      nexus-release-.timer.d nexus-.timer.d timer.d; do
      test ! -e "$unit_path/$dropin_name" && test ! -L "$unit_path/$dropin_name" \
        || die "systemd drop-in authority is forbidden: $unit_path/$dropin_name"
    done
  done <<<"$unit_paths_output"
}

require_initial_no_authority() {
  local active dropin fragment load_state unit unit_path unit_paths_output
  require_no_physical_unit_dropins
  if ! unit_paths_output="$(/usr/bin/env -i PATH=/usr/bin:/bin \
      /usr/bin/systemd-analyze unit-paths)"; then
    die 'cannot enumerate systemd unit search paths for initial admission'
  fi
  while IFS= read -r unit_path; do
    case "$unit_path" in /*) ;; *) die "systemd returned a relative unit path: $unit_path" ;; esac
    for unit in nexus-release-bootstrap.service nexus-release-poller.service \
      nexus-release-poller.timer nexus-release-heartbeat.service \
      nexus-release-heartbeat.timer nexus-release-backup-liveness-force.service \
      nexus-release-backup-liveness.service \
      nexus-release-backup-liveness.timer; do
      test ! -e "$unit_path/$unit" && test ! -L "$unit_path/$unit" \
        || die "initial mode found physical release-unit definition: $unit_path/$unit"
    done
  done <<<"$unit_paths_output"
  for unit in nexus-release-bootstrap.service nexus-release-poller.service \
    nexus-release-poller.timer nexus-release-heartbeat.service \
    nexus-release-heartbeat.timer nexus-release-backup-liveness-force.service \
    nexus-release-backup-liveness.service \
    nexus-release-backup-liveness.timer; do
    if ! load_state="$(systemctl show --property=LoadState --value "$unit")"; then
      die "cannot read initial release-unit load state: $unit"
    fi
    if ! active="$(systemctl show --property=ActiveState --value "$unit")"; then
      die "cannot read initial release-unit active state: $unit"
    fi
    if ! fragment="$(systemctl show --property=FragmentPath --value "$unit")"; then
      die "cannot read initial release-unit fragment path: $unit"
    fi
    if ! dropin="$(systemctl show --property=DropInPaths --value "$unit")"; then
      die "cannot read initial release-unit drop-in paths: $unit"
    fi
    test "$load_state" = not-found && test "$active" = inactive \
      && test -z "$fragment" && test -z "$dropin" \
      || die "initial mode found pre-existing release authority: $unit"
  done
}

require_initial_no_backup_authority() {
  local active dropin fragment load_state path unit
  for path in \
    /usr/local/libexec/nexus-local-backup/local-backup.py \
    /usr/local/libexec/nexus-local-backup/local-backup-retry-launcher.sh \
    /etc/sudoers.d/nexus-local-backup \
    /etc/systemd/system/nexus-local-backup.service \
    /etc/systemd/system/nexus-local-backup.timer \
    /etc/systemd/system/nexus-local-backup-pre-promotion.service \
    /etc/systemd/system/nexus-local-backup-restore-verify.service \
    /etc/systemd/system/nexus-local-backup-restore-verify.timer; do
    test ! -e "$path" && test ! -L "$path" \
      || die "initial mode found installed local-backup authority: $path"
  done
  for unit in nexus-local-backup.service nexus-local-backup.timer \
    nexus-local-backup-pre-promotion.service \
    nexus-local-backup-restore-verify.service \
    nexus-local-backup-restore-verify.timer; do
    load_state="$(systemctl show --property=LoadState --value "$unit")"
    active="$(systemctl show --property=ActiveState --value "$unit")"
    fragment="$(systemctl show --property=FragmentPath --value "$unit")"
    dropin="$(systemctl show --property=DropInPaths --value "$unit")"
    test "$load_state" = not-found && test "$active" = inactive \
      && test -z "$fragment" && test -z "$dropin" \
      || die "initial mode found effective local-backup authority: $unit"
  done
}

installed_liveness_pair_state() {
  local allow_partial force service timer unit_path
  allow_partial="${1:-0}"
  force=/etc/systemd/system/nexus-release-backup-liveness-force.service
  service=/etc/systemd/system/nexus-release-backup-liveness.service
  timer=/etc/systemd/system/nexus-release-backup-liveness.timer
  if { test ! -e "$force" && test ! -L "$force"; } \
      && { test ! -e "$service" && test ! -L "$service"; } \
      && { test ! -e "$timer" && test ! -L "$timer"; }; then
    printf 'absent\n'
    return
  fi
  if test -f "$force" && test ! -L "$force" \
      && test "$(stat -Lc '%U:%G:%a:%h' -- "$force")" = root:root:644:1 \
      && test -f "$service" && test ! -L "$service" \
      && test "$(stat -Lc '%U:%G:%a:%h' -- "$service")" = root:root:644:1 \
      && test -f "$timer" && test ! -L "$timer" \
      && test "$(stat -Lc '%U:%G:%a:%h' -- "$timer")" = root:root:644:1; then
    printf 'present\n'
    return
  fi
  if test "$allow_partial" -eq 1; then
    for unit_path in "$force" "$service" "$timer"; do
      if test -e "$unit_path" || test -L "$unit_path"; then
        test -f "$unit_path" && test ! -L "$unit_path" \
          && test "$(stat -Lc '%U:%G:%a:%h' -- "$unit_path")" = root:root:644:1 \
          || die "installed backup-liveness transition unit is unsafe: $unit_path"
      fi
    done
    printf 'partial\n'
    return
  fi
  die 'installed backup-liveness unit set is partial or unsafe'
}

require_selected_liveness_interface() {
  local active candidate_state dropin fragment installed_state load_state unit
  active="$1"
  candidate_state="$(candidate_liveness_pair_state "$active")"
  installed_state="$(installed_liveness_pair_state)"
  if test "$candidate_state" = present; then
    test "$installed_state" = present \
      || die 'selected controller backup-liveness unit set is not installed'
    for unit in nexus-release-backup-liveness-force.service \
      nexus-release-backup-liveness.service \
      nexus-release-backup-liveness.timer; do
      cmp -s -- "$active/ops/nexus-release/$unit" "/etc/systemd/system/$unit" \
        || die "installed backup-liveness unit differs from selected controller: $unit"
      load_state="$(systemctl show "$unit" --property=LoadState --value)"
      fragment="$(systemctl show "$unit" --property=FragmentPath --value)"
      dropin="$(systemctl show "$unit" --property=DropInPaths --value)"
      test "$load_state" = loaded \
        && test "$fragment" = "/etc/systemd/system/$unit" \
        && test -z "$dropin" \
        && test "$(systemctl show "$unit" --property=NeedDaemonReload --value)" = no \
        || die "effective backup-liveness unit is not exact: $unit"
    done
  else
    test "$installed_state" = absent \
      || die 'retained controller unexpectedly has installed backup-liveness units'
    for unit in nexus-release-backup-liveness-force.service \
      nexus-release-backup-liveness.service \
      nexus-release-backup-liveness.timer; do
      load_state="$(systemctl show "$unit" --property=LoadState --value)"
      fragment="$(systemctl show "$unit" --property=FragmentPath --value)"
      dropin="$(systemctl show "$unit" --property=DropInPaths --value)"
      test "$load_state" = not-found \
        && test "$(systemctl show "$unit" --property=ActiveState --value)" = inactive \
        && test -z "$fragment" && test -z "$dropin" \
        || die "retained controller has effective backup-liveness authority: $unit"
    done
  fi
}

require_exact_effective_core_systemd_units() {
  local dropin fragment load_state unit
  for unit in nexus-release-bootstrap.service nexus-release-poller.service \
    nexus-release-poller.timer nexus-release-heartbeat.service \
    nexus-release-heartbeat.timer; do
    if ! load_state="$(systemctl show --property=LoadState --value "$unit")"; then
      die "cannot read installed release-unit load state: $unit"
    fi
    if ! fragment="$(systemctl show --property=FragmentPath --value "$unit")"; then
      die "cannot read installed release-unit fragment path: $unit"
    fi
    if ! dropin="$(systemctl show --property=DropInPaths --value "$unit")"; then
      die "cannot read installed release-unit drop-in paths: $unit"
    fi
    test "$load_state" = loaded \
      && test "$fragment" = "/etc/systemd/system/$unit" \
      && test -z "$dropin" \
      || die "effective release-unit authority is not exact: $unit"
  done
}

require_exact_effective_systemd_units() {
  local active
  require_exact_effective_core_systemd_units
  active="$(selector_or_absent "$ACTIVE_LINK")"
  test -n "$active" || die 'effective release-unit proof has no active controller'
  require_selected_liveness_interface "$active"
}

require_control_plane_services_settled() {
  local active allow_transition_partial liveness_state load_state require_loaded unit
  require_loaded="${1:-0}"
  allow_transition_partial="${2:-0}"
  for unit in nexus-release-poller.service nexus-release-bootstrap.service \
    nexus-release-heartbeat.service; do
    if ! load_state="$(systemctl show --property=LoadState --value "$unit")"; then
      die "cannot read root control-plane service load state: $unit"
    fi
    if ! active="$(systemctl show --property=ActiveState --value "$unit")"; then
      die "cannot read root control-plane service active state: $unit"
    fi
    case "$load_state:$active" in
      loaded:inactive|loaded:failed) ;;
      not-found:inactive)
        test "$require_loaded" -eq 0 \
          || die "installed root control-plane service is not loaded: $unit"
        ;;
      *) die "root control-plane service is not settled: $unit ($load_state/$active)" ;;
    esac
  done
  liveness_state="$(installed_liveness_pair_state "$allow_transition_partial")"
  for unit in nexus-release-backup-liveness-force.service \
    nexus-release-backup-liveness.service; do
    load_state="$(systemctl show "$unit" --property=LoadState --value)"
    active="$(systemctl show "$unit" --property=ActiveState --value)"
    if test "$liveness_state" = present; then
      case "$load_state:$active" in loaded:inactive|loaded:failed) ;;
        *) die "backup-liveness service is not settled: $unit ($load_state/$active)" ;; esac
    elif test "$liveness_state" = partial; then
      case "$load_state:$active" in
        loaded:inactive|loaded:failed|not-found:inactive) ;;
        *) die "transition backup-liveness service is not settled: $unit ($load_state/$active)" ;;
      esac
    else
      test "$load_state:$active" = not-found:inactive \
        || die "absent backup-liveness service is not settled: $unit ($load_state/$active)"
    fi
  done
}

require_poller_service_clean() {
  local active exec_status load_state result unit
  unit=nexus-release-poller.service
  load_state="$(systemctl show "$unit" --property=LoadState --value)"
  active="$(systemctl show "$unit" --property=ActiveState --value)"
  result="$(systemctl show "$unit" --property=Result --value)"
  exec_status="$(systemctl show "$unit" --property=ExecMainStatus --value)"
  test "$load_state:$active:$result:$exec_status" = loaded:inactive:success:0 \
    || die "poller service is not clean before authority restoration: $load_state/$active/$result/$exec_status"
}

require_local_backup_services_settled() {
  local active fragment load_state unit
  for unit in nexus-local-backup.service \
    nexus-local-backup-pre-promotion.service \
    nexus-local-backup-restore-verify.service; do
    load_state="$(systemctl show --property=LoadState --value "$unit")" \
      || die "cannot read local-backup service load state: $unit"
    active="$(systemctl show --property=ActiveState --value "$unit")" \
      || die "cannot read local-backup service active state: $unit"
    fragment="$(systemctl show --property=FragmentPath --value "$unit")" \
      || die "cannot read local-backup service fragment: $unit"
    case "$load_state:$active" in
      loaded:inactive) test -n "$fragment" ;;
      not-found:inactive) test -z "$fragment" ;;
      *) false ;;
    esac || die "local-backup service is not settled: $unit ($load_state/$active)"
  done
}

verify_installed_backup_interface() {
  local active_root destination destination_mode source source_mode spec unit
  active_root="$(selector_or_absent "$ACTIVE_LINK")"
  test "$active_root" = "$TARGET" \
    || die 'installed local-backup proof is not using the transaction target'
  for spec in \
    'scripts/local-backup.py|/usr/local/libexec/nexus-local-backup/local-backup.py|555|755' \
    'scripts/local-backup-retry-launcher.sh|/usr/local/libexec/nexus-local-backup/local-backup-retry-launcher.sh|555|755' \
    'ops/local-backup/systemd/nexus-local-backup.service|/etc/systemd/system/nexus-local-backup.service|444|644' \
    'ops/local-backup/systemd/nexus-local-backup.timer|/etc/systemd/system/nexus-local-backup.timer|444|644' \
    'ops/local-backup/systemd/nexus-local-backup-pre-promotion.service|/etc/systemd/system/nexus-local-backup-pre-promotion.service|444|644' \
    'ops/local-backup/systemd/nexus-local-backup-restore-verify.service|/etc/systemd/system/nexus-local-backup-restore-verify.service|444|644' \
    'ops/local-backup/systemd/nexus-local-backup-restore-verify.timer|/etc/systemd/system/nexus-local-backup-restore-verify.timer|444|644' \
    'ops/local-backup/nexus-local-backup.sudoers|/etc/sudoers.d/nexus-local-backup|444|440'; do
    IFS='|' read -r source destination source_mode destination_mode <<<"$spec"
    source="$active_root/$source"
    test -f "$source" && test ! -L "$source" \
      && test "$(stat -Lc '%U:%G:%a:%h' -- "$source")" = \
        "root:root:$source_mode:1" \
      || die "governed immutable local-backup source is unsafe: $source"
    test -f "$destination" && test ! -L "$destination" \
      && test "$(stat -Lc '%U:%G:%a:%h' -- "$destination")" = \
        "root:root:$destination_mode:1" \
      && cmp -s -- "$source" "$destination" \
      || die "installed local-backup authority differs from source: $destination"
  done
  /usr/sbin/visudo -cf /etc/sudoers.d/nexus-local-backup >/dev/null \
    || die 'installed local-backup sudoers policy is invalid'
  for unit in nexus-local-backup.service nexus-local-backup.timer \
    nexus-local-backup-pre-promotion.service \
    nexus-local-backup-restore-verify.service \
    nexus-local-backup-restore-verify.timer; do
    test "$(systemctl show "$unit" --property=LoadState --value)" = loaded \
      && test "$(systemctl show "$unit" --property=FragmentPath --value)" = \
        "/etc/systemd/system/$unit" \
      && test -z "$(systemctl show "$unit" --property=DropInPaths --value)" \
      && test "$(systemctl show "$unit" --property=NeedDaemonReload --value)" = no \
      || die "installed local-backup effective unit is not exact: $unit"
  done
  # Exact unit-byte binding above also binds each governed ExecStopPost. New
  # controllers add the descriptor-safe verifier; a retained older rollback
  # target is accepted only through this equivalent inline proof.
  if test -f "$active_root/scripts/release-installed-backup-interface-check.mjs" \
      && test ! -L "$active_root/scripts/release-installed-backup-interface-check.mjs"; then
    /usr/bin/env -i PATH=/usr/bin:/bin HOME=/var/lib/nexus-release/home \
      /usr/bin/node \
      /opt/nexus-release/checkout/scripts/release-installed-backup-interface-check.mjs \
      >/dev/null \
      || die 'installed local-backup checker refused the active controller'
  else
    test "$CONTROL_PLANE_MODE" = rollback \
      || die 'installed local-backup checker is absent outside rollback'
  fi
}

selected_guard_pair_is_compatible() {
  local active marker post_gate_state transaction_guard_state
  active="$1"; post_gate_state="$2"; transaction_guard_state="$3"
  if test "$CONTROL_PLANE_MODE" = rollback; then
    return 0
  fi
  test "$CONTROL_PLANE_MODE" = upgrade || return 1
  if test "$post_gate_state:$transaction_guard_state" = present:present; then
    return 0
  fi
  test "$post_gate_state:$transaction_guard_state" = absent:legacy \
    || return 1
  test "$active" = "$VERSION_ROOT/$LEGACY_UPGRADE_PREDECESSOR_SHA" \
    || return 1
  marker="$active/.nexus-control-plane-ready"
  test -f "$marker" && test ! -L "$marker" \
    && test "$(stat -Lc '%U:%G:%a:%h' -- "$marker")" = root:root:444:1 \
    && test "$(<"$marker")" = "$LEGACY_UPGRADE_PREDECESSOR_MARKER"
}

require_installed_transaction_gate() {
  local active allow_transition_partial liveness_state post_gate_state \
    transaction_guard_state unit
  allow_transition_partial="${1:-0}"
  active="$(selector_or_absent "$ACTIVE_LINK")"
  test -n "$active" || die 'transaction-gate proof has no selected controller'
  post_gate_state="$(candidate_post_gate_guards_state "$active")"
  transaction_guard_state="$(candidate_transaction_guards_state "$active")"
  selected_guard_pair_is_compatible \
    "$active" "$post_gate_state" "$transaction_guard_state" \
    || die 'selected controller guard pair is incompatible with the requested operation'
  for unit in nexus-release-bootstrap.service nexus-release-poller.service \
    nexus-release-heartbeat.service; do
    test -f "/etc/systemd/system/$unit" && test ! -L "/etc/systemd/system/$unit" \
      && test "$(stat -Lc '%U:%G:%a:%h' -- "/etc/systemd/system/$unit")" \
        = root:root:644:1 \
      || die "installed transaction-gated service is unsafe: $unit"
    grep -Fx 'ConditionPathExists=!/var/lib/nexus-release/state/control-plane-transaction.json' \
      "/etc/systemd/system/$unit" >/dev/null \
      || die "installed service cannot honor the durable transaction gate: $unit"
    if test "$transaction_guard_state" = present \
        && test "$allow_transition_partial" -eq 0; then
      grep -Fx \
        'ConditionPathIsSymbolicLink=!/var/lib/nexus-release/state/control-plane-transaction.json' \
        "/etc/systemd/system/$unit" >/dev/null \
        || die "installed service cannot honor a symbolic transaction gate: $unit"
    fi
  done
  if test "$post_gate_state" = present; then
    if test "$allow_transition_partial" -eq 0; then
      for unit in nexus-release-bootstrap.service nexus-release-poller.service; do
        grep -Fx \
          'ConditionPathExists=!/var/lib/nexus-release/state/control-plane-post-gate.json' \
          "/etc/systemd/system/$unit" >/dev/null \
          || die "installed service cannot honor the post-gate journal: $unit"
        grep -Fx \
          'ConditionPathIsSymbolicLink=!/var/lib/nexus-release/state/control-plane-post-gate.json' \
          "/etc/systemd/system/$unit" >/dev/null \
          || die "installed service cannot honor a symbolic post-gate journal: $unit"
      done
    fi
  elif test "$post_gate_state" = absent; then
    test "$CONTROL_PLANE_MODE" = rollback \
      || test "$CONTROL_PLANE_MODE" = upgrade \
      || die 'selected controller lacks post-gate guards outside upgrade or rollback'
  elif test "$post_gate_state" != legacy; then
    die 'selected controller post-gate guard state is unsupported'
  fi
  liveness_state="$(installed_liveness_pair_state "$allow_transition_partial")"
  if test "$liveness_state" = present || test "$liveness_state" = partial; then
    for unit in nexus-release-backup-liveness-force.service \
      nexus-release-backup-liveness.service; do
      if test "$liveness_state" = partial \
          && test ! -e "/etc/systemd/system/$unit" \
          && test ! -L "/etc/systemd/system/$unit"; then
        continue
      fi
      grep -Fx \
        'ConditionPathExists=!/var/lib/nexus-release/state/control-plane-transaction.json' \
        "/etc/systemd/system/$unit" >/dev/null \
        || die "installed backup-liveness service cannot honor the transaction gate: $unit"
      if test "$transaction_guard_state" = present \
          && test "$allow_transition_partial" -eq 0; then
        grep -Fx \
          'ConditionPathIsSymbolicLink=!/var/lib/nexus-release/state/control-plane-transaction.json' \
          "/etc/systemd/system/$unit" >/dev/null \
          || die "installed backup-liveness service cannot honor a symbolic transaction gate: $unit"
      fi
    done
  fi
}

selector_or_absent() {
  local link resolved
  link="$1"
  if test ! -e "$link" && test ! -L "$link"; then printf '\n'; return 0; fi
  test -L "$link" || die "control-plane selector is not symbolic: $link"
  if ! resolved="$(readlink -f -- "$link")"; then
    die "control-plane selector is broken: $link"
  fi
  [[ "$resolved" =~ ^$VERSION_ROOT/[0-9a-f]{40}$ ]] \
    || die "control-plane selector escapes the immutable version root: $link"
  printf '%s\n' "$resolved"
}

publish_selector() {
  local desired link relative stage
  link="$1"; relative="$2"; desired="$3"; stage="$link.next"
  if test -e "$stage" || test -L "$stage"; then
    test -L "$stage" && test "$(readlink -- "$stage")" = "$relative" \
      && test "$(readlink -f -- "$stage")" = "$desired" \
      && test "$(stat -c '%U:%G:%F' -- "$stage")" = 'root:root:symbolic link' \
      || die "selector staging remnant is unsafe: $stage"
  else
    ln -s -- "$relative" "$stage"
    chown -h root:root "$stage"
    sync -f "$CONTROL_ROOT"
  fi
  if test "$(selector_or_absent "$link")" = "$desired"; then
    rm -f -- "$stage"
  else
    mv -T -- "$stage" "$link"
  fi
  sync -f "$CONTROL_ROOT"
  test "$(selector_or_absent "$link")" = "$desired" \
    || die "selector publication did not select the durable target: $link"
}

install_atomic_root_file() {
  local ancestor_identity destination expected mode source stage
  source="$1"; destination="$2"; mode="$3"; stage="$destination.next-control-plane"
  expected="root:root:$mode:1"
  ancestor_identity="$(trusted_destination_ancestor_identity "$destination")" \
    || die "installed control-plane ancestor is unsafe: $destination"
  if test -e "$destination" || test -L "$destination"; then
    test -f "$destination" && test ! -L "$destination" \
      && test "$(stat -Lc '%U:%G:%a:%h' -- "$destination")" = "$expected" \
      || die "installed control-plane file is unsafe: $destination"
  fi
  if test -e "$stage" || test -L "$stage"; then
    test -f "$stage" && test ! -L "$stage" \
      && test "$(stat -Lc '%U:%G:%a:%h' -- "$stage")" = "$expected" \
      || die "control-plane file staging remnant is unsafe: $stage"
    if ! cmp -s -- "$source" "$stage"; then
      rm -f -- "$stage"
      sync -f "$(dirname "$destination")"
    fi
  fi
  if test ! -e "$stage" && test ! -L "$stage"; then
    install -o root -g root -m "$mode" -- "$source" "$stage"
    sync -f "$stage"; sync -f "$(dirname "$destination")"
  fi
  if test -f "$destination" && test ! -L "$destination" \
      && cmp -s -- "$source" "$destination"; then
    rm -f -- "$stage"
  else
    mv -T -- "$stage" "$destination"
  fi
  sync -f "$destination"; sync -f "$(dirname "$destination")"
  test "$(stat -Lc '%U:%G:%a:%h' -- "$destination")" = "$expected" \
    && cmp -s -- "$source" "$destination" \
    || die "atomic control-plane file publication failed: $destination"
  test "$(trusted_destination_ancestor_identity "$destination")" = \
      "$ancestor_identity" \
    || die "installed control-plane ancestor changed: $destination"
}

prove_installed_control_plane() {
  local active capability_ancestors unit
  active="$1"
  capability_ancestors="$(trusted_destination_ancestor_identity \
    /usr/local/sbin/nexus-release-state-view \
    /etc/sudoers.d/nexus-release-state-view)" \
    || die 'installed capability ancestor proof failed'
  test "$(stat -Lc '%U:%G:%a:%h' -- /usr/local/sbin/nexus-release-state-view)" \
    = root:root:755:1 \
    && cmp -s -- "$active/ops/nexus-release/nexus-release-state-view" \
      /usr/local/sbin/nexus-release-state-view \
    || die 'installed state-view wrapper differs from the selected candidate'
  test "$(stat -Lc '%U:%G:%a:%h' -- /etc/sudoers.d/nexus-release-state-view)" \
    = root:root:440:1 \
    && cmp -s -- "$active/ops/nexus-release/nexus-release-state-view.sudoers" \
      /etc/sudoers.d/nexus-release-state-view \
    || die 'installed state-view sudoers rule differs from the selected candidate'
  /usr/sbin/visudo -cf /etc/sudoers.d/nexus-release-state-view >/dev/null \
    || die 'installed state-view sudoers rule is invalid'
  /usr/bin/sudo -u dominguez /usr/bin/sudo -n \
    /usr/local/sbin/nexus-release-state-view >/dev/null \
    || die 'installed delegated state-view proof failed'
  for unit in nexus-release-bootstrap.service nexus-release-poller.service \
    nexus-release-poller.timer nexus-release-heartbeat.service \
    nexus-release-heartbeat.timer; do
    test "$(stat -Lc '%U:%G:%a:%h' -- "/etc/systemd/system/$unit")" = root:root:644:1 \
      && cmp -s -- "$active/ops/nexus-release/$unit" "/etc/systemd/system/$unit" \
      || die "installed unit differs from selected candidate: $unit"
  done
  require_selected_liveness_interface "$active"
  test "$(trusted_destination_ancestor_identity \
    /usr/local/sbin/nexus-release-state-view \
    /etc/sudoers.d/nexus-release-state-view)" = "$capability_ancestors" \
    || die 'installed capability ancestor identity changed'
}

require_installed_transition_bytes() {
  local destination entry incoming incoming_liveness mode outgoing \
    outgoing_liveness relative unit
  outgoing="$1"; incoming="$2"
  for entry in \
    'ops/nexus-release/nexus-release-state-view:/usr/local/sbin/nexus-release-state-view:755' \
    'ops/nexus-release/nexus-release-state-view.sudoers:/etc/sudoers.d/nexus-release-state-view:440'; do
    IFS=: read -r relative destination mode <<<"$entry"
    test -f "$destination" && test ! -L "$destination" \
      && test "$(stat -Lc '%U:%G:%a:%h' -- "$destination")" = "root:root:$mode:1" \
      && { cmp -s -- "$outgoing/$relative" "$destination" \
        || cmp -s -- "$incoming/$relative" "$destination"; } \
      || die "installed transition file differs from both durable versions: $destination"
  done
  /usr/sbin/visudo -cf /etc/sudoers.d/nexus-release-state-view >/dev/null \
    || die 'installed transition sudoers rule is invalid'
  for unit in nexus-release-bootstrap.service nexus-release-poller.service \
    nexus-release-poller.timer nexus-release-heartbeat.service \
    nexus-release-heartbeat.timer; do
    destination="/etc/systemd/system/$unit"
    test -f "$destination" && test ! -L "$destination" \
      && test "$(stat -Lc '%U:%G:%a:%h' -- "$destination")" = root:root:644:1 \
      && { cmp -s -- "$outgoing/ops/nexus-release/$unit" "$destination" \
        || cmp -s -- "$incoming/ops/nexus-release/$unit" "$destination"; } \
      || die "installed transition unit differs from both durable versions: $unit"
  done
  outgoing_liveness="$(candidate_liveness_pair_state "$outgoing")"
  incoming_liveness="$(candidate_liveness_pair_state "$incoming")"
  for unit in nexus-release-backup-liveness-force.service \
    nexus-release-backup-liveness.service \
    nexus-release-backup-liveness.timer; do
    destination="/etc/systemd/system/$unit"
    if test -e "$destination" || test -L "$destination"; then
      test -f "$destination" && test ! -L "$destination" \
        && test "$(stat -Lc '%U:%G:%a:%h' -- "$destination")" = root:root:644:1 \
        && { { test "$outgoing_liveness" = present \
              && cmp -s -- "$outgoing/ops/nexus-release/$unit" "$destination"; } \
          || { test "$incoming_liveness" = present \
              && cmp -s -- "$incoming/ops/nexus-release/$unit" "$destination"; }; } \
        || die "installed liveness transition unit is unsafe or unknown: $unit"
    else
      test "$outgoing_liveness" = absent || test "$incoming_liveness" = absent \
        || die "installed liveness transition unit disappeared: $unit"
    fi
  done
}

require_installed_initial_transition_bytes() {
  local destination entry incoming mode relative unit
  incoming="$1"
  for entry in \
    'ops/nexus-release/nexus-release-state-view:/usr/local/sbin/nexus-release-state-view:755' \
    'ops/nexus-release/nexus-release-state-view.sudoers:/etc/sudoers.d/nexus-release-state-view:440'; do
    IFS=: read -r relative destination mode <<<"$entry"
    if test -e "$destination" || test -L "$destination"; then
      test -f "$destination" && test ! -L "$destination" \
        && test "$(stat -Lc '%U:%G:%a:%h' -- "$destination")" = "root:root:$mode:1" \
        && cmp -s -- "$incoming/$relative" "$destination" \
        || die "initial transition file differs from its durable candidate: $destination"
    fi
  done
  if test -e /etc/sudoers.d/nexus-release-state-view; then
    /usr/sbin/visudo -cf /etc/sudoers.d/nexus-release-state-view >/dev/null \
      || die 'initial transition sudoers rule is invalid'
  fi
  for unit in nexus-release-bootstrap.service nexus-release-poller.service \
    nexus-release-poller.timer nexus-release-heartbeat.service \
    nexus-release-heartbeat.timer nexus-release-backup-liveness-force.service \
    nexus-release-backup-liveness.service \
    nexus-release-backup-liveness.timer; do
    destination="/etc/systemd/system/$unit"
    if test -e "$destination" || test -L "$destination"; then
      test -f "$destination" && test ! -L "$destination" \
        && test "$(stat -Lc '%U:%G:%a:%h' -- "$destination")" = root:root:644:1 \
        && cmp -s -- "$incoming/ops/nexus-release/$unit" "$destination" \
        || die "initial transition unit differs from its durable candidate: $unit"
    fi
  done
}

remove_installed_liveness_for_absent_target() {
  local destination installed_path outgoing outgoing_state stage unit
  outgoing="$1"
  outgoing_state="$(candidate_liveness_pair_state "$outgoing")"
  for unit in nexus-release-backup-liveness-force.service \
    nexus-release-backup-liveness.service \
    nexus-release-backup-liveness.timer; do
    destination="/etc/systemd/system/$unit"
    stage="$destination.next-control-plane"
    for installed_path in "$destination" "$stage"; do
      if test -e "$installed_path" || test -L "$installed_path"; then
        test "$outgoing_state" = present \
          && test -f "$installed_path" && test ! -L "$installed_path" \
          && test "$(stat -Lc '%U:%G:%a:%h' -- "$installed_path")" = root:root:644:1 \
          && cmp -s -- "$outgoing/ops/nexus-release/$unit" "$installed_path" \
          || die "rollback liveness removal path is unsafe or unknown: $installed_path"
        rm -f -- "$installed_path"
        sync -f /etc/systemd/system
      fi
    done
  done
}

publish_transaction_phase() {
  local local_record phase
  phase="$1"; local_record="$(mktemp)"
  jq -cn --argjson backupTimerWasActive "$BACKUP_TIMER_WAS_ACTIVE" \
    --argjson backupTimerWasEnabled "$BACKUP_TIMER_WAS_ENABLED" \
    --arg candidateDigest "$CANDIDATE_DIGEST" \
    --arg controlPlaneDigest "$CONTROL_PLANE_DIGEST" \
    --arg controlPlaneSchema "$CONTROL_PLANE_SCHEMA" \
    --arg createdAt "$TRANSACTION_CREATED_AT" --arg expectedMarker "$EXPECTED_MARKER" \
    --argjson heartbeatTimerWasActive "$HEARTBEAT_TIMER_WAS_ACTIVE" \
    --argjson heartbeatTimerWasEnabled "$HEARTBEAT_TIMER_WAS_ENABLED" \
    --argjson livenessTimerDesiredActive "$LIVENESS_TIMER_DESIRED_ACTIVE" \
    --argjson livenessTimerDesiredEnabled "$LIVENESS_TIMER_DESIRED_ENABLED" \
    --argjson livenessTimerWasActive "$LIVENESS_TIMER_WAS_ACTIVE" \
    --argjson livenessTimerWasEnabled "$LIVENESS_TIMER_WAS_ENABLED" \
    --arg mode "$CONTROL_PLANE_MODE" --arg operation "$TRANSACTION_OPERATION" \
    --arg originalActivePath "$ORIGINAL_ACTIVE_PATH" \
    --arg originalPreviousPath "$ORIGINAL_PREVIOUS_PATH" --arg phase "$phase" \
    --argjson pollerTimerDesiredActive "$POLLER_TIMER_DESIRED_ACTIVE" \
    --argjson pollerTimerDesiredEnabled "$POLLER_TIMER_DESIRED_ENABLED" \
    --argjson pollerTimerWasActive "$POLLER_TIMER_WAS_ACTIVE" \
    --argjson pollerTimerWasEnabled "$POLLER_TIMER_WAS_ENABLED" \
    --argjson restoreVerifyTimerWasActive "$RESTORE_VERIFY_TIMER_WAS_ACTIVE" \
    --argjson restoreVerifyTimerWasEnabled "$RESTORE_VERIFY_TIMER_WAS_ENABLED" \
    --arg sourceRepository "$SOURCE_REPOSITORY" --arg stageIdentity "$STAGE_IDENTITY" \
    --arg stagePath "$RECORDED_STAGE_PATH" --arg targetPath "$TARGET" \
    --arg targetSha "$SOURCE_SHA" --arg updatedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '
      {schema:"nexus.control-plane-transaction.v1",operation:$operation,mode:$mode,
       targetSha:$targetSha,sourceRepository:$sourceRepository,
       expectedMarker:$expectedMarker,targetPath:$targetPath,
       stagePath:$stagePath,stageIdentity:$stageIdentity,
       candidateDigest:$candidateDigest,controlPlaneSchema:$controlPlaneSchema,
       controlPlaneDigest:$controlPlaneDigest,originalActivePath:$originalActivePath,
       originalPreviousPath:$originalPreviousPath,
       pollerTimerDesiredActive:$pollerTimerDesiredActive,
       pollerTimerDesiredEnabled:$pollerTimerDesiredEnabled,
       pollerTimerWasActive:$pollerTimerWasActive,
       pollerTimerWasEnabled:$pollerTimerWasEnabled,
       heartbeatTimerWasActive:$heartbeatTimerWasActive,
       heartbeatTimerWasEnabled:$heartbeatTimerWasEnabled,
       livenessTimerWasActive:$livenessTimerWasActive,
       livenessTimerWasEnabled:$livenessTimerWasEnabled,
       livenessTimerDesiredActive:$livenessTimerDesiredActive,
       livenessTimerDesiredEnabled:$livenessTimerDesiredEnabled,
       backupTimerWasActive:$backupTimerWasActive,
       backupTimerWasEnabled:$backupTimerWasEnabled,
       restoreVerifyTimerWasActive:$restoreVerifyTimerWasActive,
       restoreVerifyTimerWasEnabled:$restoreVerifyTimerWasEnabled,
       phase:$phase,createdAt:$createdAt,updatedAt:$updatedAt}
    ' >"$local_record" || { rm -f -- "$local_record"; die 'transaction JSON creation failed'; }
  if test -e "$TRANSACTION_STAGE" || test -L "$TRANSACTION_STAGE"; then
    test -f "$TRANSACTION_STAGE" && test ! -L "$TRANSACTION_STAGE" \
      && test "$(stat -Lc '%U:%G:%a:%h' -- "$TRANSACTION_STAGE")" = root:root:600:1 \
      || { rm -f -- "$local_record"; die 'transaction staging path is unsafe'; }
    rm -f -- "$TRANSACTION_STAGE"
    sync -f "$STATE_ROOT"
  fi
  install -o root -g root -m 600 -- "$local_record" "$TRANSACTION_STAGE"
  rm -f -- "$local_record"
  sync -f "$TRANSACTION_STAGE"; sync -f "$STATE_ROOT"
  mv -T -- "$TRANSACTION_STAGE" "$TRANSACTION_STATE"
  sync -f "$TRANSACTION_STATE"; sync -f "$STATE_ROOT"
  require_transaction_file "$TRANSACTION_STATE"
  TRANSACTION_DURABLE=1
  TRANSACTION_PHASE="$phase"
}

if test "$CONTROL_PLANE_MODE" = initial \
    && test "$RESUME_TRANSACTION" -eq 0 && test -n "$STAGE_DIR"; then
  # Establish the no-authority premise before running untrusted lifecycle code;
  # it is re-proved immediately before the durable gate is published.
  require_initial_no_authority
  require_initial_no_backup_authority
fi

if test "$RESUME_TRANSACTION" -eq 0 && test -n "$STAGE_DIR"; then
if test "$ORPHAN_STAGE_PRESENT" -eq 1; then
  require_builder_quiescent "$STAGE_DIR"
  sudo rm -rf -- "$STAGE_DIR"
  sudo sync -f "$STAGING_ROOT"
fi
sudo install -d -o "$BUILD_USER" -g "$BUILD_GID" -m 700 "$STAGE_DIR"
as_builder /usr/bin/git -C "$STAGE_DIR" init --quiet
as_builder /usr/bin/git -C "$STAGE_DIR" config core.hooksPath /dev/null
as_builder /usr/bin/git -C "$STAGE_DIR" remote add origin "$SOURCE_REPOSITORY"
# The transient builder has no interactive credential helper. Pin Git protocol
# v0 and HTTP/1.1: the canonical anonymous GitHub remote is readable with this
# transport pair while v2 or HTTP/2 negotiation can incorrectly request
# credentials in this sandbox. The exact protected SHA is still verified
# immediately below before checkout.
as_builder /usr/bin/git -C "$STAGE_DIR" -c protocol.version=0 -c http.version=HTTP/1.1 fetch --quiet --no-tags --depth=1 \
  origin "$SOURCE_REF"
FETCHED_SHA="$(as_builder /usr/bin/git -C "$STAGE_DIR" rev-parse --verify 'FETCH_HEAD^{commit}')"
test "$FETCHED_SHA" = "$SOURCE_SHA" \
  || die 'protected main no longer equals the exact owner-reviewed SHA'
as_builder /usr/bin/git -C "$STAGE_DIR" checkout --quiet --detach "$SOURCE_SHA"
normalize_builder_tracked_modes "$STAGE_DIR" \
  || die 'candidate tracked-mode normalization failed'
require_builder_git_exact "$STAGE_DIR" "$FORBID_UNTRACKED_MARKER"
test -f "$STAGE_DIR/package.json" && test ! -L "$STAGE_DIR/package.json" \
  || die 'package.json is absent or symbolic'
test -f "$STAGE_DIR/package-lock.json" && test ! -L "$STAGE_DIR/package-lock.json" \
  || die 'package-lock.json is absent or symbolic'

# Capture the exact tracked filesystem bytes outside the builder's mount
# namespace before any lifecycle code can modify either the worktree or .git.
SOURCE_LIST_TEMP="$(mktemp)"
SOURCE_MANIFEST_TEMP="$(mktemp)"
if ! as_builder /usr/bin/git -C "$STAGE_DIR" ls-files -z >"$SOURCE_LIST_TEMP"; then
  die 'pre-lifecycle tracked-path capture failed'
fi
source_tree_manifest create "$STAGE_DIR" "$SOURCE_SHA" /dev/null \
  "$SOURCE_LIST_TEMP" >"$SOURCE_MANIFEST_TEMP" \
  || die 'pre-lifecycle source-tree manifest creation failed'

# Lifecycle scripts run only inside the unprivileged candidate. They are required
# for the Node-22 native better-sqlite3 binding; the active root tree is never built.
as_builder /usr/bin/npm --prefix "$STAGE_DIR" ci \
  --omit=dev --no-audit --no-fund
as_builder /usr/bin/npm --prefix "$STAGE_DIR" ls --omit=dev --depth=0 \
  || die 'production dependency inventory is incomplete'
test -f "$STAGE_DIR/node_modules/better-sqlite3/package.json" \
  && test ! -L "$STAGE_DIR/node_modules/better-sqlite3/package.json" \
  || die 'better-sqlite3 package is absent or symbolic'
as_builder /usr/bin/node --input-type=module -e "
  import { createRequire } from 'node:module';
  if (process.version !== 'v22.23.1') process.exit(10);
  const require = createRequire('$STAGE_DIR/package.json');
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  db.prepare('SELECT 1').get();
  db.close();
  await import('file://$STAGE_DIR/scripts/lib/release-bootstrap.mjs');
  await import('file://$STAGE_DIR/scripts/lib/release-environment.mjs');
  await import('file://$STAGE_DIR/scripts/lib/release-installed-backup-interface.mjs');
  await import('file://$STAGE_DIR/scripts/lib/release-protected-head.mjs');
" || die 'Node-22 better-sqlite3 import/execute proof failed'

for relative in package.json package-lock.json scripts/release-poll.sh \
  scripts/release-deploy.mjs scripts/release-state-view.mjs \
  scripts/release-installed-backup-interface-check.mjs \
  scripts/local-backup-systemd-install.sh scripts/local-backup.py \
  scripts/local-backup-retry-launcher.sh \
  scripts/lib/release-installed-backup-interface.mjs \
  scripts/lib/release-bootstrap.mjs scripts/lib/release-environment.mjs \
  scripts/lib/release-protected-head.mjs \
  ops/nexus-release/nexus-release-state-view \
  ops/nexus-release/nexus-release-state-view.sudoers \
  ops/nexus-release/nexus-release-bootstrap.service \
  ops/nexus-release/nexus-release-poller.service \
  ops/nexus-release/nexus-release-poller.timer \
  ops/nexus-release/nexus-release-heartbeat.service \
  ops/nexus-release/nexus-release-heartbeat.timer \
  ops/local-backup/systemd/nexus-local-backup.service \
  ops/local-backup/systemd/nexus-local-backup.timer \
  ops/local-backup/systemd/nexus-local-backup-pre-promotion.service \
  ops/local-backup/systemd/nexus-local-backup-restore-verify.service \
  ops/local-backup/systemd/nexus-local-backup-restore-verify.timer \
  ops/local-backup/nexus-local-backup.sudoers; do
  test -f "$STAGE_DIR/$relative" && test ! -L "$STAGE_DIR/$relative" \
    || die "critical control-plane path is absent or symbolic: $relative"
done
as_builder /usr/bin/rm -rf -- "$STAGE_DIR/.npm-cache" "$STAGE_DIR/.build-home"
require_builder_git_exact "$STAGE_DIR" "$FORBID_UNTRACKED_MARKER"
source_tree_manifest verify "$STAGE_DIR" "$SOURCE_SHA" \
  "$SOURCE_MANIFEST_TEMP" /dev/null build \
  || die 'post-lifecycle tracked bytes differ from the pre-lifecycle manifest'
# Runtime code never consults the local repository. Retiring .git removes all
# lifecycle-controlled config, excludes, refs, index flags, and replace refs
# from the root-owned candidate instead of treating them as provenance.
as_builder /usr/bin/rm -rf -- "$STAGE_DIR/.git"
require_safe_candidate_tree "$STAGE_DIR"
require_builder_quiescent "$STAGE_DIR"

for relative in .nexus-control-plane-ready \
  .nexus-control-plane-source-tree.json .nexus-control-plane-tree.sha256; do
  test ! -e "$STAGE_DIR/$relative" && test ! -L "$STAGE_DIR/$relative" \
    || die "candidate pre-created root evidence path: $relative"
done
MARKER_TMP="$(mktemp)"
printf '%s\n' "$EXPECTED_MARKER" >"$MARKER_TMP"
sudo install -o root -g root -m 444 "$MARKER_TMP" \
  "$STAGE_DIR/.nexus-control-plane-ready"
rm -f -- "$MARKER_TMP"
sudo install -o root -g root -m 444 "$SOURCE_MANIFEST_TEMP" \
  "$STAGE_DIR/.nexus-control-plane-source-tree.json"
rm -f -- "$SOURCE_LIST_TEMP" "$SOURCE_MANIFEST_TEMP"
SOURCE_LIST_TEMP=
SOURCE_MANIFEST_TEMP=
sudo chown -hR root:root "$STAGE_DIR"
sudo chmod -R a-w "$STAGE_DIR"
require_root_readonly_candidate_tree "$STAGE_DIR"
test "$(sudo cat "$STAGE_DIR/.nexus-control-plane-ready")" = "$EXPECTED_MARKER" \
  || die 'candidate readiness marker changed'
source_tree_manifest verify "$STAGE_DIR" "$SOURCE_SHA" \
  "$STAGE_DIR/.nexus-control-plane-source-tree.json" /dev/null published \
  || die 'published candidate differs from the pre-lifecycle tracked bytes'
CANDIDATE_DIGEST="$(candidate_tree_digest "$STAGE_DIR")" \
  || die 'candidate tree digest failed'
[[ "$CANDIDATE_DIGEST" =~ ^[0-9a-f]{64}$ ]] \
  || die 'candidate tree digest is malformed'
DIGEST_TMP="$(mktemp)"
printf '%s\n' "$CANDIDATE_DIGEST" >"$DIGEST_TMP"
sudo install -o root -g root -m 444 "$DIGEST_TMP" \
  "$STAGE_DIR/.nexus-control-plane-tree.sha256"
rm -f -- "$DIGEST_TMP"
fi

TARGET="$VERSION_ROOT/$SOURCE_SHA"
if test "$CONTROL_PLANE_MODE" != rollback; then
  test "$(stat -Lc '%d' -- "$STAGING_ROOT")" = "$(stat -Lc '%d' -- "$VERSION_ROOT")" \
    || die 'staging and immutable version roots are not on the same filesystem'
fi

if test "$CONTROL_PLANE_MODE" != initial; then
  require_release_lock
  test -f "$MAINTENANCE_LOCK" && test ! -L "$MAINTENANCE_LOCK" \
    && test "$(stat -Lc '%U:%G:%a:%h' -- "$MAINTENANCE_LOCK")" = root:dominguez:660:1 \
    || die 'maintenance mutex is absent or unsafe'
  exec 9<>"$RELEASE_LOCK"
  test "$(stat -Lc '%d:%i' -- /proc/$$/fd/9)" = \
    "$(stat -Lc '%d:%i' -- "$RELEASE_LOCK")" \
    || die 'release mutex changed identity before acquisition'
  /usr/bin/flock -n 9 || die 'a release is active'
  test "$(stat -Lc '%d:%i' -- /proc/$$/fd/9)" = \
    "$(stat -Lc '%d:%i' -- "$RELEASE_LOCK")" \
    || die 'release mutex changed identity after acquisition'
  exec 8<>"$MAINTENANCE_LOCK"
  test "$(stat -Lc '%d:%i' -- /proc/$$/fd/8)" = \
    "$(stat -Lc '%d:%i' -- "$MAINTENANCE_LOCK")" \
    || die 'maintenance mutex changed identity before acquisition'
  /usr/bin/flock -n 8 || die 'root maintenance is active'
  test "$(stat -Lc '%d:%i' -- /proc/$$/fd/8)" = \
    "$(stat -Lc '%d:%i' -- "$MAINTENANCE_LOCK")" \
    || die 'maintenance mutex changed identity after acquisition'
fi

if test "$RESUME_TRANSACTION" -eq 1; then
  CANDIDATE_DIGEST="$(jq -er .candidateDigest "$TRANSACTION_STATE")"
  CONTROL_PLANE_SCHEMA="$(jq -er .controlPlaneSchema "$TRANSACTION_STATE")"
  CONTROL_PLANE_DIGEST="$(jq -er .controlPlaneDigest "$TRANSACTION_STATE")"
  TRANSACTION_CREATED_AT="$(jq -er .createdAt "$TRANSACTION_STATE")"
  TRANSACTION_PHASE="$(jq -er .phase "$TRANSACTION_STATE")"
  RESUME_FROM_PHASE="$TRANSACTION_PHASE"
  ORIGINAL_ACTIVE_PATH="$(jq -r .originalActivePath "$TRANSACTION_STATE")"
  ORIGINAL_PREVIOUS_PATH="$(jq -r .originalPreviousPath "$TRANSACTION_STATE")"
  RECORDED_STAGE_PATH="$(jq -r .stagePath "$TRANSACTION_STATE")"
  STAGE_IDENTITY="$(jq -r .stageIdentity "$TRANSACTION_STATE")"
  POLLER_TIMER_WAS_ACTIVE="$(jq -er .pollerTimerWasActive "$TRANSACTION_STATE")"
  POLLER_TIMER_WAS_ENABLED="$(jq -er .pollerTimerWasEnabled "$TRANSACTION_STATE")"
  POLLER_TIMER_DESIRED_ACTIVE="$(jq -er .pollerTimerDesiredActive "$TRANSACTION_STATE")"
  POLLER_TIMER_DESIRED_ENABLED="$(jq -er .pollerTimerDesiredEnabled "$TRANSACTION_STATE")"
  HEARTBEAT_TIMER_WAS_ACTIVE="$(jq -er .heartbeatTimerWasActive "$TRANSACTION_STATE")"
  HEARTBEAT_TIMER_WAS_ENABLED="$(jq -er .heartbeatTimerWasEnabled "$TRANSACTION_STATE")"
  LIVENESS_TIMER_WAS_ACTIVE="$(jq -er .livenessTimerWasActive "$TRANSACTION_STATE")"
  LIVENESS_TIMER_WAS_ENABLED="$(jq -er .livenessTimerWasEnabled "$TRANSACTION_STATE")"
  LIVENESS_TIMER_DESIRED_ACTIVE="$(jq -er \
    .livenessTimerDesiredActive "$TRANSACTION_STATE")"
  LIVENESS_TIMER_DESIRED_ENABLED="$(jq -er \
    .livenessTimerDesiredEnabled "$TRANSACTION_STATE")"
  BACKUP_TIMER_WAS_ACTIVE="$(jq -er .backupTimerWasActive "$TRANSACTION_STATE")"
  BACKUP_TIMER_WAS_ENABLED="$(jq -er .backupTimerWasEnabled "$TRANSACTION_STATE")"
  RESTORE_VERIFY_TIMER_WAS_ACTIVE="$(jq -er \
    .restoreVerifyTimerWasActive "$TRANSACTION_STATE")"
  RESTORE_VERIFY_TIMER_WAS_ENABLED="$(jq -er \
    .restoreVerifyTimerWasEnabled "$TRANSACTION_STATE")"
else
  ORIGINAL_ACTIVE_PATH="$(selector_or_absent "$ACTIVE_LINK")"
  ORIGINAL_PREVIOUS_PATH="$(selector_or_absent "$PREVIOUS_LINK")"
  if test "$ORIGINAL_ACTIVE_PATH" = "$TARGET"; then
    if test "$CONTROL_PLANE_MODE" = initial; then
      test -z "$ORIGINAL_PREVIOUS_PATH" \
        || die 'completed initial install unexpectedly has a predecessor'
    else
      test -n "$ORIGINAL_PREVIOUS_PATH" && test "$ORIGINAL_PREVIOUS_PATH" != "$TARGET" \
        || die 'completed upgrade lacks its distinct predecessor'
    fi
    require_immutable_candidate "$TARGET"
    require_no_physical_unit_dropins
    prove_installed_control_plane "$TARGET"
    systemctl daemon-reload
    require_exact_effective_systemd_units
    require_control_plane_services_settled 1
    require_local_backup_services_settled
    verify_installed_backup_interface
    if test "$CONTROL_PLANE_MODE" = initial; then
      test "$(read_timer_bits nexus-release-poller.timer)" = '0 0' \
        && test "$(read_timer_bits nexus-release-heartbeat.timer)" = '0 0' \
        && test "$(read_timer_bits nexus-release-backup-liveness.timer)" = '0 0' \
        && test "$(read_timer_bits nexus-local-backup.timer)" = '0 0' \
        && test "$(read_timer_bits nexus-local-backup-restore-verify.timer)" = '0 0' \
        || die 'completed initial install has timer authority'
    else
      read_timer_bits nexus-release-poller.timer >/dev/null
      read_timer_bits nexus-release-heartbeat.timer >/dev/null
      read_timer_bits_or_absent nexus-release-backup-liveness.timer >/dev/null
      read_timer_bits nexus-local-backup.timer >/dev/null
      read_timer_bits nexus-local-backup-restore-verify.timer >/dev/null
    fi
    printf 'immutable control plane %s is already complete; mode=%s\n' \
      "$SOURCE_SHA" "$CONTROL_PLANE_MODE"
    exit 0
  fi
  if test "$CONTROL_PLANE_MODE" = initial; then
    test -z "$ORIGINAL_ACTIVE_PATH" && test -z "$ORIGINAL_PREVIOUS_PATH" \
      || die 'initial install found an existing selector'
    POLLER_TIMER_WAS_ACTIVE=0; POLLER_TIMER_WAS_ENABLED=0
    POLLER_TIMER_DESIRED_ACTIVE=0; POLLER_TIMER_DESIRED_ENABLED=0
    HEARTBEAT_TIMER_WAS_ACTIVE=0; HEARTBEAT_TIMER_WAS_ENABLED=0
    LIVENESS_TIMER_WAS_ACTIVE=0; LIVENESS_TIMER_WAS_ENABLED=0
    LIVENESS_TIMER_DESIRED_ACTIVE=0; LIVENESS_TIMER_DESIRED_ENABLED=0
    BACKUP_TIMER_WAS_ACTIVE=0; BACKUP_TIMER_WAS_ENABLED=0
    RESTORE_VERIFY_TIMER_WAS_ACTIVE=0; RESTORE_VERIFY_TIMER_WAS_ENABLED=0
  elif test "$CONTROL_PLANE_MODE" = upgrade; then
    test -n "$ORIGINAL_ACTIVE_PATH" && test "$ORIGINAL_ACTIVE_PATH" != "$TARGET" \
      || die 'upgrade requires a distinct active predecessor'
  else
    test -n "$ORIGINAL_ACTIVE_PATH" && test "$ORIGINAL_ACTIVE_PATH" != "$TARGET" \
      || die 'rollback requires a distinct active outgoing version'
    test "$ORIGINAL_PREVIOUS_PATH" = "$TARGET" \
      || die 'checkout.previous does not select the owner-reviewed rollback SHA'
  fi
  if test "$CONTROL_PLANE_MODE" != initial; then
    require_no_physical_unit_dropins
    prove_installed_control_plane "$ORIGINAL_ACTIVE_PATH"
    require_installed_transaction_gate
    systemctl daemon-reload
    require_exact_effective_systemd_units
    POLLER_BITS="$(read_timer_bits nexus-release-poller.timer)" \
      || die 'poller timer snapshot failed'
    read -r POLLER_TIMER_WAS_ACTIVE POLLER_TIMER_WAS_ENABLED <<<"$POLLER_BITS"
    HEARTBEAT_BITS="$(read_timer_bits nexus-release-heartbeat.timer)" \
      || die 'heartbeat timer snapshot failed'
    read -r HEARTBEAT_TIMER_WAS_ACTIVE HEARTBEAT_TIMER_WAS_ENABLED <<<"$HEARTBEAT_BITS"
    LIVENESS_BITS="$(read_timer_bits_or_absent nexus-release-backup-liveness.timer)" \
      || die 'backup-liveness timer snapshot failed'
    read -r LIVENESS_TIMER_WAS_ACTIVE LIVENESS_TIMER_WAS_ENABLED \
      <<<"$LIVENESS_BITS"
    require_local_backup_services_settled
    BACKUP_BITS="$(read_timer_bits nexus-local-backup.timer)" \
      || die 'backup timer snapshot failed'
    read -r BACKUP_TIMER_WAS_ACTIVE BACKUP_TIMER_WAS_ENABLED <<<"$BACKUP_BITS"
    RESTORE_VERIFY_BITS="$(read_timer_bits nexus-local-backup-restore-verify.timer)" \
      || die 'restore-verify timer snapshot failed'
    read -r RESTORE_VERIFY_TIMER_WAS_ACTIVE RESTORE_VERIFY_TIMER_WAS_ENABLED \
      <<<"$RESTORE_VERIFY_BITS"
  fi
  if test -n "$STAGE_DIR"; then
    require_immutable_candidate "$STAGE_DIR"
    TARGET_LIVENESS_STATE="$(candidate_liveness_pair_state "$STAGE_DIR")"
    TARGET_POST_GATE_STATE="$(candidate_post_gate_guards_state "$STAGE_DIR")"
    CANDIDATE_DIGEST="$(<"$STAGE_DIR/.nexus-control-plane-tree.sha256")"
    RECORDED_STAGE_PATH="$STAGE_DIR"
    STAGE_IDENTITY="$(stat -Lc '%d:%i' -- "$STAGE_DIR")"
  else
    require_immutable_candidate "$TARGET"
    TARGET_LIVENESS_STATE="$(candidate_liveness_pair_state "$TARGET")"
    TARGET_POST_GATE_STATE="$(candidate_post_gate_guards_state "$TARGET")"
    CANDIDATE_DIGEST="$(<"$TARGET/.nexus-control-plane-tree.sha256")"
    RECORDED_STAGE_PATH=
    STAGE_IDENTITY=
  fi
  CONTROL_PLANE_IDENTITY="$(candidate_control_plane_identity \
    "${RECORDED_STAGE_PATH:-$TARGET}" "$CANDIDATE_DIGEST")" \
    || die 'candidate control-plane identity proof failed'
  read -r CONTROL_PLANE_SCHEMA CONTROL_PLANE_DIGEST <<<"$CONTROL_PLANE_IDENTITY"
  [[ "$CONTROL_PLANE_SCHEMA" =~ ^nexus\.(release-control-plane|control-plane-tree)\.v1$ ]] \
    && [[ "$CONTROL_PLANE_DIGEST" =~ ^[0-9a-f]{64}$ ]] \
    || die 'candidate control-plane identity is malformed'
  if test "$CONTROL_PLANE_MODE" = initial; then
    test "$TARGET_LIVENESS_STATE" = present \
      || die 'initial controller lacks the signed backup-liveness unit set'
  else
    if test "$TARGET_POST_GATE_STATE" = present; then
      POLLER_TIMER_DESIRED_ACTIVE="$POLLER_TIMER_WAS_ACTIVE"
      POLLER_TIMER_DESIRED_ENABLED="$POLLER_TIMER_WAS_ENABLED"
    else
      test "$CONTROL_PLANE_MODE" = rollback \
        || die 'only rollback may select a controller without post-gate guards'
      POLLER_TIMER_DESIRED_ACTIVE=0
      POLLER_TIMER_DESIRED_ENABLED="$POLLER_TIMER_WAS_ENABLED"
    fi
  fi
  if test "$CONTROL_PLANE_MODE" = initial; then
    : # Initial liveness desired bits were fixed at 0/0 before candidate build.
  elif test "$TARGET_LIVENESS_STATE" = present; then
    # Preserve an existing operator decision. A newly introduced unit set snapshots
    # as 0/0 and is activated only by the separate attended post-transaction step.
    LIVENESS_TIMER_DESIRED_ACTIVE="$LIVENESS_TIMER_WAS_ACTIVE"
    LIVENESS_TIMER_DESIRED_ENABLED="$LIVENESS_TIMER_WAS_ENABLED"
  else
    test "$CONTROL_PLANE_MODE" = rollback \
      || die 'only rollback may select a controller without backup-liveness units'
    LIVENESS_TIMER_DESIRED_ACTIVE=0
    LIVENESS_TIMER_DESIRED_ENABLED=0
  fi
  # `sync -f` is syncfs: flush the complete immutable candidate filesystem and
  # its publication parent before the separately mounted state record can claim
  # `prepared`. A later move also flushes target and both version parents.
  if test -n "$RECORDED_STAGE_PATH"; then
    sync -f "$RECORDED_STAGE_PATH"
    sync -f "$STAGING_ROOT"
  else
    sync -f "$TARGET"
    sync -f "$VERSION_ROOT"
  fi
  if test "$CONTROL_PLANE_MODE" = initial; then
    require_initial_no_authority
    require_initial_no_backup_authority
  else
    # The outgoing installed services must already observe the gate; otherwise
    # a kill after state publication but before timer disable could restore
    # authority through an older cached unit definition.
    require_no_physical_unit_dropins
    prove_installed_control_plane "$ORIGINAL_ACTIVE_PATH"
    require_installed_transaction_gate
    systemctl daemon-reload
    require_exact_effective_systemd_units
    test "$(read_timer_bits nexus-release-poller.timer)" = \
      "$POLLER_TIMER_WAS_ACTIVE $POLLER_TIMER_WAS_ENABLED" \
      || die 'poller timer changed after its exact snapshot'
    test "$(read_timer_bits nexus-release-heartbeat.timer)" = \
      "$HEARTBEAT_TIMER_WAS_ACTIVE $HEARTBEAT_TIMER_WAS_ENABLED" \
      || die 'heartbeat timer changed after its exact snapshot'
    test "$(read_timer_bits_or_absent nexus-release-backup-liveness.timer)" = \
      "$LIVENESS_TIMER_WAS_ACTIVE $LIVENESS_TIMER_WAS_ENABLED" \
      || die 'backup-liveness timer changed after its exact snapshot'
    test "$(read_timer_bits nexus-local-backup.timer)" = \
      "$BACKUP_TIMER_WAS_ACTIVE $BACKUP_TIMER_WAS_ENABLED" \
      || die 'backup timer changed after its exact snapshot'
    test "$(read_timer_bits nexus-local-backup-restore-verify.timer)" = \
      "$RESTORE_VERIFY_TIMER_WAS_ACTIVE $RESTORE_VERIFY_TIMER_WAS_ENABLED" \
      || die 'restore-verify timer changed after its exact snapshot'
  fi
  TRANSACTION_CREATED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  publish_transaction_phase prepared
  RESUME_FROM_PHASE=prepared
fi

# From the first durable timer snapshot until final gate retirement, every
# error path disables all five release/backup timers. Initial records zero
# authority; upgrade/rollback persist the exact live bits plus target-aware
# backup-liveness desired bits proved above.
TIMER_FAILSAFE_ARMED=1

for TIMER_UNIT in nexus-release-poller.timer nexus-release-heartbeat.timer \
  nexus-release-backup-liveness.timer nexus-local-backup.timer \
  nexus-local-backup-restore-verify.timer; do
  disable_timer_if_present "$TIMER_UNIT" \
    || die "timer could not be disabled for control-plane transition: $TIMER_UNIT"
  test "$(read_timer_bits_or_absent "$TIMER_UNIT")" = '0 0' \
    || die "timer retained authority during control-plane transition: $TIMER_UNIT"
done
unset TIMER_UNIT
require_local_backup_services_settled
require_control_plane_services_settled 0 "$RESUME_TRANSACTION"

if test "$RESUME_TRANSACTION" -eq 1; then
  require_no_physical_unit_dropins
  if test "$CONTROL_PLANE_MODE" != initial; then
    require_installed_transaction_gate 1
  fi
fi

# A durable state may describe only the exact pre-move stage or exact final
# version. Both/neither is incoherent; the recorded inode prevents substitution.
if test -n "$RECORDED_STAGE_PATH"; then
  test "$RECORDED_STAGE_PATH" = "$STAGING_ROOT/$SOURCE_SHA.candidate" \
    && [[ "$STAGE_IDENTITY" =~ ^[0-9]+:[0-9]+$ ]] \
    || die 'durable candidate staging identity is malformed'
  if test -e "$RECORDED_STAGE_PATH" || test -L "$RECORDED_STAGE_PATH"; then
    test ! -e "$TARGET" && test ! -L "$TARGET" \
      || die 'both staged and immutable candidate paths exist'
    test "$(stat -Lc '%d:%i' -- "$RECORDED_STAGE_PATH")" = "$STAGE_IDENTITY" \
      || die 'candidate staging inode changed'
    require_builder_quiescent "$RECORDED_STAGE_PATH"
    require_immutable_candidate "$RECORDED_STAGE_PATH" "$CANDIDATE_DIGEST"
  else
    test -d "$TARGET" && test ! -L "$TARGET" \
      || die 'neither staged nor immutable candidate path exists'
    require_immutable_candidate "$TARGET" "$CANDIDATE_DIGEST"
  fi
else
  test -d "$TARGET" && test ! -L "$TARGET" \
    || die 'adopted immutable candidate is absent or symbolic'
  require_immutable_candidate "$TARGET" "$CANDIDATE_DIGEST"
fi

if test -d "$TARGET" && test ! -L "$TARGET"; then
  TRANSITION_CANDIDATE_PATH="$TARGET"
else
  TRANSITION_CANDIDATE_PATH="$RECORDED_STAGE_PATH"
fi
TARGET_LIVENESS_STATE="$(candidate_liveness_pair_state "$TRANSITION_CANDIDATE_PATH")"
TARGET_POST_GATE_STATE="$(candidate_post_gate_guards_state "$TRANSITION_CANDIDATE_PATH")"
CURRENT_CONTROL_PLANE_IDENTITY="$(candidate_control_plane_identity \
  "$TRANSITION_CANDIDATE_PATH" "$CANDIDATE_DIGEST")" \
  || die 'durable candidate control-plane identity proof failed'
test "$CURRENT_CONTROL_PLANE_IDENTITY" = "$CONTROL_PLANE_SCHEMA $CONTROL_PLANE_DIGEST" \
  || die 'durable candidate control-plane identity changed'
if test "$CONTROL_PLANE_MODE" = initial; then
  test "$TARGET_POST_GATE_STATE" = present \
    && test "$POLLER_TIMER_WAS_ACTIVE $POLLER_TIMER_WAS_ENABLED" = '0 0' \
    && test "$POLLER_TIMER_DESIRED_ACTIVE $POLLER_TIMER_DESIRED_ENABLED" = '0 0' \
    || die 'initial poller transaction state is incoherent'
elif test "$TARGET_POST_GATE_STATE" = present; then
  test "$POLLER_TIMER_DESIRED_ACTIVE $POLLER_TIMER_DESIRED_ENABLED" = \
    "$POLLER_TIMER_WAS_ACTIVE $POLLER_TIMER_WAS_ENABLED" \
    || die 'guarded target poller desired state changed its operator snapshot'
else
  test "$CONTROL_PLANE_MODE" = rollback \
    && test "$POLLER_TIMER_DESIRED_ACTIVE" -eq 0 \
    && test "$POLLER_TIMER_DESIRED_ENABLED" -eq "$POLLER_TIMER_WAS_ENABLED" \
    || die 'unguarded rollback target must defer an active poller restart'
fi
if test "$CONTROL_PLANE_MODE" = initial; then
  test "$TARGET_LIVENESS_STATE" = present \
    && test "$LIVENESS_TIMER_WAS_ACTIVE $LIVENESS_TIMER_WAS_ENABLED" = '0 0' \
    && test "$LIVENESS_TIMER_DESIRED_ACTIVE $LIVENESS_TIMER_DESIRED_ENABLED" = '0 0' \
    || die 'initial backup-liveness transaction state is incoherent'
elif test "$TARGET_LIVENESS_STATE" = present; then
  test "$LIVENESS_TIMER_DESIRED_ACTIVE $LIVENESS_TIMER_DESIRED_ENABLED" = \
    "$LIVENESS_TIMER_WAS_ACTIVE $LIVENESS_TIMER_WAS_ENABLED" \
    || die 'backup-liveness desired state does not preserve the operator snapshot'
else
  test "$CONTROL_PLANE_MODE" = rollback \
    && test "$LIVENESS_TIMER_DESIRED_ACTIVE $LIVENESS_TIMER_DESIRED_ENABLED" = '0 0' \
    || die 'rollback to a controller without backup-liveness must desire 0/0'
fi

if test "$RESUME_TRANSACTION" -eq 1; then
  if test "$CONTROL_PLANE_MODE" = initial; then
    require_installed_initial_transition_bytes "$TRANSITION_CANDIDATE_PATH"
  else
    require_installed_transition_bytes \
      "$ORIGINAL_ACTIVE_PATH" "$TRANSITION_CANDIDATE_PATH"
  fi
  systemctl daemon-reload
  require_exact_effective_core_systemd_units
fi

CURRENT_ACTIVE_PATH="$(selector_or_absent "$ACTIVE_LINK")"
CURRENT_PREVIOUS_PATH="$(selector_or_absent "$PREVIOUS_LINK")"
if test -n "$ORIGINAL_ACTIVE_PATH"; then
  case "$CURRENT_ACTIVE_PATH" in "$ORIGINAL_ACTIVE_PATH"|"$TARGET") ;;
    *) die 'active selector differs from both durable pre/post identities' ;; esac
  case "$CURRENT_PREVIOUS_PATH" in "$ORIGINAL_PREVIOUS_PATH"|"$ORIGINAL_ACTIVE_PATH") ;;
    *) die 'previous selector differs from both durable pre/post identities' ;; esac
else
  case "$CURRENT_ACTIVE_PATH" in ''|"$TARGET") ;;
    *) die 'initial active selector differs from durable pre/post identity' ;; esac
  test -z "$CURRENT_PREVIOUS_PATH" \
    || die 'initial previous selector unexpectedly exists'
fi
if test "$CURRENT_ACTIVE_PATH" = "$TARGET"; then
  test "$CURRENT_PREVIOUS_PATH" = "$ORIGINAL_ACTIVE_PATH" \
    || die 'active selector advanced without its exact predecessor'
fi

if test -n "$RECORDED_STAGE_PATH" && test -d "$RECORDED_STAGE_PATH"; then
  mv -T -- "$RECORDED_STAGE_PATH" "$TARGET"
  STAGE_DIR=
  sync -f "$TARGET"; sync -f "$STAGING_ROOT"; sync -f "$VERSION_ROOT"
fi
require_immutable_candidate "$TARGET" "$CANDIDATE_DIGEST"
publish_transaction_phase candidate_installed

if test -n "$ORIGINAL_ACTIVE_PATH"; then
  publish_selector "$PREVIOUS_LINK" \
    "control-plane/$(basename "$ORIGINAL_ACTIVE_PATH")" "$ORIGINAL_ACTIVE_PATH"
else
  test ! -e "$PREVIOUS_LINK" && test ! -L "$PREVIOUS_LINK" \
    || die 'initial transaction cannot publish a predecessor'
fi
publish_transaction_phase previous_selected
publish_selector "$ACTIVE_LINK" "control-plane/$SOURCE_SHA" "$TARGET"
publish_transaction_phase active_selected
test "$(selector_or_absent "$ACTIVE_LINK")" = "$TARGET" \
  || die 'active selector did not retain the exact transaction target'
require_immutable_candidate "$TARGET" "$CANDIDATE_DIGEST"

STATE_VIEW_SOURCE="$TARGET/ops/nexus-release/nexus-release-state-view"
STATE_VIEW_SUDOERS_SOURCE="$TARGET/ops/nexus-release/nexus-release-state-view.sudoers"
/bin/sh -n "$STATE_VIEW_SOURCE"
/usr/sbin/visudo -cf "$STATE_VIEW_SUDOERS_SOURCE"
install_atomic_root_file "$STATE_VIEW_SOURCE" \
  /usr/local/sbin/nexus-release-state-view 755
install_atomic_root_file "$STATE_VIEW_SUDOERS_SOURCE" \
  /etc/sudoers.d/nexus-release-state-view 440
/usr/sbin/visudo -cf /etc/sudoers.d/nexus-release-state-view
sudo -u dominguez sudo -n /usr/local/sbin/nexus-release-state-view >/dev/null \
  || die 'delegated state-view proof failed'
publish_transaction_phase capabilities_installed

case "$RESUME_FROM_PHASE" in
  backup_interface_installed|units_reloaded|timers_restored|complete)
    # The durable phase says installation completed. Re-proof only; do not
    # rewrite authority-bearing backup files on a later-phase resume.
    verify_installed_backup_interface
    ;;
  prepared|candidate_installed|previous_selected|active_selected|capabilities_installed)
    require_local_backup_services_settled
    "$TARGET/scripts/local-backup-systemd-install.sh" "$TARGET"
    verify_installed_backup_interface
    publish_transaction_phase backup_interface_installed
    ;;
  *) die "unsupported backup-interface resume phase: $RESUME_FROM_PHASE" ;;
esac

for unit in nexus-release-bootstrap.service nexus-release-poller.service \
  nexus-release-poller.timer nexus-release-heartbeat.service \
  nexus-release-heartbeat.timer; do
  install_atomic_root_file "$TARGET/ops/nexus-release/$unit" \
    "/etc/systemd/system/$unit" 644
done
if test "$TARGET_LIVENESS_STATE" = present; then
  for unit in nexus-release-backup-liveness-force.service \
    nexus-release-backup-liveness.service \
    nexus-release-backup-liveness.timer; do
    install_atomic_root_file "$TARGET/ops/nexus-release/$unit" \
      "/etc/systemd/system/$unit" 644
  done
else
  remove_installed_liveness_for_absent_target "$ORIGINAL_ACTIVE_PATH"
fi
require_no_physical_unit_dropins
systemctl daemon-reload
require_exact_effective_systemd_units
prove_installed_control_plane "$TARGET"
publish_transaction_phase units_reloaded

# Restore only the exact enabled bits for the four established timers and the
# target-aware liveness timer while the transaction file still gates release
# execution. All five active bits remain zero until post-gate service proofs
# finish. Any partial restore is disabled again on the next retry.
require_local_backup_services_settled
verify_installed_backup_interface
for TIMER_UNIT in nexus-release-poller.timer nexus-release-heartbeat.timer \
  nexus-release-backup-liveness.timer nexus-local-backup.timer \
  nexus-local-backup-restore-verify.timer; do
  disable_timer_if_present "$TIMER_UNIT" \
    || die "timer could not be disabled before exact restore: $TIMER_UNIT"
done
unset TIMER_UNIT
if test "$HEARTBEAT_TIMER_WAS_ENABLED" -eq 1; then
  systemctl enable nexus-release-heartbeat.timer
fi
if test "$POLLER_TIMER_DESIRED_ENABLED" -eq 1; then
  systemctl enable nexus-release-poller.timer
fi
if test "$BACKUP_TIMER_WAS_ENABLED" -eq 1; then
  systemctl enable nexus-local-backup.timer
fi
if test "$RESTORE_VERIFY_TIMER_WAS_ENABLED" -eq 1; then
  systemctl enable nexus-local-backup-restore-verify.timer
fi
if test "$LIVENESS_TIMER_DESIRED_ENABLED" -eq 1; then
  test "$TARGET_LIVENESS_STATE" = present \
    || die 'cannot enable absent backup-liveness timer authority'
  systemctl enable nexus-release-backup-liveness.timer
fi
test "$(read_timer_bits nexus-release-poller.timer)" = \
  "0 $POLLER_TIMER_DESIRED_ENABLED" \
  || die 'poller timer became active before post-gate proofs completed'
test "$(read_timer_bits nexus-release-heartbeat.timer)" = \
  "0 $HEARTBEAT_TIMER_WAS_ENABLED" \
  || die 'heartbeat timer became active before post-gate proofs completed'
test "$(read_timer_bits nexus-local-backup.timer)" = \
  "0 $BACKUP_TIMER_WAS_ENABLED" \
  || die 'backup timer became active before post-gate proofs completed'
test "$(read_timer_bits nexus-local-backup-restore-verify.timer)" = \
  "0 $RESTORE_VERIFY_TIMER_WAS_ENABLED" \
  || die 'restore-verify timer became active before post-gate proofs completed'
test "$(read_timer_bits_or_absent nexus-release-backup-liveness.timer)" = \
  "0 $LIVENESS_TIMER_DESIRED_ENABLED" \
  || die 'backup-liveness timer became active before post-gate proofs completed'
publish_transaction_phase timers_restored

test "$(selector_or_absent "$ACTIVE_LINK")" = "$TARGET" \
  || die 'final active selector reproof failed'
test "$(selector_or_absent "$PREVIOUS_LINK")" = "$ORIGINAL_ACTIVE_PATH" \
  || die 'final previous selector reproof failed'
require_immutable_candidate "$TARGET" "$CANDIDATE_DIGEST"
require_no_physical_unit_dropins
prove_installed_control_plane "$TARGET"
require_exact_effective_systemd_units
verify_installed_backup_interface
require_control_plane_services_settled 1
require_poller_service_clean
publish_transaction_phase complete

# Complete is durable but remains a gate. Re-prove every authority-bearing byte,
# selector, and timer bit once more before atomically retiring that gate.
test "$(selector_or_absent "$ACTIVE_LINK")" = "$TARGET"
test "$(selector_or_absent "$PREVIOUS_LINK")" = "$ORIGINAL_ACTIVE_PATH"
require_immutable_candidate "$TARGET" "$CANDIDATE_DIGEST"
require_no_physical_unit_dropins
prove_installed_control_plane "$TARGET"
require_exact_effective_systemd_units
verify_installed_backup_interface
require_control_plane_services_settled 1
require_poller_service_clean
test "$(read_timer_bits nexus-release-poller.timer)" = \
  "0 $POLLER_TIMER_DESIRED_ENABLED"
test "$(read_timer_bits nexus-release-heartbeat.timer)" = \
  "0 $HEARTBEAT_TIMER_WAS_ENABLED"
test "$(read_timer_bits nexus-local-backup.timer)" = \
  "0 $BACKUP_TIMER_WAS_ENABLED"
test "$(read_timer_bits nexus-local-backup-restore-verify.timer)" = \
  "0 $RESTORE_VERIFY_TIMER_WAS_ENABLED"
test "$(read_timer_bits_or_absent nexus-release-backup-liveness.timer)" = \
  "0 $LIVENESS_TIMER_DESIRED_ENABLED"
test ! -e "$POST_GATE_STATE" && test ! -L "$POST_GATE_STATE" \
  || die 'post-gate record path became occupied'
test ! -e "$FINALIZATION_STATE" && test ! -L "$FINALIZATION_STATE" \
  || die 'finalization record path became occupied'

# Retire the gating name atomically, but retain the exact complete journal until
# the services whose timers must return active have run successfully against
# the selected controller. Every timer remains inactive during these proofs.
# A killed retry promotes this same-request record
# back to the gating name before doing any further work.
TIMER_FAILSAFE_ARMED=0
mv -T -- "$TRANSACTION_STATE" "$POST_GATE_STATE"
sync -f "$POST_GATE_STATE"; sync -f "$STATE_ROOT"
require_transaction_file "$POST_GATE_STATE"
test "$(jq -er .phase "$POST_GATE_STATE")" = complete \
  || die 'post-gate record lost its durable complete phase'
test ! -e "$TRANSACTION_STATE" && test ! -L "$TRANSACTION_STATE" \
  || die 'post-gate publication retained the gating transaction name'

start_and_prove_post_gate_service() {
  local active exec_status load_state result unit
  unit="$1"
  load_state="$(systemctl show "$unit" --property=LoadState --value)"
  active="$(systemctl show "$unit" --property=ActiveState --value)"
  case "$load_state:$active" in
    loaded:inactive) ;;
    loaded:failed)
      systemctl reset-failed "$unit" \
        || die "post-gate service failure state could not be reset: $unit"
      ;;
    *) die "post-gate service is not ready to start: $unit ($load_state/$active)" ;;
  esac
  systemctl start "$unit" \
    || die "post-gate service execution failed: $unit"
  load_state="$(systemctl show "$unit" --property=LoadState --value)"
  active="$(systemctl show "$unit" --property=ActiveState --value)"
  result="$(systemctl show "$unit" --property=Result --value)"
  exec_status="$(systemctl show "$unit" --property=ExecMainStatus --value)"
  test "$load_state:$active:$result:$exec_status" = loaded:inactive:success:0 \
    || die "post-gate service result is not exact: $unit ($load_state/$active/$result/$exec_status)"
}

if test "$HEARTBEAT_TIMER_WAS_ACTIVE" -eq 1; then
  start_and_prove_post_gate_service nexus-release-heartbeat.service
fi
if test "$LIVENESS_TIMER_DESIRED_ACTIVE" -eq 1; then
  test "$TARGET_LIVENESS_STATE" = present \
    || die 'post-gate backup-liveness service is absent'
  start_and_prove_post_gate_service nexus-release-backup-liveness-force.service
fi

test "$(selector_or_absent "$ACTIVE_LINK")" = "$TARGET"
test "$(selector_or_absent "$PREVIOUS_LINK")" = "$ORIGINAL_ACTIVE_PATH"
require_immutable_candidate "$TARGET" "$CANDIDATE_DIGEST"
require_no_physical_unit_dropins
prove_installed_control_plane "$TARGET"
require_exact_effective_systemd_units
verify_installed_backup_interface
require_control_plane_services_settled 1
require_poller_service_clean
test "$(read_timer_bits nexus-release-poller.timer)" = \
  "0 $POLLER_TIMER_DESIRED_ENABLED"
test "$(read_timer_bits nexus-release-heartbeat.timer)" = \
  "0 $HEARTBEAT_TIMER_WAS_ENABLED"
test "$(read_timer_bits nexus-local-backup.timer)" = \
  "0 $BACKUP_TIMER_WAS_ENABLED"
test "$(read_timer_bits nexus-local-backup-restore-verify.timer)" = \
  "0 $RESTORE_VERIFY_TIMER_WAS_ENABLED"
test "$(read_timer_bits_or_absent nexus-release-backup-liveness.timer)" = \
  "0 $LIVENESS_TIMER_DESIRED_ENABLED"
require_transaction_file "$POST_GATE_STATE"
test ! -e "$FINALIZATION_STATE" && test ! -L "$FINALIZATION_STATE" \
  || die 'finalization path became occupied during post-gate proofs'
mv -T -- "$POST_GATE_STATE" "$FINALIZATION_STATE"
sync -f "$FINALIZATION_STATE"; sync -f "$STATE_ROOT"
require_transaction_file "$FINALIZATION_STATE"
test ! -e "$POST_GATE_STATE" && test ! -L "$POST_GATE_STATE" \
  || die 'terminal finalization retained the post-gate journal name'

# Post-gate service proofs are complete. The finalization journal is recovery
# authority only, not a workload gate: release both deployment mutexes before
# restoring poller activity so its first admitted run cannot fail on our locks.
if test "$CONTROL_PLANE_MODE" != initial; then
  exec 8>&-; exec 9>&-
fi
start_terminal_timer_if_active() {
  local desired unit
  unit="$1"; desired="$2"
  if test "$desired" -eq 1; then
    systemctl start "$unit" \
      || die "terminal timer activation failed: $unit"
  fi
}
start_terminal_timer_if_active nexus-release-heartbeat.timer \
  "$HEARTBEAT_TIMER_WAS_ACTIVE"
start_terminal_timer_if_active nexus-release-backup-liveness.timer \
  "$LIVENESS_TIMER_DESIRED_ACTIVE"
start_terminal_timer_if_active nexus-local-backup.timer \
  "$BACKUP_TIMER_WAS_ACTIVE"
start_terminal_timer_if_active nexus-local-backup-restore-verify.timer \
  "$RESTORE_VERIFY_TIMER_WAS_ACTIVE"
start_terminal_timer_if_active nexus-release-poller.timer \
  "$POLLER_TIMER_DESIRED_ACTIVE"
test "$(read_timer_bits nexus-release-poller.timer)" = \
  "$POLLER_TIMER_DESIRED_ACTIVE $POLLER_TIMER_DESIRED_ENABLED" \
  || die 'terminal poller timer state differs from its durable desired state'
test "$(read_timer_bits nexus-release-heartbeat.timer)" = \
  "$HEARTBEAT_TIMER_WAS_ACTIVE $HEARTBEAT_TIMER_WAS_ENABLED" \
  || die 'terminal heartbeat timer state differs from its durable snapshot'
test "$(read_timer_bits nexus-local-backup.timer)" = \
  "$BACKUP_TIMER_WAS_ACTIVE $BACKUP_TIMER_WAS_ENABLED" \
  || die 'terminal backup timer state differs from its durable snapshot'
test "$(read_timer_bits nexus-local-backup-restore-verify.timer)" = \
  "$RESTORE_VERIFY_TIMER_WAS_ACTIVE $RESTORE_VERIFY_TIMER_WAS_ENABLED" \
  || die 'terminal restore-verify timer state differs from its durable snapshot'
test "$(read_timer_bits_or_absent nexus-release-backup-liveness.timer)" = \
  "$LIVENESS_TIMER_DESIRED_ACTIVE $LIVENESS_TIMER_DESIRED_ENABLED" \
  || die 'terminal backup-liveness timer state differs from its durable target'
POLLER_RESTART_DEFERRED=0
if test "$POLLER_TIMER_WAS_ACTIVE" -eq 1 \
    && test "$POLLER_TIMER_DESIRED_ACTIVE" -eq 0; then
  POLLER_RESTART_DEFERRED=1
fi
require_transaction_file "$FINALIZATION_STATE"
rm -f -- "$FINALIZATION_STATE"
sync -f "$STATE_ROOT"
test ! -e "$FINALIZATION_STATE" && test ! -L "$FINALIZATION_STATE" \
  && test ! -e "$POST_GATE_STATE" && test ! -L "$POST_GATE_STATE" \
  && test ! -e "$TRANSACTION_STATE" && test ! -L "$TRANSACTION_STATE" \
  || die 'completed control-plane journals were not retired'
TRANSACTION_DURABLE=0
printf 'completed immutable control-plane transaction %s; mode=%s; pollerRestartDeferred=%s\n' \
  "$SOURCE_SHA" "$CONTROL_PLANE_MODE" "$POLLER_RESTART_DEFERRED"
```

### Emergency abort of a `capabilities_installed` upgrade

Do not rerun §1a, request ordinary rollback, reboot, or edit its journal when an
`upgrade` is durably stuck at `capabilities_installed`. The narrowly scoped
abort tool supports only that exact phase. It restores the controller recorded
as `originalActivePath`; it is not a general control-plane rollback command.

The existing §1a gate cannot provision a different SHA. Provision a separate,
minimal two-script recovery tree from one owner-reviewed protected-main hotfix.
The hotfix evidence must publish the exact source SHA, two committed file
hashes, descriptor hash, and resulting immutable-tree digest. The deterministic
target name is authority; a crash before its atomic rename leaves only a
non-authoritative unique staging directory, while a crash after rename leaves a
fully synced tree that the same command can re-prove.

```bash
set -euo pipefail
PATH=/usr/bin:/bin
export PATH
RECOVERY_SOURCE_SHA='<owner-reviewed protected-main hotfix 40-hex SHA>'
RECOVERY_TREE_DIGEST='<owner-reviewed immutable-tree 64-hex SHA-256>'
WRAPPER_SHA256='<owner-reviewed 64-lowercase-hex SHA-256>'
MODULE_SHA256='<owner-reviewed 64-lowercase-hex SHA-256>'
DESCRIPTOR_SHA256='<owner-reviewed 64-lowercase-hex SHA-256>'
SOURCE_CHECKOUT='<clean exact hotfix checkout absolute path>'
BUNDLE_PARENT=/opt/nexus-release/recovery-tools/control-plane
TOOL_ROOT="$BUNDLE_PARENT/$RECOVERY_SOURCE_SHA"

test "$(/usr/bin/git -C "$SOURCE_CHECKOUT" rev-parse HEAD)" = "$RECOVERY_SOURCE_SHA"
test -z "$(/usr/bin/git -C "$SOURCE_CHECKOUT" status --porcelain=v1)"
printf '%s  %s\n%s  %s\n%s  %s\n' \
  "$WRAPPER_SHA256" \
    "$SOURCE_CHECKOUT/scripts/release-control-plane-abort-recovery.sh" \
  "$MODULE_SHA256" \
    "$SOURCE_CHECKOUT/scripts/release-control-plane-abort-recovery.mjs" \
  "$DESCRIPTOR_SHA256" \
    "$SOURCE_CHECKOUT/ops/nexus-release/release-control-plane-inputs.json" \
  | /usr/bin/sha256sum -c -

sudo install -d -o root -g root -m 0700 \
  /opt/nexus-release/recovery-tools "$BUNDLE_PARENT"
if ! sudo test -e "$TOOL_ROOT" && ! sudo test -L "$TOOL_ROOT"; then
  STAGE="$(sudo mktemp -d "$BUNDLE_PARENT/.${RECOVERY_SOURCE_SHA}.candidate.XXXXXX")"
  sudo install -d -o root -g root -m 0755 \
    "$STAGE/scripts" "$STAGE/ops" "$STAGE/ops/nexus-release"
  sudo install -o root -g root -m 0555 \
    "$SOURCE_CHECKOUT/scripts/release-control-plane-abort-recovery.sh" \
    "$STAGE/scripts/"
  sudo install -o root -g root -m 0444 \
    "$SOURCE_CHECKOUT/scripts/release-control-plane-abort-recovery.mjs" \
    "$STAGE/scripts/"
  sudo install -o root -g root -m 0444 \
    "$SOURCE_CHECKOUT/ops/nexus-release/release-control-plane-inputs.json" \
    "$STAGE/ops/nexus-release/"
  MARKER_TEMP="$(mktemp)"; DIGEST_TEMP="$(mktemp)"
  trap 'rm -f -- "$MARKER_TEMP" "$DIGEST_TEMP"' EXIT
  printf '%s %s %s\n' "$RECOVERY_SOURCE_SHA" \
    'https://github.com/felipedrf74/cortex-telegram-hub-bot.git' \
    '/usr/bin/node:v22.23.1' >"$MARKER_TEMP"
  printf '%064d\n' 0 >"$DIGEST_TEMP"
  sudo install -o root -g root -m 0444 "$MARKER_TEMP" \
    "$STAGE/.nexus-control-plane-ready"
  sudo install -o root -g root -m 0444 "$DIGEST_TEMP" \
    "$STAGE/.nexus-control-plane-tree.sha256"
  sudo chmod 0555 "$STAGE/scripts" "$STAGE/ops/nexus-release" \
    "$STAGE/ops" "$STAGE"
  # Rehash the root-owned, frozen copies before importing any staged code. The
  # earlier checkout proof cannot prevent a same-user swap between read/copy.
  printf '%s  %s\n%s  %s\n%s  %s\n' \
    "$WRAPPER_SHA256" \
      "$STAGE/scripts/release-control-plane-abort-recovery.sh" \
    "$MODULE_SHA256" \
      "$STAGE/scripts/release-control-plane-abort-recovery.mjs" \
    "$DESCRIPTOR_SHA256" \
      "$STAGE/ops/nexus-release/release-control-plane-inputs.json" \
    | sudo /usr/bin/sha256sum -c -
  CALCULATED_DIGEST="$(sudo /usr/bin/node --input-type=module - "$STAGE" <<'NODE'
import { pathToFileURL } from 'node:url';
const root = process.argv[2];
const module = await import(pathToFileURL(
  `${root}/scripts/release-control-plane-abort-recovery.mjs`,
));
process.stdout.write(`${module.computeImmutableTreeDigest(root)}\n`);
NODE
  )"
  test "$CALCULATED_DIGEST" = "$RECOVERY_TREE_DIGEST"
  printf '%s\n' "$CALCULATED_DIGEST" >"$DIGEST_TEMP"
  sudo install -o root -g root -m 0444 "$DIGEST_TEMP" \
    "$STAGE/.nexus-control-plane-tree.sha256"
  for durable in \
    "$STAGE/scripts/release-control-plane-abort-recovery.sh" \
    "$STAGE/scripts/release-control-plane-abort-recovery.mjs" \
    "$STAGE/ops/nexus-release/release-control-plane-inputs.json" \
    "$STAGE/.nexus-control-plane-ready" \
    "$STAGE/.nexus-control-plane-tree.sha256" \
    "$STAGE/scripts" "$STAGE/ops/nexus-release" "$STAGE/ops" "$STAGE"; do
    sudo sync -f "$durable"
  done
  sudo mv -T -- "$STAGE" "$TOOL_ROOT"
  sudo sync -f "$TOOL_ROOT"; sudo sync -f "$BUNDLE_PARENT"
fi

# A retry may enter with TOOL_ROOT already published. Re-prove its exact
# committed code and descriptor before importing or invoking either executable.
printf '%s  %s\n%s  %s\n%s  %s\n' \
  "$WRAPPER_SHA256" \
    "$TOOL_ROOT/scripts/release-control-plane-abort-recovery.sh" \
  "$MODULE_SHA256" \
    "$TOOL_ROOT/scripts/release-control-plane-abort-recovery.mjs" \
  "$DESCRIPTOR_SHA256" \
    "$TOOL_ROOT/ops/nexus-release/release-control-plane-inputs.json" \
  | sudo /usr/bin/sha256sum -c -
PROVED_DIGEST="$(sudo /usr/bin/node --input-type=module - "$TOOL_ROOT" <<'NODE'
import { pathToFileURL } from 'node:url';
const root = process.argv[2];
const module = await import(pathToFileURL(
  `${root}/scripts/release-control-plane-abort-recovery.mjs`,
));
process.stdout.write(`${module.computeImmutableTreeDigest(root)}\n`);
NODE
)"
test "$PROVED_DIGEST" = "$RECOVERY_TREE_DIGEST"

sudo "$TOOL_ROOT/scripts/release-control-plane-abort-recovery.sh" \
  --target-sha '<journal targetSha>' \
  --original-sha '<journal originalActivePath basename>' \
  --application-release-id '<active completed 32-hex releaseId>' \
  --application-source-sha '<active completed 40-hex sourceSha>' \
  --application-receipt-sha256 '<SHA-256 of its immutable receipt bytes>' \
  --recovery-source-sha "$RECOVERY_SOURCE_SHA" \
  --recovery-source-tree-digest "$RECOVERY_TREE_DIGEST"
```

The tool binds the control-plane, release, and maintenance locks in that order.
Before mutation it proves the exact v1 journal and phase, both selectors, the
target/original/predecessor immutable trees, the completed application receipt,
the immutable owner-reviewed recovery source,
the known mixed installed bytes, inactive services, and five suppressed timer
states. It then durably advances
`control-plane-abort-recovery.json` after each idempotent phase. Rerun only the
same command after interruption; different identities are refused.

Recovery restores the recorded-original state-view and sudoers files, five core
units, and seven legacy local-backup files. Target-only liveness files are
removed only when their bytes are exact and known. The original transaction
gate remains present through durable `recovery_complete`; it is then renamed to
`control-plane-aborted-<targetSha>.json`. Terminal evidence is retained at
`control-plane-abort-recovery-<targetSha>.json`. Heartbeat and local-backup timer
intent is restored, but poller and target-only liveness remain `0/0`; this is
deliberate because the recorded v2 poller cannot consume the active v3 release
envelope.

After terminal proof, build and publish a new protected-main hotfix SHA and run
a fresh attended §1a `upgrade` to that new SHA. Do not reactivate the old poller.
The successful fresh transaction installs the compatible reader and owns final
poller activation.

`initial` requires both release and local-backup authority to be absent, then
installs the seven local-backup producer/unit/sudoers files and the release unit
definitions from the immutable target. It starts and enables nothing.
Resume only at the next applicable step in the canonical first-install order
above; do not infer execution order from the section numbers. Only section 6 may
start the first-bootstrap unit, and only the completed bootstrap receipt may
authorize enabling the ordinary poller timer.

During `upgrade`, candidate construction has no runtime authority. Activation is
serialized by both governed mutexes. Before the durable snapshot, all three
local-backup oneshots must be inactive. The transaction persists the four
established poller, heartbeat, backup, and restore-verify timers' eight snapshot
bits, a target-aware poller desired pair, and the backup-liveness timer's prior
and target-aware desired pairs: fourteen exact timer bits in total. An existing
liveness unit set preserves the operator snapshot, an absent-to-present set
remains 0/0, and a retained old rollback target forces liveness to 0/0. All five timers
are stopped and disabled across reboot before any selector or authority-bearing
file changes. After selector activation, the transaction installs and
byte-proves the local-backup producer, five units/timers, and sudoers policy from
the immutable target, including exact effective fragments, empty drop-ins, and
`NeedDaemonReload=no`. It restores only the governed enabled bits while keeping
all five timers inactive. The ERR/EXIT fail-safe remains armed through that
gating phase; any earlier exit disables and stops all five timers again. Do not
improvise a partial restart. Both immutable version directories and
`checkout.previous` remain, so rollback does not depend on GitHub or npm still
being available.

Rollback uses the same durable transaction above, not a second volatile link
swap. Re-run the **complete** fenced block in this section from its first
`set -euo pipefail` through its final transaction-gate retirement, changing
only these owner-reviewed inputs:

- `CONTROL_PLANE_MODE=rollback`
- `SOURCE_SHA='<owner-reviewed 40-lowercase-hex SHA currently selected by checkout.previous>'`

Do not paste only those assignments or resume at an internal phase. The shared
control-plane mutex and exact root-owned transaction record supply the original
active/predecessor selectors, candidate digest, and all persisted timer bits after
any SIGKILL or reboot. A same-request retry re-proves those durable identities,
disables all five timers behind the transaction gate, reconciles the two
selectors, installs or re-proves the rollback target's exact local-backup
interface, installs or removes the target-aware liveness unit set, then restores
only enabled bits before post-gate proofs and terminal active-bit restoration. A
retained pre-checker target remains rollback-compatible only through the inline exact
byte/metadata/systemd proof; a partial checker/module pair refuses. A different
mode, SHA, repository, marker, candidate, or selector refuses without replacing
the retained versions.

The shared ERR/EXIT fail-safe stays armed until all five inactive/enabled
intermediate states match the durable record. The transaction record gates
bootstrap, poller, heartbeat, and installed backup-liveness execution through
that phase. Durable completion atomically becomes the post-gate journal, which
continues to gate bootstrap and poller while all five timers remain inactive.
Required heartbeat and liveness oneshots must then succeed. A second full
candidate, installed-interface, effective-unit, selector, and timer reproof
atomically promotes the journal to terminal finalization state. Finalization
recomputes the complete immutable tree digest, signed control-plane identity,
and Node-22 native dependency proof before starting any saved-active timer; a
retry accepts only pending or exact terminal timer states. All five core
installed fragments and the optional three liveness fragments must remain the
exact governed main files; any exact-name, dash-prefix, or type-wide systemd
drop-in is forbidden. Never delete either version or manually change timer
enablement while any of the three root-owned journals exists; rerun the complete
same-mode transaction instead.

For a controller that introduces the backup-liveness unit set while the live
timer was absent, section 1a deliberately preserves 0/0. After section 1a has fully
retired all transaction journals, the backup policy, encrypted receipt, and
restore proof are live, and the owner explicitly attends the first activation,
run this whole block once. It preserves an existing operator decision: 1/1 is
accepted only as an already completed activation with a successful service
result; 0/0 runs the governed forced proof before enabling the timer; any partial
state refuses.

```bash
sudo -i
set -euo pipefail
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH
die() { printf 'BACKUP-LIVENESS ACTIVATION REFUSED: %s\n' "$*" >&2; exit 1; }

CONTROL_PLANE_LOCK=/var/lib/nexus-release/locks/control-plane.lock
RELEASE_LOCK=/var/lib/nexus-release/locks/release.lock
MAINTENANCE_LOCK=/run/lock/nexus-release-sonar.lock
STATE_ROOT=/var/lib/nexus-release/state
TRANSACTION_STATE="$STATE_ROOT/control-plane-transaction.json"
POST_GATE_STATE="$STATE_ROOT/control-plane-post-gate.json"
FINALIZATION_STATE="$STATE_ROOT/control-plane-finalization.json"
ACTIVE_LINK=/opt/nexus-release/checkout
VERSION_ROOT=/opt/nexus-release/control-plane
SERVICE=nexus-release-backup-liveness-force.service
TIMER=nexus-release-backup-liveness.timer

test "$EUID" -eq 0 || die 'run the complete activation from one root shell'
test ! -e "$TRANSACTION_STATE" && test ! -L "$TRANSACTION_STATE" \
  && test ! -e "$POST_GATE_STATE" && test ! -L "$POST_GATE_STATE" \
  && test ! -e "$FINALIZATION_STATE" && test ! -L "$FINALIZATION_STATE" \
  || die 'a control-plane transaction, post-gate proof, or finalization is active'
for lock_spec in \
  "$CONTROL_PLANE_LOCK|root:root:600:1|7" \
  "$RELEASE_LOCK|root:root:600:1|9" \
  "$MAINTENANCE_LOCK|root:dominguez:660:1|8"; do
  IFS='|' read -r lock expected fd <<<"$lock_spec"
  test -f "$lock" && test ! -L "$lock" \
    && test "$(stat -Lc '%U:%G:%a:%h' -- "$lock")" = "$expected" \
    || die "governed lock is unsafe: $lock"
  case "$fd" in
    7) exec 7<>"$lock" ;;
    8) exec 8<>"$lock" ;;
    9) exec 9<>"$lock" ;;
    *) die "unexpected governed lock descriptor: $fd" ;;
  esac
  test "$(stat -Lc '%d:%i' -- "/proc/$$/fd/$fd")" = \
    "$(stat -Lc '%d:%i' -- "$lock")" \
    || die "governed lock changed before acquisition: $lock"
  flock -n "$fd" || die "governed lock is busy: $lock"
done
unset expected fd lock lock_spec
test ! -e "$TRANSACTION_STATE" && test ! -L "$TRANSACTION_STATE" \
  && test ! -e "$POST_GATE_STATE" && test ! -L "$POST_GATE_STATE" \
  && test ! -e "$FINALIZATION_STATE" && test ! -L "$FINALIZATION_STATE" \
  || die 'a control-plane transaction appeared after lock acquisition'

test -L "$ACTIVE_LINK" || die 'active controller selector is not symbolic'
ACTIVE="$(readlink -f -- "$ACTIVE_LINK")"
[[ "$ACTIVE" =~ ^$VERSION_ROOT/[0-9a-f]{40}$ ]] \
  || die 'active controller selector escaped the immutable version root'
test -d "$ACTIVE" && test ! -L "$ACTIVE" \
  || die 'active immutable controller is unsafe'
for relative in nexus-release-backup-liveness-force.service \
  nexus-release-backup-liveness.service \
  nexus-release-backup-liveness.timer; do
  source="$ACTIVE/ops/nexus-release/$relative"
  installed="/etc/systemd/system/$relative"
  test -f "$source" && test ! -L "$source" \
    && test "$(stat -Lc '%U:%G:%a:%h' -- "$source")" = root:root:444:1 \
    || die "signed liveness source is unsafe: $relative"
  test -f "$installed" && test ! -L "$installed" \
    && test "$(stat -Lc '%U:%G:%a:%h' -- "$installed")" = root:root:644:1 \
    && cmp -s -- "$source" "$installed" \
    || die "installed liveness unit differs from the active controller: $relative"
  test "$(systemctl show "$relative" --property=LoadState --value)" = loaded \
    && test "$(systemctl show "$relative" --property=FragmentPath --value)" = \
      "$installed" \
    && test -z "$(systemctl show "$relative" --property=DropInPaths --value)" \
    && test "$(systemctl show "$relative" --property=NeedDaemonReload --value)" = no \
    || die "effective liveness unit is not exact: $relative"
done
launcher="$ACTIVE/scripts/release-backup-liveness-launcher.sh"
test -f "$launcher" && test ! -L "$launcher" \
  && test "$(stat -Lc '%U:%G:%a:%h' -- "$launcher")" = root:root:555:1 \
  || die 'signed liveness launcher is unsafe'

timer_bits() {
  local active enabled
  active="$(systemctl show "$TIMER" --property=ActiveState --value)"
  enabled="$(systemctl show "$TIMER" --property=UnitFileState --value)"
  case "$active" in active) active=1 ;; inactive) active=0 ;;
    *) die "liveness timer active state is inadmissible: $active" ;; esac
  case "$enabled" in enabled) enabled=1 ;; disabled) enabled=0 ;;
    *) die "liveness timer enabled state is inadmissible: $enabled" ;; esac
  printf '%s %s\n' "$active" "$enabled"
}

case "$(timer_bits)" in
  '0 0')
    systemctl reset-failed "$SERVICE" \
      || die 'liveness service failure state could not be reset'
    systemctl start "$SERVICE" || die 'attended liveness service check failed'
    test "$(systemctl show "$SERVICE" --property=LoadState --value)" = loaded \
      && test "$(systemctl show "$SERVICE" --property=ActiveState --value)" = inactive \
      && test "$(systemctl show "$SERVICE" --property=Result --value)" = success \
      && test "$(systemctl show "$SERVICE" --property=ExecMainStatus --value)" = 0 \
      || die 'attended liveness service result is not exact'
    systemctl enable --now "$TIMER" \
      || die 'liveness timer activation failed'
    ;;
  '1 1')
    test "$(systemctl show "$SERVICE" --property=Result --value)" = success \
      && test "$(systemctl show "$SERVICE" --property=ExecMainStatus --value)" = 0 \
      || die 'already-active liveness timer lacks a successful service result'
    ;;
  *) die 'liveness timer is in a partial active/enabled state' ;;
esac
test "$(timer_bits)" = '1 1' || die 'liveness timer did not reach exact 1/1'
test ! -e "$TRANSACTION_STATE" && test ! -L "$TRANSACTION_STATE" \
  && test ! -e "$POST_GATE_STATE" && test ! -L "$POST_GATE_STATE" \
  && test ! -e "$FINALIZATION_STATE" && test ! -L "$FINALIZATION_STATE" \
  || die 'control-plane transaction state appeared during activation'
printf 'backup-liveness service proved and timer active/enabled\n'
```

### Retained-old rollback poller restart

A rollback target retained from before the post-gate conditions cannot safely
restore an active poller inside section 1a. In that one case the terminal output
reports `pollerRestartDeferred=1`, preserves the timer's enabled bit, and leaves
its active bit at zero. Only after all three control-plane journals are absent
and the owner explicitly attends the deferred restart, run this complete block.
It does not enable a timer that was disabled.

```bash
sudo -i
set -euo pipefail
PATH=/usr/bin:/bin:/usr/sbin:/sbin
export PATH
die() { printf 'DEFERRED POLLER RESTART REFUSED: %s\n' "$*" >&2; exit 1; }

CONTROL_LOCK=/var/lib/nexus-release/locks/control-plane.lock
RELEASE_LOCK=/var/lib/nexus-release/locks/release.lock
MAINTENANCE_LOCK=/run/lock/nexus-release-sonar.lock
STATE_ROOT=/var/lib/nexus-release/state
ACTIVE_LINK=/opt/nexus-release/checkout
VERSION_ROOT=/opt/nexus-release/control-plane
POLLER_UNIT=nexus-release-poller.service
POLLER_TIMER=nexus-release-poller.timer

test "$EUID" -eq 0 || die 'run the complete restart from one root shell'
for state in control-plane-transaction.json control-plane-post-gate.json \
  control-plane-finalization.json pm2-fallback-retirement.json \
  pm2-fallback-retired.json; do
  test ! -e "$STATE_ROOT/$state" && test ! -L "$STATE_ROOT/$state" \
    || die "conflicting authority state exists: $state"
done
test -f "$CONTROL_LOCK" && test ! -L "$CONTROL_LOCK" \
  && test "$(stat -Lc '%U:%G:%a:%h' -- "$CONTROL_LOCK")" = root:root:600:1 \
  || die 'control-plane mutex is unsafe'
test -f "$RELEASE_LOCK" && test ! -L "$RELEASE_LOCK" \
  && test "$(stat -Lc '%U:%G:%a:%h' -- "$RELEASE_LOCK")" = root:root:600:1 \
  || die 'release mutex is unsafe'
test -f "$MAINTENANCE_LOCK" && test ! -L "$MAINTENANCE_LOCK" \
  && test "$(stat -Lc '%U:%G:%a:%h' -- "$MAINTENANCE_LOCK")" = \
    root:dominguez:660:1 || die 'maintenance mutex is unsafe'
exec 7<>"$CONTROL_LOCK"; flock -n 7 || die 'control-plane authority is active'
exec 9<>"$RELEASE_LOCK"; flock -n 9 || die 'release authority is active'
exec 8<>"$MAINTENANCE_LOCK"; flock -n 8 || die 'root maintenance is active'
for state in control-plane-transaction.json control-plane-post-gate.json \
  control-plane-finalization.json pm2-fallback-retirement.json \
  pm2-fallback-retired.json; do
  test ! -e "$STATE_ROOT/$state" && test ! -L "$STATE_ROOT/$state" \
    || die "conflicting authority appeared after locking: $state"
done

test -L "$ACTIVE_LINK" || die 'active controller selector is not symbolic'
ACTIVE="$(readlink -f -- "$ACTIVE_LINK")"
[[ "$ACTIVE" =~ ^$VERSION_ROOT/[0-9a-f]{40}$ ]] \
  || die 'active controller escaped the immutable version root'
SOURCE="$ACTIVE/ops/nexus-release/$POLLER_UNIT"
INSTALLED="/etc/systemd/system/$POLLER_UNIT"
test -f "$SOURCE" && test ! -L "$SOURCE" \
  && test "$(stat -Lc '%U:%G:%a:%h' -- "$SOURCE")" = root:root:444:1 \
  || die 'retained poller source is unsafe'
! grep -Fqx \
  'ConditionPathExists=!/var/lib/nexus-release/state/control-plane-post-gate.json' \
  "$SOURCE" || die 'selected controller already has the post-gate condition'
! grep -Fqx \
  'ConditionPathIsSymbolicLink=!/var/lib/nexus-release/state/control-plane-post-gate.json' \
  "$SOURCE" || die 'selected controller already has the post-gate symlink condition'
test -f "$INSTALLED" && test ! -L "$INSTALLED" \
  && test "$(stat -Lc '%U:%G:%a:%h' -- "$INSTALLED")" = root:root:644:1 \
  && cmp -s -- "$SOURCE" "$INSTALLED" \
  && test "$(systemctl show "$POLLER_UNIT" --property=LoadState --value)" = loaded \
  && test "$(systemctl show "$POLLER_UNIT" --property=FragmentPath --value)" = \
    "$INSTALLED" \
  && test -z "$(systemctl show "$POLLER_UNIT" --property=DropInPaths --value)" \
  && test "$(systemctl show "$POLLER_UNIT" --property=NeedDaemonReload --value)" = no \
  || die 'installed retained poller unit is not exact'
POLLER_ACTIVE="$(systemctl show "$POLLER_TIMER" --property=ActiveState --value)"
POLLER_ENABLED="$(systemctl show "$POLLER_TIMER" --property=UnitFileState --value)"
case "$POLLER_ACTIVE" in active|inactive) ;; *) die 'poller timer active state is unsafe' ;; esac
case "$POLLER_ENABLED" in enabled|disabled) ;; *) die 'poller timer enabled state is unsafe' ;; esac
if test "$POLLER_ACTIVE" = inactive; then
  test "$(systemctl show "$POLLER_UNIT" --property=ActiveState --value)" = inactive \
    && test "$(systemctl show "$POLLER_UNIT" --property=Result --value)" = success \
    && test "$(systemctl show "$POLLER_UNIT" --property=ExecMainStatus --value)" = 0 \
    || die 'poller service is not clean before deferred restart'
  exec 8>&-; exec 9>&-
  systemctl start "$POLLER_TIMER" || die 'deferred poller timer restart failed'
fi
test "$(systemctl show "$POLLER_TIMER" --property=ActiveState --value)" = active \
  && test "$(systemctl show "$POLLER_TIMER" --property=UnitFileState --value)" = \
    "$POLLER_ENABLED" || die 'deferred poller timer state is not exact'
printf 'deferred retained-old poller restart completed; enabled=%s\n' "$POLLER_ENABLED"
```

## 1b. Quiesced transition of the existing production and staging databases

**Manual verification required.** The existing production and staging databases
live at `/home/dominguez/telegram-hub-bot/data/bot.db` and
`/home/dominguez/telegram-hub-bot-staging/data/bot.db` under PM2. Both must be
copied, not recreated. In particular, an empty staging database has every
historical migration pending; the signed plan correctly refuses its contract
migrations, so the first container rehearsal cannot use an empty mount.

Complete sections 2, 3, and 5 first: the pinned public key, read-only registry
credential, exact signed `main` payload, and root-owned shared maintenance mutex
must already exist before production is stopped. Then run this block as one Bash
transaction. It exits on the first failed assertion; do not paste individual
lines around a failure.

The transaction proves every installed local-backup executable, unit, timer,
and sudoers byte against the real immutable active control-plane root before it
stops PM2. If that proof reports a mismatch, keep PM2 online, first prove all
local-backup oneshots inactive, and reinstall only from the resolved real root
(the installer intentionally rejects the `checkout` symlink itself):

```bash
set -euo pipefail
sudo test -L /opt/nexus-release/checkout
test "$(sudo stat -c '%U:%G:%F' -- /opt/nexus-release/checkout)" = \
  'root:root:symbolic link'
ACTIVE_BACKUP_SOURCE="$(sudo readlink -f -- /opt/nexus-release/checkout)"
[[ "$ACTIVE_BACKUP_SOURCE" =~ ^/opt/nexus-release/control-plane/[0-9a-f]{40}$ ]]
sudo test -d "$ACTIVE_BACKUP_SOURCE" && sudo test ! -L "$ACTIVE_BACKUP_SOURCE"
ACTIVE_BACKUP_SHA="${ACTIVE_BACKUP_SOURCE##*/}"
test "$(sudo cat "$ACTIVE_BACKUP_SOURCE/.nexus-control-plane-ready")" = \
  "$ACTIVE_BACKUP_SHA https://github.com/felipedrf74/cortex-telegram-hub-bot.git /usr/bin/node:v22.23.1"
sudo "$ACTIVE_BACKUP_SOURCE/scripts/local-backup-systemd-install.sh" \
  "$ACTIVE_BACKUP_SOURCE"
```

Then rerun the complete transaction from its first line; never resume after the
failed proof.

```bash
set -euo pipefail

die() { printf 'CUTOVER REFUSED: %s\n' "$*" >&2; exit 1; }

run_pm2_as_dominguez() {
  local pm2_cwd=/home/dominguez
  (cd "$pm2_cwd" && sudo -u dominguez pm2 "$@")
}

require_no_open_handles() {
  local db suffix error_file handles lsof_status
  local -a candidates
  for db in "$@"; do
    sudo test -f "$db" || die "missing database: $db"
    candidates+=("$db")
    for suffix in -wal -shm -journal; do
      if sudo test -e "$db$suffix"; then candidates+=("$db$suffix"); fi
    done
  done
  error_file="$(mktemp)"
  if handles="$(sudo lsof -t -- "${candidates[@]}" 2>"$error_file")"; then
    lsof_status=0
  else
    lsof_status=$?
  fi
  if test -s "$error_file"; then
    sed 's/^/lsof: /' "$error_file" >&2
    rm -f "$error_file"
    die 'open-handle probe produced an error'
  fi
  rm -f "$error_file"
  case "$lsof_status" in
    0) die "database handles remain open: $handles" ;;
    1) test -z "$handles" || die 'lsof returned output with no-match status' ;;
    *) die "lsof failed with status $lsof_status" ;;
  esac
}

require_no_sqlite_sidecars() {
  local db suffix
  for db in "$@"; do
    for suffix in -wal -shm -journal; do
      sudo test ! -e "$db$suffix" || die "SQLite sidecar remains: $db$suffix"
    done
  done
}

require_valid_sqlite() {
  local db integrity foreign_keys
  db="$1"
  integrity="$(sudo sqlite3 "file:$db?mode=ro" 'PRAGMA integrity_check;')"
  test "$integrity" = 'ok' || die "integrity_check failed for $db: $integrity"
  foreign_keys="$(sudo sqlite3 "file:$db?mode=ro" 'PRAGMA foreign_key_check;')"
  test -z "$foreign_keys" || die "foreign_key_check failed for $db: $foreign_keys"
}

logical_digest() {
  sudo sqlite3 "file:$1?mode=ro" '.dump' | sha256sum | awk '{print $1}'
}

verify_installed_runtime() {
  local digest runtime sha
  runtime="$1"; sha="$2"; digest="$3"
  sudo test -d "$runtime" && sudo test ! -L "$runtime" \
    && sudo test -f "$runtime/ecosystem.release.config.js" \
    && sudo test ! -L "$runtime/ecosystem.release.config.js" || return 1
  if sudo test -e "$runtime/.nexus-installed-runtime.json" \
      || sudo test -L "$runtime/.nexus-installed-runtime.json" \
      || sudo test -e "$runtime/scripts/release-installed-tree-attestation.mjs" \
      || sudo test -L "$runtime/scripts/release-installed-tree-attestation.mjs"; then
    sudo test -f "$runtime/.nexus-installed-runtime.json" \
      && sudo test ! -L "$runtime/.nexus-installed-runtime.json" \
      && sudo test -f "$runtime/scripts/release-installed-tree-attestation.mjs" \
      && sudo test ! -L "$runtime/scripts/release-installed-tree-attestation.mjs" \
      || return 1
    sudo /usr/bin/node \
      /opt/nexus-release/checkout/scripts/release-artifact-manifest.mjs \
      --verify-installed-source "$runtime" --expected-runtime-sha "$sha" \
      --expected-digest "$digest" \
      --require-declared-file scripts/release-installed-tree-attestation.mjs \
      >/dev/null || return 1
    sudo /usr/bin/node \
      "$runtime/scripts/release-installed-tree-attestation.mjs" validate \
      --root "$runtime" --runtime-sha "$sha" --artifact-digest "$digest" \
      >/dev/null || return 1
  else
    sudo /usr/bin/node \
      /opt/nexus-release/checkout/scripts/release-artifact-manifest.mjs \
      --verify-installed-source "$runtime" --expected-runtime-sha "$sha" \
      --expected-digest "$digest" >/dev/null || return 1
    sudo /usr/bin/node \
      /opt/nexus-release/checkout/scripts/release-runtime-dependencies.mjs \
      verify-predecessor-extracted --root "$runtime" --python-bin /usr/bin/python3.12 \
      >/dev/null || return 1
  fi
}

remove_proven_stale_wal_sidecars() {
  local checkpoint db metadata sidecar
  local -a stale_sidecars
  for db in "$@"; do
    stale_sidecars=()
    require_no_open_handles "$db"
    checkpoint="$(sudo sqlite3 "$db" 'PRAGMA wal_checkpoint(TRUNCATE);')"
    test "$checkpoint" = '0|0|0' \
      || die "zero-WAL checkpoint proof failed for $db: $checkpoint"
    require_no_open_handles "$db"
    sudo test ! -e "$db-journal" \
      || die "rollback journal cannot be classified stale: $db-journal"
    if sudo test -e "$db-wal"; then
      metadata="$(sudo stat -c '%F:%h:%s' -- "$db-wal")"
      test "$metadata" = 'regular empty file:1:0' \
        || die "WAL sidecar is not a single-link zero-byte regular file: $db-wal"
      stale_sidecars+=("$db-wal")
    fi
    if sudo test -e "$db-shm"; then
      metadata="$(sudo stat -c '%F:%h' -- "$db-shm")"
      test "$metadata" = 'regular file:1' \
        || die "SHM sidecar is not a single-link regular file: $db-shm"
      stale_sidecars+=("$db-shm")
    fi
    if test "${#stale_sidecars[@]}" -gt 0; then
      sudo rm -- "${stale_sidecars[@]}"
    fi
    require_no_open_handles "$db"
    require_no_sqlite_sidecars "$db"
  done
}

require_no_legacy_listeners() {
  local error_file listeners lsof_status port
  for port in 8100 8101 8200 8201; do
    error_file="$(mktemp)"
    if listeners="$(sudo lsof -nP -t -iTCP:"$port" -sTCP:LISTEN 2>"$error_file")"; then
      lsof_status=0
    else
      lsof_status=$?
    fi
    if test -s "$error_file"; then
      sed 's/^/lsof: /' "$error_file" >&2
      rm -f "$error_file"
      die "listener probe produced an error for port $port"
    fi
    rm -f "$error_file"
    case "$lsof_status" in
      0) die "legacy listener remains on port $port: $listeners" ;;
      1) test -z "$listeners" || die 'lsof returned output with no-match status' ;;
      *) die "listener lsof failed with status $lsof_status" ;;
    esac
  done
}

require_local_backup_installation() {
  local active_mode active_root destination dropins exec_start expected_sha
  local fragment load mode relative source spec unit
  sudo test -L /opt/nexus-release/checkout \
    && test "$(sudo stat -c '%U:%G:%F' -- /opt/nexus-release/checkout)" = \
      'root:root:symbolic link' \
    || die 'active control-plane selector is unsafe'
  active_root="$(sudo readlink -f -- /opt/nexus-release/checkout)"
  [[ "$active_root" =~ ^/opt/nexus-release/control-plane/[0-9a-f]{40}$ ]] \
    || die 'active control-plane selector escapes its immutable version root'
  sudo test -d "$active_root" && sudo test ! -L "$active_root" \
    && test "$(sudo stat -Lc '%U:%G' -- "$active_root")" = root:root \
    || die 'active immutable control-plane root is unsafe'
  active_mode="$(sudo stat -Lc '%a' -- "$active_root")"
  test $((8#$active_mode & 0222)) -eq 0 \
    || die 'active immutable control-plane root is writable'
  expected_sha="${active_root##*/}"
  test "$(sudo cat "$active_root/.nexus-control-plane-ready")" = \
    "$expected_sha https://github.com/felipedrf74/cortex-telegram-hub-bot.git /usr/bin/node:v22.23.1" \
    || die 'active immutable control-plane marker is invalid'
  for spec in \
    'scripts/local-backup.py|/usr/local/libexec/nexus-local-backup/local-backup.py|755' \
    'scripts/local-backup-retry-launcher.sh|/usr/local/libexec/nexus-local-backup/local-backup-retry-launcher.sh|755' \
    'ops/local-backup/systemd/nexus-local-backup.service|/etc/systemd/system/nexus-local-backup.service|644' \
    'ops/local-backup/systemd/nexus-local-backup.timer|/etc/systemd/system/nexus-local-backup.timer|644' \
    'ops/local-backup/systemd/nexus-local-backup-pre-promotion.service|/etc/systemd/system/nexus-local-backup-pre-promotion.service|644' \
    'ops/local-backup/systemd/nexus-local-backup-restore-verify.service|/etc/systemd/system/nexus-local-backup-restore-verify.service|644' \
    'ops/local-backup/systemd/nexus-local-backup-restore-verify.timer|/etc/systemd/system/nexus-local-backup-restore-verify.timer|644' \
    'ops/local-backup/nexus-local-backup.sudoers|/etc/sudoers.d/nexus-local-backup|440'; do
    IFS='|' read -r relative destination mode <<<"$spec"
    source="$active_root/$relative"
    sudo test -f "$source" && sudo test ! -L "$source" \
      || die "immutable local-backup source is unsafe: $relative"
    sudo test -f "$destination" && sudo test ! -L "$destination" \
      && test "$(sudo stat -Lc '%U:%G:%a:%h' -- "$destination")" = \
        "root:root:$mode:1" \
      || die "installed local-backup asset metadata is unsafe: $destination"
    sudo cmp -s -- "$source" "$destination" \
      || die "installed local-backup asset differs from immutable source: $destination"
  done
  sudo visudo -cf /etc/sudoers.d/nexus-local-backup >/dev/null \
    || die 'installed local-backup sudoers policy is invalid'
  sudo systemctl daemon-reload
  for unit in nexus-local-backup.service nexus-local-backup.timer \
    nexus-local-backup-pre-promotion.service \
    nexus-local-backup-restore-verify.service \
    nexus-local-backup-restore-verify.timer; do
    load="$(sudo systemctl show "$unit" --property=LoadState --value)"
    fragment="$(sudo systemctl show "$unit" --property=FragmentPath --value)"
    dropins="$(sudo systemctl show "$unit" --property=DropInPaths --value)"
    test "$load" = loaded \
      && test "$fragment" = "/etc/systemd/system/$unit" \
      && test -z "$dropins" \
      || die "$unit does not resolve to its exact installed bytes"
  done
  test "$(sudo systemctl show nexus-local-backup-pre-promotion.service \
    --property=Type --value)" = oneshot \
    || die 'pre-promotion backup unit is not Type=oneshot'
  exec_start="$(sudo systemctl show nexus-local-backup-pre-promotion.service \
    --property=ExecStart --value)"
  case "$exec_start" in
    *'path=/usr/local/libexec/nexus-local-backup/local-backup.py ; argv[]=/usr/local/libexec/nexus-local-backup/local-backup.py pre-promotion ;'*) ;;
    *) die 'pre-promotion backup unit has an unexpected effective ExecStart' ;;
  esac
}

PM2_GUARD_ROOT=/etc/systemd/system.control

pm2_guard_path() {
  case "$1" in
    pm2-dominguez.service|nexus-release-pm2-recovery-daemon.service)
      printf '%s/%s\n' "$PM2_GUARD_ROOT" "$1" ;;
    *) return 64 ;;
  esac
}

pm2_guard_root_is_exact() {
  sudo test -d "$PM2_GUARD_ROOT" && sudo test ! -L "$PM2_GUARD_ROOT" \
    && test "$(sudo stat -Lc '%U:%G:%a' -- "$PM2_GUARD_ROOT")" = root:root:755
}

ensure_pm2_guard_root() {
  if ! sudo test -e "$PM2_GUARD_ROOT" && ! sudo test -L "$PM2_GUARD_ROOT"; then
    sudo install -d -o root -g root -m 755 -- "$PM2_GUARD_ROOT" || return 1
  fi
  pm2_guard_root_is_exact
}

install_pm2_guard() {
  local guard unit
  unit="$1"; guard="$(pm2_guard_path "$unit")" || return 1
  ensure_pm2_guard_root || return 1
  if sudo test -e "$guard" || sudo test -L "$guard"; then
    sudo test -L "$guard" || return 1
  else
    sudo ln -s -- /dev/null "$guard" || return 1
  fi
  test "$(sudo readlink -- "$guard")" = /dev/null \
    && test "$(sudo stat -c '%U:%G:%F' -- "$guard")" = \
      'root:root:symbolic link'
}

pm2_guard_is_exact() {
  local active can_start fragment guard load unit
  unit="$1"; guard="$(pm2_guard_path "$unit")" || return 1
  pm2_guard_root_is_exact || return 1
  sudo test -L "$guard" \
    && test "$(sudo readlink -- "$guard")" = /dev/null \
    && test "$(sudo stat -c '%U:%G:%F' -- "$guard")" = \
      'root:root:symbolic link' || return 1
  load="$(sudo systemctl show "$unit" --property=LoadState --value)" \
    || return 1
  fragment="$(sudo systemctl show "$unit" --property=FragmentPath --value)" \
    || return 1
  can_start="$(sudo systemctl show "$unit" --property=CanStart --value)" \
    || return 1
  active="$(sudo systemctl show "$unit" --property=ActiveState --value)" \
    || return 1
  test "$load" = masked && test "$fragment" = "$guard" \
    && test "$can_start" = no && test "$active" = inactive
}

require_pm2_guard() {
  local unit
  for unit in pm2-dominguez.service nexus-release-pm2-recovery-daemon.service; do
    pm2_guard_is_exact "$unit" \
      || die "$unit is not protected by its exact high-priority runtime guard"
  done
}

OLD_PRODUCTION=/home/dominguez/telegram-hub-bot/data/bot.db
OLD_STAGING=/home/dominguez/telegram-hub-bot-staging/data/bot.db
PM2_PRODUCTION_BASE=/home/dominguez/telegram-hub-bot
PM2_STAGING_BASE=/home/dominguez/telegram-hub-bot-staging
NEW_PRODUCTION=/var/lib/nexus-hub/production/data
NEW_STAGING=/var/lib/nexus-hub/staging/data
USER_RELEASE_LOCK=/home/dominguez/.local/state/nexus-release/.release.lock
MAINTENANCE_LOCK=/run/lock/nexus-release-sonar.lock
RUNTIME_EVIDENCE=/var/lib/nexus-release/state/bootstrap-legacy-runtime.json
TRANSITION_EVIDENCE=/var/lib/nexus-release/state/bootstrap-database-transition.json
BACKUP_ENV=/etc/nexus-local-backup/backup.env

# The PM2 transaction takes its user release lock first and the shared root
# maintenance mutex second. The container poller takes its own release lock
# first and this same maintenance mutex second, so the two paths cannot overlap.
sudo -u dominguez install -d -m 700 "$(dirname "$USER_RELEASE_LOCK")"
sudo -u dominguez touch "$USER_RELEASE_LOCK"
sudo -u dominguez chmod 600 "$USER_RELEASE_LOCK"
test "$(sudo stat -c '%U:%G:%a' -- "$USER_RELEASE_LOCK")" \
  = 'dominguez:dominguez:600' || die 'user release lock is unsafe'
test "$(sudo stat -c '%U:%G:%a' -- "$MAINTENANCE_LOCK")" \
  = 'root:dominguez:660' || die 'shared maintenance mutex is unsafe'
test ! -L "$USER_RELEASE_LOCK" && test ! -L "$MAINTENANCE_LOCK" \
  || die 'a release mutex is symbolic'
exec 9<>"$USER_RELEASE_LOCK"
flock -n 9 || die 'another PM2 release or capability transaction is active'
exec 8<>"$MAINTENANCE_LOCK"
flock -n 8 || die 'another root maintenance or container release is active'
require_local_backup_installation
sudo test -f "$BACKUP_ENV" && sudo test ! -L "$BACKUP_ENV" \
  || die 'backup environment is missing or symbolic'
test "$(sudo stat -Lc '%U:%G:%a:%h' -- "$BACKUP_ENV")" = 'root:root:600:1' \
  || die 'backup environment owner, mode, or link count is unsafe'
test "$(sudo awk -F= \
  '$1 == "NEXUS_LOCAL_BACKUP_DATABASE_PATH" { count += 1 } END { print count + 0 }' \
  "$BACKUP_ENV")" = 1 || die 'backup database path is absent or duplicated'
test "$(sudo awk -F= \
  '$1 == "NEXUS_LOCAL_BACKUP_DATABASE_PATH" { print substr($0, index($0, "=") + 1) }' \
  "$BACKUP_ENV")" = "$OLD_PRODUCTION" \
  || die 'governed backup is not bound to legacy production before cutover'

# Refuse stale or divergent container targets while PM2 is still online. The
# later under-lock recheck closes the race between this admission and the copy.
for TARGET in "$NEW_PRODUCTION/bot.db" "$NEW_PRODUCTION/bot.db.next" \
  "$NEW_STAGING/bot.db" "$NEW_STAGING/bot.db.next"; do
  sudo test ! -e "$TARGET" && sudo test ! -L "$TARGET" \
    || die "container target exists before PM2 stop; investigate without stopping production: $TARGET"
done

# 1. Capture every exact runtime and canonical database inode before the first
# mutating command. A failure after this no-replace root-owned publication can
# therefore use the pre-baseline recovery branch below even if `pm2 stop` is the
# command that aborts. If capture publication fails, every writer is still live.
for DB in "$OLD_PRODUCTION" "$OLD_STAGING"; do
  sudo test -f "$DB" && sudo test ! -L "$DB" \
    || die "legacy database path is missing or symbolic: $DB"
  test "$(sudo readlink -f -- "$DB")" = "$DB" \
    || die "legacy database path is not canonical: $DB"
  test "$(sudo stat -Lc '%U:%G:%a:%h' -- "$DB")" \
    = 'dominguez:dominguez:600:1' \
    || die "legacy database owner, mode, or link count is unsafe: $DB"
done
PRODUCTION_DATABASE_IDENTITY="$(sudo stat -Lc '%d:%i' -- "$OLD_PRODUCTION")"
STAGING_DATABASE_IDENTITY="$(sudo stat -Lc '%d:%i' -- "$OLD_STAGING")"
for ROLE in production staging; do
  if test "$ROLE" = production; then
    LEGACY_BASE="$PM2_PRODUCTION_BASE"
  else
    LEGACY_BASE="$PM2_STAGING_BASE"
  fi
  sudo test -L "$LEGACY_BASE/current" \
    || die "$ROLE legacy current selector is not symbolic"
  LEGACY_RUNTIME="$(sudo readlink -f -- "$LEGACY_BASE/current")"
  case "$LEGACY_RUNTIME" in
    "$LEGACY_BASE"/releases/*) ;;
    *) die "$ROLE legacy current selector is unsafe" ;;
  esac
  MARKER="$LEGACY_RUNTIME/.complete.json"
  sudo test -f "$MARKER" && sudo test ! -L "$MARKER" \
    || die "$ROLE legacy runtime marker is missing or symbolic"
  test "$(sudo stat -Lc '%F:%h' -- "$MARKER")" = 'regular file:1' \
    || die "$ROLE legacy runtime marker is not a single-link regular file"
  RUNTIME_SHA="$(sudo jq -er \
    'select(
       type == "object"
       and .schema == "nexus.release-bundle.v1"
       and (.runtimeSha | type == "string"
         and test("^[0-9a-f]{40}$"))
       and (.artifactDigest | type == "string"
         and test("^[0-9a-f]{64}$"))
     )
     | .runtimeSha' "$MARKER")" \
    || die "$ROLE legacy runtime marker is invalid"
  ARTIFACT_DIGEST="$(sudo jq -er .artifactDigest "$MARKER")"
  MARKER_SHA256="$(sudo sha256sum "$MARKER" | awk '{print $1}')"
  verify_installed_runtime "$LEGACY_RUNTIME" "$RUNTIME_SHA" "$ARTIFACT_DIGEST" \
    || die "$ROLE installed runtime tree differs from its captured artifact"
  if test "$ROLE" = production; then
    PRODUCTION_RUNTIME="$LEGACY_RUNTIME"
    PRODUCTION_SHA="$RUNTIME_SHA"
    PRODUCTION_ARTIFACT_DIGEST="$ARTIFACT_DIGEST"
    PRODUCTION_MARKER_SHA256="$MARKER_SHA256"
  else
    STAGING_RUNTIME="$LEGACY_RUNTIME"
    STAGING_SHA="$RUNTIME_SHA"
    STAGING_ARTIFACT_DIGEST="$ARTIFACT_DIGEST"
    STAGING_MARKER_SHA256="$MARKER_SHA256"
  fi
done

require_exact_pm2_identity() {
  local app expected_artifact expected_base expected_cwd expected_database
  local expected_exec expected_role expected_sha expected_status row
  app="$1"
  expected_status="$2"
  case "$app" in
    nexus-hub)
      expected_role=production
      expected_base="$PM2_PRODUCTION_BASE"
      expected_cwd="$PRODUCTION_RUNTIME"
      expected_exec="$PRODUCTION_RUNTIME/dist/index.js"
      expected_database="$OLD_PRODUCTION"
      expected_sha="$PRODUCTION_SHA"
      expected_artifact="$PRODUCTION_ARTIFACT_DIGEST"
      ;;
    content-engine)
      expected_role=production
      expected_base="$PM2_PRODUCTION_BASE"
      expected_cwd="$PRODUCTION_RUNTIME/content-engine"
      expected_exec=/usr/bin/python3.12
      expected_database=''
      expected_sha="$PRODUCTION_SHA"
      expected_artifact="$PRODUCTION_ARTIFACT_DIGEST"
      ;;
    nexus-hub-staging)
      expected_role=staging
      expected_base="$PM2_STAGING_BASE"
      expected_cwd="$STAGING_RUNTIME"
      expected_exec="$STAGING_RUNTIME/dist/index.js"
      expected_database="$OLD_STAGING"
      expected_sha="$STAGING_SHA"
      expected_artifact="$STAGING_ARTIFACT_DIGEST"
      ;;
    content-engine-staging)
      expected_role=staging
      expected_base="$PM2_STAGING_BASE"
      expected_cwd="$STAGING_RUNTIME/content-engine"
      expected_exec=/usr/bin/python3.12
      expected_database=''
      expected_sha="$STAGING_SHA"
      expected_artifact="$STAGING_ARTIFACT_DIGEST"
      ;;
    *) die "unknown PM2 application: $app" ;;
  esac
  row="$(jq -ce --arg app "$app" \
    '[.[] | select(.name == $app)]
     | if length == 1 then .[0] else error("PM2 identity is ambiguous") end' \
    <<<"$PM2_JSON")" || die "$app PM2 identity is ambiguous"
  test "$(jq -er '.pm2_env.status' <<<"$row")" = "$expected_status" \
    || die "$app PM2 status is not $expected_status"
  test "$(jq -er '.pm2_env.NEXUS_RELEASE_SHA // .pm2_env.GIT_COMMIT' \
    <<<"$row")" = "$expected_sha" || die "$app source SHA is unexpected"
  test "$(jq -er '.pm2_env.NEXUS_RELEASE_ARTIFACT_SHA256' <<<"$row")" \
    = "$expected_artifact" || die "$app artifact digest is unexpected"
  test "$(jq -er '.pm2_env.NEXUS_RELEASE_ROLE' <<<"$row")" = "$expected_role" \
    || die "$app release role is unexpected"
  test "$(jq -er '.pm2_env.NEXUS_RELEASE_BASE_DIR' <<<"$row")" = "$expected_base" \
    || die "$app release base is unexpected"
  test "$(jq -er '.pm2_env.pm_cwd' <<<"$row")" = "$expected_cwd" \
    || die "$app working directory is outside the recorded runtime"
  test "$(jq -er '.pm2_env.pm_exec_path' <<<"$row")" = "$expected_exec" \
    || die "$app executable is outside the recorded runtime identity"
  if test -n "$expected_database"; then
    test "$(jq -er '.pm2_env.DATABASE_PATH' <<<"$row")" = "$expected_database" \
      || die "$app database identity is unexpected"
  fi
}

PM2_JSON="$(run_pm2_as_dominguez jlist)"
for APP in nexus-hub content-engine nexus-hub-staging content-engine-staging; do
  require_exact_pm2_identity "$APP" online
done
sudo test ! -e "$TRANSITION_EVIDENCE" \
  || die 'database transition evidence already exists; use pre-baseline recovery'
if sudo test -e "$RUNTIME_EVIDENCE" || sudo test -L "$RUNTIME_EVIDENCE"; then
  sudo test -f "$RUNTIME_EVIDENCE" && sudo test ! -L "$RUNTIME_EVIDENCE" \
    || die 'existing legacy runtime capture is missing or symbolic'
  sudo jq -e --arg productionSourceSha "$PRODUCTION_SHA" \
    --arg productionArtifactDigest "$PRODUCTION_ARTIFACT_DIGEST" \
    --arg productionRuntimePath "$PRODUCTION_RUNTIME" \
    --arg productionMarkerSha256 "$PRODUCTION_MARKER_SHA256" \
    --arg productionDatabaseIdentity "$PRODUCTION_DATABASE_IDENTITY" \
    --arg stagingSourceSha "$STAGING_SHA" \
    --arg stagingArtifactDigest "$STAGING_ARTIFACT_DIGEST" \
    --arg stagingRuntimePath "$STAGING_RUNTIME" \
    --arg stagingMarkerSha256 "$STAGING_MARKER_SHA256" \
    --arg stagingDatabaseIdentity "$STAGING_DATABASE_IDENTITY" \
    '.schema == "nexus.bootstrap-legacy-runtime-capture.v2"
     and .productionSourceSha == $productionSourceSha
     and .productionArtifactDigest == $productionArtifactDigest
     and .productionRuntimePath == $productionRuntimePath
     and .productionMarkerSha256 == $productionMarkerSha256
     and .productionDatabaseIdentity == $productionDatabaseIdentity
     and .stagingSourceSha == $stagingSourceSha
     and .stagingArtifactDigest == $stagingArtifactDigest
     and .stagingRuntimePath == $stagingRuntimePath
     and .stagingMarkerSha256 == $stagingMarkerSha256
     and .stagingDatabaseIdentity == $stagingDatabaseIdentity' \
    "$RUNTIME_EVIDENCE" >/dev/null \
    || die 'existing legacy runtime capture differs from the current exact PM2 identity'
else
  RUNTIME_EVIDENCE_TEMP="$(mktemp)"
  jq -cn --arg createdAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg productionSourceSha "$PRODUCTION_SHA" \
    --arg productionArtifactDigest "$PRODUCTION_ARTIFACT_DIGEST" \
    --arg productionRuntimePath "$PRODUCTION_RUNTIME" \
    --arg productionMarkerSha256 "$PRODUCTION_MARKER_SHA256" \
    --arg productionDatabaseIdentity "$PRODUCTION_DATABASE_IDENTITY" \
    --arg stagingSourceSha "$STAGING_SHA" \
    --arg stagingArtifactDigest "$STAGING_ARTIFACT_DIGEST" \
    --arg stagingRuntimePath "$STAGING_RUNTIME" \
    --arg stagingMarkerSha256 "$STAGING_MARKER_SHA256" \
    --arg stagingDatabaseIdentity "$STAGING_DATABASE_IDENTITY" \
    '{schema:"nexus.bootstrap-legacy-runtime-capture.v2",createdAt:$createdAt,
      productionSourceSha:$productionSourceSha,
      productionArtifactDigest:$productionArtifactDigest,
      productionRuntimePath:$productionRuntimePath,
      productionMarkerSha256:$productionMarkerSha256,
      productionDatabaseIdentity:$productionDatabaseIdentity,
      stagingSourceSha:$stagingSourceSha,
      stagingArtifactDigest:$stagingArtifactDigest,
      stagingRuntimePath:$stagingRuntimePath,
      stagingMarkerSha256:$stagingMarkerSha256,
      stagingDatabaseIdentity:$stagingDatabaseIdentity}' >"$RUNTIME_EVIDENCE_TEMP"
  RUNTIME_EVIDENCE_STAGE="$RUNTIME_EVIDENCE.next-$BASHPID"
  sudo test ! -e "$RUNTIME_EVIDENCE_STAGE" \
    || die 'legacy runtime capture staging path already exists'
  sudo install -o root -g root -m 600 \
    "$RUNTIME_EVIDENCE_TEMP" "$RUNTIME_EVIDENCE_STAGE"
  rm -f "$RUNTIME_EVIDENCE_TEMP"
  sudo sync -f "$RUNTIME_EVIDENCE_STAGE"
  sudo mv -T -- "$RUNTIME_EVIDENCE_STAGE" "$RUNTIME_EVIDENCE"
fi
test "$(sudo stat -Lc '%U:%G:%a:%h' -- "$RUNTIME_EVIDENCE")" \
  = 'root:root:600:1' || die 'legacy runtime capture publication is unsafe'
sudo sync -f "$RUNTIME_EVIDENCE"
sudo sync -f "$(dirname "$RUNTIME_EVIDENCE")"

# The first mutation happens only after the recovery identity is durable.
run_pm2_as_dominguez stop \
  nexus-hub content-engine nexus-hub-staging content-engine-staging
PM2_JSON="$(run_pm2_as_dominguez jlist)"
for APP in nexus-hub content-engine nexus-hub-staging content-engine-staging; do
  require_exact_pm2_identity "$APP" stopped
done
for UNIT in pm2-dominguez.service nexus-release-pm2-recovery-daemon.service; do
  LOAD_STATE="$(sudo systemctl show "$UNIT" --property=LoadState --value)"
  case "$LOAD_STATE" in
    loaded) sudo systemctl disable --now "$UNIT" ;;
    masked)
      test "$UNIT" = nexus-release-pm2-recovery-daemon.service \
        || die "$UNIT is unexpectedly masked before first cutover"
      ;;
    not-found) ;;
    *) die "$UNIT has unsafe load state: $LOAD_STATE" ;;
  esac
  install_pm2_guard "$UNIT" \
    || die "$UNIT high-priority runtime guard could not be installed"
done
sudo systemctl daemon-reload
run_pm2_as_dominguez kill
require_pm2_guard
require_no_open_handles "$OLD_PRODUCTION" "$OLD_STAGING"
require_no_legacy_listeners

# 2. Checkpoint every committed WAL frame, then require all SQLite sidecars to
# be gone. Empty WAL/SHM files are not accepted because the bootstrap verifier
# deliberately uses absence as part of its quiescence proof.
remove_proven_stale_wal_sidecars "$OLD_PRODUCTION" "$OLD_STAGING"

# 3. Validate the stopped sources and capture exact logical evidence.
require_valid_sqlite "$OLD_PRODUCTION"
require_valid_sqlite "$OLD_STAGING"
PRODUCTION_LOGICAL_SHA="$(logical_digest "$OLD_PRODUCTION")"
STAGING_LOGICAL_SHA="$(logical_digest "$OLD_STAGING")"
printf 'legacy production logical sha256: %s\n' "$PRODUCTION_LOGICAL_SHA"
printf 'legacy staging logical sha256: %s\n' "$STAGING_LOGICAL_SHA"
sudo sha256sum "$OLD_PRODUCTION" "$OLD_STAGING"
sudo sqlite3 "file:$OLD_PRODUCTION?mode=ro" \
  'SELECT filename FROM _migrations ORDER BY filename;'
sudo sqlite3 "file:$OLD_STAGING?mode=ro" \
  'SELECT filename FROM _migrations ORDER BY filename;'

# 4. Require a fresh successful governed backup receipt for the exact stopped
# production database; a stale last-success.json is not evidence for this run.
require_local_backup_installation
remove_proven_stale_wal_sidecars "$OLD_PRODUCTION" "$OLD_STAGING"
require_no_sqlite_sidecars "$OLD_PRODUCTION" "$OLD_STAGING"
BACKUP_REQUESTED_MS="$(date +%s%3N)"
sudo systemctl start nexus-local-backup-pre-promotion.service
test "$(sudo systemctl show nexus-local-backup-pre-promotion.service \
  --property=Result --value)" = 'success' || die 'pre-cutover backup unit failed'
BACKUP_RECEIPT=/srv/nexus-backups/application/state/last-success.json
sudo test -f "$BACKUP_RECEIPT" || die 'pre-cutover backup receipt is missing'
sudo jq -e --arg expectedDatabase "$OLD_PRODUCTION" \
  '.schema == "nexus.local-backup.v1"
   and .status == "passed"
   and .kind == "pre-promotion"
   and .backupRoot == "/srv/nexus-backups/application"
   and .database == $expectedDatabase
   and (.encryptedSha256 | type == "string"
        and test("^[0-9a-f]{64}$"))
   and (.encryptedSizeBytes | type == "number" and . > 0 and floor == .)
   and (.startedAt | type == "string"
        and test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]+)?Z$"))
   and (.completedAt | type == "string"
        and test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]+)?Z$"))' \
  "$BACKUP_RECEIPT" >/dev/null
BACKUP_PRODUCER_STARTED_MS="$(date -d \
  "$(sudo jq -er .startedAt "$BACKUP_RECEIPT")" +%s%3N)"
BACKUP_COMPLETED_MS="$(date -d \
  "$(sudo jq -er .completedAt "$BACKUP_RECEIPT")" +%s%3N)"
test "$BACKUP_PRODUCER_STARTED_MS" -ge "$BACKUP_REQUESTED_MS" \
  || die 'pre-cutover backup producer predates this invocation'
test "$BACKUP_COMPLETED_MS" -ge "$BACKUP_PRODUCER_STARTED_MS" \
  || die 'pre-cutover backup completed before its producer started'
sudo jq '{kind,database,encryptedSha256,encryptedSizeBytes,startedAt,completedAt}' "$BACKUP_RECEIPT"

# Read-only backup tooling may recreate an empty WAL plus SHM for a WAL-mode
# source. Delete only the exact single-link sidecars proven stale by a second
# no-handle and 0|0|0 checkpoint boundary; never delete a journal or nonzero WAL.
remove_proven_stale_wal_sidecars "$OLD_PRODUCTION" "$OLD_STAGING"

# 5. Make the destination directories root-only while creating the snapshots.
# A failure leaves them unusable by containers, which is the fail-closed state.
sudo chown root:root "$NEW_PRODUCTION" "$NEW_STAGING"
sudo chmod 700 "$NEW_PRODUCTION" "$NEW_STAGING"
sudo test ! -e "$NEW_PRODUCTION/bot.db" && sudo test ! -L "$NEW_PRODUCTION/bot.db" \
  || die 'production container target already exists; use the recovery/rebaseline branch'
sudo test ! -e "$NEW_STAGING/bot.db" && sudo test ! -L "$NEW_STAGING/bot.db" \
  || die 'staging container target already exists; use the recovery/rebaseline branch'
sudo test ! -e "$NEW_PRODUCTION/bot.db.next" \
  && sudo test ! -L "$NEW_PRODUCTION/bot.db.next" \
  || die 'production temporary target already exists; investigate before retrying'
sudo test ! -e "$NEW_STAGING/bot.db.next" \
  && sudo test ! -L "$NEW_STAGING/bot.db.next" \
  || die 'staging temporary target already exists; investigate before retrying'
sudo sqlite3 "$OLD_PRODUCTION" ".backup '$NEW_PRODUCTION/bot.db.next'"
sudo sqlite3 "$OLD_STAGING" ".backup '$NEW_STAGING/bot.db.next'"
require_valid_sqlite "$NEW_PRODUCTION/bot.db.next"
require_valid_sqlite "$NEW_STAGING/bot.db.next"
PRODUCTION_TARGET_LOGICAL_SHA="$(logical_digest "$NEW_PRODUCTION/bot.db.next")"
STAGING_TARGET_LOGICAL_SHA="$(logical_digest "$NEW_STAGING/bot.db.next")"
test "$PRODUCTION_TARGET_LOGICAL_SHA" = "$PRODUCTION_LOGICAL_SHA" \
  || die 'production snapshot differs from the legacy production database'
test "$STAGING_TARGET_LOGICAL_SHA" = "$STAGING_LOGICAL_SHA" \
  || die 'staging snapshot differs from the legacy staging database'
# WAL-mode read-only validation and logical dumps may create an empty WAL plus
# a single-link SHM beside an otherwise valid snapshot. Reconcile only that
# proven zero-WAL state after the final read, then require sidecar absence before
# the temporary database names can be published as container targets.
remove_proven_stale_wal_sidecars \
  "$NEW_PRODUCTION/bot.db.next" "$NEW_STAGING/bot.db.next"
require_no_sqlite_sidecars \
  "$NEW_PRODUCTION/bot.db.next" "$NEW_STAGING/bot.db.next"
remove_proven_stale_wal_sidecars "$OLD_PRODUCTION" "$OLD_STAGING"

sudo chmod 600 "$NEW_PRODUCTION/bot.db.next" "$NEW_STAGING/bot.db.next"
sudo mv -f "$NEW_PRODUCTION/bot.db.next" "$NEW_PRODUCTION/bot.db"
sudo mv -f "$NEW_STAGING/bot.db.next" "$NEW_STAGING/bot.db"
test "$(sudo stat -c '%d:%i' "$NEW_PRODUCTION/bot.db")" != \
  "$(sudo stat -c '%d:%i' "$NEW_STAGING/bot.db")" \
  || die 'production and staging databases share one inode'
sudo chown 10001:10001 \
  "$NEW_PRODUCTION" "$NEW_STAGING" \
  "$NEW_PRODUCTION/bot.db" "$NEW_STAGING/bot.db"
sudo chmod 700 "$NEW_PRODUCTION" "$NEW_STAGING"
require_no_open_handles \
  "$OLD_PRODUCTION" "$OLD_STAGING" \
  "$NEW_PRODUCTION/bot.db" "$NEW_STAGING/bot.db"
require_no_sqlite_sidecars \
  "$OLD_PRODUCTION" "$OLD_STAGING" \
  "$NEW_PRODUCTION/bot.db" "$NEW_STAGING/bot.db"

# Backups must follow the container target before the bootstrap unit can mutate
# it. The backup's read may recreate zero WAL/SHM, so repeat the same narrowly
# proven stale-sidecar cleanup while both release mutexes and the PM2 guard hold.
sudo sed -i \
  's#^NEXUS_LOCAL_BACKUP_DATABASE_PATH=.*#NEXUS_LOCAL_BACKUP_DATABASE_PATH=/var/lib/nexus-hub/production/data/bot.db#' \
  "$BACKUP_ENV"
test "$(sudo awk -F= \
  '$1 == "NEXUS_LOCAL_BACKUP_DATABASE_PATH" { print substr($0, index($0, "=") + 1) }' \
  "$BACKUP_ENV")" = "$NEW_PRODUCTION/bot.db" \
  || die 'governed backup repoint did not settle on container production'
remove_proven_stale_wal_sidecars \
  "$NEW_PRODUCTION/bot.db" "$NEW_STAGING/bot.db"
require_no_sqlite_sidecars \
  "$NEW_PRODUCTION/bot.db" "$NEW_STAGING/bot.db"
BACKUP_REQUESTED_MS="$(date +%s%3N)"
sudo systemctl start nexus-local-backup-pre-promotion.service
test "$(sudo systemctl show nexus-local-backup-pre-promotion.service \
  --property=Result --value)" = 'success' \
  || die 'container-path backup unit failed'
sudo jq -e \
  '.schema == "nexus.local-backup.v1"
   and .status == "passed"
   and .kind == "pre-promotion"
   and .backupRoot == "/srv/nexus-backups/application"
   and .database == "/var/lib/nexus-hub/production/data/bot.db"
   and (.encryptedSha256 | type == "string"
        and test("^[0-9a-f]{64}$"))
   and (.encryptedSizeBytes | type == "number" and . > 0 and floor == .)
   and (.startedAt | type == "string"
        and test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]+)?Z$"))
   and (.completedAt | type == "string"
        and test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]+)?Z$"))' \
  "$BACKUP_RECEIPT" >/dev/null \
  || die 'container-path backup receipt contract failed'
BACKUP_PRODUCER_STARTED_MS="$(date -d \
  "$(sudo jq -er .startedAt "$BACKUP_RECEIPT")" +%s%3N)"
BACKUP_COMPLETED_MS="$(date -d \
  "$(sudo jq -er .completedAt "$BACKUP_RECEIPT")" +%s%3N)"
test "$BACKUP_PRODUCER_STARTED_MS" -ge "$BACKUP_REQUESTED_MS" \
  || die 'container-path backup producer predates this invocation'
test "$BACKUP_COMPLETED_MS" -ge "$BACKUP_PRODUCER_STARTED_MS" \
  || die 'container-path backup completed before its producer started'
remove_proven_stale_wal_sidecars \
  "$NEW_PRODUCTION/bot.db" "$NEW_STAGING/bot.db"
require_no_sqlite_sidecars \
  "$OLD_PRODUCTION" "$OLD_STAGING" \
  "$NEW_PRODUCTION/bot.db" "$NEW_STAGING/bot.db"
require_pm2_guard
require_no_legacy_listeners
test "$(sudo stat -Lc '%d:%i' -- "$OLD_PRODUCTION")" \
  = "$PRODUCTION_DATABASE_IDENTITY" \
  || die 'legacy production database identity changed during transition'
test "$(sudo stat -Lc '%d:%i' -- "$OLD_STAGING")" \
  = "$STAGING_DATABASE_IDENTITY" \
  || die 'legacy staging database identity changed during transition'
TRANSITION_EVIDENCE_TEMP="$(mktemp)"
RUNTIME_CAPTURE_SHA256="$(sudo sha256sum "$RUNTIME_EVIDENCE" | awk '{print $1}')"
jq -cn --arg createdAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg runtimeCaptureSha256 "$RUNTIME_CAPTURE_SHA256" \
  --arg legacyProductionIdentity "$PRODUCTION_DATABASE_IDENTITY" \
  --arg legacyProductionLogicalDigest "$PRODUCTION_LOGICAL_SHA" \
  --arg legacyStagingIdentity "$STAGING_DATABASE_IDENTITY" \
  --arg legacyStagingLogicalDigest "$STAGING_LOGICAL_SHA" \
  --arg targetProductionIdentity \
    "$(sudo stat -Lc '%d:%i' -- "$NEW_PRODUCTION/bot.db")" \
  --arg targetProductionLogicalDigest "$PRODUCTION_TARGET_LOGICAL_SHA" \
  --arg targetStagingIdentity \
    "$(sudo stat -Lc '%d:%i' -- "$NEW_STAGING/bot.db")" \
  --arg targetStagingLogicalDigest "$STAGING_TARGET_LOGICAL_SHA" \
  '{schema:"nexus.bootstrap-database-transition.v1",createdAt:$createdAt,
    runtimeCaptureSha256:$runtimeCaptureSha256,
    legacy:{production:{path:"/home/dominguez/telegram-hub-bot/data/bot.db",
      identity:$legacyProductionIdentity,logicalDigest:$legacyProductionLogicalDigest},
      staging:{path:"/home/dominguez/telegram-hub-bot-staging/data/bot.db",
      identity:$legacyStagingIdentity,logicalDigest:$legacyStagingLogicalDigest}},
    target:{production:{path:"/var/lib/nexus-hub/production/data/bot.db",
      identity:$targetProductionIdentity,logicalDigest:$targetProductionLogicalDigest},
      staging:{path:"/var/lib/nexus-hub/staging/data/bot.db",
      identity:$targetStagingIdentity,logicalDigest:$targetStagingLogicalDigest}},
    backupDatabasePath:"/var/lib/nexus-hub/production/data/bot.db"}' \
  >"$TRANSITION_EVIDENCE_TEMP"
TRANSITION_EVIDENCE_STAGE="$TRANSITION_EVIDENCE.next-$BASHPID"
sudo test ! -e "$TRANSITION_EVIDENCE_STAGE" \
  || die 'database transition evidence staging path already exists'
sudo install -o root -g root -m 600 \
  "$TRANSITION_EVIDENCE_TEMP" "$TRANSITION_EVIDENCE_STAGE"
rm -f "$TRANSITION_EVIDENCE_TEMP"
sudo sync -f "$TRANSITION_EVIDENCE_STAGE"
sudo mv -T -- "$TRANSITION_EVIDENCE_STAGE" "$TRANSITION_EVIDENCE"
test "$(sudo stat -Lc '%U:%G:%a:%h' -- "$TRANSITION_EVIDENCE")" \
  = 'root:root:600:1' || die 'database transition evidence publication is unsafe'
sudo sync -f "$TRANSITION_EVIDENCE"
sudo sync -f "$(dirname "$TRANSITION_EVIDENCE")"
printf 'container snapshots are valid, isolated, and source-equal\n'
```

A missing source, an uncertain/open `lsof` result, a checkpoint result other
than `0|0|0`, any WAL/SHM/journal sidecar, a failed integrity or foreign-key
check, a source/snapshot logical-dump mismatch, or matching production/staging
inode identities means **stop**. Do not start the containers, and do not delete
either PM2 database. A raw `bot.db` SHA is supporting identity evidence, not
proof of logical equality when the source previously used WAL. Empty production
or staging databases are unsafe cutovers.

The transaction also repoints and verifies the governed backup before releasing
either mutex. The poller rejects a receipt whose `database` is not exactly the
production database it is about to migrate, and the transaction removes only a
single-link zero-byte WAL and its SHM after a second no-handle/`0|0|0` proof.

### Recover or resume an abort before the owner baseline exists

If section 1b stops after its root-owned runtime capture is published but before
`bootstrap-baseline.json` exists, do **not** use the baseline-dependent bootstrap
fallback later in this runbook. Run the complete attended transaction below.
Choose exactly one action: `recover-pm2` returns the untouched legacy pair to
service and leaves every container target or temporary snapshot untouched for
incident review; `resume-baseline` proves the completed database-transition
checkpoint and leaves PM2 guarded so section 3a can continue idempotently; after
incident review, `reset-cutover` preserves the complete governed data trees,
retires only the archived transition checkpoint, restores PM2, and makes section
1b safely re-enterable with the still-exact runtime capture. A target with a
different logical digest may contain newer data, so only resume refuses it.
Ordinary recovery never moves, replaces, or deletes target data.

The section 1b capture is deliberately published before `pm2 stop`, its first
mutating command. Therefore every abort that can leave an app stopped has this
branch. If no capture exists, section 1b did not cross that mutation boundary;
inspect the still-running PM2 identities and restart section 1b from its top.

```bash
set -euo pipefail

die() { printf 'PRE-BASELINE RECOVERY REFUSED: %s\n' "$*" >&2; exit 1; }

PM2_RETIREMENT_JOURNAL=/var/lib/nexus-release/state/pm2-fallback-retirement.json
PM2_RETIRED_TOMBSTONE=/var/lib/nexus-release/state/pm2-fallback-retired.json
for PM2_RETIREMENT_GATE in "$PM2_RETIREMENT_JOURNAL" "$PM2_RETIRED_TOMBSTONE"; do
  sudo test ! -e "$PM2_RETIREMENT_GATE" \
    && sudo test ! -L "$PM2_RETIREMENT_GATE" \
    || die "PM2 fallback retirement gate exists: $PM2_RETIREMENT_GATE"
done
unset PM2_RETIREMENT_GATE

run_pm2_as_dominguez() {
  local pm2_cwd=/home/dominguez
  (cd "$pm2_cwd" && sudo -u dominguez pm2 "$@")
}

require_no_open_handles() {
  local db error_file handles lsof_status suffix
  local -a candidates
  for db in "$@"; do
    sudo test -f "$db" || die "missing database: $db"
    candidates+=("$db")
    for suffix in -wal -shm -journal; do
      if sudo test -e "$db$suffix"; then candidates+=("$db$suffix"); fi
    done
  done
  error_file="$(mktemp)"
  if handles="$(sudo lsof -t -- "${candidates[@]}" 2>"$error_file")"; then
    lsof_status=0
  else
    lsof_status=$?
  fi
  if test -s "$error_file"; then
    sed 's/^/lsof: /' "$error_file" >&2
    rm -f "$error_file"
    die 'open-handle probe produced an error'
  fi
  rm -f "$error_file"
  case "$lsof_status" in
    0) die "database handles remain open: $handles" ;;
    1) test -z "$handles" || die 'lsof returned output with no-match status' ;;
    *) die "lsof failed with status $lsof_status" ;;
  esac
}

require_no_sqlite_sidecars() {
  local db suffix
  for db in "$@"; do
    for suffix in -wal -shm -journal; do
      sudo test ! -e "$db$suffix" || die "SQLite sidecar remains: $db$suffix"
    done
  done
}

remove_proven_stale_wal_sidecars() {
  local checkpoint db metadata
  local -a stale_sidecars
  for db in "$@"; do
    stale_sidecars=()
    require_no_open_handles "$db"
    checkpoint="$(sudo sqlite3 "$db" 'PRAGMA wal_checkpoint(TRUNCATE);')"
    test "$checkpoint" = '0|0|0' \
      || die "zero-WAL checkpoint proof failed for $db: $checkpoint"
    require_no_open_handles "$db"
    sudo test ! -e "$db-journal" \
      || die "rollback journal cannot be classified stale: $db-journal"
    if sudo test -e "$db-wal"; then
      metadata="$(sudo stat -c '%F:%h:%s' -- "$db-wal")"
      test "$metadata" = 'regular empty file:1:0' \
        || die "WAL sidecar is not a single-link zero-byte regular file: $db-wal"
      stale_sidecars+=("$db-wal")
    fi
    if sudo test -e "$db-shm"; then
      metadata="$(sudo stat -c '%F:%h' -- "$db-shm")"
      test "$metadata" = 'regular file:1' \
        || die "SHM sidecar is not a single-link regular file: $db-shm"
      stale_sidecars+=("$db-shm")
    fi
    if test "${#stale_sidecars[@]}" -gt 0; then
      sudo rm -- "${stale_sidecars[@]}"
    fi
    require_no_open_handles "$db"
    require_no_sqlite_sidecars "$db"
  done
}

require_valid_sqlite() {
  local db foreign_keys integrity
  db="$1"
  integrity="$(sudo sqlite3 "file:$db?mode=ro" 'PRAGMA integrity_check;')"
  test "$integrity" = ok || die "integrity_check failed for $db: $integrity"
  foreign_keys="$(sudo sqlite3 "file:$db?mode=ro" 'PRAGMA foreign_key_check;')"
  test -z "$foreign_keys" \
    || die "foreign_key_check failed for $db: $foreign_keys"
}

logical_digest() {
  sudo sqlite3 "file:$1?mode=ro" '.dump' | sha256sum | awk '{print $1}'
}

verify_installed_runtime() {
  local digest runtime sha verified
  runtime="$1"
  sha="$2"
  digest="$3"
  sudo test -d "$runtime" && sudo test ! -L "$runtime" \
    && sudo test -f "$runtime/ecosystem.release.config.js" \
    && sudo test ! -L "$runtime/ecosystem.release.config.js" \
    || return 1
  if sudo test -e "$runtime/.nexus-installed-runtime.json" \
      || sudo test -L "$runtime/.nexus-installed-runtime.json" \
      || sudo test -e "$runtime/scripts/release-installed-tree-attestation.mjs" \
      || sudo test -L "$runtime/scripts/release-installed-tree-attestation.mjs"; then
    sudo test -f "$runtime/.nexus-installed-runtime.json" \
      && sudo test ! -L "$runtime/.nexus-installed-runtime.json" \
      && sudo test -f "$runtime/scripts/release-installed-tree-attestation.mjs" \
      && sudo test ! -L "$runtime/scripts/release-installed-tree-attestation.mjs" \
      || return 1
    sudo /usr/bin/node \
      /opt/nexus-release/checkout/scripts/release-artifact-manifest.mjs \
      --verify-installed-source "$runtime" \
      --expected-runtime-sha "$sha" --expected-digest "$digest" \
      --require-declared-file scripts/release-installed-tree-attestation.mjs \
      >/dev/null || return 1
    sudo /usr/bin/node \
      "$runtime/scripts/release-installed-tree-attestation.mjs" validate \
      --root "$runtime" --runtime-sha "$sha" --artifact-digest "$digest" \
      >/dev/null || return 1
  else
    sudo /usr/bin/node \
      /opt/nexus-release/checkout/scripts/release-artifact-manifest.mjs \
      --verify-installed-source "$runtime" \
      --expected-runtime-sha "$sha" --expected-digest "$digest" \
      >/dev/null || return 1
    sudo /usr/bin/node \
      /opt/nexus-release/checkout/scripts/release-runtime-dependencies.mjs \
      verify-predecessor-extracted --root "$runtime" --python-bin /usr/bin/python3.12 \
      >/dev/null || return 1
  fi
  verified="$(sudo /usr/bin/node - "$runtime/.complete.json" \
    "$(basename "$runtime")" <<'NODE'
const fs = require('node:fs');
const [markerPath, directoryName] = process.argv.slice(2);
const stat = fs.lstatSync(markerPath);
const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
if (!stat.isFile() || stat.isSymbolicLink()
    || marker?.schema !== 'nexus.release-bundle.v1'
    || !/^[0-9a-f]{40}$/.test(marker.runtimeSha ?? '')
    || !/^[0-9a-f]{64}$/.test(marker.artifactDigest ?? '')
    || directoryName !== `${marker.runtimeSha}-${marker.artifactDigest.slice(0, 12)}`) {
  process.exit(1);
}
process.stdout.write(`${marker.runtimeSha} ${marker.artifactDigest}\n`);
NODE
)" || return 1
  test "$verified" = "$sha $digest"
}

require_canonical_database() {
  local db expected_identity
  db="$1"
  expected_identity="${2:-}"
  sudo test -f "$db" && sudo test ! -L "$db" \
    || die "database is missing or symbolic: $db"
  test "$(sudo readlink -f -- "$db")" = "$db" \
    || die "database path is not canonical: $db"
  test "$(sudo stat -Lc '%F:%h' -- "$db")" = 'regular file:1' \
    || die "database is not a single-link regular file: $db"
  if test -n "$expected_identity"; then
    test "$(sudo stat -Lc '%d:%i' -- "$db")" = "$expected_identity" \
      || die "captured database identity changed: $db"
  fi
  require_no_open_handles "$db"
  require_no_sqlite_sidecars "$db"
  require_valid_sqlite "$db"
}

require_local_backup_installation() {
  local active_mode active_root destination dropins exec_start expected_sha
  local fragment load mode relative source spec unit
  sudo test -L /opt/nexus-release/checkout \
    && test "$(sudo stat -c '%U:%G:%F' -- /opt/nexus-release/checkout)" = \
      'root:root:symbolic link' \
    || die 'active control-plane selector is unsafe'
  active_root="$(sudo readlink -f -- /opt/nexus-release/checkout)"
  [[ "$active_root" =~ ^/opt/nexus-release/control-plane/[0-9a-f]{40}$ ]] \
    || die 'active control-plane selector escapes its immutable version root'
  sudo test -d "$active_root" && sudo test ! -L "$active_root" \
    && test "$(sudo stat -Lc '%U:%G' -- "$active_root")" = root:root \
    || die 'active immutable control-plane root is unsafe'
  active_mode="$(sudo stat -Lc '%a' -- "$active_root")"
  test $((8#$active_mode & 0222)) -eq 0 \
    || die 'active immutable control-plane root is writable'
  expected_sha="${active_root##*/}"
  test "$(sudo cat "$active_root/.nexus-control-plane-ready")" = \
    "$expected_sha https://github.com/felipedrf74/cortex-telegram-hub-bot.git /usr/bin/node:v22.23.1" \
    || die 'active immutable control-plane marker is invalid'
  for spec in \
    'scripts/local-backup.py|/usr/local/libexec/nexus-local-backup/local-backup.py|755' \
    'scripts/local-backup-retry-launcher.sh|/usr/local/libexec/nexus-local-backup/local-backup-retry-launcher.sh|755' \
    'ops/local-backup/systemd/nexus-local-backup.service|/etc/systemd/system/nexus-local-backup.service|644' \
    'ops/local-backup/systemd/nexus-local-backup.timer|/etc/systemd/system/nexus-local-backup.timer|644' \
    'ops/local-backup/systemd/nexus-local-backup-pre-promotion.service|/etc/systemd/system/nexus-local-backup-pre-promotion.service|644' \
    'ops/local-backup/systemd/nexus-local-backup-restore-verify.service|/etc/systemd/system/nexus-local-backup-restore-verify.service|644' \
    'ops/local-backup/systemd/nexus-local-backup-restore-verify.timer|/etc/systemd/system/nexus-local-backup-restore-verify.timer|644' \
    'ops/local-backup/nexus-local-backup.sudoers|/etc/sudoers.d/nexus-local-backup|440'; do
    IFS='|' read -r relative destination mode <<<"$spec"
    source="$active_root/$relative"
    sudo test -f "$source" && sudo test ! -L "$source" \
      || die "immutable local-backup source is unsafe: $relative"
    sudo test -f "$destination" && sudo test ! -L "$destination" \
      && test "$(sudo stat -Lc '%U:%G:%a:%h' -- "$destination")" = \
        "root:root:$mode:1" \
      || die "installed local-backup asset metadata is unsafe: $destination"
    sudo cmp -s -- "$source" "$destination" \
      || die "installed local-backup asset differs from immutable source: $destination"
  done
  sudo visudo -cf /etc/sudoers.d/nexus-local-backup >/dev/null \
    || die 'installed local-backup sudoers policy is invalid'
  sudo systemctl daemon-reload
  for unit in nexus-local-backup.service nexus-local-backup.timer \
    nexus-local-backup-pre-promotion.service \
    nexus-local-backup-restore-verify.service \
    nexus-local-backup-restore-verify.timer; do
    load="$(sudo systemctl show "$unit" --property=LoadState --value)"
    fragment="$(sudo systemctl show "$unit" --property=FragmentPath --value)"
    dropins="$(sudo systemctl show "$unit" --property=DropInPaths --value)"
    test "$load" = loaded \
      && test "$fragment" = "/etc/systemd/system/$unit" \
      && test -z "$dropins" \
      || die "$unit does not resolve to its exact installed bytes"
  done
  test "$(sudo systemctl show nexus-local-backup-pre-promotion.service \
    --property=Type --value)" = oneshot \
    || die 'pre-promotion backup unit is not Type=oneshot'
  exec_start="$(sudo systemctl show nexus-local-backup-pre-promotion.service \
    --property=ExecStart --value)"
  case "$exec_start" in
    *'path=/usr/local/libexec/nexus-local-backup/local-backup.py ; argv[]=/usr/local/libexec/nexus-local-backup/local-backup.py pre-promotion ;'*) ;;
    *) die 'pre-promotion backup unit has an unexpected effective ExecStart' ;;
  esac
}

wait_for_all_pm2_health() {
  local curl_max deadline endpoint iteration_ok remaining
  local -a endpoints=(
    http://127.0.0.1:8200/health
    http://127.0.0.1:8100/health
    http://127.0.0.1:8201/health
    http://127.0.0.1:8101/health
  )
  deadline=$((SECONDS + 120))
  while test "$SECONDS" -lt "$deadline"; do
    iteration_ok=1
    for endpoint in "${endpoints[@]}"; do
      remaining=$((deadline - SECONDS))
      if test "$remaining" -le 0; then
        iteration_ok=0
        break
      fi
      curl_max=3
      if test "$remaining" -lt "$curl_max"; then curl_max="$remaining"; fi
      if ! curl --fail --silent --show-error --connect-timeout 1 \
          --max-time "$curl_max" "$endpoint" >/dev/null; then
        iteration_ok=0
        break
      fi
    done
    test "$iteration_ok" -eq 1 && return 0
    remaining=$((deadline - SECONDS))
    test "$remaining" -gt 0 || break
    sleep 1
  done
  return 1
}

fresh_backup_for() {
  require_local_backup_installation
  local completed_ms expected producer_started_ms receipt requested_ms
  expected="$1"
  # Root-owned SQLite evidence reads may recreate empty WAL/SHM files. Prove
  # them stale and remove them at the final quiesced boundary before the
  # descriptor-bound backup producer opens the configured database.
  remove_proven_stale_wal_sidecars "$expected"
  require_no_sqlite_sidecars "$expected"
  receipt=/srv/nexus-backups/application/state/last-success.json
  requested_ms="$(date +%s%3N)"
  sudo systemctl start nexus-local-backup-pre-promotion.service
  test "$(sudo systemctl show nexus-local-backup-pre-promotion.service \
    --property=Result --value)" = success || die 'governed backup unit failed'
  sudo test -f "$receipt" || die 'governed backup receipt is missing'
  sudo jq -e --arg expectedDatabase "$expected" \
    '.schema == "nexus.local-backup.v1"
     and .status == "passed"
     and .kind == "pre-promotion"
     and .backupRoot == "/srv/nexus-backups/application"
     and .database == $expectedDatabase
     and (.encryptedSha256 | test("^[0-9a-f]{64}$"))
     and (.encryptedSizeBytes | type == "number" and . > 0 and floor == .)
     and (.startedAt | type == "string")
     and (.completedAt | type == "string")' "$receipt" >/dev/null \
    || die "backup receipt contract failed (wanted $expected)"
  producer_started_ms="$(date -d "$(sudo jq -er .startedAt "$receipt")" +%s%3N)"
  completed_ms="$(date -d "$(sudo jq -er .completedAt "$receipt")" +%s%3N)"
  test "$producer_started_ms" -ge "$requested_ms" \
    || die 'backup producer predates this invocation'
  test "$completed_ms" -ge "$producer_started_ms" \
    || die 'backup completed before its producer started'
}

PM2_GUARD_ROOT=/etc/systemd/system.control
PM2_CANONICAL_UNIT_ROOT=/etc/systemd/system

pm2_guard_path() {
  case "$1" in
    pm2-dominguez.service|nexus-release-pm2-recovery-daemon.service)
      printf '%s/%s\n' "$PM2_GUARD_ROOT" "$1" ;;
    *) return 64 ;;
  esac
}

pm2_guard_root_is_exact() {
  sudo test -d "$PM2_GUARD_ROOT" && sudo test ! -L "$PM2_GUARD_ROOT" \
    && test "$(sudo stat -Lc '%U:%G:%a' -- "$PM2_GUARD_ROOT")" = root:root:755
}

ensure_pm2_guard_root() {
  if ! sudo test -e "$PM2_GUARD_ROOT" && ! sudo test -L "$PM2_GUARD_ROOT"; then
    sudo install -d -o root -g root -m 755 -- "$PM2_GUARD_ROOT" || return 1
  fi
  pm2_guard_root_is_exact
}

install_pm2_guard() {
  local guard unit
  unit="$1"; guard="$(pm2_guard_path "$unit")" || return 1
  ensure_pm2_guard_root || return 1
  if sudo test -e "$guard" || sudo test -L "$guard"; then
    sudo test -L "$guard" || return 1
  else
    sudo ln -s -- /dev/null "$guard" || return 1
  fi
  test "$(sudo readlink -- "$guard")" = /dev/null \
    && test "$(sudo stat -c '%U:%G:%F' -- "$guard")" = \
      'root:root:symbolic link'
}

pm2_guard_is_exact() {
  local active can_start fragment guard load unit
  unit="$1"; guard="$(pm2_guard_path "$unit")" || return 1
  pm2_guard_root_is_exact || return 1
  sudo test -L "$guard" \
    && test "$(sudo readlink -- "$guard")" = /dev/null \
    && test "$(sudo stat -c '%U:%G:%F' -- "$guard")" = \
      'root:root:symbolic link' || return 1
  load="$(sudo systemctl show "$unit" --property=LoadState --value)" \
    || return 1
  fragment="$(sudo systemctl show "$unit" --property=FragmentPath --value)" \
    || return 1
  can_start="$(sudo systemctl show "$unit" --property=CanStart --value)" \
    || return 1
  active="$(sudo systemctl show "$unit" --property=ActiveState --value)" \
    || return 1
  test "$load" = masked && test "$fragment" = "$guard" \
    && test "$can_start" = no && test "$active" = inactive
}

require_pm2_guard() {
  local unit
  for unit in pm2-dominguez.service nexus-release-pm2-recovery-daemon.service; do
    pm2_guard_is_exact "$unit" \
      || die "$unit is not protected by its exact high-priority runtime guard"
  done
}

pm2_fail_closed_is_exact() {
  local database handles listeners lsof_status path pgrep_status port suffix unit
  for unit in pm2-dominguez.service nexus-release-pm2-recovery-daemon.service; do
    pm2_guard_is_exact "$unit" || return 1
  done
  if sudo pgrep -u dominguez -f 'PM2.*God Daemon' >/dev/null; then
    return 1
  else
    pgrep_status=$?
  fi
  test "$pgrep_status" -eq 1 || return 1
  for port in 8100 8101 8200 8201; do
    if listeners="$(sudo lsof -nP -t -iTCP:"$port" -sTCP:LISTEN 2>&1)"; then
      return 1
    else
      lsof_status=$?
    fi
    test "$lsof_status" -eq 1 && test -z "$listeners" || return 1
  done
  for database in \
    /home/dominguez/telegram-hub-bot/data/bot.db \
    /home/dominguez/telegram-hub-bot-staging/data/bot.db \
    /home/dominguez/telegram-hub-bot/data/bot.db.next-bootstrap-recovery \
    /var/lib/nexus-hub/production/data/bot.db \
    /var/lib/nexus-hub/production/data/bot.db.next \
    /var/lib/nexus-hub/staging/data/bot.db \
    /var/lib/nexus-hub/staging/data/bot.db.next; do
    for suffix in '' -wal -shm -journal; do
      path="$database$suffix"
      if sudo test -e "$path" || sudo test -L "$path"; then
        if handles="$(sudo lsof -nP -t -- "$path" 2>&1)"; then
          return 1
        else
          lsof_status=$?
        fi
        test "$lsof_status" -eq 1 && test -z "$handles" || return 1
      fi
    done
  done
}

enforce_pm2_fail_closed() {
  local action_failed=0 unit
  if pm2_fail_closed_is_exact; then
    return 0
  fi
  run_pm2_as_dominguez stop \
    nexus-hub content-engine nexus-hub-staging content-engine-staging \
    || action_failed=1
  for unit in pm2-dominguez.service nexus-release-pm2-recovery-daemon.service; do
    sudo systemctl disable --now "$unit" || action_failed=1
    install_pm2_guard "$unit" || action_failed=1
  done
  sudo systemctl daemon-reload || action_failed=1
  run_pm2_as_dominguez kill || action_failed=1
  if pm2_fail_closed_is_exact; then
    return 0
  fi
  printf 'PM2 fail-closed postconditions remain false (action failures: %s)\n' \
    "$action_failed" >&2
  return 1
}

retire_canonical_pm2_guard() {
  local active can_start canonical fragment guard legacy_guard load unit
  unit="$1"
  test "$unit" = pm2-dominguez.service || return 64
  guard="$(pm2_guard_path "$unit")" || return 1
  canonical="$PM2_CANONICAL_UNIT_ROOT/$unit"
  legacy_guard="/run/systemd/system/$unit"
  pm2_guard_is_exact "$unit" || return 1
  sudo test -f "$canonical" && sudo test ! -L "$canonical" \
    && test "$(sudo stat -Lc '%U:%G:%a:%h' -- "$canonical")" = \
      'root:root:644:1' || return 1
  if sudo test -e "$legacy_guard" || sudo test -L "$legacy_guard"; then
    sudo test -L "$legacy_guard" \
      && test "$(sudo readlink -- "$legacy_guard")" = /dev/null \
      && test "$(sudo stat -c '%U:%G:%F' -- "$legacy_guard")" = \
        'root:root:symbolic link' || return 1
    sudo rm -- "$legacy_guard" || return 1
  fi
  sudo rm -- "$guard" || return 1
  sudo systemctl daemon-reload || return 1
  sudo test ! -e "$guard" && sudo test ! -L "$guard" || return 1
  sudo test ! -e "$legacy_guard" && sudo test ! -L "$legacy_guard" || return 1
  load="$(sudo systemctl show "$unit" --property=LoadState --value)" \
    || return 1
  fragment="$(sudo systemctl show "$unit" --property=FragmentPath --value)" \
    || return 1
  can_start="$(sudo systemctl show "$unit" --property=CanStart --value)" \
    || return 1
  active="$(sudo systemctl show "$unit" --property=ActiveState --value)" \
    || return 1
  test "$load" = loaded && test "$fragment" = "$canonical" \
    && test "$can_start" = yes && test "$active" = inactive
}

OLD_PRODUCTION=/home/dominguez/telegram-hub-bot/data/bot.db
OLD_STAGING=/home/dominguez/telegram-hub-bot-staging/data/bot.db
PM2_PRODUCTION_BASE=/home/dominguez/telegram-hub-bot
PM2_STAGING_BASE=/home/dominguez/telegram-hub-bot-staging
LIVE_PRODUCTION=/var/lib/nexus-hub/production/data/bot.db
LIVE_STAGING=/var/lib/nexus-hub/staging/data/bot.db
BASELINE_FILE=/var/lib/nexus-release/state/bootstrap-baseline.json
RUNTIME_EVIDENCE=/var/lib/nexus-release/state/bootstrap-legacy-runtime.json
TRANSITION_EVIDENCE=/var/lib/nexus-release/state/bootstrap-database-transition.json
USER_RELEASE_LOCK=/home/dominguez/.local/state/nexus-release/.release.lock
MAINTENANCE_LOCK=/run/lock/nexus-release-sonar.lock
BACKUP_ENV=/etc/nexus-local-backup/backup.env
: "${PRE_BASELINE_ACTION:?set recover-pm2, resume-baseline, or reset-cutover explicitly}"
case "$PRE_BASELINE_ACTION" in
  recover-pm2|resume-baseline|reset-cutover) ;;
  *) die 'PRE_BASELINE_ACTION must be recover-pm2, resume-baseline, or reset-cutover' ;;
esac
sudo test ! -e "$BASELINE_FILE" && sudo test ! -L "$BASELINE_FILE" \
  || die 'bootstrap baseline exists; use the baseline-dependent recovery branch'

test "$(sudo stat -Lc '%U:%G:%a:%h' -- "$RUNTIME_EVIDENCE")" \
  = 'root:root:600:1' || die 'legacy runtime capture owner, mode, or links are unsafe'
sudo test ! -L "$RUNTIME_EVIDENCE" || die 'legacy runtime capture is symbolic'
sudo jq -e \
  '.schema == "nexus.bootstrap-legacy-runtime-capture.v2"
   and (.createdAt | test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$"))
   and (.productionSourceSha | test("^[0-9a-f]{40}$"))
   and (.stagingSourceSha | test("^[0-9a-f]{40}$"))
   and (.productionArtifactDigest | test("^[0-9a-f]{64}$"))
   and (.stagingArtifactDigest | test("^[0-9a-f]{64}$"))
   and (.productionMarkerSha256 | test("^[0-9a-f]{64}$"))
   and (.stagingMarkerSha256 | test("^[0-9a-f]{64}$"))
   and (.productionRuntimePath
       | startswith("/home/dominguez/telegram-hub-bot/releases/"))
   and (.stagingRuntimePath
       | startswith("/home/dominguez/telegram-hub-bot-staging/releases/"))
   and (.productionDatabaseIdentity | test("^[0-9]+:[0-9]+$"))
   and (.stagingDatabaseIdentity | test("^[0-9]+:[0-9]+$"))
   and (keys | sort == ["createdAt","productionArtifactDigest",
     "productionDatabaseIdentity","productionMarkerSha256",
     "productionRuntimePath","productionSourceSha","schema",
     "stagingArtifactDigest","stagingDatabaseIdentity","stagingMarkerSha256",
     "stagingRuntimePath","stagingSourceSha"])' "$RUNTIME_EVIDENCE" >/dev/null \
  || die 'legacy runtime capture is invalid'
PRODUCTION_SHA="$(sudo jq -er .productionSourceSha "$RUNTIME_EVIDENCE")"
STAGING_SHA="$(sudo jq -er .stagingSourceSha "$RUNTIME_EVIDENCE")"
PRODUCTION_ARTIFACT_DIGEST="$(sudo jq -er \
  .productionArtifactDigest "$RUNTIME_EVIDENCE")"
STAGING_ARTIFACT_DIGEST="$(sudo jq -er \
  .stagingArtifactDigest "$RUNTIME_EVIDENCE")"
PRODUCTION_RUNTIME="$(sudo jq -er .productionRuntimePath "$RUNTIME_EVIDENCE")"
STAGING_RUNTIME="$(sudo jq -er .stagingRuntimePath "$RUNTIME_EVIDENCE")"
PRODUCTION_DATABASE_IDENTITY="$(sudo jq -er \
  .productionDatabaseIdentity "$RUNTIME_EVIDENCE")"
STAGING_DATABASE_IDENTITY="$(sudo jq -er \
  .stagingDatabaseIdentity "$RUNTIME_EVIDENCE")"

for ROLE in production staging; do
  if test "$ROLE" = production; then
    LEGACY_BASE="$PM2_PRODUCTION_BASE"
    EXPECTED_RUNTIME="$PRODUCTION_RUNTIME"
    EXPECTED_SHA="$PRODUCTION_SHA"
    EXPECTED_ARTIFACT="$PRODUCTION_ARTIFACT_DIGEST"
    EXPECTED_MARKER_SHA="$(sudo jq -er \
      .productionMarkerSha256 "$RUNTIME_EVIDENCE")"
  else
    LEGACY_BASE="$PM2_STAGING_BASE"
    EXPECTED_RUNTIME="$STAGING_RUNTIME"
    EXPECTED_SHA="$STAGING_SHA"
    EXPECTED_ARTIFACT="$STAGING_ARTIFACT_DIGEST"
    EXPECTED_MARKER_SHA="$(sudo jq -er \
      .stagingMarkerSha256 "$RUNTIME_EVIDENCE")"
  fi
  sudo test -L "$LEGACY_BASE/current" \
    || die "$ROLE legacy current selector is not symbolic"
  test "$(sudo readlink -f -- "$LEGACY_BASE/current")" = "$EXPECTED_RUNTIME" \
    || die "$ROLE legacy current selector changed after capture"
  sudo test -f "$EXPECTED_RUNTIME/.complete.json" \
    && sudo test ! -L "$EXPECTED_RUNTIME/.complete.json" \
    || die "$ROLE legacy runtime marker is missing or symbolic"
  test "$(sudo sha256sum "$EXPECTED_RUNTIME/.complete.json" | awk '{print $1}')" \
    = "$EXPECTED_MARKER_SHA" || die "$ROLE legacy runtime marker changed after capture"
  sudo jq -e --arg sha "$EXPECTED_SHA" --arg artifact "$EXPECTED_ARTIFACT" \
    '.schema == "nexus.release-bundle.v1"
     and .runtimeSha == $sha and .artifactDigest == $artifact' \
    "$EXPECTED_RUNTIME/.complete.json" >/dev/null \
    || die "$ROLE legacy runtime marker does not match the capture"
done

test "$(sudo stat -c '%U:%G:%a' -- "$USER_RELEASE_LOCK")" \
  = 'dominguez:dominguez:600' || die 'user release lock is unsafe'
test "$(sudo stat -c '%U:%G:%a' -- "$MAINTENANCE_LOCK")" \
  = 'root:dominguez:660' || die 'shared maintenance mutex is unsafe'
test ! -L "$USER_RELEASE_LOCK" && test ! -L "$MAINTENANCE_LOCK" \
  || die 'a release mutex is symbolic'
exec 9<>"$USER_RELEASE_LOCK"
flock -n 9 || die 'another PM2 release or capability transaction is active'
exec 8<>"$MAINTENANCE_LOCK"
flock -n 8 || die 'another root maintenance or container release is active'

# Arm fail-closed cleanup before inspecting or quiescing any possibly active
# PM2 authority. A signal during `pm2 jlist` or the first quiescence attempt
# must retry exact closure rather than leave a partially active daemon.
PM2_RESTART_ARMED=1
fail_closed_pm2_restart() {
  local status=$?
  trap - EXIT HUP INT TERM
  if test "$status" -ne 0 && test "$PM2_RESTART_ARMED" -eq 1; then
    if ! enforce_pm2_fail_closed; then
      printf 'FATAL: PM2 restart cleanup could not prove fail-closed postconditions\n' >&2
      exit 70
    fi
  fi
  exit "$status"
}
trap fail_closed_pm2_restart EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

# If section 1b failed in `pm2 stop` itself, finish quiescing only after every
# still-visible PM2 row is proven to match the immutable capture. High-priority
# persistent control guards are re-proved on every retry, so inactive authorities
# are disabled and re-guarded without invoking `pm2`; `pm2 jlist` is allowed only when a service
# authority or the already-running PM2 daemon proves that the user daemon is
# active.
PM2_ALREADY_GUARDED=1
PM2_AUTHORITY_OR_DAEMON_ACTIVE=0
for UNIT in pm2-dominguez.service nexus-release-pm2-recovery-daemon.service; do
  if ACTIVE_STATE="$(sudo systemctl is-active "$UNIT" 2>&1)"; then
    ACTIVE_STATUS=0
  else
    ACTIVE_STATUS=$?
  fi
  case "$ACTIVE_STATE" in
    active) PM2_AUTHORITY_OR_DAEMON_ACTIVE=1 ;;
    inactive) test "$ACTIVE_STATUS" -ne 0 \
      || die "$UNIT returned an inconsistent inactive state" ;;
    *) die "$UNIT has an unsafe active state: $ACTIVE_STATE" ;;
  esac
  if ! pm2_guard_is_exact "$UNIT" || test "$ACTIVE_STATE" != inactive; then
    PM2_ALREADY_GUARDED=0
  fi
done
if sudo pgrep -u dominguez -f 'PM2.*God Daemon' >/dev/null; then
  PM2_AUTHORITY_OR_DAEMON_ACTIVE=1
  PM2_ALREADY_GUARDED=0
else
  PGREP_STATUS=$?
  test "$PGREP_STATUS" -eq 1 \
    || die "PM2 daemon process probe failed with status $PGREP_STATUS"
fi
PM2_CAPTURE_IDENTITY_PROVED=1
if test "$PM2_ALREADY_GUARDED" -eq 0; then
  if test "$PM2_AUTHORITY_OR_DAEMON_ACTIVE" -eq 1; then
    if PM2_JSON="$(run_pm2_as_dominguez jlist)" \
        && jq -e 'length == 4
          and ([.[].name] | sort == ["content-engine","content-engine-staging",
            "nexus-hub","nexus-hub-staging"])' <<<"$PM2_JSON" >/dev/null; then
      :
    else
      PM2_CAPTURE_IDENTITY_PROVED=0
      PM2_JSON='[]'
    fi
    for APP in nexus-hub content-engine nexus-hub-staging content-engine-staging; do
      case "$APP" in
        nexus-hub)
          EXPECTED_RUNTIME="$PRODUCTION_RUNTIME"
          EXPECTED_CWD="$PRODUCTION_RUNTIME"
          EXPECTED_EXEC="$PRODUCTION_RUNTIME/dist/index.js"
          EXPECTED_SHA="$PRODUCTION_SHA"
          EXPECTED_ARTIFACT="$PRODUCTION_ARTIFACT_DIGEST"
          EXPECTED_ROLE=production
          EXPECTED_BASE="$PM2_PRODUCTION_BASE"
          EXPECTED_DATABASE="$OLD_PRODUCTION"
          ;;
        content-engine)
          EXPECTED_RUNTIME="$PRODUCTION_RUNTIME"
          EXPECTED_CWD="$PRODUCTION_RUNTIME/content-engine"
          EXPECTED_EXEC=/usr/bin/python3.12
          EXPECTED_SHA="$PRODUCTION_SHA"
          EXPECTED_ARTIFACT="$PRODUCTION_ARTIFACT_DIGEST"
          EXPECTED_ROLE=production
          EXPECTED_BASE="$PM2_PRODUCTION_BASE"
          EXPECTED_DATABASE=''
          ;;
        nexus-hub-staging)
          EXPECTED_RUNTIME="$STAGING_RUNTIME"
          EXPECTED_CWD="$STAGING_RUNTIME"
          EXPECTED_EXEC="$STAGING_RUNTIME/dist/index.js"
          EXPECTED_SHA="$STAGING_SHA"
          EXPECTED_ARTIFACT="$STAGING_ARTIFACT_DIGEST"
          EXPECTED_ROLE=staging
          EXPECTED_BASE="$PM2_STAGING_BASE"
          EXPECTED_DATABASE="$OLD_STAGING"
          ;;
        content-engine-staging)
          EXPECTED_RUNTIME="$STAGING_RUNTIME"
          EXPECTED_CWD="$STAGING_RUNTIME/content-engine"
          EXPECTED_EXEC=/usr/bin/python3.12
          EXPECTED_SHA="$STAGING_SHA"
          EXPECTED_ARTIFACT="$STAGING_ARTIFACT_DIGEST"
          EXPECTED_ROLE=staging
          EXPECTED_BASE="$PM2_STAGING_BASE"
          EXPECTED_DATABASE=''
          ;;
      esac
      if ! ROW="$(jq -ce --arg app "$APP" \
        '[.[] | select(.name == $app)]
         | if length == 1 then .[0] else error("PM2 identity is ambiguous") end' \
        <<<"$PM2_JSON")"; then
        PM2_CAPTURE_IDENTITY_PROVED=0
        continue
      fi
      if ! jq -e --arg sha "$EXPECTED_SHA" --arg artifact "$EXPECTED_ARTIFACT" \
          --arg cwd "$EXPECTED_CWD" --arg executable "$EXPECTED_EXEC" \
          --arg role "$EXPECTED_ROLE" --arg base "$EXPECTED_BASE" \
          --arg database "$EXPECTED_DATABASE" \
          '((.pm2_env.status == "stopped")
             or (.pm2_env.status == "online"
               and (.pid | type == "number" and . > 0)))
           and (.pm2_env.NEXUS_RELEASE_SHA // .pm2_env.GIT_COMMIT) == $sha
           and .pm2_env.NEXUS_RELEASE_ARTIFACT_SHA256 == $artifact
           and .pm2_env.pm_cwd == $cwd
           and .pm2_env.pm_exec_path == $executable
           and .pm2_env.NEXUS_RELEASE_ROLE == $role
           and .pm2_env.NEXUS_RELEASE_BASE_DIR == $base
           and ($database == "" or .pm2_env.DATABASE_PATH == $database)' \
          <<<"$ROW" >/dev/null; then
        PM2_CAPTURE_IDENTITY_PROVED=0
      fi
    done
  fi
  # Quiescence is unconditional: a partial or mismatched active identity must
  # never escape through an early assertion before both authorities are guarded.
  enforce_pm2_fail_closed \
    || die 'PM2 fail-closed quiescence could not prove every postcondition'
fi
require_pm2_guard
if sudo pgrep -u dominguez -f 'PM2.*God Daemon' >/dev/null; then
  die 'PM2 daemon remains after fail-closed quiescence'
else
  PGREP_STATUS=$?
  test "$PGREP_STATUS" -eq 1 \
    || die "post-quiescence PM2 daemon probe failed with status $PGREP_STATUS"
fi
test "$PM2_CAPTURE_IDENTITY_PROVED" -eq 1 \
  || die 'active PM2 identity mismatched the capture; authorities are now guarded; rerun recovery'

for PROJECT in nexus-production nexus-staging; do
  test -z "$(sudo docker ps -aq \
    --filter "label=com.docker.compose.project=$PROJECT")" \
    || die "$PROJECT has containers before a bootstrap baseline exists"
done
for PORT in 8100 8101 8200 8201; do
  test -z "$(sudo lsof -nP -t -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null)" \
    || die "legacy listener remains on port $PORT"
done

remove_proven_stale_wal_sidecars "$OLD_PRODUCTION" "$OLD_STAGING"
require_canonical_database "$OLD_PRODUCTION" "$PRODUCTION_DATABASE_IDENTITY"
require_canonical_database "$OLD_STAGING" "$STAGING_DATABASE_IDENTITY"
PRODUCTION_LOGICAL_SHA="$(logical_digest "$OLD_PRODUCTION")"
STAGING_LOGICAL_SHA="$(logical_digest "$OLD_STAGING")"

TRANSITION_COMPLETE=0
if sudo test -e "$TRANSITION_EVIDENCE" || sudo test -L "$TRANSITION_EVIDENCE"; then
  sudo test ! -L "$TRANSITION_EVIDENCE" \
    || die 'database transition evidence is symbolic'
  test "$(sudo stat -Lc '%U:%G:%a:%h' -- "$TRANSITION_EVIDENCE")" \
    = 'root:root:600:1' || die 'database transition evidence is unsafe'
  RUNTIME_CAPTURE_SHA256="$(sudo sha256sum "$RUNTIME_EVIDENCE" | awk '{print $1}')"
  sudo jq -e --arg capture "$RUNTIME_CAPTURE_SHA256" \
    --arg productionIdentity "$PRODUCTION_DATABASE_IDENTITY" \
    --arg productionDigest "$PRODUCTION_LOGICAL_SHA" \
    --arg stagingIdentity "$STAGING_DATABASE_IDENTITY" \
    --arg stagingDigest "$STAGING_LOGICAL_SHA" \
    '.schema == "nexus.bootstrap-database-transition.v1"
     and .runtimeCaptureSha256 == $capture
     and .legacy.production.path == "/home/dominguez/telegram-hub-bot/data/bot.db"
     and .legacy.production.identity == $productionIdentity
     and .legacy.production.logicalDigest == $productionDigest
     and .legacy.staging.path == "/home/dominguez/telegram-hub-bot-staging/data/bot.db"
     and .legacy.staging.identity == $stagingIdentity
     and .legacy.staging.logicalDigest == $stagingDigest
     and .target.production.path == "/var/lib/nexus-hub/production/data/bot.db"
     and .target.staging.path == "/var/lib/nexus-hub/staging/data/bot.db"
     and .backupDatabasePath == "/var/lib/nexus-hub/production/data/bot.db"' \
    "$TRANSITION_EVIDENCE" >/dev/null \
    || die 'database transition checkpoint does not match untouched legacy data'
  TRANSITION_COMPLETE=1
fi

for TARGET in "$LIVE_PRODUCTION" "$LIVE_PRODUCTION.next" \
  "$LIVE_STAGING" "$LIVE_STAGING.next"; do
  if sudo test -e "$TARGET" || sudo test -L "$TARGET"; then
    if test "$PRE_BASELINE_ACTION" != resume-baseline; then
      printf 'preserving container target in place for incident review: %s\n' "$TARGET"
      continue
    fi
    case "$TARGET" in
      "$LIVE_PRODUCTION"|"$LIVE_PRODUCTION.next") SOURCE_SHA="$PRODUCTION_LOGICAL_SHA" ;;
      *) SOURCE_SHA="$STAGING_LOGICAL_SHA" ;;
    esac
    remove_proven_stale_wal_sidecars "$TARGET"
    require_canonical_database "$TARGET"
    test "$(logical_digest "$TARGET")" = "$SOURCE_SHA" \
      || die "target may contain newer or divergent data; preserved untouched: $TARGET"
  fi
done

sudo test -f "$BACKUP_ENV" && sudo test ! -L "$BACKUP_ENV" \
  || die 'backup environment is missing or symbolic'
test "$(sudo stat -Lc '%U:%G:%a:%h' -- "$BACKUP_ENV")" = 'root:root:600:1' \
  || die 'backup environment owner, mode, or link count is unsafe'
test "$(sudo awk -F= \
  '$1 == "NEXUS_LOCAL_BACKUP_DATABASE_PATH" { count += 1 } END { print count + 0 }' \
  "$BACKUP_ENV")" = 1 || die 'backup database path is absent or duplicated'
CURRENT_BACKUP_DATABASE="$(sudo awk -F= \
  '$1 == "NEXUS_LOCAL_BACKUP_DATABASE_PATH" { print substr($0, index($0, "=") + 1) }' \
  "$BACKUP_ENV")"
case "$CURRENT_BACKUP_DATABASE" in
  "$OLD_PRODUCTION"|"$LIVE_PRODUCTION") ;;
  *) die 'backup database path is outside the pre-baseline transaction' ;;
esac

# Both actions require an executable captured fallback, not a marker-only
# match. These checks run while both release locks and the PM2 guard are held;
# resume is not allowed to bypass them.
test "$(sudo readlink -f -- "$PM2_PRODUCTION_BASE/current")" \
  = "$PRODUCTION_RUNTIME" || die 'production runtime selector changed under lock'
test "$(sudo readlink -f -- "$PM2_STAGING_BASE/current")" \
  = "$STAGING_RUNTIME" || die 'staging runtime selector changed under lock'
verify_installed_runtime \
  "$PRODUCTION_RUNTIME" "$PRODUCTION_SHA" "$PRODUCTION_ARTIFACT_DIGEST" \
  || die 'production installed runtime tree does not match the capture'
verify_installed_runtime \
  "$STAGING_RUNTIME" "$STAGING_SHA" "$STAGING_ARTIFACT_DIGEST" \
  || die 'staging installed runtime tree does not match the capture'

RESET_CUTOVER=0
if test "$PRE_BASELINE_ACTION" = reset-cutover; then
  RESET_CUTOVER=1
  STAMP="$(date -u +%Y%m%dT%H%M%SZ)-$BASHPID"
  INCIDENT_DIR="/var/lib/nexus-release/incidents/pre-baseline-reset/$STAMP"
  sudo install -d -o root -g root -m 700 \
    /var/lib/nexus-release/incidents \
    /var/lib/nexus-release/incidents/pre-baseline-reset
  sudo test ! -e "$INCIDENT_DIR" && sudo test ! -L "$INCIDENT_DIR" \
    || die 'reset incident evidence directory already exists'
  sudo mkdir "$INCIDENT_DIR"
  sudo chown root:root "$INCIDENT_DIR"; sudo chmod 700 "$INCIDENT_DIR"

  # Make the governed backup independent of the targets before preserving and
  # retiring them. The legacy inode is still the exact captured authority.
  if test "$CURRENT_BACKUP_DATABASE" = "$LIVE_PRODUCTION"; then
    sudo sed -i \
      "s#^NEXUS_LOCAL_BACKUP_DATABASE_PATH=.*#NEXUS_LOCAL_BACKUP_DATABASE_PATH=$OLD_PRODUCTION#" \
      "$BACKUP_ENV"
    CURRENT_BACKUP_DATABASE="$OLD_PRODUCTION"
  fi
  test "$CURRENT_BACKUP_DATABASE" = "$OLD_PRODUCTION" \
    || die 'reset backup path did not settle on captured legacy production'
  fresh_backup_for "$OLD_PRODUCTION"
  remove_proven_stale_wal_sidecars "$OLD_PRODUCTION" "$OLD_STAGING"

  for SPEC in "$(dirname "$LIVE_PRODUCTION"):$INCIDENT_DIR/production-data" \
    "$(dirname "$LIVE_STAGING"):$INCIDENT_DIR/staging-data"; do
    SOURCE_DIR="${SPEC%%:*}"; ARCHIVE_DIR="${SPEC#*:}"
    sudo test -d "$SOURCE_DIR" && sudo test ! -L "$SOURCE_DIR" \
      || die "governed data directory is missing or symbolic: $SOURCE_DIR"
    test -z "$(sudo find "$SOURCE_DIR" -xdev -type l -print -quit)" \
      || die "governed data directory contains a symbolic link: $SOURCE_DIR"
    RESET_LSOF_ERROR="$(mktemp)"
    if RESET_HANDLES="$(sudo lsof -t +D "$SOURCE_DIR" 2>"$RESET_LSOF_ERROR")"; then
      RESET_LSOF_STATUS=0
    else
      RESET_LSOF_STATUS=$?
    fi
    if test -s "$RESET_LSOF_ERROR"; then
      sed 's/^/lsof: /' "$RESET_LSOF_ERROR" >&2
      rm -f "$RESET_LSOF_ERROR"
      die "governed directory handle probe failed: $SOURCE_DIR"
    fi
    rm -f "$RESET_LSOF_ERROR"
    test "$RESET_LSOF_STATUS" -eq 1 && test -z "$RESET_HANDLES" \
      || die "governed directory has handles or an uncertain probe: $SOURCE_DIR"
    sudo cp -a --reflink=auto -- "$SOURCE_DIR" "$ARCHIVE_DIR"
    sudo diff -qr --no-dereference "$SOURCE_DIR" "$ARCHIVE_DIR" >/dev/null \
      || die "reset archive differs from governed data: $SOURCE_DIR"
  done
  sudo sync -f "$INCIDENT_DIR"

  if sudo test -e "$TRANSITION_EVIDENCE" || sudo test -L "$TRANSITION_EVIDENCE"; then
    sudo test -f "$TRANSITION_EVIDENCE" && sudo test ! -L "$TRANSITION_EVIDENCE" \
      || die 'transition checkpoint is unsafe before retirement'
    RETIRED_TRANSITION="$INCIDENT_DIR/bootstrap-database-transition.json"
    sudo install -o root -g root -m 600 \
      "$TRANSITION_EVIDENCE" "$RETIRED_TRANSITION"
    sudo cmp -s -- "$TRANSITION_EVIDENCE" "$RETIRED_TRANSITION" \
      || die 'retired transition archive differs from canonical evidence'
    sudo sync -f "$INCIDENT_DIR"
    sudo rm -- "$TRANSITION_EVIDENCE"
    sudo sync -f "$(dirname "$TRANSITION_EVIDENCE")"
  fi
  for BASE in "$LIVE_PRODUCTION" "$LIVE_STAGING"; do
    for TARGET in "$BASE" "$BASE-wal" "$BASE-shm" "$BASE-journal" \
      "$BASE.next" "$BASE.next-wal" "$BASE.next-shm" "$BASE.next-journal"; do
      if sudo test -e "$TARGET" || sudo test -L "$TARGET"; then
        sudo test -f "$TARGET" && sudo test ! -L "$TARGET" \
          || die "archived reset target is not a regular file: $TARGET"
        sudo rm -- "$TARGET"
      fi
    done
  done
  sudo test ! -e "$LIVE_PRODUCTION" && sudo test ! -L "$LIVE_PRODUCTION" \
    && sudo test ! -e "$LIVE_PRODUCTION.next" \
    && sudo test ! -L "$LIVE_PRODUCTION.next" \
    && sudo test ! -e "$LIVE_STAGING" && sudo test ! -L "$LIVE_STAGING" \
    && sudo test ! -e "$LIVE_STAGING.next" && sudo test ! -L "$LIVE_STAGING.next" \
    || die 'reset did not clear all section 1b target paths'
fi

if test "$PRE_BASELINE_ACTION" = resume-baseline; then
  test "$TRANSITION_COMPLETE" -eq 1 \
    || die 'resume requires the completed database-transition checkpoint'
  sudo test -f "$LIVE_PRODUCTION" && sudo test -f "$LIVE_STAGING" \
    || die 'resume requires both completed container targets'
  sudo test ! -e "$LIVE_PRODUCTION.next" && sudo test ! -L "$LIVE_PRODUCTION.next" \
    || die 'production temporary target remains'
  sudo test ! -e "$LIVE_STAGING.next" && sudo test ! -L "$LIVE_STAGING.next" \
    || die 'staging temporary target remains'
  test "$(sudo stat -Lc '%d:%i' -- "$LIVE_PRODUCTION")" \
    = "$(sudo jq -er .target.production.identity "$TRANSITION_EVIDENCE")" \
    || die 'production target identity changed after transition checkpoint'
  test "$(sudo stat -Lc '%d:%i' -- "$LIVE_STAGING")" \
    = "$(sudo jq -er .target.staging.identity "$TRANSITION_EVIDENCE")" \
    || die 'staging target identity changed after transition checkpoint'
  test "$(logical_digest "$LIVE_PRODUCTION")" \
    = "$(sudo jq -er .target.production.logicalDigest "$TRANSITION_EVIDENCE")" \
    || die 'production target changed after transition checkpoint'
  test "$(logical_digest "$LIVE_STAGING")" \
    = "$(sudo jq -er .target.staging.logicalDigest "$TRANSITION_EVIDENCE")" \
    || die 'staging target changed after transition checkpoint'
  test "$(sudo stat -Lc '%d:%i' -- "$LIVE_PRODUCTION")" != \
    "$(sudo stat -Lc '%d:%i' -- "$LIVE_STAGING")" \
    || die 'production and staging targets share one inode'
  test "$CURRENT_BACKUP_DATABASE" = "$LIVE_PRODUCTION" \
    || die 'completed transition checkpoint requires backup bound to container production'
  fresh_backup_for "$LIVE_PRODUCTION"
  remove_proven_stale_wal_sidecars "$LIVE_PRODUCTION" "$LIVE_STAGING"
  require_pm2_guard
  pm2_fail_closed_is_exact \
    || die 'pre-baseline checkpoint exit is not exactly fail-closed'
  PM2_RESTART_ARMED=0
  trap - EXIT HUP INT TERM
  printf 'pre-baseline transition checkpoint is current; continue with section 3a\n'
  exit 0
fi

# `recover-pm2` never replaces, moves, or removes container target data.
# Divergent or partial remnants stay offline in place for incident review while
# PM2 resumes only against the captured legacy paths. `reset-cutover` is the
# separately explicit, archive-first re-entry action above.
if test "$CURRENT_BACKUP_DATABASE" = "$LIVE_PRODUCTION"; then
  sudo sed -i \
    "s#^NEXUS_LOCAL_BACKUP_DATABASE_PATH=.*#NEXUS_LOCAL_BACKUP_DATABASE_PATH=$OLD_PRODUCTION#" \
    "$BACKUP_ENV"
fi
test "$(sudo awk -F= \
  '$1 == "NEXUS_LOCAL_BACKUP_DATABASE_PATH" { print substr($0, index($0, "=") + 1) }' \
  "$BACKUP_ENV")" = "$OLD_PRODUCTION" \
  || die 'backup environment did not settle on legacy production'
fresh_backup_for "$OLD_PRODUCTION"
remove_proven_stale_wal_sidecars "$OLD_PRODUCTION" "$OLD_STAGING"
require_canonical_database "$OLD_PRODUCTION" "$PRODUCTION_DATABASE_IDENTITY"
require_canonical_database "$OLD_STAGING" "$STAGING_DATABASE_IDENTITY"
remove_proven_stale_wal_sidecars "$OLD_PRODUCTION" "$OLD_STAGING"
require_no_sqlite_sidecars "$OLD_PRODUCTION" "$OLD_STAGING"

# Reassert the selected symlinks and the complete installed-tree/dependency
# attestation while both release locks and the PM2 guard are still held. A
# marker-only match is not authority to execute a tampered fallback tree.
test "$(sudo readlink -f -- "$PM2_PRODUCTION_BASE/current")" \
  = "$PRODUCTION_RUNTIME" || die 'production runtime selector changed under lock'
test "$(sudo readlink -f -- "$PM2_STAGING_BASE/current")" \
  = "$STAGING_RUNTIME" || die 'staging runtime selector changed under lock'
verify_installed_runtime \
  "$PRODUCTION_RUNTIME" "$PRODUCTION_SHA" "$PRODUCTION_ARTIFACT_DIGEST" \
  || die 'production installed runtime tree does not match the capture'
verify_installed_runtime \
  "$STAGING_RUNTIME" "$STAGING_SHA" "$STAGING_ARTIFACT_DIGEST" \
  || die 'staging installed runtime tree does not match the capture'

if test -z "${INCIDENT_DIR:-}"; then
  STAMP="$(date -u +%Y%m%dT%H%M%SZ)-$BASHPID"
  INCIDENT_DIR="/var/lib/nexus-release/incidents/pre-baseline/$STAMP"
  sudo install -d -o root -g root -m 700 \
    /var/lib/nexus-release/incidents /var/lib/nexus-release/incidents/pre-baseline
  sudo test ! -e "$INCIDENT_DIR" || die 'incident evidence directory already exists'
  sudo mkdir "$INCIDENT_DIR"
  sudo chown root:root "$INCIDENT_DIR"
  sudo chmod 700 "$INCIDENT_DIR"
fi

retire_canonical_pm2_guard pm2-dominguez.service \
  || die 'canonical PM2 high-priority runtime guard could not be retired safely'
sudo systemctl enable --now pm2-dominguez.service
run_pm2_as_dominguez start content-engine content-engine-staging
run_pm2_as_dominguez start nexus-hub nexus-hub-staging
PM2_JSON="$(run_pm2_as_dominguez jlist)"
for APP in nexus-hub content-engine nexus-hub-staging content-engine-staging; do
  case "$APP" in
    nexus-hub)
      EXPECTED_CWD="$PRODUCTION_RUNTIME"
      EXPECTED_EXEC="$PRODUCTION_RUNTIME/dist/index.js"
      EXPECTED_SHA="$PRODUCTION_SHA"
      EXPECTED_ARTIFACT="$PRODUCTION_ARTIFACT_DIGEST"
      EXPECTED_ROLE=production
      EXPECTED_BASE="$PM2_PRODUCTION_BASE"
      EXPECTED_DATABASE="$OLD_PRODUCTION"
      ;;
    content-engine)
      EXPECTED_CWD="$PRODUCTION_RUNTIME/content-engine"
      EXPECTED_EXEC=/usr/bin/python3.12
      EXPECTED_SHA="$PRODUCTION_SHA"
      EXPECTED_ARTIFACT="$PRODUCTION_ARTIFACT_DIGEST"
      EXPECTED_ROLE=production
      EXPECTED_BASE="$PM2_PRODUCTION_BASE"
      EXPECTED_DATABASE=''
      ;;
    nexus-hub-staging)
      EXPECTED_CWD="$STAGING_RUNTIME"
      EXPECTED_EXEC="$STAGING_RUNTIME/dist/index.js"
      EXPECTED_SHA="$STAGING_SHA"
      EXPECTED_ARTIFACT="$STAGING_ARTIFACT_DIGEST"
      EXPECTED_ROLE=staging
      EXPECTED_BASE="$PM2_STAGING_BASE"
      EXPECTED_DATABASE="$OLD_STAGING"
      ;;
    content-engine-staging)
      EXPECTED_CWD="$STAGING_RUNTIME/content-engine"
      EXPECTED_EXEC=/usr/bin/python3.12
      EXPECTED_SHA="$STAGING_SHA"
      EXPECTED_ARTIFACT="$STAGING_ARTIFACT_DIGEST"
      EXPECTED_ROLE=staging
      EXPECTED_BASE="$PM2_STAGING_BASE"
      EXPECTED_DATABASE=''
      ;;
  esac
  ROW="$(jq -ce --arg app "$APP" \
    '[.[] | select(.name == $app)]
     | if length == 1 then .[0] else error("PM2 identity is ambiguous") end' \
    <<<"$PM2_JSON")" || die "$APP PM2 identity is ambiguous after restart"
  test "$(jq -er .pm2_env.status <<<"$ROW")" = online \
    || die "$APP did not return online"
  test "$(jq -er '.pm2_env.NEXUS_RELEASE_SHA // .pm2_env.GIT_COMMIT' \
    <<<"$ROW")" = "$EXPECTED_SHA" || die "$APP restarted with a different source SHA"
  test "$(jq -er .pm2_env.NEXUS_RELEASE_ARTIFACT_SHA256 <<<"$ROW")" \
    = "$EXPECTED_ARTIFACT" || die "$APP restarted with a different artifact"
  test "$(jq -er .pm2_env.pm_cwd <<<"$ROW")" = "$EXPECTED_CWD" \
    || die "$APP restarted outside the recorded runtime"
  test "$(jq -er .pm2_env.pm_exec_path <<<"$ROW")" = "$EXPECTED_EXEC" \
    || die "$APP restarted with a different executable"
  test "$(jq -er .pm2_env.NEXUS_RELEASE_ROLE <<<"$ROW")" = "$EXPECTED_ROLE" \
    || die "$APP restarted with a different role"
  test "$(jq -er .pm2_env.NEXUS_RELEASE_BASE_DIR <<<"$ROW")" = "$EXPECTED_BASE" \
    || die "$APP restarted with a different base directory"
  test "$(jq -er '.pid | type == "number" and . > 0' <<<"$ROW")" = true \
    || die "$APP has no live process identity"
  if test -n "$EXPECTED_DATABASE"; then
    test "$(jq -er .pm2_env.DATABASE_PATH <<<"$ROW")" = "$EXPECTED_DATABASE" \
      || die "$APP restarted against a different database"
  fi
done
wait_for_all_pm2_health \
  || die 'PM2 restart did not make all four health endpoints ready within 120 seconds'

# Copy evidence to the incident directory without retiring either canonical
# authority. If either copy fails, both source files remain retryable and the
# armed trap returns PM2 to the guarded state.
for EVIDENCE_PAIR in \
  "$RUNTIME_EVIDENCE:$INCIDENT_DIR/bootstrap-legacy-runtime.json" \
  "$TRANSITION_EVIDENCE:$INCIDENT_DIR/bootstrap-database-transition.json"; do
  EVIDENCE_SOURCE="${EVIDENCE_PAIR%%:*}"
  EVIDENCE_DESTINATION="${EVIDENCE_PAIR#*:}"
  if sudo test -e "$EVIDENCE_SOURCE"; then
    sudo test ! -e "$EVIDENCE_DESTINATION" \
      && sudo test ! -L "$EVIDENCE_DESTINATION" \
      || die "incident evidence destination exists: $EVIDENCE_DESTINATION"
    sudo install -o root -g root -m 600 \
      "$EVIDENCE_SOURCE" "$EVIDENCE_DESTINATION"
    sudo cmp --silent "$EVIDENCE_SOURCE" "$EVIDENCE_DESTINATION" \
      || die "incident evidence copy differs: $EVIDENCE_DESTINATION"
    test "$(sudo stat -Lc '%U:%G:%a:%h' -- "$EVIDENCE_DESTINATION")" \
      = 'root:root:600:1' || die 'incident evidence copy metadata is unsafe'
  fi
done
PM2_RESTART_ARMED=0
trap - EXIT HUP INT TERM
printf 'legacy PM2 restored from exact capture; evidence: %s\n' "$INCIDENT_DIR"
```

## 2. Signing trust root

The poller trusts one pinned Ed25519 public key. Generate the pair on a trusted
machine — not on the server, and not in CI:

```bash
npm run release:cd:keygen
```

Then, following the instructions it prints:

1. store the private key as the GitHub Actions secret
   `NEXUS_RELEASE_MANIFEST_SIGNING_KEY` in the `release-publish` environment, and
   shred the local copy;
2. commit the public key to `docs/release/evidence/release-manifest-public-key.pem`;
3. prove the GitHub environment and protected-main rules below, then install the
   public key on the host.

The environment is a secret boundary, not a per-release approval step. Before
the first publication, prove it exists, admits protected branches only, has no
required reviewers, wait timer, or custom protection rule, and contains the
named secret without printing its value:

```bash
REPOSITORY=felipedrf74/cortex-telegram-hub-bot
BRANCH_RULES_JSON="$(gh api \
  -H 'Accept: application/vnd.github+json' \
  -H 'X-GitHub-Api-Version: 2022-11-28' \
  "repos/$REPOSITORY/rules/branches/main")" \
  || exit 1
printf '%s' "$BRANCH_RULES_JSON" | jq -e '
  any(.[]; .type == "pull_request")
  and any(.[]; .type == "non_fast_forward")
  and any(.[]; .type == "deletion")
  and any(.[];
    .type == "required_status_checks"
    and any(.parameters.required_status_checks[]?; .context == "🧪 Tests")
  )
' >/dev/null || {
  echo 'main must require PRs, forbid force-push/deletion, and require 🧪 Tests' >&2
  exit 1
}
ENVIRONMENT_JSON="$(gh api \
  -H 'Accept: application/vnd.github+json' \
  -H 'X-GitHub-Api-Version: 2022-11-28' \
  "repos/$REPOSITORY/environments/release-publish")" \
  || exit 1
printf '%s' "$ENVIRONMENT_JSON" | jq -e '
  .name == "release-publish"
  and .deployment_branch_policy.protected_branches == true
  and .deployment_branch_policy.custom_branch_policies == false
  and all(.protection_rules[]?; .type == "branch_policy")
' >/dev/null || {
  echo 'release-publish must have protected-branch policy and no approval/wait rule' >&2
  exit 1
}
test "$(gh secret list --repo "$REPOSITORY" --env release-publish \
  --json name --jq '[.[] | select(.name == "NEXUS_RELEASE_MANIFEST_SIGNING_KEY")] | length')" = 1 \
  || {
    echo 'release-publish signing secret is absent or duplicated' >&2
    exit 1
  }
```

Only after that proof, install the public key on the host:

```bash
sudo install -o root -g root -m 644 \
  /opt/nexus-release/checkout/docs/release/evidence/release-manifest-public-key.pem \
  /etc/nexus-release/trust/release-manifest-signing-2026-08.pem
```

Using the immutable active checkout as the source makes the host pin byte-for-byte
identical to the public key the publisher verifies before signing. Do not install
the differently named generated file directly after the committed pin exists.

The key id, repository, protected ref and workflow name the poller requires are
in `config/continuous-deployment.json > trust`. A manifest that does not match
all of them is refused.

## 2a. Manifest schema reader-first activation

Ordinary publication always pushes the signed release payload under its exact
source-SHA tag first. The publisher signature-verifies that candidate and the
current `nexus-hub-release:main` manifest, then moves `:main` only when their
signed schema generations match. `hold_generation_mismatch` or
`hold_current_unavailable` is a successful immutable publication but **not** a
pointer activation. Do not retag GHCR manually.

Initial policy adoption that keeps the existing writer generation is an
equal-generation publication and must return `move_main`. Do not dispatch the
owner activation workflow for that case: activation deliberately refuses equal
generations.

A moved pointer does not override the signed continuous-deployment verdict.
After a publication that is ineligible only because the signed manifest names
reviewed deployment-governance paths, run one attended owner authorization from
the installed exact controller checkout. The command must use the same clean
runtime environment, private registry configuration, and pinned executables as
the poller unit:

```bash
sudo /usr/bin/env -i PATH=/usr/bin:/bin \
  HOME=/var/lib/nexus-release/home \
  DOCKER_CONFIG=/etc/nexus-release/docker \
  NEXUS_RELEASE_OWNER_AUTHORIZED=1 \
  NEXUS_RELEASE_NODE_BIN=/usr/bin/node \
  NEXUS_RELEASE_GIT_BIN=/usr/bin/git \
  NEXUS_RELEASE_FLOCK_BIN=/usr/bin/flock \
  NEXUS_RELEASE_SYSTEMCTL_BIN=/usr/bin/systemctl \
  NEXUS_RELEASE_DOCKER_BIN=/usr/bin/docker \
  NEXUS_RELEASE_SQLITE_BIN=/usr/bin/sqlite3 \
  NEXUS_RELEASE_LSOF_BIN=/usr/bin/lsof \
  NEXUS_RELEASE_SCP_BIN=/usr/bin/scp \
  NEXUS_RELEASE_SSH_BIN=/usr/bin/ssh \
  /opt/nexus-release/checkout/scripts/release-poll.sh \
  --authorize-governance-only <exact-32-hex-releaseId>
```

The command is accepted only for the exact signed governance-only release with
an entirely predecessor-compatible live pending migration suffix. It records an
immutable, digest-bound authorization before staging. Exit 75 means the kernel
release mutex is already held; wait for that invocation to settle and rerun the
exact command. The attended path deliberately omits optional audit-mirror and
Telegram credentials. The timer retries durable audit-mirror obligations from
its configured environment; Telegram delivery for the attended result is
best-effort and is skipped. Never acknowledge a governance-only release merely
to bypass its signed ineligibility. The
controller-only bridge also requires exact image, Compose, migration inventory,
reconciliation, and migration up/down count equality. Publish a later non-governance,
non-control-plane successor, require `cdEligibility.eligible == true`,
`cdEligibility.predecessorCompatible == true`, `move_main`, and the same signed
`controlPlane.digest`, then use that exact successor for §1a, block
acknowledgement and one attended poll. Keep the timer disabled until the
attended poll produces a completed, provable receipt and the exact healthy
image pair.

Schema reader support must land on protected `main`, pass the exact base/head
schema-policy gate, and be installed with the attended §1a control-plane
transaction before the dedicated writer-only policy flip. The writer flip may
change only `ops/nexus-release/release-manifest-schema-policy.json` and the
generated project map. Policy v1 never removes a generation row or a candidate
or retained reader; any later retirement needs a new, separately reviewed
evidence contract.

When the automatic publisher withholds `:main`, first require all §1a journals
absent, the exact candidate selected at `/opt/nexus-release/checkout`, and its
installed fragment/interface proofs green. Compute the active immutable
controller identity locally on the server; this command prints no secret:

```bash
INSTALLED_CONTROL_PLANE_DIGEST="$(
  ssh -t ServerDominguez \
    "sudo /usr/bin/env -i PATH=/usr/bin:/bin /usr/bin/node --input-type=module -" <<'NODE'
import { pathToFileURL } from 'node:url';
const root = '/opt/nexus-release/checkout';
const module = await import(pathToFileURL(
  `${root}/scripts/lib/release-control-plane.mjs`,
));
const identity = module.computeReleaseControlPlaneIdentity(root, {
  runtimeVersion: '22.23.1',
});
process.stdout.write(`${identity.digest}\n`);
NODE
)"
test "${#INSTALLED_CONTROL_PLANE_DIGEST}" = 64
```

Compare that value to the signed candidate `controlPlane.digest`, and obtain the
exact candidate payload digest and the exact current `:main` digest from the
completed publisher's pointer-guard evidence. Then dispatch from an authenticated
repository-owner session only:

```bash
REPOSITORY=felipedrf74/cortex-telegram-hub-bot
: "${SOURCE_SHA:?exact current protected-main SHA}"
: "${RELEASE_PAYLOAD_DIGEST:?exact withheld candidate sha256 digest}"
: "${CURRENT_POINTER_DIGEST:?exact observed current :main sha256 digest}"
: "${INSTALLED_CONTROL_PLANE_DIGEST:?exact owner-observed installed digest}"
test "$(gh api "repos/$REPOSITORY/commits/main" --jq .sha)" = "$SOURCE_SHA"
gh workflow run release-manifest-schema-activate.yml \
  --repo "$REPOSITORY" \
  --ref main \
  -f source_sha="$SOURCE_SHA" \
  -f release_payload_digest="$RELEASE_PAYLOAD_DIGEST" \
  -f current_pointer_digest="$CURRENT_POINTER_DIGEST" \
  -f installed_control_plane_digest="$INSTALLED_CONTROL_PLANE_DIGEST" \
  -f confirm=activate-manifest-schema-pointer
```

The dispatch shares `release-publish-main` concurrency and the
`release-publish` environment. It refuses a non-owner original actor or rerun
triggering actor, non-main workflow,
changed protected-main SHA, changed current pointer, bad signature, non-increasing
generation, or control-plane mismatch; it reasserts the exact pointer and main
SHA after retagging. Its installed-controller input is explicitly an attended
owner observation, not a machine-generated host attestation. Require the run to
finish `success` and its summary to contain the four exact reviewed identities
before one attended poll. Keep the poller timer disabled until that poll writes a
completed/provable receipt and both exact images are healthy.

## 3. Registry access

The poller pulls from GHCR as root. Log in once with a read-only token:

```bash
# DOCKER_CONFIG, not /root/.docker: the poller unit sets ProtectHome=yes, which
# hides /root, so a credential written to the default location is invisible to the
# poller and every pull fails with an authentication error.
GHCR_READ_USER='<exact GitHub package reader>'
read -r -s -p 'GHCR read:packages token: ' GHCR_READ_TOKEN
printf '\n' >&2
printf '%s' "$GHCR_READ_TOKEN" \
  | sudo /usr/bin/env -i PATH=/usr/bin:/bin \
    HOME=/var/lib/nexus-release/home \
    DOCKER_CONFIG=/etc/nexus-release/docker \
    /usr/bin/docker login ghcr.io -u "$GHCR_READ_USER" --password-stdin
unset GHCR_READ_TOKEN
sudo chmod 600 /etc/nexus-release/docker/config.json
sudo test ! -L /etc/nexus-release/docker/config.json
test "$(sudo stat -Lc '%U:%G:%a:%h' -- \
  /etc/nexus-release/docker/config.json)" = root:root:600:1
sudo jq -e '
  (.auths["ghcr.io"].auth | type == "string" and length > 0)
  and (has("currentContext") | not)
  and (has("proxies") | not)
' /etc/nexus-release/docker/config.json >/dev/null
```

The token needs `read:packages` only. It must not carry write scope: the host
publishes nothing.

Verify the poller can actually see it, inside the hardened unit rather than from
an interactive root shell:

```bash
sudo systemd-run --pipe --wait \
  --property=ProtectHome=yes --property=ProtectSystem=full \
  /usr/bin/env -i PATH=/usr/bin:/bin HOME=/var/lib/nexus-release/home \
  DOCKER_CONFIG=/etc/nexus-release/docker \
  /usr/bin/docker pull --quiet ghcr.io/felipedrf74/nexus-hub-release:main
```

## 3a. Owner-authorized legacy migration baseline

The legacy `_migrations` ledger records filenames, not byte digests. No local
tool can retroactively prove which bytes a historical process executed. Before
signing, the hosted full-history checkout reads ordinary retired rows from their
exact source commits. Five v4 `repository_archive` rows whose commits are not
hosted-reachable preserve `sourceCommit` as historical metadata but verify their
bytes only from the canonical candidate-index path
`docs/release/evidence/retired-migrations/<sourceCommit>/<file>`. That locator
must be one stage-0 regular `100644` Git entry; worktree-only, untracked,
missing, duplicate, symlink, mismatched-path, or digest-drifted evidence fails
closed, without fallback to a locally available dangling commit. The archive
does not independently prove membership in the historical commit. The hosted
gate also proves byte equality for byte-identical renumbers and executable-SQL
equality after deterministic comment/whitespace normalization for comment-only
renumbers.

The first container release still requires explicit owner acceptance of the
quiesced database state. Each database must contain an exact canonical prefix of
the signed inventory plus its exact signed retired rows: currently 19 in
production and those 19 plus four notification aliases in staging. The remaining
inventory must be the exact ordered pending suffix, and every row in that suffix
must be predecessor compatible. With the current 274-file inventory, both
databases have the 273-file prefix and the sole pending row is migration 283. A
missing or additional outside-inventory row is refused. Raw schemas are expected
to differ at this boundary. The baseline applies every exact signed pending byte
to private in-memory snapshots, requires v2 semantic schemas to converge, and
binds every column ordinal plus a canonical token projection of each complete
`CREATE TABLE` statement, including collation, generated expressions, and table
constraints. It excludes only the signed staging fixture table/index and proves
the fixture row count and digest are unchanged. For migration 283, admission
also binds each obsolete index name globally to its exact unique table/columns
or absence, creates and verifies each exact tenant-safe unique replacement
before the old drop, and rejects absent, wrong-column, or non-unique
replacements. After that boundary, CI's append-only gate forbids changing,
renaming, or deleting a baseline migration.

This step is intentionally after signing trust and registry access. The
generator pulls `nexus-hub-release:main`, verifies its signature with the pinned
host key, resolves its immutable OCI digest, and binds the baseline to that exact
published target. A baseline cannot be created before that signed candidate
exists.

Supply the exact release ID and OCI payload digest from the owner-reviewed signed
publication. The mutable `:main` pointer is only a discovery mechanism: the
generator refuses a different resolved digest or release ID before it publishes
baseline evidence. `unknown`, an inferred value, or a value copied from generator
output is not authorization. The source SHAs and fallback artifact identities
come from the root-owned PM2 capture written before section 1b's first mutation;
the completed database-transition checkpoint binds that capture to both source-
equal targets. This block never starts the guarded PM2 daemon merely to query it.

```bash
set -euo pipefail
die() { printf 'BASELINE REFUSED: %s\n' "$*" >&2; exit 1; }

BASELINE_FILE=/var/lib/nexus-release/state/bootstrap-baseline.json
RUNTIME_EVIDENCE=/var/lib/nexus-release/state/bootstrap-legacy-runtime.json
TRANSITION_EVIDENCE=/var/lib/nexus-release/state/bootstrap-database-transition.json
USER_RELEASE_LOCK=/home/dominguez/.local/state/nexus-release/.release.lock
MAINTENANCE_LOCK=/run/lock/nexus-release-sonar.lock
: "${EXPECTED_RELEASE_ID:?export the owner-reviewed 32-hex release ID}"
: "${EXPECTED_RELEASE_PAYLOAD_DIGEST:?export the owner-reviewed sha256 OCI payload digest}"
[[ "$EXPECTED_RELEASE_ID" =~ ^[0-9a-f]{32}$ ]] \
  || die 'owner-expected release ID is invalid'
[[ "$EXPECTED_RELEASE_PAYLOAD_DIGEST" =~ ^sha256:[0-9a-f]{64}$ ]] \
  || die 'owner-expected payload digest is invalid'
test "$(sudo stat -Lc '%U:%G:%a:%h' -- "$RUNTIME_EVIDENCE")" \
  = 'root:root:600:1' || die 'legacy runtime capture owner, mode, or links are unsafe'
sudo test ! -L "$RUNTIME_EVIDENCE" || die 'legacy runtime capture is symbolic'
sudo jq -e \
  '.schema == "nexus.bootstrap-legacy-runtime-capture.v2"
   and (.createdAt | type == "string"
        and test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$"))
   and (.productionSourceSha | test("^[0-9a-f]{40}$"))
   and (.stagingSourceSha | test("^[0-9a-f]{40}$"))
   and (.productionArtifactDigest | test("^[0-9a-f]{64}$"))
   and (.stagingArtifactDigest | test("^[0-9a-f]{64}$"))
   and (.productionMarkerSha256 | test("^[0-9a-f]{64}$"))
   and (.stagingMarkerSha256 | test("^[0-9a-f]{64}$"))
   and (.productionRuntimePath
        | startswith("/home/dominguez/telegram-hub-bot/releases/"))
   and (.stagingRuntimePath
        | startswith("/home/dominguez/telegram-hub-bot-staging/releases/"))
   and (.productionDatabaseIdentity | test("^[0-9]+:[0-9]+$"))
   and (.stagingDatabaseIdentity | test("^[0-9]+:[0-9]+$"))
   and (keys | sort == ["createdAt","productionArtifactDigest",
     "productionDatabaseIdentity","productionMarkerSha256",
     "productionRuntimePath","productionSourceSha","schema",
     "stagingArtifactDigest","stagingDatabaseIdentity","stagingMarkerSha256",
     "stagingRuntimePath","stagingSourceSha"])' \
  "$RUNTIME_EVIDENCE" >/dev/null \
  || die 'legacy runtime capture is invalid'
PRODUCTION_SHA="$(sudo jq -er .productionSourceSha "$RUNTIME_EVIDENCE")"
STAGING_SHA="$(sudo jq -er .stagingSourceSha "$RUNTIME_EVIDENCE")"
test "$(printf '%s\n' "$PRODUCTION_SHA" "$STAGING_SHA" \
  | grep -Ec '^[0-9a-f]{40}$')" -eq 2 || die 'captured source SHA is invalid'
test "$(sudo stat -c '%U:%G:%a' -- "$USER_RELEASE_LOCK")" \
  = 'dominguez:dominguez:600' || die 'user release lock is unsafe'
test "$(sudo stat -c '%U:%G:%a' -- "$MAINTENANCE_LOCK")" \
  = 'root:dominguez:660' || die 'shared maintenance mutex is unsafe'
test ! -L "$USER_RELEASE_LOCK" && test ! -L "$MAINTENANCE_LOCK" \
  || die 'a release mutex is symbolic'
exec 9<>"$USER_RELEASE_LOCK"
flock -n 9 || die 'another PM2 release or capability transaction is active'
exec 8<>"$MAINTENANCE_LOCK"
flock -n 8 || die 'another root maintenance or container release is active'
PM2_GUARD_ROOT=/etc/systemd/system.control
sudo test -d "$PM2_GUARD_ROOT" && sudo test ! -L "$PM2_GUARD_ROOT" \
  && test "$(sudo stat -Lc '%U:%G:%a' -- "$PM2_GUARD_ROOT")" = root:root:755 \
  || die 'PM2 high-priority runtime guard root is unsafe'
for UNIT in pm2-dominguez.service nexus-release-pm2-recovery-daemon.service; do
  GUARD="$PM2_GUARD_ROOT/$UNIT"
  sudo test -L "$GUARD" \
    && test "$(sudo readlink -- "$GUARD")" = /dev/null \
    && test "$(sudo stat -c '%U:%G:%F' -- "$GUARD")" = \
      'root:root:symbolic link' \
    || die "$UNIT high-priority runtime guard is not exact"
  test "$(sudo systemctl show "$UNIT" --property=LoadState --value)" = masked \
    || die "$UNIT is not loaded as masked"
  test "$(sudo systemctl show "$UNIT" --property=FragmentPath --value)" = "$GUARD" \
    || die "$UNIT is not resolved through its high-priority runtime guard"
  test "$(sudo systemctl show "$UNIT" --property=CanStart --value)" = no \
    || die "$UNIT can still be started"
  test "$(sudo systemctl show "$UNIT" --property=ActiveState --value)" = inactive \
    || die "$UNIT is not inactive"
done

test "$(sudo stat -Lc '%U:%G:%a:%h' -- "$TRANSITION_EVIDENCE")" \
  = 'root:root:600:1' || die 'database transition checkpoint is unsafe'
sudo test ! -L "$TRANSITION_EVIDENCE" \
  || die 'database transition checkpoint is symbolic'
RUNTIME_CAPTURE_SHA256="$(sudo sha256sum "$RUNTIME_EVIDENCE" | awk '{print $1}')"
sudo jq -e --arg capture "$RUNTIME_CAPTURE_SHA256" \
  '.schema == "nexus.bootstrap-database-transition.v1"
   and .runtimeCaptureSha256 == $capture
   and .legacy.production.path == "/home/dominguez/telegram-hub-bot/data/bot.db"
   and .legacy.staging.path == "/home/dominguez/telegram-hub-bot-staging/data/bot.db"
   and .target.production.path == "/var/lib/nexus-hub/production/data/bot.db"
   and .target.staging.path == "/var/lib/nexus-hub/staging/data/bot.db"
   and .backupDatabasePath == "/var/lib/nexus-hub/production/data/bot.db"
   and (.legacy.production.identity | test("^[0-9]+:[0-9]+$"))
   and (.legacy.staging.identity | test("^[0-9]+:[0-9]+$"))
   and (.target.production.identity | test("^[0-9]+:[0-9]+$"))
   and (.target.staging.identity | test("^[0-9]+:[0-9]+$"))
   and (.legacy.production.logicalDigest | test("^[0-9a-f]{64}$"))
   and (.legacy.staging.logicalDigest | test("^[0-9a-f]{64}$"))
   and (.target.production.logicalDigest == .legacy.production.logicalDigest)
   and (.target.staging.logicalDigest == .legacy.staging.logicalDigest)' \
  "$TRANSITION_EVIDENCE" >/dev/null \
  || die 'database transition checkpoint is invalid or capture-mismatched'

BASELINE_RESULT="$(sudo /usr/bin/env -i PATH=/usr/bin:/bin \
  HOME=/var/lib/nexus-release/home DOCKER_CONFIG=/etc/nexus-release/docker \
  /usr/bin/npm --prefix /opt/nexus-release/checkout run --silent \
  release:cd:bootstrap-baseline -- \
  --accept-current-history-as-baseline \
  --production-source-sha "$PRODUCTION_SHA" \
  --staging-source-sha "$STAGING_SHA" \
  --expected-release-id "$EXPECTED_RELEASE_ID" \
  --expected-release-payload-digest "$EXPECTED_RELEASE_PAYLOAD_DIGEST")"
printf '%s\n' "$BASELINE_RESULT" | jq -e \
  '.schema == "nexus.release-bootstrap-baseline-result.v1"
   and (.target.releaseId | test("^[0-9a-f]{32}$"))
   and (.target.sourceSha | test("^[0-9a-f]{40}$"))
   and (.target.releasePayloadDigest | test("^sha256:[0-9a-f]{64}$"))
   and (.target.manifestDigest | test("^[0-9a-f]{64}$"))' >/dev/null
test "$(printf '%s\n' "$BASELINE_RESULT" | jq -er .target.releaseId)" \
  = "$EXPECTED_RELEASE_ID" || die 'baseline result release ID changed'
test "$(printf '%s\n' "$BASELINE_RESULT" | jq -er .target.releasePayloadDigest)" \
  = "$EXPECTED_RELEASE_PAYLOAD_DIGEST" || die 'baseline result payload digest changed'
test "$(printf '%s\n' "$BASELINE_RESULT" | jq -er .output)" = "$BASELINE_FILE"
test "$(sudo stat -c '%U:%G %a' "$BASELINE_FILE")" = 'root:root 600'
sudo jq -e \
  '.schema == "nexus.release-bootstrap-baseline.v2"
   and (.legacyDatabases.production.snapshotDigest == .databases.production.snapshotDigest)
   and (.legacyDatabases.staging.snapshotDigest == .databases.staging.snapshotDigest)
   and (.migrationReconciliationDigest | test("^[0-9a-f]{64}$"))
   and (.databases.production.ledger.legacyRows | length == 19)
   and (all(.databases.production.ledger.pending[];
        .predecessorCompatible == true
        and (.file | test("^[0-9]{3}_[^/]+\\.sql$"))
        and (.sha256 | test("^[0-9a-f]{64}$"))))
   and (.databases.staging.ledger.legacyRows | length == 23)
   and (all(.databases.staging.ledger.pending[];
        .predecessorCompatible == true
        and (.file | test("^[0-9]{3}_[^/]+\\.sql$"))
        and (.sha256 | test("^[0-9a-f]{64}$"))))
   and (.schemaProof.schema == "nexus.release-bootstrap-semantic-schema-proof.v2")
   and (.schemaProof.production.postMigrationSchemaDigest == .schemaProof.convergedSchemaDigest)
   and (.schemaProof.staging.postMigrationSchemaDigest == .schemaProof.convergedSchemaDigest)
   and (.schemaProof.staging.preservedFixture.tableName == "staging_fixture_calendar_events")
   and (.schemaProof.staging.preservedFixture.rowCount >= 0)
   and (.schemaProof.staging.preservedFixture.digest | test("^[0-9a-f]{64}$"))' \
  "$BASELINE_FILE" >/dev/null
sudo jq \
  '{createdAt,migrationInventoryDigest,migrationReconciliationDigest,
    convergedSchemaDigest:.schemaProof.convergedSchemaDigest,
    preservedStagingFixture:.schemaProof.staging.preservedFixture,
    target,legacyRuntime,
    snapshots:{production:.databases.production.snapshotDigest,
               staging:.databases.staging.snapshotDigest}}' \
  "$BASELINE_FILE"
sudo sha256sum "$BASELINE_FILE"
```

The generator refuses any WAL, SHM, or rollback-journal sidecar; an open SQLite
handle; a non-prefix canonical ledger; a missing or extra signed legacy row; an
unknown or non-compatible pending migration; failure to converge after the exact
signed in-memory rehearsal; changed staging fixture data; symlinks/hardlinks; or
an existing baseline file. The bootstrap unit re-hashes both legacy and target
databases, the signed inventory, and the signed reconciliation. Evidence older
than 24 hours or any byte changed after authorization is refused before staging.
The reset branch in section 6 is the only documented path for replacing
failed-attempt evidence.

## 4. Environment files

```bash
sudo install -o root -g root -m 600 \
  /opt/nexus-release/checkout/ops/nexus-release/poller.env.example \
  /etc/nexus-release/poller.env
sudo editor /etc/nexus-release/poller.env
```

Each environment has two application files. Backend and the one-shot migrator
share the backend file because they execute the same Node image. The Python
content engine receives only its eight allowlisted inputs:
`ANTHROPIC_API_KEY`, `CONTENT_ENGINE_RESEARCH_NETWORK_DISABLED`,
`INTERNAL_API_SECRET`, `NEWSAPI_API_KEY`, `REDDIT_CLIENT_ID`,
`REDDIT_CLIENT_SECRET`, `SERPAPI_API_KEY`, and `YOUTUBE_API_KEY`. Never copy the
whole legacy `.env` into the content-engine file: the product-bot token, OAuth
credentials, calendar credentials, database-encryption keys, registry
credentials, and release-control values do not cross that container boundary.

The transaction below makes the initial four-file split without printing any
value. Run it as one root shell (`sudo -i`) while the poller timer is still
disabled. The two legacy paths are the installed PM2 application roots; stop if
either path differs on the host. All targets deliberately must be absent so this
first-install procedure cannot overwrite a later rotated secret set. Compose
loads these files with `format: raw`, so values must be unquoted literal
`KEY=value` bytes with no inline ` # comment`; `$` is preserved and never
expanded from the root poller environment. If a legacy source uses dotenv quote
or inline-comment syntax, prepare an owner-reviewed normalized root-only source
copy first rather than allowing raw mode to change its effective value.

```bash
set -euo pipefail
umask 077
PATH=/usr/bin:/bin
export PATH

die() { printf 'ENVIRONMENT SPLIT REFUSED: %s\n' "$*" >&2; exit 1; }
test "$EUID" -eq 0 || die 'run the complete transaction from one root shell (sudo -i)'

LEGACY_PRODUCTION_ENV=/home/dominguez/telegram-hub-bot/.env
LEGACY_STAGING_ENV=/home/dominguez/telegram-hub-bot-staging/.env
PRODUCTION_BACKEND=/etc/nexus-release/production-backend.env
PRODUCTION_ENGINE=/etc/nexus-release/production-content-engine.env
STAGING_BACKEND=/etc/nexus-release/staging-backend.env
STAGING_ENGINE=/etc/nexus-release/staging-content-engine.env
SPLIT_TMP="$(mktemp -d /etc/nexus-release/.env-split.XXXXXXXX)"
ENV_SPLIT_TARGETS_OWNED=0

cleanup_env_split() {
  if test "$ENV_SPLIT_TARGETS_OWNED" -eq 1; then
    rm -f -- \
      "$PRODUCTION_BACKEND" "$PRODUCTION_ENGINE" "$STAGING_BACKEND" "$STAGING_ENGINE"
  fi
  rm -f -- \
    "$SPLIT_TMP/production.source" "$SPLIT_TMP/staging.source" \
    "$SPLIT_TMP/production-backend.env" "$SPLIT_TMP/production-content-engine.env" \
    "$SPLIT_TMP/staging-backend.env" "$SPLIT_TMP/staging-content-engine.env"
  rmdir -- "$SPLIT_TMP"
}
trap cleanup_env_split EXIT

snapshot_legacy_env() {
  local source=$1 destination=$2 before after metadata
  test -f "$source" && test ! -L "$source" \
    || die "legacy environment is absent or symbolic: $source"
  metadata="$(stat -Lc '%U:%G:%a:%h' -- "$source")"
  case "$metadata" in
    dominguez:dominguez:600:1|root:root:600:1) ;;
    *) die "legacy environment ownership/mode/link count is unsafe: $source" ;;
  esac
  before="$(stat -Lc '%d:%i:%s:%Y:%Z' -- "$source")"
  install -o root -g root -m 600 -- "$source" "$destination"
  after="$(stat -Lc '%d:%i:%s:%Y:%Z' -- "$source")"
  test "$before" = "$after" \
    || die "legacy environment changed while it was copied: $source"
}

write_backend_env() {
  local source=$1 destination=$2
  awk '
    /^[[:space:]]*($|#)/ { print; next }
    /^[A-Z_][A-Z0-9_]*=/ {
      key=$0; sub(/=.*/, "", key)
      if (key ~ /^(BACKUP_DIR|COMPOSE_PROJECT_NAME|CONTENT_ENGINE_BASE_URL|CONTENT_ENGINE_PORT|DATABASE_PATH|ENV|MIGRATIONS_MODE|NEXUS_APP_STAGING|NEXUS_BACKEND_BASE_URL|NEXUS_BACKEND_ENV_FILE|NEXUS_BACKEND_IMAGE|NEXUS_BACKEND_PORT|NEXUS_CONTENT_ENGINE_ENV_FILE|NEXUS_CONTENT_ENGINE_IMAGE|NEXUS_CONTENT_ENGINE_PORT|NEXUS_DATA_DIR|NEXUS_ENV_FILE|NEXUS_RELEASE_BACKEND_DIGEST|NEXUS_RELEASE_ENVIRONMENT|NEXUS_RELEASE_ID|NEXUS_RELEASE_MIGRATION_PLAN|NEXUS_RELEASE_PLAN_DIR|NEXUS_RELEASE_SOURCE_SHA|NODE_ENV|PORTAL_BIND|PORTAL_PORT|PORTAL_PUBLIC_BIND_ACK|STAGING)$/) next
      if (key ~ /^(DYLD_|LD_|NODE_)/) next
      if (key ~ /^(OPENSSL_CONF|SSL_CERT_DIR|SSL_CERT_FILE)$/) next
      print; next
    }
    { exit 42 }
  ' "$source" >"$destination" \
    || die "legacy backend environment has unsupported syntax: $source"
}

write_content_engine_env() {
  local source=$1 destination=$2
  awk '
    /^[[:space:]]*($|#)/ { next }
    /^[A-Z_][A-Z0-9_]*=/ {
      key=$0; sub(/=.*/, "", key)
      if (key ~ /^(ANTHROPIC_API_KEY|CONTENT_ENGINE_RESEARCH_NETWORK_DISABLED|INTERNAL_API_SECRET|NEWSAPI_API_KEY|REDDIT_CLIENT_ID|REDDIT_CLIENT_SECRET|SERPAPI_API_KEY|YOUTUBE_API_KEY)$/) print
      next
    }
    { exit 42 }
  ' "$source" >"$destination" \
    || die "legacy content-engine environment has unsupported syntax: $source"
}

for target in \
  "$PRODUCTION_BACKEND" "$PRODUCTION_ENGINE" "$STAGING_BACKEND" "$STAGING_ENGINE"; do
  test ! -e "$target" && test ! -L "$target" \
    || die "split environment target already exists: $target"
done
ENV_SPLIT_TARGETS_OWNED=1

snapshot_legacy_env "$LEGACY_PRODUCTION_ENV" "$SPLIT_TMP/production.source"
snapshot_legacy_env "$LEGACY_STAGING_ENV" "$SPLIT_TMP/staging.source"
write_backend_env \
  "$SPLIT_TMP/production.source" "$SPLIT_TMP/production-backend.env"
write_content_engine_env \
  "$SPLIT_TMP/production.source" "$SPLIT_TMP/production-content-engine.env"
write_backend_env \
  "$SPLIT_TMP/staging.source" "$SPLIT_TMP/staging-backend.env"
write_content_engine_env \
  "$SPLIT_TMP/staging.source" "$SPLIT_TMP/staging-content-engine.env"

install -o root -g root -m 600 -- "$SPLIT_TMP/production-backend.env" "$PRODUCTION_BACKEND"
install -o root -g root -m 600 -- "$SPLIT_TMP/production-content-engine.env" "$PRODUCTION_ENGINE"
install -o root -g root -m 600 -- "$SPLIT_TMP/staging-backend.env" "$STAGING_BACKEND"
install -o root -g root -m 600 -- "$SPLIT_TMP/staging-content-engine.env" "$STAGING_ENGINE"

# Use the same descriptor-safe contract the poller executes before every
# Compose render. It checks canonical raw KEY=value syntax, exact allow/deny lists,
# root ownership, one link, mode 0600, and equal non-empty INTERNAL_API_SECRET
# bytes across each environment's pair. It prints no secret or digest.
/usr/bin/env -i PATH=/usr/bin:/bin HOME=/var/lib/nexus-release/home \
  NODE_ENV=production /usr/bin/node --input-type=module -e '
    import { loadContinuousDeploymentPolicy } from "/opt/nexus-release/checkout/scripts/lib/release-manifest.mjs";
    import { createReleaseEnvironmentGate } from "/opt/nexus-release/checkout/scripts/lib/release-environment.mjs";
    const policy = loadContinuousDeploymentPolicy("/opt/nexus-release/checkout");
    const gate = createReleaseEnvironmentGate({ policy });
    gate.verify("staging");
    gate.verify("production");
  '

for target in \
  "$PRODUCTION_BACKEND" "$PRODUCTION_ENGINE" "$STAGING_BACKEND" "$STAGING_ENGINE"; do
  test "$(stat -Lc '%U:%G:%a:%h' -- "$target")" = root:root:600:1 \
    || die "split environment target changed after validation: $target"
done
ENV_SPLIT_TARGETS_OWNED=0
```

Compose declares both files `required: true`; a missing or unreadable file is a
hard failure and `format: raw` prevents value interpolation. The descriptor-safe host gate runs before every Compose
config/ps/up/down/migrator render, remembers both accepted digests for the life
of the release process, and refuses an edit between staging and production.
If `APNS_ENABLED=true`, keep `APNS_AUTH_KEY_P8` as either canonical escaped PEM
or a normalized absolute host path to the private `.p8`. A referenced file must
be a mode-0600, single-link regular UTF-8 file owned by the effective root
release identity and contain an EC P-256 key. The host gate descriptor-reads and
digest-pins it, then passes only canonical single-line escaped PEM to the backend
container while explicitly blanking it in the migrator. This prevents a valid
host path from becoming an unreadable container path while avoiding a broad
secret directory mount. Never print the path, PEM, or its digest during
verification.
Rotate a pair only as one owner-controlled transaction while no release attempt
is running. `INTERNAL_API_SECRET` must be present with the same raw value in
both files of a pair.

Compose supplies topology and signed identity instead of trusting mutable env
files: `PORTAL_PORT`, `PORTAL_BIND`, `CONTENT_ENGINE_BASE_URL`, `DATABASE_PATH`,
`BACKUP_DIR`, `MIGRATIONS_MODE`, every `NEXUS_RELEASE_*` value, image/path/port
selectors, `NODE_ENV`, and `STAGING` are forbidden in the backend file.
`NEXUS_RELEASE_ID`, `NEXUS_RELEASE_SOURCE_SHA`, and
`NEXUS_RELEASE_BACKEND_DIGEST` are also poller-supplied and are forbidden in
every mutable environment file.
`NEXUS_APNS_AUTH_KEY_P8_ESCAPED` is likewise poller-supplied and forbidden; the
mutable file remains the source declaration through `APNS_AUTH_KEY_P8`, while
the descriptor-safe gate owns the bytes delivered to the container.
`NODE_ENV=production` remains deliberate for both deployments; the registry
supplies immutable `NEXUS_APP_STAGING=true` only for staging and `false` only for
production. Every render requires the exact signed candidate identity and plan
directory. Candidate work uses a v2 plan. Normal/crash rollback uses a freshly
materialized v3 plan that binds the predecessor's exact signed identity,
inventory, and reconciliation plus the root-projected successor identity and
the exact ordered digest-bound predecessor-compatible suffix already applied.
Backend and migrator mount the direct digest-workdir `runtime-plan` directory
read-only; it must be mode 0755 with a mode-0644 single-link regular plan. The
registry rejects a missing or unsafe directory and has no fallback; never
supply a manual default. Unknown or non-prefix ledger rows still fail.

## 5. Maintenance mutex

```bash
sudo install -o root -g root -m 644 \
  /opt/nexus-release/checkout/ops/nexus-release/nexus-release-maintenance-lock.conf \
  /etc/tmpfiles.d/nexus-release-maintenance-lock.conf
sudo systemd-tmpfiles --create
```

## 6. Units

Install the argument-free state projection and its one-command sudo rule from
the same immutable control-plane candidate. This is the only root command the
workspace release resolver receives: it can read the validated state/receipt
projection, but cannot acknowledge a block, start a deployment, select an
output path, or inject an environment variable. Validate both the reviewed
source and installed sudoers bytes before attempting the delegated read.

```bash
STATE_VIEW_SOURCE=/opt/nexus-release/checkout/ops/nexus-release/nexus-release-state-view
STATE_VIEW_SUDOERS_SOURCE=/opt/nexus-release/checkout/ops/nexus-release/nexus-release-state-view.sudoers

sudo test -f "$STATE_VIEW_SOURCE" && sudo test ! -L "$STATE_VIEW_SOURCE"
sudo test -f "$STATE_VIEW_SUDOERS_SOURCE" && sudo test ! -L "$STATE_VIEW_SUDOERS_SOURCE"
sudo /bin/sh -n "$STATE_VIEW_SOURCE"
sudo /usr/sbin/visudo -cf "$STATE_VIEW_SUDOERS_SOURCE"
sudo install -o root -g root -m 755 -- \
  "$STATE_VIEW_SOURCE" /usr/local/sbin/nexus-release-state-view
sudo install -o root -g root -m 440 -- \
  "$STATE_VIEW_SUDOERS_SOURCE" /etc/sudoers.d/nexus-release-state-view
sudo /usr/sbin/visudo -cf /etc/sudoers.d/nexus-release-state-view
sudo /usr/bin/cmp -s -- \
  "$STATE_VIEW_SOURCE" /usr/local/sbin/nexus-release-state-view
sudo /usr/bin/cmp -s -- \
  "$STATE_VIEW_SUDOERS_SOURCE" /etc/sudoers.d/nexus-release-state-view
test "$(sudo stat -Lc '%U:%G:%a:%h' -- \
  /usr/local/sbin/nexus-release-state-view)" = root:root:755:1 \
  || die 'installed release-state observer ownership or mode changed'
test "$(sudo stat -Lc '%U:%G:%a:%h' -- \
  /etc/sudoers.d/nexus-release-state-view)" = root:root:440:1 \
  || die 'installed release-state sudo rule ownership or mode changed'
sudo -u dominguez sudo -n /usr/local/sbin/nexus-release-state-view >/dev/null

sudo install -o root -g root -m 644 \
  /opt/nexus-release/checkout/ops/nexus-release/nexus-release-bootstrap.service \
  /opt/nexus-release/checkout/ops/nexus-release/nexus-release-poller.service \
  /opt/nexus-release/checkout/ops/nexus-release/nexus-release-poller.timer \
  /opt/nexus-release/checkout/ops/nexus-release/nexus-release-heartbeat.service \
  /opt/nexus-release/checkout/ops/nexus-release/nexus-release-heartbeat.timer \
  /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable nexus-release-heartbeat.timer
```

Before any first-cutover poller invocation, prove the dedicated release
Telegram path immediately. The one-shot receives only the two Telegram values
from the root-only `poller.env`; it does not log either value or read the
provider response body. A journal sync and tail cursor captured before the
start fence out older evidence. Post-cursor trusted fields must expose one
validated `_SYSTEMD_INVOCATION_ID`, and a second query bound to that cursor,
unit, and invocation must contain exactly one delivered proof. This remains
valid even when systemd clears the unit's `InvocationID` property after exit.
Run the complete block in one Bash shell. Any failure stops the cutover; do not
start the bootstrap service or either poller service/timer without the exact
`delivered:true` proof.

```bash
set -euo pipefail
PATH=/usr/bin:/bin
export PATH

die() { printf 'HEARTBEAT LIVENESS REFUSED: %s\n' "$*" >&2; exit 1; }

HEARTBEAT_UNIT=nexus-release-heartbeat.service
HEARTBEAT_TIMER=nexus-release-heartbeat.timer
test "$(sudo systemctl show "$HEARTBEAT_UNIT" --property=ActiveState --value)" \
  = inactive || die 'heartbeat service is not inactive before attended proof'
test "$(sudo systemctl show "$HEARTBEAT_TIMER" --property=ActiveState --value)" \
  = inactive || die 'heartbeat timer is already active before attended proof'
test "$(sudo systemctl show "$HEARTBEAT_UNIT" --property=Type --value)" \
  = oneshot || die 'heartbeat service is not a one-shot'
test "$(sudo systemctl show "$HEARTBEAT_UNIT" --property=RemainAfterExit --value)" \
  = no || die 'heartbeat service retains an active state after exit'

sudo journalctl --sync
HEARTBEAT_CURSOR_OUTPUT="$(
  sudo journalctl -n 0 --show-cursor --output=cat --no-pager --quiet
)"
HEARTBEAT_CURSOR_COUNT="$(
  /usr/bin/awk '/^-- cursor: / { count += 1 } END { print count + 0 }' \
    <<<"$HEARTBEAT_CURSOR_OUTPUT"
)"
test "$HEARTBEAT_CURSOR_COUNT" = 1 \
  || die 'journal did not return exactly one pre-start tail cursor'
HEARTBEAT_JOURNAL_CURSOR="$(
  /usr/bin/sed -n 's/^-- cursor: //p' <<<"$HEARTBEAT_CURSOR_OUTPUT"
)"
test -n "$HEARTBEAT_JOURNAL_CURSOR" \
  || die 'journal cursor is unavailable before heartbeat start'

sudo systemctl start "$HEARTBEAT_UNIT" \
  || die 'dedicated release-channel heartbeat service failed'
HEARTBEAT_RESULT="$(sudo systemctl show "$HEARTBEAT_UNIT" \
  --property=Result --value)"
test "$HEARTBEAT_RESULT" = success \
  || die 'heartbeat unit result is not success'

sudo journalctl --sync
HEARTBEAT_POST_CURSOR_INVOCATIONS="$(
  sudo journalctl --after-cursor="$HEARTBEAT_JOURNAL_CURSOR" \
    "_SYSTEMD_UNIT=$HEARTBEAT_UNIT" --output=json --no-pager --quiet \
  | /usr/bin/jq -rs '
      [ .[]
        | ._SYSTEMD_INVOCATION_ID
        | select(type == "string" and test("^[0-9a-f]{32}$"))
      ] | unique
    '
)"
HEARTBEAT_POST_CURSOR_INVOCATION_COUNT="$(
  /usr/bin/jq -r 'length' <<<"$HEARTBEAT_POST_CURSOR_INVOCATIONS"
)"
test "$HEARTBEAT_POST_CURSOR_INVOCATION_COUNT" = 1 \
  || die 'post-cursor journal lacks exactly one heartbeat invocation'
HEARTBEAT_INVOCATION_ID="$(
  /usr/bin/jq -er '.[0] | select(test("^[0-9a-f]{32}$"))' \
    <<<"$HEARTBEAT_POST_CURSOR_INVOCATIONS"
)" || die 'heartbeat proof invocation identity is unavailable'

HEARTBEAT_INVOCATION_PROOF_COUNT="$(
  sudo journalctl --after-cursor="$HEARTBEAT_JOURNAL_CURSOR" \
    "_SYSTEMD_UNIT=$HEARTBEAT_UNIT" \
    "_SYSTEMD_INVOCATION_ID=$HEARTBEAT_INVOCATION_ID" \
    --output=json --no-pager --quiet \
  | /usr/bin/jq -rs --arg invocation "$HEARTBEAT_INVOCATION_ID" \
      --arg unit "$HEARTBEAT_UNIT" '
      [ .[]
        | select(
            ._SYSTEMD_UNIT == $unit
            and ._SYSTEMD_INVOCATION_ID == $invocation
          )
        | .MESSAGE
        | fromjson?
        | select(
            type == "object"
            and keys == ["delivered", "reason", "schema"]
            and .schema == "nexus.release-heartbeat.v1"
            and .delivered == true
            and .reason == "sent"
          )
      ] | length
    '
)"
test "$HEARTBEAT_INVOCATION_PROOF_COUNT" = 1 \
  || die 'exact post-cursor invocation lacks one delivered heartbeat journal proof'

sudo systemctl start "$HEARTBEAT_TIMER" \
  || die 'weekly heartbeat timer did not start'
```

The workspace read is exactly
`ssh ServerDominguez sudo -n /usr/local/sbin/nexus-release-state-view` with no
arguments. The wrapper resets the environment with `/usr/bin/env -i` and then
executes only the active root-owned `scripts/release-state-view.mjs`; a caller
argument is rejected with exit 64 before Node starts. The JSON is generated and
non-authoritative: root-owned state and immutable receipts remain the evidence.

Do **not** enable the poller timer yet. The ordinary poller deliberately returns
`first_container_bootstrap_authorization_required` while no completed container
predecessor exists. Prove the first release through the separate, non-enabled
owner bootstrap unit:

```bash
sudo systemctl start nexus-release-bootstrap.service
sudo journalctl -u nexus-release-bootstrap.service -o short-iso --no-pager
sudo /usr/bin/env -i PATH=/usr/bin:/bin HOME=/var/lib/nexus-release/home \
  /usr/bin/npm --prefix /opt/nexus-release/checkout \
  run release:cd:ack -- --show
# Require: active.status=completed, predecessor.releaseId=active.releaseId,
# no block, and a completed immutable receipt for that exact release.
```

This one-shot path may admit the initial publication even when its signed summary
says `cdEligibility:false`, but only for the exact digest-bound reconciliation:
both databases must contain an exact canonical inventory prefix, their exact
signed environment-specific legacy sets, and only the remaining exact signed
ordered suffix may be pending; every suffix row must be predecessor compatible. The current suffix
contains only migration 283, but admission does not hardcode that filename or
suffix length. The baseline's in-memory proof must converge and preserve staging
fixture data. Any byte outside the signed suffix or any other ledger row fails.
The ordinary timer never carries the bootstrap flag, so this cannot become a
maintenance-release bypass.

If the first cutover fails after either Compose project starts, there is no prior
container pair to restore. Keep the timer disabled. Run the following recovery
as one Bash transaction: it stops **both** Compose projects (including one-off
migrators), archives both failed container databases, atomically replaces the
legacy production path with a SQLite snapshot that preserves container-era
writes, restores both PM2 pairs, and points governed backups back at PM2. A
forced container stop may leave WAL/SHM pathnames even after a successful
checkpoint. The transaction removes them only after proving no handles, exact
`0|0|0`, no rollback journal, a single-link zero-byte regular WAL, and a
single-link regular SHM; any other sidecar shape is a hard refusal.

```bash
set -euo pipefail

die() { printf 'BOOTSTRAP RECOVERY REFUSED: %s\n' "$*" >&2; exit 1; }

PM2_RETIREMENT_JOURNAL=/var/lib/nexus-release/state/pm2-fallback-retirement.json
PM2_RETIRED_TOMBSTONE=/var/lib/nexus-release/state/pm2-fallback-retired.json
for PM2_RETIREMENT_GATE in "$PM2_RETIREMENT_JOURNAL" "$PM2_RETIRED_TOMBSTONE"; do
  sudo test ! -e "$PM2_RETIREMENT_GATE" \
    && sudo test ! -L "$PM2_RETIREMENT_GATE" \
    || die "PM2 fallback retirement gate exists: $PM2_RETIREMENT_GATE"
done
unset PM2_RETIREMENT_GATE

run_pm2_as_dominguez() {
  local pm2_cwd=/home/dominguez
  (cd "$pm2_cwd" && sudo -u dominguez pm2 "$@")
}

require_no_open_handles() {
  local db suffix error_file handles lsof_status
  local -a candidates
  for db in "$@"; do
    sudo test -f "$db" || die "missing database: $db"
    candidates+=("$db")
    for suffix in -wal -shm -journal; do
      if sudo test -e "$db$suffix"; then candidates+=("$db$suffix"); fi
    done
  done
  error_file="$(mktemp)"
  if handles="$(sudo lsof -t -- "${candidates[@]}" 2>"$error_file")"; then
    lsof_status=0
  else
    lsof_status=$?
  fi
  if test -s "$error_file"; then
    sed 's/^/lsof: /' "$error_file" >&2
    rm -f "$error_file"
    die 'open-handle probe produced an error'
  fi
  rm -f "$error_file"
  case "$lsof_status" in
    0) die "database handles remain open: $handles" ;;
    1) test -z "$handles" || die 'lsof returned output with no-match status' ;;
    *) die "lsof failed with status $lsof_status" ;;
  esac
}

require_no_sqlite_sidecars() {
  local db suffix
  for db in "$@"; do
    for suffix in -wal -shm -journal; do
      sudo test ! -e "$db$suffix" || die "SQLite sidecar remains: $db$suffix"
    done
  done
}

remove_proven_stale_wal_sidecars() {
  local checkpoint db metadata
  local -a stale_sidecars
  for db in "$@"; do
    stale_sidecars=()
    require_no_open_handles "$db"
    checkpoint="$(sudo sqlite3 "$db" 'PRAGMA wal_checkpoint(TRUNCATE);')"
    test "$checkpoint" = '0|0|0' \
      || die "zero-WAL checkpoint proof failed for $db: $checkpoint"
    require_no_open_handles "$db"
    sudo test ! -e "$db-journal" \
      || die "rollback journal cannot be classified stale: $db-journal"
    if sudo test -e "$db-wal"; then
      metadata="$(sudo stat -c '%F:%h:%s' -- "$db-wal")"
      test "$metadata" = 'regular empty file:1:0' \
        || die "WAL sidecar is not a single-link zero-byte regular file: $db-wal"
      stale_sidecars+=("$db-wal")
    fi
    if sudo test -e "$db-shm"; then
      metadata="$(sudo stat -c '%F:%h' -- "$db-shm")"
      test "$metadata" = 'regular file:1' \
        || die "SHM sidecar is not a single-link regular file: $db-shm"
      stale_sidecars+=("$db-shm")
    fi
    if test "${#stale_sidecars[@]}" -gt 0; then
      sudo rm -- "${stale_sidecars[@]}"
    fi
    require_no_open_handles "$db"
    require_no_sqlite_sidecars "$db"
  done
}

require_valid_sqlite() {
  local db integrity foreign_keys
  db="$1"
  integrity="$(sudo sqlite3 "file:$db?mode=ro" 'PRAGMA integrity_check;')"
  test "$integrity" = 'ok' || die "integrity_check failed for $db: $integrity"
  foreign_keys="$(sudo sqlite3 "file:$db?mode=ro" 'PRAGMA foreign_key_check;')"
  test -z "$foreign_keys" || die "foreign_key_check failed for $db: $foreign_keys"
}

logical_digest() {
  sudo sqlite3 "file:$1?mode=ro" '.dump' | sha256sum | awk '{print $1}'
}

verify_installed_runtime() {
  local digest runtime sha
  runtime="$1"; sha="$2"; digest="$3"
  sudo test -d "$runtime" && sudo test ! -L "$runtime" \
    && sudo test -f "$runtime/ecosystem.release.config.js" \
    && sudo test ! -L "$runtime/ecosystem.release.config.js" || return 1
  if sudo test -f "$runtime/.nexus-installed-runtime.json" \
      && sudo test ! -L "$runtime/.nexus-installed-runtime.json" \
      && sudo test -f "$runtime/scripts/release-installed-tree-attestation.mjs" \
      && sudo test ! -L "$runtime/scripts/release-installed-tree-attestation.mjs"; then
    sudo /usr/bin/node \
      /opt/nexus-release/checkout/scripts/release-artifact-manifest.mjs \
      --verify-installed-source "$runtime" --expected-runtime-sha "$sha" \
      --expected-digest "$digest" \
      --require-declared-file scripts/release-installed-tree-attestation.mjs \
      >/dev/null || return 1
    sudo /usr/bin/node \
      "$runtime/scripts/release-installed-tree-attestation.mjs" validate \
      --root "$runtime" --runtime-sha "$sha" --artifact-digest "$digest" \
      >/dev/null || return 1
  else
    sudo test ! -e "$runtime/.nexus-installed-runtime.json" \
      && sudo test ! -L "$runtime/.nexus-installed-runtime.json" \
      && sudo test ! -e "$runtime/scripts/release-installed-tree-attestation.mjs" \
      && sudo test ! -L "$runtime/scripts/release-installed-tree-attestation.mjs" \
      || return 1
    sudo /usr/bin/node \
      /opt/nexus-release/checkout/scripts/release-artifact-manifest.mjs \
      --verify-installed-source "$runtime" --expected-runtime-sha "$sha" \
      --expected-digest "$digest" >/dev/null || return 1
    sudo /usr/bin/node \
      /opt/nexus-release/checkout/scripts/release-runtime-dependencies.mjs \
      verify-predecessor-extracted --root "$runtime" --python-bin /usr/bin/python3.12 \
      >/dev/null || return 1
  fi
}

require_local_backup_installation() {
  local active_mode active_root destination dropins exec_start expected_sha
  local fragment load mode relative source spec unit
  sudo test -L /opt/nexus-release/checkout \
    && test "$(sudo stat -c '%U:%G:%F' -- /opt/nexus-release/checkout)" = \
      'root:root:symbolic link' \
    || die 'active control-plane selector is unsafe'
  active_root="$(sudo readlink -f -- /opt/nexus-release/checkout)"
  [[ "$active_root" =~ ^/opt/nexus-release/control-plane/[0-9a-f]{40}$ ]] \
    || die 'active control-plane selector escapes its immutable version root'
  sudo test -d "$active_root" && sudo test ! -L "$active_root" \
    && test "$(sudo stat -Lc '%U:%G' -- "$active_root")" = root:root \
    || die 'active immutable control-plane root is unsafe'
  active_mode="$(sudo stat -Lc '%a' -- "$active_root")"
  test $((8#$active_mode & 0222)) -eq 0 \
    || die 'active immutable control-plane root is writable'
  expected_sha="${active_root##*/}"
  test "$(sudo cat "$active_root/.nexus-control-plane-ready")" = \
    "$expected_sha https://github.com/felipedrf74/cortex-telegram-hub-bot.git /usr/bin/node:v22.23.1" \
    || die 'active immutable control-plane marker is invalid'
  for spec in \
    'scripts/local-backup.py|/usr/local/libexec/nexus-local-backup/local-backup.py|755' \
    'scripts/local-backup-retry-launcher.sh|/usr/local/libexec/nexus-local-backup/local-backup-retry-launcher.sh|755' \
    'ops/local-backup/systemd/nexus-local-backup.service|/etc/systemd/system/nexus-local-backup.service|644' \
    'ops/local-backup/systemd/nexus-local-backup.timer|/etc/systemd/system/nexus-local-backup.timer|644' \
    'ops/local-backup/systemd/nexus-local-backup-pre-promotion.service|/etc/systemd/system/nexus-local-backup-pre-promotion.service|644' \
    'ops/local-backup/systemd/nexus-local-backup-restore-verify.service|/etc/systemd/system/nexus-local-backup-restore-verify.service|644' \
    'ops/local-backup/systemd/nexus-local-backup-restore-verify.timer|/etc/systemd/system/nexus-local-backup-restore-verify.timer|644' \
    'ops/local-backup/nexus-local-backup.sudoers|/etc/sudoers.d/nexus-local-backup|440'; do
    IFS='|' read -r relative destination mode <<<"$spec"
    source="$active_root/$relative"
    sudo test -f "$source" && sudo test ! -L "$source" \
      || die "immutable local-backup source is unsafe: $relative"
    sudo test -f "$destination" && sudo test ! -L "$destination" \
      && test "$(sudo stat -Lc '%U:%G:%a:%h' -- "$destination")" = \
        "root:root:$mode:1" \
      || die "installed local-backup asset metadata is unsafe: $destination"
    sudo cmp -s -- "$source" "$destination" \
      || die "installed local-backup asset differs from immutable source: $destination"
  done
  sudo visudo -cf /etc/sudoers.d/nexus-local-backup >/dev/null \
    || die 'installed local-backup sudoers policy is invalid'
  sudo systemctl daemon-reload
  for unit in nexus-local-backup.service nexus-local-backup.timer \
    nexus-local-backup-pre-promotion.service \
    nexus-local-backup-restore-verify.service \
    nexus-local-backup-restore-verify.timer; do
    load="$(sudo systemctl show "$unit" --property=LoadState --value)"
    fragment="$(sudo systemctl show "$unit" --property=FragmentPath --value)"
    dropins="$(sudo systemctl show "$unit" --property=DropInPaths --value)"
    test "$load" = loaded \
      && test "$fragment" = "/etc/systemd/system/$unit" \
      && test -z "$dropins" \
      || die "$unit does not resolve to its exact installed bytes"
  done
  test "$(sudo systemctl show nexus-local-backup-pre-promotion.service \
    --property=Type --value)" = oneshot \
    || die 'pre-promotion backup unit is not Type=oneshot'
  exec_start="$(sudo systemctl show nexus-local-backup-pre-promotion.service \
    --property=ExecStart --value)"
  case "$exec_start" in
    *'path=/usr/local/libexec/nexus-local-backup/local-backup.py ; argv[]=/usr/local/libexec/nexus-local-backup/local-backup.py pre-promotion ;'*) ;;
    *) die 'pre-promotion backup unit has an unexpected effective ExecStart' ;;
  esac
}

wait_for_all_pm2_health() {
  local curl_max deadline endpoint iteration_ok remaining
  local -a endpoints=(
    http://127.0.0.1:8200/health
    http://127.0.0.1:8100/health
    http://127.0.0.1:8201/health
    http://127.0.0.1:8101/health
  )
  deadline=$((SECONDS + 120))
  while test "$SECONDS" -lt "$deadline"; do
    iteration_ok=1
    for endpoint in "${endpoints[@]}"; do
      remaining=$((deadline - SECONDS))
      if test "$remaining" -le 0; then
        iteration_ok=0
        break
      fi
      curl_max=3
      if test "$remaining" -lt "$curl_max"; then curl_max="$remaining"; fi
      if ! curl --fail --silent --show-error --connect-timeout 1 \
          --max-time "$curl_max" "$endpoint" >/dev/null; then
        iteration_ok=0
        break
      fi
    done
    test "$iteration_ok" -eq 1 && return 0
    remaining=$((deadline - SECONDS))
    test "$remaining" -gt 0 || break
    sleep 1
  done
  return 1
}

fresh_backup_for() {
  require_local_backup_installation
  local completed_ms expected producer_started_ms receipt requested_ms
  expected="$1"
  # Root-owned SQLite evidence reads may recreate empty WAL/SHM files. Prove
  # them stale and remove them at the final quiesced boundary before the
  # descriptor-bound backup producer opens the configured database.
  remove_proven_stale_wal_sidecars "$expected"
  require_no_sqlite_sidecars "$expected"
  receipt=/srv/nexus-backups/application/state/last-success.json
  requested_ms="$(date +%s%3N)"
  sudo systemctl start nexus-local-backup-pre-promotion.service
  test "$(sudo systemctl show nexus-local-backup-pre-promotion.service \
    --property=Result --value)" = 'success' || die 'governed backup unit failed'
  sudo test -f "$receipt" || die 'governed backup receipt is missing'
  sudo jq -e --arg expectedDatabase "$expected" \
    '.schema == "nexus.local-backup.v1"
     and .status == "passed"
     and .kind == "pre-promotion"
     and .backupRoot == "/srv/nexus-backups/application"
     and .database == $expectedDatabase
     and (.encryptedSha256 | type == "string"
          and test("^[0-9a-f]{64}$"))
     and (.encryptedSizeBytes | type == "number" and . > 0 and floor == .)
     and (.startedAt | type == "string"
          and test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]+)?Z$"))
     and (.completedAt | type == "string"
          and test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]+)?Z$"))' \
    "$receipt" >/dev/null \
    || die "backup receipt contract failed (wanted $expected)"
  producer_started_ms="$(date -d "$(sudo jq -er .startedAt "$receipt")" +%s%3N)"
  completed_ms="$(date -d "$(sudo jq -er .completedAt "$receipt")" +%s%3N)"
  test "$producer_started_ms" -ge "$requested_ms" \
    || die 'backup producer predates this invocation'
  test "$completed_ms" -ge "$producer_started_ms" \
    || die 'backup completed before its producer started'
}

PM2_GUARD_ROOT=/etc/systemd/system.control
PM2_CANONICAL_UNIT_ROOT=/etc/systemd/system

pm2_guard_path() {
  case "$1" in
    pm2-dominguez.service|nexus-release-pm2-recovery-daemon.service)
      printf '%s/%s\n' "$PM2_GUARD_ROOT" "$1" ;;
    *) return 64 ;;
  esac
}

pm2_guard_root_is_exact() {
  sudo test -d "$PM2_GUARD_ROOT" && sudo test ! -L "$PM2_GUARD_ROOT" \
    && test "$(sudo stat -Lc '%U:%G:%a' -- "$PM2_GUARD_ROOT")" = root:root:755
}

ensure_pm2_guard_root() {
  if ! sudo test -e "$PM2_GUARD_ROOT" && ! sudo test -L "$PM2_GUARD_ROOT"; then
    sudo install -d -o root -g root -m 755 -- "$PM2_GUARD_ROOT" || return 1
  fi
  pm2_guard_root_is_exact
}

install_pm2_guard() {
  local guard unit
  unit="$1"; guard="$(pm2_guard_path "$unit")" || return 1
  ensure_pm2_guard_root || return 1
  if sudo test -e "$guard" || sudo test -L "$guard"; then
    sudo test -L "$guard" || return 1
  else
    sudo ln -s -- /dev/null "$guard" || return 1
  fi
  test "$(sudo readlink -- "$guard")" = /dev/null \
    && test "$(sudo stat -c '%U:%G:%F' -- "$guard")" = \
      'root:root:symbolic link'
}

pm2_guard_is_exact() {
  local active can_start fragment guard load unit
  unit="$1"; guard="$(pm2_guard_path "$unit")" || return 1
  pm2_guard_root_is_exact || return 1
  sudo test -L "$guard" \
    && test "$(sudo readlink -- "$guard")" = /dev/null \
    && test "$(sudo stat -c '%U:%G:%F' -- "$guard")" = \
      'root:root:symbolic link' || return 1
  load="$(sudo systemctl show "$unit" --property=LoadState --value)" \
    || return 1
  fragment="$(sudo systemctl show "$unit" --property=FragmentPath --value)" \
    || return 1
  can_start="$(sudo systemctl show "$unit" --property=CanStart --value)" \
    || return 1
  active="$(sudo systemctl show "$unit" --property=ActiveState --value)" \
    || return 1
  test "$load" = masked && test "$fragment" = "$guard" \
    && test "$can_start" = no && test "$active" = inactive
}

require_pm2_guard() {
  local unit
  for unit in pm2-dominguez.service nexus-release-pm2-recovery-daemon.service; do
    pm2_guard_is_exact "$unit" \
      || die "$unit is not protected by its exact high-priority runtime guard"
  done
}

pm2_fail_closed_is_exact() {
  local database handles listeners lsof_status path pgrep_status port suffix unit
  for unit in pm2-dominguez.service nexus-release-pm2-recovery-daemon.service; do
    pm2_guard_is_exact "$unit" || return 1
  done
  if sudo pgrep -u dominguez -f 'PM2.*God Daemon' >/dev/null; then
    return 1
  else
    pgrep_status=$?
  fi
  test "$pgrep_status" -eq 1 || return 1
  for port in 8100 8101 8200 8201; do
    if listeners="$(sudo lsof -nP -t -iTCP:"$port" -sTCP:LISTEN 2>&1)"; then
      return 1
    else
      lsof_status=$?
    fi
    test "$lsof_status" -eq 1 && test -z "$listeners" || return 1
  done
  for database in \
    /home/dominguez/telegram-hub-bot/data/bot.db \
    /home/dominguez/telegram-hub-bot-staging/data/bot.db \
    /home/dominguez/telegram-hub-bot/data/bot.db.next-bootstrap-recovery \
    /var/lib/nexus-hub/production/data/bot.db \
    /var/lib/nexus-hub/production/data/bot.db.next \
    /var/lib/nexus-hub/staging/data/bot.db \
    /var/lib/nexus-hub/staging/data/bot.db.next; do
    for suffix in '' -wal -shm -journal; do
      path="$database$suffix"
      if sudo test -e "$path" || sudo test -L "$path"; then
        if handles="$(sudo lsof -nP -t -- "$path" 2>&1)"; then
          return 1
        else
          lsof_status=$?
        fi
        test "$lsof_status" -eq 1 && test -z "$handles" || return 1
      fi
    done
  done
}

enforce_pm2_fail_closed() {
  local action_failed=0 unit
  if pm2_fail_closed_is_exact; then
    return 0
  fi
  run_pm2_as_dominguez stop \
    nexus-hub content-engine nexus-hub-staging content-engine-staging \
    || action_failed=1
  for unit in pm2-dominguez.service nexus-release-pm2-recovery-daemon.service; do
    sudo systemctl disable --now "$unit" || action_failed=1
    install_pm2_guard "$unit" || action_failed=1
  done
  sudo systemctl daemon-reload || action_failed=1
  run_pm2_as_dominguez kill || action_failed=1
  if pm2_fail_closed_is_exact; then
    return 0
  fi
  printf 'PM2 fail-closed postconditions remain false (action failures: %s)\n' \
    "$action_failed" >&2
  return 1
}

retire_canonical_pm2_guard() {
  local active can_start canonical fragment guard legacy_guard load unit
  unit="$1"
  test "$unit" = pm2-dominguez.service || return 64
  guard="$(pm2_guard_path "$unit")" || return 1
  canonical="$PM2_CANONICAL_UNIT_ROOT/$unit"
  legacy_guard="/run/systemd/system/$unit"
  pm2_guard_is_exact "$unit" || return 1
  sudo test -f "$canonical" && sudo test ! -L "$canonical" \
    && test "$(sudo stat -Lc '%U:%G:%a:%h' -- "$canonical")" = \
      'root:root:644:1' || return 1
  if sudo test -e "$legacy_guard" || sudo test -L "$legacy_guard"; then
    sudo test -L "$legacy_guard" \
      && test "$(sudo readlink -- "$legacy_guard")" = /dev/null \
      && test "$(sudo stat -c '%U:%G:%F' -- "$legacy_guard")" = \
        'root:root:symbolic link' || return 1
    sudo rm -- "$legacy_guard" || return 1
  fi
  sudo rm -- "$guard" || return 1
  sudo systemctl daemon-reload || return 1
  sudo test ! -e "$guard" && sudo test ! -L "$guard" || return 1
  sudo test ! -e "$legacy_guard" && sudo test ! -L "$legacy_guard" || return 1
  load="$(sudo systemctl show "$unit" --property=LoadState --value)" \
    || return 1
  fragment="$(sudo systemctl show "$unit" --property=FragmentPath --value)" \
    || return 1
  can_start="$(sudo systemctl show "$unit" --property=CanStart --value)" \
    || return 1
  active="$(sudo systemctl show "$unit" --property=ActiveState --value)" \
    || return 1
  test "$load" = loaded && test "$fragment" = "$canonical" \
    && test "$can_start" = yes && test "$active" = inactive
}

require_canonical_database() {
  local database expected_identity
  database="$1"
  expected_identity="${2:-}"
  sudo test -f "$database" && sudo test ! -L "$database" \
    || die "database is missing or symbolic: $database"
  test "$(sudo readlink -f -- "$database")" = "$database" \
    || die "database path is not canonical: $database"
  test "$(sudo stat -Lc '%F:%h' -- "$database")" = 'regular file:1' \
    || die "database is not a single-link regular file: $database"
  if test -n "$expected_identity"; then
    test "$(sudo stat -Lc '%d:%i' -- "$database")" = "$expected_identity" \
      || die "database identity differs from immutable capture: $database"
  fi
  require_no_open_handles "$database"
  require_no_sqlite_sidecars "$database"
  require_valid_sqlite "$database"
}

publish_durable_recovery_state_stage() {
  local stage
  stage="$1"
  sudo test -f "$stage" && sudo test ! -L "$stage" \
    || die 'recovery state stage is missing or symbolic'
  test "$(sudo stat -Lc '%U:%G:%a:%h' -- "$stage")" = \
    'root:root:600:1' || die 'recovery state stage metadata is unsafe'
  sudo sync -f "$stage"
  sudo mv -T -- "$stage" "$RECOVERY_STATE"
  sudo test -f "$RECOVERY_STATE" && sudo test ! -L "$RECOVERY_STATE" \
    || die 'recovery state publication is missing or symbolic'
  test "$(sudo stat -Lc '%U:%G:%a:%h' -- "$RECOVERY_STATE")" = \
    'root:root:600:1' || die 'recovery state publication metadata is unsafe'
  sudo sync -f "$RECOVERY_STATE"
  sudo sync -f "$(dirname "$RECOVERY_STATE")"
}

append_interrupted_restart_history() {
  local kind logical path role sha size state_stage state_temp
  kind="$1"; role="$2"; path="$3"; sha="$4"; size="$5"
  logical="${6:-}"
  sudo jq -e --arg path "$path" --arg sha "$sha" --argjson size "$size" \
    'all(.interruptedRestartHistory[]?;
      .path != $path or (.sha256 == $sha and .sizeBytes == $size))' \
    "$RECOVERY_STATE" >/dev/null \
    || die "interrupted-restart history conflicts with archive: $path"
  state_temp="$(mktemp)"; state_stage="$RECOVERY_STATE.next-$BASHPID"
  sudo jq --arg kind "$kind" --arg role "$role" --arg path "$path" \
    --arg sha "$sha" --argjson size "$size" --arg logical "$logical" \
    --arg updatedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '.interruptedRestartHistory = (.interruptedRestartHistory // [])
     | if any(.interruptedRestartHistory[]?; .path == $path)
       then .
       else .interruptedRestartHistory += [{kind:$kind,role:$role,path:$path,
         sha256:$sha,sizeBytes:$size,
         logicalDigest:(if $logical == "" then null else $logical end)}]
       end
     | .updatedAt = $updatedAt' "$RECOVERY_STATE" >"$state_temp"
  sudo test ! -e "$state_stage" && sudo test ! -L "$state_stage" \
    || die 'interrupted-restart history state staging path exists'
  sudo install -o root -g root -m 600 "$state_temp" "$state_stage"
  rm -f "$state_temp"
  publish_durable_recovery_state_stage "$state_stage"
}

retire_interrupted_restart_stages() {
  local archive base expected_digest expected_logical expected_raw kind
  local link_count logical raw_sha role size suffix
  local sibling stage
  local -a siblings stages
  role="$1"
  test -z "$(sudo find "$INCIDENT_DIR" -maxdepth 1 \
    -name ".${role}-pm2-interrupted-restart.next-*.db" ! -type f -print -quit)" \
    || die "$role interrupted-restart staging path has an unsafe type"
  mapfile -d '' -t stages < <(sudo find "$INCIDENT_DIR" -maxdepth 1 -type f \
    -name ".${role}-pm2-interrupted-restart.next-*.db" -print0)
  for stage in "${stages[@]}"; do
    test "$(sudo stat -Lc '%U:%G:%a:%F' -- "$stage")" = \
      'root:root:600:regular file' \
      || die "$role interrupted-restart stage metadata is unsafe"
    require_no_open_handles "$stage"
    require_no_sqlite_sidecars "$stage"
    link_count="$(sudo stat -Lc '%h' -- "$stage")"
    if test "$link_count" = 2; then
      mapfile -d '' -t siblings < <(sudo find "$INCIDENT_DIR" -maxdepth 1 \
        -type f -samefile "$stage" -print0)
      test "${#siblings[@]}" -eq 2 \
        || die "$role interrupted-restart published stage has ambiguous links"
      sibling=''
      for archive in "${siblings[@]}"; do
        if test "$archive" != "$stage"; then sibling="$archive"; fi
      done
      test -n "$sibling" || die "$role interrupted-restart archive link is missing"
      base="$(basename "$sibling")"
      raw_sha="$(sudo sha256sum "$sibling" | awk '{print $1}')"
      size="$(sudo stat -Lc '%s' -- "$sibling")"
      case "$base" in
        "$role-pm2-interrupted-restart-partial-"*.db)
          expected_digest="${base#"$role-pm2-interrupted-restart-partial-"}"
          expected_digest="${expected_digest%.db}"
          test "$raw_sha" = "$expected_digest" \
            || die "$role partial archive name does not bind its exact bytes"
          kind=partial-stage; logical='' ;;
        "$role-pm2-interrupted-restart-"*.db)
          suffix="${base#"$role-pm2-interrupted-restart-"}"
          suffix="${suffix%.db}"
          expected_logical="${suffix%%-*}"
          expected_raw="${suffix#*-}"
          [[ "$expected_logical" =~ ^[0-9a-f]{64}$ \
            && "$expected_raw" =~ ^[0-9a-f]{64}$ ]] \
            || die "$role guarded archive name is not digest-bound"
          test "$raw_sha" = "$expected_raw" \
            || die "$role guarded archive name does not bind its exact bytes"
          require_valid_sqlite "$sibling"
          logical="$(logical_digest "$sibling")"
          test "$logical" = "$expected_logical" \
            || die "$role guarded archive name does not bind its logical digest"
          kind=guarded-sqlite ;;
        *) die "$role interrupted-restart stage links an unknown archive" ;;
      esac
      sudo sync -f "$sibling"
      sudo rm -- "$stage"
      sudo sync -f "$INCIDENT_DIR"
      test "$(sudo stat -Lc '%U:%G:%a:%h' -- "$sibling")" = \
        'root:root:600:1' || die "$role recovered archive metadata is unsafe"
      append_interrupted_restart_history \
        "$kind" "$role" "$sibling" "$raw_sha" "$size" "$logical"
      continue
    fi
    test "$link_count" = 1 \
      || die "$role interrupted-restart stage has an unsafe link count"
    raw_sha="$(sudo sha256sum "$stage" | awk '{print $1}')"
    size="$(sudo stat -Lc '%s' -- "$stage")"
    archive="$INCIDENT_DIR/$role-pm2-interrupted-restart-partial-$raw_sha.db"
    if sudo test -e "$archive" || sudo test -L "$archive"; then
      sudo test -f "$archive" && sudo test ! -L "$archive" \
        || die "$role partial interrupted-restart archive is unsafe"
      test "$(sudo stat -Lc '%U:%G:%a:%h:%s' -- "$archive")" = \
        "root:root:600:1:$size" \
        || die "$role partial archive metadata differs"
      sudo cmp -s -- "$stage" "$archive" \
        || die "$role partial archive differs from its exact stage"
    else
      sudo ln -- "$stage" "$archive" \
        || die "$role partial archive appeared concurrently"
      sudo sync -f "$archive"
      sudo rm -- "$stage"
      sudo sync -f "$INCIDENT_DIR"
    fi
    if sudo test -e "$stage"; then
      sudo rm -- "$stage"
      sudo sync -f "$INCIDENT_DIR"
    fi
    test "$(sudo stat -Lc '%U:%G:%a:%h:%s' -- "$archive")" = \
      "root:root:600:1:$size" || die "$role partial archive publication is unsafe"
    sudo sync -f "$archive"
    sudo sync -f "$INCIDENT_DIR"
    append_interrupted_restart_history \
      partial-stage "$role" "$archive" "$raw_sha" "$size"
  done
}

publish_interrupted_restart_archive() {
  local archive logical raw_sha role size source stage
  source="$1"; role="$2"; logical="$3"
  retire_interrupted_restart_stages "$role"
  stage="$(sudo mktemp \
    "$INCIDENT_DIR/.${role}-pm2-interrupted-restart.next-$BASHPID.XXXXXX.db")"
  sudo chmod 600 "$stage"
  test "$(sudo stat -Lc '%U:%G:%a:%h' -- "$stage")" = \
    'root:root:600:1' || die "$role interrupted-restart stage is unsafe"
  sudo sqlite3 "$source" ".backup '$stage'"
  require_valid_sqlite "$stage"
  test "$(logical_digest "$stage")" = "$logical" \
    || die "$role interrupted-restart stage differs from guarded PM2 data"
  sudo sync -f "$stage"
  raw_sha="$(sudo sha256sum "$stage" | awk '{print $1}')"
  size="$(sudo stat -Lc '%s' -- "$stage")"
  archive="$INCIDENT_DIR/$role-pm2-interrupted-restart-$logical-$raw_sha.db"
  if sudo test -e "$archive" || sudo test -L "$archive"; then
    sudo test -f "$archive" && sudo test ! -L "$archive" \
      || die "$role interrupted-restart archive is unsafe"
    test "$(sudo stat -Lc '%U:%G:%a:%h:%s' -- "$archive")" = \
      "root:root:600:1:$size" \
      || die "$role interrupted-restart archive metadata differs"
    sudo cmp -s -- "$stage" "$archive" \
      || die "$role interrupted-restart archive differs from its exact stage"
    require_valid_sqlite "$archive"
    test "$(logical_digest "$archive")" = "$logical" \
      || die "$role existing archive differs from its logical address"
    sudo rm -- "$stage"
    sudo sync -f "$INCIDENT_DIR"
  else
    sudo ln -- "$stage" "$archive" \
      || die "$role interrupted-restart archive appeared concurrently"
    sudo sync -f "$archive"
    sudo rm -- "$stage"
    sudo sync -f "$INCIDENT_DIR"
  fi
  test "$(sudo stat -Lc '%U:%G:%a:%h:%s' -- "$archive")" = \
    "root:root:600:1:$size" \
    || die "$role interrupted-restart archive publication is unsafe"
  sudo sync -f "$archive"
  sudo sync -f "$INCIDENT_DIR"
  append_interrupted_restart_history \
    guarded-sqlite "$role" "$archive" "$raw_sha" "$size" "$logical"
}

LIVE_PRODUCTION=/var/lib/nexus-hub/production/data/bot.db
LIVE_STAGING=/var/lib/nexus-hub/staging/data/bot.db
PM2_PRODUCTION=/home/dominguez/telegram-hub-bot/data/bot.db
PM2_STAGING=/home/dominguez/telegram-hub-bot-staging/data/bot.db
PM2_PRODUCTION_BASE=/home/dominguez/telegram-hub-bot
PM2_STAGING_BASE=/home/dominguez/telegram-hub-bot-staging
BASELINE_FILE=/var/lib/nexus-release/state/bootstrap-baseline.json
RUNTIME_EVIDENCE=/var/lib/nexus-release/state/bootstrap-legacy-runtime.json
USER_RELEASE_LOCK=/home/dominguez/.local/state/nexus-release/.release.lock
MAINTENANCE_LOCK=/run/lock/nexus-release-sonar.lock
BACKUP_ENV=/etc/nexus-local-backup/backup.env
RECOVERY_STATE=/var/lib/nexus-release/state/bootstrap-first-cutover-recovery.json
RECOVERY_INCIDENT_ROOT=/var/lib/nexus-release/incidents/bootstrap-recovery

prove_durable_running_pm2() {
  local app artifact backup_path baseline_production_sha baseline_staging_sha
  local cwd database enabled_state exec_path expected_identity marker_sha
  local pm2_json role row runtime source_sha staging_identity state_phase
  sudo test -f "$RECOVERY_STATE" && sudo test ! -L "$RECOVERY_STATE" \
    || return 1
  test "$(sudo stat -Lc '%U:%G:%a:%h' -- "$RECOVERY_STATE")" \
    = 'root:root:600:1' || return 1
  state_phase="$(sudo jq -er \
    '.schema == "nexus.bootstrap-first-cutover-recovery.v1"
     and (.phase == "backup_repointed" or .phase == "pm2_restored")
     and (.swappedPm2ProductionIdentity | test("^[0-9]+:[0-9]+$"))
     and (.pm2Staging.identity | test("^[0-9]+:[0-9]+$"))
     | .phase' "$RECOVERY_STATE")" || return 1
  sudo test -f "$BASELINE_FILE" && sudo test ! -L "$BASELINE_FILE" \
    && sudo test -f "$RUNTIME_EVIDENCE" && sudo test ! -L "$RUNTIME_EVIDENCE" \
    || return 1
  test "$(sudo sha256sum "$BASELINE_FILE" | awk '{print $1}')" = \
    "$(sudo jq -er .baselineSha256 "$RECOVERY_STATE")" || return 1
  test "$(sudo sha256sum "$RUNTIME_EVIDENCE" | awk '{print $1}')" = \
    "$(sudo jq -er .runtimeCaptureSha256 "$RECOVERY_STATE")" || return 1
  baseline_production_sha="$(sudo jq -er \
    '.legacyRuntime.productionSourceSha | select(test("^[0-9a-f]{40}$"))' \
    "$BASELINE_FILE")" || return 1
  baseline_staging_sha="$(sudo jq -er \
    '.legacyRuntime.stagingSourceSha | select(test("^[0-9a-f]{40}$"))' \
    "$BASELINE_FILE")" || return 1
  sudo jq -e --arg productionSha "$baseline_production_sha" \
    --arg stagingSha "$baseline_staging_sha" \
    '.schema == "nexus.bootstrap-legacy-runtime-capture.v2"
     and .productionSourceSha == $productionSha
     and .stagingSourceSha == $stagingSha' "$RUNTIME_EVIDENCE" >/dev/null \
    || return 1

  expected_identity="$(sudo jq -er .swappedPm2ProductionIdentity \
    "$RECOVERY_STATE")" || return 1
  staging_identity="$(sudo jq -er .pm2Staging.identity "$RECOVERY_STATE")" \
    || return 1
  for SPEC in "$PM2_PRODUCTION:$expected_identity" "$PM2_STAGING:$staging_identity"; do
    database="${SPEC%%:*}"; EXPECTED_DATABASE_IDENTITY="${SPEC#*:}"
    sudo test -f "$database" && sudo test ! -L "$database" || return 1
    test "$(sudo readlink -f -- "$database")" = "$database" || return 1
    test "$(sudo stat -Lc '%U:%G:%a:%h:%d:%i' -- "$database")" = \
      "dominguez:dominguez:600:1:$EXPECTED_DATABASE_IDENTITY" || return 1
  done
  sudo test -f "$BACKUP_ENV" && sudo test ! -L "$BACKUP_ENV" || return 1
  test "$(sudo stat -Lc '%U:%G:%a:%h' -- "$BACKUP_ENV")" = \
    'root:root:600:1' || return 1
  backup_path="$(sudo awk -F= \
    '$1 == "NEXUS_LOCAL_BACKUP_DATABASE_PATH" { count += 1; value = substr($0, index($0, "=") + 1) }
     END { if (count == 1) print value }' "$BACKUP_ENV")"
  test "$backup_path" = "$PM2_PRODUCTION" \
    && test "$(sudo jq -er .backupDatabasePath "$RECOVERY_STATE")" = \
      "$PM2_PRODUCTION" || return 1
  test "$(sudo systemctl show pm2-dominguez.service \
      --property=LoadState --value)" = loaded \
    && test "$(sudo systemctl show pm2-dominguez.service \
      --property=FragmentPath --value)" = \
      /etc/systemd/system/pm2-dominguez.service \
    && test "$(sudo systemctl show pm2-dominguez.service \
      --property=CanStart --value)" = yes \
    && test "$(sudo systemctl show pm2-dominguez.service \
      --property=ActiveState --value)" = active \
    && test "$(sudo systemctl is-enabled pm2-dominguez.service)" = enabled \
    || return 1
  pm2_guard_is_exact nexus-release-pm2-recovery-daemon.service || return 1

  for role in production staging; do
    if test "$role" = production; then
      runtime="$(sudo jq -er .productionRuntimePath "$RUNTIME_EVIDENCE")"
      source_sha="$baseline_production_sha"
      artifact="$(sudo jq -er .productionArtifactDigest "$RUNTIME_EVIDENCE")"
      marker_sha="$(sudo jq -er .productionMarkerSha256 "$RUNTIME_EVIDENCE")"
      test "$(sudo readlink -f -- "$PM2_PRODUCTION_BASE/current")" = "$runtime" \
        || return 1
      PROVED_PRODUCTION_RUNTIME="$runtime"
      PROVED_PRODUCTION_ARTIFACT="$artifact"
    else
      runtime="$(sudo jq -er .stagingRuntimePath "$RUNTIME_EVIDENCE")"
      source_sha="$baseline_staging_sha"
      artifact="$(sudo jq -er .stagingArtifactDigest "$RUNTIME_EVIDENCE")"
      marker_sha="$(sudo jq -er .stagingMarkerSha256 "$RUNTIME_EVIDENCE")"
      test "$(sudo readlink -f -- "$PM2_STAGING_BASE/current")" = "$runtime" \
        || return 1
      PROVED_STAGING_RUNTIME="$runtime"
      PROVED_STAGING_ARTIFACT="$artifact"
    fi
    test "$(sudo sha256sum "$runtime/.complete.json" | awk '{print $1}')" = \
      "$marker_sha" || return 1
    verify_installed_runtime "$runtime" "$source_sha" "$artifact" || return 1
  done

  pm2_json="$(run_pm2_as_dominguez jlist)" || return 1
  for app in nexus-hub content-engine nexus-hub-staging content-engine-staging; do
    case "$app" in
      nexus-hub)
        source_sha="$baseline_production_sha"; artifact="$PROVED_PRODUCTION_ARTIFACT"
        cwd="$PROVED_PRODUCTION_RUNTIME"; exec_path="$cwd/dist/index.js"
        role=production; EXPECTED_BASE="$PM2_PRODUCTION_BASE"
        database="$PM2_PRODUCTION" ;;
      content-engine)
        source_sha="$baseline_production_sha"; artifact="$PROVED_PRODUCTION_ARTIFACT"
        cwd="$PROVED_PRODUCTION_RUNTIME/content-engine"; exec_path=/usr/bin/python3.12
        role=production; EXPECTED_BASE="$PM2_PRODUCTION_BASE"; database='' ;;
      nexus-hub-staging)
        source_sha="$baseline_staging_sha"; artifact="$PROVED_STAGING_ARTIFACT"
        cwd="$PROVED_STAGING_RUNTIME"; exec_path="$cwd/dist/index.js"
        role=staging; EXPECTED_BASE="$PM2_STAGING_BASE"; database="$PM2_STAGING" ;;
      content-engine-staging)
        source_sha="$baseline_staging_sha"; artifact="$PROVED_STAGING_ARTIFACT"
        cwd="$PROVED_STAGING_RUNTIME/content-engine"; exec_path=/usr/bin/python3.12
        role=staging; EXPECTED_BASE="$PM2_STAGING_BASE"; database='' ;;
    esac
    row="$(jq -ce --arg app "$app" '[.[] | select(.name == $app)]
      | if length == 1 then .[0] else error("PM2 identity is ambiguous") end' \
      <<<"$pm2_json")" || return 1
    test "$(jq -er .pm2_env.status <<<"$row")" = online \
      && test "$(jq -er '.pm2_env.NEXUS_RELEASE_SHA // .pm2_env.GIT_COMMIT' \
        <<<"$row")" = "$source_sha" \
      && test "$(jq -er .pm2_env.NEXUS_RELEASE_ARTIFACT_SHA256 <<<"$row")" = "$artifact" \
      && test "$(jq -er .pm2_env.pm_cwd <<<"$row")" = "$cwd" \
      && test "$(jq -er .pm2_env.pm_exec_path <<<"$row")" = "$exec_path" \
      && test "$(jq -er .pm2_env.NEXUS_RELEASE_ROLE <<<"$row")" = "$role" \
      && test "$(jq -er .pm2_env.NEXUS_RELEASE_BASE_DIR <<<"$row")" = "$EXPECTED_BASE" \
      && test "$(jq -er '.pid | type == "number" and . > 0' <<<"$row")" = true \
      || return 1
    if test -n "$database"; then
      test "$(jq -er .pm2_env.DATABASE_PATH <<<"$row")" = "$database" || return 1
    fi
  done
  wait_for_all_pm2_health || return 1
  PROVED_RECOVERY_PHASE="$state_phase"
}

publish_early_pm2_restored() {
  local state_stage state_temp
  state_temp="$(mktemp)"; state_stage="$RECOVERY_STATE.next-$BASHPID"
  sudo jq --arg updatedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '.phase = "pm2_restored" | .backupDatabasePath =
       "/home/dominguez/telegram-hub-bot/data/bot.db"
     | .updatedAt = $updatedAt' "$RECOVERY_STATE" >"$state_temp"
  sudo test ! -e "$state_stage" && sudo test ! -L "$state_stage" || return 1
  sudo install -o root -g root -m 600 "$state_temp" "$state_stage"
  rm -f "$state_temp"
  publish_durable_recovery_state_stage "$state_stage"
  test "$(sudo stat -Lc '%U:%G:%a:%h' -- "$RECOVERY_STATE")" = \
    'root:root:600:1'
}

test "$(sudo stat -c '%U:%G:%a' -- "$USER_RELEASE_LOCK")" \
  = 'dominguez:dominguez:600' || die 'user release lock is unsafe'
test "$(sudo stat -c '%U:%G:%a' -- "$MAINTENANCE_LOCK")" \
  = 'root:dominguez:660' || die 'shared maintenance mutex is unsafe'
test ! -L "$USER_RELEASE_LOCK" && test ! -L "$MAINTENANCE_LOCK" \
  || die 'a release mutex is symbolic'
exec 9<>"$USER_RELEASE_LOCK"
flock -n 9 || die 'another PM2 release or capability transaction is active'
exec 8<>"$MAINTENANCE_LOCK"
flock -n 8 || die 'another root maintenance or container release is active'

# Arm cleanup before observing any missing guard. The unguarded-authority
# reconciliation below may wait for health or publish the durable recovery
# phase; interruption anywhere in that branch must close PM2 again.
PM2_RESTART_ARMED=1
fail_closed_bootstrap_restart() {
  local status=$?
  trap - EXIT HUP INT TERM
  if test "$status" -ne 0 && test "$PM2_RESTART_ARMED" -eq 1; then
    if ! enforce_pm2_fail_closed; then
      printf 'FATAL: bootstrap restart cleanup could not prove fail-closed postconditions\n' >&2
      exit 70
    fi
  fi
  exit "$status"
}
trap fail_closed_bootstrap_restart EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

# Read the durable phase before requiring the guard: SIGKILL can occur after
# exact PM2 start but before `pm2_restored` publication. Accept that window only
# when all four rows, PIDs, database inodes, runtime trees, authority units, and
# health endpoints prove exact. Any partial identity is stopped and masked
# before ordinary guarded recovery resumes.
PM2_FORCED_GUARD=0
PM2_GUARD_OBSERVED=1
for UNIT in pm2-dominguez.service nexus-release-pm2-recovery-daemon.service; do
  if ! pm2_guard_is_exact "$UNIT"; then
    PM2_GUARD_OBSERVED=0
  fi
done
if test "$PM2_GUARD_OBSERVED" -eq 0; then
  if prove_durable_running_pm2; then
    if test "$PROVED_RECOVERY_PHASE" = backup_repointed; then
      publish_early_pm2_restored \
        || die 'exact running PM2 proof could not be published durably'
    fi
    PM2_RESTART_ARMED=0
    trap - EXIT HUP INT TERM
    printf 'PM2 fallback was already exact and healthy; state is pm2_restored\n'
    exit 0
  fi
  PM2_FORCED_GUARD=1
  enforce_pm2_fail_closed \
    || die 'forced PM2 guard could not prove fail-closed postconditions'
fi
require_pm2_guard
test "$(sudo stat -Lc '%U:%G:%a:%h' -- "$BASELINE_FILE")" \
  = 'root:root:600:1' || die 'bootstrap baseline is unsafe'
sudo test ! -L "$BASELINE_FILE" || die 'bootstrap baseline is symbolic'
test "$(sudo stat -Lc '%U:%G:%a:%h' -- "$RUNTIME_EVIDENCE")" \
  = 'root:root:600:1' || die 'legacy runtime capture is unsafe'
sudo test ! -L "$RUNTIME_EVIDENCE" || die 'legacy runtime capture is symbolic'
BASELINE_PRODUCTION_SHA="$(sudo jq -er \
  '.legacyRuntime.productionSourceSha
   | select(test("^[0-9a-f]{40}$"))' "$BASELINE_FILE")"
BASELINE_STAGING_SHA="$(sudo jq -er \
  '.legacyRuntime.stagingSourceSha
   | select(test("^[0-9a-f]{40}$"))' "$BASELINE_FILE")"
sudo jq -e --arg productionSha "$BASELINE_PRODUCTION_SHA" \
  --arg stagingSha "$BASELINE_STAGING_SHA" \
  '.schema == "nexus.bootstrap-legacy-runtime-capture.v2"
   and .productionSourceSha == $productionSha
   and .stagingSourceSha == $stagingSha
   and (.productionDatabaseIdentity | test("^[0-9]+:[0-9]+$"))
   and (.stagingDatabaseIdentity | test("^[0-9]+:[0-9]+$"))' \
  "$RUNTIME_EVIDENCE" >/dev/null \
  || die 'legacy runtime capture differs from the bootstrap baseline'
CAPTURED_PM2_PRODUCTION_IDENTITY="$(sudo jq -er \
  .productionDatabaseIdentity "$RUNTIME_EVIDENCE")"
CAPTURED_PM2_STAGING_IDENTITY="$(sudo jq -er \
  .stagingDatabaseIdentity "$RUNTIME_EVIDENCE")"
BASELINE_SHA256="$(sudo sha256sum "$BASELINE_FILE" | awk '{print $1}')"
RUNTIME_CAPTURE_SHA256="$(sudo sha256sum "$RUNTIME_EVIDENCE" | awk '{print $1}')"

sudo systemctl stop nexus-release-poller.timer
sudo systemctl stop nexus-release-bootstrap.service
for PROJECT in nexus-production nexus-staging; do
  mapfile -t CONTAINERS < <(sudo docker ps -aq \
    --filter "label=com.docker.compose.project=$PROJECT")
  if test "${#CONTAINERS[@]}" -gt 0; then
    sudo docker rm --force "${CONTAINERS[@]}"
  fi
  test -z "$(sudo docker ps -aq \
    --filter "label=com.docker.compose.project=$PROJECT")" \
    || die "$PROJECT still has containers"
done

remove_proven_stale_wal_sidecars "$LIVE_PRODUCTION" "$LIVE_STAGING"
require_canonical_database "$LIVE_PRODUCTION"
require_canonical_database "$LIVE_STAGING"
require_canonical_database "$PM2_STAGING" "$CAPTURED_PM2_STAGING_IDENTITY"
require_canonical_database "$PM2_PRODUCTION"
LIVE_PRODUCTION_IDENTITY="$(sudo stat -Lc '%d:%i' -- "$LIVE_PRODUCTION")"
LIVE_STAGING_IDENTITY="$(sudo stat -Lc '%d:%i' -- "$LIVE_STAGING")"
LIVE_PRODUCTION_DIGEST="$(logical_digest "$LIVE_PRODUCTION")"
LIVE_STAGING_DIGEST="$(logical_digest "$LIVE_STAGING")"
PM2_PRODUCTION_IDENTITY="$(sudo stat -Lc '%d:%i' -- "$PM2_PRODUCTION")"
PM2_STAGING_IDENTITY="$(sudo stat -Lc '%d:%i' -- "$PM2_STAGING")"
PM2_PRODUCTION_DIGEST="$(logical_digest "$PM2_PRODUCTION")"
PM2_STAGING_DIGEST="$(logical_digest "$PM2_STAGING")"

sudo test -f "$BACKUP_ENV" && sudo test ! -L "$BACKUP_ENV" \
  || die 'backup environment is missing or symbolic'
test "$(sudo stat -Lc '%U:%G:%a:%h' -- "$BACKUP_ENV")" = 'root:root:600:1' \
  || die 'backup environment owner, mode, or link count is unsafe'
test "$(sudo awk -F= \
  '$1 == "NEXUS_LOCAL_BACKUP_DATABASE_PATH" { count += 1 } END { print count + 0 }' \
  "$BACKUP_ENV")" = 1 || die 'backup database path is absent or duplicated'
CURRENT_BACKUP_DATABASE="$(sudo awk -F= \
  '$1 == "NEXUS_LOCAL_BACKUP_DATABASE_PATH" { print substr($0, index($0, "=") + 1) }' \
  "$BACKUP_ENV")"
case "$CURRENT_BACKUP_DATABASE" in
  "$LIVE_PRODUCTION"|"$PM2_PRODUCTION") ;;
  *) die 'backup database path is outside bootstrap recovery' ;;
esac

publish_recovery_state() {
  local backup_path phase state_stage state_temp swapped_identity
  phase="$1"
  backup_path="$2"
  swapped_identity="${3:-}"
  state_temp="$(mktemp)"
  sudo jq --arg phase "$phase" --arg backupPath "$backup_path" \
    --arg swappedIdentity "$swapped_identity" \
    --arg updatedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '.phase = $phase
     | .backupDatabasePath = $backupPath
     | .swappedPm2ProductionIdentity =
         (if $swappedIdentity == "" then null else $swappedIdentity end)
     | .updatedAt = $updatedAt' "$RECOVERY_STATE" >"$state_temp"
  state_stage="$RECOVERY_STATE.next-$BASHPID"
  sudo test ! -e "$state_stage" && sudo test ! -L "$state_stage" \
    || die 'bootstrap recovery state staging path exists'
  sudo install -o root -g root -m 600 "$state_temp" "$state_stage"
  rm -f "$state_temp"
  publish_durable_recovery_state_stage "$state_stage"
  test "$(sudo stat -Lc '%U:%G:%a:%h' -- "$RECOVERY_STATE")" \
    = 'root:root:600:1' || die 'bootstrap recovery state publication is unsafe'
}

if sudo test -e "$RECOVERY_STATE" || sudo test -L "$RECOVERY_STATE"; then
  sudo test ! -L "$RECOVERY_STATE" || die 'bootstrap recovery state is symbolic'
  test "$(sudo stat -Lc '%U:%G:%a:%h' -- "$RECOVERY_STATE")" \
    = 'root:root:600:1' || die 'bootstrap recovery state is unsafe'
  sudo jq -e --arg baseline "$BASELINE_SHA256" \
    --arg capture "$RUNTIME_CAPTURE_SHA256" \
    --arg liveProductionIdentity "$LIVE_PRODUCTION_IDENTITY" \
    --arg liveProductionDigest "$LIVE_PRODUCTION_DIGEST" \
    --arg liveStagingIdentity "$LIVE_STAGING_IDENTITY" \
    --arg liveStagingDigest "$LIVE_STAGING_DIGEST" \
    --arg stagingIdentity "$PM2_STAGING_IDENTITY" \
    --arg stagingDigest "$PM2_STAGING_DIGEST" \
    --argjson forcedGuard "$PM2_FORCED_GUARD" \
    '.schema == "nexus.bootstrap-first-cutover-recovery.v1"
     and .baselineSha256 == $baseline
     and .runtimeCaptureSha256 == $capture
     and .liveProduction.identity == $liveProductionIdentity
     and .liveProduction.logicalDigest == $liveProductionDigest
     and .liveStaging.identity == $liveStagingIdentity
     and .liveStaging.logicalDigest == $liveStagingDigest
     and .pm2Staging.identity == $stagingIdentity
     and ($forcedGuard == 1 or .pm2Staging.logicalDigest == $stagingDigest)
     and (.incidentDir | startswith("/var/lib/nexus-release/incidents/bootstrap-recovery/"))
     and (.phase == "captured" or .phase == "production_swapped"
          or .phase == "backup_repointed" or .phase == "pm2_restored")' \
    "$RECOVERY_STATE" >/dev/null \
    || die 'bootstrap recovery state differs from current immutable evidence'
  INCIDENT_DIR="$(sudo jq -er .incidentDir "$RECOVERY_STATE")"
  RECOVERY_PHASE="$(sudo jq -er .phase "$RECOVERY_STATE")"
  OBSERVED_PM2_PRODUCTION_IDENTITY="$(sudo jq -er \
    .observedPm2Production.identity "$RECOVERY_STATE")"
  OBSERVED_PM2_PRODUCTION_DIGEST="$(sudo jq -er \
    .observedPm2Production.logicalDigest "$RECOVERY_STATE")"
  if test "$RECOVERY_PHASE" = production_swapped \
      || test "$RECOVERY_PHASE" = backup_repointed \
      || test "$RECOVERY_PHASE" = pm2_restored; then
    EXPECTED_SWAPPED_IDENTITY="$(sudo jq -er \
      '.swappedPm2ProductionIdentity
       | select(test("^[0-9]+:[0-9]+$"))' "$RECOVERY_STATE")"
    test "$PM2_PRODUCTION_IDENTITY" = "$EXPECTED_SWAPPED_IDENTITY" \
      || die 'swapped PM2 production inode changed after durable recovery state'
  fi
else
  if test "$PM2_PRODUCTION_IDENTITY" != "$CAPTURED_PM2_PRODUCTION_IDENTITY" \
      && test "$PM2_PRODUCTION_DIGEST" != "$LIVE_PRODUCTION_DIGEST"; then
    die 'PM2 production is neither the captured legacy inode nor the failed container data'
  fi
  if test "$CURRENT_BACKUP_DATABASE" = "$PM2_PRODUCTION" \
      && test "$PM2_PRODUCTION_DIGEST" != "$LIVE_PRODUCTION_DIGEST"; then
    die 'backup already targets PM2 but PM2 does not contain failed-container writes'
  fi
  STAMP="$(date -u +%Y%m%dT%H%M%SZ)-$BASHPID"
  INCIDENT_DIR="$RECOVERY_INCIDENT_ROOT/$STAMP"
  sudo install -d -o root -g root -m 700 \
    /var/lib/nexus-release/incidents "$RECOVERY_INCIDENT_ROOT"
  sudo test ! -e "$INCIDENT_DIR" || die 'bootstrap recovery incident path exists'
  sudo mkdir "$INCIDENT_DIR"
  sudo chown root:root "$INCIDENT_DIR"
  sudo chmod 700 "$INCIDENT_DIR"
  for PAIR in \
    "$LIVE_PRODUCTION:$INCIDENT_DIR/production-container.db:$LIVE_PRODUCTION_DIGEST" \
    "$LIVE_STAGING:$INCIDENT_DIR/staging-container.db:$LIVE_STAGING_DIGEST" \
    "$PM2_PRODUCTION:$INCIDENT_DIR/production-pm2-observed.db:$PM2_PRODUCTION_DIGEST" \
    "$PM2_STAGING:$INCIDENT_DIR/staging-pm2.db:$PM2_STAGING_DIGEST"; do
    SOURCE="${PAIR%%:*}"
    REST="${PAIR#*:}"
    DESTINATION="${REST%%:*}"
    EXPECTED_DIGEST="${REST##*:}"
    sudo sqlite3 "$SOURCE" ".backup '$DESTINATION'"
    sudo chmod 600 "$DESTINATION"
    require_valid_sqlite "$DESTINATION"
    test "$(logical_digest "$DESTINATION")" = "$EXPECTED_DIGEST" \
      || die "incident snapshot differs from source: $SOURCE"
  done
  OBSERVED_PM2_PRODUCTION_IDENTITY="$PM2_PRODUCTION_IDENTITY"
  OBSERVED_PM2_PRODUCTION_DIGEST="$PM2_PRODUCTION_DIGEST"
  if test "$CURRENT_BACKUP_DATABASE" = "$PM2_PRODUCTION"; then
    RECOVERY_PHASE=production_swapped
    SWAPPED_IDENTITY="$PM2_PRODUCTION_IDENTITY"
  elif test "$PM2_PRODUCTION_IDENTITY" = "$CAPTURED_PM2_PRODUCTION_IDENTITY"; then
    RECOVERY_PHASE=captured
    SWAPPED_IDENTITY=''
  else
    RECOVERY_PHASE=production_swapped
    SWAPPED_IDENTITY="$PM2_PRODUCTION_IDENTITY"
  fi
  RECOVERY_STATE_TEMP="$(mktemp)"
  jq -cn --arg createdAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg baselineSha256 "$BASELINE_SHA256" \
    --arg runtimeCaptureSha256 "$RUNTIME_CAPTURE_SHA256" \
    --arg incidentDir "$INCIDENT_DIR" --arg phase "$RECOVERY_PHASE" \
    --arg backupDatabasePath "$CURRENT_BACKUP_DATABASE" \
    --arg liveProductionIdentity "$LIVE_PRODUCTION_IDENTITY" \
    --arg liveProductionDigest "$LIVE_PRODUCTION_DIGEST" \
    --arg liveStagingIdentity "$LIVE_STAGING_IDENTITY" \
    --arg liveStagingDigest "$LIVE_STAGING_DIGEST" \
    --arg observedProductionIdentity "$PM2_PRODUCTION_IDENTITY" \
    --arg observedProductionDigest "$PM2_PRODUCTION_DIGEST" \
    --arg capturedProductionIdentity "$CAPTURED_PM2_PRODUCTION_IDENTITY" \
    --arg stagingIdentity "$PM2_STAGING_IDENTITY" \
    --arg stagingDigest "$PM2_STAGING_DIGEST" \
    --arg swappedIdentity "$SWAPPED_IDENTITY" \
    '{schema:"nexus.bootstrap-first-cutover-recovery.v1",createdAt:$createdAt,
      updatedAt:$createdAt,baselineSha256:$baselineSha256,
      runtimeCaptureSha256:$runtimeCaptureSha256,incidentDir:$incidentDir,
      phase:$phase,backupDatabasePath:$backupDatabasePath,
      liveProduction:{path:"/var/lib/nexus-hub/production/data/bot.db",
        identity:$liveProductionIdentity,logicalDigest:$liveProductionDigest},
      liveStaging:{path:"/var/lib/nexus-hub/staging/data/bot.db",
        identity:$liveStagingIdentity,logicalDigest:$liveStagingDigest},
      observedPm2Production:{path:"/home/dominguez/telegram-hub-bot/data/bot.db",
        identity:$observedProductionIdentity,logicalDigest:$observedProductionDigest},
      capturedPm2ProductionIdentity:$capturedProductionIdentity,
      pm2Staging:{path:"/home/dominguez/telegram-hub-bot-staging/data/bot.db",
        identity:$stagingIdentity,logicalDigest:$stagingDigest},
      swappedPm2ProductionIdentity:
        (if $swappedIdentity == "" then null else $swappedIdentity end)}' \
    >"$RECOVERY_STATE_TEMP"
  RECOVERY_STATE_STAGE="$RECOVERY_STATE.next-$BASHPID"
  sudo test ! -e "$RECOVERY_STATE_STAGE" && sudo test ! -L "$RECOVERY_STATE_STAGE" \
    || die 'bootstrap recovery state staging path exists'
  sudo install -o root -g root -m 600 \
    "$RECOVERY_STATE_TEMP" "$RECOVERY_STATE_STAGE"
  rm -f "$RECOVERY_STATE_TEMP"
  # Both release locks serialize the absent final name, so an atomic rename
  # avoids the link/unlink SIGKILL window and publishes with link count one.
  publish_durable_recovery_state_stage "$RECOVERY_STATE_STAGE"
fi

if test "$RECOVERY_PHASE" = captured; then
  if test "$PM2_PRODUCTION_IDENTITY" = "$OBSERVED_PM2_PRODUCTION_IDENTITY" \
      && test "$PM2_PRODUCTION_DIGEST" = "$OBSERVED_PM2_PRODUCTION_DIGEST"; then
    test "$CURRENT_BACKUP_DATABASE" = "$LIVE_PRODUCTION" \
      || die 'captured phase requires backup still bound to container production'
    fresh_backup_for "$LIVE_PRODUCTION"
    remove_proven_stale_wal_sidecars "$LIVE_PRODUCTION" "$LIVE_STAGING"
    PM2_NEXT="$PM2_PRODUCTION.next-bootstrap-recovery"
    if sudo test -e "$PM2_NEXT" || sudo test -L "$PM2_NEXT"; then
      sudo test -f "$PM2_NEXT" && sudo test ! -L "$PM2_NEXT" \
        || die 'PM2 recovery temporary path is not a regular non-symbolic file'
      test "$(sudo readlink -f -- "$PM2_NEXT")" = "$PM2_NEXT" \
        || die 'PM2 recovery temporary path is not canonical'
      test "$(sudo stat -Lc '%F:%h' -- "$PM2_NEXT")" = 'regular file:1' \
        || die 'PM2 recovery temporary path is not a single-link regular file'
      require_no_open_handles "$PM2_NEXT"
      require_no_sqlite_sidecars "$PM2_NEXT"
      PM2_NEXT_SHA256="$(sudo sha256sum "$PM2_NEXT" | awk '{print $1}')"
      PM2_NEXT_SIZE="$(sudo stat -Lc '%s' -- "$PM2_NEXT")"
      PM2_NEXT_ARCHIVE="$INCIDENT_DIR/production-pm2-next-$PM2_NEXT_SHA256.db"
      if sudo test -e "$PM2_NEXT_ARCHIVE" || sudo test -L "$PM2_NEXT_ARCHIVE"; then
        sudo test -f "$PM2_NEXT_ARCHIVE" && sudo test ! -L "$PM2_NEXT_ARCHIVE" \
          || die 'PM2 recovery temporary archive is unsafe'
        sudo cmp -s -- "$PM2_NEXT" "$PM2_NEXT_ARCHIVE" \
          || die 'PM2 recovery temporary archive differs from guarded source'
      else
        PM2_NEXT_ARCHIVE_STAGE="$PM2_NEXT_ARCHIVE.next-$BASHPID"
        sudo test ! -e "$PM2_NEXT_ARCHIVE_STAGE" \
          && sudo test ! -L "$PM2_NEXT_ARCHIVE_STAGE" \
          || die 'PM2 recovery temporary archive staging path exists'
        sudo install -o root -g root -m 600 \
          "$PM2_NEXT" "$PM2_NEXT_ARCHIVE_STAGE"
        sudo cmp -s -- "$PM2_NEXT" "$PM2_NEXT_ARCHIVE_STAGE" \
          || die 'PM2 recovery temporary archive copy differs'
        sudo sync -f "$PM2_NEXT_ARCHIVE_STAGE"
        # The held locks serialize this absent digest-addressed final name.
        # Rename publishes it atomically with no link/unlink kill window.
        sudo mv -T -- "$PM2_NEXT_ARCHIVE_STAGE" "$PM2_NEXT_ARCHIVE"
        sudo sync -f "$PM2_NEXT_ARCHIVE"
        sudo sync -f "$INCIDENT_DIR"
      fi
      test "$(sudo stat -Lc '%U:%G:%a:%h:%s' -- "$PM2_NEXT_ARCHIVE")" = \
        "root:root:600:1:$PM2_NEXT_SIZE" \
        || die 'PM2 recovery temporary archive metadata is unsafe'
      sudo sync -f "$PM2_NEXT_ARCHIVE"
      sudo sync -f "$INCIDENT_DIR"
      PM2_NEXT_STATE_TEMP="$(mktemp)"
      PM2_NEXT_STATE_STAGE="$RECOVERY_STATE.next-$BASHPID"
      sudo jq --arg path "$PM2_NEXT_ARCHIVE" --arg sha256 "$PM2_NEXT_SHA256" \
        --argjson sizeBytes "$PM2_NEXT_SIZE" \
        --arg updatedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
        '.pm2NextArchives = (.pm2NextArchives // [])
         | if any(.pm2NextArchives[]?;
             .path == $path and .sha256 == $sha256 and .sizeBytes == $sizeBytes)
           then .
           else .pm2NextArchives += [{path:$path,sha256:$sha256,sizeBytes:$sizeBytes}]
           end
         | .updatedAt = $updatedAt' "$RECOVERY_STATE" >"$PM2_NEXT_STATE_TEMP"
      sudo test ! -e "$PM2_NEXT_STATE_STAGE" \
        && sudo test ! -L "$PM2_NEXT_STATE_STAGE" \
        || die 'PM2 recovery state staging path exists during candidate archival'
      sudo install -o root -g root -m 600 \
        "$PM2_NEXT_STATE_TEMP" "$PM2_NEXT_STATE_STAGE"
      rm -f "$PM2_NEXT_STATE_TEMP"
      publish_durable_recovery_state_stage "$PM2_NEXT_STATE_STAGE"
      sudo sync -f "$INCIDENT_DIR"
      sudo rm -- "$PM2_NEXT"
      sudo test ! -e "$PM2_NEXT" && sudo test ! -L "$PM2_NEXT" \
        || die 'guarded PM2 recovery temporary path was not retired'
    fi
    sudo sqlite3 "$LIVE_PRODUCTION" ".backup '$PM2_NEXT'"
    require_canonical_database "$PM2_NEXT"
    test "$(logical_digest "$PM2_NEXT")" = "$LIVE_PRODUCTION_DIGEST" \
      || die 'PM2 recovery temporary snapshot differs from container production'
    sudo chown dominguez:dominguez "$PM2_NEXT"
    sudo chmod 600 "$PM2_NEXT"
    test "$(sudo stat -Lc '%U:%G:%a:%h' -- "$PM2_NEXT")" \
      = 'dominguez:dominguez:600:1' \
      || die 'PM2 recovery temporary snapshot metadata is unsafe'
    sudo mv -f -- "$PM2_NEXT" "$PM2_PRODUCTION"
    require_canonical_database "$PM2_PRODUCTION"
    test "$(sudo stat -Lc '%U:%G:%a:%h' -- "$PM2_PRODUCTION")" \
      = 'dominguez:dominguez:600:1' \
      || die 'restored PM2 production metadata is unsafe'
    PM2_PRODUCTION_IDENTITY="$(sudo stat -Lc '%d:%i' -- "$PM2_PRODUCTION")"
    PM2_PRODUCTION_DIGEST="$(logical_digest "$PM2_PRODUCTION")"
  elif test "$PM2_PRODUCTION_DIGEST" != "$LIVE_PRODUCTION_DIGEST"; then
    die 'PM2 production changed outside the durable recovery transaction'
  fi
  test "$PM2_PRODUCTION_DIGEST" = "$LIVE_PRODUCTION_DIGEST" \
    || die 'PM2 production does not contain failed-container writes'
  RECOVERY_PHASE=production_swapped
  publish_recovery_state "$RECOVERY_PHASE" "$CURRENT_BACKUP_DATABASE" \
    "$PM2_PRODUCTION_IDENTITY"
fi

if test "$RECOVERY_PHASE" = production_swapped; then
  test "$(logical_digest "$PM2_PRODUCTION")" = "$LIVE_PRODUCTION_DIGEST" \
    || die 'swapped PM2 production changed before backup repoint'
  if test "$CURRENT_BACKUP_DATABASE" = "$LIVE_PRODUCTION"; then
    sudo sed -i \
      "s#^NEXUS_LOCAL_BACKUP_DATABASE_PATH=.*#NEXUS_LOCAL_BACKUP_DATABASE_PATH=$PM2_PRODUCTION#" \
      "$BACKUP_ENV"
    CURRENT_BACKUP_DATABASE="$PM2_PRODUCTION"
  fi
  test "$CURRENT_BACKUP_DATABASE" = "$PM2_PRODUCTION" \
    || die 'backup repoint did not settle on PM2 production'
  fresh_backup_for "$PM2_PRODUCTION"
  remove_proven_stale_wal_sidecars "$PM2_PRODUCTION" "$PM2_STAGING"
  RECOVERY_PHASE=backup_repointed
  publish_recovery_state "$RECOVERY_PHASE" "$PM2_PRODUCTION" \
    "$(sudo stat -Lc '%d:%i' -- "$PM2_PRODUCTION")"
else
  test "$RECOVERY_PHASE" = backup_repointed \
      || test "$RECOVERY_PHASE" = pm2_restored \
    || die "unsupported bootstrap recovery phase: $RECOVERY_PHASE"
  test "$CURRENT_BACKUP_DATABASE" = "$PM2_PRODUCTION" \
    || die 'durable backup-repointed phase disagrees with backup environment'
  PM2_PRODUCTION_DIGEST="$(logical_digest "$PM2_PRODUCTION")"
  PM2_STAGING_DIGEST="$(logical_digest "$PM2_STAGING")"
  EXPECTED_STATE_STAGING_DIGEST="$(sudo jq -er \
    .pm2Staging.logicalDigest "$RECOVERY_STATE")"
  if test "$PM2_PRODUCTION_DIGEST" != "$LIVE_PRODUCTION_DIGEST" \
      || test "$PM2_STAGING_DIGEST" != "$EXPECTED_STATE_STAGING_DIGEST"; then
    test "$PM2_FORCED_GUARD" -eq 1 \
      || die 'guarded PM2 data changed after the durable backup-repointed phase'
    # A partially proved post-start state may already contain legitimate writes.
    # Preserve both exact guarded databases in append-only, logical-digest-
    # addressed history; never overwrite them with older snapshots.
    publish_interrupted_restart_archive \
      "$PM2_PRODUCTION" production "$PM2_PRODUCTION_DIGEST"
    publish_interrupted_restart_archive \
      "$PM2_STAGING" staging "$PM2_STAGING_DIGEST"
    INTERRUPTED_STATE_TEMP="$(mktemp)"
    INTERRUPTED_STATE_STAGE="$RECOVERY_STATE.next-$BASHPID"
    sudo jq --arg stagingDigest "$PM2_STAGING_DIGEST" \
      --arg updatedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      '.pm2Staging.logicalDigest = $stagingDigest
       | .updatedAt = $updatedAt' "$RECOVERY_STATE" >"$INTERRUPTED_STATE_TEMP"
    sudo test ! -e "$INTERRUPTED_STATE_STAGE" \
      && sudo test ! -L "$INTERRUPTED_STATE_STAGE" \
      || die 'interrupted-restart state staging path exists'
    sudo install -o root -g root -m 600 \
      "$INTERRUPTED_STATE_TEMP" "$INTERRUPTED_STATE_STAGE"
    rm -f "$INTERRUPTED_STATE_TEMP"
    publish_durable_recovery_state_stage "$INTERRUPTED_STATE_STAGE"
  fi
  fresh_backup_for "$PM2_PRODUCTION"
  remove_proven_stale_wal_sidecars "$PM2_PRODUCTION" "$PM2_STAGING"
fi
for DB in "$PM2_PRODUCTION" "$PM2_STAGING"; do
  test "$(sudo stat -Lc '%U:%G:%a:%h' -- "$DB")" \
    = 'dominguez:dominguez:600:1' \
    || die "PM2 database metadata is unsafe before restart: $DB"
done

# The baseline-recorded legacy source identities must still name the exact
# installed PM2 release trees before the systemd resurrection guard is undone.
test "$(sudo stat -c '%U:%G:%a' -- "$BASELINE_FILE")" = 'root:root:600' \
  || die 'bootstrap baseline owner or mode is unsafe'
BASELINE_PRODUCTION_SHA="$(sudo jq -er \
  '.legacyRuntime.productionSourceSha
   | select(test("^[0-9a-f]{40}$"))' "$BASELINE_FILE")"
BASELINE_STAGING_SHA="$(sudo jq -er \
  '.legacyRuntime.stagingSourceSha
   | select(test("^[0-9a-f]{40}$"))' "$BASELINE_FILE")"
test "$(sudo stat -Lc '%U:%G:%a:%h' -- "$RUNTIME_EVIDENCE")" \
  = 'root:root:600:1' || die 'legacy runtime capture is unsafe'
sudo test ! -L "$RUNTIME_EVIDENCE" || die 'legacy runtime capture is symbolic'
sudo jq -e --arg productionSha "$BASELINE_PRODUCTION_SHA" \
  --arg stagingSha "$BASELINE_STAGING_SHA" \
  '.schema == "nexus.bootstrap-legacy-runtime-capture.v2"
   and .productionSourceSha == $productionSha
   and .stagingSourceSha == $stagingSha
   and (.productionArtifactDigest | test("^[0-9a-f]{64}$"))
   and (.stagingArtifactDigest | test("^[0-9a-f]{64}$"))
   and (.productionMarkerSha256 | test("^[0-9a-f]{64}$"))
   and (.stagingMarkerSha256 | test("^[0-9a-f]{64}$"))' \
  "$RUNTIME_EVIDENCE" >/dev/null \
  || die 'legacy runtime capture differs from the bootstrap baseline'
for ROLE in production staging; do
  if test "$ROLE" = production; then
    LEGACY_BASE="$PM2_PRODUCTION_BASE"
    EXPECTED_SOURCE_SHA="$BASELINE_PRODUCTION_SHA"
    EXPECTED_RUNTIME="$(sudo jq -er .productionRuntimePath "$RUNTIME_EVIDENCE")"
    EXPECTED_ARTIFACT="$(sudo jq -er .productionArtifactDigest "$RUNTIME_EVIDENCE")"
    EXPECTED_MARKER_SHA="$(sudo jq -er .productionMarkerSha256 "$RUNTIME_EVIDENCE")"
    PRODUCTION_RUNTIME="$EXPECTED_RUNTIME"
    PRODUCTION_ARTIFACT_DIGEST="$EXPECTED_ARTIFACT"
  else
    LEGACY_BASE="$PM2_STAGING_BASE"
    EXPECTED_SOURCE_SHA="$BASELINE_STAGING_SHA"
    EXPECTED_RUNTIME="$(sudo jq -er .stagingRuntimePath "$RUNTIME_EVIDENCE")"
    EXPECTED_ARTIFACT="$(sudo jq -er .stagingArtifactDigest "$RUNTIME_EVIDENCE")"
    EXPECTED_MARKER_SHA="$(sudo jq -er .stagingMarkerSha256 "$RUNTIME_EVIDENCE")"
    STAGING_RUNTIME="$EXPECTED_RUNTIME"
    STAGING_ARTIFACT_DIGEST="$EXPECTED_ARTIFACT"
  fi
  test "$(sudo readlink -f -- "$LEGACY_BASE/current")" = "$EXPECTED_RUNTIME" \
    || die "$ROLE legacy current selector differs from the runtime capture"
  test "$(sudo sha256sum "$EXPECTED_RUNTIME/.complete.json" | awk '{print $1}')" \
    = "$EXPECTED_MARKER_SHA" || die "$ROLE legacy runtime marker changed"
  sudo jq -e --arg sha "$EXPECTED_SOURCE_SHA" --arg artifact "$EXPECTED_ARTIFACT" \
    '.schema == "nexus.release-bundle.v1"
     and .runtimeSha == $sha and .artifactDigest == $artifact' \
    "$EXPECTED_RUNTIME/.complete.json" >/dev/null \
    || die "$ROLE legacy runtime marker differs from captured identity"
  verify_installed_runtime "$EXPECTED_RUNTIME" "$EXPECTED_SOURCE_SHA" \
    "$EXPECTED_ARTIFACT" \
    || die "$ROLE installed runtime tree differs from captured artifact"
done

# This is the only success/failure branch that removes the first-cutover PM2
# guard from the audited canonical authority. Keep the temporary recovery daemon
# behind its high-priority runtime-control guard throughout restoration, so
# there is no activation window.
pm2_guard_is_exact nexus-release-pm2-recovery-daemon.service \
  || die 'temporary PM2 authority lost its exact high-priority runtime guard'
retire_canonical_pm2_guard pm2-dominguez.service \
  || die 'canonical PM2 high-priority runtime guard could not be retired safely'
sudo systemctl enable --now pm2-dominguez.service
run_pm2_as_dominguez start content-engine content-engine-staging
run_pm2_as_dominguez start nexus-hub nexus-hub-staging
PM2_JSON="$(run_pm2_as_dominguez jlist)"
for APP in nexus-hub content-engine nexus-hub-staging content-engine-staging; do
  case "$APP" in
    nexus-hub)
      EXPECTED_SOURCE_SHA="$BASELINE_PRODUCTION_SHA"
      EXPECTED_ARTIFACT="$PRODUCTION_ARTIFACT_DIGEST"
      EXPECTED_CWD="$PRODUCTION_RUNTIME"
      EXPECTED_EXEC="$PRODUCTION_RUNTIME/dist/index.js"
      EXPECTED_ROLE=production
      EXPECTED_BASE="$PM2_PRODUCTION_BASE"
      EXPECTED_DATABASE="$PM2_PRODUCTION"
      ;;
    content-engine)
      EXPECTED_SOURCE_SHA="$BASELINE_PRODUCTION_SHA"
      EXPECTED_ARTIFACT="$PRODUCTION_ARTIFACT_DIGEST"
      EXPECTED_CWD="$PRODUCTION_RUNTIME/content-engine"
      EXPECTED_EXEC=/usr/bin/python3.12
      EXPECTED_ROLE=production
      EXPECTED_BASE="$PM2_PRODUCTION_BASE"
      EXPECTED_DATABASE=''
      ;;
    nexus-hub-staging)
      EXPECTED_SOURCE_SHA="$BASELINE_STAGING_SHA"
      EXPECTED_ARTIFACT="$STAGING_ARTIFACT_DIGEST"
      EXPECTED_CWD="$STAGING_RUNTIME"
      EXPECTED_EXEC="$STAGING_RUNTIME/dist/index.js"
      EXPECTED_ROLE=staging
      EXPECTED_BASE="$PM2_STAGING_BASE"
      EXPECTED_DATABASE="$PM2_STAGING"
      ;;
    content-engine-staging)
      EXPECTED_SOURCE_SHA="$BASELINE_STAGING_SHA"
      EXPECTED_ARTIFACT="$STAGING_ARTIFACT_DIGEST"
      EXPECTED_CWD="$STAGING_RUNTIME/content-engine"
      EXPECTED_EXEC=/usr/bin/python3.12
      EXPECTED_ROLE=staging
      EXPECTED_BASE="$PM2_STAGING_BASE"
      EXPECTED_DATABASE=''
      ;;
  esac
  ROW="$(jq -ce --arg app "$APP" \
    '[.[] | select(.name == $app)]
     | if length == 1 then .[0] else error("PM2 identity is ambiguous") end' \
    <<<"$PM2_JSON")" || die "$APP PM2 identity is ambiguous after restart"
  test "$(jq -er .pm2_env.status <<<"$ROW")" = online \
    || die "$APP did not return online"
  test "$(jq -er '.pm2_env.NEXUS_RELEASE_SHA // .pm2_env.GIT_COMMIT' \
    <<<"$ROW")" = "$EXPECTED_SOURCE_SHA" \
    || die "$APP restarted with a source SHA outside the bootstrap baseline"
  test "$(jq -er .pm2_env.NEXUS_RELEASE_ARTIFACT_SHA256 <<<"$ROW")" \
    = "$EXPECTED_ARTIFACT" || die "$APP restarted with a different artifact"
  test "$(jq -er .pm2_env.pm_cwd <<<"$ROW")" = "$EXPECTED_CWD" \
    || die "$APP restarted outside the captured runtime"
  test "$(jq -er .pm2_env.pm_exec_path <<<"$ROW")" = "$EXPECTED_EXEC" \
    || die "$APP restarted with a different executable"
  test "$(jq -er .pm2_env.NEXUS_RELEASE_ROLE <<<"$ROW")" = "$EXPECTED_ROLE" \
    || die "$APP restarted with a different role"
  test "$(jq -er .pm2_env.NEXUS_RELEASE_BASE_DIR <<<"$ROW")" = "$EXPECTED_BASE" \
    || die "$APP restarted with a different base directory"
  test "$(jq -er '.pid | type == "number" and . > 0' <<<"$ROW")" = true \
    || die "$APP has no live process identity"
  if test -n "$EXPECTED_DATABASE"; then
    test "$(jq -er .pm2_env.DATABASE_PATH <<<"$ROW")" = "$EXPECTED_DATABASE" \
      || die "$APP restarted against a different database"
  fi
done
wait_for_all_pm2_health \
  || die 'PM2 fallback did not make all four health endpoints ready within 120 seconds'
publish_recovery_state pm2_restored "$PM2_PRODUCTION" \
  "$(sudo stat -Lc '%d:%i' -- "$PM2_PRODUCTION")"
PM2_RESTART_ARMED=0
trap - EXIT HUP INT TERM
printf 'PM2 fallback restored; incident evidence: %s\n' "$INCIDENT_DIR"
```

Run the ordinary locked poller once so any mutation-admitting interrupted state
settles to a durable `rollback_failed` receipt. Inspect `release:cd:ack -- --show`
and acknowledge only that exact failed release. `unprovable_active_release`
cannot be acknowledged; missing payload, backup, or database proof remains a
manual incident.

Before another bootstrap attempt, publish a **new** signed `main` payload, leave
the timer disabled, and run this reset/rebaseline branch as one transaction.
It stops all four PM2 writers, re-copies both authoritative PM2 databases, moves
the old target-bound baseline into root-only incident evidence, creates a new
baseline with the explicit registry credential, and leaves PM2 stopped for the
next bootstrap unit invocation.

```bash
set -euo pipefail

die() { printf 'BOOTSTRAP REBASELINE REFUSED: %s\n' "$*" >&2; exit 1; }

PM2_RETIREMENT_JOURNAL=/var/lib/nexus-release/state/pm2-fallback-retirement.json
PM2_RETIRED_TOMBSTONE=/var/lib/nexus-release/state/pm2-fallback-retired.json
for PM2_RETIREMENT_GATE in "$PM2_RETIREMENT_JOURNAL" "$PM2_RETIRED_TOMBSTONE"; do
  sudo test ! -e "$PM2_RETIREMENT_GATE" \
    && sudo test ! -L "$PM2_RETIREMENT_GATE" \
    || die "PM2 fallback retirement gate exists: $PM2_RETIREMENT_GATE"
done
unset PM2_RETIREMENT_GATE

run_pm2_as_dominguez() {
  local pm2_cwd=/home/dominguez
  (cd "$pm2_cwd" && sudo -u dominguez pm2 "$@")
}

require_no_open_handles() {
  local db suffix error_file handles lsof_status
  local -a candidates
  for db in "$@"; do
    sudo test -f "$db" || die "missing database: $db"
    candidates+=("$db")
    for suffix in -wal -shm -journal; do
      if sudo test -e "$db$suffix"; then candidates+=("$db$suffix"); fi
    done
  done
  error_file="$(mktemp)"
  if handles="$(sudo lsof -t -- "${candidates[@]}" 2>"$error_file")"; then
    lsof_status=0
  else
    lsof_status=$?
  fi
  if test -s "$error_file"; then
    sed 's/^/lsof: /' "$error_file" >&2
    rm -f "$error_file"
    die 'open-handle probe produced an error'
  fi
  rm -f "$error_file"
  case "$lsof_status" in
    0) die "database handles remain open: $handles" ;;
    1) test -z "$handles" || die 'lsof returned output with no-match status' ;;
    *) die "lsof failed with status $lsof_status" ;;
  esac
}

require_no_sqlite_sidecars() {
  local db suffix
  for db in "$@"; do
    for suffix in -wal -shm -journal; do
      sudo test ! -e "$db$suffix" || die "SQLite sidecar remains: $db$suffix"
    done
  done
}

require_valid_sqlite() {
  local db integrity foreign_keys
  db="$1"
  integrity="$(sudo sqlite3 "file:$db?mode=ro" 'PRAGMA integrity_check;')"
  test "$integrity" = 'ok' || die "integrity_check failed for $db: $integrity"
  foreign_keys="$(sudo sqlite3 "file:$db?mode=ro" 'PRAGMA foreign_key_check;')"
  test -z "$foreign_keys" || die "foreign_key_check failed for $db: $foreign_keys"
}

logical_digest() {
  sudo sqlite3 "file:$1?mode=ro" '.dump' | sha256sum | awk '{print $1}'
}

remove_proven_stale_wal_sidecars() {
  local checkpoint db metadata
  local -a stale_sidecars
  for db in "$@"; do
    stale_sidecars=()
    require_no_open_handles "$db"
    checkpoint="$(sudo sqlite3 "$db" 'PRAGMA wal_checkpoint(TRUNCATE);')"
    test "$checkpoint" = '0|0|0' \
      || die "zero-WAL checkpoint proof failed for $db: $checkpoint"
    require_no_open_handles "$db"
    sudo test ! -e "$db-journal" \
      || die "rollback journal cannot be classified stale: $db-journal"
    if sudo test -e "$db-wal"; then
      metadata="$(sudo stat -c '%F:%h:%s' -- "$db-wal")"
      test "$metadata" = 'regular empty file:1:0' \
        || die "WAL sidecar is not a single-link zero-byte regular file: $db-wal"
      stale_sidecars+=("$db-wal")
    fi
    if sudo test -e "$db-shm"; then
      metadata="$(sudo stat -c '%F:%h' -- "$db-shm")"
      test "$metadata" = 'regular file:1' \
        || die "SHM sidecar is not a single-link regular file: $db-shm"
      stale_sidecars+=("$db-shm")
    fi
    if test "${#stale_sidecars[@]}" -gt 0; then
      sudo rm -- "${stale_sidecars[@]}"
    fi
    require_no_open_handles "$db"
    require_no_sqlite_sidecars "$db"
  done
}

require_local_backup_installation() {
  local active_mode active_root destination dropins exec_start expected_sha
  local fragment load mode relative source spec unit
  sudo test -L /opt/nexus-release/checkout \
    && test "$(sudo stat -c '%U:%G:%F' -- /opt/nexus-release/checkout)" = \
      'root:root:symbolic link' \
    || die 'active control-plane selector is unsafe'
  active_root="$(sudo readlink -f -- /opt/nexus-release/checkout)"
  [[ "$active_root" =~ ^/opt/nexus-release/control-plane/[0-9a-f]{40}$ ]] \
    || die 'active control-plane selector escapes its immutable version root'
  sudo test -d "$active_root" && sudo test ! -L "$active_root" \
    && test "$(sudo stat -Lc '%U:%G' -- "$active_root")" = root:root \
    || die 'active immutable control-plane root is unsafe'
  active_mode="$(sudo stat -Lc '%a' -- "$active_root")"
  test $((8#$active_mode & 0222)) -eq 0 \
    || die 'active immutable control-plane root is writable'
  expected_sha="${active_root##*/}"
  test "$(sudo cat "$active_root/.nexus-control-plane-ready")" = \
    "$expected_sha https://github.com/felipedrf74/cortex-telegram-hub-bot.git /usr/bin/node:v22.23.1" \
    || die 'active immutable control-plane marker is invalid'
  for spec in \
    'scripts/local-backup.py|/usr/local/libexec/nexus-local-backup/local-backup.py|755' \
    'scripts/local-backup-retry-launcher.sh|/usr/local/libexec/nexus-local-backup/local-backup-retry-launcher.sh|755' \
    'ops/local-backup/systemd/nexus-local-backup.service|/etc/systemd/system/nexus-local-backup.service|644' \
    'ops/local-backup/systemd/nexus-local-backup.timer|/etc/systemd/system/nexus-local-backup.timer|644' \
    'ops/local-backup/systemd/nexus-local-backup-pre-promotion.service|/etc/systemd/system/nexus-local-backup-pre-promotion.service|644' \
    'ops/local-backup/systemd/nexus-local-backup-restore-verify.service|/etc/systemd/system/nexus-local-backup-restore-verify.service|644' \
    'ops/local-backup/systemd/nexus-local-backup-restore-verify.timer|/etc/systemd/system/nexus-local-backup-restore-verify.timer|644' \
    'ops/local-backup/nexus-local-backup.sudoers|/etc/sudoers.d/nexus-local-backup|440'; do
    IFS='|' read -r relative destination mode <<<"$spec"
    source="$active_root/$relative"
    sudo test -f "$source" && sudo test ! -L "$source" \
      || die "immutable local-backup source is unsafe: $relative"
    sudo test -f "$destination" && sudo test ! -L "$destination" \
      && test "$(sudo stat -Lc '%U:%G:%a:%h' -- "$destination")" = \
        "root:root:$mode:1" \
      || die "installed local-backup asset metadata is unsafe: $destination"
    sudo cmp -s -- "$source" "$destination" \
      || die "installed local-backup asset differs from immutable source: $destination"
  done
  sudo visudo -cf /etc/sudoers.d/nexus-local-backup >/dev/null \
    || die 'installed local-backup sudoers policy is invalid'
  sudo systemctl daemon-reload
  for unit in nexus-local-backup.service nexus-local-backup.timer \
    nexus-local-backup-pre-promotion.service \
    nexus-local-backup-restore-verify.service \
    nexus-local-backup-restore-verify.timer; do
    load="$(sudo systemctl show "$unit" --property=LoadState --value)"
    fragment="$(sudo systemctl show "$unit" --property=FragmentPath --value)"
    dropins="$(sudo systemctl show "$unit" --property=DropInPaths --value)"
    test "$load" = loaded \
      && test "$fragment" = "/etc/systemd/system/$unit" \
      && test -z "$dropins" \
      || die "$unit does not resolve to its exact installed bytes"
  done
  test "$(sudo systemctl show nexus-local-backup-pre-promotion.service \
    --property=Type --value)" = oneshot \
    || die 'pre-promotion backup unit is not Type=oneshot'
  exec_start="$(sudo systemctl show nexus-local-backup-pre-promotion.service \
    --property=ExecStart --value)"
  case "$exec_start" in
    *'path=/usr/local/libexec/nexus-local-backup/local-backup.py ; argv[]=/usr/local/libexec/nexus-local-backup/local-backup.py pre-promotion ;'*) ;;
    *) die 'pre-promotion backup unit has an unexpected effective ExecStart' ;;
  esac
}

fresh_backup_for() {
  require_local_backup_installation
  local completed_ms expected producer_started_ms receipt requested_ms
  expected="$1"
  # Root-owned SQLite evidence reads may recreate empty WAL/SHM files. Prove
  # them stale and remove them at the final quiesced boundary before the
  # descriptor-bound backup producer opens the configured database.
  remove_proven_stale_wal_sidecars "$expected"
  require_no_sqlite_sidecars "$expected"
  receipt=/srv/nexus-backups/application/state/last-success.json
  requested_ms="$(date +%s%3N)"
  sudo systemctl start nexus-local-backup-pre-promotion.service
  test "$(sudo systemctl show nexus-local-backup-pre-promotion.service \
    --property=Result --value)" = success || die 'governed backup unit failed'
  sudo jq -e --arg expectedDatabase "$expected" \
    '.schema == "nexus.local-backup.v1"
     and .status == "passed" and .kind == "pre-promotion"
     and .backupRoot == "/srv/nexus-backups/application"
     and .database == $expectedDatabase
     and (.encryptedSha256 | test("^[0-9a-f]{64}$"))
     and (.encryptedSizeBytes | type == "number" and . > 0 and floor == .)
     and (.startedAt | type == "string") and (.completedAt | type == "string")' \
    "$receipt" >/dev/null || die 'governed backup receipt contract failed'
  producer_started_ms="$(date -d "$(sudo jq -er .startedAt "$receipt")" +%s%3N)"
  completed_ms="$(date -d "$(sudo jq -er .completedAt "$receipt")" +%s%3N)"
  test "$producer_started_ms" -ge "$requested_ms" \
    || die 'backup producer predates this invocation'
  test "$completed_ms" -ge "$producer_started_ms" \
    || die 'backup completed before its producer started'
}

PM2_GUARD_ROOT=/etc/systemd/system.control

pm2_guard_path() {
  case "$1" in
    pm2-dominguez.service|nexus-release-pm2-recovery-daemon.service)
      printf '%s/%s\n' "$PM2_GUARD_ROOT" "$1" ;;
    *) return 64 ;;
  esac
}

pm2_guard_root_is_exact() {
  sudo test -d "$PM2_GUARD_ROOT" && sudo test ! -L "$PM2_GUARD_ROOT" \
    && test "$(sudo stat -Lc '%U:%G:%a' -- "$PM2_GUARD_ROOT")" = root:root:755
}

ensure_pm2_guard_root() {
  if ! sudo test -e "$PM2_GUARD_ROOT" && ! sudo test -L "$PM2_GUARD_ROOT"; then
    sudo install -d -o root -g root -m 755 -- "$PM2_GUARD_ROOT" || return 1
  fi
  pm2_guard_root_is_exact
}

install_pm2_guard() {
  local guard unit
  unit="$1"; guard="$(pm2_guard_path "$unit")" || return 1
  ensure_pm2_guard_root || return 1
  if sudo test -e "$guard" || sudo test -L "$guard"; then
    sudo test -L "$guard" || return 1
  else
    sudo ln -s -- /dev/null "$guard" || return 1
  fi
  test "$(sudo readlink -- "$guard")" = /dev/null \
    && test "$(sudo stat -c '%U:%G:%F' -- "$guard")" = \
      'root:root:symbolic link'
}

pm2_guard_is_exact() {
  local active can_start fragment guard load unit
  unit="$1"; guard="$(pm2_guard_path "$unit")" || return 1
  pm2_guard_root_is_exact || return 1
  sudo test -L "$guard" \
    && test "$(sudo readlink -- "$guard")" = /dev/null \
    && test "$(sudo stat -c '%U:%G:%F' -- "$guard")" = \
      'root:root:symbolic link' || return 1
  load="$(sudo systemctl show "$unit" --property=LoadState --value)" \
    || return 1
  fragment="$(sudo systemctl show "$unit" --property=FragmentPath --value)" \
    || return 1
  can_start="$(sudo systemctl show "$unit" --property=CanStart --value)" \
    || return 1
  active="$(sudo systemctl show "$unit" --property=ActiveState --value)" \
    || return 1
  test "$load" = masked && test "$fragment" = "$guard" \
    && test "$can_start" = no && test "$active" = inactive
}

require_pm2_guard() {
  local unit
  for unit in pm2-dominguez.service nexus-release-pm2-recovery-daemon.service; do
    pm2_guard_is_exact "$unit" \
      || die "$unit is not protected by its exact high-priority runtime guard"
  done
}

pm2_fail_closed_is_exact() {
  local database handles listeners lsof_status path pgrep_status port suffix unit
  for unit in pm2-dominguez.service nexus-release-pm2-recovery-daemon.service; do
    pm2_guard_is_exact "$unit" || return 1
  done
  if sudo pgrep -u dominguez -f 'PM2.*God Daemon' >/dev/null; then
    return 1
  else
    pgrep_status=$?
  fi
  test "$pgrep_status" -eq 1 || return 1
  for port in 8100 8101 8200 8201; do
    if listeners="$(sudo lsof -nP -t -iTCP:"$port" -sTCP:LISTEN 2>&1)"; then
      return 1
    else
      lsof_status=$?
    fi
    test "$lsof_status" -eq 1 && test -z "$listeners" || return 1
  done
  for database in \
    /home/dominguez/telegram-hub-bot/data/bot.db \
    /home/dominguez/telegram-hub-bot-staging/data/bot.db \
    /home/dominguez/telegram-hub-bot/data/bot.db.next-bootstrap-recovery \
    /var/lib/nexus-hub/production/data/bot.db \
    /var/lib/nexus-hub/production/data/bot.db.next \
    /var/lib/nexus-hub/staging/data/bot.db \
    /var/lib/nexus-hub/staging/data/bot.db.next; do
    for suffix in '' -wal -shm -journal; do
      path="$database$suffix"
      if sudo test -e "$path" || sudo test -L "$path"; then
        if handles="$(sudo lsof -nP -t -- "$path" 2>&1)"; then
          return 1
        else
          lsof_status=$?
        fi
        test "$lsof_status" -eq 1 && test -z "$handles" || return 1
      fi
    done
  done
}

enforce_pm2_fail_closed() {
  local action_failed=0 unit
  if pm2_fail_closed_is_exact; then
    return 0
  fi
  run_pm2_as_dominguez stop \
    nexus-hub content-engine nexus-hub-staging content-engine-staging \
    || action_failed=1
  for unit in pm2-dominguez.service nexus-release-pm2-recovery-daemon.service; do
    sudo systemctl disable --now "$unit" || action_failed=1
    install_pm2_guard "$unit" || action_failed=1
  done
  sudo systemctl daemon-reload || action_failed=1
  run_pm2_as_dominguez kill || action_failed=1
  if pm2_fail_closed_is_exact; then
    return 0
  fi
  printf 'PM2 fail-closed postconditions remain false (action failures: %s)\n' \
    "$action_failed" >&2
  return 1
}

verify_installed_runtime() {
  local digest runtime sha
  runtime="$1"; sha="$2"; digest="$3"
  sudo test -d "$runtime" && sudo test ! -L "$runtime" \
    && sudo test -f "$runtime/ecosystem.release.config.js" \
    && sudo test ! -L "$runtime/ecosystem.release.config.js" || return 1
  sudo /usr/bin/node \
    /opt/nexus-release/checkout/scripts/release-artifact-manifest.mjs \
    --verify-installed-source "$runtime" --expected-runtime-sha "$sha" \
    --expected-digest "$digest" >/dev/null || return 1
  if sudo test -e "$runtime/.nexus-installed-runtime.json" \
      || sudo test -L "$runtime/.nexus-installed-runtime.json"; then
    sudo test -f "$runtime/.nexus-installed-runtime.json" \
      && sudo test ! -L "$runtime/.nexus-installed-runtime.json" \
      && sudo test -f "$runtime/scripts/release-installed-tree-attestation.mjs" \
      && sudo test ! -L "$runtime/scripts/release-installed-tree-attestation.mjs" \
      || return 1
    sudo /usr/bin/node \
      "$runtime/scripts/release-installed-tree-attestation.mjs" validate \
      --root "$runtime" --runtime-sha "$sha" --artifact-digest "$digest" \
      >/dev/null || return 1
  else
    sudo /usr/bin/node \
      /opt/nexus-release/checkout/scripts/release-runtime-dependencies.mjs \
      verify-predecessor-extracted --root "$runtime" --python-bin /usr/bin/python3.12 \
      >/dev/null || return 1
  fi
}

tree_digest() {
  sudo tar --sort=name --mtime='@0' --owner=0 --group=0 --numeric-owner \
    -cf - -C "$1" . | sha256sum | awk '{print $1}'
}

require_directory_no_handles() {
  local directory error_file handles lsof_status
  directory="$1"; error_file="$(mktemp)"
  if handles="$(sudo lsof -t +D "$directory" 2>"$error_file")"; then
    lsof_status=0
  else
    lsof_status=$?
  fi
  if test -s "$error_file"; then
    sed 's/^/lsof: /' "$error_file" >&2
    rm -f "$error_file"
    die "directory handle probe produced an error: $directory"
  fi
  rm -f "$error_file"
  case "$lsof_status" in
    0) die "database directory still has open handles: $handles" ;;
    1) test -z "$handles" || die 'lsof returned output with no-match status' ;;
    *) die "directory lsof failed with status $lsof_status" ;;
  esac
}

install_or_verify_candidate() {
  local candidate candidate_dir candidate_name orphan source stage
  local -a orphan_stages
  source="$1"; candidate="$2"; stage="$candidate.next-$BASHPID"
  candidate_dir="$(dirname "$candidate")"; candidate_name="$(basename "$candidate")"
  test -z "$(sudo find "$candidate_dir" -maxdepth 1 \
    -name "$candidate_name.next-*" ! -type f -print -quit)" \
    || die "candidate has an unsafe orphan staging path: $candidate"
  mapfile -d '' -t orphan_stages < <(sudo find "$candidate_dir" -maxdepth 1 \
    -type f -name "$candidate_name.next-*" -print0)
  for orphan in "${orphan_stages[@]}"; do
    test "$(sudo stat -Lc '%U:%G:%a:%h' -- "$orphan")" = \
      'root:root:600:1' || die "candidate orphan stage is unsafe: $orphan"
    require_no_open_handles "$orphan"
    if sudo cmp -s -- "$source" "$orphan"; then
      if ! sudo test -e "$candidate" && ! sudo test -L "$candidate"; then
        sudo sync -f "$orphan"
        sudo mv -T -- "$orphan" "$candidate"
        sudo sync -f "$candidate"
        sudo sync -f "$candidate_dir"
        continue
      fi
    fi
    if sudo test -e "$candidate" || sudo test -L "$candidate"; then
      sudo test -f "$candidate" && sudo test ! -L "$candidate" \
        && sudo cmp -s -- "$source" "$candidate" \
        || die "candidate differs while retiring orphan stage: $candidate"
    fi
    sudo rm -- "$orphan"
    sudo sync -f "$candidate_dir"
  done
  if sudo test -e "$candidate" || sudo test -L "$candidate"; then
    sudo test -f "$candidate" && sudo test ! -L "$candidate" \
      || die "candidate is missing or symbolic: $candidate"
    test "$(sudo stat -Lc '%U:%G:%a:%h' -- "$candidate")" \
      = 'root:root:600:1' || die "candidate metadata is unsafe: $candidate"
    sudo cmp -s -- "$source" "$candidate" \
      || die "existing candidate differs from durable transaction: $candidate"
    sudo sync -f "$candidate"
    sudo sync -f "$candidate_dir"
    return
  fi
  sudo test ! -e "$stage" && sudo test ! -L "$stage" \
    || die "candidate staging path exists: $stage"
  sudo install -o root -g root -m 600 "$source" "$stage"
  sudo cmp -s -- "$source" "$stage" \
    || die "candidate staging copy differs: $stage"
  sudo sync -f "$stage"
  sudo mv -T -- "$stage" "$candidate"
  sudo sync -f "$candidate"
  sudo sync -f "$candidate_dir"
  test "$(sudo stat -Lc '%U:%G:%a:%h' -- "$candidate")" \
    = 'root:root:600:1' || die "candidate publication is unsafe: $candidate"
}

publish_or_verify_tree_archive() {
  local archive archive_dir archive_name orphan source stage
  local -a orphan_stages
  source="$1"; archive="$2"; archive_dir="$(dirname "$archive")"
  archive_name="$(basename "$archive")"; stage="$archive.next-$BASHPID"
  test -z "$(sudo find "$archive_dir" -maxdepth 1 \
    -name "$archive_name.next-*" ! -type d -print -quit)" \
    || die "tree archive has an unsafe orphan staging path: $archive"
  mapfile -d '' -t orphan_stages < <(sudo find "$archive_dir" -maxdepth 1 \
    -type d -name "$archive_name.next-*" -print0)
  for orphan in "${orphan_stages[@]}"; do
    sudo test ! -L "$orphan" || die "tree archive stage is symbolic: $orphan"
    test -z "$(sudo find "$orphan" -xdev -type l -print -quit)" \
      || die "tree archive stage contains a symbolic link: $orphan"
    require_directory_no_handles "$orphan"
    if sudo diff -qr --no-dereference "$source" "$orphan" >/dev/null; then
      sudo chown root:root "$orphan"; sudo chmod 700 "$orphan"
      if ! sudo test -e "$archive" && ! sudo test -L "$archive"; then
        sudo sync -f "$orphan"
        sudo mv -T -- "$orphan" "$archive"
        sudo sync -f "$archive"
        sudo sync -f "$archive_dir"
        continue
      fi
    fi
    if sudo test -e "$archive" || sudo test -L "$archive"; then
      sudo test -d "$archive" && sudo test ! -L "$archive" \
        && sudo diff -qr --no-dereference "$source" "$archive" >/dev/null \
        || die "tree archive differs while retiring orphan stage: $archive"
    fi
    sudo find "$orphan" -xdev -depth -delete
    sudo sync -f "$archive_dir"
  done
  if sudo test -e "$archive" || sudo test -L "$archive"; then
    sudo test -d "$archive" && sudo test ! -L "$archive" \
      || die "tree archive is unsafe: $archive"
    test "$(sudo stat -Lc '%U:%G:%a' -- "$archive")" = 'root:root:700' \
      || die "tree archive root metadata is unsafe: $archive"
    test -z "$(sudo find "$archive" -xdev -type l -print -quit)" \
      || die "tree archive contains a symbolic link: $archive"
    sudo diff -qr --no-dereference "$source" "$archive" >/dev/null \
      || die "tree archive differs from source: $source"
    sudo sync -f "$archive"
    sudo sync -f "$archive_dir"
    return
  fi
  sudo test ! -e "$stage" && sudo test ! -L "$stage" \
    || die "tree archive staging path exists: $stage"
  sudo cp -a --reflink=auto -- "$source" "$stage"
  test -z "$(sudo find "$stage" -xdev -type l -print -quit)" \
    || die "tree archive copy contains a symbolic link: $stage"
  sudo diff -qr --no-dereference "$source" "$stage" >/dev/null \
    || die "tree archive staging copy differs from source: $source"
  sudo chown root:root "$stage"; sudo chmod 700 "$stage"
  sudo sync -f "$stage"
  sudo mv -T -- "$stage" "$archive"
  sudo sync -f "$archive"
  sudo sync -f "$archive_dir"
  test "$(sudo stat -Lc '%U:%G:%a' -- "$archive")" = 'root:root:700' \
    || die "tree archive publication is unsafe: $archive"
}

publish_durable_rebaseline_state_stage() {
  local stage
  stage="$1"
  sudo test -f "$stage" && sudo test ! -L "$stage" \
    || die 'rebaseline state stage is missing or symbolic'
  test "$(sudo stat -Lc '%U:%G:%a:%h' -- "$stage")" = \
    'root:root:600:1' || die 'rebaseline state stage metadata is unsafe'
  sudo sync -f "$stage"
  sudo mv -T -- "$stage" "$REBASELINE_STATE"
  sudo test -f "$REBASELINE_STATE" && sudo test ! -L "$REBASELINE_STATE" \
    || die 'rebaseline state publication is missing or symbolic'
  test "$(sudo stat -Lc '%U:%G:%a:%h' -- "$REBASELINE_STATE")" = \
    'root:root:600:1' || die 'rebaseline state publication metadata is unsafe'
  sudo sync -f "$REBASELINE_STATE"
  sudo sync -f "$(dirname "$REBASELINE_STATE")"
}

publish_rebaseline_phase() {
  local phase state_stage state_temp
  phase="$1"; state_temp="$(mktemp)"
  sudo jq --arg phase "$phase" \
    --arg updatedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '.phase = $phase | .updatedAt = $updatedAt' \
    "$REBASELINE_STATE" >"$state_temp"
  state_stage="$REBASELINE_STATE.next-$BASHPID"
  sudo test ! -e "$state_stage" && sudo test ! -L "$state_stage" \
    || die 'rebaseline state staging path exists'
  sudo install -o root -g root -m 600 "$state_temp" "$state_stage"
  rm -f "$state_temp"
  publish_durable_rebaseline_state_stage "$state_stage"
  test "$(sudo stat -Lc '%U:%G:%a:%h' -- "$REBASELINE_STATE")" \
    = 'root:root:600:1' || die 'rebaseline state publication is unsafe'
}

require_baseline_shape() {
  local baseline
  baseline="$1"
  sudo /usr/bin/env -i PATH=/usr/bin:/bin HOME=/var/lib/nexus-release/home \
    /usr/bin/node --input-type=module -e '
      import fs from "node:fs";
      import { assertReleaseBootstrapBaselineShape } from
        "/opt/nexus-release/checkout/scripts/lib/release-bootstrap.mjs";
      import { loadContinuousDeploymentPolicy } from
        "/opt/nexus-release/checkout/scripts/lib/release-manifest.mjs";
      const file = process.argv[1];
      const policy = loadContinuousDeploymentPolicy("/opt/nexus-release/checkout");
      assertReleaseBootstrapBaselineShape(JSON.parse(fs.readFileSync(file, "utf8")), policy);
    ' "$baseline" >/dev/null || die "bootstrap baseline shape is invalid: $baseline"
}

OLD_PRODUCTION=/home/dominguez/telegram-hub-bot/data/bot.db
OLD_STAGING=/home/dominguez/telegram-hub-bot-staging/data/bot.db
PM2_PRODUCTION_BASE=/home/dominguez/telegram-hub-bot
PM2_STAGING_BASE=/home/dominguez/telegram-hub-bot-staging
NEW_PRODUCTION=/var/lib/nexus-hub/production/data
NEW_STAGING=/var/lib/nexus-hub/staging/data
LIVE_PRODUCTION="$NEW_PRODUCTION/bot.db"
LIVE_STAGING="$NEW_STAGING/bot.db"
BACKUP_ENV=/etc/nexus-local-backup/backup.env
BASELINE_FILE=/var/lib/nexus-release/state/bootstrap-baseline.json
BASELINE_ARCHIVE_DIR=/var/lib/nexus-release/incidents/bootstrap-baselines
RUNTIME_EVIDENCE=/var/lib/nexus-release/state/bootstrap-legacy-runtime.json
TRANSITION_EVIDENCE=/var/lib/nexus-release/state/bootstrap-database-transition.json
FIRST_RECOVERY_STATE=/var/lib/nexus-release/state/bootstrap-first-cutover-recovery.json
RELEASE_IMAGE=ghcr.io/felipedrf74/nexus-hub-release
USER_RELEASE_LOCK=/home/dominguez/.local/state/nexus-release/.release.lock
MAINTENANCE_LOCK=/run/lock/nexus-release-sonar.lock
: "${EXPECTED_RELEASE_ID:?export the owner-reviewed new 32-hex release ID}"
: "${EXPECTED_RELEASE_PAYLOAD_DIGEST:?export the owner-reviewed new sha256 OCI payload digest}"
[[ "$EXPECTED_RELEASE_ID" =~ ^[0-9a-f]{32}$ ]] \
  || die 'owner-expected release ID is invalid'
[[ "$EXPECTED_RELEASE_PAYLOAD_DIGEST" =~ ^sha256:[0-9a-f]{64}$ ]] \
  || die 'owner-expected payload digest is invalid'
REBASELINE_STATE="/var/lib/nexus-release/state/bootstrap-rebaseline-$EXPECTED_RELEASE_ID.json"
INCIDENT_DIR="/var/lib/nexus-release/incidents/bootstrap-rebaseline/$EXPECTED_RELEASE_ID"
CANDIDATE_BASELINE="$BASELINE_FILE.next-$EXPECTED_RELEASE_ID"
RUNTIME_CANDIDATE="$RUNTIME_EVIDENCE.next-$EXPECTED_RELEASE_ID"
TRANSITION_CANDIDATE="$TRANSITION_EVIDENCE.next-$EXPECTED_RELEASE_ID"

test "$(sudo stat -c '%U:%G:%a' -- "$USER_RELEASE_LOCK")" \
  = 'dominguez:dominguez:600' || die 'user release lock is unsafe'
test "$(sudo stat -c '%U:%G:%a' -- "$MAINTENANCE_LOCK")" \
  = 'root:dominguez:660' || die 'shared maintenance mutex is unsafe'
test ! -L "$USER_RELEASE_LOCK" && test ! -L "$MAINTENANCE_LOCK" \
  || die 'a release mutex is symbolic'
exec 9<>"$USER_RELEASE_LOCK"
flock -n 9 || die 'another PM2 release or capability transaction is active'
exec 8<>"$MAINTENANCE_LOCK"
flock -n 8 || die 'another root maintenance or container release is active'

if ! sudo test -e "$REBASELINE_STATE" && ! sudo test -L "$REBASELINE_STATE"; then
  test "$(sudo stat -Lc '%U:%G:%a:%h' -- "$BASELINE_FILE")" \
    = 'root:root:600:1' || die 'canonical bootstrap baseline is unsafe'
  sudo test ! -L "$BASELINE_FILE" || die 'canonical bootstrap baseline is symbolic'
  require_baseline_shape "$BASELINE_FILE"
  OLD_BASELINE_SHA256="$(sudo sha256sum "$BASELINE_FILE" | awk '{print $1}')"
  OLD_RELEASE_ID="$(sudo jq -er '.target.releaseId
    | select(test("^[0-9a-f]{32}$"))' "$BASELINE_FILE")"
  OLD_TARGET_DIGEST="$(sudo jq -er '.target.releasePayloadDigest
    | select(test("^sha256:[0-9a-f]{64}$"))' "$BASELINE_FILE")"
  test "$OLD_RELEASE_ID" != "$EXPECTED_RELEASE_ID" \
    || die 'a new bootstrap target cannot reuse the failed release ID'
  test "$OLD_TARGET_DIGEST" != "$EXPECTED_RELEASE_PAYLOAD_DIGEST" \
    || die 'the owner-authorized bootstrap target has not changed'

  for EVIDENCE in "$RUNTIME_EVIDENCE" "$TRANSITION_EVIDENCE" \
    "$FIRST_RECOVERY_STATE"; do
    sudo test -f "$EVIDENCE" && sudo test ! -L "$EVIDENCE" \
      || die "required recovery evidence is missing or symbolic: $EVIDENCE"
    test "$(sudo stat -Lc '%U:%G:%a:%h' -- "$EVIDENCE")" \
      = 'root:root:600:1' || die "recovery evidence is unsafe: $EVIDENCE"
  done
  sudo jq -e '.schema == "nexus.bootstrap-first-cutover-recovery.v1"
    and .phase == "pm2_restored"' "$FIRST_RECOVERY_STATE" >/dev/null \
    || die 'first-cutover recovery is not durably complete'
  sudo jq -e '.schema == "nexus.bootstrap-legacy-runtime-capture.v2"' \
    "$RUNTIME_EVIDENCE" >/dev/null || die 'legacy runtime capture is invalid'
  sudo jq -e '.schema == "nexus.bootstrap-database-transition.v1"' \
    "$TRANSITION_EVIDENCE" >/dev/null || die 'database transition evidence is invalid'

  for ROLE in production staging; do
    if test "$ROLE" = production; then
      LEGACY_BASE="$PM2_PRODUCTION_BASE"
    else
      LEGACY_BASE="$PM2_STAGING_BASE"
    fi
    RUNTIME="$(sudo readlink -f -- "$LEGACY_BASE/current")"
    case "$RUNTIME" in "$LEGACY_BASE"/releases/*) ;; *)
      die "$ROLE legacy current selector is unsafe" ;; esac
    MARKER="$RUNTIME/.complete.json"
    sudo test -f "$MARKER" && sudo test ! -L "$MARKER" \
      || die "$ROLE runtime marker is missing or symbolic"
    SOURCE_SHA="$(sudo jq -er 'select(
      type == "object"
      and .schema == "nexus.release-bundle.v1"
      and (.runtimeSha | type == "string"
        and test("^[0-9a-f]{40}$"))
      and (.artifactDigest | type == "string"
        and test("^[0-9a-f]{64}$"))
    ) | .runtimeSha' "$MARKER")"
    ARTIFACT_DIGEST="$(sudo jq -er .artifactDigest "$MARKER")"
    MARKER_SHA256="$(sudo sha256sum "$MARKER" | awk '{print $1}')"
    verify_installed_runtime "$RUNTIME" "$SOURCE_SHA" "$ARTIFACT_DIGEST" \
      || die "$ROLE installed runtime tree differs from its marker"
    if test "$ROLE" = production; then
      PRODUCTION_RUNTIME="$RUNTIME"; PRODUCTION_SHA="$SOURCE_SHA"
      PRODUCTION_ARTIFACT_DIGEST="$ARTIFACT_DIGEST"
      PRODUCTION_MARKER_SHA256="$MARKER_SHA256"
    else
      STAGING_RUNTIME="$RUNTIME"; STAGING_SHA="$SOURCE_SHA"
      STAGING_ARTIFACT_DIGEST="$ARTIFACT_DIGEST"
      STAGING_MARKER_SHA256="$MARKER_SHA256"
    fi
  done

  PM2_JSON="$(run_pm2_as_dominguez jlist)"
  for APP in nexus-hub content-engine nexus-hub-staging content-engine-staging; do
    case "$APP" in
      nexus-hub)
        EXPECTED_STATUS=online; EXPECTED_SHA="$PRODUCTION_SHA"
        EXPECTED_ARTIFACT="$PRODUCTION_ARTIFACT_DIGEST"
        EXPECTED_CWD="$PRODUCTION_RUNTIME"
        EXPECTED_EXEC="$PRODUCTION_RUNTIME/dist/index.js"
        EXPECTED_ROLE=production; EXPECTED_BASE="$PM2_PRODUCTION_BASE"
        EXPECTED_DATABASE="$OLD_PRODUCTION" ;;
      content-engine)
        EXPECTED_STATUS=online; EXPECTED_SHA="$PRODUCTION_SHA"
        EXPECTED_ARTIFACT="$PRODUCTION_ARTIFACT_DIGEST"
        EXPECTED_CWD="$PRODUCTION_RUNTIME/content-engine"
        EXPECTED_EXEC=/usr/bin/python3.12
        EXPECTED_ROLE=production; EXPECTED_BASE="$PM2_PRODUCTION_BASE"
        EXPECTED_DATABASE='' ;;
      nexus-hub-staging)
        EXPECTED_STATUS=online; EXPECTED_SHA="$STAGING_SHA"
        EXPECTED_ARTIFACT="$STAGING_ARTIFACT_DIGEST"
        EXPECTED_CWD="$STAGING_RUNTIME"
        EXPECTED_EXEC="$STAGING_RUNTIME/dist/index.js"
        EXPECTED_ROLE=staging; EXPECTED_BASE="$PM2_STAGING_BASE"
        EXPECTED_DATABASE="$OLD_STAGING" ;;
      content-engine-staging)
        EXPECTED_STATUS=online; EXPECTED_SHA="$STAGING_SHA"
        EXPECTED_ARTIFACT="$STAGING_ARTIFACT_DIGEST"
        EXPECTED_CWD="$STAGING_RUNTIME/content-engine"
        EXPECTED_EXEC=/usr/bin/python3.12
        EXPECTED_ROLE=staging; EXPECTED_BASE="$PM2_STAGING_BASE"
        EXPECTED_DATABASE='' ;;
    esac
    ROW="$(jq -ce --arg app "$APP" '[.[] | select(.name == $app)]
      | if length == 1 then .[0] else error("PM2 identity is ambiguous") end' \
      <<<"$PM2_JSON")" || die "$APP PM2 identity is ambiguous"
    test "$(jq -er .pm2_env.status <<<"$ROW")" = "$EXPECTED_STATUS" \
      || die "$APP is not online before rebaseline"
    test "$(jq -er '.pm2_env.NEXUS_RELEASE_SHA // .pm2_env.GIT_COMMIT' \
      <<<"$ROW")" = "$EXPECTED_SHA" || die "$APP source SHA differs"
    test "$(jq -er .pm2_env.NEXUS_RELEASE_ARTIFACT_SHA256 <<<"$ROW")" \
      = "$EXPECTED_ARTIFACT" || die "$APP artifact digest differs"
    test "$(jq -er .pm2_env.pm_cwd <<<"$ROW")" = "$EXPECTED_CWD" \
      || die "$APP cwd differs"
    test "$(jq -er .pm2_env.pm_exec_path <<<"$ROW")" = "$EXPECTED_EXEC" \
      || die "$APP executable differs"
    test "$(jq -er .pm2_env.NEXUS_RELEASE_ROLE <<<"$ROW")" = "$EXPECTED_ROLE" \
      || die "$APP role differs"
    test "$(jq -er .pm2_env.NEXUS_RELEASE_BASE_DIR <<<"$ROW")" = "$EXPECTED_BASE" \
      || die "$APP base directory differs"
    test "$(jq -er '.pid | type == "number" and . > 0' <<<"$ROW")" = true \
      || die "$APP has no live PID"
    if test -n "$EXPECTED_DATABASE"; then
      test "$(jq -er .pm2_env.DATABASE_PATH <<<"$ROW")" = "$EXPECTED_DATABASE" \
        || die "$APP database path differs"
    fi
  done
  test "$(sudo systemctl show pm2-dominguez.service \
      --property=LoadState --value)" = loaded \
    && test "$(sudo systemctl show pm2-dominguez.service \
      --property=FragmentPath --value)" = \
      /etc/systemd/system/pm2-dominguez.service \
    && test "$(sudo systemctl show pm2-dominguez.service \
      --property=CanStart --value)" = yes \
    && test "$(sudo systemctl show pm2-dominguez.service \
      --property=ActiveState --value)" = active \
    && test "$(sudo systemctl is-enabled pm2-dominguez.service)" = enabled \
    || die 'canonical PM2 authority is not exact, active, and enabled'
  pm2_guard_is_exact nexus-release-pm2-recovery-daemon.service \
    || die 'temporary PM2 authority lost its exact high-priority runtime guard'

  for DB in "$OLD_PRODUCTION" "$OLD_STAGING"; do
    sudo test -f "$DB" && sudo test ! -L "$DB" \
      || die "PM2 database is missing or symbolic: $DB"
    test "$(sudo readlink -f -- "$DB")" = "$DB" \
      || die "PM2 database is not canonical: $DB"
    test "$(sudo stat -Lc '%F:%h' -- "$DB")" = 'regular file:1' \
      || die "PM2 database is not a single-link regular file: $DB"
  done
  PRODUCTION_DATABASE_IDENTITY="$(sudo stat -Lc '%d:%i' -- "$OLD_PRODUCTION")"
  STAGING_DATABASE_IDENTITY="$(sudo stat -Lc '%d:%i' -- "$OLD_STAGING")"
  RUNTIME_EVIDENCE_SHA256="$(sudo sha256sum "$RUNTIME_EVIDENCE" | awk '{print $1}')"
  TRANSITION_EVIDENCE_SHA256="$(sudo sha256sum "$TRANSITION_EVIDENCE" | awk '{print $1}')"
  RECOVERY_STATE_SHA256="$(sudo sha256sum "$FIRST_RECOVERY_STATE" | awk '{print $1}')"
  ARCHIVED_BASELINE="$BASELINE_ARCHIVE_DIR/$EXPECTED_RELEASE_ID-$OLD_RELEASE_ID.json"

  sudo /usr/bin/env -i PATH=/usr/bin:/bin HOME=/var/lib/nexus-release/home \
    DOCKER_CONFIG=/etc/nexus-release/docker \
    /usr/bin/docker pull --quiet "$RELEASE_IMAGE:main" >/dev/null
  RESOLVED_TARGET_DIGEST="$(sudo /usr/bin/env -i PATH=/usr/bin:/bin \
    HOME=/var/lib/nexus-release/home DOCKER_CONFIG=/etc/nexus-release/docker \
    /usr/bin/docker image inspect --format '{{join .RepoDigests "\\n"}}' \
    "$RELEASE_IMAGE:main" | awk -F@ -v repository="$RELEASE_IMAGE" \
      '$1 == repository && $2 ~ /^sha256:[0-9a-f]{64}$/ { print $2; found=1; exit }
       END { if (!found) exit 1 }')"
  test "$RESOLVED_TARGET_DIGEST" = "$EXPECTED_RELEASE_PAYLOAD_DIGEST" \
    || die 'resolved bootstrap payload digest differs from owner authorization'

  CREATED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  sudo install -d -o root -g root -m 700 \
    /var/lib/nexus-release/incidents/bootstrap-rebaseline "$INCIDENT_DIR"
  STATE_TEMP="$(mktemp)"
  jq -cn --arg createdAt "$CREATED_AT" --arg incidentDir "$INCIDENT_DIR" \
    --arg expectedReleaseId "$EXPECTED_RELEASE_ID" \
    --arg expectedPayloadDigest "$EXPECTED_RELEASE_PAYLOAD_DIGEST" \
    --arg oldBaselineSha256 "$OLD_BASELINE_SHA256" \
    --arg oldReleaseId "$OLD_RELEASE_ID" --arg oldTargetDigest "$OLD_TARGET_DIGEST" \
    --arg archivedBaseline "$ARCHIVED_BASELINE" \
    --arg runtimeEvidenceSha256 "$RUNTIME_EVIDENCE_SHA256" \
    --arg transitionEvidenceSha256 "$TRANSITION_EVIDENCE_SHA256" \
    --arg recoveryStateSha256 "$RECOVERY_STATE_SHA256" \
    --arg productionPath "$OLD_PRODUCTION" \
    --arg productionIdentity "$PRODUCTION_DATABASE_IDENTITY" \
    --arg stagingPath "$OLD_STAGING" \
    --arg stagingIdentity "$STAGING_DATABASE_IDENTITY" \
    --arg productionRuntime "$PRODUCTION_RUNTIME" --arg productionSha "$PRODUCTION_SHA" \
    --arg productionArtifact "$PRODUCTION_ARTIFACT_DIGEST" \
    --arg productionMarker "$PRODUCTION_MARKER_SHA256" \
    --arg stagingRuntime "$STAGING_RUNTIME" --arg stagingSha "$STAGING_SHA" \
    --arg stagingArtifact "$STAGING_ARTIFACT_DIGEST" \
    --arg stagingMarker "$STAGING_MARKER_SHA256" \
    '{schema:"nexus.bootstrap-rebaseline.v1",createdAt:$createdAt,
      updatedAt:$createdAt,phase:"admitted",incidentDir:$incidentDir,
      expectedTarget:{releaseId:$expectedReleaseId,payloadDigest:$expectedPayloadDigest},
      oldBaseline:{sha256:$oldBaselineSha256,releaseId:$oldReleaseId,
        payloadDigest:$oldTargetDigest,archivePath:$archivedBaseline},
      oldEvidence:{runtimeSha256:$runtimeEvidenceSha256,
        transitionSha256:$transitionEvidenceSha256,
        recoveryStateSha256:$recoveryStateSha256},
      legacy:{production:{path:$productionPath,identity:$productionIdentity,
          logicalDigest:null},
        staging:{path:$stagingPath,identity:$stagingIdentity,logicalDigest:null}},
      runtime:{production:{path:$productionRuntime,sourceSha:$productionSha,
          artifactDigest:$productionArtifact,markerSha256:$productionMarker},
        staging:{path:$stagingRuntime,sourceSha:$stagingSha,
          artifactDigest:$stagingArtifact,markerSha256:$stagingMarker}}}' >"$STATE_TEMP"
  STATE_STAGE="$REBASELINE_STATE.next-$BASHPID"
  sudo test ! -e "$STATE_STAGE" && sudo test ! -L "$STATE_STAGE" \
    || die 'rebaseline state staging path exists'
  sudo install -o root -g root -m 600 "$STATE_TEMP" "$STATE_STAGE"
  rm -f "$STATE_TEMP"
  # Both release locks serialize admission; atomic rename publishes a
  # single-link state without a link/unlink SIGKILL window.
  publish_durable_rebaseline_state_stage "$STATE_STAGE"
fi

sudo test -f "$REBASELINE_STATE" && sudo test ! -L "$REBASELINE_STATE" \
  || die 'rebaseline state is missing or symbolic'
test "$(sudo stat -Lc '%U:%G:%a:%h' -- "$REBASELINE_STATE")" \
  = 'root:root:600:1' || die 'rebaseline state is unsafe'
sudo jq -e --arg expectedReleaseId "$EXPECTED_RELEASE_ID" \
  --arg expectedPayloadDigest "$EXPECTED_RELEASE_PAYLOAD_DIGEST" \
  --arg incidentDir "$INCIDENT_DIR" \
  '.schema == "nexus.bootstrap-rebaseline.v1"
   and .expectedTarget.releaseId == $expectedReleaseId
   and .expectedTarget.payloadDigest == $expectedPayloadDigest
   and .incidentDir == $incidentDir
   and (.phase == "admitted" or .phase == "pm2_quiesced"
     or .phase == "targets_archived" or .phase == "targets_reset"
     or .phase == "backup_repointed" or .phase == "evidence_ready"
     or .phase == "evidence_published" or .phase == "candidate_ready"
     or .phase == "baseline_published" or .phase == "complete")
   and (.oldBaseline.sha256 | test("^[0-9a-f]{64}$"))
   and (.legacy.production.identity | test("^[0-9]+:[0-9]+$"))
   and (.legacy.staging.identity | test("^[0-9]+:[0-9]+$"))
   and (.runtime.production.sourceSha | test("^[0-9a-f]{40}$"))
   and (.runtime.production.artifactDigest | test("^[0-9a-f]{64}$"))
   and (.runtime.staging.sourceSha | test("^[0-9a-f]{40}$"))
   and (.runtime.staging.artifactDigest | test("^[0-9a-f]{64}$"))' \
  "$REBASELINE_STATE" >/dev/null || die 'rebaseline state contract is invalid'
REBASELINE_PHASE="$(sudo jq -er .phase "$REBASELINE_STATE")"
CREATED_AT="$(sudo jq -er .createdAt "$REBASELINE_STATE")"
OLD_BASELINE_SHA256="$(sudo jq -er .oldBaseline.sha256 "$REBASELINE_STATE")"
OLD_RELEASE_ID="$(sudo jq -er .oldBaseline.releaseId "$REBASELINE_STATE")"
ARCHIVED_BASELINE="$(sudo jq -er .oldBaseline.archivePath "$REBASELINE_STATE")"
PRODUCTION_DATABASE_IDENTITY="$(sudo jq -er .legacy.production.identity "$REBASELINE_STATE")"
STAGING_DATABASE_IDENTITY="$(sudo jq -er .legacy.staging.identity "$REBASELINE_STATE")"
PRODUCTION_RUNTIME="$(sudo jq -er .runtime.production.path "$REBASELINE_STATE")"
PRODUCTION_SHA="$(sudo jq -er .runtime.production.sourceSha "$REBASELINE_STATE")"
PRODUCTION_ARTIFACT_DIGEST="$(sudo jq -er .runtime.production.artifactDigest "$REBASELINE_STATE")"
PRODUCTION_MARKER_SHA256="$(sudo jq -er .runtime.production.markerSha256 "$REBASELINE_STATE")"
STAGING_RUNTIME="$(sudo jq -er .runtime.staging.path "$REBASELINE_STATE")"
STAGING_SHA="$(sudo jq -er .runtime.staging.sourceSha "$REBASELINE_STATE")"
STAGING_ARTIFACT_DIGEST="$(sudo jq -er .runtime.staging.artifactDigest "$REBASELINE_STATE")"
STAGING_MARKER_SHA256="$(sudo jq -er .runtime.staging.markerSha256 "$REBASELINE_STATE")"

for SPEC in \
  "$PM2_PRODUCTION_BASE:$PRODUCTION_RUNTIME:$PRODUCTION_SHA:$PRODUCTION_ARTIFACT_DIGEST:$PRODUCTION_MARKER_SHA256" \
  "$PM2_STAGING_BASE:$STAGING_RUNTIME:$STAGING_SHA:$STAGING_ARTIFACT_DIGEST:$STAGING_MARKER_SHA256"; do
  LEGACY_BASE="${SPEC%%:*}"; REST="${SPEC#*:}"
  RUNTIME="${REST%%:*}"; REST="${REST#*:}"
  SOURCE_SHA="${REST%%:*}"; REST="${REST#*:}"
  ARTIFACT_DIGEST="${REST%%:*}"; MARKER_SHA256="${REST#*:}"
  test "$(sudo readlink -f -- "$LEGACY_BASE/current")" = "$RUNTIME" \
    || die 'legacy selector differs from durable rebaseline state'
  test "$(sudo sha256sum "$RUNTIME/.complete.json" | awk '{print $1}')" \
    = "$MARKER_SHA256" || die 'runtime marker differs from durable state'
  verify_installed_runtime "$RUNTIME" "$SOURCE_SHA" "$ARTIFACT_DIGEST" \
    || die 'installed runtime tree differs from durable state'
done
for SPEC in "$OLD_PRODUCTION:$PRODUCTION_DATABASE_IDENTITY" \
  "$OLD_STAGING:$STAGING_DATABASE_IDENTITY"; do
  DB="${SPEC%%:*}"; EXPECTED_IDENTITY="${SPEC#*:}"
  sudo test -f "$DB" && sudo test ! -L "$DB" \
    || die "PM2 database is missing or symbolic: $DB"
  test "$(sudo readlink -f -- "$DB")" = "$DB" \
    || die "PM2 database is not canonical: $DB"
  test "$(sudo stat -Lc '%d:%i' -- "$DB")" = "$EXPECTED_IDENTITY" \
    || die "PM2 database identity changed: $DB"
done

REBASELINE_ARMED=1
fail_closed_rebaseline() {
  local status=$?
  trap - EXIT HUP INT TERM
  if test "$REBASELINE_ARMED" -eq 1; then
    if ! sudo systemctl stop \
        nexus-release-bootstrap.service nexus-release-poller.timer; then
      printf 'FATAL: rebaseline cleanup could not stop container authorities\n' >&2
      status=70
    fi
    if ! enforce_pm2_fail_closed; then
      printf 'FATAL: rebaseline cleanup could not prove PM2 fail-closed postconditions\n' >&2
      status=70
    fi
    printf 'rebaseline remains fail-closed; resume with state %s\n' \
      "$REBASELINE_STATE" >&2
  fi
  exit "$status"
}
trap fail_closed_rebaseline EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

# The trap is armed before the first authority or data mutation. An admitted
# retry may already be fully quiescent; prove that without starting an empty
# PM2 daemon. Active authority/process states are stopped below, while the
# no-daemon path advances from the durable state after database/guard proof.
REBASELINE_PM2_LIVE=0
for UNIT in pm2-dominguez.service nexus-release-pm2-recovery-daemon.service; do
  if ACTIVE_STATE="$(sudo systemctl is-active "$UNIT" 2>&1)"; then
    ACTIVE_STATUS=0
  else
    ACTIVE_STATUS=$?
  fi
  case "$ACTIVE_STATE" in
    active) REBASELINE_PM2_LIVE=1 ;;
    inactive) test "$ACTIVE_STATUS" -ne 0 \
      || die "$UNIT returned an inconsistent inactive state" ;;
    *) die "$UNIT has an unsafe active state: $ACTIVE_STATE" ;;
  esac
done
if sudo pgrep -u dominguez -f 'PM2.*God Daemon' >/dev/null; then
  REBASELINE_PM2_LIVE=1
else
  PGREP_STATUS=$?
  test "$PGREP_STATUS" -eq 1 \
    || die "rebaseline PM2 daemon probe failed with status $PGREP_STATUS"
fi
sudo systemctl disable --now pm2-dominguez.service
install_pm2_guard pm2-dominguez.service \
  || die 'canonical PM2 high-priority runtime guard could not be installed'
RECOVERY_LOAD_STATE="$(sudo systemctl show \
  nexus-release-pm2-recovery-daemon.service --property=LoadState --value)"
case "$RECOVERY_LOAD_STATE" in
  loaded) sudo systemctl disable --now nexus-release-pm2-recovery-daemon.service ;;
  masked|not-found) ;;
  *) die "temporary PM2 authority has unsafe load state: $RECOVERY_LOAD_STATE" ;;
esac
install_pm2_guard nexus-release-pm2-recovery-daemon.service \
  || die 'temporary PM2 high-priority runtime guard could not be installed'
sudo systemctl daemon-reload
if test "$REBASELINE_PM2_LIVE" -eq 1; then
  run_pm2_as_dominguez kill
fi
require_pm2_guard
if sudo pgrep -u dominguez -f 'PM2.*God Daemon' >/dev/null; then
  die 'PM2 daemon remains after rebaseline quiescence'
else
  PGREP_STATUS=$?
  test "$PGREP_STATUS" -eq 1 \
    || die "post-quiescence PM2 daemon probe failed with status $PGREP_STATUS"
fi
for PROJECT in nexus-production nexus-staging; do
  test -z "$(sudo docker ps -aq \
    --filter "label=com.docker.compose.project=$PROJECT")" \
    || die "$PROJECT still has containers"
done

remove_proven_stale_wal_sidecars "$OLD_PRODUCTION" "$OLD_STAGING"
for SPEC in "$OLD_PRODUCTION:$PRODUCTION_DATABASE_IDENTITY" \
  "$OLD_STAGING:$STAGING_DATABASE_IDENTITY"; do
  DB="${SPEC%%:*}"; EXPECTED_IDENTITY="${SPEC#*:}"
  require_valid_sqlite "$DB"
  require_no_open_handles "$DB"
  test "$(sudo stat -Lc '%d:%i' -- "$DB")" = "$EXPECTED_IDENTITY" \
    || die "PM2 database identity changed after quiescence: $DB"
done
PRODUCTION_LOGICAL_SHA="$(logical_digest "$OLD_PRODUCTION")"
STAGING_LOGICAL_SHA="$(logical_digest "$OLD_STAGING")"
remove_proven_stale_wal_sidecars "$OLD_PRODUCTION" "$OLD_STAGING"
require_no_sqlite_sidecars "$OLD_PRODUCTION" "$OLD_STAGING"
if test "$(sudo jq -r .legacy.production.logicalDigest "$REBASELINE_STATE")" = null; then
  STATE_TEMP="$(mktemp)"; STATE_STAGE="$REBASELINE_STATE.next-$BASHPID"
  sudo jq --arg productionDigest "$PRODUCTION_LOGICAL_SHA" \
    --arg stagingDigest "$STAGING_LOGICAL_SHA" \
    --arg updatedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '.legacy.production.logicalDigest = $productionDigest
     | .legacy.staging.logicalDigest = $stagingDigest
     | .phase = "pm2_quiesced" | .updatedAt = $updatedAt' \
    "$REBASELINE_STATE" >"$STATE_TEMP"
  sudo install -o root -g root -m 600 "$STATE_TEMP" "$STATE_STAGE"
  rm -f "$STATE_TEMP"
  publish_durable_rebaseline_state_stage "$STATE_STAGE"
else
  test "$(sudo jq -er .legacy.production.logicalDigest "$REBASELINE_STATE")" \
    = "$PRODUCTION_LOGICAL_SHA" || die 'production PM2 data changed during rebaseline'
  test "$(sudo jq -er .legacy.staging.logicalDigest "$REBASELINE_STATE")" \
    = "$STAGING_LOGICAL_SHA" || die 'staging PM2 data changed during rebaseline'
  if test "$REBASELINE_PHASE" = admitted; then
    publish_rebaseline_phase pm2_quiesced
  fi
fi
REBASELINE_PHASE="$(sudo jq -er .phase "$REBASELINE_STATE")"

# Preserve the complete governed data directories before removing any known
# target/remnant. This retains divergent or partial SQLite families byte-for-byte.
PRODUCTION_ARCHIVE="$INCIDENT_DIR/production-data.before"
STAGING_ARCHIVE="$INCIDENT_DIR/staging-data.before"
if test "$REBASELINE_PHASE" = pm2_quiesced; then
  for SPEC in "$NEW_PRODUCTION:$PRODUCTION_ARCHIVE" \
    "$NEW_STAGING:$STAGING_ARCHIVE"; do
    SOURCE_DIR="${SPEC%%:*}"; ARCHIVE_DIR="${SPEC#*:}"
    sudo test -d "$SOURCE_DIR" && sudo test ! -L "$SOURCE_DIR" \
      || die "governed data directory is missing or symbolic: $SOURCE_DIR"
    test -z "$(sudo find "$SOURCE_DIR" -xdev -type l -print -quit)" \
      || die "governed data directory contains a symbolic link: $SOURCE_DIR"
    require_directory_no_handles "$SOURCE_DIR"
    publish_or_verify_tree_archive "$SOURCE_DIR" "$ARCHIVE_DIR"
  done
  PRODUCTION_ARCHIVE_SHA="$(tree_digest "$PRODUCTION_ARCHIVE")"
  STAGING_ARCHIVE_SHA="$(tree_digest "$STAGING_ARCHIVE")"
  STATE_TEMP="$(mktemp)"; STATE_STAGE="$REBASELINE_STATE.next-$BASHPID"
  sudo jq --arg productionArchive "$PRODUCTION_ARCHIVE" \
    --arg productionSha "$PRODUCTION_ARCHIVE_SHA" \
    --arg stagingArchive "$STAGING_ARCHIVE" --arg stagingSha "$STAGING_ARCHIVE_SHA" \
    --arg updatedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '.targetArchives = {
       production:{path:$productionArchive,treeSha256:$productionSha},
       staging:{path:$stagingArchive,treeSha256:$stagingSha}}
     | .phase = "targets_archived" | .updatedAt = $updatedAt' \
    "$REBASELINE_STATE" >"$STATE_TEMP"
  sudo install -o root -g root -m 600 "$STATE_TEMP" "$STATE_STAGE"
  rm -f "$STATE_TEMP"
  publish_durable_rebaseline_state_stage "$STATE_STAGE"
fi
REBASELINE_PHASE="$(sudo jq -er .phase "$REBASELINE_STATE")"
PRODUCTION_ARCHIVE="$(sudo jq -er .targetArchives.production.path "$REBASELINE_STATE")"
STAGING_ARCHIVE="$(sudo jq -er .targetArchives.staging.path "$REBASELINE_STATE")"
test "$(tree_digest "$PRODUCTION_ARCHIVE")" = \
  "$(sudo jq -er .targetArchives.production.treeSha256 "$REBASELINE_STATE")" \
  || die 'production target archive changed'
test "$(tree_digest "$STAGING_ARCHIVE")" = \
  "$(sudo jq -er .targetArchives.staging.treeSha256 "$REBASELINE_STATE")" \
  || die 'staging target archive changed'

if test "$REBASELINE_PHASE" = targets_archived; then
  sudo chown root:root "$NEW_PRODUCTION" "$NEW_STAGING"
  sudo chmod 700 "$NEW_PRODUCTION" "$NEW_STAGING"
  for BASE in "$LIVE_PRODUCTION" "$LIVE_STAGING"; do
    for PATH_TO_RETIRE in \
      "$BASE" "$BASE-wal" "$BASE-shm" "$BASE-journal" \
      "$BASE.next" "$BASE.next-wal" "$BASE.next-shm" "$BASE.next-journal" \
      "$BASE.next-$EXPECTED_RELEASE_ID" \
      "$BASE.next-$EXPECTED_RELEASE_ID-wal" \
      "$BASE.next-$EXPECTED_RELEASE_ID-shm" \
      "$BASE.next-$EXPECTED_RELEASE_ID-journal"; do
      if sudo test -e "$PATH_TO_RETIRE" || sudo test -L "$PATH_TO_RETIRE"; then
        sudo test -f "$PATH_TO_RETIRE" && sudo test ! -L "$PATH_TO_RETIRE" \
          || die "archived target remnant is not a regular file: $PATH_TO_RETIRE"
        sudo rm -- "$PATH_TO_RETIRE"
      fi
    done
  done
  PRODUCTION_NEXT="$LIVE_PRODUCTION.next-$EXPECTED_RELEASE_ID"
  STAGING_NEXT="$LIVE_STAGING.next-$EXPECTED_RELEASE_ID"
  sudo test ! -e "$PRODUCTION_NEXT" && sudo test ! -L "$PRODUCTION_NEXT" \
    || die 'production reset candidate exists after archival cleanup'
  sudo test ! -e "$STAGING_NEXT" && sudo test ! -L "$STAGING_NEXT" \
    || die 'staging reset candidate exists after archival cleanup'
  sudo sqlite3 "$OLD_PRODUCTION" ".backup '$PRODUCTION_NEXT'"
  sudo sqlite3 "$OLD_STAGING" ".backup '$STAGING_NEXT'"
  for SPEC in "$PRODUCTION_NEXT:$PRODUCTION_LOGICAL_SHA" \
    "$STAGING_NEXT:$STAGING_LOGICAL_SHA"; do
    DB="${SPEC%%:*}"; EXPECTED_DIGEST="${SPEC#*:}"
    require_valid_sqlite "$DB"; require_no_open_handles "$DB"
    test "$(logical_digest "$DB")" = "$EXPECTED_DIGEST" \
      || die "container reset candidate differs from authoritative PM2 data: $DB"
    remove_proven_stale_wal_sidecars "$DB"
    require_no_sqlite_sidecars "$DB"
    sudo chown 10001:10001 "$DB"; sudo chmod 600 "$DB"
    test "$(sudo stat -Lc '%u:%g:%a:%h' -- "$DB")" \
      = '10001:10001:600:1' || die "container reset candidate metadata is unsafe: $DB"
  done
  sudo mv -T -- "$PRODUCTION_NEXT" "$LIVE_PRODUCTION"
  sudo mv -T -- "$STAGING_NEXT" "$LIVE_STAGING"
  sudo chown 10001:10001 "$NEW_PRODUCTION" "$NEW_STAGING"
  sudo chmod 700 "$NEW_PRODUCTION" "$NEW_STAGING"
  for SPEC in "$LIVE_PRODUCTION:$PRODUCTION_LOGICAL_SHA" \
    "$LIVE_STAGING:$STAGING_LOGICAL_SHA"; do
    DB="${SPEC%%:*}"; EXPECTED_DIGEST="${SPEC#*:}"
    test "$(sudo stat -Lc '%u:%g:%a:%h' -- "$DB")" \
      = '10001:10001:600:1' || die "governed database metadata is unsafe: $DB"
    require_valid_sqlite "$DB"; require_no_open_handles "$DB"
    test "$(logical_digest "$DB")" = "$EXPECTED_DIGEST" \
      || die "governed database differs from authoritative PM2 data: $DB"
    remove_proven_stale_wal_sidecars "$DB"
    require_no_sqlite_sidecars "$DB"
  done
  TARGET_PRODUCTION_IDENTITY="$(sudo stat -Lc '%d:%i' -- "$LIVE_PRODUCTION")"
  TARGET_STAGING_IDENTITY="$(sudo stat -Lc '%d:%i' -- "$LIVE_STAGING")"
  STATE_TEMP="$(mktemp)"; STATE_STAGE="$REBASELINE_STATE.next-$BASHPID"
  sudo jq --arg productionIdentity "$TARGET_PRODUCTION_IDENTITY" \
    --arg productionDigest "$PRODUCTION_LOGICAL_SHA" \
    --arg stagingIdentity "$TARGET_STAGING_IDENTITY" \
    --arg stagingDigest "$STAGING_LOGICAL_SHA" \
    --arg updatedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '.target = {
       production:{path:"/var/lib/nexus-hub/production/data/bot.db",
         identity:$productionIdentity,logicalDigest:$productionDigest},
       staging:{path:"/var/lib/nexus-hub/staging/data/bot.db",
         identity:$stagingIdentity,logicalDigest:$stagingDigest}}
     | .phase = "targets_reset" | .updatedAt = $updatedAt' \
    "$REBASELINE_STATE" >"$STATE_TEMP"
  sudo install -o root -g root -m 600 "$STATE_TEMP" "$STATE_STAGE"
  rm -f "$STATE_TEMP"
  publish_durable_rebaseline_state_stage "$STATE_STAGE"
fi
REBASELINE_PHASE="$(sudo jq -er .phase "$REBASELINE_STATE")"
TARGET_PRODUCTION_IDENTITY="$(sudo jq -er .target.production.identity "$REBASELINE_STATE")"
TARGET_STAGING_IDENTITY="$(sudo jq -er .target.staging.identity "$REBASELINE_STATE")"
for SPEC in "$LIVE_PRODUCTION:$TARGET_PRODUCTION_IDENTITY:$PRODUCTION_LOGICAL_SHA" \
  "$LIVE_STAGING:$TARGET_STAGING_IDENTITY:$STAGING_LOGICAL_SHA"; do
  DB="${SPEC%%:*}"; REST="${SPEC#*:}"
  EXPECTED_DEVICE="${REST%%:*}"; REST="${REST#*:}"
  EXPECTED_INODE="${REST%%:*}"; EXPECTED_DIGEST="${REST#*:}"
  test "$(sudo stat -Lc '%d:%i' -- "$DB")" = "$EXPECTED_DEVICE:$EXPECTED_INODE" \
    || die "governed database identity changed: $DB"
  test "$(logical_digest "$DB")" = "$EXPECTED_DIGEST" \
    || die "governed database content changed: $DB"
done

sudo test -f "$BACKUP_ENV" && sudo test ! -L "$BACKUP_ENV" \
  || die 'backup environment is missing or symbolic'
test "$(sudo stat -Lc '%U:%G:%a:%h' -- "$BACKUP_ENV")" \
  = 'root:root:600:1' || die 'backup environment metadata is unsafe'
test "$(sudo awk -F= '$1 == "NEXUS_LOCAL_BACKUP_DATABASE_PATH" { count += 1 }
  END { print count + 0 }' "$BACKUP_ENV")" = 1 \
  || die 'backup database path is absent or duplicated'
CURRENT_BACKUP_DATABASE="$(sudo awk -F= \
  '$1 == "NEXUS_LOCAL_BACKUP_DATABASE_PATH" {
    print substr($0, index($0, "=") + 1) }' "$BACKUP_ENV")"
case "$CURRENT_BACKUP_DATABASE" in
  "$OLD_PRODUCTION"|"$LIVE_PRODUCTION") ;;
  *) die 'backup database path is outside the rebaseline transaction' ;;
esac
if test "$CURRENT_BACKUP_DATABASE" = "$OLD_PRODUCTION"; then
  sudo sed -i \
    "s#^NEXUS_LOCAL_BACKUP_DATABASE_PATH=.*#NEXUS_LOCAL_BACKUP_DATABASE_PATH=$LIVE_PRODUCTION#" \
    "$BACKUP_ENV"
fi
test "$(sudo awk -F= '$1 == "NEXUS_LOCAL_BACKUP_DATABASE_PATH" {
  print substr($0, index($0, "=") + 1) }' "$BACKUP_ENV")" = "$LIVE_PRODUCTION" \
  || die 'backup repoint did not settle on governed production'
fresh_backup_for "$LIVE_PRODUCTION"
remove_proven_stale_wal_sidecars "$OLD_PRODUCTION" "$OLD_STAGING" \
  "$LIVE_PRODUCTION" "$LIVE_STAGING"
if test "$REBASELINE_PHASE" = targets_reset; then
  publish_rebaseline_phase backup_repointed
fi
REBASELINE_PHASE="$(sudo jq -er .phase "$REBASELINE_STATE")"

if test "$REBASELINE_PHASE" = backup_repointed; then
  RUNTIME_TEMP="$(mktemp)"
  jq -cn --arg createdAt "$CREATED_AT" \
    --arg productionSourceSha "$PRODUCTION_SHA" \
    --arg productionArtifactDigest "$PRODUCTION_ARTIFACT_DIGEST" \
    --arg productionRuntimePath "$PRODUCTION_RUNTIME" \
    --arg productionMarkerSha256 "$PRODUCTION_MARKER_SHA256" \
    --arg productionDatabaseIdentity "$PRODUCTION_DATABASE_IDENTITY" \
    --arg stagingSourceSha "$STAGING_SHA" \
    --arg stagingArtifactDigest "$STAGING_ARTIFACT_DIGEST" \
    --arg stagingRuntimePath "$STAGING_RUNTIME" \
    --arg stagingMarkerSha256 "$STAGING_MARKER_SHA256" \
    --arg stagingDatabaseIdentity "$STAGING_DATABASE_IDENTITY" \
    '{schema:"nexus.bootstrap-legacy-runtime-capture.v2",createdAt:$createdAt,
      productionSourceSha:$productionSourceSha,
      productionArtifactDigest:$productionArtifactDigest,
      productionRuntimePath:$productionRuntimePath,
      productionMarkerSha256:$productionMarkerSha256,
      productionDatabaseIdentity:$productionDatabaseIdentity,
      stagingSourceSha:$stagingSourceSha,
      stagingArtifactDigest:$stagingArtifactDigest,
      stagingRuntimePath:$stagingRuntimePath,
      stagingMarkerSha256:$stagingMarkerSha256,
      stagingDatabaseIdentity:$stagingDatabaseIdentity}' >"$RUNTIME_TEMP"
  install_or_verify_candidate "$RUNTIME_TEMP" "$RUNTIME_CANDIDATE"
  NEW_RUNTIME_SHA256="$(sha256sum "$RUNTIME_TEMP" | awk '{print $1}')"
  rm -f "$RUNTIME_TEMP"

  TRANSITION_TEMP="$(mktemp)"
  jq -cn --arg createdAt "$CREATED_AT" \
    --arg runtimeCaptureSha256 "$NEW_RUNTIME_SHA256" \
    --arg legacyProductionIdentity "$PRODUCTION_DATABASE_IDENTITY" \
    --arg legacyProductionLogicalDigest "$PRODUCTION_LOGICAL_SHA" \
    --arg legacyStagingIdentity "$STAGING_DATABASE_IDENTITY" \
    --arg legacyStagingLogicalDigest "$STAGING_LOGICAL_SHA" \
    --arg targetProductionIdentity "$TARGET_PRODUCTION_IDENTITY" \
    --arg targetProductionLogicalDigest "$PRODUCTION_LOGICAL_SHA" \
    --arg targetStagingIdentity "$TARGET_STAGING_IDENTITY" \
    --arg targetStagingLogicalDigest "$STAGING_LOGICAL_SHA" \
    '{schema:"nexus.bootstrap-database-transition.v1",createdAt:$createdAt,
      runtimeCaptureSha256:$runtimeCaptureSha256,
      legacy:{production:{path:"/home/dominguez/telegram-hub-bot/data/bot.db",
        identity:$legacyProductionIdentity,logicalDigest:$legacyProductionLogicalDigest},
        staging:{path:"/home/dominguez/telegram-hub-bot-staging/data/bot.db",
        identity:$legacyStagingIdentity,logicalDigest:$legacyStagingLogicalDigest}},
      target:{production:{path:"/var/lib/nexus-hub/production/data/bot.db",
        identity:$targetProductionIdentity,logicalDigest:$targetProductionLogicalDigest},
        staging:{path:"/var/lib/nexus-hub/staging/data/bot.db",
        identity:$targetStagingIdentity,logicalDigest:$targetStagingLogicalDigest}},
      backupDatabasePath:"/var/lib/nexus-hub/production/data/bot.db"}' \
    >"$TRANSITION_TEMP"
  install_or_verify_candidate "$TRANSITION_TEMP" "$TRANSITION_CANDIDATE"
  NEW_TRANSITION_SHA256="$(sha256sum "$TRANSITION_TEMP" | awk '{print $1}')"
  rm -f "$TRANSITION_TEMP"
  sudo jq -e --arg runtimeCaptureSha256 "$NEW_RUNTIME_SHA256" \
    '.schema == "nexus.bootstrap-database-transition.v1"
     and .runtimeCaptureSha256 == $runtimeCaptureSha256' \
    "$TRANSITION_CANDIDATE" >/dev/null || die 'transition candidate is incoherent'

  OLD_RUNTIME_ARCHIVE="$INCIDENT_DIR/bootstrap-legacy-runtime.before.json"
  OLD_TRANSITION_ARCHIVE="$INCIDENT_DIR/bootstrap-database-transition.before.json"
  for SPEC in "$RUNTIME_EVIDENCE:$OLD_RUNTIME_ARCHIVE" \
    "$TRANSITION_EVIDENCE:$OLD_TRANSITION_ARCHIVE"; do
    SOURCE="${SPEC%%:*}"; ARCHIVE="${SPEC#*:}"
    install_or_verify_candidate "$SOURCE" "$ARCHIVE"
  done
  STATE_TEMP="$(mktemp)"; STATE_STAGE="$REBASELINE_STATE.next-$BASHPID"
  sudo jq --arg runtimeSha "$NEW_RUNTIME_SHA256" \
    --arg transitionSha "$NEW_TRANSITION_SHA256" \
    --arg runtimeArchive "$OLD_RUNTIME_ARCHIVE" \
    --arg transitionArchive "$OLD_TRANSITION_ARCHIVE" \
    --arg updatedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '.newEvidence = {runtimeSha256:$runtimeSha,transitionSha256:$transitionSha}
     | .oldEvidence.runtimeArchivePath = $runtimeArchive
     | .oldEvidence.transitionArchivePath = $transitionArchive
     | .phase = "evidence_ready" | .updatedAt = $updatedAt' \
    "$REBASELINE_STATE" >"$STATE_TEMP"
  sudo install -o root -g root -m 600 "$STATE_TEMP" "$STATE_STAGE"
  rm -f "$STATE_TEMP"
  publish_durable_rebaseline_state_stage "$STATE_STAGE"
fi
REBASELINE_PHASE="$(sudo jq -er .phase "$REBASELINE_STATE")"
NEW_RUNTIME_SHA256="$(sudo jq -er .newEvidence.runtimeSha256 "$REBASELINE_STATE")"
NEW_TRANSITION_SHA256="$(sudo jq -er .newEvidence.transitionSha256 "$REBASELINE_STATE")"
OLD_RUNTIME_ARCHIVE="$(sudo jq -er .oldEvidence.runtimeArchivePath "$REBASELINE_STATE")"
OLD_TRANSITION_ARCHIVE="$(sudo jq -er .oldEvidence.transitionArchivePath "$REBASELINE_STATE")"

if test "$REBASELINE_PHASE" = evidence_ready; then
  for SPEC in \
    "$RUNTIME_EVIDENCE:$RUNTIME_CANDIDATE:$NEW_RUNTIME_SHA256:$OLD_RUNTIME_ARCHIVE" \
    "$TRANSITION_EVIDENCE:$TRANSITION_CANDIDATE:$NEW_TRANSITION_SHA256:$OLD_TRANSITION_ARCHIVE"; do
    CANONICAL="${SPEC%%:*}"; REST="${SPEC#*:}"
    CANDIDATE="${REST%%:*}"; REST="${REST#*:}"
    EXPECTED_NEW_SHA="${REST%%:*}"; OLD_ARCHIVE="${REST#*:}"
    test "$(sudo sha256sum "$OLD_ARCHIVE" | awk '{print $1}')" = \
      "$(if test "$CANONICAL" = "$RUNTIME_EVIDENCE"; then
          sudo jq -er .oldEvidence.runtimeSha256 "$REBASELINE_STATE"
        else sudo jq -er .oldEvidence.transitionSha256 "$REBASELINE_STATE"; fi)" \
      || die "old evidence archive changed: $OLD_ARCHIVE"
    CURRENT_SHA="$(sudo sha256sum "$CANONICAL" | awk '{print $1}')"
    if test "$CURRENT_SHA" != "$EXPECTED_NEW_SHA"; then
      test "$(sudo sha256sum "$CANDIDATE" | awk '{print $1}')" = "$EXPECTED_NEW_SHA" \
        || die "new evidence candidate changed: $CANDIDATE"
      sudo mv -T -- "$CANDIDATE" "$CANONICAL"
      sudo sync -f "$(dirname "$CANONICAL")"
    fi
    test "$(sudo sha256sum "$CANONICAL" | awk '{print $1}')" = "$EXPECTED_NEW_SHA" \
      || die "canonical evidence publication failed: $CANONICAL"
  done
  publish_rebaseline_phase evidence_published
fi
REBASELINE_PHASE="$(sudo jq -er .phase "$REBASELINE_STATE")"
test "$(sudo sha256sum "$RUNTIME_EVIDENCE" | awk '{print $1}')" = \
  "$NEW_RUNTIME_SHA256" || die 'canonical runtime capture changed'
test "$(sudo sha256sum "$TRANSITION_EVIDENCE" | awk '{print $1}')" = \
  "$NEW_TRANSITION_SHA256" || die 'canonical transition checkpoint changed'
sudo jq -e --arg runtimeSha "$NEW_RUNTIME_SHA256" \
  --arg productionIdentity "$PRODUCTION_DATABASE_IDENTITY" \
  --arg stagingIdentity "$STAGING_DATABASE_IDENTITY" \
  --arg targetProductionIdentity "$TARGET_PRODUCTION_IDENTITY" \
  --arg targetStagingIdentity "$TARGET_STAGING_IDENTITY" \
  '.schema == "nexus.bootstrap-database-transition.v1"
   and .runtimeCaptureSha256 == $runtimeSha
   and .legacy.production.identity == $productionIdentity
   and .legacy.staging.identity == $stagingIdentity
   and .target.production.identity == $targetProductionIdentity
   and .target.staging.identity == $targetStagingIdentity
   and .backupDatabasePath == "/var/lib/nexus-hub/production/data/bot.db"' \
  "$TRANSITION_EVIDENCE" >/dev/null || die 'published transition checkpoint is incoherent'

if test "$REBASELINE_PHASE" = evidence_published; then
  if ! sudo test -e "$CANDIDATE_BASELINE" && ! sudo test -L "$CANDIDATE_BASELINE"; then
    BASELINE_RESULT="$(sudo /usr/bin/env -i PATH=/usr/bin:/bin \
      HOME=/var/lib/nexus-release/home DOCKER_CONFIG=/etc/nexus-release/docker \
      /usr/bin/npm --prefix /opt/nexus-release/checkout run --silent \
      release:cd:bootstrap-baseline -- \
      --accept-current-history-as-baseline --output-candidate \
      --production-source-sha "$PRODUCTION_SHA" \
      --staging-source-sha "$STAGING_SHA" \
      --expected-release-id "$EXPECTED_RELEASE_ID" \
      --expected-release-payload-digest "$EXPECTED_RELEASE_PAYLOAD_DIGEST")"
    test "$(printf '%s\n' "$BASELINE_RESULT" | jq -er .output)" \
      = "$CANDIDATE_BASELINE" \
      || die 'generator published outside the fixed candidate path'
  fi
  sudo test -f "$CANDIDATE_BASELINE" && sudo test ! -L "$CANDIDATE_BASELINE" \
    || die 'bootstrap baseline candidate is missing or symbolic'
  test "$(sudo stat -Lc '%U:%G:%a:%h' -- "$CANDIDATE_BASELINE")" \
    = 'root:root:600:1' || die 'bootstrap baseline candidate is unsafe'
  require_baseline_shape "$CANDIDATE_BASELINE"
  sudo jq -e --arg releaseId "$EXPECTED_RELEASE_ID" \
    --arg payloadDigest "$EXPECTED_RELEASE_PAYLOAD_DIGEST" \
    --arg productionSha "$PRODUCTION_SHA" --arg stagingSha "$STAGING_SHA" \
    '.target.releaseId == $releaseId
     and .target.releasePayloadDigest == $payloadDigest
     and .legacyRuntime.productionSourceSha == $productionSha
     and .legacyRuntime.stagingSourceSha == $stagingSha' \
    "$CANDIDATE_BASELINE" >/dev/null \
    || die 'candidate baseline differs from durable owner/runtime identity'
  test "$(sudo sha256sum "$BASELINE_FILE" | awk '{print $1}')" \
    = "$OLD_BASELINE_SHA256" \
    || die 'old canonical baseline changed before candidate validation'
  CANDIDATE_BASELINE_SHA256="$(sudo sha256sum "$CANDIDATE_BASELINE" | awk '{print $1}')"
  STATE_TEMP="$(mktemp)"; STATE_STAGE="$REBASELINE_STATE.next-$BASHPID"
  sudo jq --arg candidateSha "$CANDIDATE_BASELINE_SHA256" \
    --arg updatedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '.candidateBaselineSha256 = $candidateSha
     | .phase = "candidate_ready" | .updatedAt = $updatedAt' \
    "$REBASELINE_STATE" >"$STATE_TEMP"
  sudo install -o root -g root -m 600 "$STATE_TEMP" "$STATE_STAGE"
  rm -f "$STATE_TEMP"
  publish_durable_rebaseline_state_stage "$STATE_STAGE"
fi
REBASELINE_PHASE="$(sudo jq -er .phase "$REBASELINE_STATE")"
CANDIDATE_BASELINE_SHA256="$(sudo jq -er .candidateBaselineSha256 "$REBASELINE_STATE")"

if test "$REBASELINE_PHASE" = candidate_ready; then
  sudo install -d -o root -g root -m 700 "$BASELINE_ARCHIVE_DIR"
  if sudo test -e "$ARCHIVED_BASELINE" || sudo test -L "$ARCHIVED_BASELINE"; then
    sudo test -f "$ARCHIVED_BASELINE" && sudo test ! -L "$ARCHIVED_BASELINE" \
      || die 'archived baseline is unsafe'
    test "$(sudo sha256sum "$ARCHIVED_BASELINE" | awk '{print $1}')" \
      = "$OLD_BASELINE_SHA256" || die 'archived baseline differs from admitted baseline'
  else
    test "$(sudo sha256sum "$BASELINE_FILE" | awk '{print $1}')" \
      = "$OLD_BASELINE_SHA256" || die 'cannot archive a changed canonical baseline'
    sudo ln -- "$BASELINE_FILE" "$ARCHIVED_BASELINE"
    sudo sync -f "$BASELINE_ARCHIVE_DIR"
    test "$(sudo stat -Lc '%d:%i' -- "$BASELINE_FILE")" = \
      "$(sudo stat -Lc '%d:%i' -- "$ARCHIVED_BASELINE")" \
      || die 'baseline archive is not the admitted canonical inode'
  fi
  CURRENT_BASELINE_SHA="$(sudo sha256sum "$BASELINE_FILE" | awk '{print $1}')"
  if test "$CURRENT_BASELINE_SHA" = "$OLD_BASELINE_SHA256"; then
    test "$(sudo sha256sum "$CANDIDATE_BASELINE" | awk '{print $1}')" \
      = "$CANDIDATE_BASELINE_SHA256" || die 'candidate baseline changed before swap'
    # The old canonical still has its durable archive name. Only now replace it.
    sudo mv -T -- "$CANDIDATE_BASELINE" "$BASELINE_FILE"
    sudo sync -f "$(dirname "$BASELINE_FILE")"
  fi
  test "$(sudo sha256sum "$BASELINE_FILE" | awk '{print $1}')" \
    = "$CANDIDATE_BASELINE_SHA256" || die 'canonical baseline publication failed'
  require_baseline_shape "$BASELINE_FILE"
  test "$(sudo stat -Lc '%U:%G:%a:%h' -- "$BASELINE_FILE")" \
    = 'root:root:600:1' || die 'new canonical baseline is unsafe'
  sudo jq -e --arg releaseId "$EXPECTED_RELEASE_ID" \
    --arg payloadDigest "$EXPECTED_RELEASE_PAYLOAD_DIGEST" \
    '.target.releaseId == $releaseId
     and .target.releasePayloadDigest == $payloadDigest' \
    "$BASELINE_FILE" >/dev/null || die 'new canonical baseline target differs'
  publish_rebaseline_phase baseline_published
fi
REBASELINE_PHASE="$(sudo jq -er .phase "$REBASELINE_STATE")"

# Retire only the stale terminal recovery state, and only after its exact bytes
# have a root-only incident copy and the new baseline/evidence pair is canonical.
RECOVERY_STATE_ARCHIVE="$INCIDENT_DIR/bootstrap-first-cutover-recovery.before.json"
if test "$REBASELINE_PHASE" = baseline_published; then
  EXPECTED_RECOVERY_STATE_SHA="$(sudo jq -er .oldEvidence.recoveryStateSha256 \
    "$REBASELINE_STATE")"
  if sudo test -e "$FIRST_RECOVERY_STATE" || sudo test -L "$FIRST_RECOVERY_STATE"; then
    sudo test -f "$FIRST_RECOVERY_STATE" && sudo test ! -L "$FIRST_RECOVERY_STATE" \
      || die 'terminal first-cutover recovery state is unsafe'
    test "$(sudo sha256sum "$FIRST_RECOVERY_STATE" | awk '{print $1}')" \
      = "$EXPECTED_RECOVERY_STATE_SHA" || die 'terminal recovery state changed'
    install_or_verify_candidate "$FIRST_RECOVERY_STATE" "$RECOVERY_STATE_ARCHIVE"
    sudo sync -f "$INCIDENT_DIR"
    sudo rm -- "$FIRST_RECOVERY_STATE"
    sudo sync -f "$(dirname "$FIRST_RECOVERY_STATE")"
  else
    test "$(sudo sha256sum "$RECOVERY_STATE_ARCHIVE" | awk '{print $1}')" \
      = "$EXPECTED_RECOVERY_STATE_SHA" \
      || die 'retired recovery state has no exact incident archive'
  fi
  publish_rebaseline_phase complete
fi

test "$(sudo jq -er .phase "$REBASELINE_STATE")" = complete \
  || die 'rebaseline did not reach its durable completion checkpoint'
require_pm2_guard
test "$(sudo sha256sum "$BASELINE_FILE" | awk '{print $1}')" \
  = "$CANDIDATE_BASELINE_SHA256" || die 'canonical baseline changed after publication'
test "$(sudo sha256sum "$RUNTIME_EVIDENCE" | awk '{print $1}')" \
  = "$NEW_RUNTIME_SHA256" || die 'runtime capture changed after publication'
test "$(sudo sha256sum "$TRANSITION_EVIDENCE" | awk '{print $1}')" \
  = "$NEW_TRANSITION_SHA256" || die 'transition evidence changed after publication'
REBASELINE_ARMED=0
trap - EXIT HUP INT TERM
printf 'new owner baseline targets release %s; PM2 remains stopped; state: %s\n' \
  "$EXPECTED_RELEASE_ID" "$REBASELINE_STATE"

```

The automatic 120-second predecessor objective begins only after the bootstrap
receipt has established the first container predecessor. Do not enable the timer
or retire PM2 before that receipt is complete.

Then enable the timer:

```bash
sudo systemctl enable --now nexus-release-poller.timer
```

## 7. Verify

```bash
# what the host believes is deployed, and whether anything is blocked
sudo /usr/bin/env -i PATH=/usr/bin:/bin HOME=/var/lib/nexus-release/home \
  /usr/bin/npm --prefix /opt/nexus-release/checkout \
  run release:cd:ack -- --show

# generated, non-authoritative projection for humans
sudo /usr/bin/env -i PATH=/usr/bin:/bin HOME=/var/lib/nexus-release/home \
  /usr/bin/npm --prefix /opt/nexus-release/checkout \
  run release:cd:state
```

The poller wrapper refuses to run without the kernel flock, so a hand-run and the
timer can never race:

```bash
sudo /usr/bin/env -i PATH=/usr/bin:/bin HOME=/var/lib/nexus-release/home \
  DOCKER_CONFIG=/etc/nexus-release/docker \
  NEXUS_RELEASE_NODE_BIN=/usr/bin/node \
  NEXUS_RELEASE_GIT_BIN=/usr/bin/git \
  NEXUS_RELEASE_FLOCK_BIN=/usr/bin/flock \
  NEXUS_RELEASE_SYSTEMCTL_BIN=/usr/bin/systemctl \
  NEXUS_RELEASE_DOCKER_BIN=/usr/bin/docker \
  NEXUS_RELEASE_SQLITE_BIN=/usr/bin/sqlite3 \
  NEXUS_RELEASE_LSOF_BIN=/usr/bin/lsof \
  NEXUS_RELEASE_SCP_BIN=/usr/bin/scp \
  NEXUS_RELEASE_SSH_BIN=/usr/bin/ssh \
  /opt/nexus-release/checkout/scripts/release-poll.sh # exits 75 if contended
```

Both the release lock and shared maintenance mutex are resolved only from
`config/continuous-deployment.json`; caller variables and `poller.env` cannot
redirect either path. Both release services use `TimeoutStartSec=infinity` so an
aggregate systemd timer cannot kill a release after durable mutation admission.
The poller uses pinned `/usr/bin/git` for bounded, credential-free `ls-remote`
checks of the canonical public protected-main ref at initial admission, after
staging, and after backup, production-ledger reconciliation, and exact backup
revalidation. That third check is the last non-mutating boundary immediately
before write-ahead/migration. `:main` is discovery only. A lookup outage defers
without production mutation; a changed head tears staging down and atomically
retires it. Teardown failure retains active evidence and hard-blocks. The exact
completed-payload no-op remains offline-safe.

The narrower migrator, backup, health, observation, and rollback deadlines remain
the governing operation budgets; a stuck poller retains both mutexes for
inspection instead of allowing another attempt to overlap it.

The same locked poller is the supported crash-recovery command. When `--show`
reports `unprovable_active_release`, do not acknowledge it: start the poller
service (or invoke the wrapper above) and inspect its journal. It verifies the
interrupted signed payload and database integrity before restoring the exact
recorded predecessor payload/Compose identity. Extraction may recreate the
retained predecessor work directory, and the OCI payload does not carry a
materialized migration plan. The recovery path therefore re-verifies the
predecessor's signed manifest identity and Compose digest, then materializes a
fresh v3 verification plan: exact predecessor v2 identity, inventory, and
reconciliation plus the root-projected successor identity and exact ordered
filename/digest prefix of verified compatible successor rows already applied.
Ordinary candidate plans remain v2; unknown and non-prefix rows fail. Normal
rollback follows the same sequence. A
successful recovery leaves `rollback_fired`, which may then be acknowledged by
exact release id. If payload, backup, predecessor, plan, integrity, Compose, or
running-image proof is unavailable, the service exits non-zero, leaves a durable
block, and pages for manual recovery; it never restores database bytes
automatically.

Recovery evidence exposes two clocks: `incidentRecoveryDurationMs` starts before
the recovery block, first page, and evidence revalidation, and reuses the exact
block's durable `since` after a poller retry. The independent
`predecessorSwitchDurationMs` starts immediately before predecessor pull and is
judged against `predecessorSwitchObjectiveSeconds` (120 by policy). Immutable
receipts, release-state history/generated view, and terminal notifications
report all three names explicitly. A restored receipt or rolled-back history
entry whose switch duration exceeds that objective is rejected as invalid.

## 8. Audit mirror

Receipts are mirrored to a separate account on the Pi. A Raspberry Pi Connect
remote-shell session URL is an interactive owner console, not a hostname the
VPS can resolve or a durable route the poller can use. Before setting the host
variable, provision a stable VPS-to-Pi SSH route that works unattended for both
`/usr/bin/ssh` and `/usr/bin/scp` with the transport options below. The current
contract supplies no port argument: the endpoint must be reachable on SSH port
22 (directly, through an owner-managed overlay address, or through a durable
reverse-tunnel/system SSH alias that presents that standard endpoint).

Create `nexus-audit` on the Pi with no sudo or Docker membership, a root-owned
parent, and an account-owned mode-0700 final directory. The final directory must
be a canonical non-symlink path writable by `nexus-audit`: both the `scp` upload
and durable finalize transaction run as that account.

The remote account needs `/bin/sh`, an `scp` server, `sha256sum`, `cut`, GNU
`stat` with `-c`, GNU `sync` with `-f`, `ln`, and `rm`. Prove both the command
surface and filesystem semantics on the Pi before enabling the host variable:

```bash
getent passwd nexus-audit >/dev/null \
  || sudo /usr/sbin/useradd --system --home-dir /var/lib/nexus-release-audit \
    --shell /bin/sh nexus-audit
sudo /usr/sbin/usermod --lock nexus-audit
test -z "$(id -nG nexus-audit | tr ' ' '\n' | grep -Ex 'sudo|docker' || true)"
sudo install -d -o root -g root -m 755 /var/lib/nexus-release-audit
sudo install -d -o nexus-audit -g nexus-audit -m 700 \
  /var/lib/nexus-release-audit/receipts

sudo -u nexus-audit /bin/sh <<'SH'
set -eu
directory=/var/lib/nexus-release-audit/receipts
test -d "$directory"
test ! -L "$directory"
cd "$directory"
test "$(pwd -P)" = "$directory"
test -w .
for binary in scp sha256sum cut stat sync ln rm; do
  command -v "$binary" >/dev/null
done
probe=.nexus-release-audit-prerequisite-probe-$$
trap 'rm -f -- "$probe" "$probe.link"' EXIT HUP INT TERM
printf 'nexus-release-audit-probe\n' >"$probe"
test "$(stat -c '%h' -- "$probe")" = 1
sha256sum -- "$probe" | cut -d ' ' -f 1 >/dev/null
sync -f -- "$probe"
ln -- "$probe" "$probe.link"
test "$(stat -c '%h' -- "$probe")" = 2
rm -f -- "$probe.link" "$probe"
sync -f -- .
trap - EXIT HUP INT TERM
SH
```

On the VPS, generate one key used only for this mirror, then install its public
line in the Pi account's `authorized_keys` with the OpenSSH `restrict` option.
Do not reuse a deploy, operator, runner, or personal key. Transfer the public
line through the authenticated owner console; never paste the private key into
that console.

```bash
sudo test ! -e /etc/nexus-release/trust/audit-mirror-id_ed25519
sudo ssh-keygen -q -t ed25519 -N '' \
  -C nexus-release-audit-mirror \
  -f /etc/nexus-release/trust/audit-mirror-id_ed25519
sudo chown root:root \
  /etc/nexus-release/trust/audit-mirror-id_ed25519 \
  /etc/nexus-release/trust/audit-mirror-id_ed25519.pub
sudo chmod 600 /etc/nexus-release/trust/audit-mirror-id_ed25519
sudo chmod 644 /etc/nexus-release/trust/audit-mirror-id_ed25519.pub
sudo ssh-keygen -lf /etc/nexus-release/trust/audit-mirror-id_ed25519.pub
```

On the Pi, replace the placeholder with the exact single public-key line copied
from the VPS. Preserve the `restrict` option at the beginning of the installed
line:

```bash
AUDIT_PUBLIC_KEY='<exact ssh-ed25519 public-key line from the VPS>'
case "$AUDIT_PUBLIC_KEY" in
  'ssh-ed25519 '*) ;;
  *) echo 'invalid audit public key' >&2; exit 1 ;;
esac
sudo install -d -o nexus-audit -g nexus-audit -m 700 \
  /var/lib/nexus-release-audit/.ssh
sudo test ! -e /var/lib/nexus-release-audit/.ssh/authorized_keys
printf 'restrict %s\n' "$AUDIT_PUBLIC_KEY" \
  | sudo tee /var/lib/nexus-release-audit/.ssh/authorized_keys >/dev/null
sudo chown nexus-audit:nexus-audit \
  /var/lib/nexus-release-audit/.ssh/authorized_keys
sudo chmod 600 /var/lib/nexus-release-audit/.ssh/authorized_keys
```

The transfer uses `StrictHostKeyChecking=yes` with an explicitly pinned
`known_hosts`. The default `$HOME/.ssh/known_hosts` is unreachable under
`ProtectHome=yes`, so provision the pinned file — the mirror refuses to run
without it rather than relaxing host checking:

```bash
PI_HOST=nexushub.local
EXPECTED_PI_HOST_FINGERPRINT='<exact SHA256:... from sudo ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub on the Pi>'
KNOWN_HOSTS_TMP="$(mktemp)"
trap 'rm -f -- "$KNOWN_HOSTS_TMP"' EXIT HUP INT TERM
ssh-keyscan -t ed25519 "$PI_HOST" >"$KNOWN_HOSTS_TMP"
OBSERVED_PI_HOST_FINGERPRINT="$(ssh-keygen -lf "$KNOWN_HOSTS_TMP" \
  | awk '{print $2}' | sort -u)"
test "$OBSERVED_PI_HOST_FINGERPRINT" = "$EXPECTED_PI_HOST_FINGERPRINT"
sudo install -o root -g root -m 644 -- "$KNOWN_HOSTS_TMP" \
  /etc/nexus-release/trust/audit-mirror-known_hosts
test "$(sudo stat -Lc '%U:%G:%a:%h' -- \
  /etc/nexus-release/trust/audit-mirror-known_hosts)" = root:root:644:1
rm -f -- "$KNOWN_HOSTS_TMP"
trap - EXIT HUP INT TERM
```

Verify inside the hardened unit, which is where it actually runs:

```bash
PI_HOST=nexushub.local
sudo systemd-run --pipe --wait \
  --property=ProtectHome=yes --property=ProtectSystem=full \
  /usr/bin/ssh -o BatchMode=yes -o IdentitiesOnly=yes \
  -o StrictHostKeyChecking=yes \
  -o UserKnownHostsFile=/etc/nexus-release/trust/audit-mirror-known_hosts \
  -i /etc/nexus-release/trust/audit-mirror-id_ed25519 \
  "nexus-audit@$PI_HOST" true
```

Only after that proof succeeds, set
`NEXUS_RELEASE_AUDIT_MIRROR_HOST=nexushub.local` in `poller.env`. Use that name
only when the VPS resolves it and the Pi is reachable on port 22; repository
state does not prove either live fact. Account/key provisioning and the hardened
SSH proof remain required before the mirror is enabled. Never put a URL,
`user@host`, shell option, or `host:port` there; the governed account is already
fixed as `nexus-audit`. If SSH proof fails, leave the variable empty. That is a
supported non-gating release state, but independent receipt observability is
incomplete until the account, dedicated key, host pin, and stable route are
provisioned.

Delivery is durably queued under `/var/lib/nexus-release/mirror-queue`. A receipt
is enqueued before the transfer is attempted and dequeued only once delivered, so
a poller that dies mid-`scp` retries on the next poll instead of losing the audit
record. After `maxAttempts` the entry moves to `mirror-queue/failed/` and alerts
only after the exhausted-entry evidence is durable. If that evidence cannot be
written, the source entry stays queued with a `deferred` result for a later retry;
no exhaustion alert is emitted.

The mirror is non-gating throughout: a failure alerts but never changes a
deployment verdict. Leaving the host unset disables mirroring cleanly; it must
not be described as a completed audit-host installation.

## 8a. Lock order during the PM2 transition

Three mutex files exist while PM2 remains available as the cutover fallback;
the maintenance mutex is the one real exclusion boundary shared by both runtime
paths:

| Lock | Holder | Purpose |
| --- | --- | --- |
| `/var/lib/nexus-release/locks/release.lock` | poller (`scripts/release-poll.sh`) | serializes container releases |
| `/home/dominguez/.local/state/nexus-release/.release.lock` | legacy PM2 transaction and user capability operations | serializes user-owned PM2 mutations |
| `/run/lock/nexus-release-sonar.lock` | poller (second lock), legacy PM2 transaction (second lock), data-key rotation, Ollama finalize | shared root maintenance mutex, retained under its historical filename only |

**Lock order is release lock first, maintenance mutex second — never the
reverse.** The poller takes its root release lock and then the maintenance mutex;
the PM2 path takes its user release lock and then that same maintenance mutex.
No path takes both release locks. Every acquisition is non-blocking, so
contention exits 75 and releases the first lock instead of waiting in the
opposite order. Both scripts verify the maintenance file is a non-symlink
`root:dominguez 0660` file and that the locked descriptor still names it.
The poller obtains both pathnames solely from the governed CD policy; neither
pathname has an environment override.

The practical rule while both paths exist: do not run a legacy PM2 transaction or
a data-key rotation while the poller timer is enabled. Stop the timer, do the
maintenance, then re-enable it:

```bash
sudo systemctl stop nexus-release-poller.timer
# ... legacy maintenance ...
sudo systemctl start nexus-release-poller.timer
```

`flock --nonblock` means a poll that collides simply exits 75 and retries, so a
collision degrades throughput rather than correctness.

## 9. Notifications

A dedicated Telegram bot and chat, not the product bot: release alerts must not
depend on, or be able to reach, user conversations. Set
`NEXUS_RELEASE_TELEGRAM_BOT_TOKEN` and `NEXUS_RELEASE_TELEGRAM_CHAT_ID` in
`poller.env`.

Failure and recovery messages are built only from structured values, are
hard-bounded, and pass through the release detail sanitizer. Raw logs, user data,
OAuth tokens, credentials, and provider responses are forbidden inputs; unknown
or credential-shaped detail is redacted fail-closed. Recovery alerts label full
incident seconds, predecessor-switch seconds, and the switch objective separately.
The weekly heartbeat is the
liveness proof for this channel — a
silent-on-success alerting path that has quietly broken looks exactly like a
quiet week.

Failures before signature verification have their own root-owned durable source:
`/var/lib/nexus-release/state/release-discovery-alert.json`, schema
`nexus.release-discovery-alert-state.v1`. The poller opens and fsyncs the event
before delivery while holding and descriptor-reproving the release mutex. One
`release_discovery:poll_failed` edge is attempted immediately, then after 60 and
120 seconds; a third failed attempt becomes durable `dead_letter`. A delivered
or dead-letter event suppresses every 30-second repeat. The CLI marks the
condition healthy only from a closed result shape that proves signed discovery,
an exact completed-payload no-op, or an ordinary completed/blocked/staging
receipt. An early block, crash-recovery return, or receiptless failure does not
rearm the edge.

`controller_schema_incompatible` means the installed reader cannot consume the
published envelope and requires the attended immutable controller upgrade.
Other pre-identity failures use `release_discovery_failed`. Telegram shows the
fixed source, severity, dedupe key, action, and this runbook URL. `release` and
`commit` deliberately remain `unknown` until signature verification establishes
a trustworthy identity; filling them from a moving tag or error text would
fabricate evidence. Raw exception text, logs, and provider bodies are never
persisted or sent.

Inspect the closed state without reading provider output:

```bash
sudo /usr/bin/jq -e '
  .schema == "nexus.release-discovery-alert-state.v1"
  and (.condition == null or (.condition.status == "healthy" or .condition.status == "failed"))
  and (.events | type == "array" and length <= 1)
' /var/lib/nexus-release/state/release-discovery-alert.json
```

An absent file means no incident has been opened. Malformed state, unsafe
metadata, a changed lock descriptor, or an unsafe stale temporary refuses both
state mutation and any ad-hoc fallback page, but remains non-gating for the
release verdict. Repair the root authority from the exact immutable controller;
do not delete or hand-edit the alert file to suppress an incident.

## 10. Raspberry Pi runner access

The Pi runner account is CI-verification-only; the separate `nexus-audit`
account owns the inaccessible audit-mirror receipt directory described in §8.
Because the repository is public, the persistent runner is eligible only for
trusted pushes to `develop`. Pull requests, including forks, and protected-main
pushes always use ephemeral GitHub-hosted runners.
Keep the machine's Raspberry Pi Connect URL
**operator-only**: it is a remote-shell path onto a machine that runs repository
code, and sharing it would widen the trust boundary the test-only posture exists
to keep narrow. Do not put the URL in CI variables, workflow files, receipts, or
notifications.

### Install the immutable test-only guard

CI runs this as the first step of every dynamically routed self-hosted job,
**before** any checkout or other repository-controlled command, from a root-owned
path outside the workspace:

```bash
getent passwd nexus-ci >/dev/null \
  || sudo /usr/sbin/useradd --system --create-home --user-group \
    --home-dir /var/lib/nexus-ci --shell /bin/bash nexus-ci
sudo /usr/sbin/usermod --lock nexus-ci
test -z "$(id -nG nexus-ci | tr ' ' '\n' | grep -Ex 'sudo|docker|nexus-audit' || true)"
sudo install -o root -g root -m 755 \
  /opt/nexus-release/checkout/ops/pi-runner/nexus-pi-guardrails \
  /usr/local/sbin/nexus-pi-guardrails
sudo -u nexus-ci /usr/local/sbin/nexus-pi-guardrails --json
```

It must exit 0 as the runner account. It asserts the absence of a Docker socket or
reachable daemon, registry credentials, production env/trust/state/backup paths,
and any read/write/traverse access to the `nexus-audit` final receipt directory,
plus passwordless sudo, root identity, and private SSH keys. CI additionally
refuses a guard the runner account can write to — a writable guard is the same as
no guard.

Register the runner with exactly these labels, which CI matches on:

```text
self-hosted, linux, ARM64, nexus-pi
```

Keep the repository variable `NEXUS_CI_TEST_RUNNER` unset until the owner has
explicitly authorized the full (test-executing) readiness command and it exits
zero as `nexus-ci`. Authorization alone is not readiness evidence: an installed
account or capabilities-only guard is insufficient, and CI must continue
selecting GitHub-hosted runners until the complete live proof succeeds.

The runner account must not be able to reach `/var/run/docker.sock`,
`/etc/nexus-release/*.env`, the audit-mirror key,
`/var/lib/nexus-release-audit/receipts`, or `/var/lib/nexus-release`.
CI re-asserts this separately on every job allocation through the installed,
root-owned `/usr/local/sbin/nexus-pi-guardrails --json`. A successful
`runner_guardrails` job is only an early graph gate; it cannot attest a later job
that GitHub may place on another machine with the same labels. The repository
readiness script is a provisioning diagnostic, not the immutable CI guard.

## 11. PM2 during cutover

Keep PM2 installed but stopped and permanently guarded during the first-cutover
recovery window. Retirement becomes eligible exactly 14 days after the
`completedAt` of the first completed container receipt bound by
`bootstrap-baseline.json`; a remembered cutover time, release count, or current
health alone is not admission evidence.

The implementation may be installed before that deadline. Live apply must wait
until the dry-run admits all of the following at one locked observation:

- the canonical baseline and its exact completed anchor receipt match source,
  manifest, payload, and both digest-bound bootstrap checks; `baselineSha256`
  and both receipt hashes bind exact immutable file bytes, while the distinct
  `baselineAuthorizationDigest` is the canonical-JSON digest bound by those
  existing bootstrap checks;
- current state resolves to the exact active immutable `completed` receipt with
  no block, recovery gate, control-plane transaction, incomplete rebaseline
  stage, or PM2 install journal. One exact terminal `complete`
  `nexus.bootstrap-rebaseline.v1` checkpoint is accepted only when its root-only
  bytes, filename release identity, target payload, candidate-baseline digest,
  and production/staging runtime sources bind the current canonical baseline,
  while its new-evidence digests still match the canonical runtime and
  database-transition evidence files. Any incomplete,
  malformed, additional, or prior-target rebaseline record remains conflicting.
  The accepted terminal evidence is hashed into the retirement plan and must
  remain byte-identical through resume. The v3 receipt's
  control-plane schema/digest equals the identity recomputed from
  `/opt/nexus-release/checkout`; the complete immutable tree digest is recomputed
  and its selected `better-sqlite3` binding must load and execute a query at
  admission;
- NTP is synchronized; production and staging have their exact healthy active
  images; the poller, heartbeat, backup-liveness, backup, and restore-verify
  timers are enabled and active; the poller, backup, and restore services have
  settled successfully;
- no PM2 process or open closure handle exists, and the root PM2 launcher,
  package lock, closure, and
  `/var/lib/nexus-release-promotion/pm2-root-install.v1.json` exactly match their
  attestation;
- neither legacy `bot.db` nor an existing `-wal`, `-shm`, or `-journal` sidecar
  has an open handle; the latest encrypted backup is at most two hours old and
  restore-verification evidence is at most eight days old;
- both `pm2-dominguez.service` and
  `nexus-release-pm2-recovery-daemon.service` resolve only through their exact
  root-owned `/etc/systemd/system.control/<unit> -> /dev/null` guards and cannot
  start.

Dry-run from the installed, immutable control-plane checkout. It takes the
control-plane, user-release, shared maintenance, and shared governed-backup
flocks and performs no host mutation. The backup flock descriptor remains
bound throughout backup and restore-evidence inspection. Exit 75 with
`stable_window_open` before the exact deadline is the expected result, not
authorization to override it:

```bash
sudo /usr/bin/env -i \
  PATH=/usr/bin:/bin \
  HOME=/var/lib/nexus-release/home \
  /usr/bin/node \
  /opt/nexus-release/checkout/scripts/retire-pm2-fallback.mjs
```

An eligible result prints the exact four-part confirmation:
`<active-release-id>:<active-receipt-sha256>:<anchor-release-id>:<anchor-receipt-sha256>`.
Apply only that value with explicit owner authorization. The service must be
detached from SSH and execute Node directly so `SYSTEMD_EXEC_PID` identifies the
retirement process; do not add `--wait` or `--pipe`:

If and only if the historical root closure is exact but
`/var/lib/nexus-release-promotion/pm2-root-install.v1.json` is absent, use the
governed recovery entrypoint before repeating the retirement dry-run. Recovery
does not infer or fabricate the missing source archive digest: it verifies the
entire installed closure against its exact manifest and trusted package lock,
the launcher, PM2 package, and Node runtime, then publishes the distinct
`nexus.pm2-root-install-recovered.v1` schema with a no-replace atomic write.
Any install/retirement journal, tombstone, additional closure, changed file, or
existing attestation refuses recovery. First capture the dry-run confirmation,
then apply that exact digest only with explicit owner authorization:

```bash
PM2_ATTESTATION_CONFIRM="$({
  sudo /usr/bin/env -i \
    PATH=/usr/bin:/bin \
    HOME=/var/lib/nexus-release/home \
    /usr/bin/node \
    /opt/nexus-release/checkout/scripts/recover-pm2-root-attestation.mjs
} | /usr/bin/jq -er '.confirmation')"

sudo /usr/bin/env -i \
  PATH=/usr/bin:/bin \
  HOME=/var/lib/nexus-release/home \
  NEXUS_RELEASE_OWNER_AUTHORIZED=1 \
  /usr/bin/node \
  /opt/nexus-release/checkout/scripts/recover-pm2-root-attestation.mjs \
  --apply --confirm "$PM2_ATTESTATION_CONFIRM"
```

This is a one-time evidence recovery for an already-installed exact closure,
not permission to rebuild, replace, start, or otherwise mutate PM2.

```bash
PM2_RETIRE_CONFIRM='<exact confirmation from the immediately preceding dry-run>'
PM2_RETIRE_UNIT="nexus-pm2-fallback-retirement-$(date -u +%Y%m%dT%H%M%SZ)"

sudo /usr/bin/systemd-run \
  --unit="$PM2_RETIRE_UNIT" \
  --no-block \
  --property=Type=exec \
  --property=RemainAfterExit=yes \
  --working-directory=/opt/nexus-release/checkout \
  --setenv=NEXUS_RELEASE_OWNER_AUTHORIZED=1 \
  --setenv=PATH=/usr/bin:/bin \
  /usr/bin/node \
  /opt/nexus-release/checkout/scripts/retire-pm2-fallback.mjs \
  --apply --confirm "$PM2_RETIRE_CONFIRM"

sudo /usr/bin/systemctl show "${PM2_RETIRE_UNIT}.service" \
  --property=ActiveState,SubState,Result,ExecMainStatus --no-pager
sudo /usr/bin/journalctl -u "${PM2_RETIRE_UNIT}.service" --no-pager
```

The write-ahead transaction is resumable and monotonic:
`admitted -> fallback_barred -> systemd_retired -> closure_detached ->
package_retired -> verified`.
It writes
`/var/lib/nexus-release/state/pm2-fallback-retirement.json`, then publishes the
no-replace `pm2-fallback-retired.json` tombstone before removing any executable
authority. It deletes the journal only after the immutable terminal receipt and
retained closure manifest are durable under
`/var/lib/nexus-release/retirements/pm2-fallback/`. A crash or
failed verification is not permission to restore PM2 or remove evidence: rerun
the detached apply with the same confirmation so the exact durable phase can
resume. A malformed/conflicting journal, tombstone, or receipt blocks.

If an interrupted transaction is already exactly at `systemd_retired` and a
subsequent signed control-plane repair makes the immutable controller differ
from the controller admitted by the journal, do not edit the journal, roll back
the controller, or weaken continuity to branch ancestry. With explicit owner
authorization, inspect and authorize exactly that installed successor once:

```bash
PM2_SUCCESSOR_CONFIRM="$({
  sudo /usr/bin/env -i \
    PATH=/usr/bin:/bin \
    HOME=/var/lib/nexus-release/home \
    /usr/bin/node \
    /opt/nexus-release/checkout/scripts/retire-pm2-fallback.mjs \
    --inspect-control-plane-successor
} | /usr/bin/jq -er '.candidate.authorizationDigest')"

sudo /usr/bin/env -i \
  PATH=/usr/bin:/bin \
  HOME=/var/lib/nexus-release/home \
  NEXUS_RELEASE_OWNER_AUTHORIZED=1 \
  /usr/bin/node \
  /opt/nexus-release/checkout/scripts/retire-pm2-fallback.mjs \
  --authorize-control-plane-successor --confirm "$PM2_SUCCESSOR_CONFIRM"
unset PM2_SUCCESSOR_CONFIRM
```

The authorization is a root-owned mode `0600`, no-replace record bound to the
exact transaction ID, unchanged plan digest, `systemd_retired` phase, admitted
controller identity, and installed successor identity. Later controller drift,
a different phase, an altered record, or a second authorization refuses. The
same original four-part retirement confirmation still resumes the journal, and
the terminal receipt retains and hashes the successor record.

The removal allowlist is closed: the two canonical PM2 unit files and their
`multi-user.target.wants` links when captured by the plan,
`/usr/local/bin/pm2`,
`/usr/local/share/nexus-release/pm2-package-lock.json`, the attestation above,
and only its exact `/opt/nexus-release/pm2/<version>` closure. Before recursive
removal, the closure is atomically renamed on the same filesystem to the
transaction-derived
`/opt/nexus-release/.pm2-fallback-retirement-<transaction-id>` quarantine. The
durable manifest binds every admitted path, type, mode, size, and file digest;
a crash during unit unlink, detachment, or purge may resume only the exact
remaining subset. Filesystem crossings, symbolic links, changed entries, and
new quarantine paths refuse instead of being deleted. The quarantine must be
absent when the terminal receipt is published.

The two `system.control` guards remain forever. Preserve both legacy checkout/config
trees, `/home/dominguez/.pm2`, `/etc/nexus-release`, `/var/lib/nexus-release`,
`/var/lib/nexus-hub`, and `/srv/nexus-backups/application`; the transaction has
no allowlisted mutation for unrelated content in them. Its only
`/var/lib/nexus-release` mutations are the exact journal, tombstone, terminal
receipt, retained closure-manifest, and, only for the bounded recovery above,
the transaction-bound control-plane-successor evidence paths named above.
`scripts/retire-legacy-release-machinery.sh` is not this procedure and must not
be reused for it.

Runtime gates distinguish an interrupted transaction from completed retirement.
The ordinary poller service and wrapper refuse while
`pm2-fallback-retirement.json` exists, but the terminal tombstone does not block
later container releases. The one-time bootstrap service refuses either file.
Heartbeat remains available so backup/notification liveness stays observable.
Before any attended PM2 fallback attempt, root must prove that neither file nor
a symlink at either name exists; the user transaction also requires the canonical
PM2 unit to be exact and active, so the permanent guard blocks a direct revival:

```bash
sudo test ! -e /var/lib/nexus-release/state/pm2-fallback-retirement.json
sudo test ! -L /var/lib/nexus-release/state/pm2-fallback-retirement.json
sudo test ! -e /var/lib/nexus-release/state/pm2-fallback-retired.json
sudo test ! -L /var/lib/nexus-release/state/pm2-fallback-retired.json
```
