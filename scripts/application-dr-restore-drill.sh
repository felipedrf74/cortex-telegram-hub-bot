#!/usr/bin/env bash
# Restore one encrypted hourly database recovery point and one encrypted exact
# release bundle into a private scratch root, then require an operator-supplied
# isolated boot/smoke/stop harness. This command never writes to production.
set -euo pipefail
umask 077

PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
CONFIG=/etc/nexus-application-dr/backup.env
IDENTITY_FILE=""
DATABASE_KEY=""
RELEASE_KEY=""
OUTPUT=""

usage() {
  echo "Usage: application-dr-restore-drill.sh --database-key <hourly-key> --release-key <escrow-key> --identity-file <root-mode-0600-age-key> --output <state-dir/evidence/name.json> [--config <file>]"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --config) CONFIG="${2:?--config requires a path}"; shift 2 ;;
    --identity-file) IDENTITY_FILE="${2:?--identity-file requires a path}"; shift 2 ;;
    --database-key) DATABASE_KEY="${2:?--database-key requires a key}"; shift 2 ;;
    --release-key) RELEASE_KEY="${2:?--release-key requires a key}"; shift 2 ;;
    --output) OUTPUT="${2:?--output requires a path}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 64 ;;
  esac
done

die() { echo "application DR restore drill: $*" >&2; exit 1; }

