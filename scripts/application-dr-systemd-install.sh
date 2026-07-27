#!/usr/bin/env bash
# Install the application DR implementation from a root-owned immutable source
# tree. This intentionally does not create backup.env or enable the backup
# timer. A new health timer may only inherit an already-enabled backup timer.
set -euo pipefail
umask 077
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

SOURCE_ROOT="${1:-}"
EXPECTED_DRILL_USER="${NEXUS_DR_INSTALL_DRILL_USER:-nexus-drill}"
LAYOUT_RELATIVE="ops/application-dr/install-layout.tsv"
DR_SERVICE="nexus-application-dr-backup.service"
DR_TIMER="nexus-application-dr-backup.timer"
DR_HEALTH_SERVICE="nexus-application-dr-health.service"
DR_HEALTH_TIMER="nexus-application-dr-health.timer"
DR_STATE_DIR="/var/lib/nexus-application-dr"
DR_ALERT_DIR="$DR_STATE_DIR/alerts"
DR_EVIDENCE_DIR="$DR_STATE_DIR/evidence"
DR_BACKUP_LOCK="$DR_STATE_DIR/backup.lock"
DR_INSTALL_JOURNAL="$DR_STATE_DIR/install-in-progress.v1"
DR_INSTALL_RECEIPT="$DR_STATE_DIR/install-receipt.v2.json"
DR_INSTALL_RECOVERY_PROGRAM="$DR_STATE_DIR/install-recovery-program.v2.py"
DR_INSTALL_RECOVERY_SERVICE="nexus-application-dr-install-recovery.service"

die() {
  echo "application DR installer: $*" >&2
  exit 1
}

usage() {
  echo "Usage: sudo scripts/application-dr-systemd-install.sh <root-owned-source-root>"
}

[ $# -eq 1 ] || {
  usage >&2
  exit 64
}
[ "$(id -u)" -eq 0 ] || die "must run as root"
for command in cat chmod cp dirname flock getent groupdel id install ln mktemp mv \
  python3 realpath rm rmdir sha256sum stat systemctl tail useradd userdel; do
  command -v "$command" >/dev/null 2>&1 || die "$command is required"
done

fsync_path() {
  python3 - "$1" <<'PY'
import os
import sys

descriptor = os.open(sys.argv[1], os.O_RDONLY)
try:
    os.fsync(descriptor)
finally:
    os.close(descriptor)
PY
}

durable_remove() {
  local target="$1"
  rm -f -- "$target" || return 1
  fsync_path "$(dirname -- "$target")" || return 1
}

