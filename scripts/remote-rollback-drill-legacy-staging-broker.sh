#!/usr/bin/env bash
# Root-owned, one-shot adapter for the exact control-v2 legacy staging layout.
# It is deliberately drill-only. The accepted request, predecessor, selector,
# outage clock, readiness, and terminal evidence are journaled independently
# from ordinary release promotion state.
set -euo pipefail
umask 077
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH

VERSION=nexus-rollback-drill-legacy-staging-broker.v1
COMMAND="${1:-}"
[ "$#" -gt 0 ] && shift
TEST_MODE="${NEXUS_LEGACY_DRILL_TEST_MODE:-0}"
if [ "$TEST_MODE" = 1 ] && [ "$EUID" -eq 0 ]; then
  echo "legacy staging drill broker: test mode may not cross a privileged uid boundary" >&2
  exit 77
fi
STATE_ROOT="${NEXUS_LEGACY_DRILL_STATE_ROOT:-/var/lib/nexus-rollback-drill-legacy-staging}"
BASE="${NEXUS_LEGACY_DRILL_BASE:-/home/dominguez/telegram-hub-bot-staging}"
WORKER_USER="${NEXUS_LEGACY_DRILL_WORKER_USER:-dominguez}"
CONTROL_BIN="${NEXUS_LEGACY_DRILL_CONTROL_BIN:-/usr/local/sbin/nexus-release-promotion-control}"
ADAPTER_BIN="${NEXUS_LEGACY_DRILL_ADAPTER_BIN:-/usr/local/libexec/nexus-rollback-drill-legacy-staging-adapter.mjs}"
DEPENDENCY_BIN="${NEXUS_LEGACY_DRILL_DEPENDENCY_BIN:-/usr/local/libexec/nexus-release-runtime-dependencies.mjs}"
INSTALLED_ATTESTOR="${NEXUS_LEGACY_DRILL_INSTALLED_ATTESTOR:-/usr/local/libexec/nexus-release-installed-tree-attestation.mjs}"
RECOVERY_ATTESTOR="${NEXUS_LEGACY_DRILL_RECOVERY_ATTESTOR:-/usr/local/libexec/nexus-release-recovery-runtime-identity.mjs}"
SQLITE_HELPER="${NEXUS_LEGACY_DRILL_SQLITE_HELPER:-/usr/local/libexec/nexus-application-dr/application-dr-sqlite.py}"
FILESYSTEM_HELPER="${NEXUS_LEGACY_DRILL_FILESYSTEM_HELPER:-/usr/local/libexec/nexus-rollback-drill-legacy-staging-fs.py}"
PROC_ROOT="${NEXUS_LEGACY_DRILL_PROC_ROOT:-/proc}"
RELEASE_PUBLIC_KEY="${NEXUS_LEGACY_DRILL_RELEASE_PUBLIC_KEY:-/etc/nexus-release/release-evidence-public-key.pem}"
INSTALL_RECEIPT="${NEXUS_LEGACY_DRILL_INSTALL_RECEIPT:-$STATE_ROOT/install-receipt.v1.json}"
TRANSACTION_UNIT="${NEXUS_LEGACY_DRILL_TRANSACTION_UNIT:-/etc/systemd/system/nexus-rollback-drill-legacy-staging@.service}"
RECOVERY_UNIT="${NEXUS_LEGACY_DRILL_RECOVERY_UNIT:-/etc/systemd/system/nexus-rollback-drill-legacy-staging-recovery.service}"
PM2_DOMINGUEZ_DROP_IN="${NEXUS_LEGACY_DRILL_PM2_DOMINGUEZ_DROP_IN:-/etc/systemd/system/pm2-dominguez.service.d/10-nexus-rollback-drill-legacy-staging-recovery.conf}"
PM2_ROOT_DROP_IN="${NEXUS_LEGACY_DRILL_PM2_ROOT_DROP_IN:-/etc/systemd/system/pm2-root.service.d/10-nexus-rollback-drill-legacy-staging-recovery.conf}"
SUDOERS_FILE="${NEXUS_LEGACY_DRILL_SUDOERS_FILE:-/etc/sudoers.d/nexus-rollback-drill-legacy-staging}"
NODE_BIN="${NEXUS_LEGACY_DRILL_NODE_BIN:-/usr/bin/node}"
PYTHON_BIN="${NEXUS_LEGACY_DRILL_PYTHON_BIN:-/usr/bin/python3}"
FUSER_BIN="${NEXUS_LEGACY_DRILL_FUSER_BIN:-/usr/bin/fuser}"
PM2_BIN="${NEXUS_LEGACY_DRILL_PM2_BIN:-/usr/local/bin/pm2}"
BASH_BIN="${NEXUS_LEGACY_DRILL_BASH_BIN:-/usr/bin/bash}"
CURL_BIN="${NEXUS_LEGACY_DRILL_CURL_BIN:-/usr/bin/curl}"
TIMEOUT_BIN="${NEXUS_LEGACY_DRILL_TIMEOUT_BIN:-/usr/bin/timeout}"
SETPRIV_BIN="${NEXUS_LEGACY_DRILL_SETPRIV_BIN:-/usr/bin/setpriv}"
ENV_BIN="${NEXUS_LEGACY_DRILL_ENV_BIN:-/usr/bin/env}"
SYSTEMCTL_BIN="${NEXUS_LEGACY_DRILL_SYSTEMCTL_BIN:-/usr/bin/systemctl}"
FLOCK_BIN="${NEXUS_LEGACY_DRILL_FLOCK_BIN:-/usr/bin/flock}"
PROMOTION_STATE_ROOT="${NEXUS_PROMOTION_STATE_ROOT:-/var/lib/nexus-release-promotion}"
PROMOTION_CONTROL_LOCK="$PROMOTION_STATE_ROOT/.control.lock"
SONAR_LOCK="${NEXUS_LEGACY_DRILL_SONAR_LOCK:-/run/lock/nexus-release-sonar.lock}"
UPLOAD_ROOT="$BASE/.local/release/legacy-staging-drill"
REQUESTS="$STATE_ROOT/requests"
TRANSACTIONS="$STATE_ROOT/transactions"
PREPARATIONS="$STATE_ROOT/preparations"
EXPECTED_CONTROL_SHA256="${NEXUS_LEGACY_DRILL_EXPECTED_CONTROL_SHA256:-fb66d9257ec0b7b6f2c582d326c5ed3f6c01071f5792a4045c42199b6691edf1}"
EXPECTED_SQLITE_HELPER_SHA256="${NEXUS_LEGACY_DRILL_EXPECTED_SQLITE_HELPER_SHA256:-e1f1a92d4dc49bd6fe6c1d8c1a3573ec2db61f6374a1831b2765a5541943708d}"
EXPECTED_NODE_VERSION=v22.23.1
STABILITY_SECONDS=60
RECOVERY_TARGET_SECONDS=120
LOCKS_HELD=false

die() {
  echo "legacy staging drill broker: $*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage:
  nexus-rollback-drill-legacy-staging-broker version
  nexus-rollback-drill-legacy-staging-broker inspect
  nexus-rollback-drill-legacy-staging-broker prepare <request-id> <runtime-sha> <artifact-digest>
  nexus-rollback-drill-legacy-staging-broker launch <request-id>
  nexus-rollback-drill-legacy-staging-broker run <request-id>
  nexus-rollback-drill-legacy-staging-broker status <request-id>
  nexus-rollback-drill-legacy-staging-broker fetch-evidence <request-id>
  nexus-rollback-drill-legacy-staging-broker recover-all
  nexus-rollback-drill-legacy-staging-broker assert-boot-safe
  nexus-rollback-drill-legacy-staging-broker assert-terminal-retirement-ready
EOF
}

case "$COMMAND" in
  version|inspect|recover-all|assert-boot-safe|assert-terminal-retirement-ready)
    [ "$#" -eq 0 ] || { usage >&2; exit 64; }
    ;;
  launch|run|status|fetch-evidence) [ "$#" -eq 1 ] || { usage >&2; exit 64; } ;;
  prepare) [ "$#" -eq 3 ] || { usage >&2; exit 64; } ;;
  *) usage >&2; exit 64 ;;
esac

if [ "$TEST_MODE" != 1 ]; then
  [ "$EUID" -eq 0 ] || {
    echo "legacy staging drill broker requires root" >&2
    exit 77
  }
  [ "$BASE" = /home/dominguez/telegram-hub-bot-staging ] \
    || die "production legacy staging base may not be overridden"
  [ "$WORKER_USER" = dominguez ] \
    || die "production legacy staging worker may not be overridden"
  [ "$CONTROL_BIN" = /usr/local/sbin/nexus-release-promotion-control ] \
    || die "production control identity may not be overridden"
  [ "$EXPECTED_CONTROL_SHA256" = fb66d9257ec0b7b6f2c582d326c5ed3f6c01071f5792a4045c42199b6691edf1 ] \
    || die "production control digest may not be overridden"
  [ "$SQLITE_HELPER" = /usr/local/libexec/nexus-application-dr/application-dr-sqlite.py ] \
    && [ "$EXPECTED_SQLITE_HELPER_SHA256" = e1f1a92d4dc49bd6fe6c1d8c1a3573ec2db61f6374a1831b2765a5541943708d ] \
    || die "production SQLite helper identity may not be overridden"
  [ "$FILESYSTEM_HELPER" = /usr/local/libexec/nexus-rollback-drill-legacy-staging-fs.py ] \
    || die "production filesystem helper path may not be overridden"
  [ "$PROC_ROOT" = /proc ] \
    || die "production procfs root may not be overridden"
  [ "$PYTHON_BIN" = /usr/bin/python3 ] && [ "$FUSER_BIN" = /usr/bin/fuser ] \
    || die "production database tool paths may not be overridden"
fi

UUID_RE='^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
SHA_RE='^[a-f0-9]{40}$'
DIGEST_RE='^[a-f0-9]{64}$'

validate_request_id() {
  [[ "$1" =~ $UUID_RE ]] || {
    echo "legacy staging drill request id is invalid" >&2
    exit 64
  }
}

sha256_file() {
  "$NODE_BIN" - "$1" <<'NODE'
const crypto=require('node:crypto');const fs=require('node:fs');
const file=process.argv[2];
const fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));
try{
 const before=fs.fstatSync(fd),body=fs.readFileSync(fd),after=fs.fstatSync(fd);
 if(!before.isFile()||before.nlink!==1||before.dev!==after.dev
  ||before.ino!==after.ino||before.size!==after.size
  ||before.mtimeMs!==after.mtimeMs)process.exit(1);
 process.stdout.write(crypto.createHash('sha256').update(body).digest('hex'));
}finally{fs.closeSync(fd);}
NODE
}

fsync_path() {
  "$NODE_BIN" - "$1" <<'NODE'
const fs=require('node:fs');const fd=fs.openSync(process.argv[2],'r');
try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
NODE
}

move_exact() {
  if [ "$TEST_MODE" = 1 ]; then
    "$NODE_BIN" -e '
const fs=require("node:fs");
fs.renameSync(process.argv[1],process.argv[2]);' "$1" "$2"
  else
    mv -T -- "$1" "$2"
  fi
}

root_own() {
  [ "$TEST_MODE" = 1 ] || chown root:root "$1"
}

