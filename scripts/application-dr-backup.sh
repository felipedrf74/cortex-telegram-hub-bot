#!/usr/bin/env bash
# Create a transactionally consistent SQLite recovery point and escrow every
# local exact-release rollback bundle. Plaintext is confined to a root-only
# temporary directory and encrypted with an off-host age recipient before S3.
set -euo pipefail
umask 077

PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
CONFIG=/etc/nexus-application-dr/backup.env
ACTION=backup
REQUIRED_RELEASE=""
JSON_OUTPUT=false

usage() {
  echo "Usage: application-dr-backup.sh [--config <root-mode-0600-file>] [--verify-config] [--require-release <rollback.tar.gz>] [--json]"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --config) CONFIG="${2:?--config requires a path}"; shift 2 ;;
    --verify-config) ACTION=verify; shift ;;
    --require-release) REQUIRED_RELEASE="${2:?--require-release requires a path}"; shift 2 ;;
    --json) JSON_OUTPUT=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 64 ;;
  esac
done

die() { echo "application DR backup: $*" >&2; exit 1; }

private_root_file() {
  local path="$1" label="$2" identity
  [[ "$path" == /* && "$path" != / && -f "$path" && ! -L "$path" ]] \
    || die "$label must be an absolute non-symlink regular file"
  [ "$(realpath -e -- "$path")" = "$path" ] || die "$label must not traverse symlinks"
  identity="$(stat -c '%U:%G:%a' -- "$path")"
  [ "$identity" = root:root:600 ] || die "$label must be root:root mode 0600"
}

canonical_directory() {
  local path="$1" label="$2"
  [[ "$path" == /* && "$path" != / && -d "$path" && ! -L "$path" ]] \
    || die "$label must be an absolute non-symlink directory"
  [ "$(realpath -e -- "$path")" = "$path" ] || die "$label must not traverse symlinks"
}

[ "$(id -u)" -eq 0 ] || die "must run as root"
command -v realpath >/dev/null 2>&1 || die "realpath is required"
private_root_file "$CONFIG" "configuration"

set -a
# shellcheck disable=SC1090
. "$CONFIG"
set +a
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

required=(
  NEXUS_DR_DATABASE_PATH
  NEXUS_DR_ROLLBACK_DIR
  NEXUS_DR_STATE_DIR
  NEXUS_DR_APPLICATION_USER
  NEXUS_DR_PYTHON_BIN
  NEXUS_DR_S3_ENDPOINT
  NEXUS_DR_S3_BUCKET
  NEXUS_DR_S3_PREFIX
  NEXUS_DR_STORAGE_PROVIDER
  NEXUS_DR_STORAGE_CONTROL_MODE
  NEXUS_DR_STORAGE_CONTROL_EVIDENCE
  NEXUS_DR_AGE_RECIPIENT
)
for key in "${required[@]}"; do
  [ -n "${!key:-}" ] || die "configuration is missing $key"
done

[[ "$NEXUS_DR_APPLICATION_USER" =~ ^[a-z_][a-z0-9_-]*$ ]] \
  || die "invalid application user"
id "$NEXUS_DR_APPLICATION_USER" >/dev/null 2>&1 || die "configured application user does not exist"
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
case "$NEXUS_DR_STORAGE_PROVIDER:$NEXUS_DR_STORAGE_CONTROL_MODE" in
  aws-s3:versioned-s3|cloudflare-r2:r2-approved-variance) ;;
  *) die "storage provider/control mode must be aws-s3:versioned-s3 or cloudflare-r2:r2-approved-variance" ;;
esac
private_root_file "$NEXUS_DR_STORAGE_CONTROL_EVIDENCE" "storage-control evidence"
[[ "$NEXUS_DR_AGE_RECIPIENT" =~ ^age1[023456789acdefghjklmnpqrstuvwxyz]{58}$ ]] \
  || die "age recipient must be a native age public recipient"
[[ "${AWS_REGION:-us-east-1}" =~ ^[a-z0-9-]+$ ]] || die "invalid AWS region"

canonical_directory "$NEXUS_DR_STATE_DIR" "state directory"
[ "$(stat -c '%U:%G:%a' -- "$NEXUS_DR_STATE_DIR")" = root:root:700 ] \
  || die "state directory must be root:root mode 0700"
canonical_directory "$NEXUS_DR_ROLLBACK_DIR" "rollback directory"
[ "$(stat -c '%U:%a' -- "$NEXUS_DR_ROLLBACK_DIR")" = "$NEXUS_DR_APPLICATION_USER:700" ] \
  || die "rollback directory must be owned by the application user with mode 0700"
if [ -n "$REQUIRED_RELEASE" ]; then
  [[ "$REQUIRED_RELEASE" == "$NEXUS_DR_ROLLBACK_DIR"/v*.tar.gz \
      && -f "$REQUIRED_RELEASE" && ! -L "$REQUIRED_RELEASE" ]] \
    || die "required release must be a local rollback bundle"
  [ "$(realpath -e -- "$REQUIRED_RELEASE")" = "$REQUIRED_RELEASE" ] \
    || die "required release must not traverse symlinks"
fi
[[ "$NEXUS_DR_DATABASE_PATH" == /* && "$NEXUS_DR_DATABASE_PATH" != / \
   && -f "$NEXUS_DR_DATABASE_PATH" && ! -L "$NEXUS_DR_DATABASE_PATH" ]] \
  || die "database must be an absolute non-symlink regular file"
[ "$(realpath -e -- "$NEXUS_DR_DATABASE_PATH")" = "$NEXUS_DR_DATABASE_PATH" ] \
  || die "database path must not traverse symlinks"
[ "$(stat -c '%U' -- "$NEXUS_DR_DATABASE_PATH")" = "$NEXUS_DR_APPLICATION_USER" ] \
  || die "database must be owned by the configured application user"
case "$(stat -c '%a' -- "$NEXUS_DR_DATABASE_PATH")" in
  600|640|660) ;;
  *) die "database mode must be one of 0600, 0640, or 0660" ;;
esac

[[ "$NEXUS_DR_PYTHON_BIN" == /* && -x "$NEXUS_DR_PYTHON_BIN" && ! -L "$NEXUS_DR_PYTHON_BIN" ]] \
  || die "Python binary must be an absolute executable non-symlink file"
[ "$(realpath -e -- "$NEXUS_DR_PYTHON_BIN")" = "$NEXUS_DR_PYTHON_BIN" ] \
  || die "Python binary must not traverse symlinks"
[ "$(stat -c '%U' -- "$NEXUS_DR_PYTHON_BIN")" = root ] \
  || die "Python binary must be root-owned"
python_mode="$(stat -c '%a' -- "$NEXUS_DR_PYTHON_BIN")"
(( (8#$python_mode & 0022) == 0 )) || die "Python binary must not be group/world writable"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SQLITE_HELPER="$SCRIPT_DIR/application-dr-sqlite.py"
RETENTION_HELPER="$SCRIPT_DIR/application-dr-retention.py"
STORAGE_CONTROL_HELPER="$SCRIPT_DIR/application-dr-storage-controls.py"
for helper in "$SQLITE_HELPER" "$RETENTION_HELPER" "$STORAGE_CONTROL_HELPER"; do
  [[ -f "$helper" && ! -L "$helper" ]] || die "installed helper is missing: $helper"
  [ "$(stat -c '%U:%G:%a' -- "$helper")" = root:root:644 ] \
    || die "installed helper must be root:root mode 0644: $helper"
done
for command in age aws flock sha256sum stat tar; do
  command -v "$command" >/dev/null 2>&1 || die "$command is required"
done
printf '' | age --encrypt --recipient "$NEXUS_DR_AGE_RECIPIENT" >/dev/null \
  || die "age recipient checksum is invalid"
"$NEXUS_DR_PYTHON_BIN" "$STORAGE_CONTROL_HELPER" \
  --evidence "$NEXUS_DR_STORAGE_CONTROL_EVIDENCE" \
  --provider "$NEXUS_DR_STORAGE_PROVIDER" \
  --control-mode "$NEXUS_DR_STORAGE_CONTROL_MODE" \
  --endpoint "$NEXUS_DR_S3_ENDPOINT" \
  --bucket "$NEXUS_DR_S3_BUCKET" \
  --prefix "$NEXUS_DR_S3_PREFIX" >/dev/null

if [ "$ACTION" = verify ]; then
  echo "application_dr_backup_config_ok encryption=age transport=s3-compatible storageProvider=$NEXUS_DR_STORAGE_PROVIDER storageControlMode=$NEXUS_DR_STORAGE_CONTROL_MODE releasePrefixLock=verified databaseRetention=24-hourly,7-daily,4-weekly,6-monthly releaseRetention=90-days"
  exit 0
fi

install -d -o root -g root -m 0700 "$NEXUS_DR_STATE_DIR/tmp"
exec 9>"$NEXUS_DR_STATE_DIR/backup.lock"
chmod 0600 "$NEXUS_DR_STATE_DIR/backup.lock"
flock -n 9 || die "another application DR backup is already running"

tmp_dir="$(mktemp -d "$NEXUS_DR_STATE_DIR/tmp/backup.XXXXXX")"
cleanup() { rm -rf -- "$tmp_dir"; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
chmod 0700 "$tmp_dir"

aws_s3api() {
  aws --endpoint-url "$NEXUS_DR_S3_ENDPOINT" --region "${AWS_REGION:-us-east-1}" s3api "$@"
}

sha256_file() { sha256sum -- "$1" | awk '{print $1}'; }
size_file() { stat -c '%s' -- "$1"; }

verify_remote_object() {
  local key="$1" encrypted_sha="$2" plaintext_sha="$3" schema="$4"
  local expected_size="$5" created_epoch="$6" original_name="${7:-}"
  local head="$tmp_dir/head-$(printf '%s' "$key" | sha256sum | awk '{print $1}').json"
  aws_s3api head-object --bucket "$NEXUS_DR_S3_BUCKET" --key "$key" >"$head"
  "$NEXUS_DR_PYTHON_BIN" - "$head" "$encrypted_sha" "$plaintext_sha" "$schema" \
    "$expected_size" "$created_epoch" "$original_name" "$NEXUS_DR_STORAGE_PROVIDER" <<'PY'
from datetime import datetime, timezone
import json
import sys

head_path, encrypted, plaintext, schema, size, created, original, provider = sys.argv[1:]
value = json.load(open(head_path, encoding="utf-8"))
metadata = {str(key).lower(): str(item) for key, item in value.get("Metadata", {}).items()}
expected = {
    "encrypted-sha256": encrypted,
    "plaintext-sha256": plaintext,
    "schema-version": schema,
    "created-epoch": created,
}
if any(metadata.get(key) != item for key, item in expected.items()):
    raise SystemExit("uploaded object metadata did not verify")
if original and metadata.get("original-name") != original:
    raise SystemExit("uploaded object original filename did not verify")
if int(value.get("ContentLength", -1)) != int(size):
    raise SystemExit("uploaded object size did not verify")
if schema == "NexusReleaseRollbackEscrowV1" and provider == "aws-s3":
    if value.get("ObjectLockMode") != "COMPLIANCE":
        raise SystemExit("release escrow object is missing S3 compliance retention")
    raw_retention = value.get("ObjectLockRetainUntilDate", "")
    try:
        retention = datetime.fromisoformat(raw_retention.replace("Z", "+00:00"))
    except (TypeError, ValueError):
        raise SystemExit("release escrow S3 retention timestamp is invalid")
    if retention.tzinfo is None:
        raise SystemExit("release escrow S3 retention timestamp has no timezone")
    if int(retention.astimezone(timezone.utc).timestamp()) < int(created) + 90 * 86400:
        raise SystemExit("release escrow S3 retention is shorter than 90 days")
PY
}

put_encrypted_object() {
  local key="$1" encrypted="$2" encrypted_sha="$3" plaintext_sha="$4"
  local schema="$5" created_epoch="$6" original_name="${7:-}"
  local metadata="encrypted-sha256=$encrypted_sha,plaintext-sha256=$plaintext_sha,schema-version=$schema,created-epoch=$created_epoch"
  local object_lock_args=()
  local retain_until=""
  [ -z "$original_name" ] || metadata="$metadata,original-name=$original_name"
  if [ "$schema" = NexusReleaseRollbackEscrowV1 ] \
      && [ "$NEXUS_DR_STORAGE_PROVIDER" = aws-s3 ]; then
    retain_until="$("$NEXUS_DR_PYTHON_BIN" - "$created_epoch" <<'PY'
from datetime import datetime, timezone
import sys

retain_epoch = int(sys.argv[1]) + 90 * 86400
print(datetime.fromtimestamp(retain_epoch, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"))
PY
)"
    object_lock_args=(
      --object-lock-mode COMPLIANCE
      --object-lock-retain-until-date "$retain_until"
    )
  fi
  aws_s3api put-object \
    --bucket "$NEXUS_DR_S3_BUCKET" \
    --key "$key" \
    --body "$encrypted" \
    --content-type application/octet-stream \
    "${object_lock_args[@]}" \
    --metadata "$metadata" >/dev/null
  verify_remote_object "$key" "$encrypted_sha" "$plaintext_sha" "$schema" \
    "$(size_file "$encrypted")" "$created_epoch" "$original_name"
}

created_epoch="$(date -u +%s)"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
snapshot="$tmp_dir/nexus-db-$timestamp.sqlite"
snapshot_manifest="$tmp_dir/snapshot.json"
"$NEXUS_DR_PYTHON_BIN" "$SQLITE_HELPER" snapshot "$NEXUS_DR_DATABASE_PATH" "$snapshot" >"$snapshot_manifest"
chmod 0600 "$snapshot_manifest"
plaintext_sha="$(sha256_file "$snapshot")"
manifest_sha="$($NEXUS_DR_PYTHON_BIN -c 'import json,sys; print(json.load(open(sys.argv[1]))["sha256"])' "$snapshot_manifest")"
[ "$plaintext_sha" = "$manifest_sha" ] || die "SQLite recovery-point digest mismatch"

encrypted="$tmp_dir/nexus-db-$timestamp.sqlite.age"
age --encrypt --recipient "$NEXUS_DR_AGE_RECIPIENT" --output "$encrypted" "$snapshot"
[ -s "$encrypted" ] || die "age produced an empty database recovery point"
chmod 0600 "$encrypted"
rm -f -- "$snapshot" "$snapshot_manifest"
encrypted_sha="$(sha256_file "$encrypted")"

database_root="$NEXUS_DR_S3_PREFIX/database"
hourly_key="$database_root/hourly/nexus-db-$timestamp.sqlite.age"
daily_key="$database_root/daily/nexus-db-$(date -u +%Y%m%d).sqlite.age"
weekly_key="$database_root/weekly/nexus-db-$(date -u +%G-W%V).sqlite.age"
monthly_key="$database_root/monthly/nexus-db-$(date -u +%Y%m).sqlite.age"
for key in "$hourly_key" "$daily_key" "$weekly_key" "$monthly_key"; do
  put_encrypted_object "$key" "$encrypted" "$encrypted_sha" "$plaintext_sha" \
    NexusApplicationSqliteRecoveryPointV1 "$created_epoch"
done

prune_count_tier() {
  local tier="$1" retain="$2" listing="$tmp_dir/$tier-list.json" plan="$tmp_dir/$tier-delete.txt"
  aws_s3api list-objects-v2 --bucket "$NEXUS_DR_S3_BUCKET" \
    --prefix "$database_root/$tier/" --output json >"$listing"
  "$NEXUS_DR_PYTHON_BIN" "$RETENTION_HELPER" \
    --listing "$listing" --prefix "$database_root" --output "$plan" \
    count --tier "$tier" --retain "$retain"
  while IFS= read -r key; do
    [ -n "$key" ] || continue
    case "$key" in
      "$database_root/$tier/"nexus-db-*.sqlite.age) ;;
      *) die "retention helper returned an unsafe database key" ;;
    esac
    aws_s3api delete-object --bucket "$NEXUS_DR_S3_BUCKET" --key "$key" >/dev/null
  done <"$plan"
}

prune_count_tier hourly 24
prune_count_tier daily 7
prune_count_tier weekly 4
prune_count_tier monthly 6

release_count=0
required_release_confirmed=false
required_release_sha=""
required_release_key=""
shopt -s nullglob
rollback_archives=("$NEXUS_DR_ROLLBACK_DIR"/v*.tar.gz)
shopt -u nullglob
for archive in "${rollback_archives[@]}"; do
  basename="$(basename -- "$archive")"
  [[ "$basename" =~ ^v[A-Za-z0-9._+-]+\.tar\.gz$ ]] \
    || die "unsafe release rollback filename: $basename"
  [[ -f "$archive" && ! -L "$archive" ]] || die "rollback bundle must be a regular non-symlink file"
  [ "$(realpath -e -- "$archive")" = "$archive" ] || die "rollback bundle must not traverse symlinks"
  [ "$(stat -c '%U:%a' -- "$archive")" = "$NEXUS_DR_APPLICATION_USER:600" ] \
    || die "rollback bundle must be application-user owned mode 0600: $basename"
  tar tzf "$archive" >/dev/null || die "rollback bundle archive validation failed: $basename"
  archive_sha="$(sha256_file "$archive")"
  release_key="$NEXUS_DR_S3_PREFIX/releases/$basename.$archive_sha.age"
  release_head="$tmp_dir/release-head-$archive_sha.json"
  if aws_s3api head-object --bucket "$NEXUS_DR_S3_BUCKET" --key "$release_key" >"$release_head" 2>/dev/null; then
    "$NEXUS_DR_PYTHON_BIN" - "$release_head" "$archive_sha" "$basename" \
      "$NEXUS_DR_STORAGE_PROVIDER" <<'PY'
from datetime import datetime, timezone
import json
import re
import sys
value = json.load(open(sys.argv[1], encoding="utf-8"))
metadata = {str(key).lower(): str(item) for key, item in value.get("Metadata", {}).items()}
if metadata.get("plaintext-sha256") != sys.argv[2] or metadata.get("original-name") != sys.argv[3]:
    raise SystemExit("existing release escrow metadata does not match the local rollback bundle")
if metadata.get("schema-version") != "NexusReleaseRollbackEscrowV1":
    raise SystemExit("existing release escrow schema is invalid")
if not re.fullmatch(r"[0-9a-f]{64}", metadata.get("encrypted-sha256", "")):
    raise SystemExit("existing release escrow encrypted digest is invalid")
if int(value.get("ContentLength", 0)) <= 0:
    raise SystemExit("existing release escrow object is empty")
created = metadata.get("created-epoch", "")
if not re.fullmatch(r"[0-9]+", created):
    raise SystemExit("existing release escrow created epoch is invalid")
if sys.argv[4] == "aws-s3":
    if value.get("ObjectLockMode") != "COMPLIANCE":
        raise SystemExit("existing release escrow is missing S3 compliance retention")
    try:
        retention = datetime.fromisoformat(
            str(value.get("ObjectLockRetainUntilDate", "")).replace("Z", "+00:00"),
        )
    except ValueError:
        raise SystemExit("existing release escrow S3 retention timestamp is invalid")
    if retention.tzinfo is None or int(retention.astimezone(timezone.utc).timestamp()) < int(created) + 90 * 86400:
        raise SystemExit("existing release escrow S3 retention is shorter than 90 days")
PY
  else
    release_encrypted="$tmp_dir/$basename.$archive_sha.age"
    age --encrypt --recipient "$NEXUS_DR_AGE_RECIPIENT" --output "$release_encrypted" "$archive"
    [ -s "$release_encrypted" ] || die "age produced an empty release escrow object"
    chmod 0600 "$release_encrypted"
    [ "$(sha256_file "$archive")" = "$archive_sha" ] \
      || die "rollback bundle changed while it was being encrypted: $basename"
    release_encrypted_sha="$(sha256_file "$release_encrypted")"
    put_encrypted_object "$release_key" "$release_encrypted" "$release_encrypted_sha" \
      "$archive_sha" NexusReleaseRollbackEscrowV1 "$created_epoch" "$basename"
    rm -f -- "$release_encrypted"
  fi
  if [ -n "$REQUIRED_RELEASE" ] && [ "$archive" = "$REQUIRED_RELEASE" ]; then
    required_release_confirmed=true
    required_release_sha="$archive_sha"
    required_release_key="$release_key"
  fi
  release_count=$((release_count + 1))
done

if [ -n "$REQUIRED_RELEASE" ] && [ "$required_release_confirmed" != true ]; then
  die "required release escrow was not confirmed"
fi

release_listing="$tmp_dir/releases-list.json"
release_plan="$tmp_dir/releases-delete.txt"
aws_s3api list-objects-v2 --bucket "$NEXUS_DR_S3_BUCKET" \
  --prefix "$NEXUS_DR_S3_PREFIX/releases/" --output json >"$release_listing"
"$NEXUS_DR_PYTHON_BIN" "$RETENTION_HELPER" \
  --listing "$release_listing" --prefix "$NEXUS_DR_S3_PREFIX" --output "$release_plan" \
  age --days 90 --now-epoch "$created_epoch"
while IFS= read -r key; do
  [ -n "$key" ] || continue
  case "$key" in
    "$NEXUS_DR_S3_PREFIX/releases/"v*.tar.gz.*.age) ;;
    *) die "retention helper returned an unsafe release key" ;;
  esac
  aws_s3api delete-object --bucket "$NEXUS_DR_S3_BUCKET" --key "$key" >/dev/null
done <"$release_plan"

if [ "$JSON_OUTPUT" = true ]; then
  "$NEXUS_DR_PYTHON_BIN" - "$hourly_key" "$plaintext_sha" "$release_count" "$REQUIRED_RELEASE" \
    "$required_release_sha" "$required_release_key" "$NEXUS_DR_STORAGE_PROVIDER" \
    "$NEXUS_DR_STORAGE_CONTROL_MODE" <<'PY'
import json
import sys
database_key, database_sha, count, required_path, release_sha, release_key, provider, control_mode = sys.argv[1:]
print(json.dumps({
    "schema": "nexus.application-dr-backup-result.v1",
    "status": "passed",
    "encrypted": True,
    "storageProvider": provider,
    "storageControlMode": control_mode,
    "releasePrefixLockVerified": True,
    "databaseKey": database_key,
    "databaseSha256": database_sha,
    "releaseBundles": int(count),
    "requiredRelease": None if not required_path else {
        "path": required_path,
        "plaintextSha256": release_sha,
        "objectKey": release_key,
        "confirmed": True,
    },
}, separators=(",", ":")))
PY
else
  echo "application_dr_backup_complete encrypted=true storageProvider=$NEXUS_DR_STORAGE_PROVIDER storageControlMode=$NEXUS_DR_STORAGE_CONTROL_MODE releasePrefixLock=verified databaseKey=$hourly_key databaseSha256=$plaintext_sha releaseBundles=$release_count databaseRetention=24,7,4,6 releaseRetentionDays=90"
fi
