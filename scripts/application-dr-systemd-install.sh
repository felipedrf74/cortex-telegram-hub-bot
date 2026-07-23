#!/usr/bin/env bash
# Install the application DR implementation from a root-owned immutable source
# tree. This intentionally does not create backup.env or enable the timer.
set -euo pipefail
umask 077
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

SOURCE_ROOT="${1:-}"
EXPECTED_DRILL_USER="${NEXUS_DR_INSTALL_DRILL_USER:-nexus-drill}"
LAYOUT_RELATIVE="ops/application-dr/install-layout.tsv"
DR_SERVICE="nexus-application-dr-backup.service"
DR_TIMER="nexus-application-dr-backup.timer"
DR_STATE_DIR="/var/lib/nexus-application-dr"
DR_BACKUP_LOCK="$DR_STATE_DIR/backup.lock"
DR_INSTALL_JOURNAL="$DR_STATE_DIR/install-in-progress.v1"

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
for command in cat chmod dirname flock getent groupdel id install ln mktemp mv \
  python3 realpath rm rmdir stat systemctl tail useradd userdel; do
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

write_install_journal() {
  local temporary
  temporary="$(mktemp -p "$DR_STATE_DIR" ".install-in-progress.v1.tmp.XXXXXX")"
  printf '%s\n' \
    '{"schema":"nexus.application-dr-install-journal.v1","status":"in_progress"}' \
    >"$temporary"
  chmod 0600 "$temporary"
  fsync_path "$temporary"
  mv -fT -- "$temporary" "$DR_INSTALL_JOURNAL"
  fsync_path "$DR_STATE_DIR"
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

expected_layout="$(
  cat <<'LAYOUT'
scripts/application-dr-backup.sh	/usr/local/libexec/nexus-application-dr/application-dr-backup.sh	root:root	0755
scripts/application-dr-sqlite.py	/usr/local/libexec/nexus-application-dr/application-dr-sqlite.py	root:root	0644
config/production-migration-lineages.json	/usr/local/libexec/nexus-application-dr/production-migration-lineages.json	root:root	0644
scripts/application-dr-retention.py	/usr/local/libexec/nexus-application-dr/application-dr-retention.py	root:root	0644
scripts/application-dr-version-retention.py	/usr/local/libexec/nexus-application-dr/application-dr-version-retention.py	root:root	0644
scripts/application-dr-storage-controls.py	/usr/local/libexec/nexus-application-dr/application-dr-storage-controls.py	root:root	0644
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
while IFS=$'\t' read -r relative target owner mode extra; do
  [ -z "$extra" ] || die "install layout contains an extra column"
  [ -n "$relative" ] && [ -n "$target" ] && [ -n "$owner" ] && [ -n "$mode" ] \
    || die "install layout contains an incomplete row"
  [[ "$relative" =~ ^[A-Za-z0-9._/-]+$ ]] \
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
    /etc/systemd/system/nexus-application-dr-backup.timer) ;;
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
done <<< "$actual_layout"

planned="${#sources[@]}"
[ "$planned" -gt 0 ] || die "install layout is empty"
[ "$service_index" -ge 0 ] || die "install layout omits the guarded backup service"

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

timer_enabled=false
if systemctl is-enabled "$DR_TIMER" >/dev/null 2>&1; then
  timer_enabled=true
fi
timer_active=false
if systemctl is-active "$DR_TIMER" >/dev/null 2>&1; then
  timer_active=true
fi

libexec_dir_existed=false
etc_dir_existed=false
state_dir_existed=false
preexisting_install_journal=false
[ -d /usr/local/libexec/nexus-application-dr ] && libexec_dir_existed=true
[ -d /etc/nexus-application-dr ] && etc_dir_existed=true
[ -d "$DR_STATE_DIR" ] && state_dir_existed=true
validate_existing_target_chain "$DR_STATE_DIR"
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