ensure_worker_upload_root() {
  "$PYTHON_BIN" - "$BASE" "$UPLOAD_ROOT" "$WORKER_UID" "$WORKER_GID" \
    "$TEST_MODE" <<'PY'
import errno
import os
import stat
import sys

base, upload_root, uid_raw, gid_raw, test_mode = sys.argv[1:]
uid, gid = int(uid_raw), int(gid_raw)
flags = os.O_RDONLY | os.O_DIRECTORY | getattr(os, "O_NOFOLLOW", 0)

def fail(message):
    raise SystemExit(message)

def open_absolute(directory):
    if not os.path.isabs(directory) or os.path.normpath(directory) != directory:
        fail("worker path is not canonical")
    descriptor = os.open("/", flags)
    try:
        for component in directory.split(os.sep)[1:]:
            child = os.open(component, flags, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = child
            observed = os.fstat(descriptor)
            if not stat.S_ISDIR(observed.st_mode):
                fail("worker path component is not a directory")
            if observed.st_uid not in (0, uid) or observed.st_mode & 0o022:
                fail("worker path ancestor ownership or mode is unsafe")
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise

base_fd = open_absolute(base)
try:
    relative = os.path.relpath(upload_root, base)
    if relative.startswith("..") or os.path.isabs(relative):
        fail("worker upload root escapes the legacy base")
    descriptor = os.dup(base_fd)
    try:
        for component in relative.split(os.sep):
            created = False
            try:
                child = os.open(component, flags, dir_fd=descriptor)
            except FileNotFoundError:
                try:
                    os.mkdir(component, 0o700, dir_fd=descriptor)
                    created = True
                except FileExistsError:
                    pass
                child = os.open(component, flags, dir_fd=descriptor)
            if created:
                os.fchmod(child, 0o700)
                if test_mode != "1":
                    os.fchown(child, uid, gid)
            os.close(descriptor)
            descriptor = child
            observed = os.fstat(descriptor)
            mode = stat.S_IMODE(observed.st_mode)
            if not stat.S_ISDIR(observed.st_mode) or observed.st_uid != uid \
                    or observed.st_gid != gid or mode & 0o022:
                fail("worker upload path ownership or mode is unsafe")
        observed = os.fstat(descriptor)
        if stat.S_IMODE(observed.st_mode) != 0o700:
            fail("worker upload root mode is unsafe")
    finally:
        os.close(descriptor)
finally:
    os.close(base_fd)
PY
}

ensure_state() {
  if [ "$TEST_MODE" = 1 ]; then
    install -d -m 700 "$STATE_ROOT" "$REQUESTS" "$TRANSACTIONS" \
      "$PREPARATIONS"
    install -d -m 700 "$(dirname -- "$PROMOTION_CONTROL_LOCK")" \
      "$(dirname -- "$SONAR_LOCK")"
    [ -e "$PROMOTION_CONTROL_LOCK" ] || : >"$PROMOTION_CONTROL_LOCK"
    [ -e "$SONAR_LOCK" ] || : >"$SONAR_LOCK"
  else
    install -d -o root -g root -m 700 "$STATE_ROOT" "$REQUESTS" \
      "$TRANSACTIONS" "$PREPARATIONS"
  fi
  [ -d "$STATE_ROOT" ] && [ ! -L "$STATE_ROOT" ] \
    && [ -d "$REQUESTS" ] && [ ! -L "$REQUESTS" ] \
    && [ -d "$TRANSACTIONS" ] && [ ! -L "$TRANSACTIONS" ] \
    && [ -d "$PREPARATIONS" ] && [ ! -L "$PREPARATIONS" ] \
    || die "root transaction state is unsafe"
  assert_release_parents
  ensure_worker_upload_root \
    || die "worker upload root or one of its ancestors is unsafe"
}

for executable in "$NODE_BIN" "$CONTROL_BIN" "$ADAPTER_BIN"; do
  [ -f "$executable" ] && [ ! -L "$executable" ] && [ -x "$executable" ] \
    || die "required root-controlled executable is unavailable: $executable"
done
if [ "$TEST_MODE" != 1 ]; then
  [ "$("$NODE_BIN" --version)" = "$EXPECTED_NODE_VERSION" ] \
    || die "trusted system Node must be exactly $EXPECTED_NODE_VERSION"
  for executable in "$DEPENDENCY_BIN" "$INSTALLED_ATTESTOR" \
    "$RECOVERY_ATTESTOR" "$PM2_BIN" "$BASH_BIN" "$CURL_BIN" \
    "$TIMEOUT_BIN" "$SETPRIV_BIN" "$ENV_BIN" "$SYSTEMCTL_BIN" \
    "$PYTHON_BIN" "$FUSER_BIN" "$FLOCK_BIN" "$FILESYSTEM_HELPER"; do
    [ -x "$executable" ] || die "required broker executable is unavailable: $executable"
  done
  [ -f "$SQLITE_HELPER" ] && [ ! -L "$SQLITE_HELPER" ] \
    && [ "$(stat -c '%U:%G:%a:%h' -- "$SQLITE_HELPER")" = root:root:644:1 ] \
    && [ "$(sha256sum -- "$SQLITE_HELPER" | cut -d' ' -f1)" \
      = "$EXPECTED_SQLITE_HELPER_SHA256" ] \
    || die "exact installed SQLite recovery helper is unavailable"
fi

WORKER_UID="$(id -u "$WORKER_USER")"
WORKER_GID="$(id -g "$WORKER_USER")"
WORKER_HOME="$(getent passwd "$WORKER_USER" 2>/dev/null | cut -d: -f6 || true)"
if [ "$TEST_MODE" = 1 ]; then
  WORKER_HOME="${NEXUS_LEGACY_DRILL_WORKER_HOME:-$STATE_ROOT/worker-home}"
  install -d -m 700 "$WORKER_HOME"
fi
[ -n "$WORKER_HOME" ] || die "release worker home is unavailable"

BROKER_SHA256="$(sha256_file "$(realpath -- "${BASH_SOURCE[0]}")")"
ADAPTER_SHA256="$(sha256_file "$ADAPTER_BIN")"
CONTROL_SHA256="$(sha256_file "$CONTROL_BIN")"
CONTROL_VERSION="$("$CONTROL_BIN" version)"

verify_control() {
  [ "$CONTROL_VERSION" = nexus-release-promotion-control.v2 ] \
    && [ "$CONTROL_SHA256" = "$EXPECTED_CONTROL_SHA256" ] || {
    echo "exact installed promotion control v2 is required" >&2
    exit 75
  }
}

validate_install_receipt() {
  [ "$TEST_MODE" = 1 ] && return 0
  [ -f "$INSTALL_RECEIPT" ] && [ ! -L "$INSTALL_RECEIPT" ] \
    && [ "$(stat -c '%U:%G:%a:%h' -- "$INSTALL_RECEIPT")" = root:root:600:1 ] \
    || die "root install receipt is unavailable or unsafe"
  "$NODE_BIN" - "$INSTALL_RECEIPT" "$CONTROL_BIN" \
    "$(realpath -- "${BASH_SOURCE[0]}")" "$ADAPTER_BIN" "$DEPENDENCY_BIN" \
    "$INSTALLED_ATTESTOR" "$RECOVERY_ATTESTOR" "$RELEASE_PUBLIC_KEY" \
    "$TRANSACTION_UNIT" "$RECOVERY_UNIT" "$PM2_DOMINGUEZ_DROP_IN" \
    "$PM2_ROOT_DROP_IN" "$SUDOERS_FILE" \
    "$SQLITE_HELPER" "$FILESYSTEM_HELPER" <<'NODE'
const crypto=require('node:crypto');const fs=require('node:fs');
const [receiptFile,control,broker,adapter,dependencies,installedAttestor,
 recoveryAttestor,releasePublicKey,transactionUnit,recoveryUnit,
 pm2DominguezDropIn,pm2RootDropIn,sudoers,sqliteTool,filesystemHelper]
 =process.argv.slice(2);
const body=fs.readFileSync(receiptFile),receipt=JSON.parse(body);
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)
 &&Object.keys(value).sort().join(',')===[...keys].sort().join(',');
const digest=/^[a-f0-9]{64}$/u;
if(!exact(receipt,['schema','status','promotionAllowed','source','control',
 'installed','installedAt'])
 ||!exact(receipt.source,['sourceSha','archiveSha256'])
 ||!exact(receipt.control,['version','sha256'])
 ||!exact(receipt.installed,['broker','adapter','dependencies',
  'installedAttestor','recoveryAttestor','releasePublicKey',
  'transactionUnit','recoveryUnit','pm2DominguezDropIn','pm2RootDropIn',
  'sudoers','sqliteTool','filesystemHelper'])
 ||receipt.schema!=='nexus.rollback-drill-legacy-staging-install-receipt.v1'
 ||receipt.status!=='active'||receipt.promotionAllowed!==false
 ||!/^[a-f0-9]{40}$/u.test(receipt.source.sourceSha||'')
 ||!digest.test(receipt.source.archiveSha256||'')
 ||receipt.control.version!=='nexus-release-promotion-control.v2'
 ||!Number.isFinite(Date.parse(receipt.installedAt||'')))process.exit(1);
const files={broker,adapter,dependencies,installedAttestor,recoveryAttestor,
 releasePublicKey,transactionUnit,recoveryUnit,pm2DominguezDropIn,
 pm2RootDropIn,sudoers,sqliteTool,filesystemHelper};
for(const [name,file] of Object.entries(files)){
 const stat=fs.lstatSync(file);
 const observed=crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
 if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1
  ||!digest.test(receipt.installed[name]||'')
  ||receipt.installed[name]!==observed)process.exit(1);
}
const controlObserved=crypto.createHash('sha256')
 .update(fs.readFileSync(control)).digest('hex');
if(receipt.control.sha256!==controlObserved)process.exit(1);
NODE
}

adapter_env() {
  if [ "$TEST_MODE" = 1 ]; then
    NODE_ENV=test \
    NEXUS_LEGACY_DRILL_BASE="$BASE" \
    NEXUS_LEGACY_DRILL_DATABASE_TRANSACTION_ROOT="$TRANSACTIONS" \
    NEXUS_LEGACY_DRILL_SQLITE_HELPER="$SQLITE_HELPER" \
    NEXUS_LEGACY_DRILL_FILESYSTEM_HELPER="$FILESYSTEM_HELPER" \
    NEXUS_LEGACY_DRILL_EXPECTED_SQLITE_HELPER_SHA256="$EXPECTED_SQLITE_HELPER_SHA256" \
    NEXUS_LEGACY_DRILL_PYTHON_BIN="$PYTHON_BIN" \
    NEXUS_LEGACY_DRILL_FUSER_BIN="$FUSER_BIN" \
    NEXUS_LEGACY_DRILL_EXPECTED_CONTROL_SHA256="$EXPECTED_CONTROL_SHA256" \
      "$NODE_BIN" "$ADAPTER_BIN" "$@"
  else
    "$NODE_BIN" "$ADAPTER_BIN" "$@"
  fi
}

filesystem_env() {
  local -a arguments=(--base "$BASE")
  if [ "$TEST_MODE" = 1 ]; then arguments+=(--test-mode); fi
  "$PYTHON_BIN" "$FILESYSTEM_HELPER" "$1" "${arguments[@]}" "${@:2}"
}

assert_release_parents() {
  filesystem_env assert-parents >/dev/null \
    || die "legacy staging base and releases parent must be root-owned mode 0755"
}

test_fail_phase() {
  local phase="$1"
  if [ "$TEST_MODE" = 1 ] \
      && [ "${NEXUS_LEGACY_DRILL_TEST_FAIL_PHASE:-}" = "$phase" ]; then
    echo "legacy staging drill injected failure: $phase" >&2
    return 88
  fi
}

test_fail_recovery_phase() {
  local phase="$1"
  if [ "$TEST_MODE" = 1 ] \
      && [ "${NEXUS_LEGACY_DRILL_TEST_RECOVERY_FAIL_PHASE:-}" = "$phase" ]; then
    echo "legacy staging drill injected recovery failure: $phase" >&2
    return 89
  fi
}

run_worker() {
  if [ "$TEST_MODE" = 1 ]; then
    HOME="$WORKER_HOME" PATH="$PATH" "$@"
  else
    "$SETPRIV_BIN" --reuid="$WORKER_UID" --regid="$WORKER_GID" \
      --init-groups --no-new-privs \
      "$ENV_BIN" -i HOME="$WORKER_HOME" PATH="$PATH" "$@"
  fi
}

run_worker_release() {
  local runtime="$1" runtime_sha="$2"
  shift 2
  run_worker "$ENV_BIN" \
    NEXUS_RELEASE_DIR="$runtime" \
    NEXUS_RELEASE_BASE_DIR="$BASE" \
    NEXUS_RELEASE_ROLE=staging \
    NEXUS_RELEASE_SHA="$runtime_sha" \
    SENTRY_RELEASE="$runtime_sha" \
    "$@"
}

run_worker_release_guarded() {
  local runtime="$1" runtime_sha="$2" runtime_dev="$3" runtime_ino="$4"
  shift 4
  if [ "$TEST_MODE" = 1 ]; then
    guarded_runtime_exec "$runtime" "$runtime_dev" "$runtime_ino" \
      -- \
      "$ENV_BIN" HOME="$WORKER_HOME" PATH="$PATH" \
      NEXUS_RELEASE_DIR="$runtime" NEXUS_RELEASE_BASE_DIR="$BASE" \
      NEXUS_RELEASE_ROLE=staging NEXUS_RELEASE_SHA="$runtime_sha" \
      SENTRY_RELEASE="$runtime_sha" "$@"
  else
    guarded_runtime_exec "$runtime" "$runtime_dev" "$runtime_ino" \
      -- \
      "$SETPRIV_BIN" --reuid="$WORKER_UID" --regid="$WORKER_GID" \
      --init-groups --no-new-privs "$ENV_BIN" -i \
      HOME="$WORKER_HOME" PATH="$PATH" \
      NEXUS_RELEASE_DIR="$runtime" NEXUS_RELEASE_BASE_DIR="$BASE" \
      NEXUS_RELEASE_ROLE=staging NEXUS_RELEASE_SHA="$runtime_sha" \
      SENTRY_RELEASE="$runtime_sha" "$@"
  fi
}

run_worker_release_guarded_fd() {
  local runtime="$1" runtime_sha="$2" runtime_dev="$3" runtime_ino="$4"
  local pass_fd="$5"
  shift 5
  if [ "$TEST_MODE" = 1 ]; then
    guarded_runtime_exec "$runtime" "$runtime_dev" "$runtime_ino" \
      --pass-fd "$pass_fd" -- \
      "$ENV_BIN" HOME="$WORKER_HOME" PATH="$PATH" \
      NEXUS_RELEASE_DIR="$runtime" NEXUS_RELEASE_BASE_DIR="$BASE" \
      NEXUS_RELEASE_ROLE=staging NEXUS_RELEASE_SHA="$runtime_sha" \
      SENTRY_RELEASE="$runtime_sha" "$@"
  else
    guarded_runtime_exec "$runtime" "$runtime_dev" "$runtime_ino" \
      --pass-fd "$pass_fd" -- \
      "$SETPRIV_BIN" --reuid="$WORKER_UID" --regid="$WORKER_GID" \
      --init-groups --no-new-privs "$ENV_BIN" -i \
      HOME="$WORKER_HOME" PATH="$PATH" \
      NEXUS_RELEASE_DIR="$runtime" NEXUS_RELEASE_BASE_DIR="$BASE" \
      NEXUS_RELEASE_ROLE=staging NEXUS_RELEASE_SHA="$runtime_sha" \
      SENTRY_RELEASE="$runtime_sha" "$@"
  fi
}

acquire_locks() {
  [ "$LOCKS_HELD" = false ] || return 0
  verify_control
  "$CONTROL_BIN" assert-idle >/dev/null
  [ -f "$PROMOTION_CONTROL_LOCK" ] && [ ! -L "$PROMOTION_CONTROL_LOCK" ] \
    || die "promotion control lock is unavailable"
  [ -f "$SONAR_LOCK" ] && [ ! -L "$SONAR_LOCK" ] \
    || die "shared release/Sonar lock is unavailable"
  exec 9>"$PROMOTION_CONTROL_LOCK"
  "$FLOCK_BIN" -x 9
  exec 8>"$SONAR_LOCK"
  "$FLOCK_BIN" -x 8
  LOCKS_HELD=true
  [ ! -e "$PROMOTION_STATE_ROOT/active.json" ] \
    && [ ! -L "$PROMOTION_STATE_ROOT/active.json" ] \
    || die "ordinary promotion is active"
}

