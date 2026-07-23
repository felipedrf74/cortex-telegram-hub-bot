#!/usr/bin/env bash
# Restore one encrypted hourly database recovery point and one encrypted signed
# current recovery runtime into a private scratch root, then require an
# operator-supplied isolated boot/smoke/stop harness. This command never writes
# to production.
set -euo pipefail
umask 077

PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
CONFIG=/etc/nexus-application-dr/backup.env
IDENTITY_FILE=""
DATABASE_KEY=""
RELEASE_KEY=""
DATABASE_VERSION_ID=""
RELEASE_VERSION_ID=""
OUTPUT=""

usage() {
  echo "Usage: application-dr-restore-drill.sh --database-key <hourly-key> --release-key <signed-current-recovery-runtime-key> --identity-file <root-mode-0600-age-key> --output <state-dir/evidence/name.json> [--database-version-id <exact-aws-version>] [--release-version-id <exact-aws-version>] [--config <file>]"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --config) CONFIG="${2:?--config requires a path}"; shift 2 ;;
    --identity-file) IDENTITY_FILE="${2:?--identity-file requires a path}"; shift 2 ;;
    --database-key) DATABASE_KEY="${2:?--database-key requires a key}"; shift 2 ;;
    --release-key) RELEASE_KEY="${2:?--release-key requires a key}"; shift 2 ;;
    --database-version-id) DATABASE_VERSION_ID="${2:?--database-version-id requires an ID}"; shift 2 ;;
    --release-version-id) RELEASE_VERSION_ID="${2:?--release-version-id requires an ID}"; shift 2 ;;
    --output) OUTPUT="${2:?--output requires a path}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 64 ;;
  esac
done

die() { echo "application DR restore drill: $*" >&2; exit 1; }

