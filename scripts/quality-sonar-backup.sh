#!/usr/bin/env bash
# Create a root-only local PostgreSQL custom-format dump and retain seven.
set -euo pipefail
umask 077
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

CONFIG=/etc/nexus-sonarqube-backup.env
ACTION=backup
MAX_AGE_HOURS=26
while [ "$#" -gt 0 ]; do
  case "$1" in
    --config) CONFIG="${2:-}"; shift 2 ;;
    --verify-config) ACTION=verify-config; shift ;;
    --verify-freshness) ACTION=verify-freshness; shift ;;
    --max-age-hours) MAX_AGE_HOURS="${2:-}"; shift 2 ;;
    -h|--help)
      echo "Usage: quality-sonar-backup.sh [--config FILE] [--verify-config|--verify-freshness [--max-age-hours 1-168]]"
      exit 0
      ;;
    *) echo "quality-sonar-backup: unknown argument: $1" >&2; exit 64 ;;
  esac
done

fail() { echo "quality-sonar-backup: $*" >&2; exit 1; }
[ "$(id -u)" -eq 0 ] || [ "${NEXUS_LOCAL_BACKUP_TEST_MODE:-0}" = 1 ] \
  || fail "must run as root"
[[ "$CONFIG" == /* && "$CONFIG" != / && -f "$CONFIG" && ! -L "$CONFIG" ]] \
  || fail "config must be an absolute non-symlink file"
if [ "${NEXUS_LOCAL_BACKUP_TEST_MODE:-0}" != 1 ]; then
  [ "$(stat -c '%U:%G' "$CONFIG")" = root:root ] \
    && [ "$(stat -c '%a' "$CONFIG")" = 600 ] \
    || fail "config must be root-owned mode 0600"
fi

config_value() {
  local key="$1"
  awk -F= -v key="$key" '
    $0 !~ /^[[:space:]]*#/ && $1 == key {
      count += 1
      value = substr($0, index($0, "=") + 1)
    }
    END {
      if (count != 1 || value == "") exit 1
      print value
    }
  ' "$CONFIG"
}

BACKUP_ROOT="$(config_value SONAR_BACKUP_ROOT)" || fail "SONAR_BACKUP_ROOT is required"
STACK_DIR="$(config_value SONAR_STACK_DIR)" || fail "SONAR_STACK_DIR is required"
COMPOSE_FILE="$(config_value SONAR_COMPOSE_FILE)" || fail "SONAR_COMPOSE_FILE is required"
SECRETS_FILE="$(config_value SONAR_SECRETS_FILE)" || fail "SONAR_SECRETS_FILE is required"
SUCCESS_RECEIPT="$(config_value SONAR_BACKUP_SUCCESS_RECEIPT)" \
  || fail "SONAR_BACKUP_SUCCESS_RECEIPT is required"
for value in "$BACKUP_ROOT" "$STACK_DIR" "$COMPOSE_FILE" "$SECRETS_FILE" "$SUCCESS_RECEIPT"; do
  [[ "$value" == /* && "$value" != / ]] || fail "configured paths must be absolute and non-root"
done
[[ "$MAX_AGE_HOURS" =~ ^[0-9]+$ ]] \
  && [ "$MAX_AGE_HOURS" -ge 1 ] && [ "$MAX_AGE_HOURS" -le 168 ] \
  || fail "max age must be between 1 and 168 hours"

if [ "$ACTION" = verify-config ]; then
  [ -d "$STACK_DIR" ] && [ ! -L "$STACK_DIR" ] || fail "Sonar stack directory is missing"
  [ -f "$COMPOSE_FILE" ] && [ ! -L "$COMPOSE_FILE" ] \
    || fail "Sonar Compose file is missing or unsafe"
  [ -f "$SECRETS_FILE" ] && [ ! -L "$SECRETS_FILE" ] \
    || fail "Sonar secrets file is missing or unsafe"
  command -v docker >/dev/null 2>&1 || fail "Docker is required"
  docker compose \
    --project-directory "$STACK_DIR" \
    --env-file "$SECRETS_FILE" \
    -f "$COMPOSE_FILE" \
    config --services | grep -Fx db >/dev/null \
    || fail "Sonar Compose project has no db service"
  printf '{"schema":"nexus.sonarqube-local-backup-config.v1","status":"passed"}\n'
  exit 0
fi

if [ "$ACTION" = verify-freshness ]; then
  python3 - "$SUCCESS_RECEIPT" "$MAX_AGE_HOURS" <<'PY'
import hashlib
import json
from pathlib import Path
import sys
from datetime import datetime, timezone

receipt_path = Path(sys.argv[1])
maximum = int(sys.argv[2])
if receipt_path.is_symlink() or not receipt_path.is_file():
    raise SystemExit("Sonar backup success receipt is missing")
value = json.loads(receipt_path.read_text(encoding="utf-8"))
if value.get("schema") != "nexus.sonarqube-local-backup.v1" or value.get("status") != "passed":
    raise SystemExit("Sonar backup success receipt is invalid")
completed = datetime.fromisoformat(value["completedAt"].replace("Z", "+00:00"))
age = (datetime.now(timezone.utc) - completed).total_seconds()
if age < 0 or age > maximum * 3600:
    raise SystemExit("Sonar backup success receipt is stale")
backup = Path(value["backup"])
if backup.is_symlink() or not backup.is_file():
    raise SystemExit("Sonar backup file is missing")
digest = hashlib.sha256(backup.read_bytes()).hexdigest()
if digest != value.get("sha256"):
    raise SystemExit("Sonar backup digest no longer matches its receipt")
print(json.dumps({
    "schema": "nexus.sonarqube-local-backup-freshness.v1",
    "status": "passed",
    "ageSeconds": int(age),
    "maxAgeHours": maximum,
}, sort_keys=True))
PY
  exit
fi

SHARED_MUTEX=/run/lock/nexus-release-sonar.lock
if [ "${NEXUS_LOCAL_BACKUP_TEST_MODE:-0}" = 1 ]; then
  SHARED_MUTEX="$BACKUP_ROOT/.release-sonar.lock"
  mkdir -p "$BACKUP_ROOT"
  : >"$SHARED_MUTEX"
fi
[ -f "$SHARED_MUTEX" ] && [ ! -L "$SHARED_MUTEX" ] \
  || fail "shared release/Sonar mutex is missing"
exec 8<>"$SHARED_MUTEX"
flock -n 8 || fail "a release, scan, or Sonar operation is active"

mkdir -p "$BACKUP_ROOT" "$(dirname "$SUCCESS_RECEIPT")"
chmod 0700 "$BACKUP_ROOT" "$(dirname "$SUCCESS_RECEIPT")"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
stage="$(mktemp "$BACKUP_ROOT/.nexus-sonarqube-${timestamp}.XXXXXX.dump")"
trap 'rm -f -- "$stage"' EXIT
target="$BACKUP_ROOT/nexus-sonarqube-${timestamp}.dump"
[ ! -e "$target" ] && [ ! -L "$target" ] || fail "backup target already exists"

compose=(
  docker compose
  --project-directory "$STACK_DIR"
  --env-file "$SECRETS_FILE"
  -f "$COMPOSE_FILE"
)
"${compose[@]}" exec -T db sh -eu -c \
  'exec pg_dump --format=custom --compress=6 --no-owner --no-privileges --username="$POSTGRES_USER" "$POSTGRES_DB"' \
  >"$stage"
[ -s "$stage" ] || fail "pg_dump produced an empty backup"
"${compose[@]}" exec -T db pg_restore --list <"$stage" >/dev/null
chmod 0600 "$stage"
mv "$stage" "$target"
trap - EXIT

sha256="$(sha256sum "$target" | awk '{print $1}')"
printf '%s  %s\n' "$sha256" "$(basename "$target")" >"$target.sha256"
chmod 0600 "$target.sha256"

mapfile -t backups < <(
  find "$BACKUP_ROOT" -maxdepth 1 -type f -name 'nexus-sonarqube-*.dump' -printf '%f\n' \
    | LC_ALL=C sort -r
)
for old in "${backups[@]:7}"; do
  rm -f -- "$BACKUP_ROOT/$old" "$BACKUP_ROOT/$old.sha256"
done

python3 - "$SUCCESS_RECEIPT" "$target" "$sha256" <<'PY'
import json
import os
from pathlib import Path
import sys
from datetime import datetime, timezone

receipt = Path(sys.argv[1])
backup = Path(sys.argv[2])
digest = sys.argv[3]
value = {
    "schema": "nexus.sonarqube-local-backup.v1",
    "status": "passed",
    "backup": str(backup),
    "sha256": digest,
    "sizeBytes": backup.stat().st_size,
    "completedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    "retainedCopies": 7,
}
temporary = receipt.with_name(f".{receipt.name}.{os.getpid()}.tmp")
temporary.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")
temporary.chmod(0o600)
os.replace(temporary, receipt)
print(json.dumps(value, sort_keys=True))
PY