acquire_successor_locks() {
  [ "$LOCKS_HELD" = false ] || return 0
  [ "$CONTROL_VERSION" = nexus-release-promotion-control.v4 ] \
    || die "installed successor promotion control v4 is required"
  if [ "$TEST_MODE" != 1 ]; then
    [ "$CONTROL_BIN" = /usr/local/sbin/nexus-release-promotion-control ] \
      && [ "$(stat -c '%U:%G:%a:%h' -- "$CONTROL_BIN")" = root:root:700:1 ] \
      || die "installed successor control ownership or mode is unsafe"
  fi
  "$CONTROL_BIN" assert-idle >/dev/null \
    && "$CONTROL_BIN" assert-layout-ready >/dev/null \
    || die "installed successor layout evidence is not operationally valid"
  [ -f "$PROMOTION_CONTROL_LOCK" ] && [ ! -L "$PROMOTION_CONTROL_LOCK" ] \
    || die "promotion control lock is unavailable"
  [ -f "$SONAR_LOCK" ] && [ ! -L "$SONAR_LOCK" ] \
    || die "shared release/Sonar lock is unavailable"
  exec 9>"$PROMOTION_CONTROL_LOCK"
  "$FLOCK_BIN" -x 9
  exec 8>"$SONAR_LOCK"
  "$FLOCK_BIN" -x 8
  LOCKS_HELD=true
  [ ! -e "$PROMOTION_STATE_ROOT/active.json" ] \
    && [ ! -L "$PROMOTION_STATE_ROOT/active.json" ] \
    || die "ordinary promotion is active"
  "$CONTROL_BIN" assert-idle >/dev/null \
    && "$CONTROL_BIN" assert-layout-ready >/dev/null \
    || die "successor layout changed while retirement locks were acquired"
}

request_path() {
  printf '%s/%s.json' "$REQUESTS" "$1"
}

journal_path() {
  printf '%s/%s/journal.json' "$TRANSACTIONS" "$1"
}

evidence_path() {
  printf '%s/%s/evidence.json' "$TRANSACTIONS" "$1"
}

preparation_path() {
  printf '%s/%s.json' "$PREPARATIONS" "$1"
}

upload_request_path() {
  printf '%s/%s/request.json' "$UPLOAD_ROOT" "$1"
}

release_dir() {
  printf '%s/releases/%s-%s' "$BASE" "$1" "${2:0:12}"
}

atomic_copy_root() {
  local source="$1" destination="$2"
  "$NODE_BIN" - "$source" "$destination" "$TEST_MODE" <<'NODE'
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const [source, destination, testMode] = process.argv.slice(2);
const constants = fs.constants;
const parent = path.dirname(destination);
const temporary = path.join(
  parent,
  `.legacy-drill-copy.${process.pid}.${crypto.randomBytes(12).toString('hex')}`,
);
let sourceFd;
let temporaryFd;
let parentFd;
try {
  sourceFd = fs.openSync(
    source,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_CLOEXEC,
  );
  const before = fs.fstatSync(sourceFd, { bigint: true });
  if (!before.isFile() || before.nlink !== 1n) {
    throw new Error('input file is unsafe');
  }
  temporaryFd = fs.openSync(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL
      | constants.O_NOFOLLOW | constants.O_CLOEXEC,
    0o600,
  );
  const sourceHash = crypto.createHash('sha256');
  const destinationHash = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let offset = 0;
  for (;;) {
    const count = fs.readSync(sourceFd, buffer, 0, buffer.length, offset);
    if (count === 0) break;
    sourceHash.update(buffer.subarray(0, count));
    let written = 0;
    while (written < count) {
      written += fs.writeSync(
        temporaryFd,
        buffer,
        written,
        count - written,
        offset + written,
      );
    }
    destinationHash.update(buffer.subarray(0, count));
    offset += count;
  }
  const after = fs.fstatSync(sourceFd, { bigint: true });
  for (const field of ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'nlink']) {
    if (before[field] !== after[field]) {
      throw new Error('input file changed during its root copy');
    }
  }
  if (sourceHash.digest('hex') !== destinationHash.digest('hex')) {
    throw new Error('root copy digest mismatch');
  }
  fs.fsyncSync(temporaryFd);
  fs.closeSync(temporaryFd);
  temporaryFd = undefined;
  fs.linkSync(temporary, destination);
  fs.unlinkSync(temporary);
  if (testMode !== '1') {
    const identity = fs.lstatSync(destination, { bigint: true });
    if (!identity.isFile() || identity.uid !== 0n || identity.gid !== 0n
        || identity.mode % 0o1000n !== 0o600n || identity.nlink !== 1n) {
      throw new Error('root copy identity is invalid');
    }
  }
  parentFd = fs.openSync(
    parent,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
      | constants.O_CLOEXEC,
  );
  fs.fsyncSync(parentFd);
} finally {
  if (sourceFd !== undefined) fs.closeSync(sourceFd);
  if (temporaryFd !== undefined) fs.closeSync(temporaryFd);
  if (parentFd !== undefined) fs.closeSync(parentFd);
  try { fs.unlinkSync(temporary); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}
NODE
}

atomic_json_phase() {
  local journal="$1" phase="$2" details="${3:-}"
  "$NODE_BIN" - "$journal" "$phase" "$details" "$TEST_MODE" <<'NODE'
const crypto=require('node:crypto');const fs=require('node:fs');const path=require('node:path');
const [journal,phase,detailsFile,testMode]=process.argv.slice(2);
const transitions={
 queued:new Set(['queued','identity_journaled','recovered']),
 identity_journaled:new Set(['identity_journaled','prepared','recovered']),
 prepared:new Set(['prepared','outage_armed','recovered']),
 outage_armed:new Set(['outage_armed','selector_switched','recovered']),
 selector_switched:new Set(['selector_switched','candidate_started','recovered']),
 candidate_started:new Set(['candidate_started','readiness_passed','recovered']),
 readiness_passed:new Set(['readiness_passed','completed','recovered']),
 completed:new Set(['completed']),recovered:new Set(['recovered']),
};
const current=JSON.parse(fs.readFileSync(journal,'utf8'));
if(current.schema!=='nexus.rollback-drill-legacy-staging-journal.v1'
 ||!transitions[current.phase]?.has(phase))process.exit(1);
const details=detailsFile?JSON.parse(fs.readFileSync(detailsFile,'utf8')):{};
const value={...current,...details,phase,updatedAt:new Date().toISOString()};
const temporary=`${journal}.next.${crypto.randomBytes(12).toString('hex')}`;
const fd=fs.openSync(temporary,'wx',0o600);
try{fs.writeFileSync(fd,`${JSON.stringify(value,null,2)}\n`);fs.fsyncSync(fd);}
finally{fs.closeSync(fd);}
fs.renameSync(temporary,journal);
const parent=fs.openSync(path.dirname(journal),'r');
try{fs.fsyncSync(parent);}finally{fs.closeSync(parent);}
if(testMode!=='1'){fs.chownSync(journal,0,0);fs.chmodSync(journal,0o600);}
NODE
}

write_queued_journal() {
  local request_id="$1" request="$2" journal="$3" transaction_root
  transaction_root="$(dirname -- "$journal")"
  install -d -m 700 "$transaction_root"
  root_own "$transaction_root"
  "$NODE_BIN" - "$request" "$journal" "$BROKER_SHA256" \
    "$ADAPTER_SHA256" "$CONTROL_SHA256" "$TEST_MODE" <<'NODE'
const crypto=require('node:crypto');const fs=require('node:fs');const path=require('node:path');
const [requestFile,journal,brokerSha256,adapterSha256,controlSha256,testMode]=process.argv.slice(2);
if(fs.lstatSync(journal,{throwIfNoEntry:false}))process.exit(1);
const requestBody=fs.readFileSync(requestFile),request=JSON.parse(requestBody);
const manifestBody=Buffer.from(request.releaseManifestBase64,'base64');
const manifest=JSON.parse(manifestBody);
const canonical=(value)=>value===null||typeof value!=='object'?JSON.stringify(value)
 :Array.isArray(value)?`[${value.map(canonical).join(',')}]`
 :`{${Object.keys(value).sort().map((key)=>`${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
const digest=(value)=>crypto.createHash('sha256').update(value).digest('hex');
const provenance={
 rootRequestSha256:digest(requestBody),
 releaseManifestSha256:digest(manifestBody),
 releaseManifestPayloadSha256:digest(canonical(manifest.payload)),
 releaseManifestSignatureSha256:digest(Buffer.from(manifest.signature,'base64')),
 releaseManifestSigningRunId:String(manifest.payload?.ci?.runId??''),
 releaseManifestSigningRunSha256:digest(canonical(manifest.payload?.ci)),
};
for(const field of Object.keys(provenance).filter((name)=>name!=='rootRequestSha256')){
 if(request[field]!==provenance[field])process.exit(1);
}
const value={
 schema:'nexus.rollback-drill-legacy-staging-journal.v1',
 phase:'queued',requestId:request.requestId,runtimeSha:request.runtimeSha,
 artifactDigest:request.artifactDigest,base:request.base,
 candidateRuntime:request.releaseDir,
 requestSha256:provenance.rootRequestSha256,sourceProvenance:provenance,
 broker:{version:'nexus-rollback-drill-legacy-staging-broker.v1',
  sha256:brokerSha256,adapterSha256},
 control:{version:'nexus-release-promotion-control.v2',sha256:controlSha256},
 queuedAt:new Date().toISOString(),updatedAt:new Date().toISOString(),
};
const fd=fs.openSync(journal,'wx',0o600);
try{fs.writeFileSync(fd,`${JSON.stringify(value,null,2)}\n`);fs.fsyncSync(fd);}
finally{fs.closeSync(fd);}
const parent=fs.openSync(path.dirname(journal),'r');
try{fs.fsyncSync(parent);}finally{fs.closeSync(parent);}
if(testMode!=='1'){fs.chownSync(journal,0,0);fs.chmodSync(journal,0o600);}
NODE
}

journal_phase() {
  "$NODE_BIN" -e '
const fs=require("node:fs");const x=JSON.parse(fs.readFileSync(process.argv[1]));
if(x.schema!=="nexus.rollback-drill-legacy-staging-journal.v1")process.exit(1);
process.stdout.write(x.phase);' "$1"
}

request_fields() {
  "$NODE_BIN" - "$1" <<'NODE'
const fs=require('node:fs');const x=JSON.parse(fs.readFileSync(process.argv[2]));
process.stdout.write(`${[x.requestId,x.runtimeSha,x.artifactDigest,x.releaseDir].join('\t')}\n`);
NODE
}

validate_root_request() {
  local request_id="$1" request="$2"
  adapter_env validate-transaction-request \
    --request "$request" \
    --public-key "$RELEASE_PUBLIC_KEY" \
    --expect-request-id "$request_id" \
    --expect-broker-sha256 "$BROKER_SHA256" \
    --expect-adapter-sha256 "$ADAPTER_SHA256" >/dev/null
}

prepare_worker_directories() {
  local release_directory="$1" upload_directory="$2"
  local release_identity upload_identity
  release_identity="$(
    filesystem_env prepare-release \
      --runtime "$release_directory" \
      --worker-uid "$WORKER_UID" --worker-gid "$WORKER_GID"
  )"
  if ! upload_identity="$(
    "$PYTHON_BIN" - "$upload_directory" \
      "$WORKER_UID" "$WORKER_GID" "$TEST_MODE" <<'PY'
import json
import os
import stat
import sys

upload_directory, uid_raw, gid_raw, test_mode = sys.argv[1:]
uid, gid = int(uid_raw), int(gid_raw)
flags = os.O_RDONLY | os.O_DIRECTORY | getattr(os, "O_NOFOLLOW", 0)

def fail(message):
    raise SystemExit(message)

def open_absolute(directory):
    if not os.path.isabs(directory) or os.path.normpath(directory) != directory:
        fail("prepared directory path is not canonical")
    descriptor = os.open("/", flags)
    try:
        for component in directory.split(os.sep)[1:]:
            child = os.open(component, flags, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = child
            observed = os.fstat(descriptor)
            if (not stat.S_ISDIR(observed.st_mode)
                    or observed.st_uid not in (0, uid)
                    or observed.st_mode & 0o022):
                fail("prepared directory ancestor is unsafe")
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise

parent, name = os.path.dirname(upload_directory), os.path.basename(upload_directory)
if not name or name in (".", ".."):
    fail("prepared upload directory basename is invalid")
parent_fd = open_absolute(parent)
child = None
try:
    try:
        os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
    except FileNotFoundError:
        pass
    else:
        fail("prepared upload directory already exists")
    os.mkdir(name, 0o700, dir_fd=parent_fd)
    child = os.open(name, flags, dir_fd=parent_fd)
    os.fchmod(child, 0o700)
    if test_mode != "1":
        os.fchown(child, uid, gid)
    observed = os.fstat(child)
    if not stat.S_ISDIR(observed.st_mode) or observed.st_uid != uid \
            or observed.st_gid != gid \
            or stat.S_IMODE(observed.st_mode) != 0o700:
        fail("prepared upload directory identity is unsafe")
    print(json.dumps({
        "dev": str(observed.st_dev),
        "ino": str(observed.st_ino),
        "uid": observed.st_uid,
        "gid": observed.st_gid,
        "mode": stat.S_IMODE(observed.st_mode),
    }, separators=(",", ":")))
except BaseException:
    try:
        os.rmdir(name, dir_fd=parent_fd)
    except OSError:
        pass
    raise
finally:
    if child is not None:
        os.close(child)
    os.close(parent_fd)
PY
  )"; then
    rmdir -- "$release_directory" 2>/dev/null || true
    return 1
  fi
  "$NODE_BIN" - "$release_identity" "$upload_identity" <<'NODE'
const [releaseIdentity,uploadIdentity]=process.argv.slice(2).map(JSON.parse);
process.stdout.write(JSON.stringify({releaseIdentity,uploadIdentity}));
NODE
}