stage_paths=()
backup_paths=()
committed_indices=()
install_succeeded=false
timer_stopped=false
timer_restored=false
lock_open=false
drill_user_created=false
drill_group_created=false
journal_armed=false
rollback_abandoned=false

cleanup_install() {
  local rc=$? position index target stage backup rollback_failed=false
  trap - EXIT INT TERM
  set +e
  if [ "$install_succeeded" != true ] && [ "$rollback_abandoned" = false ]; then
    for ((position=${#committed_indices[@]} - 1; position >= 0; position -= 1)); do
      index="${committed_indices[$position]}"
      target="${targets[$index]}"
      backup="${backup_paths[$index]:-}"
      if [ "${had_targets[$index]}" = true ]; then
        if [ -n "$backup" ] && [ -f "$backup" ]; then
          if mv -fT -- "$backup" "$target" \
              && fsync_path "$(dirname -- "$target")"; then
            backup_paths[$index]=""
          else
            rollback_failed=true
            echo "application DR installer: failed to restore $target from $backup" >&2
          fi
        fi
      else
        if ! durable_remove "$target"; then
          rollback_failed=true
          echo "application DR installer: failed to remove newly installed target $target" >&2
        fi
      fi
    done
    if [ "${#committed_indices[@]}" -gt 0 ]; then
      if ! systemctl daemon-reload >/dev/null 2>&1; then
        rollback_failed=true
        echo "application DR installer: failed to reload systemd after rollback" >&2
      fi
    fi
  elif [ "$install_succeeded" != true ]; then
    rollback_failed=true
    echo "application DR installer: installation stopped after rollback backups began cleanup" >&2
  fi
  for stage in "${stage_paths[@]:-}"; do
    [ -n "$stage" ] && durable_remove "$stage"
  done
  for backup in "${backup_paths[@]:-}"; do
    if [ "$install_succeeded" = true ] && [ -n "$backup" ]; then
      durable_remove "$backup"
    fi
  done
  if [ "$install_succeeded" != true ] \
      && [ "$rollback_failed" = false ] \
      && [ "$journal_armed" = true ] \
      && [ "$preexisting_install_journal" = false ]; then
    if durable_remove "$DR_INSTALL_JOURNAL"; then
      journal_armed=false
    else
      rollback_failed=true
      echo "application DR installer: failed to clear the install journal after rollback" >&2
    fi
  fi
  if [ "$install_succeeded" != true ] \
      && [ "$preexisting_install_journal" = true ]; then
    rollback_failed=true
  fi
  if [ "$lock_open" = true ]; then
    exec 9>&-
  fi
  if [ "$install_succeeded" != true ]; then
    if [ "$drill_user_created" = true ]; then userdel "$EXPECTED_DRILL_USER" >/dev/null 2>&1; fi
    if [ "$drill_group_created" = true ]; then groupdel "$EXPECTED_DRILL_USER" >/dev/null 2>&1; fi
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
    if [ "$timer_active" = true ]; then
      systemctl stop "$DR_TIMER" >/dev/null 2>&1
      timer_restored=false
      echo "application DR installer: rollback incomplete; leaving $DR_TIMER stopped" >&2
    fi
    rc=1
  elif [ "$timer_active" = true ] && [ "$timer_restored" = false ]; then
    if ! systemctl start "$DR_TIMER" >/dev/null 2>&1; then
      echo "application DR installer: failed to restore active timer state for $DR_TIMER" >&2
      rc=1
    fi
  fi
  exit "$rc"
}
trap cleanup_install EXIT
trap 'exit 130' INT TERM

if [ "$timer_active" = true ]; then
  systemctl stop "$DR_TIMER"
  timer_stopped=true
fi
if systemctl is-active "$DR_SERVICE" >/dev/null 2>&1; then
  die "application DR backup service is active; retry after it completes"
fi

install -d -o root -g root -m 0755 \
  /usr/local/libexec \
  /usr/local/libexec/nexus-application-dr
install -d -o root -g root -m 0700 \
  /etc/nexus-application-dr \
  "$DR_STATE_DIR"
fsync_path /usr/local/libexec/nexus-application-dr
fsync_path /usr/local/libexec
fsync_path /etc/nexus-application-dr
fsync_path /etc
fsync_path "$DR_STATE_DIR"
fsync_path /var/lib
validate_root_owned_chain /usr/local/libexec/nexus-application-dr "install target"
validate_root_owned_chain /etc/nexus-application-dr "install target"
validate_root_owned_chain "$DR_STATE_DIR" "application DR state"

exec 9>"$DR_BACKUP_LOCK"
lock_open=true
chmod 0600 "$DR_BACKUP_LOCK"
flock -n 9 || die "another application DR backup or install is running"
write_install_journal
journal_armed=true

if [ "$drill_user_exists" = false ]; then
  if ! useradd \
    --system \
    --user-group \
    --home-dir /nonexistent \
    --no-create-home \
    --shell /usr/sbin/nologin \
    "$EXPECTED_DRILL_USER"; then
    if getent group "$EXPECTED_DRILL_USER" >/dev/null 2>&1; then
      groupdel "$EXPECTED_DRILL_USER" >/dev/null 2>&1
    fi
    die "failed to create drill account"
  fi
  drill_user_created=true
  drill_group_created=true
fi
supplementary_groups="$(id -nG "$EXPECTED_DRILL_USER")"
[ "$supplementary_groups" = "$EXPECTED_DRILL_USER" ] \
  || die "drill account must not belong to supplementary groups"

for ((index=0; index<planned; index+=1)); do
  target="${targets[$index]}"
  target_parent="$(dirname -- "$target")"
  stage="$(mktemp -p "$target_parent" ".nexus-application-dr.stage.XXXXXX")"
  install -o root -g root -m "${modes[$index]}" -- "${sources[$index]}" "$stage"
  fsync_path "$stage"
  stage_paths[$index]="$stage"
  backup_paths[$index]=""
done

commit_asset() {
  local index="$1" target target_parent backup
  target="${targets[$index]}"
  target_parent="$(dirname -- "$target")"
  committed_indices+=("$index")
  if [ "${had_targets[$index]}" = true ]; then
    backup="$(mktemp -p "$target_parent" ".nexus-application-dr.backup.XXXXXX")"
    rm -f -- "$backup"
    backup_paths[$index]="$backup"
    ln -- "$target" "$backup"
    fsync_path "$target_parent"
  fi
  mv -fT -- "${stage_paths[$index]}" "$target"
  fsync_path "$target_parent"
  stage_paths[$index]=""
}

# The guarded service is the first durable replacement. If the host reboots
# before the compatibility set is complete, systemd reloads this unit and
# refuses to run the timer while the install journal remains. Reverse-order
# rollback restores this service last, after every older helper is back.
commit_asset "$service_index"
for ((index=0; index<planned; index+=1)); do
  [ "$index" -eq "$service_index" ] && continue
  commit_asset "$index"
done

systemctl daemon-reload
timer_enabled_after=false
if systemctl is-enabled "$DR_TIMER" >/dev/null 2>&1; then
  timer_enabled_after=true
fi
[ "$timer_enabled_after" = "$timer_enabled" ] \
  || die "application DR timer enabled state changed during install"
if [ "$timer_active" = true ]; then
  systemctl start "$DR_TIMER"
  timer_restored=true
elif systemctl is-active "$DR_TIMER" >/dev/null 2>&1; then
  systemctl stop "$DR_TIMER"
fi

installed="$planned"
rollback_abandoned=true
for backup in "${backup_paths[@]:-}"; do
  [ -n "$backup" ] && durable_remove "$backup"
done
durable_remove "$DR_INSTALL_JOURNAL"
journal_armed=false
install_succeeded=true

printf '{"ok":true,"schema":"nexus.application-dr-install.v1","installedAssets":%d,"drillUser":"%s","timerEnabled":%s,"configurationWritten":false}\n' \
  "$installed" "$EXPECTED_DRILL_USER" "$timer_enabled"
