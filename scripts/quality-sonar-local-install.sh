#!/usr/bin/env bash
# Update the existing ServerDominguez Sonar Compose project in place and install
# only the local backup helpers. The stack is not restarted and timers remain
# disabled.
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
STACK_DIR="${2:-/home/dominguez/sonarqube}"
[ "$#" -ge 1 ] && [ "$#" -le 2 ] || {
  echo "Usage: sudo quality-sonar-local-install.sh <root-owned-source-root> [/home/dominguez/sonarqube]" >&2
  exit 64
}
[ "$(id -u)" -eq 0 ] || {
  echo "Sonar local installer must run as root" >&2
  exit 1
}
[[ "$SOURCE_ROOT" == /* && "$SOURCE_ROOT" != / && -d "$SOURCE_ROOT" && ! -L "$SOURCE_ROOT" ]] \
  || { echo "source root must be an absolute non-symlink directory" >&2; exit 1; }
[[ "$STACK_DIR" == /* && "$STACK_DIR" != / && -d "$STACK_DIR" && ! -L "$STACK_DIR" ]] \
  || { echo "existing Sonar stack directory is missing or unsafe" >&2; exit 1; }
validate_root_path_chain "$SOURCE_ROOT" "Sonar source root" || exit 1
SOURCE_ROOT="$(realpath -e -- "$SOURCE_ROOT")"
STACK_DIR="$(realpath -e -- "$STACK_DIR")"
LIVE_COMPOSE="$STACK_DIR/docker-compose.yml"
LIVE_ENV="$STACK_DIR/.env"
CANDIDATE="$SOURCE_ROOT/ops/sonarqube/compose.yaml"
for path in "$LIVE_COMPOSE" "$LIVE_ENV" "$CANDIDATE"; do
  [ -f "$path" ] && [ ! -L "$path" ] \
    || { echo "required Sonar file is missing or unsafe: $path" >&2; exit 1; }
done
validate_root_path_chain "$CANDIDATE" "Sonar Compose candidate" || exit 1

for source in \
  scripts/quality-sonar-backup.sh \
  scripts/quality-sonar-release-state.sh \
  scripts/quality-sonar-restore-drill.sh \
  scripts/quality-sonar-volume-identity.mjs \
  ops/sonarqube/backup.env.example \
  ops/sonarqube/nexus-release-sonar-lock.conf \
  ops/sonarqube/nexus-sonar-release-monitor.sudoers \
  ops/sonarqube/systemd/nexus-sonarqube-backup.service \
  ops/sonarqube/systemd/nexus-sonarqube-backup.timer; do
  [ -f "$SOURCE_ROOT/$source" ] && [ ! -L "$SOURCE_ROOT/$source" ] \
    || { echo "missing Sonar local asset: $source" >&2; exit 1; }
  validate_root_path_chain "$SOURCE_ROOT/$source" "Sonar local asset ($source)" \
    || exit 1
done
visudo -cf \
  "$SOURCE_ROOT/ops/sonarqube/nexus-sonar-release-monitor.sudoers" >/dev/null

current_services="$(
  docker compose --project-directory "$STACK_DIR" --env-file "$LIVE_ENV" \
    -f "$LIVE_COMPOSE" config --services | LC_ALL=C sort
)"
candidate_services="$(
  docker compose --project-directory "$STACK_DIR" --env-file "$LIVE_ENV" \
    -f "$CANDIDATE" config --services | LC_ALL=C sort
)"
[ "$current_services" = $'db\nsonarqube' ] \
  && [ "$candidate_services" = "$current_services" ] \
  || { echo "candidate must preserve the exact db/sonarqube services" >&2; exit 1; }
current_volumes="$(
  docker compose --project-directory "$STACK_DIR" --env-file "$LIVE_ENV" \
    -f "$LIVE_COMPOSE" config --volumes | LC_ALL=C sort
)"
candidate_volumes="$(
  docker compose --project-directory "$STACK_DIR" --env-file "$LIVE_ENV" \
    -f "$CANDIDATE" config --volumes | LC_ALL=C sort
)"
[ -n "$current_volumes" ] && [ "$candidate_volumes" = "$current_volumes" ] \
  || { echo "candidate must preserve the existing named volumes" >&2; exit 1; }

identity_tmp="$(mktemp -d)"
trap 'rm -rf -- "$identity_tmp"' EXIT
docker compose --project-directory "$STACK_DIR" --env-file "$LIVE_ENV" \
  -f "$LIVE_COMPOSE" config --format json >"$identity_tmp/current-config.json"
docker compose --project-directory "$STACK_DIR" --env-file "$LIVE_ENV" \
  -f "$CANDIDATE" config --format json >"$identity_tmp/candidate-config.json"
mapfile -t db_container_ids < <(
  docker compose --project-directory "$STACK_DIR" --env-file "$LIVE_ENV" \
    -f "$LIVE_COMPOSE" ps -q db
)
mapfile -t sonar_container_ids < <(
  docker compose --project-directory "$STACK_DIR" --env-file "$LIVE_ENV" \
    -f "$LIVE_COMPOSE" ps -q sonarqube
)
[ "${#db_container_ids[@]}" -eq 1 ] && [ -n "${db_container_ids[0]}" ] \
  || { echo "exactly one running Sonar database container is required" >&2; exit 1; }
[ "${#sonar_container_ids[@]}" -eq 1 ] && [ -n "${sonar_container_ids[0]}" ] \
  || { echo "exactly one running Sonar application container is required" >&2; exit 1; }
docker inspect --format '{{json .Mounts}}' "${db_container_ids[0]}" \
  >"$identity_tmp/db-mounts.json"
docker inspect --format '{{json .Mounts}}' "${sonar_container_ids[0]}" \
  >"$identity_tmp/sonarqube-mounts.json"
node "$SOURCE_ROOT/scripts/quality-sonar-volume-identity.mjs" \
  --current-config "$identity_tmp/current-config.json" \
  --candidate-config "$identity_tmp/candidate-config.json" \
  --db-mounts "$identity_tmp/db-mounts.json" \
  --sonarqube-mounts "$identity_tmp/sonarqube-mounts.json"
rm -rf -- "$identity_tmp"
trap - EXIT

install -d -o root -g root -m 0700 \
  /srv/nexus-backups/sonarqube \
  /srv/nexus-backups/sonarqube/restore-evidence
install -o root -g root -m 0755 \
  "$SOURCE_ROOT/scripts/quality-sonar-backup.sh" \
  /usr/local/sbin/quality-sonar-backup
install -o root -g root -m 0755 \
  "$SOURCE_ROOT/scripts/quality-sonar-restore-drill.sh" \
  /usr/local/sbin/quality-sonar-restore-drill
install -o root -g root -m 0755 \
  "$SOURCE_ROOT/scripts/quality-sonar-release-state.sh" \
  /usr/local/sbin/quality-sonar-release-state
install -o root -g root -m 0644 \
  "$SOURCE_ROOT/ops/sonarqube/nexus-release-sonar-lock.conf" \
  /etc/tmpfiles.d/nexus-release-sonar-lock.conf
install -o root -g root -m 0440 \
  "$SOURCE_ROOT/ops/sonarqube/nexus-sonar-release-monitor.sudoers" \
  /etc/sudoers.d/nexus-sonar-release-monitor
visudo -cf /etc/sudoers.d/nexus-sonar-release-monitor >/dev/null
[ "$(stat -c '%U:%G:%a' /usr/local/sbin/quality-sonar-release-state)" = root:root:755 ] \
  || { echo "installed Sonar release monitor is unsafe" >&2; exit 1; }
[ "$(stat -c '%U:%G:%a' /etc/sudoers.d/nexus-sonar-release-monitor)" = root:root:440 ] \
  || { echo "installed Sonar sudoers policy is unsafe" >&2; exit 1; }
systemd-tmpfiles --create /etc/tmpfiles.d/nexus-release-sonar-lock.conf
[ -f /run/lock/nexus-release-sonar.lock ] \
  && [ ! -L /run/lock/nexus-release-sonar.lock ] \
  && [ "$(stat -c '%U:%G:%a' /run/lock/nexus-release-sonar.lock)" = root:dominguez:660 ] \
  || { echo "shared release/Sonar lock was not installed safely" >&2; exit 1; }
for unit in nexus-sonarqube-backup.service nexus-sonarqube-backup.timer; do
  install -o root -g root -m 0644 \
    "$SOURCE_ROOT/ops/sonarqube/systemd/$unit" \
    "/etc/systemd/system/$unit"
done
if [ ! -e /etc/nexus-sonarqube-backup.env ] && [ ! -L /etc/nexus-sonarqube-backup.env ]; then
  install -o root -g root -m 0600 \
    "$SOURCE_ROOT/ops/sonarqube/backup.env.example" \
    /etc/nexus-sonarqube-backup.env
fi

predecessor="$STACK_DIR/docker-compose.yml.pre-lean"
if cmp -s "$LIVE_COMPOSE" "$CANDIDATE"; then
  # The stack may already have been normalized during the approved
  # maintenance window. Preserve its existing predecessor and install only
  # the missing local helper assets.
  [ ! -L "$predecessor" ] || {
    echo "existing pre-lean Compose backup is a symlink" >&2
    exit 1
  }
  [ ! -e "$predecessor" ] || {
    [ -f "$predecessor" ] && [ "$(stat -c '%U:%G:%a' "$predecessor")" = dominguez:dominguez:644 ] \
      || { echo "existing pre-lean Compose backup is unsafe" >&2; exit 1; }
  }
else
  [ ! -e "$predecessor" ] && [ ! -L "$predecessor" ] \
    || { echo "review and remove the existing pre-lean Compose backup first" >&2; exit 1; }
  install -o dominguez -g dominguez -m 0644 "$LIVE_COMPOSE" "$predecessor"
  stage="$(mktemp "$STACK_DIR/.docker-compose.XXXXXX")"
  trap 'rm -f -- "$stage"' EXIT
  install -o dominguez -g dominguez -m 0644 "$CANDIDATE" "$stage"
  mv "$stage" "$LIVE_COMPOSE"
  trap - EXIT
fi
systemctl daemon-reload
echo "Sonar assets installed in place; stack restart and timer enablement remain explicit"