validate_prepared_directory() {
  local preparation="$1" kind="$2"
  if [ "$kind" = release ]; then
    local fields runtime dev ino
    fields="$("$NODE_BIN" - "$preparation" <<'NODE'
const fs=require('node:fs');const x=JSON.parse(fs.readFileSync(process.argv[2]));
process.stdout.write([
 x.releaseDir,x.releaseIdentity?.dev,x.releaseIdentity?.ino,
].join('\t'));
NODE
    )" || return 1
    IFS=$'\t' read -r runtime dev ino <<<"$fields"
    filesystem_env assert-runtime --runtime "$runtime" \
      --expect-dev "$dev" --expect-ino "$ino" \
      --worker-uid "$WORKER_UID" --worker-gid "$WORKER_GID" >/dev/null
    return
  fi
  [ "$kind" = upload ] || return 1
  "$PYTHON_BIN" - "$preparation" "$kind" "$WORKER_UID" "$WORKER_GID" \
    "$TEST_MODE" <<'PY'
import json
import os
import stat
import sys

preparation, kind, uid_raw, gid_raw, test_mode = sys.argv[1:]
uid, gid = int(uid_raw), int(gid_raw)
with open(preparation, "rb") as handle:
    value = json.load(handle)
if kind == "upload":
    directory = os.path.dirname(value["requestUpload"])
    identity = value["uploadIdentity"]
else:
    raise SystemExit("prepared directory kind is invalid")
flags = os.O_RDONLY | os.O_DIRECTORY | getattr(os, "O_NOFOLLOW", 0)
descriptor = os.open("/", flags)
try:
    for component in directory.split(os.sep)[1:]:
        child = os.open(component, flags, dir_fd=descriptor)
        os.close(descriptor)
        descriptor = child
    observed = os.fstat(descriptor)
    original = (observed.st_uid == uid and observed.st_gid == gid
                and stat.S_IMODE(observed.st_mode) == 0o700)
    if not stat.S_ISDIR(observed.st_mode) \
            or str(observed.st_dev) != identity["dev"] \
            or str(observed.st_ino) != identity["ino"] \
            or not original:
        raise SystemExit("prepared directory identity changed")
finally:
    os.close(descriptor)
PY
}

copy_prepared_worker_request() {
  local preparation="$1" request_id="$2"
  "$PYTHON_BIN" - "$preparation" "$request_id" "$REQUESTS" \
    "$WORKER_UID" "$WORKER_GID" "$TEST_MODE" <<'PY'
import json
import os
import secrets
import stat
import sys

preparation, request_id, destination_root, uid_raw, gid_raw, test_mode = \
    sys.argv[1:]
uid, gid = int(uid_raw), int(gid_raw)
with open(preparation, "rb") as handle:
    value = json.load(handle)
upload_directory = os.path.dirname(value["requestUpload"])
if value.get("requestId") != request_id \
        or os.path.basename(value["requestUpload"]) != "request.json":
    raise SystemExit("prepared upload identity is invalid")
flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
directory_flags = flags | os.O_DIRECTORY

def open_directory(directory):
    descriptor = os.open("/", directory_flags)
    try:
        for component in directory.split(os.sep)[1:]:
            child = os.open(component, directory_flags, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = child
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise

upload_fd = open_directory(upload_directory)
destination_fd = open_directory(destination_root)
temporary_name = f".worker-request.{request_id}.{secrets.token_hex(12)}"
temporary_path = os.path.join(destination_root, temporary_name)
request_fd = None
output_fd = None
try:
    upload_stat = os.fstat(upload_fd)
    identity = value["uploadIdentity"]
    if str(upload_stat.st_dev) != identity["dev"] \
            or str(upload_stat.st_ino) != identity["ino"] \
            or upload_stat.st_uid != uid or upload_stat.st_gid != gid \
            or stat.S_IMODE(upload_stat.st_mode) != 0o700:
        raise SystemExit("prepared upload directory identity changed")
    request_fd = os.open("request.json", flags, dir_fd=upload_fd)
    before = os.fstat(request_fd)
    if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 \
            or before.st_uid != uid or before.st_gid != gid \
            or stat.S_IMODE(before.st_mode) != 0o600 \
            or before.st_size <= 0 or before.st_size > 18 * 1024 * 1024:
        raise SystemExit("worker request upload is unsafe")
    pause_marker = os.environ.get(
        "NEXUS_LEGACY_DRILL_TEST_REQUEST_FD_OPEN_MARKER",
    )
    resume_marker = os.environ.get(
        "NEXUS_LEGACY_DRILL_TEST_REQUEST_FD_RESUME_MARKER",
    )
    if test_mode == "1" and pause_marker and resume_marker:
        import time
        marker_fd = os.open(
            pause_marker,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL,
            0o600,
        )
        os.close(marker_fd)
        for _ in range(500):
            if os.path.exists(resume_marker):
                break
            time.sleep(0.01)
        else:
            raise SystemExit("test request descriptor pause timed out")
    output_fd = os.open(
        temporary_name,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL,
        0o600,
        dir_fd=destination_fd,
    )
    copied = 0
    while True:
        block = os.read(request_fd, 1024 * 1024)
        if not block:
            break
        copied += len(block)
        if copied > 18 * 1024 * 1024:
            raise SystemExit("worker request upload exceeds its size bound")
        view = memoryview(block)
        while view:
            written = os.write(output_fd, view)
            view = view[written:]
    after = os.fstat(request_fd)
    if (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns) != (
            after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns):
        raise SystemExit("worker request upload changed while copied")
    os.fsync(output_fd)
    print(temporary_path)
except BaseException:
    try:
        os.unlink(temporary_name, dir_fd=destination_fd)
    except FileNotFoundError:
        pass
    raise
finally:
    if output_fd is not None:
        os.close(output_fd)
    if request_fd is not None:
        os.close(request_fd)
    os.close(upload_fd)
    os.close(destination_fd)
PY
}

validate_preparation() {
  local request_id="$1" preparation="$2"
  "$NODE_BIN" - "$preparation" "$request_id" "$BASE" "$UPLOAD_ROOT" \
    "$WORKER_UID" "$WORKER_GID" <<'NODE'
const fs=require('node:fs');
const [file,requestId,base,uploadRoot,uidRaw,gidRaw]=process.argv.slice(2);
const x=JSON.parse(fs.readFileSync(file));
const exact=['artifactDigest','preparedAt','releaseDir','releaseIdentity',
 'requestId','requestUpload','runtimeSha','schema','uploadIdentity'];
const identity=(value)=>value&&Object.keys(value).sort().join(',')
 ===['dev','gid','ino','mode','uid'].sort().join(',')
 &&typeof value.dev==='string'&&typeof value.ino==='string'
 &&Number.isSafeInteger(value.uid)&&Number.isSafeInteger(value.gid)
 &&Number.isSafeInteger(value.mode);
if(!x||Object.keys(x).sort().join(',')!==exact.sort().join(',')
 ||x.schema!=='nexus.rollback-drill-legacy-staging-preparation.v1'
 ||x.requestId!==requestId||!/^[a-f0-9]{40}$/u.test(x.runtimeSha||'')
 ||!/^[a-f0-9]{64}$/u.test(x.artifactDigest||'')
 ||x.releaseDir!==`${base}/releases/${x.runtimeSha}-${x.artifactDigest.slice(0,12)}`
 ||x.requestUpload!==`${uploadRoot}/${requestId}/request.json`
 ||!Number.isFinite(Date.parse(x.preparedAt||''))
 ||!identity(x.releaseIdentity)
 ||!identity(x.uploadIdentity)
 ||x.releaseIdentity.uid!==Number(uidRaw)||x.releaseIdentity.gid!==Number(gidRaw)
 ||x.uploadIdentity.uid!==Number(uidRaw)||x.uploadIdentity.gid!==Number(gidRaw)
 ||x.releaseIdentity.mode!==0o700||x.uploadIdentity.mode!==0o700)process.exit(1);
process.stdout.write(`${x.releaseDir}\t${x.requestUpload}\t${x.runtimeSha}\t${x.artifactDigest}`);
NODE
}

selector_json() {
  local expected="$1" dev="${2:-}" ino="${3:-}"
  local -a identity=()
  if [ -n "$dev" ] && [ -n "$ino" ]; then
    identity=(--expect-dev "$dev" --expect-ino "$ino")
  fi
  filesystem_env selector-json --expected "$expected" "${identity[@]}"
}

read_current() {
  filesystem_env current-identity | "$NODE_BIN" -e '
let body="";process.stdin.on("data",(chunk)=>body+=chunk);
process.stdin.on("end",()=>process.stdout.write(JSON.parse(body).runtime));'
}

current_identity_json() {
  filesystem_env current-identity
}

atomic_selector_switch() {
  local expected="$1" expected_dev="$2" expected_ino="$3"
  local target="$4" target_dev="$5" target_ino="$6"
  filesystem_env switch-selector \
    --expected "$expected" --expect-dev "$expected_dev" \
    --expect-ino "$expected_ino" --target "$target" \
    --target-dev "$target_dev" --target-ino "$target_ino" \
    --switch-marker "${NEXUS_LEGACY_DRILL_TEST_SWITCH_FD_OPEN_MARKER:-}" \
    --switch-resume "${NEXUS_LEGACY_DRILL_TEST_SWITCH_FD_RESUME_MARKER:-}" \
    >/dev/null
}

delete_staging_apps() {
  local snapshot app count
  snapshot="$(run_worker "$TIMEOUT_BIN" --signal=TERM --kill-after=2s 8s \
    "$PM2_BIN" jlist)"
  for app in nexus-hub-staging content-engine-staging; do
    count="$("$NODE_BIN" -e '
const rows=JSON.parse(process.argv[1]),name=process.argv[2];
const found=rows.filter((row)=>row?.name===name);
if(found.length>1)process.exit(1);process.stdout.write(String(found.length));' \
      "$snapshot" "$app")"
    if [ "$count" = 1 ]; then
      run_worker "$TIMEOUT_BIN" --signal=TERM --kill-after=2s 12s \
        "$PM2_BIN" delete "$app" >/dev/null
    fi
  done
}

runtime_marker_fields() {
  "$NODE_BIN" - "$1/.complete.json" <<'NODE'
const fs=require('node:fs');
const fd=fs.openSync(process.argv[2],fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));
try{
 const before=fs.fstatSync(fd),body=fs.readFileSync(fd),after=fs.fstatSync(fd);
 const value=JSON.parse(body);
 if(!before.isFile()||before.nlink!==1||before.dev!==after.dev
  ||before.ino!==after.ino||before.size!==after.size
  ||before.mtimeMs!==after.mtimeMs||value.schema!=='nexus.release-bundle.v1'
  ||!/^[a-f0-9]{40}$/u.test(value.runtimeSha||'')
  ||!/^[a-f0-9]{64}$/u.test(value.artifactDigest||''))process.exit(1);
 process.stdout.write(`${value.runtimeSha}\t${value.artifactDigest}`);
}finally{fs.closeSync(fd);}
NODE
}

predecessor_details() {
  local request_id="$1" runtime="$2" output="$3" current_identity="$4"
  local candidate_dev="$5" candidate_ino="$6"
  local metadata="$TRANSACTIONS/$request_id/predecessor-metadata.json"
  "$NODE_BIN" - "$runtime" "$current_identity" "$output" "$BASE" \
    "$TRANSACTIONS/$request_id/predecessor-installed-runtime.json" \
    "$TRANSACTIONS/$request_id/predecessor-recovery-runtime.json" \
    "$metadata" "$candidate_dev" "$candidate_ino" \
    "$TRANSACTIONS/$request_id/candidate-metadata.json" <<'NODE'
const crypto=require('node:crypto');const fs=require('node:fs');const path=require('node:path');
const [runtime,currentIdentityJson,output,base,installedIdentity,recoveryIdentity,
 metadata,candidateDev,candidateIno,candidateMetadata]
 =process.argv.slice(2);
if(path.dirname(runtime)!==path.join(base,'releases')
 ||fs.realpathSync.native(runtime)!==runtime)process.exit(1);
const markerPath=path.join(runtime,'.complete.json');
const fd=fs.openSync(markerPath,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));
let body;
try{
 const before=fs.fstatSync(fd);body=fs.readFileSync(fd);const after=fs.fstatSync(fd);
 if(!before.isFile()||before.nlink!==1||before.dev!==after.dev
  ||before.ino!==after.ino||before.size!==after.size
  ||before.mtimeMs!==after.mtimeMs)process.exit(1);
}finally{fs.closeSync(fd);}
const marker=JSON.parse(body),currentIdentity=JSON.parse(currentIdentityJson);
if(marker.schema!=='nexus.release-bundle.v1'
 ||currentIdentity.runtime!==runtime
 ||currentIdentity.selector?.target!==runtime
 ||!currentIdentity.runtimeIdentity
 ||!/^[a-f0-9]{40}$/u.test(marker.runtimeSha||'')
 ||!/^[a-f0-9]{64}$/u.test(marker.artifactDigest||''))process.exit(1);
