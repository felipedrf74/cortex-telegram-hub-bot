#!/usr/bin/env bash
# Install the small same-host backup assets. Configuration and timer activation
# remain explicit owner operations.
set -euo pipefail
umask 077
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

validate_root_path_chain() {
  local path="$1" label="$2" current owner mode
  [[ "$path" == /* && "$path" != / && ! -L "$path" ]] \
    || { echo "$label must be an absolute non-symlink path" >&2; return 1; }
  [ "$(realpath -e -- "$path")" = "$path" ] \
    || { echo "$label must not traverse symlinks" >&2; return 1; }
  current="$path"
  while :; do
    owner="$(stat -c '%U:%G' -- "$current")"
    mode="$(stat -c '%a' -- "$current")"
    [ "$owner" = root:root ] \
      || { echo "$label path component is not root-owned: $current" >&2; return 1; }
    (( (8#$mode & 0022) == 0 )) \
      || { echo "$label path component is group/world writable: $current" >&2; return 1; }
    [ "$current" = / ] && break
    current="$(dirname -- "$current")"
  done
}

validate_optional_directory_chain() {
  local target="$1" label="$2" current="$1"
  while [ ! -e "$current" ] && [ ! -L "$current" ]; do
    [ "$current" != / ] || break
    current="$(dirname -- "$current")"
  done
  if [ -e "$current" ] || [ -L "$current" ]; then
    [ -d "$current" ] && [ ! -L "$current" ] \
      || { echo "$label exists with an unsafe type" >&2; return 1; }
    validate_root_path_chain "$current" "$label"
  else
    echo "$label has no trusted existing ancestor" >&2
    return 1
  fi
}

validate_optional_installed_file() {
  local target="$1" expected_mode="$2" expected_uid="${3:-0}" expected_gid="${4:-0}"
  local metadata
  if [ ! -e "$target" ] && [ ! -L "$target" ]; then
    return 0
  fi
  [ -f "$target" ] && [ ! -L "$target" ] \
    || { echo "installed local backup target has an unsafe type: $target" >&2; return 1; }
  metadata="$(stat -Lc '%u:%g:%a:%h' -- "$target")" \
    || { echo "installed local backup target metadata is unreadable: $target" >&2; return 1; }
  [ "$metadata" = "$expected_uid:$expected_gid:$expected_mode:1" ] \
    || { echo "installed local backup target metadata is unsafe: $target" >&2; return 1; }
}

path_chain_identity() {
  local target="$1" current
  current="$target"
  while :; do
    printf '%s|%s\n' "$current" "$(stat -Lc '%d:%i:%u:%g:%a' -- "$current")"
    [ "$current" = / ] && break
    current="$(dirname -- "$current")"
  done
}

destination_ancestor_identity() {
  local target
  for target in \
    /usr/local/libexec/nexus-local-backup \
    /etc/systemd/system \
    /etc/sudoers.d \
    /etc/nexus-local-backup \
    /srv/nexus-backups/application; do
    validate_root_path_chain "$target" "local backup destination ($target)" || return 1
    path_chain_identity "$target"
  done
}

destination_file_identity() {
  local target
  for target in \
    /usr/local/libexec/nexus-local-backup/local-backup.py \
    /usr/local/libexec/nexus-local-backup/local-backup-retry-launcher.sh \
    /etc/systemd/system/nexus-local-backup.service \
    /etc/systemd/system/nexus-local-backup.timer \
    /etc/systemd/system/nexus-local-backup-pre-promotion.service \
    /etc/systemd/system/nexus-local-backup-restore-verify.service \
    /etc/systemd/system/nexus-local-backup-restore-verify.timer \
    /etc/sudoers.d/nexus-local-backup; do
    validate_root_path_chain "$target" "installed local backup authority ($target)" \
      || return 1
    printf '%s|%s\n' "$target" "$(stat -Lc '%d:%i:%u:%g:%a:%h:%s' -- "$target")"
  done
}

durably_sync_installed_authority() {
  local target
  for target in \
    /usr/local/libexec/nexus-local-backup/local-backup.py \
    /usr/local/libexec/nexus-local-backup/local-backup-retry-launcher.sh \
    /etc/systemd/system/nexus-local-backup.service \
    /etc/systemd/system/nexus-local-backup.timer \
    /etc/systemd/system/nexus-local-backup-pre-promotion.service \
    /etc/systemd/system/nexus-local-backup-restore-verify.service \
    /etc/systemd/system/nexus-local-backup-restore-verify.timer \
    /etc/sudoers.d/nexus-local-backup; do
    validate_optional_installed_file "$target" \
      "$([[ "$target" == /usr/local/libexec/nexus-local-backup/* ]] \
        && printf 755 \
        || { [ "$target" = /etc/sudoers.d/nexus-local-backup ] \
          && printf 440 || printf 644; })" || return 1
    sync -f "$target" || return 1
  done
  for target in \
    /usr/local/libexec/nexus-local-backup \
    /usr/local/libexec \
    /usr/local \
    /etc/systemd/system \
    /etc/sudoers.d \
    /etc/nexus-local-backup \
    /srv/nexus-backups/application \
    /srv/nexus-backups \
    /srv; do
    validate_root_path_chain "$target" \
      "local backup durability directory ($target)" || return 1
    sync -f "$target" || return 1
  done
}

SOURCE_ROOT="${1:-}"
[ "$#" -eq 1 ] || {
  echo "Usage: sudo scripts/local-backup-systemd-install.sh <root-owned-source-root>" >&2
  exit 64
}
[ "$(id -u)" -eq 0 ] || {
  echo "local backup installer must run as root" >&2
  exit 1
}
[ -x /usr/bin/timeout ] && [ -x /usr/bin/sleep ] || {
  echo "local backup retry runtime is unavailable" >&2
  exit 1
}
[[ "$SOURCE_ROOT" == /* && "$SOURCE_ROOT" != / && -d "$SOURCE_ROOT" && ! -L "$SOURCE_ROOT" ]] \
  || { echo "source root must be an absolute non-symlink directory" >&2; exit 1; }
validate_root_path_chain "$SOURCE_ROOT" "local backup source root" || exit 1
SOURCE_ROOT="$(realpath -e -- "$SOURCE_ROOT")"

for source in \
  scripts/local-backup.py \
  scripts/local-backup-retry-launcher.sh \
  ops/local-backup/systemd/nexus-local-backup.service \
  ops/local-backup/systemd/nexus-local-backup.timer \
  ops/local-backup/systemd/nexus-local-backup-pre-promotion.service \
  ops/local-backup/systemd/nexus-local-backup-restore-verify.service \
  ops/local-backup/systemd/nexus-local-backup-restore-verify.timer \
  ops/local-backup/nexus-local-backup.sudoers; do
  [ -f "$SOURCE_ROOT/$source" ] && [ ! -L "$SOURCE_ROOT/$source" ] \
    || { echo "missing local backup asset: $source" >&2; exit 1; }
  validate_root_path_chain "$SOURCE_ROOT/$source" "local backup asset ($source)" \
    || exit 1
done
visudo -cf "$SOURCE_ROOT/ops/local-backup/nexus-local-backup.sudoers" >/dev/null

for destination in \
  /usr/local/libexec \
  /usr/local/libexec/nexus-local-backup \
  /etc/systemd/system \
  /etc/sudoers.d \
  /etc/nexus-local-backup \
  /srv/nexus-backups \
  /srv/nexus-backups/application; do
  validate_optional_directory_chain "$destination" \
    "local backup destination ($destination)" || exit 1
done
for destination_spec in \
  '/usr/local/libexec/nexus-local-backup/local-backup.py|755' \
  '/usr/local/libexec/nexus-local-backup/local-backup-retry-launcher.sh|755' \
  '/etc/systemd/system/nexus-local-backup.service|644' \
  '/etc/systemd/system/nexus-local-backup.timer|644' \
  '/etc/systemd/system/nexus-local-backup-pre-promotion.service|644' \
  '/etc/systemd/system/nexus-local-backup-restore-verify.service|644' \
  '/etc/systemd/system/nexus-local-backup-restore-verify.timer|644' \
  '/etc/sudoers.d/nexus-local-backup|440'; do
  IFS='|' read -r destination destination_mode <<<"$destination_spec"
  validate_optional_installed_file "$destination" "$destination_mode" || exit 1
done
unset destination destination_mode destination_spec
install -d -o root -g root -m 0700 \
  /etc/nexus-local-backup \
  /srv/nexus-backups \
  /srv/nexus-backups/application
install -d -o root -g root -m 0755 /usr/local/libexec/nexus-local-backup
DESTINATION_ANCESTORS_BEFORE="$(destination_ancestor_identity)" || exit 1

install -o root -g root -m 0755 \
  "$SOURCE_ROOT/scripts/local-backup.py" \
  /usr/local/libexec/nexus-local-backup/local-backup.py
install -o root -g root -m 0755 \
  "$SOURCE_ROOT/scripts/local-backup-retry-launcher.sh" \
  /usr/local/libexec/nexus-local-backup/local-backup-retry-launcher.sh
for unit in \
  nexus-local-backup.service \
  nexus-local-backup.timer \
  nexus-local-backup-pre-promotion.service \
  nexus-local-backup-restore-verify.service \
  nexus-local-backup-restore-verify.timer; do
  install -o root -g root -m 0644 \
    "$SOURCE_ROOT/ops/local-backup/systemd/$unit" \
    "/etc/systemd/system/$unit"
done
install -o root -g root -m 0440 \
  "$SOURCE_ROOT/ops/local-backup/nexus-local-backup.sudoers" \
  /etc/sudoers.d/nexus-local-backup
visudo -cf /etc/sudoers.d/nexus-local-backup >/dev/null
[ "$(stat -c '%U:%G:%a' /usr/local/libexec/nexus-local-backup/local-backup.py)" = root:root:755 ] \
  || { echo "installed local backup executable is unsafe" >&2; exit 1; }
[ "$(stat -c '%U:%G:%a' /usr/local/libexec/nexus-local-backup/local-backup-retry-launcher.sh)" = root:root:755 ] \
  || { echo "installed local backup retry launcher is unsafe" >&2; exit 1; }
[ "$(stat -c '%U:%G:%a' /etc/sudoers.d/nexus-local-backup)" = root:root:440 ] \
  || { echo "installed local backup sudoers policy is unsafe" >&2; exit 1; }
DESTINATION_FILES_BEFORE="$(destination_file_identity)" || exit 1
[ "$DESTINATION_ANCESTORS_BEFORE" = "$(destination_ancestor_identity)" ] \
  || { echo "local backup destination ancestors changed during installation" >&2; exit 1; }
cmp -s -- "$SOURCE_ROOT/scripts/local-backup.py" \
  /usr/local/libexec/nexus-local-backup/local-backup.py \
  || { echo "installed local backup producer differs from source" >&2; exit 1; }
cmp -s -- "$SOURCE_ROOT/scripts/local-backup-retry-launcher.sh" \
  /usr/local/libexec/nexus-local-backup/local-backup-retry-launcher.sh \
  || { echo "installed local backup retry launcher differs from source" >&2; exit 1; }
for unit in \
  nexus-local-backup.service \
  nexus-local-backup.timer \
  nexus-local-backup-pre-promotion.service \
  nexus-local-backup-restore-verify.service \
  nexus-local-backup-restore-verify.timer; do
  cmp -s -- "$SOURCE_ROOT/ops/local-backup/systemd/$unit" "/etc/systemd/system/$unit" \
    || { echo "installed local backup unit differs from source: $unit" >&2; exit 1; }
done
cmp -s -- "$SOURCE_ROOT/ops/local-backup/nexus-local-backup.sudoers" \
  /etc/sudoers.d/nexus-local-backup \
  || { echo "installed local backup sudoers differs from source" >&2; exit 1; }
[ "$DESTINATION_ANCESTORS_BEFORE" = "$(destination_ancestor_identity)" ] \
  || { echo "local backup destination ancestors changed during byte proof" >&2; exit 1; }
[ "$DESTINATION_FILES_BEFORE" = "$(destination_file_identity)" ] \
  || { echo "local backup destination files changed during byte proof" >&2; exit 1; }
durably_sync_installed_authority \
  || { echo "installed local backup authority could not be made durable" >&2; exit 1; }
[ "$DESTINATION_ANCESTORS_BEFORE" = "$(destination_ancestor_identity)" ] \
  || { echo "local backup destination ancestors changed during durability proof" >&2; exit 1; }
[ "$DESTINATION_FILES_BEFORE" = "$(destination_file_identity)" ] \
  || { echo "local backup destination files changed during durability proof" >&2; exit 1; }
systemctl daemon-reload
[ "$DESTINATION_ANCESTORS_BEFORE" = "$(destination_ancestor_identity)" ] \
  || { echo "local backup destination ancestors changed during systemd proof" >&2; exit 1; }
[ "$DESTINATION_FILES_BEFORE" = "$(destination_file_identity)" ] \
  || { echo "local backup destination files changed during systemd proof" >&2; exit 1; }
echo "local backup assets installed; configure backup.env and enable timers explicitly"