[[ "$SOURCE_ROOT" == /* && "$SOURCE_ROOT" != / && -d "$SOURCE_ROOT" && ! -L "$SOURCE_ROOT" ]] \
  || die "source root must be an absolute non-symlink directory"
canonical_source_root="$(realpath -e -- "$SOURCE_ROOT")"
[ "$canonical_source_root" = "$SOURCE_ROOT" ] \
  || die "source root must not traverse symlinks"
SOURCE_ROOT="$canonical_source_root"

validate_root_owned_chain() {
  local current="$1" label="${2:-source}" owner mode
  while :; do
    owner="$(stat -c '%U:%G' -- "$current")"
    mode="$(stat -c '%a' -- "$current")"
    [ "$owner" = root:root ] \
      || die "$label path component is not root-owned: $current"
    (( (8#$mode & 0022) == 0 )) \
      || die "$label path component is group/world writable: $current"
    [ "$current" = / ] && break
    current="$(dirname -- "$current")"
  done
}
validate_root_owned_chain "$SOURCE_ROOT"

[[ "$EXPECTED_DRILL_USER" =~ ^[a-z_][a-z0-9_-]*$ ]] \
  || die "drill user is invalid"

LAYOUT="$SOURCE_ROOT/$LAYOUT_RELATIVE"
[[ -f "$LAYOUT" && ! -L "$LAYOUT" ]] \
  || die "install layout is missing or unsafe"
[ "$(realpath -e -- "$LAYOUT")" = "$LAYOUT" ] \
  || die "install layout must not traverse symlinks"
validate_root_owned_chain "$LAYOUT"

systemctl_enabled_state() {
  local unit="$1" state rc
  if state="$(systemctl is-enabled "$unit" 2>/dev/null)"; then
    rc=0
  else
    rc=$?
  fi
  case "$state" in
    enabled)
      [ "$rc" -eq 0 ] \
        || die "systemd enabled-state result is inconsistent for $unit"
      ;;
    disabled|not-found)
      [ "$rc" -ne 0 ] \
        || die "systemd disabled-state result is inconsistent for $unit"
      ;;
    *)
      die "systemd enabled state is transitional or unsupported for $unit: ${state:-empty}"
      ;;
  esac
  printf '%s\n' "$state"
}

systemctl_active_state() {
  local unit="$1" state rc
  if state="$(systemctl is-active "$unit" 2>/dev/null)"; then
    rc=0
  else
    rc=$?
  fi
  case "$state" in
    active)
      [ "$rc" -eq 0 ] \
        || die "systemd active-state result is inconsistent for $unit"
      ;;
    inactive)
      [ "$rc" -ne 0 ] \
        || die "systemd inactive-state result is inconsistent for $unit"
      ;;
    *)
      die "systemd active state is transitional or unsupported for $unit: ${state:-empty}"
      ;;
  esac
  printf '%s\n' "$state"
}

expected_layout="$(
  cat <<'LAYOUT'
scripts/application-dr-backup.sh	/usr/local/libexec/nexus-application-dr/application-dr-backup.sh	root:root	0755
scripts/application-dr-sqlite.py	/usr/local/libexec/nexus-application-dr/application-dr-sqlite.py	root:root	0644
config/production-migration-lineages.json	/usr/local/libexec/nexus-application-dr/production-migration-lineages.json	root:root	0644
scripts/application-dr-retention.py	/usr/local/libexec/nexus-application-dr/application-dr-retention.py	root:root	0644
scripts/application-dr-version-retention.py	/usr/local/libexec/nexus-application-dr/application-dr-version-retention.py	root:root	0644
scripts/application-dr-storage-controls.py	/usr/local/libexec/nexus-application-dr/application-dr-storage-controls.py	root:root	0644
scripts/aws-credential-process-boundary.py	/usr/local/libexec/nexus-application-dr/aws-credential-process-boundary.py	root:root	0644
scripts/application-dr-crl-parameters.mjs	/usr/local/libexec/nexus-application-dr/application-dr-crl-parameters.mjs	root:root	0755
scripts/application-dr-cloudformation-activate.py	/usr/local/libexec/nexus-application-dr/application-dr-cloudformation-activate.py	root:root	0755
scripts/application-dr-cloudformation-parameter-digest.py	/usr/local/libexec/nexus-application-dr/application-dr-cloudformation-parameter-digest.py	root:root	0755
scripts/application-dr-install-transaction.py	/usr/local/libexec/nexus-application-dr/application-dr-install-transaction.py	root:root	0755
scripts/application-dr-roles-anywhere-probe.py	/usr/local/libexec/nexus-application-dr/application-dr-roles-anywhere-probe.py	root:root	0755
scripts/application-dr-health-check.py	/usr/local/libexec/nexus-application-dr/application-dr-health-check.py	root:root	0755
scripts/application-dr-alert.py	/usr/local/libexec/nexus-application-dr/application-dr-alert.py	root:root	0755
scripts/application-dr-recovery-runtime.mjs	/usr/local/libexec/nexus-application-dr/application-dr-recovery-runtime.mjs	root:root	0644
scripts/release-recovery-runtime-identity.mjs	/usr/local/libexec/nexus-application-dr/release-recovery-runtime-identity.mjs	root:root	0644
scripts/application-dr-recovery-archive.py	/usr/local/libexec/nexus-application-dr/application-dr-recovery-archive.py	root:root	0644
scripts/application-dr-archive.py	/usr/local/libexec/nexus-application-dr/application-dr-archive.py	root:root	0644
scripts/release-runtime-dependencies.mjs	/usr/local/libexec/nexus-application-dr/release-runtime-dependencies.mjs	root:root	0644
scripts/application-dr-restore-drill.sh	/usr/local/libexec/nexus-application-dr/application-dr-restore-drill.sh	root:root	0755
scripts/application-dr-isolated-harness.sh	/usr/local/libexec/nexus-application-dr/application-dr-isolated-harness.sh	root:root	0700
docs/release/evidence/release-evidence-public-key.pem	/etc/nexus-application-dr/release-evidence-public-key.pem	root:root	0644
ops/application-dr/systemd/nexus-application-dr-backup.service	/etc/systemd/system/nexus-application-dr-backup.service	root:root	0644
ops/application-dr/systemd/nexus-application-dr-backup.timer	/etc/systemd/system/nexus-application-dr-backup.timer	root:root	0644
ops/application-dr/systemd/nexus-application-dr-health.service	/etc/systemd/system/nexus-application-dr-health.service	root:root	0644
ops/application-dr/systemd/nexus-application-dr-health.timer	/etc/systemd/system/nexus-application-dr-health.timer	root:root	0644
ops/application-dr/systemd/nexus-application-dr-alert@.service	/etc/systemd/system/nexus-application-dr-alert@.service	root:root	0644
ops/application-dr/systemd/nexus-application-dr-install-recovery.service	/etc/systemd/system/nexus-application-dr-install-recovery.service	root:root	0644
LAYOUT
)"
actual_layout="$(tail -n +2 "$LAYOUT")"
[ "$actual_layout" = "$expected_layout" ] \
  || die "install layout differs from the exact allowlist"

validate_existing_target_chain() {
  local current="$1" parent canonical
  while [ ! -e "$current" ] && [ ! -L "$current" ]; do
    parent="$(dirname -- "$current")"
    [ "$parent" != "$current" ] || die "install target has no existing trusted ancestor"
    current="$parent"
  done
  [ -d "$current" ] && [ ! -L "$current" ] \
    || die "install target ancestor is unsafe: $current"
  canonical="$(realpath -e -- "$current")"
  [ "$canonical" = "$current" ] \
    || die "install target ancestor traverses a symlink: $current"
  validate_root_owned_chain "$current" "install target"
}

sources=()
targets=()
owners=()
modes=()
had_targets=()
service_index=-1
health_timer_index=-1
install_recovery_service_index=-1
while IFS=$'\t' read -r relative target owner mode extra; do
  [ -z "$extra" ] || die "install layout contains an extra column"
  [ -n "$relative" ] && [ -n "$target" ] && [ -n "$owner" ] && [ -n "$mode" ] \
    || die "install layout contains an incomplete row"
  [[ "$relative" =~ ^[A-Za-z0-9._@/-]+$ ]] \
    && [[ "/$relative/" != *"/../"* && "/$relative/" != *"/./"* ]] \
    && [[ "$relative" != /* ]] \
    || die "install layout source is unsafe"
  source_path="$SOURCE_ROOT/$relative"
  [[ -f "$source_path" && ! -L "$source_path" ]] \
    || die "install source is missing or unsafe: $relative"
  [ "$(realpath -e -- "$source_path")" = "$source_path" ] \
    || die "install source traverses a symlink: $relative"
  validate_root_owned_chain "$source_path"
  [ "$owner" = root:root ] || die "install target owner is outside the allowlist"
  [[ "$mode" =~ ^0(644|700|755)$ ]] \
    || die "install target mode is outside the allowlist"
  [[ "$target" == /* && "$target" != / ]] \
    && [ "$(realpath -m -- "$target")" = "$target" ] \
    || die "install target is noncanonical: $target"
  case "$target" in
    /usr/local/libexec/nexus-application-dr/*|\
    /etc/nexus-application-dr/release-evidence-public-key.pem|\
    /etc/systemd/system/nexus-application-dr-backup.service|\
    /etc/systemd/system/nexus-application-dr-backup.timer|\
    /etc/systemd/system/nexus-application-dr-health.service|\
    /etc/systemd/system/nexus-application-dr-health.timer|\
    /etc/systemd/system/nexus-application-dr-alert@.service|\
    /etc/systemd/system/nexus-application-dr-install-recovery.service) ;;
    *) die "install target is outside the allowlist: $target" ;;
  esac
  target_parent="$(dirname -- "$target")"
  validate_existing_target_chain "$target_parent"
  if [ -L "$target" ]; then
    die "existing install target is a symlink: $target"
  elif [ -e "$target" ]; then
    [ -f "$target" ] || die "existing install target is not a regular file: $target"
    [ "$(realpath -e -- "$target")" = "$target" ] \
      || die "existing install target traverses a symlink: $target"
    validate_root_owned_chain "$target" "install target"
    had_targets+=(true)
  else
    had_targets+=(false)
  fi
  sources+=("$source_path")
  targets+=("$target")
  owners+=("$owner")
  modes+=("$mode")
  if [ "$target" = "/etc/systemd/system/$DR_SERVICE" ]; then
    service_index=$((${#targets[@]} - 1))
  fi
  if [ "$target" = "/etc/systemd/system/$DR_HEALTH_TIMER" ]; then
    health_timer_index=$((${#targets[@]} - 1))
  fi
  if [ "$target" = "/etc/systemd/system/$DR_INSTALL_RECOVERY_SERVICE" ]; then
    install_recovery_service_index=$((${#targets[@]} - 1))
  fi
done <<< "$actual_layout"

planned="${#sources[@]}"
[ "$planned" -gt 0 ] || die "install layout is empty"
[ "$service_index" -ge 0 ] || die "install layout omits the guarded backup service"
[ "$health_timer_index" -ge 0 ] \
  || die "install layout omits the application DR health timer"
[ "$install_recovery_service_index" -ge 0 ] \
  || die "install layout omits the application DR install recovery service"

drill_user_exists=false
if getent passwd "$EXPECTED_DRILL_USER" >/dev/null; then
  drill_user_exists=true
  IFS=: read -r account _ uid gid _ home shell \
    < <(getent passwd "$EXPECTED_DRILL_USER")
  [ "$account" = "$EXPECTED_DRILL_USER" ] \
    && [[ "$uid" =~ ^[0-9]+$ && "$uid" -gt 0 ]] \
    && [[ "$gid" =~ ^[0-9]+$ && "$gid" -gt 0 ]] \
    && [ "$home" = /nonexistent ] \
    || die "existing drill account identity is invalid"
  case "$shell" in
    /usr/sbin/nologin|/sbin/nologin|/bin/false) ;;
    *) die "existing drill account must have a disabled login shell" ;;
  esac
else
  ! getent group "$EXPECTED_DRILL_USER" >/dev/null \
    || die "drill account private group already exists without its user"
fi

timer_enabled_state="$(systemctl_enabled_state "$DR_TIMER")"
timer_enabled=false
if [ "$timer_enabled_state" = enabled ]; then timer_enabled=true; fi
timer_active_state="$(systemctl_active_state "$DR_TIMER")"
timer_active=false
if [ "$timer_active_state" = active ]; then timer_active=true; fi
health_timer_enabled_state="$(systemctl_enabled_state "$DR_HEALTH_TIMER")"
health_timer_enabled=false
if [ "$health_timer_enabled_state" = enabled ]; then
  health_timer_enabled=true
fi
health_timer_active_state="$(systemctl_active_state "$DR_HEALTH_TIMER")"
health_timer_active=false
if [ "$health_timer_active_state" = active ]; then
  health_timer_active=true
fi
install_recovery_service_enabled_state="$(
  systemctl_enabled_state "$DR_INSTALL_RECOVERY_SERVICE"
)"
install_recovery_service_enabled=false
if [ "$install_recovery_service_enabled_state" = enabled ]; then
  install_recovery_service_enabled=true
fi
health_timer_unit_preexisting="${had_targets[$health_timer_index]}"
health_timer_desired_enabled="$health_timer_enabled"
health_timer_desired_active="$health_timer_active"
if [ "$health_timer_unit_preexisting" = true ]; then
  [ "$health_timer_enabled" = "$timer_enabled" ] \
    || die "backup and health timer enabled states differ"
  [ "$health_timer_active" = "$timer_active" ] \
    || die "backup and health timer active states differ"
else
  [ "$health_timer_enabled" = false ] \
    && [ "$health_timer_active" = false ] \
    || die "an untracked application DR health timer is enabled or active"
  # First upgrade from the backup-only layout adopts the already-approved
  # backup timer state. A disabled backup remains disabled; an enabled backup
  # gains monitoring without requiring an unsafe gap or a second installer.
  health_timer_desired_enabled="$timer_enabled"
  health_timer_desired_active="$timer_active"
fi

libexec_dir_existed=false
etc_dir_existed=false
state_dir_existed=false
alert_dir_existed=false
evidence_dir_existed=false
preexisting_install_journal=false
[ -d /usr/local/libexec/nexus-application-dr ] && libexec_dir_existed=true
[ -d /etc/nexus-application-dr ] && etc_dir_existed=true
[ -d "$DR_STATE_DIR" ] && state_dir_existed=true
[ -d "$DR_ALERT_DIR" ] && alert_dir_existed=true
[ -d "$DR_EVIDENCE_DIR" ] && evidence_dir_existed=true
validate_existing_target_chain "$DR_STATE_DIR"
if [ -L "$DR_ALERT_DIR" ]; then
  die "application DR alert directory is a symlink"
elif [ -e "$DR_ALERT_DIR" ]; then
  [ -d "$DR_ALERT_DIR" ] || die "application DR alert path is not a directory"
  [ "$(realpath -e -- "$DR_ALERT_DIR")" = "$DR_ALERT_DIR" ] \
    || die "application DR alert directory traverses a symlink"
  [ "$(stat -c '%U:%G:%a' -- "$DR_ALERT_DIR")" = root:root:700 ] \
    || die "application DR alert directory must be root:root mode 0700"
fi
if [ -L "$DR_EVIDENCE_DIR" ]; then
  die "application DR evidence directory is a symlink"
elif [ -e "$DR_EVIDENCE_DIR" ]; then
  [ -d "$DR_EVIDENCE_DIR" ] || die "application DR evidence path is not a directory"
  [ "$(realpath -e -- "$DR_EVIDENCE_DIR")" = "$DR_EVIDENCE_DIR" ] \
    || die "application DR evidence directory traverses a symlink"
  [ "$(stat -c '%U:%G:%a' -- "$DR_EVIDENCE_DIR")" = root:root:700 ] \
    || die "application DR evidence directory must be root:root mode 0700"
fi
if [ -L "$DR_BACKUP_LOCK" ]; then
  die "application DR backup lock is a symlink"
elif [ -e "$DR_BACKUP_LOCK" ]; then
  [ -f "$DR_BACKUP_LOCK" ] || die "application DR backup lock is not a regular file"
  validate_root_owned_chain "$DR_BACKUP_LOCK" "application DR backup lock"
fi
if [ -L "$DR_INSTALL_JOURNAL" ]; then
  die "application DR install journal is a symlink"
elif [ -e "$DR_INSTALL_JOURNAL" ]; then
  [ -f "$DR_INSTALL_JOURNAL" ] \
    || die "application DR install journal is not a regular file"
  [ "$(realpath -e -- "$DR_INSTALL_JOURNAL")" = "$DR_INSTALL_JOURNAL" ] \
    || die "application DR install journal traverses a symlink"
  [ "$(stat -c '%U:%G:%a' -- "$DR_INSTALL_JOURNAL")" = root:root:600 ] \
    || die "application DR install journal must be root:root mode 0600"
  preexisting_install_journal=true
fi

if [ "$preexisting_install_journal" = true ]; then
  # Never replace an unfinished transaction. Stop both timer entry points and
  # use only the exact transaction-bound recovery program retained in state.
  systemctl stop "$DR_HEALTH_TIMER" >/dev/null 2>&1 || true
  systemctl stop "$DR_TIMER" >/dev/null 2>&1 || true
  [ -f "$DR_INSTALL_RECOVERY_PROGRAM" ] \
    && [ ! -L "$DR_INSTALL_RECOVERY_PROGRAM" ] \
    && [ "$(realpath -e -- "$DR_INSTALL_RECOVERY_PROGRAM")" = "$DR_INSTALL_RECOVERY_PROGRAM" ] \
    && [ "$(stat -c '%U:%G:%a' -- "$DR_INSTALL_RECOVERY_PROGRAM")" = root:root:600 ] \
    || die "unfinished install requires its exact retained recovery program"
  python3 "$DR_INSTALL_RECOVERY_PROGRAM" recover \
    --journal "$DR_INSTALL_JOURNAL" \
    --receipt "$DR_STATE_DIR/install-recovery-receipt.v2.json" \
    --program "$DR_INSTALL_RECOVERY_PROGRAM" \
    --lock "$DR_BACKUP_LOCK"
  die "recovered the unfinished install; review recovery evidence and rerun"
fi

stage_paths=()
backup_paths=()
committed_indices=()
install_succeeded=false
timer_stopped=false
timer_restored=false
health_timer_stopped=false
health_timer_restored=false
health_timer_enabled_by_install=false
health_timer_started_by_install=false
install_recovery_service_enabled_by_install=false
lock_open=false
drill_user_created=false
drill_group_created=false
journal_armed=false
rollback_abandoned=false
transaction_dir=""
transaction_plan=""

cleanup_install() {
  local rc=$? stage backup rollback_failed=false
  trap - EXIT INT TERM
  set +e
  if [ "$install_succeeded" != true ] \
      && [ "$journal_armed" = false ] \
      && [ "$preexisting_install_journal" = false ] \
      && [ -e "$DR_INSTALL_JOURNAL" ]; then
    # begin() may have durably created the journal immediately before its
    # caller observed a failure. Treat the journal, not the shell flag, as the
    # authoritative recovery boundary.
    journal_armed=true
  fi
  if [ "$journal_armed" = true ] && [ ! -e "$DR_INSTALL_JOURNAL" ]; then
    # The transaction helper crossed its verified commit point. Do not attempt
    # predecessor restoration without the authoritative journal.
    rollback_abandoned=true
  fi
  if [ "$install_succeeded" != true ] \
      && [ "$journal_armed" = true ] \
      && [ "$rollback_abandoned" = false ]; then
    # Use the exact retained recovery program for ordinary shell failures too.
    # This keeps boot recovery and in-process rollback on one verifier and
    # prevents the shell from clearing the journal before identity/systemd
    # predecessor state is proven.
    if [ "$lock_open" = true ]; then
      exec 9>&-
      lock_open=false
    fi
    if python3 "$DR_INSTALL_RECOVERY_PROGRAM" recover \
        --journal "$DR_INSTALL_JOURNAL" \
        --receipt "$DR_STATE_DIR/install-recovery-receipt.v2.json" \
        --program "$DR_INSTALL_RECOVERY_PROGRAM" \
        --lock "$DR_BACKUP_LOCK"; then
      journal_armed=false
      committed_indices=()
      stage_paths=()
      backup_paths=()
      drill_user_created=false
      drill_group_created=false
    else
      rollback_failed=true
      echo "application DR installer: exact transaction rollback failed; journal retained" >&2
    fi
  elif [ "$install_succeeded" != true ] \
      && [ "$rollback_abandoned" = true ]; then
    rollback_failed=true
    echo "application DR installer: installation stopped after its commit point" >&2
  elif [ "$install_succeeded" != true ]; then
    # Before the durable journal exists, no account or target mutation is
    # permitted. Only uncommitted stages and predecessor hard links exist.
    for stage in "${stage_paths[@]:-}"; do
      [ -n "$stage" ] && durable_remove "$stage"
    done
    for backup in "${backup_paths[@]:-}"; do
      [ -n "$backup" ] && durable_remove "$backup"
    done
  fi
  if [ "$lock_open" = true ]; then
    exec 9>&-
    lock_open=false
  fi
  if [ "$install_succeeded" != true ] && [ "$journal_armed" = false ]; then
    if [ "$alert_dir_existed" = false ]; then
      rmdir -- "$DR_ALERT_DIR" >/dev/null 2>&1
    fi
    if [ "$evidence_dir_existed" = false ]; then
      rmdir -- "$DR_EVIDENCE_DIR" >/dev/null 2>&1
    fi
    if [ "$state_dir_existed" = false ]; then
      rm -f -- "$DR_BACKUP_LOCK"
      rmdir -- "$DR_STATE_DIR" >/dev/null 2>&1
    fi
    if [ "$etc_dir_existed" = false ]; then rmdir -- /etc/nexus-application-dr >/dev/null 2>&1; fi
    if [ "$libexec_dir_existed" = false ]; then
      rmdir -- /usr/local/libexec/nexus-application-dr >/dev/null 2>&1
    fi
  fi
  if [ "$rollback_failed" = true ]; then
    systemctl stop "$DR_HEALTH_TIMER" >/dev/null 2>&1
    systemctl stop "$DR_TIMER" >/dev/null 2>&1
    echo "application DR installer: rollback incomplete; leaving $DR_HEALTH_TIMER stopped" >&2
    echo "application DR installer: rollback incomplete; leaving $DR_TIMER stopped" >&2
    rc=1
  fi
  exit "$rc"
}
trap cleanup_install EXIT
trap 'exit 130' INT TERM

install -d -o root -g root -m 0755 \
  /usr/local/libexec \
  /usr/local/libexec/nexus-application-dr
install -d -o root -g root -m 0700 \
  /etc/nexus-application-dr \
  "$DR_STATE_DIR" \
  "$DR_ALERT_DIR" \
  "$DR_EVIDENCE_DIR"
fsync_path /usr/local/libexec/nexus-application-dr
fsync_path /usr/local/libexec
fsync_path /etc/nexus-application-dr
fsync_path /etc
fsync_path "$DR_STATE_DIR"
fsync_path "$DR_ALERT_DIR"
fsync_path "$DR_EVIDENCE_DIR"
fsync_path /var/lib
validate_root_owned_chain /usr/local/libexec/nexus-application-dr "install target"
validate_root_owned_chain /etc/nexus-application-dr "install target"
validate_root_owned_chain "$DR_STATE_DIR" "application DR state"

exec 9>"$DR_BACKUP_LOCK"
lock_open=true
chmod 0600 "$DR_BACKUP_LOCK"
flock -n 9 || die "another application DR backup or install is running"

transaction_dir="$(mktemp -d -p "$DR_STATE_DIR" ".install-transaction.v2.XXXXXX")"
chmod 0700 "$transaction_dir"
transaction_plan="$transaction_dir/plan.tsv"
: >"$transaction_plan"
chmod 0600 "$transaction_plan"

for ((index=0; index<planned; index+=1)); do
  target="${targets[$index]}"
  target_parent="$(dirname -- "$target")"
  stage="$(mktemp -p "$target_parent" ".nexus-application-dr.stage.XXXXXX")"
  install -o root -g root -m "${modes[$index]}" -- "${sources[$index]}" "$stage"
  fsync_path "$stage"
  stage_paths[$index]="$stage"
  backup_paths[$index]=""
  if [ "${had_targets[$index]}" = true ]; then
    backup="$(mktemp -p "$target_parent" ".nexus-application-dr.backup.XXXXXX")"
    rm -f -- "$backup"
    ln -- "$target" "$backup"
    fsync_path "$target_parent"
    backup_paths[$index]="$backup"
  fi
  printf '%d\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$index" "${sources[$index]}" "$target" "$stage" \
    "${backup_paths[$index]}" "${had_targets[$index]}" \
    "${owners[$index]}" "${modes[$index]}" >>"$transaction_plan"
done
fsync_path "$transaction_plan"
fsync_path "$transaction_dir"

recovery_temporary="$(mktemp -p "$DR_STATE_DIR" ".install-recovery-program.v2.XXXXXX")"
install -o root -g root -m 0600 \
  -- "$SOURCE_ROOT/scripts/application-dr-install-transaction.py" \
  "$recovery_temporary"
fsync_path "$recovery_temporary"
mv -fT -- "$recovery_temporary" "$DR_INSTALL_RECOVERY_PROGRAM"
fsync_path "$DR_STATE_DIR"

python3 "$SOURCE_ROOT/scripts/application-dr-install-transaction.py" begin \
  --journal "$DR_INSTALL_JOURNAL" \
  --plan "$transaction_plan" \
  --source-root "$SOURCE_ROOT" \
  --layout "$LAYOUT" \
  --recovery-program "$DR_INSTALL_RECOVERY_PROGRAM" \
  --drill-user "$EXPECTED_DRILL_USER" \
  --backup-timer-enabled "$timer_enabled" \
  --backup-timer-enabled-state "$timer_enabled_state" \
  --backup-timer-active "$timer_active" \
  --backup-timer-active-state "$timer_active_state" \
  --health-timer-enabled "$health_timer_enabled" \
  --health-timer-enabled-state "$health_timer_enabled_state" \
  --health-timer-active "$health_timer_active" \
  --health-timer-active-state "$health_timer_active_state" \
  --recovery-service-enabled "$install_recovery_service_enabled" \
  --recovery-service-enabled-state \
    "$install_recovery_service_enabled_state" >/dev/null
journal_armed=true

if [ "$health_timer_active" = true ]; then
  systemctl stop "$DR_HEALTH_TIMER"
  health_timer_stopped=true
fi
if [ "$timer_active" = true ]; then
  systemctl stop "$DR_TIMER"
  timer_stopped=true
fi
if systemctl is-active "$DR_SERVICE" >/dev/null 2>&1; then
  die "application DR backup service is active; retry after it completes"
fi
if systemctl is-active "$DR_HEALTH_SERVICE" >/dev/null 2>&1; then
  die "application DR health service is active; retry after it completes"
fi
python3 "$DR_INSTALL_RECOVERY_PROGRAM" checkpoint \
  --journal "$DR_INSTALL_JOURNAL" \
  --phase timers-stopped

if [ "$drill_user_exists" = false ]; then
  # Arm the exact cleanup obligation before useradd. A lost process response,
  # power failure, or partial private-group creation is therefore recovered by
  # the same retained verifier. Removing an identity that was never created is
  # explicitly accepted only after getent proves both predecessors remain absent.
  python3 "$DR_INSTALL_RECOVERY_PROGRAM" checkpoint \
    --journal "$DR_INSTALL_JOURNAL" \
    --phase drill-user-create-attempted \
    --drill-user-created
  drill_user_created=true
  drill_group_created=true
  if ! useradd \
    --system \
    --user-group \
    --home-dir /nonexistent \
    --no-create-home \
    --shell /usr/sbin/nologin \
    "$EXPECTED_DRILL_USER"; then
    die "failed to create drill account"
  fi
  python3 "$DR_INSTALL_RECOVERY_PROGRAM" checkpoint \
    --journal "$DR_INSTALL_JOURNAL" \
    --phase drill-user-created
fi
supplementary_groups="$(id -nG "$EXPECTED_DRILL_USER")"
[ "$supplementary_groups" = "$EXPECTED_DRILL_USER" ] \
  || die "drill account must not belong to supplementary groups"

commit_asset() {
  local index="$1" target target_parent
  target="${targets[$index]}"
  target_parent="$(dirname -- "$target")"
  python3 "$DR_INSTALL_RECOVERY_PROGRAM" checkpoint \
    --journal "$DR_INSTALL_JOURNAL" \
    --phase "committing-$index"
  committed_indices+=("$index")
  mv -fT -- "${stage_paths[$index]}" "$target"
  fsync_path "$target_parent"
  stage_paths[$index]=""
  python3 "$DR_INSTALL_RECOVERY_PROGRAM" checkpoint \
    --journal "$DR_INSTALL_JOURNAL" \
    --phase "committed-$index" \
    --committed-index "$index"
}

# Enroll boot recovery before any application asset. The recovery program and
# exact predecessor/source plan already exist in root-private durable state.
commit_asset "$install_recovery_service_index"
systemctl daemon-reload
systemctl enable "$DR_INSTALL_RECOVERY_SERVICE"
if [ "$install_recovery_service_enabled" = false ]; then
  install_recovery_service_enabled_by_install=true
fi
python3 "$DR_INSTALL_RECOVERY_PROGRAM" checkpoint \
  --journal "$DR_INSTALL_JOURNAL" \
  --phase recovery-service-enrolled

# The guarded backup service is the next durable replacement.
commit_asset "$service_index"
for ((index=0; index<planned; index+=1)); do
  [ "$index" -eq "$service_index" ] && continue
  [ "$index" -eq "$install_recovery_service_index" ] && continue
  commit_asset "$index"
done

systemctl daemon-reload
timer_enabled_after=false
if systemctl is-enabled "$DR_TIMER" >/dev/null 2>&1; then
  timer_enabled_after=true
fi
[ "$timer_enabled_after" = "$timer_enabled" ] \
  || die "application DR timer enabled state changed during install"
health_timer_enabled_after=false
if systemctl is-enabled "$DR_HEALTH_TIMER" >/dev/null 2>&1; then
  health_timer_enabled_after=true
fi
if [ "$health_timer_enabled_after" != "$health_timer_desired_enabled" ] \
    && [ "$health_timer_unit_preexisting" = false ] \
    && [ "$health_timer_enabled_after" = false ] \
    && [ "$health_timer_desired_enabled" = true ]; then
  systemctl enable "$DR_HEALTH_TIMER"
  health_timer_enabled_by_install=true
  python3 "$DR_INSTALL_RECOVERY_PROGRAM" checkpoint \
    --journal "$DR_INSTALL_JOURNAL" \
    --phase health-timer-enabled \
    --health-timer-enabled-by-install
  health_timer_enabled_after=true
fi
[ "$health_timer_enabled_after" = "$health_timer_desired_enabled" ] \
  || die "application DR health timer enabled state changed during install"
if [ "$timer_active" = true ]; then
  systemctl start "$DR_TIMER"
  timer_restored=true
elif systemctl is-active "$DR_TIMER" >/dev/null 2>&1; then
  systemctl stop "$DR_TIMER"
fi
if [ "$health_timer_desired_active" = true ]; then
  systemctl start "$DR_HEALTH_TIMER"
  if [ "$health_timer_active" = true ]; then
    health_timer_restored=true
  else
    health_timer_started_by_install=true
  fi
elif systemctl is-active "$DR_HEALTH_TIMER" >/dev/null 2>&1; then
  systemctl stop "$DR_HEALTH_TIMER"
fi

installed="$planned"
python3 "$DR_INSTALL_RECOVERY_PROGRAM" complete \
  --journal "$DR_INSTALL_JOURNAL" \
  --receipt "$DR_INSTALL_RECEIPT" \
  --program "$DR_INSTALL_RECOVERY_PROGRAM"
rollback_abandoned=true
journal_armed=false
backup_paths=()
stage_paths=()
install_succeeded=true

printf '{"ok":true,"schema":"nexus.application-dr-install.v2","installedAssets":%d,"drillUser":"%s","timerEnabled":%s,"healthTimerEnabled":%s,"receipt":"%s","configurationWritten":false}\n' \
  "$installed" "$EXPECTED_DRILL_USER" "$timer_enabled" \
  "$health_timer_desired_enabled" "$DR_INSTALL_RECEIPT"