fs.writeFileSync(output,`${JSON.stringify({
 predecessor:{
	  runtime,runtimeSha:marker.runtimeSha,artifactDigest:marker.artifactDigest,
	  runtimeIdentity:currentIdentity.runtimeIdentity,
	  markerSha256:crypto.createHash('sha256').update(body).digest('hex'),
	  selector:currentIdentity.selector,
	  installedAttestationSha256:crypto.createHash('sha256')
	   .update(fs.readFileSync(installedIdentity)).digest('hex'),
	  recoveryAttestationSha256:crypto.createHash('sha256')
	   .update(fs.readFileSync(recoveryIdentity)).digest('hex'),
	  metadataSha256:crypto.createHash('sha256')
	   .update(fs.readFileSync(metadata)).digest('hex'),
 },
 candidateRuntimeIdentity:{dev:candidateDev,ino:candidateIno},
 candidateMetadataSha256:crypto.createHash('sha256')
  .update(fs.readFileSync(candidateMetadata)).digest('hex'),
 preparedAt:new Date().toISOString(),
},null,2)}\n`,{mode:0o600,flag:'w'});
NODE
}

prepare_candidate() {
  local runtime="$1" runtime_sha="$2" artifact_digest="$3"
  adapter_env verify-bundle --bundle "$runtime" \
    --runtime-sha "$runtime_sha" --artifact-digest "$artifact_digest" >/dev/null
  if [ "$TEST_MODE" = 1 ] \
      && [ "${NEXUS_LEGACY_DRILL_TEST_SKIP_DEPENDENCIES:-0}" = 1 ]; then
    [ -f "$runtime/.nexus-installed-runtime.json" ] \
      && [ -f "$runtime/.nexus-recovery-runtime.json" ] \
      || die "test candidate attestations are missing"
    return
  fi
  run_worker ln -sfn "$BASE/.env" "$runtime/.env"
  run_worker ln -sfn "$BASE/data" "$runtime/data"
  run_worker ln -sfn "$BASE/logs" "$runtime/logs"
  if [ -f "$runtime/.nexus-installed-runtime.json" ]; then
    run_worker "$NODE_BIN" "$INSTALLED_ATTESTOR" validate \
      --root "$runtime" --runtime-sha "$runtime_sha" \
      --artifact-digest "$artifact_digest" >/dev/null
  else
    run_worker "$NODE_BIN" "$DEPENDENCY_BIN" install \
      --root "$runtime" --python-bin /usr/bin/python3.12
    run_worker "$NODE_BIN" "$INSTALLED_ATTESTOR" write \
      --root "$runtime" --runtime-sha "$runtime_sha" \
      --artifact-digest "$artifact_digest" >/dev/null
  fi
  local recovery_temporary="$runtime/.nexus-recovery-runtime.next.json"
  rm -f -- "$recovery_temporary"
  run_worker "$NODE_BIN" "$RECOVERY_ATTESTOR" compute \
    --root "$runtime" --runtime-sha "$runtime_sha" \
    --artifact-digest "$artifact_digest" --output "$recovery_temporary" >/dev/null
  if [ "$TEST_MODE" = 1 ]; then
    move_exact "$recovery_temporary" "$runtime/.nexus-recovery-runtime.json"
  else
    run_worker mv -T -- "$recovery_temporary" \
      "$runtime/.nexus-recovery-runtime.json"
  fi
}

pin_runtime_attestations() {
  local request_id="$1" runtime="$2" runtime_sha="$3" artifact_digest="$4"
  local identity_name="$5"
  local transaction_root installed recovery installed_root recovery_root
  local expected_recovery_digest source_sha
  transaction_root="$TRANSACTIONS/$request_id"
  installed="$runtime/.nexus-installed-runtime.json"
  recovery="$runtime/.nexus-recovery-runtime.json"
  case "$identity_name" in
    candidate)
      installed_root="$transaction_root/installed-runtime.json"
      recovery_root="$transaction_root/recovery-runtime.json"
      ;;
    predecessor)
      installed_root="$transaction_root/predecessor-installed-runtime.json"
      recovery_root="$transaction_root/predecessor-recovery-runtime.json"
      ;;
    *) die "runtime attestation identity name is invalid" ;;
  esac
  [ -f "$installed" ] && [ ! -L "$installed" ] \
    && [ -f "$recovery" ] && [ ! -L "$recovery" ] \
    || die "candidate runtime attestations are unavailable"
  if [ "$TEST_MODE" != 1 ] \
      || [ "${NEXUS_LEGACY_DRILL_TEST_SKIP_DEPENDENCIES:-0}" != 1 ]; then
    run_worker "$NODE_BIN" "$INSTALLED_ATTESTOR" validate \
      --root "$runtime" --runtime-sha "$runtime_sha" \
      --artifact-digest "$artifact_digest" \
      --expect-runtime-sha "$runtime_sha" \
      --expect-artifact-digest "$artifact_digest" >/dev/null
    expected_recovery_digest="$("$NODE_BIN" -e '
const fs=require('node:fs');const x=JSON.parse(fs.readFileSync(process.argv[1]));
if(x.schema!=="nexus.recovery-runtime-attestation.v1"
 ||!/^[a-f0-9]{64}$/u.test(x.aggregateDigest||""))process.exit(1);
process.stdout.write(x.aggregateDigest);' "$recovery")"
    run_worker "$NODE_BIN" "$RECOVERY_ATTESTOR" compute \
      --root "$runtime" --runtime-sha "$runtime_sha" \
      --artifact-digest "$artifact_digest" \
      --expect-digest "$expected_recovery_digest" >/dev/null
  fi
  for pair in "$installed:$installed_root" "$recovery:$recovery_root"; do
    local source="${pair%%:*}" destination="${pair#*:}"
    source_sha="$(sha256_file "$source")"
    if [ -f "$destination" ] && [ ! -L "$destination" ]; then
      [ "$(sha256_file "$destination")" = "$source_sha" ] \
        || die "root-pinned runtime attestation is immutable"
    else
      atomic_copy_root "$source" "$destination"
    fi
  done
}

pin_candidate_attestations() {
  pin_runtime_attestations "$1" "$2" "$3" "$4" candidate
}

pin_predecessor_attestations() {
  pin_runtime_attestations "$1" "$2" "$3" "$4" predecessor
}

capture_runtime_metadata() {
  local request_id="$1" runtime="$2" dev="$3" ino="$4" identity_name="$5"
  local output="$TRANSACTIONS/$request_id/$identity_name-metadata.json"
  if [ -f "$output" ] && [ ! -L "$output" ]; then
    return
  fi
  [ ! -e "$output" ] && [ ! -L "$output" ] \
    || die "$identity_name metadata destination is unsafe"
  filesystem_env capture --runtime "$runtime" \
    --expect-dev "$dev" --expect-ino "$ino" --output "$output" >/dev/null
  root_own "$output"
}

restore_runtime_metadata() {
  local request_id="$1" runtime="$2" dev="$3" ino="$4" identity_name="$5"
  local metadata="$TRANSACTIONS/$request_id/$identity_name-metadata.json"
  [ -f "$metadata" ] && [ ! -L "$metadata" ] \
    || die "$identity_name reversible metadata is unavailable"
  filesystem_env restore-metadata --runtime "$runtime" \
    --expect-dev "$dev" --expect-ino "$ino" --metadata "$metadata" >/dev/null
}

guarded_runtime_exec() {
  local runtime="$1" dev="$2" ino="$3"
  shift 3
  filesystem_env guarded-exec --runtime "$runtime" \
    --expect-dev "$dev" --expect-ino "$ino" \
    --exec-marker "${NEXUS_LEGACY_DRILL_TEST_EXEC_FD_OPEN_MARKER:-}" \
    --exec-resume "${NEXUS_LEGACY_DRILL_TEST_EXEC_FD_RESUME_MARKER:-}" \
    "$@"
}

seal_runtime_tree() {
  local runtime="$1" dev="$2" ino="$3"
  filesystem_env seal --runtime "$runtime" \
    --expect-dev "$dev" --expect-ino "$ino" \
    --seal-marker "${NEXUS_LEGACY_DRILL_TEST_SEAL_FD_OPEN_MARKER:-}" \
    --seal-resume "${NEXUS_LEGACY_DRILL_TEST_SEAL_FD_RESUME_MARKER:-}" \
    >/dev/null
}

assert_runtime_tree_sealed() {
  local runtime="$1" dev="$2" ino="$3"
  filesystem_env assert-sealed --runtime "$runtime" \
    --expect-dev "$dev" --expect-ino "$ino" >/dev/null
}

assert_no_writable_runtime_references() {
  local runtime="$1" dev="$2" ino="$3"
  local -a proc_arguments=()
  if [ "$TEST_MODE" = 1 ]; then
    proc_arguments=(--proc-root "$PROC_ROOT")
  fi
  filesystem_env assert-no-writable-references --runtime "$runtime" \
    --expect-dev "$dev" --expect-ino "$ino" \
    "${proc_arguments[@]}" >/dev/null
}

verify_pinned_runtime_content() {
  local request_id="$1" runtime="$2" runtime_sha="$3" artifact_digest="$4"
  local identity_name="$5"
  local transaction_root installed_root recovery_root
  local expected_recovery_digest
  transaction_root="$TRANSACTIONS/$request_id"
  case "$identity_name" in
    candidate)
      installed_root="$transaction_root/installed-runtime.json"
      recovery_root="$transaction_root/recovery-runtime.json"
      ;;
    predecessor)
      installed_root="$transaction_root/predecessor-installed-runtime.json"
      recovery_root="$transaction_root/predecessor-recovery-runtime.json"
      ;;
    *) die "runtime verification identity name is invalid" ;;
  esac
  [ "$(sha256_file "$runtime/.nexus-installed-runtime.json")" \
      = "$(sha256_file "$installed_root")" ] \
    && [ "$(sha256_file "$runtime/.nexus-recovery-runtime.json")" \
      = "$(sha256_file "$recovery_root")" ] \
    || die "$identity_name root-pinned runtime identity drifted"
  if [ "$TEST_MODE" != 1 ] \
      || [ "${NEXUS_LEGACY_DRILL_TEST_SKIP_DEPENDENCIES:-0}" != 1 ]; then
    run_worker "$NODE_BIN" "$INSTALLED_ATTESTOR" validate \
      --root "$runtime" --runtime-sha "$runtime_sha" \
      --artifact-digest "$artifact_digest" \
      --expect-runtime-sha "$runtime_sha" \
      --expect-artifact-digest "$artifact_digest" >/dev/null
    expected_recovery_digest="$("$NODE_BIN" -e '
const fs=require('node:fs');const x=JSON.parse(fs.readFileSync(process.argv[1]));
if(x.schema!=="nexus.recovery-runtime-attestation.v1"
 ||!/^[a-f0-9]{64}$/u.test(x.aggregateDigest||""))process.exit(1);
process.stdout.write(x.aggregateDigest);' "$recovery_root")"
    run_worker "$NODE_BIN" "$RECOVERY_ATTESTOR" compute \
      --root "$runtime" --runtime-sha "$runtime_sha" \
      --artifact-digest "$artifact_digest" \
      --expect-digest "$expected_recovery_digest" >/dev/null
  fi
}

verify_pinned_runtime() {
  local request_id="$1" runtime="$2" runtime_sha="$3" artifact_digest="$4"
  local identity_name="$5" runtime_dev="$6" runtime_ino="$7"
  verify_pinned_runtime_content "$request_id" "$runtime" "$runtime_sha" \
    "$artifact_digest" "$identity_name"
  assert_runtime_tree_sealed "$runtime" "$runtime_dev" "$runtime_ino" \
    || die "$identity_name runtime seal drifted"
}

prove_predecessor_healthy() {
  local runtime="$1" runtime_sha="$2" runtime_dev="$3" runtime_ino="$4" output
  output="$(mktemp "$STATE_ROOT/.legacy-drill-recovery-readiness.XXXXXXXX")"
  exec 7<>"$output"
  run_worker_release_guarded_fd "$runtime" "$runtime_sha" \
    "$runtime_dev" "$runtime_ino" 7 \
    "$TIMEOUT_BIN" --signal=TERM --kill-after=5s 60s \
    "$BASH_BIN" "$runtime/scripts/remote-release-readiness.sh" \
    --role staging --base-dir "$BASE" --release-dir "$runtime" \
    --runtime-sha "$runtime_sha" --pm2-bin "$PM2_BIN" \
    --node-bin "$NODE_BIN" --curl-bin "$CURL_BIN" --output-fd 7 \
    --stability-seconds 0 --readiness-attempts 8 --poll-seconds 1 >&2
  exec 7>&-
  rm -f -- "$output"
  selector_json "$runtime" "$runtime_dev" "$runtime_ino" >/dev/null
}

write_no_outage_recovery_details() {
  local output="$1"
  "$NODE_BIN" - "$output" <<'NODE'
const fs=require('node:fs');const output=process.argv[2];
fs.writeFileSync(output,`${JSON.stringify({
 recoveryClock:'no_outage',recoveryStartedMonotonicNs:null,
 recoveryCompletedMonotonicNs:null,recoveryMonotonicNanoseconds:'0',
 recoverySeconds:0,recoveryTargetSeconds:120,recoveryTargetMet:true,
 wallOutageSecondsDiagnostic:0,recoveredAt:new Date().toISOString(),
},null,2)}\n`,{mode:0o600,flag:'w'});
NODE
}

