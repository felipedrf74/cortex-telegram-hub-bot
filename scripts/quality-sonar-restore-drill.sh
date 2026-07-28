#!/usr/bin/env bash
# Restore one local Sonar PostgreSQL dump into a disposable PostgreSQL volume.
set -euo pipefail
umask 077
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

CONFIG=/etc/nexus-sonarqube-backup.env
BACKUP=""
OUTPUT=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --config) CONFIG="${2:-}"; shift 2 ;;
    --backup) BACKUP="${2:-}"; shift 2 ;;
    --output) OUTPUT="${2:-}"; shift 2 ;;
    -h|--help)
      echo "Usage: quality-sonar-restore-drill.sh --backup ABSOLUTE.dump --output NEW.json [--config FILE]"
      exit 0
      ;;
    *) echo "quality-sonar-restore-drill: unknown argument: $1" >&2; exit 64 ;;
  esac
done
fail() { echo "quality-sonar-restore-drill: $*" >&2; exit 1; }
[ "$(id -u)" -eq 0 ] || fail "must run as root"
for path in "$CONFIG" "$BACKUP"; do
  [[ "$path" == /* && "$path" != / && -f "$path" && ! -L "$path" ]] \
    || fail "config and backup must be absolute non-symlink files"
done
[ "$(stat -c '%U:%G' "$CONFIG")" = root:root ] \
  && [ "$(stat -c '%a' "$CONFIG")" = 600 ] \
  || fail "config must be root-owned mode 0600"
[[ "$OUTPUT" == /* && "$OUTPUT" != / && ! -e "$OUTPUT" && ! -L "$OUTPUT" ]] \
  || fail "output must be a new absolute path"
[ -d "$(dirname "$OUTPUT")" ] && [ ! -L "$(dirname "$OUTPUT")" ] \
  || fail "output parent must already exist"

config_value() {
  local key="$1"
  awk -F= -v key="$key" '
    $0 !~ /^[[:space:]]*#/ && $1 == key {
      count += 1
      value = substr($0, index($0, "=") + 1)
    }
    END { if (count != 1 || value == "") exit 1; print value }
  ' "$CONFIG"
}
BACKUP_ROOT="$(config_value SONAR_BACKUP_ROOT)" || fail "SONAR_BACKUP_ROOT is required"
STACK_DIR="$(config_value SONAR_STACK_DIR)" || fail "SONAR_STACK_DIR is required"
COMPOSE_FILE="$(config_value SONAR_COMPOSE_FILE)" || fail "SONAR_COMPOSE_FILE is required"
SECRETS_FILE="$(config_value SONAR_SECRETS_FILE)" || fail "SONAR_SECRETS_FILE is required"
BACKUP_ROOT="$(realpath -e -- "$BACKUP_ROOT")"
[ "$(realpath -e -- "$BACKUP")" = "$BACKUP" ] \
  && [[ "$BACKUP" == "$BACKUP_ROOT/"* ]] \
  || fail "backup is outside the configured root"
[ -d "$STACK_DIR" ] && [ ! -L "$STACK_DIR" ] \
  && [ -f "$COMPOSE_FILE" ] && [ ! -L "$COMPOSE_FILE" ] \
  && [ -f "$SECRETS_FILE" ] && [ ! -L "$SECRETS_FILE" ] \
  || fail "Sonar Compose project is missing or unsafe"
[ -f "$BACKUP.sha256" ] && [ ! -L "$BACKUP.sha256" ] \
  || fail "backup checksum is missing"
(cd "$BACKUP_ROOT" && sha256sum --check "$(basename "$BACKUP").sha256") >/dev/null \
  || fail "backup checksum mismatch"

SHARED_MUTEX=/run/lock/nexus-release-sonar.lock
[ -f "$SHARED_MUTEX" ] && [ ! -L "$SHARED_MUTEX" ] \
  || fail "shared release/Sonar mutex is missing"
exec 8<>"$SHARED_MUTEX"
flock -n 8 || fail "a release, scan, or Sonar operation is active"

project="nexus-sonar-restore-$(date -u +%Y%m%d%H%M%S)-$$"
password="$(openssl rand -hex 24)"
compose=(
  docker compose
  --project-directory "$STACK_DIR"
  --env-file "$SECRETS_FILE"
  -f "$COMPOSE_FILE"
)
rendered="$(mktemp)"
trap 'rm -f -- "$rendered"' EXIT
"${compose[@]}" config --format json >"$rendered"
postgres_image="$(python3 - "$rendered" <<'PY'
import json
import sys
value = json.load(open(sys.argv[1], encoding="utf-8"))
image = value.get("services", {}).get("db", {}).get("image")
if not isinstance(image, str) or "@sha256:" not in image:
    raise SystemExit("live PostgreSQL service is not pinned by immutable digest")
print(image)
PY
)" || fail "unable to resolve the pinned live PostgreSQL image"
rm -f -- "$rendered"
trap - EXIT

cleanup() {
  docker rm --force --volumes "$project" >/dev/null 2>&1 || true
}
trap cleanup EXIT
docker run --detach --pull=never --name "$project" --network none \
  --env POSTGRES_DB=sonar_drill \
  --env POSTGRES_USER=sonar_drill \
  --env "POSTGRES_PASSWORD=$password" \
  "$postgres_image" >/dev/null
ready=false
for _attempt in $(seq 1 60); do
  if docker exec "$project" pg_isready --username=sonar_drill --dbname=sonar_drill \
      >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep 1
done
[ "$ready" = true ] || fail "disposable PostgreSQL did not become ready"
docker exec -i "$project" \
  pg_restore --no-owner --no-privileges --username=sonar_drill --dbname=sonar_drill \
  <"$BACKUP"
table_count="$(docker exec "$project" psql \
  --tuples-only --no-align --username=sonar_drill --dbname=sonar_drill \
  --command="SELECT count(*) FROM pg_catalog.pg_tables WHERE schemaname = 'public';" \
  | tr -d '[:space:]')"
[[ "$table_count" =~ ^[0-9]+$ ]] && [ "$table_count" -gt 0 ] \
  || fail "restored database has no public tables"

python3 - "$OUTPUT" "$BACKUP" "$table_count" <<'PY'
import hashlib
import json
import os
from pathlib import Path
import sys
from datetime import datetime, timezone

output, backup = Path(sys.argv[1]), Path(sys.argv[2])
value = {
    "schema": "nexus.sonarqube-local-restore.v1",
    "status": "passed",
    "backup": str(backup),
    "sha256": hashlib.sha256(backup.read_bytes()).hexdigest(),
    "publicTableCount": int(sys.argv[3]),
    "disposablePostgresContainer": True,
    "verifiedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
}
stage = output.with_name(f".{output.name}.{os.getpid()}.tmp")
stage.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")
stage.chmod(0o600)
os.link(stage, output)
stage.unlink()
print(json.dumps(value, sort_keys=True))
PY