private_root_file() {
  local path="$1" label="$2"
  [[ "$path" == /* && "$path" != / && -f "$path" && ! -L "$path" ]] \
    || die "$label must be an absolute non-symlink regular file"
  [ "$(realpath -e -- "$path")" = "$path" ] || die "$label must not traverse symlinks"
  [ "$(stat -c '%U:%G:%a' -- "$path")" = root:root:600 ] \
    || die "$label must be root:root mode 0600"
}

[ "$(id -u)" -eq 0 ] || die "must run as root on an isolated drill host"
command -v realpath >/dev/null 2>&1 || die "realpath is required"
private_root_file "$CONFIG" "configuration"
private_root_file "$IDENTITY_FILE" "age identity"

set -a
# shellcheck disable=SC1090
. "$CONFIG"
set +a
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

required=(
  NEXUS_DR_STATE_DIR
  NEXUS_DR_PYTHON_BIN
  NEXUS_DR_S3_ENDPOINT
  NEXUS_DR_S3_BUCKET
  NEXUS_DR_S3_PREFIX
  NEXUS_DR_RESTORE_HARNESS
  NEXUS_DR_DRILL_BASE_URL
)
for key in "${required[@]}"; do
  [ -n "${!key:-}" ] || die "configuration is missing $key"
done
[[ "$NEXUS_DR_S3_ENDPOINT" =~ ^https://[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:[0-9]{1,5})?/?$ ]] \
  && [[ "$NEXUS_DR_S3_ENDPOINT" != *@* ]] \
  || die "S3 endpoint must be a credential-free HTTPS origin"
if [[ "$NEXUS_DR_S3_ENDPOINT" =~ :([0-9]{1,5})/?$ ]]; then
  endpoint_port="${BASH_REMATCH[1]}"
  (( 10#$endpoint_port >= 1 && 10#$endpoint_port <= 65535 )) || die "invalid S3 endpoint port"
fi
[[ "$NEXUS_DR_S3_BUCKET" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{1,61}[A-Za-z0-9]$ ]] \
  || die "invalid S3 bucket"
[[ "$NEXUS_DR_S3_PREFIX" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]*[A-Za-z0-9]$ ]] \
  && [[ "$NEXUS_DR_S3_PREFIX" != *..* ]] \
  && [[ "$NEXUS_DR_S3_PREFIX" != *//* ]] \
  || die "invalid S3 prefix"
[[ "${AWS_REGION:-us-east-1}" =~ ^[a-z0-9-]+$ ]] || die "invalid AWS region"
[[ "$NEXUS_DR_DRILL_BASE_URL" =~ ^http://127\.0\.0\.1:([0-9]{4,5})$ ]] \
  || die "drill base URL must be an explicit high loopback HTTP port"
drill_port="${BASH_REMATCH[1]}"
(( drill_port >= 1024 && drill_port <= 65535 )) || die "invalid drill loopback port"

[[ "$NEXUS_DR_STATE_DIR" == /* && "$NEXUS_DR_STATE_DIR" != / \
   && -d "$NEXUS_DR_STATE_DIR" && ! -L "$NEXUS_DR_STATE_DIR" ]] \
  || die "state directory must be an absolute non-symlink directory"
[ "$(realpath -e -- "$NEXUS_DR_STATE_DIR")" = "$NEXUS_DR_STATE_DIR" ] \
  || die "state directory must not traverse symlinks"
[ "$(stat -c '%U:%G:%a' -- "$NEXUS_DR_STATE_DIR")" = root:root:700 ] \
  || die "state directory must be root:root mode 0700"
[[ "$NEXUS_DR_PYTHON_BIN" == /* && -x "$NEXUS_DR_PYTHON_BIN" && ! -L "$NEXUS_DR_PYTHON_BIN" ]] \
  || die "Python binary must be an absolute executable non-symlink file"
[ "$(realpath -e -- "$NEXUS_DR_PYTHON_BIN")" = "$NEXUS_DR_PYTHON_BIN" ] \
  || die "Python binary must not traverse symlinks"
[ "$(stat -c '%U' -- "$NEXUS_DR_PYTHON_BIN")" = root ] \
  || die "Python binary must be root-owned"
python_mode="$(stat -c '%a' -- "$NEXUS_DR_PYTHON_BIN")"
(( (8#$python_mode & 0022) == 0 )) || die "Python binary must not be group/world writable"
[[ "$NEXUS_DR_RESTORE_HARNESS" == /* && -f "$NEXUS_DR_RESTORE_HARNESS" \
   && ! -L "$NEXUS_DR_RESTORE_HARNESS" && -x "$NEXUS_DR_RESTORE_HARNESS" ]] \
  || die "restore harness must be an absolute executable non-symlink file"
[ "$(realpath -e -- "$NEXUS_DR_RESTORE_HARNESS")" = "$NEXUS_DR_RESTORE_HARNESS" ] \
  || die "restore harness must not traverse symlinks"
[ "$(stat -c '%U:%G:%a' -- "$NEXUS_DR_RESTORE_HARNESS")" = root:root:700 ] \
  || die "restore harness must be root:root mode 0700"

database_prefix="$NEXUS_DR_S3_PREFIX/database/hourly/"
release_prefix="$NEXUS_DR_S3_PREFIX/releases/"
database_suffix="${DATABASE_KEY#"$database_prefix"}"
release_suffix="${RELEASE_KEY#"$release_prefix"}"
[ "$DATABASE_KEY" = "$database_prefix$database_suffix" ] \
  && [[ "$database_suffix" =~ ^nexus-db-[0-9]{8}T[0-9]{6}Z\.sqlite\.age$ ]] \
  || die "database key is outside the governed hourly namespace"
[ "$RELEASE_KEY" = "$release_prefix$release_suffix" ] \
  && [[ "$release_suffix" =~ ^v[A-Za-z0-9._+-]+\.tar\.gz\.[0-9a-f]{64}\.age$ ]] \
  || die "release key is outside the governed escrow namespace"

install -d -o root -g root -m 0700 "$NEXUS_DR_STATE_DIR/evidence" "$NEXUS_DR_STATE_DIR/tmp"
[[ "$OUTPUT" == "$NEXUS_DR_STATE_DIR/evidence/"*.json && "$OUTPUT" != *..* && ! -L "$OUTPUT" ]] \
  || die "output must be a non-symlink JSON path below the private evidence directory"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SQLITE_HELPER="$SCRIPT_DIR/application-dr-sqlite.py"
ARCHIVE_HELPER="$SCRIPT_DIR/application-dr-archive.py"
for helper in "$SQLITE_HELPER" "$ARCHIVE_HELPER"; do
  [[ -f "$helper" && ! -L "$helper" ]] || die "installed helper is missing: $helper"
  [ "$(stat -c '%U:%G:%a' -- "$helper")" = root:root:644 ] \
    || die "installed helper must be root:root mode 0644: $helper"
done
for command in age aws flock sha256sum ss timeout; do
  command -v "$command" >/dev/null 2>&1 || die "$command is required"
done
if ss -ltnH "sport = :$drill_port" | grep -q .; then
  die "isolated drill port is already in use"
fi

exec 9>"$NEXUS_DR_STATE_DIR/restore-drill.lock"
chmod 0600 "$NEXUS_DR_STATE_DIR/restore-drill.lock"
flock -n 9 || die "another application DR restore drill is already running"

tmp_dir="$(mktemp -d "$NEXUS_DR_STATE_DIR/tmp/restore-drill.XXXXXX")"
runtime="$tmp_dir/runtime"
mkdir -m 0700 "$runtime"
booted=false
cleanup() {
  status=$?
  if [ "$booted" = true ]; then
    NEXUS_DRILL_MODE=isolated-restore \
    NEXUS_DRILL_ROOT="$runtime" \
    NEXUS_DRILL_DATABASE_PATH="$runtime/data/bot.db" \
    NEXUS_DRILL_BASE_URL="$NEXUS_DR_DRILL_BASE_URL" \
      timeout --signal=TERM --kill-after=15 60 "$NEXUS_DR_RESTORE_HARNESS" stop "$runtime" >/dev/null 2>&1 || true
  fi
  rm -rf -- "$tmp_dir"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
chmod 0700 "$tmp_dir"

aws_s3api() {
  aws --endpoint-url "$NEXUS_DR_S3_ENDPOINT" --region "${AWS_REGION:-us-east-1}" s3api "$@"
}
sha256_file() { sha256sum -- "$1" | awk '{print $1}'; }

started_epoch="$(date -u +%s)"
database_head="$tmp_dir/database-head.json"
release_head="$tmp_dir/release-head.json"
aws_s3api head-object --bucket "$NEXUS_DR_S3_BUCKET" --key "$DATABASE_KEY" >"$database_head"
aws_s3api head-object --bucket "$NEXUS_DR_S3_BUCKET" --key "$RELEASE_KEY" >"$release_head"

metadata_env="$tmp_dir/metadata.env"
"$NEXUS_DR_PYTHON_BIN" - "$database_head" "$release_head" "$started_epoch" "$metadata_env" <<'PY'
import json
import re
import shlex
import sys

database_path, release_path, now_raw, output = sys.argv[1:]
now = int(now_raw)

def metadata(path):
    value = json.load(open(path, encoding="utf-8"))
    if int(value.get("ContentLength", 0)) <= 0:
        raise SystemExit("encrypted DR object is empty")
    return {str(key).lower(): str(item) for key, item in value.get("Metadata", {}).items()}

database = metadata(database_path)
release = metadata(release_path)
if database.get("schema-version") != "NexusApplicationSqliteRecoveryPointV1":
    raise SystemExit("database recovery-point schema is invalid")
if release.get("schema-version") != "NexusReleaseRollbackEscrowV1":
    raise SystemExit("release escrow schema is invalid")
for label, values in (("database", database), ("release", release)):
    for key in ("encrypted-sha256", "plaintext-sha256"):
        if not re.fullmatch(r"[0-9a-f]{64}", values.get(key, "")):
            raise SystemExit(f"{label} {key} is invalid")
created = database.get("created-epoch", "")
if not re.fullmatch(r"[0-9]+", created):
    raise SystemExit("database created-epoch is invalid")
age = now - int(created)
if age < 0 or age > 3600:
    raise SystemExit(f"RPO breach: selected database recovery point is {age} seconds old")
original = release.get("original-name", "")
if not re.fullmatch(r"v[A-Za-z0-9._+-]+\.tar\.gz", original):
    raise SystemExit("release escrow original filename is invalid")
values = {
    "DATABASE_ENCRYPTED_SHA256": database["encrypted-sha256"],
    "DATABASE_PLAINTEXT_SHA256": database["plaintext-sha256"],
    "DATABASE_CREATED_EPOCH": created,
    "DATABASE_AGE_SECONDS": str(age),
    "RELEASE_ENCRYPTED_SHA256": release["encrypted-sha256"],
    "RELEASE_PLAINTEXT_SHA256": release["plaintext-sha256"],
    "RELEASE_ORIGINAL_NAME": original,
}
with open(output, "w", encoding="utf-8") as target:
    for key, value in values.items():
        target.write(f"{key}={shlex.quote(value)}\n")
PY
chmod 0600 "$metadata_env"
# shellcheck disable=SC1090
. "$metadata_env"

database_encrypted="$tmp_dir/database.sqlite.age"
release_encrypted="$tmp_dir/release.tar.gz.age"
aws_s3api get-object --bucket "$NEXUS_DR_S3_BUCKET" --key "$DATABASE_KEY" "$database_encrypted" >/dev/null
aws_s3api get-object --bucket "$NEXUS_DR_S3_BUCKET" --key "$RELEASE_KEY" "$release_encrypted" >/dev/null
[ "$(sha256_file "$database_encrypted")" = "$DATABASE_ENCRYPTED_SHA256" ] \
  || die "encrypted database checksum mismatch"
[ "$(sha256_file "$release_encrypted")" = "$RELEASE_ENCRYPTED_SHA256" ] \
  || die "encrypted release checksum mismatch"

database_plain="$tmp_dir/database.sqlite"
release_plain="$tmp_dir/release.tar.gz"
age --decrypt --identity "$IDENTITY_FILE" --output "$database_plain" "$database_encrypted"
age --decrypt --identity "$IDENTITY_FILE" --output "$release_plain" "$release_encrypted"
chmod 0600 "$database_plain" "$release_plain"
rm -f -- "$database_encrypted" "$release_encrypted"
[ "$(sha256_file "$database_plain")" = "$DATABASE_PLAINTEXT_SHA256" ] \
  || die "decrypted database checksum mismatch"
[ "$(sha256_file "$release_plain")" = "$RELEASE_PLAINTEXT_SHA256" ] \
  || die "decrypted release checksum mismatch"
"$NEXUS_DR_PYTHON_BIN" "$SQLITE_HELPER" verify "$database_plain" >"$tmp_dir/database-verify.json"
"$NEXUS_DR_PYTHON_BIN" "$ARCHIVE_HELPER" "$release_plain" "$runtime" >"$tmp_dir/release-verify.json"
"$NEXUS_DR_PYTHON_BIN" "$SQLITE_HELPER" compatibility \
  "$database_plain" "$runtime/migrations" >"$tmp_dir/release-database-compatibility.json"
rm -f -- "$release_plain"
install -m 0600 -- "$database_plain" "$runtime/data/bot.db.next"
mv -f -- "$runtime/data/bot.db.next" "$runtime/data/bot.db"
rm -f -- "$database_plain"
unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN AWS_SECURITY_TOKEN
unset AWS_PROFILE AWS_DEFAULT_PROFILE AWS_SHARED_CREDENTIALS_FILE AWS_CONFIG_FILE
unset AWS_WEB_IDENTITY_TOKEN_FILE AWS_ROLE_ARN AWS_ROLE_SESSION_NAME
unset AWS_CONTAINER_CREDENTIALS_FULL_URI AWS_CONTAINER_CREDENTIALS_RELATIVE_URI

remaining_seconds() {
  local elapsed
  elapsed=$(( $(date -u +%s) - started_epoch ))
  (( elapsed < 1800 )) || die "RTO breach before isolated $1"
  echo $((1800 - elapsed))
}

run_harness() {
  local action="$1" remaining
  remaining="$(remaining_seconds "$action")"
  NEXUS_DRILL_MODE=isolated-restore \
  NEXUS_DRILL_ROOT="$runtime" \
  NEXUS_DRILL_DATABASE_PATH="$runtime/data/bot.db" \
  NEXUS_DRILL_BASE_URL="$NEXUS_DR_DRILL_BASE_URL" \
    timeout --signal=TERM --kill-after=15 "$remaining" "$NEXUS_DR_RESTORE_HARNESS" "$action" "$runtime"
}

run_harness boot
booted=true
run_harness smoke
completed_epoch="$(date -u +%s)"
rto_seconds=$((completed_epoch - started_epoch))
(( rto_seconds <= 1800 )) || die "RTO breach: isolated restore took $rto_seconds seconds"

"$NEXUS_DR_PYTHON_BIN" - "$OUTPUT" "$DATABASE_KEY" "$RELEASE_KEY" \
  "$DATABASE_PLAINTEXT_SHA256" "$RELEASE_PLAINTEXT_SHA256" "$DATABASE_AGE_SECONDS" "$rto_seconds" \
  "$tmp_dir/release-database-compatibility.json" <<'PY'
import json
import os
import sys
from datetime import datetime, timezone

output, database_key, release_key, database_sha, release_sha, rpo, rto, compatibility_path = sys.argv[1:]
with open(compatibility_path, encoding="utf-8") as source:
    compatibility = json.load(source)
if compatibility.get("schemaVersion") != "NexusApplicationRestoreCompatibilityV1" \
        or compatibility.get("status") != "passed":
    raise SystemExit("release/database compatibility evidence is invalid")
evidence = {
    "schemaVersion": "NexusApplicationRestoreDrillV1",
    "databaseKey": database_key,
    "releaseKey": release_key,
    "databaseSha256": database_sha,
    "releaseSha256": release_sha,
    "sqliteIntegrityVerified": True,
    "exactReleaseBundleVerified": True,
    "releaseDatabaseCompatibility": compatibility,
    "isolatedBootVerified": True,
    "applicationSmokeHarnessVerified": True,
    "rpoSeconds": int(rpo),
    "rpoTargetSeconds": 3600,
    "rtoSeconds": int(rto),
    "rtoTargetSeconds": 1800,
    "completedAt": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
}
temporary = f"{output}.next"
with open(temporary, "x", encoding="utf-8") as target:
    json.dump(evidence, target, indent=2)
    target.write("\n")
os.chmod(temporary, 0o600)
os.replace(temporary, output)
PY
chmod 0600 "$OUTPUT"
run_harness stop
booted=false
echo "application_dr_restore_drill_ok rpoSeconds=$DATABASE_AGE_SECONDS rtoSeconds=$rto_seconds evidence=$OUTPUT"