write_outage_recovery_details() {
  local journal="$1" output="$2"
  "$NODE_BIN" - "$journal" "$output" "$TEST_MODE" \
    "${NEXUS_LEGACY_DRILL_TEST_BOOT_ID:-test-boot-id}" <<'NODE'
const fs=require('node:fs');
const [journalFile,output,testMode,testBootId]=process.argv.slice(2);
const journal=JSON.parse(fs.readFileSync(journalFile));
const completedEpoch=Math.floor(Date.now()/1000);
const recoveryBootId=testMode==='1'?testBootId
 :fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim();
const completedMonotonicNs=testMode==='1'?process.hrtime.bigint()
 :BigInt(Math.floor(
   Number(fs.readFileSync('/proc/uptime','utf8').split(/\s+/u)[0])*1e9,
  ));
if(!Number.isSafeInteger(journal.outageStartedEpoch)
 ||journal.outageStartedEpoch<0
 ||typeof journal.outageBootId!=='string'||!journal.outageBootId
 ||!validMonotonic(journal.outageStartedMonotonicNs))process.exit(1);
function validMonotonic(value){
 return typeof value==='string'&&/^(?:0|[1-9][0-9]*)$/u.test(value);
}
const startedMonotonicNs=BigInt(journal.outageStartedMonotonicNs);
const sameBoot=journal.outageBootId===recoveryBootId;
const monotonicValid=sameBoot&&completedMonotonicNs>=startedMonotonicNs;
const elapsed=monotonicValid?completedMonotonicNs-startedMonotonicNs:null;
const wallSeconds=Math.max(0,completedEpoch-journal.outageStartedEpoch);
const targetMet=elapsed!==null&&elapsed<=120_000_000_000n;
fs.writeFileSync(output,`${JSON.stringify({
 recoveryClock:monotonicValid?'journaled_monotonic':'cross_boot_unverifiable',
 recoveryStartedMonotonicNs:journal.outageStartedMonotonicNs,
 recoveryCompletedMonotonicNs:monotonicValid
  ?String(completedMonotonicNs):null,
 recoveryMonotonicNanoseconds:elapsed===null?null:String(elapsed),
 recoverySeconds:elapsed===null?null:Number(elapsed)/1e9,
 recoveryTargetSeconds:120,recoveryTargetMet:targetMet,
 outageBootId:journal.outageBootId,recoveryBootId,sameBoot,
 wallOutageSecondsDiagnostic:wallSeconds,recoveredAt:new Date().toISOString(),
},null,2)}\n`,{mode:0o600,flag:'w'});
NODE
}

restore_transaction() {
  local request_id="$1" journal phase fields candidate predecessor predecessor_sha
  local predecessor_digest pinned_installed_sha pinned_recovery_sha
  local predecessor_dev predecessor_ino candidate_dev candidate_ino
  local current details
  local has_database_backup predecessor_marker_sha predecessor_metadata_sha
  local candidate_metadata_sha
  journal="$(journal_path "$request_id")"
  phase="$(journal_phase "$journal")"
  case "$phase" in
    completed|recovered) return 0 ;;
    queued)
      details="$(mktemp "$STATE_ROOT/.legacy-drill-recovered.XXXXXXXX")"
      write_no_outage_recovery_details "$details"
      atomic_json_phase "$journal" recovered "$details"
      rm -f -- "$details"
      return 0
      ;;
  esac
  fields="$("$NODE_BIN" - "$journal" <<'NODE'
const fs=require('node:fs');const x=JSON.parse(fs.readFileSync(process.argv[2]));
if(!x.predecessor?.runtime||!x.predecessor?.runtimeSha
  ||!x.predecessor?.artifactDigest||!x.candidateRuntime
  ||!x.predecessor?.installedAttestationSha256
  ||!x.predecessor?.recoveryAttestationSha256
  ||!x.predecessor?.runtimeIdentity?.dev
  ||!x.predecessor?.runtimeIdentity?.ino
  ||!x.candidateRuntimeIdentity?.dev||!x.candidateRuntimeIdentity?.ino
  ||!x.predecessor?.metadataSha256
  ||!x.candidateMetadataSha256||!x.predecessor?.markerSha256)process.exit(1);
process.stdout.write([x.candidateRuntime,x.predecessor.runtime,
  x.predecessor.runtimeSha,x.predecessor.artifactDigest,
  x.predecessor.installedAttestationSha256,
  x.predecessor.recoveryAttestationSha256,
  x.predecessor.runtimeIdentity.dev,x.predecessor.runtimeIdentity.ino,
  x.candidateRuntimeIdentity.dev,x.candidateRuntimeIdentity.ino,
  x.predecessor.markerSha256,x.predecessor.metadataSha256,
  x.candidateMetadataSha256,
  x.databaseBackup?'true':'false'].join('\t'));
NODE
  )"
  IFS=$'\t' read -r candidate predecessor predecessor_sha \
    predecessor_digest pinned_installed_sha pinned_recovery_sha \
    predecessor_dev predecessor_ino candidate_dev candidate_ino \
    predecessor_marker_sha predecessor_metadata_sha candidate_metadata_sha \
    has_database_backup <<<"$fields"
  [ "$(sha256_file "$TRANSACTIONS/$request_id/predecessor-metadata.json")" \
      = "$predecessor_metadata_sha" ] \
    && [ "$(sha256_file "$TRANSACTIONS/$request_id/candidate-metadata.json")" \
      = "$candidate_metadata_sha" ] \
    || die "root-held reversible runtime metadata drifted"
  [ "$(sha256_file "$TRANSACTIONS/$request_id/predecessor-installed-runtime.json")" \
      = "$pinned_installed_sha" ] \
    && [ "$(sha256_file "$TRANSACTIONS/$request_id/predecessor-recovery-runtime.json")" \
      = "$pinned_recovery_sha" ] \
    && [ "$(sha256_file "$predecessor/.complete.json")" \
      = "$predecessor_marker_sha" ] \
    || die "root-held predecessor recovery identity drifted"
  verify_pinned_runtime_content "$request_id" "$predecessor" \
    "$predecessor_sha" "$predecessor_digest" predecessor

  if [ "$phase" = identity_journaled ] || [ "$phase" = prepared ]; then
    restore_runtime_metadata "$request_id" "$candidate" \
      "$candidate_dev" "$candidate_ino" candidate
    restore_runtime_metadata "$request_id" "$predecessor" \
      "$predecessor_dev" "$predecessor_ino" predecessor
    details="$(mktemp "$STATE_ROOT/.legacy-drill-recovered.XXXXXXXX")"
    write_no_outage_recovery_details "$details"
    atomic_json_phase "$journal" recovered "$details"
    rm -f -- "$details"
    return 0
  fi

  current="$(read_current)"
  case "$current" in
    "$candidate"|"$predecessor") ;;
    *) die "staging selector differs from both durable recovery endpoints" ;;
  esac
  delete_staging_apps
  seal_runtime_tree "$predecessor" "$predecessor_dev" "$predecessor_ino"
  assert_no_writable_runtime_references \
    "$predecessor" "$predecessor_dev" "$predecessor_ino"
  verify_pinned_runtime "$request_id" "$predecessor" "$predecessor_sha" \
    "$predecessor_digest" predecessor "$predecessor_dev" "$predecessor_ino"
  [ "$(sha256_file "$predecessor/.complete.json")" \
      = "$predecessor_marker_sha" ] \
    || die "root-held predecessor marker drifted after outage sealing"
  test_fail_recovery_phase database
  if [ "$has_database_backup" = true ]; then
    adapter_env restore-database --request-id "$request_id" \
      --journal "$journal" >/dev/null
  else
    case "$phase:$current" in
      outage_armed:"$predecessor") ;;
      *) die "post-switch recovery lacks a journaled database recovery point" ;;
    esac
  fi
  verify_pinned_runtime "$request_id" "$predecessor" "$predecessor_sha" \
    "$predecessor_digest" predecessor "$predecessor_dev" "$predecessor_ino"
  test_fail_recovery_phase selector
  case "$current" in
    "$candidate")
      atomic_selector_switch "$candidate" "$candidate_dev" "$candidate_ino" \
        "$predecessor" "$predecessor_dev" "$predecessor_ino"
      ;;
    "$predecessor") ;;
  esac
  verify_pinned_runtime "$request_id" "$predecessor" "$predecessor_sha" \
    "$predecessor_digest" predecessor "$predecessor_dev" "$predecessor_ino"
  test_fail_recovery_phase pm2_start
  run_worker_release_guarded "$predecessor" "$predecessor_sha" \
    "$predecessor_dev" "$predecessor_ino" \
    "$TIMEOUT_BIN" --signal=TERM --kill-after=3s 25s \
    "$PM2_BIN" start "$predecessor/ecosystem.release.config.js" --update-env >/dev/null
  run_worker "$TIMEOUT_BIN" --signal=TERM --kill-after=2s 10s \
    "$PM2_BIN" save >/dev/null
  test_fail_recovery_phase readiness
  prove_predecessor_healthy "$predecessor" "$predecessor_sha" \
    "$predecessor_dev" "$predecessor_ino"
  test_fail_recovery_phase metadata
  restore_runtime_metadata "$request_id" "$candidate" \
    "$candidate_dev" "$candidate_ino" candidate
  restore_runtime_metadata "$request_id" "$predecessor" \
    "$predecessor_dev" "$predecessor_ino" predecessor
  details="$(mktemp "$STATE_ROOT/.legacy-drill-recovered.XXXXXXXX")"
  write_outage_recovery_details "$journal" "$details"
  atomic_json_phase "$journal" recovered "$details"
  rm -f -- "$details"
}

rollback_on_failure() {
  local status=$? recovered=0 request_id="${ACTIVE_REQUEST_ID:-}"
  trap - EXIT INT TERM HUP
  if [ "$status" -ne 0 ] && [ -n "$request_id" ] \
      && [ -f "$(journal_path "$request_id")" ]; then
    set +e
    ( set -euo pipefail; restore_transaction "$request_id" )
    recovered=$?
    set -e
    if [ "$recovered" -eq 0 ]; then
      echo "legacy staging drill failed and the exact predecessor was restored" >&2
      exit 75
    fi
    echo "legacy staging drill recovery failed; durable journal retained" >&2
  fi
  exit "$status"
}

publish_evidence() {
  local request_id="$1" journal="$2" readiness="$3" evidence="$4"
  local installed recovery current_selector temporary
  installed="$TRANSACTIONS/$request_id/installed-runtime.json"
  recovery="$TRANSACTIONS/$request_id/recovery-runtime.json"
  local candidate_binding
  candidate_binding="$("$NODE_BIN" - "$journal" <<'NODE'
const fs=require('node:fs');const x=JSON.parse(fs.readFileSync(process.argv[2]));
process.stdout.write(`${x.candidateRuntimeIdentity.dev}\t${x.candidateRuntimeIdentity.ino}`);
NODE
  )"
  local candidate_dev candidate_ino
  IFS=$'\t' read -r candidate_dev candidate_ino <<<"$candidate_binding"
  current_selector="$(selector_json "$CANDIDATE_RUNTIME" \
    "$candidate_dev" "$candidate_ino")"
  temporary="${evidence}.next.$$"
  "$NODE_BIN" - "$journal" "$installed" "$recovery" "$readiness" \
    "$temporary" "$current_selector" "$(request_path "$request_id")" <<'NODE'
const crypto=require('node:crypto');const fs=require('node:fs');
const [journalFile,installedFile,recoveryFile,readinessFile,output,
 currentSelectorJson,requestFile]=process.argv.slice(2);
const body=fs.readFileSync(journalFile),journal=JSON.parse(body);
const requestBody=fs.readFileSync(requestFile);
const requestSha256=crypto.createHash('sha256').update(requestBody).digest('hex');
if(requestSha256!==journal.requestSha256
 ||requestSha256!==journal.sourceProvenance?.rootRequestSha256)process.exit(1);
const installed=JSON.parse(fs.readFileSync(installedFile));
const recovery=JSON.parse(fs.readFileSync(recoveryFile));
const readiness=JSON.parse(fs.readFileSync(readinessFile));
const remoteIdentity={
 schema:'nexus.pm2-release-identity.v1',
 services:(readiness.services??[]).map((entry)=>({
  name:entry.name,status:entry.status,cwd:entry.cwd,
  executable:entry.executable,interpreter:entry.interpreter,
  releaseSha:entry.releaseSha,sentryRelease:entry.sentryRelease,
 })),
};
const publishedAt=new Date().toISOString();
const evidence={
 schema:'nexus.rollback-drill-legacy-staging-evidence.v1',
 status:'completed',promotionAllowed:false,requestId:journal.requestId,
 runtimeSha:journal.runtimeSha,artifactDigest:journal.artifactDigest,
 base:journal.base,releaseDir:journal.candidateRuntime,
 broker:journal.broker,control:journal.control,
 sourceProvenance:journal.sourceProvenance,
 predecessor:journal.predecessor,currentSelector:JSON.parse(currentSelectorJson),
 installedRuntimeAttestation:installed,recoveryRuntimeAttestation:recovery,
 remoteIdentity,remoteReadiness:readiness,
  transaction:{
  databaseBackupSha256:journal.databaseBackup.sha256,
  databaseBackupSizeBytes:journal.databaseBackup.sizeBytes,
  journalSha256:crypto.createHash('sha256').update(body).digest('hex'),
  preparedAt:journal.preparedAt,
  selectorSwitchedAt:journal.selectorSwitchedAt,
  readinessCompletedAt:journal.readinessCompletedAt,
  publishedAt,stabilitySeconds:60,recoveryTargetSeconds:120,
 },
};
const fd=fs.openSync(output,'wx',0o600);
try{fs.writeFileSync(fd,`${JSON.stringify(evidence,null,2)}\n`);fs.fsyncSync(fd);}
finally{fs.closeSync(fd);}
NODE
  root_own "$temporary"
  adapter_env validate-broker-evidence --evidence "$temporary" >/dev/null
  move_exact "$temporary" "$evidence"
  fsync_path "$(dirname -- "$evidence")"
  local evidence_sha details
  evidence_sha="$(sha256_file "$evidence")"
  details="$(mktemp "$STATE_ROOT/.legacy-drill-completed.XXXXXXXX")"
  "$NODE_BIN" - "$details" "$evidence_sha" <<'NODE'