trusted_root_path_chain() {
  local path="$1" label="$2" current owner mode
  [[ "$path" == /* && "$path" != / ]] || die "$label path is invalid"
  current="$(realpath -e -- "$path")"
  while [ "$current" != / ]; do
    owner="$(stat -c '%u' -- "$current")"
    mode="$(stat -c '%a' -- "$current")"
    [ "$owner" = 0 ] || die "$label path component is not root-owned: $current"
    (( (8#$mode & 0022) == 0 )) \
      || die "$label path component is group/world writable: $current"
    current="$(dirname -- "$current")"
  done
}

private_root_file() {
  local path="$1" label="$2"
  [[ "$path" == /* && "$path" != / && -f "$path" && ! -L "$path" ]] \
    || die "$label must be an absolute non-symlink regular file"
  [ "$(realpath -e -- "$path")" = "$path" ] || die "$label must not traverse symlinks"
  trusted_root_path_chain "$path" "$label"
  [ "$(stat -c '%U:%G:%a' -- "$path")" = root:root:600 ] \
    || die "$label must be root:root mode 0600"
}

trusted_root_executable() {
  local path="$1" label="$2" resolved mode
  [[ "$path" == /* && "$path" != / && -x "$path" ]] \
    || die "$label must be an absolute executable"
  resolved="$(realpath -e -- "$path")"
  [ -f "$resolved" ] || die "$label must resolve to a regular file"
  trusted_root_path_chain "$resolved" "$label"
  [ "$(stat -c '%U' -- "$resolved")" = root ] \
    || die "$label must resolve to a root-owned file"
  mode="$(stat -c '%a' -- "$resolved")"
  (( (8#$mode & 0022) == 0 )) || die "$label must not be group/world writable"
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
  NEXUS_DR_RELEASE_PUBLIC_KEY
  NEXUS_DR_S3_ENDPOINT
  NEXUS_DR_S3_BUCKET
  NEXUS_DR_S3_PREFIX
  NEXUS_DR_STORAGE_PROVIDER
  NEXUS_DR_STORAGE_CONTROL_MODE
  NEXUS_DR_RESTORE_HARNESS
  NEXUS_DR_DRILL_BASE_URL
  NEXUS_DR_DRILL_USER
  NEXUS_DR_DRILL_NODE_BIN
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
case "$NEXUS_DR_STORAGE_PROVIDER:$NEXUS_DR_STORAGE_CONTROL_MODE" in
  aws-s3:versioned-s3|cloudflare-r2:r2-approved-variance) ;;
  *) die "storage provider/control mode is not an approved pair" ;;
esac
if [ "$NEXUS_DR_STORAGE_PROVIDER" = aws-s3 ]; then
  [[ "$DATABASE_VERSION_ID" =~ ^[A-Za-z0-9._~+=:/-]{1,1024}$ \
      && "$RELEASE_VERSION_ID" =~ ^[A-Za-z0-9._~+=:/-]{1,1024}$ ]] \
    || die "versioned S3 restore requires exact database and release VersionIds"
else
  [ -z "$DATABASE_VERSION_ID" ] && [ -z "$RELEASE_VERSION_ID" ] \
    || die "the approved R2 variance does not accept S3 VersionIds"
fi
[[ "$NEXUS_DR_DRILL_USER" =~ ^[a-z_][a-z0-9_-]*$ ]] \
  || die "invalid dedicated drill user"
IFS=: read -r drill_account _ drill_uid drill_gid _ _ drill_shell \
  < <(getent passwd "$NEXUS_DR_DRILL_USER")
[[ "$drill_account" = "$NEXUS_DR_DRILL_USER" && "$drill_uid" =~ ^[0-9]+$ \
   && "$drill_gid" =~ ^[0-9]+$ && "$drill_uid" -gt 0 ]] \
  || die "dedicated drill user does not exist or is privileged"
case "$drill_shell" in
  /usr/sbin/nologin|/sbin/nologin|/bin/false) ;;
  *) die "dedicated drill user must have a disabled login shell" ;;
esac
trusted_root_executable "$NEXUS_DR_DRILL_NODE_BIN" "drill Node binary"
[[ "$NEXUS_DR_DRILL_BASE_URL" =~ ^http://127\.0\.0\.1:([0-9]{4,5})$ ]] \
  || die "drill base URL must be an explicit high loopback HTTP port"
drill_port="${BASH_REMATCH[1]}"
(( drill_port >= 1024 && drill_port <= 65535 )) || die "invalid drill loopback port"

[[ "$NEXUS_DR_STATE_DIR" == /* && "$NEXUS_DR_STATE_DIR" != / \
   && -d "$NEXUS_DR_STATE_DIR" && ! -L "$NEXUS_DR_STATE_DIR" ]] \
  || die "state directory must be an absolute non-symlink directory"
[ "$(realpath -e -- "$NEXUS_DR_STATE_DIR")" = "$NEXUS_DR_STATE_DIR" ] \
  || die "state directory must not traverse symlinks"
trusted_root_path_chain "$NEXUS_DR_STATE_DIR" "state directory"
[ "$(stat -c '%U:%G:%a' -- "$NEXUS_DR_STATE_DIR")" = root:root:700 ] \
  || die "state directory must be root:root mode 0700"
[[ "$NEXUS_DR_PYTHON_BIN" == /* && -x "$NEXUS_DR_PYTHON_BIN" && ! -L "$NEXUS_DR_PYTHON_BIN" ]] \
  || die "Python binary must be an absolute executable non-symlink file"
[ "$(realpath -e -- "$NEXUS_DR_PYTHON_BIN")" = "$NEXUS_DR_PYTHON_BIN" ] \
  || die "Python binary must not traverse symlinks"
trusted_root_path_chain "$NEXUS_DR_PYTHON_BIN" "Python binary"
[ "$(stat -c '%U' -- "$NEXUS_DR_PYTHON_BIN")" = root ] \
  || die "Python binary must be root-owned"
python_mode="$(stat -c '%a' -- "$NEXUS_DR_PYTHON_BIN")"
(( (8#$python_mode & 0022) == 0 )) || die "Python binary must not be group/world writable"
[[ "$NEXUS_DR_RELEASE_PUBLIC_KEY" == /* && -f "$NEXUS_DR_RELEASE_PUBLIC_KEY" \
   && ! -L "$NEXUS_DR_RELEASE_PUBLIC_KEY" ]] \
  || die "release evidence public key must be an absolute non-symlink file"
[ "$(realpath -e -- "$NEXUS_DR_RELEASE_PUBLIC_KEY")" = "$NEXUS_DR_RELEASE_PUBLIC_KEY" ] \
  || die "release evidence public key must not traverse symlinks"
trusted_root_path_chain "$NEXUS_DR_RELEASE_PUBLIC_KEY" "release evidence public key"
[ "$(stat -c '%U:%G:%a' -- "$NEXUS_DR_RELEASE_PUBLIC_KEY")" = root:root:644 ] \
  || die "release evidence public key must be root:root mode 0644"
[[ "$NEXUS_DR_RESTORE_HARNESS" == /* && -f "$NEXUS_DR_RESTORE_HARNESS" \
   && ! -L "$NEXUS_DR_RESTORE_HARNESS" && -x "$NEXUS_DR_RESTORE_HARNESS" ]] \
  || die "restore harness must be an absolute executable non-symlink file"
[ "$(realpath -e -- "$NEXUS_DR_RESTORE_HARNESS")" = "$NEXUS_DR_RESTORE_HARNESS" ] \
  || die "restore harness must not traverse symlinks"
trusted_root_path_chain "$NEXUS_DR_RESTORE_HARNESS" "restore harness"
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
  && [[ "$release_suffix" =~ ^v[A-Za-z0-9._+-]+\+current-[0-9a-f]{40}\+escrow-[0-9]{8}T[0-9]{6}Z-[0-9]+-[0-9a-f]{12}\.tar\.gz\.[0-9a-f]{64}\.age$ ]] \
  || die "release key is outside the governed escrow namespace"

install -d -o root -g root -m 0700 "$NEXUS_DR_STATE_DIR/evidence" "$NEXUS_DR_STATE_DIR/tmp"
[[ "$OUTPUT" == "$NEXUS_DR_STATE_DIR/evidence/"*.json && "$OUTPUT" != *..* \
   && ! -e "$OUTPUT" && ! -L "$OUTPUT" && ! -e "$OUTPUT.next" ]] \
  || die "output must be a new JSON path below the private evidence directory"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SQLITE_HELPER="$SCRIPT_DIR/application-dr-sqlite.py"
MIGRATION_LINEAGE_POLICY="$SCRIPT_DIR/production-migration-lineages.json"
RECOVERY_ARCHIVE_HELPER="$SCRIPT_DIR/application-dr-recovery-archive.py"
RECOVERY_RUNTIME_HELPER="$SCRIPT_DIR/application-dr-recovery-runtime.mjs"
RECOVERY_IDENTITY_HELPER="$SCRIPT_DIR/release-recovery-runtime-identity.mjs"
RUNTIME_DEPENDENCY_HELPER="$SCRIPT_DIR/release-runtime-dependencies.mjs"
for helper in "$SQLITE_HELPER" "$MIGRATION_LINEAGE_POLICY" "$RECOVERY_ARCHIVE_HELPER" \
  "$RECOVERY_RUNTIME_HELPER" "$RECOVERY_IDENTITY_HELPER"; do
  [[ -f "$helper" && ! -L "$helper" ]] || die "installed helper is missing: $helper"
  [ "$(realpath -e -- "$helper")" = "$helper" ] \
    || die "installed helper must not traverse symlinks: $helper"
  trusted_root_path_chain "$helper" "installed helper"
  [ "$(stat -c '%U:%G:%a' -- "$helper")" = root:root:644 ] \
    || die "installed helper must be root:root mode 0644: $helper"
done
[[ -f "$RUNTIME_DEPENDENCY_HELPER" && ! -L "$RUNTIME_DEPENDENCY_HELPER" ]] \
  || die "installed runtime dependency helper is missing"
[ "$(realpath -e -- "$RUNTIME_DEPENDENCY_HELPER")" = "$RUNTIME_DEPENDENCY_HELPER" ] \
  || die "installed runtime dependency helper must not traverse symlinks"
trusted_root_path_chain "$RUNTIME_DEPENDENCY_HELPER" "installed runtime dependency helper"
[ "$(stat -c '%U:%G:%a' -- "$RUNTIME_DEPENDENCY_HELPER")" = root:root:644 ] \
  || die "installed runtime dependency helper must be root:root mode 0644"
for command in age aws curl flock getent ip mount nsenter od setsid setpriv sha256sum ss timeout unshare; do
  command -v "$command" >/dev/null 2>&1 || die "$command is required"
done
drill_bash="$(command -v bash)"
trusted_root_executable "$drill_bash" "drill isolation shell"
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
preflight_state=""
preflight_mount=""
cleanup() {
  status=$?
  preserve_runtime=false
  if [ "$booted" = true ]; then
    if ! NEXUS_DRILL_MODE=isolated-restore \
      NEXUS_DRILL_ROOT="$runtime" \
      NEXUS_DRILL_DATABASE_PATH="$runtime/data/bot.db" \
      NEXUS_DRILL_BASE_URL="$NEXUS_DR_DRILL_BASE_URL" \
      NEXUS_DRILL_STATE_DIR="$NEXUS_DR_STATE_DIR" \
      NEXUS_DRILL_USER="$NEXUS_DR_DRILL_USER" \
      NEXUS_DRILL_NODE_BIN="$NEXUS_DR_DRILL_NODE_BIN" \
      NEXUS_DRILL_PYTHON_BIN="$NEXUS_DR_PYTHON_BIN" \
        timeout --signal=TERM --kill-after=15 60 \
          "$NEXUS_DR_RESTORE_HARNESS" stop "$runtime" >/dev/null 2>&1; then
      preserve_runtime=true
      status=1
      echo "application DR restore drill: isolated process cleanup failed; preserved manual-cleanup target $tmp_dir" >&2
    fi
  fi
  if [[ -n "$preflight_state" && "$preflight_state" == /run/nexus-application-drill/preflight-state-* ]]; then
    rm -rf -- "$preflight_state"
  fi
  if [[ -n "$preflight_mount" && "$preflight_mount" == /mnt/nexus-application-drill-preflight-* ]]; then
    rm -rf -- "$preflight_mount"
  fi
  if [ "$preserve_runtime" = false ]; then
    rm -rf -- "$tmp_dir"
  fi
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

database_head="$tmp_dir/database-head.json"
release_head="$tmp_dir/release-head.json"
database_head_args=(--bucket "$NEXUS_DR_S3_BUCKET" --key "$DATABASE_KEY")
release_head_args=(--bucket "$NEXUS_DR_S3_BUCKET" --key "$RELEASE_KEY")
if [ "$NEXUS_DR_STORAGE_PROVIDER" = aws-s3 ]; then
  database_head_args+=(--version-id "$DATABASE_VERSION_ID")
  release_head_args+=(--version-id "$RELEASE_VERSION_ID")
fi
aws_s3api head-object "${database_head_args[@]}" >"$database_head"
aws_s3api head-object "${release_head_args[@]}" >"$release_head"
metadata_now_epoch="$(date -u +%s)"

metadata_env="$tmp_dir/metadata.env"
"$NEXUS_DR_PYTHON_BIN" - \
  "$database_head" "$release_head" "$metadata_now_epoch" "$metadata_env" \
  "$DATABASE_KEY" "$database_prefix" "$RELEASE_KEY" "$release_prefix" \
  "$NEXUS_DR_STORAGE_PROVIDER" "$DATABASE_VERSION_ID" "$RELEASE_VERSION_ID" <<'PY'
from datetime import datetime, timezone
import json
import re
import shlex
import sys

(
    database_path,
    release_path,
    now_raw,
    output,
    database_key,
    database_prefix,
    release_key,
    release_prefix,
    storage_provider,
    expected_database_version_id,
    expected_release_version_id,
) = sys.argv[1:]
now = int(now_raw)

def object_head(path, label, maximum_bytes, expected_version_id):
    with open(path, encoding="utf-8") as source:
        value = json.load(source)
    length = value.get("ContentLength")
    if not isinstance(length, int) or isinstance(length, bool) \
            or length <= 0 or length > maximum_bytes:
        raise SystemExit(f"{label} encrypted object size is invalid")
    raw_modified = value.get("LastModified", "")
    if not isinstance(raw_modified, str):
        raise SystemExit(f"{label} LastModified is invalid")
    try:
        modified = datetime.fromisoformat(raw_modified.replace("Z", "+00:00"))
    except ValueError as error:
        raise SystemExit(f"{label} LastModified is invalid") from error
    if modified.tzinfo is None:
        raise SystemExit(f"{label} LastModified must include a timezone")
    metadata_value = value.get("Metadata")
    if not isinstance(metadata_value, dict):
        raise SystemExit(f"{label} metadata is invalid")
    version_id = value.get("VersionId")
    if storage_provider == "aws-s3":
        if not isinstance(version_id, str) or version_id == "null" \
                or not 1 <= len(version_id) <= 1024 \
                or any(ord(character) < 32 or ord(character) == 127 for character in version_id):
            raise SystemExit(f"{label} version ID is invalid for versioned S3")
        if version_id != expected_version_id:
            raise SystemExit(f"{label} exact VersionId changed")
    elif version_id not in (None, "null"):
        raise SystemExit(f"{label} unexpectedly returned a version ID for the R2 variance")
    return {
        "contentLength": length,
        "lastModifiedEpoch": int(modified.timestamp()),
        "versionId": version_id or "",
        "metadata": {
            str(key).lower(): str(item)
            for key, item in metadata_value.items()
        },
    }

database_head_value = object_head(
    database_path,
    "database",
    64 * 1024 ** 3,
    expected_database_version_id,
)
release_head_value = object_head(
    release_path,
    "release",
    8 * 1024 ** 3,
    expected_release_version_id,
)
database = database_head_value["metadata"]
release = release_head_value["metadata"]
if database.get("schema-version") != "NexusApplicationSqliteRecoveryPointV1":
    raise SystemExit("database recovery-point schema is invalid")
if release.get("schema-version") != "NexusCurrentRecoveryRuntimeV1":
    raise SystemExit("current recovery runtime escrow schema is invalid")
for label, values in (("database", database), ("release", release)):
    for key in ("encrypted-sha256", "plaintext-sha256"):
        if not re.fullmatch(r"[0-9a-f]{64}", values.get(key, "")):
            raise SystemExit(f"{label} {key} is invalid")
created = database.get("created-epoch", "")
if not re.fullmatch(r"[0-9]+", created):
    raise SystemExit("database created-epoch is invalid")
created_epoch = int(created)
key_match = re.fullmatch(
    re.escape(database_prefix) + r"nexus-db-(\d{8}T\d{6}Z)\.sqlite\.age",
    database_key,
)
if key_match is None:
    raise SystemExit("database recovery-point key timestamp is invalid")
key_epoch = int(
    datetime.strptime(key_match.group(1), "%Y%m%dT%H%M%SZ")
    .replace(tzinfo=timezone.utc)
    .timestamp()
)
last_modified_epoch = database_head_value["lastModifiedEpoch"]
if abs(created_epoch - key_epoch) > 2:
    raise SystemExit("database key and created-epoch differ by more than 2 seconds")
if last_modified_epoch < created_epoch - 2 \
        or last_modified_epoch > created_epoch + 300:
    raise SystemExit("database LastModified differs from created-epoch by more than 300 seconds")
if max(created_epoch, key_epoch, last_modified_epoch) > now + 300:
    raise SystemExit("database recovery-point timestamps are implausibly in the future")
conservative_epoch = min(created_epoch, key_epoch, last_modified_epoch)
age = now - conservative_epoch
if age < 0 or age > 3600:
    raise SystemExit(f"RPO breach: selected database recovery point is {age} seconds old")
original = release.get("original-name", "")
if not re.fullmatch(
    r"v[A-Za-z0-9._+-]+\+current-[0-9a-f]{40}"
    r"\+escrow-[0-9]{8}T[0-9]{6}Z-[0-9]+-[0-9a-f]{12}\.tar\.gz",
    original,
):
    raise SystemExit("current recovery runtime original filename is invalid")
if release_key != (
    release_prefix
    + original
    + "."
    + release["plaintext-sha256"]
    + ".age"
):
    raise SystemExit("release key does not match its bound plaintext identity")
values = {
    "DATABASE_ENCRYPTED_SHA256": database["encrypted-sha256"],
    "DATABASE_PLAINTEXT_SHA256": database["plaintext-sha256"],
    "DATABASE_CREATED_EPOCH": created,
    "DATABASE_KEY_EPOCH": str(key_epoch),
    "DATABASE_LAST_MODIFIED_EPOCH": str(last_modified_epoch),
    "DATABASE_CONSERVATIVE_EPOCH": str(conservative_epoch),
    "DATABASE_AGE_SECONDS": str(age),
    "DATABASE_CONTENT_LENGTH": str(database_head_value["contentLength"]),
    "DATABASE_OBJECT_VERSION_ID": database_head_value["versionId"],
    "RELEASE_ENCRYPTED_SHA256": release["encrypted-sha256"],
    "RELEASE_PLAINTEXT_SHA256": release["plaintext-sha256"],
    "RELEASE_ORIGINAL_NAME": original,
    "RELEASE_CONTENT_LENGTH": str(release_head_value["contentLength"]),
    "RELEASE_OBJECT_VERSION_ID": release_head_value["versionId"],
}
with open(output, "w", encoding="utf-8") as target:
    for key, value in values.items():
        target.write(f"{key}={shlex.quote(value)}\n")
PY
chmod 0600 "$metadata_env"
# shellcheck disable=SC1090
. "$metadata_env"

IFS=$'\t' read -r scratch_available_bytes scratch_required_bytes < <(
  "$NEXUS_DR_PYTHON_BIN" - "$NEXUS_DR_STATE_DIR" \
    "$DATABASE_CONTENT_LENGTH" "$RELEASE_CONTENT_LENGTH" <<'PY'
import os
import sys

state_dir, database_raw, release_raw = sys.argv[1:]
database = int(database_raw)
release = int(release_raw)
stats = os.statvfs(state_dir)
available = stats.f_bavail * stats.f_frsize
# Encrypted + decrypted objects, bounded extraction/dependency installation,
# and a fixed reserve for SQLite WAL/checkpoint and evidence files.
required = 2 * database + 2 * release + 16 * 1024 ** 3
print(available, required, sep="\t")
PY
)
[[ "$scratch_available_bytes" =~ ^[0-9]+$ \
    && "$scratch_required_bytes" =~ ^[0-9]+$ ]] \
  || die "scratch capacity calculation is invalid"
(( scratch_available_bytes >= scratch_required_bytes )) \
  || die "insufficient private scratch capacity for bounded restore objects"

database_encrypted="$tmp_dir/database.sqlite.age"
release_encrypted="$tmp_dir/release.tar.gz.age"
technical_started_ns="$("$NEXUS_DR_PYTHON_BIN" -c 'import time; print(time.monotonic_ns())')"
[[ "$technical_started_ns" =~ ^[0-9]+$ ]] \
  || die "could not start the monotonic technical restore timer"
database_range_end=$((DATABASE_CONTENT_LENGTH - 1))
release_range_end=$((RELEASE_CONTENT_LENGTH - 1))
database_get_args=(
  --bucket "$NEXUS_DR_S3_BUCKET"
  --key "$DATABASE_KEY"
  --range "bytes=0-$database_range_end"
)
release_get_args=(
  --bucket "$NEXUS_DR_S3_BUCKET"
  --key "$RELEASE_KEY"
  --range "bytes=0-$release_range_end"
)
if [ "$NEXUS_DR_STORAGE_PROVIDER" = aws-s3 ]; then
  database_get_args+=(--version-id "$DATABASE_OBJECT_VERSION_ID")
  release_get_args+=(--version-id "$RELEASE_OBJECT_VERSION_ID")
fi
aws_s3api get-object "${database_get_args[@]}" "$database_encrypted" >/dev/null
aws_s3api get-object "${release_get_args[@]}" "$release_encrypted" >/dev/null
[ "$(stat -c '%s' -- "$database_encrypted")" = "$DATABASE_CONTENT_LENGTH" ] \
  || die "downloaded encrypted database size differs from exact HEAD"
[ "$(stat -c '%s' -- "$release_encrypted")" = "$RELEASE_CONTENT_LENGTH" ] \
  || die "downloaded encrypted recovery runtime size differs from exact HEAD"
unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN AWS_SECURITY_TOKEN
unset AWS_PROFILE AWS_DEFAULT_PROFILE AWS_SHARED_CREDENTIALS_FILE AWS_CONFIG_FILE
unset AWS_WEB_IDENTITY_TOKEN_FILE AWS_ROLE_ARN AWS_ROLE_SESSION_NAME
unset AWS_CONTAINER_CREDENTIALS_FULL_URI AWS_CONTAINER_CREDENTIALS_RELATIVE_URI
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
"$NEXUS_DR_PYTHON_BIN" "$RECOVERY_ARCHIVE_HELPER" extract \
  --archive "$release_plain" --destination "$runtime" >"$tmp_dir/release-verify.json"
"$NEXUS_DR_PYTHON_BIN" "$SQLITE_HELPER" compatibility \
  "$database_plain" "$runtime/migrations" "$MIGRATION_LINEAGE_POLICY" \
  >"$tmp_dir/release-database-compatibility.json"
rm -f -- "$release_plain"
install -d -m 0700 "$runtime/data"
install -m 0600 -- "$database_plain" "$runtime/data/bot.db.next"
mv -f -- "$runtime/data/bot.db.next" "$runtime/data/bot.db"
rm -f -- "$database_plain"

# Install only the dependency payload already bound into the exact release.
# The trusted helper enforces the Ubuntu/Node/Python lock and --no-index wheel
# install. It runs as the dedicated nologin account in a private network
# namespace with an empty environment, so package processing cannot inherit
# object-store credentials, mutate production, or reach a package registry.
install -d -o "$drill_uid" -g "$drill_gid" -m 0700 \
  "$runtime/.dependency-home" "$runtime/.dependency-tmp"
chown -R "$drill_uid:$drill_gid" "$runtime"

# The private state directory deliberately denies traversal to the drill
# account. Give the unprivileged verifier a root-created bind mount under /run
# inside a private mount namespace instead of weakening state-directory modes.
drill_run_root=/run/nexus-application-drill
if [ -e "$drill_run_root" ]; then
  [[ -d "$drill_run_root" && ! -L "$drill_run_root" \
     && "$(realpath -e -- "$drill_run_root")" = "$drill_run_root" \
     && "$(stat -c '%U:%G:%a' -- "$drill_run_root")" = root:root:711 ]] \
    || die "drill run root must be canonical root:root mode 0711"
else
  install -d -o root -g root -m 0711 "$drill_run_root"
fi
drill_mount_root=/mnt
[[ -d "$drill_mount_root" && ! -L "$drill_mount_root" \
   && "$(realpath -e -- "$drill_mount_root")" = "$drill_mount_root" \
   && "$(stat -c '%U:%G:%a' -- "$drill_mount_root")" = root:root:755 ]] \
  || die "drill mount root must be canonical root:root mode 0755"
preflight_id="$(printf '%s' "$runtime" | sha256sum | awk '{print $1}')"
[[ "$preflight_id" =~ ^[0-9a-f]{64}$ ]] || die "invalid preflight runtime identity"
preflight_state="$drill_run_root/preflight-state-$preflight_id"
preflight_mount="$drill_mount_root/nexus-application-drill-preflight-$preflight_id"
[ ! -e "$preflight_state" ] && [ ! -L "$preflight_state" ] \
  && [ ! -e "$preflight_mount" ] && [ ! -L "$preflight_mount" ] \
  || die "isolated recovery preflight state already exists"
install -d -o root -g "$drill_gid" -m 0710 "$preflight_state" "$preflight_mount"
install -o root -g root -m 0644 -- \
  "$NEXUS_DR_RELEASE_PUBLIC_KEY" "$preflight_state/release-evidence-public-key.pem"

run_isolated_drill_command() {
  timeout --signal=TERM --kill-after=15 900 \
    unshare --mount --net --fork --kill-child=TERM \
    "$drill_bash" -c '
      set -euo pipefail
      source_runtime="$1"
      mounted_runtime="$2"
      run_uid="$3"
      run_gid="$4"
      public_key_source="$5"
      shift 5
      mount --make-rprivate /
      mount --bind "$source_runtime" "$mounted_runtime"
      mount -o remount,bind,rw "$mounted_runtime"
      mount -t tmpfs -o mode=1777,nosuid,nodev,size=64m tmpfs /tmp
      install -o root -g root -m 0444 \
        "$public_key_source" /tmp/release-evidence-public-key.pem
      mount -t tmpfs -o mode=0755,nosuid,nodev,noexec,size=4m tmpfs /run
      mount -t tmpfs -o mode=0755,nosuid,nodev,noexec,size=4m tmpfs /home
      mount -t tmpfs -o mode=0700,nosuid,nodev,noexec,size=4m tmpfs /root
      mount -t tmpfs -o mode=1777,nosuid,nodev,size=32m tmpfs /var/tmp
      mount -t tmpfs -o mode=1777,nosuid,nodev,size=32m tmpfs /dev/shm
      mount -o remount,ro /
      cd "$mounted_runtime"
      exec setpriv \
        --reuid "$run_uid" \
        --regid "$run_gid" \
        --clear-groups \
        --bounding-set=-all \
        --inh-caps=-all \
        --ambient-caps=-all \
        --no-new-privs \
        env -i \
          PATH=/usr/local/bin:/usr/bin:/bin \
          HOME="$mounted_runtime/.dependency-home" \
          TMPDIR="$mounted_runtime/.dependency-tmp" \
          "$@"
    ' nexus-application-dr-recovery-preflight \
      "$runtime" "$preflight_mount" "$drill_uid" "$drill_gid" \
      "$preflight_state/release-evidence-public-key.pem" "$@"
}

run_dependency_helper() {
  run_isolated_drill_command \
    "$NEXUS_DR_DRILL_NODE_BIN" "$RUNTIME_DEPENDENCY_HELPER" "$@"
}
run_dependency_helper verify --root "$preflight_mount" >"$tmp_dir/dependency-verify.json"
run_dependency_helper install --root "$preflight_mount" \
  --python-bin "$NEXUS_DR_PYTHON_BIN" >"$tmp_dir/dependency-install.json"
chmod 0600 "$tmp_dir/dependency-verify.json" "$tmp_dir/dependency-install.json"
[ -d "$runtime/node_modules" ] \
  && [ -d "$runtime/content-engine/.venv" ] \
  && [ -f "$runtime/.network-independent-install.json" ] \
  || die "network-independent dependency installation is incomplete"

IFS=$'\t' read -r RECOVERY_RUNTIME_SHA RECOVERY_ARTIFACT_DIGEST \
  RECOVERY_INSTALLED_RUNTIME_DIGEST RECOVERY_RUNTIME_DIGEST < <(
  "$NEXUS_DR_PYTHON_BIN" - "$tmp_dir/release-verify.json" <<'PY'
import json
import re
import sys

value = json.load(open(sys.argv[1], encoding="utf-8"))
identity = value.get("identity", {})
if (
    value.get("schemaVersion") != "NexusCurrentRecoveryRuntimeArchiveV1"
    or value.get("status") != "passed"
    or not re.fullmatch(r"[0-9a-f]{40}", identity.get("runtimeSha", ""))
    or any(
        not re.fullmatch(r"[0-9a-f]{64}", identity.get(key, ""))
        for key in (
            "artifactDigest",
            "installedRuntimeDigest",
            "recoveryRuntimeDigest",
        )
    )
):
    raise SystemExit("extracted current recovery runtime identity is invalid")
print(
    identity["runtimeSha"],
    identity["artifactDigest"],
    identity["installedRuntimeDigest"],
    identity["recoveryRuntimeDigest"],
    sep="\t",
)
PY
)
run_isolated_drill_command \
  "$NEXUS_DR_DRILL_NODE_BIN" "$RECOVERY_RUNTIME_HELPER" verify \
  --root "$preflight_mount" \
  --public-key /tmp/release-evidence-public-key.pem \
  --recovery-identity-helper "$RECOVERY_IDENTITY_HELPER" \
  --runtime-sha "$RECOVERY_RUNTIME_SHA" \
  --artifact-digest "$RECOVERY_ARTIFACT_DIGEST" \
  --installed-runtime-digest "$RECOVERY_INSTALLED_RUNTIME_DIGEST" \
  --recovery-runtime-digest "$RECOVERY_RUNTIME_DIGEST" \
  >"$tmp_dir/recovery-runtime-verify.json"
chmod 0600 "$tmp_dir/recovery-runtime-verify.json"

monotonic_now_ns() {
  local value
  value="$("$NEXUS_DR_PYTHON_BIN" -c 'import time; print(time.monotonic_ns())')"
  [[ "$value" =~ ^[0-9]+$ ]] || die "could not read the monotonic technical restore timer"
  printf '%s\n' "$value"
}

remaining_seconds() {
  local phase="$1" now_ns elapsed_ns remaining_ns
  now_ns="$(monotonic_now_ns)"
  elapsed_ns=$((now_ns - technical_started_ns))
  remaining_ns=$((1800000000000 - elapsed_ns))
  (( elapsed_ns >= 0 && remaining_ns > 0 )) \
    || die "technical restore target breached before isolated $phase"
  echo $(((remaining_ns + 999999999) / 1000000000))
}

run_harness() {
  local action="$1" remaining
  remaining="$(remaining_seconds "$action")"
  NEXUS_DRILL_MODE=isolated-restore \
  NEXUS_DRILL_ROOT="$runtime" \
  NEXUS_DRILL_DATABASE_PATH="$runtime/data/bot.db" \
  NEXUS_DRILL_BASE_URL="$NEXUS_DR_DRILL_BASE_URL" \
  NEXUS_DRILL_STATE_DIR="$NEXUS_DR_STATE_DIR" \
  NEXUS_DRILL_USER="$NEXUS_DR_DRILL_USER" \
  NEXUS_DRILL_NODE_BIN="$NEXUS_DR_DRILL_NODE_BIN" \
  NEXUS_DRILL_PYTHON_BIN="$NEXUS_DR_PYTHON_BIN" \
    timeout --signal=TERM --kill-after=15 "$remaining" "$NEXUS_DR_RESTORE_HARNESS" "$action" "$runtime"
}

run_harness boot
booted=true
run_harness smoke >"$tmp_dir/application-smoke.json"
chmod 0600 "$tmp_dir/application-smoke.json"
technical_completed_ns="$(monotonic_now_ns)"
technical_elapsed_ns=$((technical_completed_ns - technical_started_ns))
(( technical_elapsed_ns >= 0 && technical_elapsed_ns <= 1800000000000 )) \
  || die "technical restore target breached after isolated smoke"
technical_restore_seconds=$(((technical_elapsed_ns + 999999999) / 1000000000))
run_harness stop
booted=false

post_migration_database="$tmp_dir/post-migration-database.sqlite"
"$NEXUS_DR_PYTHON_BIN" "$SQLITE_HELPER" snapshot \
  "$runtime/data/bot.db" "$post_migration_database" \
  >"$tmp_dir/post-migration-database-snapshot.json"
"$NEXUS_DR_PYTHON_BIN" "$SQLITE_HELPER" verify \
  "$post_migration_database" >"$tmp_dir/post-migration-database-verify.json"
"$NEXUS_DR_PYTHON_BIN" "$SQLITE_HELPER" compatibility \
  "$post_migration_database" "$runtime/migrations" "$MIGRATION_LINEAGE_POLICY" \
  --require-terminal >"$tmp_dir/post-migration-release-database-compatibility.json"
chmod 0600 \
  "$tmp_dir/post-migration-database-snapshot.json" \
  "$tmp_dir/post-migration-database-verify.json" \
  "$tmp_dir/post-migration-release-database-compatibility.json"

"$NEXUS_DR_PYTHON_BIN" - "$OUTPUT" "$DATABASE_KEY" "$RELEASE_KEY" \
  "$DATABASE_PLAINTEXT_SHA256" "$RELEASE_PLAINTEXT_SHA256" \
  "$DATABASE_AGE_SECONDS" "$technical_restore_seconds" \
  "$DATABASE_CREATED_EPOCH" "$DATABASE_KEY_EPOCH" \
  "$DATABASE_LAST_MODIFIED_EPOCH" "$DATABASE_CONSERVATIVE_EPOCH" \
  "$DATABASE_OBJECT_VERSION_ID" "$RELEASE_OBJECT_VERSION_ID" \
  "$NEXUS_DR_STORAGE_PROVIDER" \
  "$tmp_dir/release-database-compatibility.json" \
  "$tmp_dir/post-migration-release-database-compatibility.json" \
  "$tmp_dir/post-migration-database-snapshot.json" \
  "$tmp_dir/post-migration-database-verify.json" \
  "$tmp_dir/application-smoke.json" "$tmp_dir/recovery-runtime-verify.json" <<'PY'
import json
import os
import re
import sys
from datetime import datetime, timezone

(
    output,
    database_key,
    release_key,
    database_sha,
    release_sha,
    rpo,
    technical_restore,
    database_created_epoch,
    database_key_epoch,
    database_last_modified_epoch,
    database_conservative_epoch,
    database_object_version_id,
    release_object_version_id,
    storage_provider,
    pre_compatibility_path,
    post_compatibility_path,
    post_database_snapshot_path,
    post_database_verify_path,
    smoke_path,
    recovery_path,
) = sys.argv[1:]
with open(pre_compatibility_path, encoding="utf-8") as source:
    pre_compatibility = json.load(source)
if (
    pre_compatibility.get("schemaVersion")
        != "NexusApplicationRestoreCompatibilityV1"
    or pre_compatibility.get("status") != "passed"
):
    raise SystemExit("pre-migration release/database compatibility evidence is invalid")
with open(post_compatibility_path, encoding="utf-8") as source:
    post_compatibility = json.load(source)
if (
    post_compatibility.get("schemaVersion")
        != "NexusApplicationRestoreCompatibilityV1"
    or post_compatibility.get("status") != "passed"
    or post_compatibility.get("terminalLineageVerified") is not True
    or post_compatibility.get("canonicalAppliedMigrationCount")
        != post_compatibility.get("runtimeMigrationCount")
    or not all(
        isinstance(post_compatibility.get(key), int)
        and not isinstance(post_compatibility.get(key), bool)
        and post_compatibility[key] >= 0
        for key in (
            "appliedMigrationCount",
            "runtimeMigrationCount",
            "canonicalAppliedMigrationCount",
        )
    )
    or not all(
        re.fullmatch(r"[0-9a-f]{64}", post_compatibility.get(key, ""))
        for key in (
            "appliedMigrationSetSha256",
            "runtimeMigrationSetSha256",
        )
    )
):
    raise SystemExit("post-migration terminal-lineage evidence is invalid")
with open(post_database_verify_path, encoding="utf-8") as source:
    post_database_verify = json.load(source)
with open(post_database_snapshot_path, encoding="utf-8") as source:
    post_database_snapshot = json.load(source)
if (
    post_database_verify.get("schemaVersion")
        != "NexusApplicationSqliteRecoveryPointV1"
    or post_database_verify.get("integrityCheck") != "ok"
    or post_database_verify.get("foreignKeyCheck") != "ok"
    or not re.fullmatch(r"[0-9a-f]{64}", post_database_verify.get("sha256", ""))
    or post_database_snapshot.get("schemaVersion")
        != "NexusApplicationSqliteRecoveryPointV1"
    or post_database_snapshot.get("integrityCheck") != "ok"
    or post_database_snapshot.get("foreignKeyCheck") != "ok"
    or post_database_snapshot.get("sha256") != post_database_verify.get("sha256")
):
    raise SystemExit("post-migration SQLite integrity evidence is invalid")
with open(smoke_path, encoding="utf-8") as source:
    application_smoke = json.load(source)
if (
    application_smoke.get("schemaVersion") != "NexusApplicationDrillSmokeV1"
    or application_smoke.get("status") != "passed"
    or application_smoke.get("nodeBackendHealthVerified") is not True
    or application_smoke.get("contentEngineHealthVerified") is not True
    or application_smoke.get("contentEngineReadinessVerified") is not True
    or set(application_smoke.get("processIdentities", {})) != {"nodeBackend", "contentEngine"}
):
    raise SystemExit("two-process application smoke evidence is invalid")
with open(recovery_path, encoding="utf-8") as source:
    recovery = json.load(source)
identity = recovery.get("identity", {})
if (
    recovery.get("ok") is not True
    or recovery.get("status") != "passed"
    or not all(
        isinstance(identity.get(key), str)
        for key in (
            "runtimeSha",
            "artifactDigest",
            "installedRuntimeDigest",
            "recoveryRuntimeDigest",
            "releaseManifestSha256",
            "stagingAttestationSha256",
        )
    )
):
    raise SystemExit("signed current recovery runtime verification evidence is invalid")
evidence = {
    "schemaVersion": "NexusApplicationRestoreDrillV1",
    "databaseKey": database_key,
    "releaseKey": release_key,
    "databaseSha256": database_sha,
    "releaseSha256": release_sha,
    "sqliteIntegrityVerified": True,
    "exactReleaseBundleVerified": True,
    "exactSignedRecoveryArtifactVerified": True,
    "releaseManifestSha256": identity["releaseManifestSha256"],
    "stagingAttestationSha256": identity["stagingAttestationSha256"],
    "runtimeSha": identity["runtimeSha"],
    "artifactDigest": identity["artifactDigest"],
    "installedRuntimeDigest": identity["installedRuntimeDigest"],
    "recoveryRuntimeDigest": identity["recoveryRuntimeDigest"],
    "relocatableInstalledTreeVerified": True,
    "networkIndependentDependenciesVerified": True,
    "dependencyInstallNetworkNamespaceVerified": True,
    "recoveryRuntimeVerificationUnprivileged": True,
    "recoveryRuntimeVerificationNetworkNamespaceVerified": True,
    "preMigrationReleaseDatabaseCompatibility": pre_compatibility,
    "postMigrationReleaseDatabaseCompatibility": post_compatibility,
    "releaseDatabaseCompatibility": post_compatibility,
    "postMigrationSqliteIntegrityVerified": True,
    "postMigrationWalStateCapturedByOnlineBackup": True,
    "postMigrationDatabaseSha256": post_database_verify["sha256"],
    "isolatedBootVerified": True,
    "isolatedNetworkNamespaceVerified": True,
    "invalidCredentialRejected": True,
    "representativeRestoredDatabaseReadVerified": True,
    "nodeBackendBootVerified": True,
    "contentEngineBootVerified": True,
    "contentEngineHealthVerified": True,
    "processIdentities": application_smoke["processIdentities"],
    "applicationSmokeHarnessVerified": True,
    "rpoSeconds": int(rpo),
    "rpoTargetSeconds": 3600,
    "rpoEvidenceScope": "selected-database-object-storage-timestamp-consistency",
    "rpoEvidenceBasis": "oldest-of-key-created-epoch-and-s3-last-modified",
    "rpoSignedProvenanceVerified": False,
    "databaseTimestampEvidence": {
        "metadataCreatedEpoch": int(database_created_epoch),
        "keyTimestampEpoch": int(database_key_epoch),
        "s3LastModifiedEpoch": int(database_last_modified_epoch),
        "conservativeEpoch": int(database_conservative_epoch),
    },
    "objectVersionEvidence": {
        "provider": storage_provider,
        "databaseVersionId": database_object_version_id or None,
        "releaseVersionId": release_object_version_id or None,
        "exactVersionDownloadVerified": storage_provider == "aws-s3",
        "approvedUnversionedVariance": storage_provider == "cloudflare-r2",
    },
    "technicalRestoreSeconds": int(technical_restore),
    "technicalRestoreTargetSeconds": 1800,
    "technicalRestoreScope":
        "selected-object-download-through-isolated-application-smoke",
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
echo "application_dr_restore_drill_ok rpoSeconds=$DATABASE_AGE_SECONDS technicalRestoreSeconds=$technical_restore_seconds evidence=$OUTPUT"
