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

SOURCE_ROOT="${1:-}"
[ "$#" -eq 1 ] || {
  echo "Usage: sudo scripts/local-backup-systemd-install.sh <root-owned-source-root>" >&2
  exit 64
}
[ "$(id -u)" -eq 0 ] || {
  echo "local backup installer must run as root" >&2
  exit 1
}
[[ "$SOURCE_ROOT" == /* && "$SOURCE_ROOT" != / && -d "$SOURCE_ROOT" && ! -L "$SOURCE_ROOT" ]] \
  || { echo "source root must be an absolute non-symlink directory" >&2; exit 1; }
validate_root_path_chain "$SOURCE_ROOT" "local backup source root" || exit 1
SOURCE_ROOT="$(realpath -e -- "$SOURCE_ROOT")"

for source in \
  scripts/local-backup.py \
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

install -d -o root -g root -m 0700 \
  /etc/nexus-local-backup \
  /srv/nexus-backups \
  /srv/nexus-backups/application
install -D -o root -g root -m 0755 \
  "$SOURCE_ROOT/scripts/local-backup.py" \
  /usr/local/libexec/nexus-local-backup/local-backup.py
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
[ "$(stat -c '%U:%G:%a' /etc/sudoers.d/nexus-local-backup)" = root:root:440 ] \
  || { echo "installed local backup sudoers policy is unsafe" >&2; exit 1; }
systemctl daemon-reload
echo "local backup assets installed; configure backup.env and enable timers explicitly"