const fs=require('node:fs');const [output,evidenceSha256]=process.argv.slice(2);
fs.writeFileSync(output,`${JSON.stringify({
 evidenceSha256,completedAt:new Date().toISOString(),
},null,2)}\n`,{mode:0o600,flag:'w'});
NODE
  atomic_json_phase "$journal" completed "$details"
  rm -f -- "$details"
}

run_transaction() {
  local request_id="$1" request journal phase request_values
  local runtime_sha artifact_digest details current readiness evidence
  local database_details has_database_backup
  ACTIVE_REQUEST_ID="$request_id"
  request="$(request_path "$request_id")"
  journal="$(journal_path "$request_id")"
  validate_root_request "$request_id" "$request"
  IFS=$'\t' read -r _ runtime_sha artifact_digest CANDIDATE_RUNTIME \
    < <(request_fields "$request")
  phase="$(journal_phase "$journal")"
  case "$phase" in
    completed) return 0 ;;
    recovered) exit 75 ;;
  esac

  trap rollback_on_failure EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  trap 'exit 129' HUP
  if [ "$phase" = readiness_passed ]; then
    evidence="$(evidence_path "$request_id")"
    [ -f "$evidence" ] && [ ! -L "$evidence" ] \
      || die "publication-ready transaction lacks root evidence"
    adapter_env validate-broker-evidence --evidence "$evidence" >/dev/null
    details="$(mktemp "$STATE_ROOT/.legacy-drill-completed.XXXXXXXX")"
    printf '{"evidenceSha256":"%s","completedAt":"%s"}\n' \
      "$(sha256_file "$evidence")" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$details"
    atomic_json_phase "$journal" completed "$details"
    rm -f -- "$details"
    trap - EXIT INT TERM HUP
    return 0
  fi
  if [ "$phase" = queued ]; then
    local preparation candidate_identity candidate_dev candidate_ino
    local predecessor_identity predecessor_dev predecessor_ino
    local predecessor_sha predecessor_artifact_digest predecessor_values
    preparation="$(preparation_path "$request_id")"
    validate_preparation "$request_id" "$preparation" >/dev/null \
      || die "candidate preparation receipt is invalid"
    validate_prepared_directory "$preparation" release \
      || die "prepared candidate directory identity changed"
    prepare_candidate "$CANDIDATE_RUNTIME" "$runtime_sha" "$artifact_digest"
    pin_candidate_attestations \
      "$request_id" "$CANDIDATE_RUNTIME" "$runtime_sha" "$artifact_digest"
    candidate_identity="$("$NODE_BIN" - "$preparation" <<'NODE'
const fs=require('node:fs');const x=JSON.parse(fs.readFileSync(process.argv[2]));
process.stdout.write(`${x.releaseIdentity.dev}\t${x.releaseIdentity.ino}`);
NODE
    )"
    IFS=$'\t' read -r candidate_dev candidate_ino <<<"$candidate_identity"
    capture_runtime_metadata "$request_id" "$CANDIDATE_RUNTIME" \
      "$candidate_dev" "$candidate_ino" candidate
    predecessor_identity="$(current_identity_json)"
    current="$("$NODE_BIN" -e '
const x=JSON.parse(process.argv[1]);process.stdout.write(x.runtime);' \
      "$predecessor_identity")"
    case "$current" in "$BASE"/releases/*) ;; *) die "legacy staging predecessor is unsafe" ;; esac
    [ "$current" != "$CANDIDATE_RUNTIME" ] \
      || die "candidate is active without a durable predecessor"
    IFS=$'\t' read -r predecessor_dev predecessor_ino \
      < <("$NODE_BIN" -e '
const x=JSON.parse(process.argv[1]);
process.stdout.write(`${x.runtimeIdentity.dev}\t${x.runtimeIdentity.ino}\n`);' \
        "$predecessor_identity")
    predecessor_values="$(runtime_marker_fields "$current")"
    IFS=$'\t' read -r predecessor_sha predecessor_artifact_digest \
      <<<"$predecessor_values"
    pin_predecessor_attestations "$request_id" "$current" \
      "$predecessor_sha" "$predecessor_artifact_digest"
    capture_runtime_metadata "$request_id" "$current" \
      "$predecessor_dev" "$predecessor_ino" predecessor
    details="$(mktemp "$STATE_ROOT/.legacy-drill-identity.XXXXXXXX")"
    predecessor_details "$request_id" "$current" "$details" \
      "$predecessor_identity" "$candidate_dev" "$candidate_ino"
    atomic_json_phase "$journal" identity_journaled "$details"
    rm -f -- "$details"
    phase=identity_journaled
    test_fail_phase after_identity_journal
  fi

  if [ "$phase" = identity_journaled ]; then
    local identity_fields predecessor_marker_sha
    identity_fields="$("$NODE_BIN" - "$journal" <<'NODE'
const fs=require('node:fs');const x=JSON.parse(fs.readFileSync(process.argv[2]));
process.stdout.write([
 x.candidateRuntimeIdentity.dev,x.candidateRuntimeIdentity.ino,
 x.predecessor.runtime,x.predecessor.runtimeSha,x.predecessor.artifactDigest,
 x.predecessor.runtimeIdentity.dev,x.predecessor.runtimeIdentity.ino,
 x.predecessor.markerSha256,
].join('\t'));
NODE
    )"
    IFS=$'\t' read -r candidate_dev candidate_ino current predecessor_sha \
      predecessor_artifact_digest predecessor_dev predecessor_ino \
      predecessor_marker_sha <<<"$identity_fields"
    seal_runtime_tree "$CANDIDATE_RUNTIME" "$candidate_dev" "$candidate_ino"
    assert_no_writable_runtime_references \
      "$CANDIDATE_RUNTIME" "$candidate_dev" "$candidate_ino"
    verify_pinned_runtime "$request_id" "$CANDIDATE_RUNTIME" \
      "$runtime_sha" "$artifact_digest" candidate "$candidate_dev" "$candidate_ino"
    verify_pinned_runtime_content "$request_id" "$current" "$predecessor_sha" \
      "$predecessor_artifact_digest" predecessor
    [ "$(sha256_file "$current/.complete.json")" = "$predecessor_marker_sha" ] \
      || die "journaled predecessor marker changed before sealing"
    run_worker_release_guarded "$CANDIDATE_RUNTIME" "$runtime_sha" \
      "$candidate_dev" "$candidate_ino" \
      "$BASH_BIN" "$CANDIDATE_RUNTIME/scripts/remote-release-preflight.sh" \
      --role staging --base-dir "$BASE" --release-dir "$CANDIDATE_RUNTIME" \
      --node-bin "$NODE_BIN" >&2
    details="$(mktemp "$STATE_ROOT/.legacy-drill-prepared.XXXXXXXX")"
    printf '{"sealedAt":"%s"}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$details"
    atomic_json_phase "$journal" prepared "$details"
    rm -f -- "$details"
    phase=prepared
  fi

  if [ "$phase" != queued ] && [ "$phase" != identity_journaled ]; then
    local bound_runtime_fields predecessor_dev predecessor_ino
    local candidate_dev candidate_ino predecessor_sha predecessor_artifact_digest
    local predecessor_marker_sha
    bound_runtime_fields="$("$NODE_BIN" - "$journal" <<'NODE'
const fs=require('node:fs');const x=JSON.parse(fs.readFileSync(process.argv[2]));
process.stdout.write([
 x.candidateRuntimeIdentity?.dev,x.candidateRuntimeIdentity?.ino,
 x.predecessor?.runtime,x.predecessor?.runtimeSha,
 x.predecessor?.artifactDigest,x.predecessor?.runtimeIdentity?.dev,
 x.predecessor?.runtimeIdentity?.ino,x.predecessor?.markerSha256,
].join('\t'));
NODE
    )"
    IFS=$'\t' read -r candidate_dev candidate_ino PREDECESSOR_RUNTIME \
      predecessor_sha predecessor_artifact_digest predecessor_dev \
      predecessor_ino predecessor_marker_sha <<<"$bound_runtime_fields"
    [ -n "$candidate_dev" ] && [ -n "$candidate_ino" ] \
      && [ -n "$predecessor_dev" ] && [ -n "$predecessor_ino" ] \
      || die "durable runtime device/inode binding is incomplete"
  fi

  if [ "$phase" = prepared ]; then
    details="$(mktemp "$STATE_ROOT/.legacy-drill-outage.XXXXXXXX")"
    "$NODE_BIN" - "$details" "$TEST_MODE" \
      "${NEXUS_LEGACY_DRILL_TEST_OUTAGE_BOOT_ID:-${NEXUS_LEGACY_DRILL_TEST_BOOT_ID:-test-boot-id}}" <<'NODE'
const fs=require('node:fs');
const epoch=Math.floor(Date.now()/1000);
const [output,testMode,testBootId]=process.argv.slice(2);
const bootId=testMode==='1'?testBootId
 :fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim();
const monotonicNs=testMode==='1'?process.hrtime.bigint()
 :BigInt(Math.floor(
   Number(fs.readFileSync('/proc/uptime','utf8').split(/\s+/u)[0])*1e9,
  ));
fs.writeFileSync(output,`${JSON.stringify({
 outageStartedEpoch:epoch,recoveryDeadlineEpoch:epoch+120,
 outageBootId:bootId,
 outageStartedMonotonic:Number(monotonicNs/1_000_000_000n),
 outageStartedMonotonicNs:String(monotonicNs),
},null,2)}\n`,{mode:0o600,flag:'w'});
NODE
    atomic_json_phase "$journal" outage_armed "$details"
    rm -f -- "$details"
    phase=outage_armed
  fi
  if [ "$phase" = outage_armed ]; then
    current="$(read_current)"
    PREDECESSOR_RUNTIME="$("$NODE_BIN" -e '
const x=require(process.argv[1]);process.stdout.write(x.predecessor.runtime);' "$journal")"
    case "$current" in
      "$PREDECESSOR_RUNTIME"|"$CANDIDATE_RUNTIME") ;;
      *) die "legacy staging selector differs from the transaction endpoints" ;;
    esac
    has_database_backup="$("$NODE_BIN" -e '
const x=require(process.argv[1]);process.stdout.write(x.databaseBackup?"true":"false");' \
      "$journal")"
    if [ "$current" = "$CANDIDATE_RUNTIME" ] \
        && [ "$has_database_backup" != true ]; then
      die "candidate selector lacks a journaled database recovery point"
    fi
    delete_staging_apps
    seal_runtime_tree \
      "$PREDECESSOR_RUNTIME" "$predecessor_dev" "$predecessor_ino"
    assert_no_writable_runtime_references \
      "$PREDECESSOR_RUNTIME" "$predecessor_dev" "$predecessor_ino"
    verify_pinned_runtime "$request_id" "$PREDECESSOR_RUNTIME" \
      "$predecessor_sha" "$predecessor_artifact_digest" predecessor \
      "$predecessor_dev" "$predecessor_ino"
    [ "$(sha256_file "$PREDECESSOR_RUNTIME/.complete.json")" \
        = "$predecessor_marker_sha" ] \
      || die "journaled predecessor marker changed after outage sealing"
    database_details="$(adapter_env snapshot-database \
      --request-id "$request_id")"
    details="$(mktemp "$STATE_ROOT/.legacy-drill-database.XXXXXXXX")"
    printf '%s\n' "$database_details" >"$details"
    atomic_json_phase "$journal" outage_armed "$details"
    rm -f -- "$details"
    if [ "$current" != "$CANDIDATE_RUNTIME" ]; then
      verify_pinned_runtime "$request_id" "$CANDIDATE_RUNTIME" \
        "$runtime_sha" "$artifact_digest" candidate \
        "$candidate_dev" "$candidate_ino"
      atomic_selector_switch "$PREDECESSOR_RUNTIME" \
        "$predecessor_dev" "$predecessor_ino" "$CANDIDATE_RUNTIME" \
        "$candidate_dev" "$candidate_ino"
    fi
    details="$(mktemp "$STATE_ROOT/.legacy-drill-switched.XXXXXXXX")"
    printf '{"selectorSwitchedAt":"%s"}\n' \
      "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$details"
    atomic_json_phase "$journal" selector_switched "$details"
    rm -f -- "$details"
    phase=selector_switched
    test_fail_phase after_selector_switch
  fi
  if [ "$phase" = selector_switched ]; then
    verify_pinned_runtime "$request_id" "$CANDIDATE_RUNTIME" \
      "$runtime_sha" "$artifact_digest" candidate \
      "$candidate_dev" "$candidate_ino"
    run_worker_release_guarded "$CANDIDATE_RUNTIME" "$runtime_sha" \
      "$candidate_dev" "$candidate_ino" \
      "$TIMEOUT_BIN" --signal=TERM --kill-after=3s 25s \
      "$PM2_BIN" start "$CANDIDATE_RUNTIME/ecosystem.release.config.js" \
      --update-env >/dev/null
    atomic_json_phase "$journal" candidate_started
    phase=candidate_started
    test_fail_phase after_candidate_start
  fi
  selector_json "$CANDIDATE_RUNTIME" "$candidate_dev" "$candidate_ino" \
    >/dev/null || die "legacy staging candidate selector drifted"
  readiness="$(mktemp "$STATE_ROOT/.legacy-drill-readiness.XXXXXXXX")"
  exec 7<>"$readiness"
  run_worker_release_guarded_fd "$CANDIDATE_RUNTIME" "$runtime_sha" \
    "$candidate_dev" "$candidate_ino" 7 \
    "$BASH_BIN" "$CANDIDATE_RUNTIME/scripts/remote-release-readiness.sh" \
    --role staging --base-dir "$BASE" --release-dir "$CANDIDATE_RUNTIME" \
    --runtime-sha "$runtime_sha" --pm2-bin "$PM2_BIN" \
    --node-bin "$NODE_BIN" --curl-bin "$CURL_BIN" --output-fd 7 \
    --stability-seconds "$STABILITY_SECONDS" >&2
  exec 7>&-
  test_fail_phase after_readiness
  run_worker "$TIMEOUT_BIN" --signal=TERM --kill-after=2s 10s \
    "$PM2_BIN" save >/dev/null
  details="$(mktemp "$STATE_ROOT/.legacy-drill-ready.XXXXXXXX")"
  printf '{"readinessCompletedAt":"%s"}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$details"
  atomic_json_phase "$journal" readiness_passed "$details"
  rm -f -- "$details"
  evidence="$(evidence_path "$request_id")"
  publish_evidence "$request_id" "$journal" "$readiness" "$evidence"
  rm -f -- "$readiness"
  trap - EXIT INT TERM HUP
}

recover_all() {
  local journal phase request_id
  local -a unfinished=()
  shopt -s nullglob
  for journal in "$TRANSACTIONS"/*/journal.json; do
    phase="$(journal_phase "$journal")"
    case "$phase" in completed|recovered) continue ;; esac
    unfinished+=("$journal")
  done
  [ "${#unfinished[@]}" -le 1 ] \
    || die "multiple unfinished legacy staging transactions require owner review"
  for journal in "${unfinished[@]}"; do
    request_id="$(basename -- "$(dirname -- "$journal")")"
    ( set -euo pipefail; restore_transaction "$request_id" )
  done
}

assert_transaction_slot() {
  local allowed_request_id="${1:-}" journal phase observed_request_id
  shopt -s nullglob
  for journal in "$TRANSACTIONS"/*/journal.json; do
    phase="$(journal_phase "$journal")"
    case "$phase" in completed|recovered) continue ;; esac
    observed_request_id="$(basename -- "$(dirname -- "$journal")")"
    [ -n "$allowed_request_id" ] \
      && [ "$observed_request_id" = "$allowed_request_id" ] \
      || die "another legacy staging drill transaction is unfinished"
  done
}

ensure_state
if [ "$COMMAND" != assert-terminal-retirement-ready ]; then
  verify_control
  validate_install_receipt
fi

case "$COMMAND" in
  version)
    printf '%s\n' "$VERSION"
    ;;
  inspect)
    "$NODE_BIN" - "$BROKER_SHA256" "$ADAPTER_SHA256" \
      "$CONTROL_SHA256" "$BASE" "$WORKER_USER" <<'NODE'
const [brokerSha256,adapterSha256,controlSha256,base,workerUser]=process.argv.slice(2);
process.stdout.write(`${JSON.stringify({
 schema:'nexus.rollback-drill-legacy-staging-broker-inspection.v1',
 promotionAllowed:false,base,workerUser,
 broker:{version:'nexus-rollback-drill-legacy-staging-broker.v1',
  sha256:brokerSha256,adapterSha256},
 control:{version:'nexus-release-promotion-control.v2',sha256:controlSha256},
})}\n`);
NODE
    ;;
  prepare)
    acquire_locks
    REQUEST_ID="$1"; RUNTIME_SHA="$2"; ARTIFACT_DIGEST="$3"
    validate_request_id "$REQUEST_ID"
    assert_transaction_slot "$REQUEST_ID"
    [[ "$RUNTIME_SHA" =~ $SHA_RE && "$ARTIFACT_DIGEST" =~ $DIGEST_RE ]] \
      || { echo "legacy staging candidate identity is invalid" >&2; exit 64; }
    RELEASE_DIR="$(release_dir "$RUNTIME_SHA" "$ARTIFACT_DIGEST")"
    UPLOAD_DIR="$UPLOAD_ROOT/$REQUEST_ID"
    PREPARATION="$(preparation_path "$REQUEST_ID")"
    if [ -f "$PREPARATION" ] && [ ! -L "$PREPARATION" ]; then
      PREPARED_FIELDS="$(validate_preparation "$REQUEST_ID" "$PREPARATION")" \
        || die "durable preparation receipt is invalid"
      validate_prepared_directory "$PREPARATION" release \
        || die "prepared candidate directory identity changed"
      validate_prepared_directory "$PREPARATION" upload \
        || die "prepared upload directory identity changed"
      IFS=$'\t' read -r PREPARED_RELEASE PREPARED_UPLOAD PREPARED_SHA \
        PREPARED_DIGEST <<<"$PREPARED_FIELDS"
      [ "$PREPARED_RELEASE" = "$RELEASE_DIR" ] \
        && [ "$PREPARED_UPLOAD" = "$UPLOAD_DIR/request.json" ] \
        && [ "$PREPARED_SHA" = "$RUNTIME_SHA" ] \
        && [ "$PREPARED_DIGEST" = "$ARTIFACT_DIGEST" ] \
        || die "request id is already bound to another candidate"
    else
      [ ! -e "$PREPARATION" ] && [ ! -L "$PREPARATION" ] \
        || die "preparation receipt path is unsafe"
      [ "$(read_current)" != "$RELEASE_DIR" ] \
        || die "candidate is already active without a durable transaction"
      PREPARED_IDENTITIES="$(
        prepare_worker_directories "$RELEASE_DIR" "$UPLOAD_DIR"
      )" || die "candidate or upload directory preparation was unsafe"
      PREPARATION_TEMPORARY="$(mktemp "$PREPARATIONS/.prepare.XXXXXXXX")"
      "$NODE_BIN" - "$PREPARATION_TEMPORARY" "$REQUEST_ID" "$RUNTIME_SHA" \
        "$ARTIFACT_DIGEST" "$RELEASE_DIR" "$UPLOAD_DIR/request.json" \
        "$PREPARED_IDENTITIES" <<'NODE'
const fs=require('node:fs');
const [output,requestId,runtimeSha,artifactDigest,releaseDir,requestUpload,
 identitiesJson]
 =process.argv.slice(2);
const identities=JSON.parse(identitiesJson);
const value={
 schema:'nexus.rollback-drill-legacy-staging-preparation.v1',
 requestId,runtimeSha,artifactDigest,releaseDir,requestUpload,
 releaseIdentity:identities.releaseIdentity,
 uploadIdentity:identities.uploadIdentity,
 preparedAt:new Date().toISOString(),
};
const fd=fs.openSync(output,'w',0o600);
try{fs.writeFileSync(fd,`${JSON.stringify(value,null,2)}\n`);fs.fsyncSync(fd);}
finally{fs.closeSync(fd);}
NODE
      root_own "$PREPARATION_TEMPORARY"
      move_exact "$PREPARATION_TEMPORARY" "$PREPARATION"
      fsync_path "$PREPARATIONS"
      validate_preparation "$REQUEST_ID" "$PREPARATION" >/dev/null \
        || die "durable preparation receipt failed validation"
      validate_prepared_directory "$PREPARATION" release \
        || die "prepared candidate directory identity changed"
      validate_prepared_directory "$PREPARATION" upload \
        || die "prepared upload directory identity changed"
    fi
    printf '{"ok":true,"promotable":false,"requestId":"%s","releaseDir":"%s","requestUpload":"%s"}\n' \
      "$REQUEST_ID" "$RELEASE_DIR" "$UPLOAD_DIR/request.json"
    ;;
  launch)
    acquire_locks
    REQUEST_ID="$1"; validate_request_id "$REQUEST_ID"
    assert_transaction_slot "$REQUEST_ID"
    PREPARATION="$(preparation_path "$REQUEST_ID")"
    [ -f "$PREPARATION" ] && [ ! -L "$PREPARATION" ] \
      || die "root preparation receipt is unavailable"
    PREPARED_FIELDS="$(validate_preparation "$REQUEST_ID" "$PREPARATION")" \
      || die "root preparation receipt is invalid"
    validate_prepared_directory "$PREPARATION" release \
      || die "prepared candidate directory identity changed"
    COPIED_REQUEST="$(
      copy_prepared_worker_request "$PREPARATION" "$REQUEST_ID"
    )" || die "worker request upload could not be copied safely"
    trap 'rm -f -- "${COPIED_REQUEST:-}"' EXIT
    validate_root_request "$REQUEST_ID" "$COPIED_REQUEST"
    REQUEST_VALUES="$(request_fields "$COPIED_REQUEST")"
    IFS=$'\t' read -r _ REQUEST_SHA REQUEST_DIGEST REQUEST_RELEASE \
      <<<"$REQUEST_VALUES"
    IFS=$'\t' read -r PREPARED_RELEASE PREPARED_UPLOAD PREPARED_SHA \
      PREPARED_DIGEST <<<"$PREPARED_FIELDS"
    [ "$REQUEST_RELEASE" = "$PREPARED_RELEASE" ] \
      && [ "$UPLOAD_ROOT/$REQUEST_ID/request.json" = "$PREPARED_UPLOAD" ] \
      && [ "$REQUEST_SHA" = "$PREPARED_SHA" ] \
      && [ "$REQUEST_DIGEST" = "$PREPARED_DIGEST" ] \
      || die "uploaded request differs from the durable preparation"
    ROOT_REQUEST="$(request_path "$REQUEST_ID")"
    JOURNAL="$(journal_path "$REQUEST_ID")"
    if [ -f "$ROOT_REQUEST" ] && [ ! -L "$ROOT_REQUEST" ]; then
      [ "$(sha256_file "$ROOT_REQUEST")" = "$(sha256_file "$COPIED_REQUEST")" ] \
        || die "accepted legacy staging request is immutable"
      rm -f -- "$COPIED_REQUEST"
    else
      [ ! -e "$ROOT_REQUEST" ] && [ ! -L "$ROOT_REQUEST" ] \
        || die "accepted request destination is unsafe"
      move_exact "$COPIED_REQUEST" "$ROOT_REQUEST"
      fsync_path "$REQUESTS"
    fi
    COPIED_REQUEST=
    trap - EXIT
    if [ ! -e "$JOURNAL" ]; then
      write_queued_journal "$REQUEST_ID" "$ROOT_REQUEST" "$JOURNAL"
    fi
    if [ "$TEST_MODE" = 1 ] \
        && [ "${NEXUS_LEGACY_DRILL_TEST_RUN_SYNC:-0}" = 1 ]; then
      run_transaction "$REQUEST_ID"
    else
      "$SYSTEMCTL_BIN" start --no-block \
        "nexus-rollback-drill-legacy-staging@$REQUEST_ID.service"
    fi
    printf '{"ok":true,"promotable":false,"requestId":"%s","status":"submitted"}\n' \
      "$REQUEST_ID"
    ;;
  run)
    acquire_locks
    REQUEST_ID="$1"; validate_request_id "$REQUEST_ID"
    run_transaction "$REQUEST_ID"
    ;;
  status)
    REQUEST_ID="$1"; validate_request_id "$REQUEST_ID"
    JOURNAL="$(journal_path "$REQUEST_ID")"
    [ -f "$JOURNAL" ] && [ ! -L "$JOURNAL" ] || exit 66
    "$NODE_BIN" - "$JOURNAL" <<'NODE'
	const fs=require('node:fs');const x=JSON.parse(fs.readFileSync(process.argv[2]));
	const terminal=new Set(['completed','recovered']).has(x.phase);
	process.stdout.write(`${JSON.stringify({
	 ok:true,promotable:false,requestId:x.requestId,
	 runtimeSha:x.runtimeSha,artifactDigest:x.artifactDigest,phase:x.phase,
	 terminal,successful:x.phase==='completed',
	 recoveryTargetMet:x.recoveryTargetMet??null,
	})}\n`);
NODE
    ;;
  fetch-evidence)
    REQUEST_ID="$1"; validate_request_id "$REQUEST_ID"
    JOURNAL="$(journal_path "$REQUEST_ID")"
    EVIDENCE="$(evidence_path "$REQUEST_ID")"
    [ "$(journal_phase "$JOURNAL")" = completed ] \
      && [ -f "$EVIDENCE" ] && [ ! -L "$EVIDENCE" ] \
      || { echo "legacy staging evidence is not terminal" >&2; exit 66; }
    EXPECTED="$("$NODE_BIN" -e '
const x=require(process.argv[1]);process.stdout.write(x.evidenceSha256||"");' "$JOURNAL")"
    [ "$EXPECTED" = "$(sha256_file "$EVIDENCE")" ] \
      || die "legacy staging terminal evidence digest mismatch"
    adapter_env validate-broker-evidence --evidence "$EVIDENCE" >/dev/null
    cat -- "$EVIDENCE"
    ;;
  recover-all)
    acquire_locks
    recover_all
    printf '{"ok":true,"promotable":false,"status":"reconciled"}\n'
    ;;
  assert-boot-safe)
    acquire_locks
    assert_transaction_slot
    printf '{"ok":true,"promotable":false,"status":"boot_safe"}\n'
    ;;
  assert-terminal-retirement-ready)
    acquire_successor_locks
    assert_transaction_slot
    "$NODE_BIN" - "$TRANSACTIONS" "$CONTROL_SHA256" <<'NODE'
const fs=require('node:fs');const path=require('node:path');
const [root,successorSha256]=process.argv.slice(2);
for(const entry of fs.readdirSync(root,{withFileTypes:true})){
 if(!entry.isDirectory())continue;
 const journal=path.join(root,entry.name,'journal.json');
 if(!fs.existsSync(journal))continue;
 const value=JSON.parse(fs.readFileSync(journal));
 if(!new Set(['completed','recovered']).has(value.phase))process.exit(1);
}
process.stdout.write(`${JSON.stringify({
 ok:true,promotable:false,status:'terminal_retirement_ready',
 successor:{
  version:'nexus-release-promotion-control.v4',
  sha256:successorSha256,
  layoutEvidenceVerified:true,
 },
})}\n`);
NODE
    ;;
esac
