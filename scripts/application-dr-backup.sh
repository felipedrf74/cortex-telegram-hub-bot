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
REQUIRED_RECOVERY_RUNTIME=""
RECOVERY_DESCRIPTOR=""
RECOVERY_ESCROW_ID=""
RECOVERY_ESCROW_PHASE=""
RECOVERY_RELEASE_MANIFEST=""
RECOVERY_STAGING_ATTESTATION=""
RECOVERY_RUNTIME_SHA=""
RECOVERY_ARTIFACT_DIGEST=""
RECOVERY_INSTALLED_RUNTIME_DIGEST=""
RECOVERY_RUNTIME_DIGEST=""
JSON_OUTPUT=false

usage() {
  echo "Usage: application-dr-backup.sh [--config <root-mode-0600-file>] [--verify-config] [--require-release <rollback.tar.gz>] [--require-recovery-runtime <release-dir> --recovery-descriptor <root-mode-0600-file> --recovery-escrow-id <promotion-transaction-id> --recovery-escrow-phase <pre-mutation|post-soak> --recovery-release-manifest <file> --recovery-staging-attestation <file> --recovery-runtime-sha <sha> --recovery-artifact-digest <sha256> --recovery-installed-runtime-digest <sha256> --recovery-runtime-digest <sha256>] [--json]"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --config) CONFIG="${2:?--config requires a path}"; shift 2 ;;
    --verify-config) ACTION=verify; shift ;;
    --require-release) REQUIRED_RELEASE="${2:?--require-release requires a path}"; shift 2 ;;
    --require-recovery-runtime) REQUIRED_RECOVERY_RUNTIME="${2:?--require-recovery-runtime requires a path}"; shift 2 ;;
    --recovery-descriptor) RECOVERY_DESCRIPTOR="${2:?--recovery-descriptor requires a path}"; shift 2 ;;
    --recovery-escrow-id) RECOVERY_ESCROW_ID="${2:?--recovery-escrow-id requires a promotion transaction ID}"; shift 2 ;;
    --recovery-escrow-phase) RECOVERY_ESCROW_PHASE="${2:?--recovery-escrow-phase requires pre-mutation or post-soak}"; shift 2 ;;
    --recovery-release-manifest) RECOVERY_RELEASE_MANIFEST="${2:?--recovery-release-manifest requires a path}"; shift 2 ;;
    --recovery-staging-attestation) RECOVERY_STAGING_ATTESTATION="${2:?--recovery-staging-attestation requires a path}"; shift 2 ;;
    --recovery-runtime-sha) RECOVERY_RUNTIME_SHA="${2:?--recovery-runtime-sha requires a SHA}"; shift 2 ;;
    --recovery-artifact-digest) RECOVERY_ARTIFACT_DIGEST="${2:?--recovery-artifact-digest requires a digest}"; shift 2 ;;
    --recovery-installed-runtime-digest) RECOVERY_INSTALLED_RUNTIME_DIGEST="${2:?--recovery-installed-runtime-digest requires a digest}"; shift 2 ;;
    --recovery-runtime-digest) RECOVERY_RUNTIME_DIGEST="${2:?--recovery-runtime-digest requires a digest}"; shift 2 ;;
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
install_journal="$NEXUS_DR_STATE_DIR/install-in-progress.v1"
if [ -L "$install_journal" ]; then
  die "application DR install journal is a symlink"
elif [ -e "$install_journal" ]; then
  private_root_file "$install_journal" "application DR install journal"
  die "application DR installation is incomplete; rerun the root installer"
fi
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
recovery_argument_count=0
for value in "$REQUIRED_RECOVERY_RUNTIME" "$RECOVERY_DESCRIPTOR" "$RECOVERY_ESCROW_ID" \
  "$RECOVERY_ESCROW_PHASE" \
  "$RECOVERY_RELEASE_MANIFEST" "$RECOVERY_STAGING_ATTESTATION" "$RECOVERY_RUNTIME_SHA" \
  "$RECOVERY_ARTIFACT_DIGEST" "$RECOVERY_INSTALLED_RUNTIME_DIGEST" \
  "$RECOVERY_RUNTIME_DIGEST"; do
  [ -z "$value" ] || recovery_argument_count=$((recovery_argument_count + 1))
done
case "$recovery_argument_count" in
  0) ;;
  10)
    canonical_directory "$REQUIRED_RECOVERY_RUNTIME" "required recovery runtime"
    [ "$(dirname -- "$REQUIRED_RECOVERY_RUNTIME")" = /srv/nexus-release/production/releases ] \
      || die "required recovery runtime must be an exact governed production release directory"
    [[ "$RECOVERY_ESCROW_ID" =~ ^[0-9]{8}T[0-9]{6}Z-[0-9]+-[a-f0-9]{12}$ ]] \
      || die "recovery escrow ID must be the exact promotion transaction ID"
    case "$RECOVERY_ESCROW_PHASE" in
      pre-mutation|post-soak) ;;
      *) die "recovery escrow phase must be pre-mutation or post-soak" ;;
    esac
    private_root_file "$RECOVERY_DESCRIPTOR" "recovery runtime descriptor"
    private_root_file "$RECOVERY_RELEASE_MANIFEST" "signed recovery release manifest"
    private_root_file "$RECOVERY_STAGING_ATTESTATION" "signed recovery staging attestation"
    [[ "$RECOVERY_RUNTIME_SHA" =~ ^[a-f0-9]{40}$ \
        && "$RECOVERY_ARTIFACT_DIGEST" =~ ^[a-f0-9]{64}$ \
        && "$RECOVERY_INSTALLED_RUNTIME_DIGEST" =~ ^[a-f0-9]{64}$ \
        && "$RECOVERY_RUNTIME_DIGEST" =~ ^[a-f0-9]{64}$ ]] \
      || die "required recovery runtime identity is invalid"
    ;;
  *) die "current recovery runtime arguments must be supplied together" ;;
esac
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
VERSION_RETENTION_HELPER="$SCRIPT_DIR/application-dr-version-retention.py"
STORAGE_CONTROL_HELPER="$SCRIPT_DIR/application-dr-storage-controls.py"
RECOVERY_ARCHIVE_HELPER="$SCRIPT_DIR/application-dr-recovery-archive.py"
for helper in "$SQLITE_HELPER" "$RETENTION_HELPER" "$VERSION_RETENTION_HELPER" \
  "$STORAGE_CONTROL_HELPER" "$RECOVERY_ARCHIVE_HELPER"; do
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

aws_version_id_from_json() {
  local document="$1" label="$2"
  "$NEXUS_DR_PYTHON_BIN" - "$document" "$label" <<'PY'
import json
import re
import sys

path, label = sys.argv[1:]
try:
    value = json.load(open(path, encoding="utf-8"))
except (OSError, json.JSONDecodeError) as error:
    raise SystemExit(f"{label} is unreadable: {error}")
version_id = value.get("VersionId") if isinstance(value, dict) else None
if not isinstance(version_id, str) or not re.fullmatch(
    r"[A-Za-z0-9._~+=:/-]{1,1024}",
    version_id,
):
    raise SystemExit(f"{label} has no valid exact VersionId")
print(version_id)
PY
}

aws_retain_until_from_json() {
  local document="$1" label="$2" minimum_epoch="$3"
  "$NEXUS_DR_PYTHON_BIN" - "$document" "$label" "$minimum_epoch" <<'PY'
from datetime import datetime, timezone
import json
import sys

path, label, minimum_raw = sys.argv[1:]
try:
    value = json.load(open(path, encoding="utf-8"))
except (OSError, json.JSONDecodeError) as error:
    raise SystemExit(f"{label} is unreadable: {error}")
raw = value.get("ObjectLockRetainUntilDate") if isinstance(value, dict) else None
try:
    retained = datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
except ValueError as error:
    raise SystemExit(f"{label} retention deadline is invalid") from error
if (
    retained.tzinfo is None
    or int(retained.astimezone(timezone.utc).timestamp())
        < int(minimum_raw) + 90 * 86400
):
    raise SystemExit(f"{label} retention deadline is shorter than 90 days")
print(retained.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"))
PY
}

validate_aws_retain_until() {
  local retain_until="$1" label="$2" minimum_epoch="$3"
  "$NEXUS_DR_PYTHON_BIN" - "$retain_until" "$label" "$minimum_epoch" <<'PY'
from datetime import datetime, timezone
import sys

raw, label, minimum_raw = sys.argv[1:]
try:
    retained = datetime.fromisoformat(raw.replace("Z", "+00:00"))
except ValueError as error:
    raise SystemExit(f"{label} retention deadline is invalid") from error
if (
    retained.tzinfo is None
    or int(retained.astimezone(timezone.utc).timestamp())
        < int(minimum_raw) + 90 * 86400
):
    raise SystemExit(f"{label} retention deadline is shorter than 90 days")
print(retained.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"))
PY
}

LAST_VERIFIED_VERSION_ID=""
LAST_VERIFIED_RETAIN_UNTIL=""
verify_remote_object() {
  local key="$1" encrypted_sha="$2" plaintext_sha="$3" schema="$4"
  local expected_size="$5" created_epoch="$6" original_name="${7:-}"
  local expected_version_id="${8:-}" verified_version_id
  local head="$tmp_dir/head-$(printf '%s' "$key" | sha256sum | awk '{print $1}').json"
  local -a head_args=(--bucket "$NEXUS_DR_S3_BUCKET" --key "$key")
  if [ "$NEXUS_DR_STORAGE_PROVIDER" = aws-s3 ] && [ -n "$expected_version_id" ]; then
    head_args+=(--version-id "$expected_version_id")
  fi
  aws_s3api head-object "${head_args[@]}" >"$head"
  verified_version_id="$("$NEXUS_DR_PYTHON_BIN" - "$head" "$encrypted_sha" \
    "$plaintext_sha" "$schema" "$expected_size" "$created_epoch" "$original_name" \
    "$NEXUS_DR_STORAGE_PROVIDER" "$expected_version_id" <<'PY'
from datetime import datetime, timezone
import json
import re
import sys

(
    head_path,
    encrypted,
    plaintext,
    schema,
    size,
    created,
    original,
    provider,
    expected_version_id,
) = sys.argv[1:]
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
if provider == "aws-s3":
    version_id = value.get("VersionId")
    if (
        not re.fullmatch(r"[A-Za-z0-9._~+=:/-]{1,1024}", version_id or "")
        or version_id != expected_version_id
    ):
        raise SystemExit("uploaded object exact VersionId did not verify")
    print(version_id)
elif provider == "cloudflare-r2":
    if (
        expected_version_id
        or value.get("VersionId") not in (None, "null")
        or value.get("ObjectLockMode") not in (None, "")
        or value.get("ObjectLockRetainUntilDate") not in (None, "")
    ):
        raise SystemExit("R2 object returned unsupported version or object-lock proof")
else:
    raise SystemExit("uploaded object storage provider is invalid")
if schema in {"NexusReleaseRollbackEscrowV1", "NexusCurrentRecoveryRuntimeV1"} and provider == "aws-s3":
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
)" || die "uploaded object verification failed: $key"
  LAST_VERIFIED_VERSION_ID="$verified_version_id"
  LAST_VERIFIED_RETAIN_UNTIL=""
  if { [ "$schema" = NexusReleaseRollbackEscrowV1 ] \
      || [ "$schema" = NexusCurrentRecoveryRuntimeV1 ]; } \
      && [ "$NEXUS_DR_STORAGE_PROVIDER" = aws-s3 ]; then
    LAST_VERIFIED_RETAIN_UNTIL="$(
      aws_retain_until_from_json "$head" "uploaded release escrow head" \
        "$created_epoch"
    )" || die "uploaded release escrow retention deadline did not verify"
  fi
}

put_encrypted_object() {
  local key="$1" encrypted="$2" encrypted_sha="$3" plaintext_sha="$4"
  local schema="$5" created_epoch="$6" original_name="${7:-}"
  local metadata="encrypted-sha256=$encrypted_sha,plaintext-sha256=$plaintext_sha,schema-version=$schema,created-epoch=$created_epoch"
  local object_lock_args=()
  local retain_until="" put_response put_version_id=""
  [ -z "$original_name" ] || metadata="$metadata,original-name=$original_name"
  if { [ "$schema" = NexusReleaseRollbackEscrowV1 ] \
      || [ "$schema" = NexusCurrentRecoveryRuntimeV1 ]; } \
      && [ "$NEXUS_DR_STORAGE_PROVIDER" = aws-s3 ]; then
    retain_until="$("$NEXUS_DR_PYTHON_BIN" - "$created_epoch" <<'PY'
from datetime import datetime, timezone
import sys

retain_epoch = int(sys.argv[1]) + 90 * 86400 + 3600
print(datetime.fromtimestamp(retain_epoch, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"))
PY
)"
    object_lock_args=(
      --object-lock-mode COMPLIANCE
      --object-lock-retain-until-date "$retain_until"
    )
  fi
  put_response="$tmp_dir/put-$(printf '%s' "$key" | sha256sum | awk '{print $1}').json"
  aws_s3api put-object \
    --bucket "$NEXUS_DR_S3_BUCKET" \
    --key "$key" \
    --body "$encrypted" \
    --content-type application/octet-stream \
    "${object_lock_args[@]}" \
    --metadata "$metadata" >"$put_response"
  if [ "$NEXUS_DR_STORAGE_PROVIDER" = aws-s3 ]; then
    put_version_id="$(aws_version_id_from_json "$put_response" "put-object response")" \
      || die "put-object did not return an exact S3 VersionId"
  fi
  verify_remote_object "$key" "$encrypted_sha" "$plaintext_sha" "$schema" \
    "$(size_file "$encrypted")" "$created_epoch" "$original_name" "$put_version_id"
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
hourly_database_version_id=""
for key in "$hourly_key" "$daily_key" "$weekly_key" "$monthly_key"; do
  put_encrypted_object "$key" "$encrypted" "$encrypted_sha" "$plaintext_sha" \
    NexusApplicationSqliteRecoveryPointV1 "$created_epoch"
  if [ "$key" = "$hourly_key" ]; then
    hourly_database_version_id="$LAST_VERIFIED_VERSION_ID"
  fi
done
if [ "$NEXUS_DR_STORAGE_PROVIDER" = aws-s3 ]; then
  [[ "$hourly_database_version_id" =~ ^[A-Za-z0-9._~+=:/-]{1,1024}$ ]] \
    || die "hourly database recovery point is missing its exact S3 VersionId"
fi

# BEGIN version-aware S3 retention functions
list_versioned_objects() {
  local prefix="$1" listing="$2" label="$3"
  local key_marker="" version_id_marker="" next_key_marker next_version_id_marker
  local page page_state listing_next marker_identity seen page_entry_count
  local truncated page_index=0 total_entries=0
  local -a page_files=() request=() seen_markers=()
  while :; do
    page_index=$((page_index + 1))
    [ "$page_index" -le 1000 ] \
      || die "version listing exceeded the bounded page limit: $label"
    page="$tmp_dir/$label-version-page-$page_index.json"
    page_state="$tmp_dir/$label-version-page-$page_index.state"
    request=(
      list-object-versions
      --bucket "$NEXUS_DR_S3_BUCKET"
      --prefix "$prefix"
      --no-paginate
      --max-keys 1000
      --output json
    )
    if [ -n "$key_marker" ] || [ -n "$version_id_marker" ]; then
      [ -n "$key_marker" ] && [ -n "$version_id_marker" ] \
        || die "version listing continuation marker pair is incomplete: $label"
      request+=(
        --key-marker "$key_marker"
        --version-id-marker "$version_id_marker"
      )
    fi
    aws_s3api "${request[@]}" >"$page"
    if ! "$NEXUS_DR_PYTHON_BIN" - "$page" "$prefix" "$key_marker" \
      "$version_id_marker" >"$page_state" <<'PY'
import json
import re
import sys

path, prefix, expected_key_marker, expected_version_marker = sys.argv[1:]
try:
    page = json.load(open(path, encoding="utf-8"))
except (OSError, json.JSONDecodeError) as error:
    raise SystemExit(f"version listing page is unreadable: {error}")
if not isinstance(page, dict) or "NextToken" in page:
    raise SystemExit("version listing page is not a direct S3 API response")
if page.get("Prefix") not in (None, prefix):
    raise SystemExit("version listing page prefix does not match the request")

safe_marker = re.compile(r"[A-Za-z0-9._~+=:/-]{1,1024}")

def marker(name):
    raw = page.get(name)
    if raw in (None, ""):
        return ""
    if not isinstance(raw, str) or not safe_marker.fullmatch(raw):
        raise SystemExit(f"version listing {name} is invalid")
    return raw

key_marker = marker("KeyMarker")
version_marker = marker("VersionIdMarker")
if key_marker != expected_key_marker or version_marker != expected_version_marker:
    raise SystemExit("version listing response marker does not match the request")
if key_marker and not key_marker.startswith(prefix):
    raise SystemExit("version listing response key marker escapes the requested prefix")

truncated = page.get("IsTruncated")
if type(truncated) is not bool:
    raise SystemExit("version listing IsTruncated must be an explicit boolean")
next_key_marker = marker("NextKeyMarker")
next_version_marker = marker("NextVersionIdMarker")
if truncated:
    if not next_key_marker or not next_version_marker:
        raise SystemExit("truncated version listing has incomplete continuation markers")
    if not next_key_marker.startswith(prefix):
        raise SystemExit("version listing continuation key escapes the requested prefix")
elif next_key_marker or next_version_marker:
    raise SystemExit("complete version listing unexpectedly has continuation markers")

versions = page.get("Versions", [])
delete_markers = page.get("DeleteMarkers", [])
if (
    not isinstance(versions, list)
    or not isinstance(delete_markers, list)
    or not all(isinstance(item, dict) for item in [*versions, *delete_markers])
    or len(versions) + len(delete_markers) > 1000
):
    raise SystemExit("version listing page entries are invalid or exceed max-keys")
print(
    "true" if truncated else "false",
    next_key_marker,
    next_version_marker,
    len(versions) + len(delete_markers),
    sep="|",
)
PY
    then
      die "version listing page validation failed: $label page $page_index"
    fi
    IFS='|' read -r truncated next_key_marker next_version_id_marker \
      page_entry_count <"$page_state"
    [[ "$page_entry_count" =~ ^[0-9]+$ ]] \
      || die "version listing page count is invalid: $label page $page_index"
    total_entries=$((total_entries + page_entry_count))
    [ "$total_entries" -le 20000 ] \
      || die "version listing exceeded the bounded entry limit: $label"
    page_files+=("$page")
    case "$truncated" in
      false)
        [ -z "$next_key_marker" ] && [ -z "$next_version_id_marker" ] \
          || die "complete version listing returned continuation state: $label"
        break
        ;;
      true)
        [ -n "$next_key_marker" ] && [ -n "$next_version_id_marker" ] \
          || die "truncated version listing omitted continuation state: $label"
        marker_identity="$next_key_marker"$'\t'"$next_version_id_marker"
        for seen in "${seen_markers[@]:-}"; do
          [ "$seen" != "$marker_identity" ] \
            || die "version listing repeated a continuation marker: $label"
        done
        seen_markers+=("$marker_identity")
        key_marker="$next_key_marker"
        version_id_marker="$next_version_id_marker"
        ;;
      *) die "version listing truncation state is invalid: $label" ;;
    esac
  done

  [[ ! -e "$listing" && ! -L "$listing" ]] \
    || die "version listing output already exists: $label"
  listing_next="$listing.next"
  [[ ! -e "$listing_next" && ! -L "$listing_next" ]] \
    || die "version listing temporary output already exists: $label"
  if ! "$NEXUS_DR_PYTHON_BIN" - "${page_files[@]}" >"$listing_next" <<'PY'
import json
import sys

pages = []
for path in sys.argv[1:]:
    with open(path, encoding="utf-8") as handle:
        page = json.load(handle)
    if not isinstance(page, dict):
        raise SystemExit("version listing page is not an object")
    pages.append(page)
if not pages:
    raise SystemExit("version listing envelope has no pages")
print(json.dumps({
    "schemaVersion": "NexusApplicationDrVersionListingV1",
    "pages": pages,
}, sort_keys=True, separators=(",", ":")))
PY
  then
    die "version listing envelope creation failed: $label"
  fi
  chmod 0600 "$listing_next"
  mv -- "$listing_next" "$listing"
}

render_version_delete_rows() {
  local plan="$1" expected_prefix="$2" rows="$3"
  if ! "$NEXUS_DR_PYTHON_BIN" - "$plan" "$expected_prefix" >"$rows" <<'PY'
import json
import re
import sys

path, expected_prefix = sys.argv[1:]
try:
    value = json.load(open(path, encoding="utf-8"))
except (OSError, json.JSONDecodeError) as error:
    raise SystemExit(f"version deletion plan is unreadable: {error}")
if (
    not isinstance(value, dict)
    or set(value) != {"schemaVersion", "deletions"}
    or value.get("schemaVersion") != "NexusApplicationDrVersionDeletionPlanV1"
    or not isinstance(value.get("deletions"), list)
):
    raise SystemExit("version deletion plan envelope is invalid")
version_pattern = re.compile(r"[A-Za-z0-9._~+=:/-]{1,1024}")
seen = set()
for deletion in value["deletions"]:
    if not isinstance(deletion, dict) or set(deletion) != {
        "key", "versionId", "kind",
    }:
        raise SystemExit("version deletion row has invalid fields")
    key = deletion["key"]
    version_id = deletion["versionId"]
    kind = deletion["kind"]
    identity = (key, version_id)
    if (
        not isinstance(key, str)
        or not key.startswith(expected_prefix)
        or "\t" in key
        or "\n" in key
        or not isinstance(version_id, str)
        or not version_pattern.fullmatch(version_id)
        or kind not in {"version", "delete-marker"}
        or identity in seen
    ):
        raise SystemExit("version deletion row is unsafe")
    seen.add(identity)
    print(key, version_id, kind, sep="\t")
PY
  then
    die "version deletion plan validation failed"
  fi
  chmod 0600 "$rows"
}

execute_version_deletion_plan() {
  local plan="$1" expected_prefix="$2" rows="$plan.rows"
  local key version_id kind extra index
  local -a protected_keys=("${3:-}" "${5:-}")
  local -a protected_version_ids=("${4:-}" "${6:-}")
  for index in 0 1; do
    if [ -n "${protected_keys[$index]}" ] \
        || [ -n "${protected_version_ids[$index]}" ]; then
      [[ "${protected_keys[$index]}" == "$expected_prefix"* \
          && "${protected_version_ids[$index]}" =~ ^[A-Za-z0-9._~+=:/-]{1,1024}$ ]] \
        || die "version deletion protection identity is incomplete or unsafe"
    fi
  done
  render_version_delete_rows "$plan" "$expected_prefix" "$rows"
  while IFS=$'\t' read -r key version_id kind extra; do
    [ -z "$extra" ] && [ -n "$key" ] && [ -n "$version_id" ] \
      || die "version deletion row could not be parsed safely"
    if { [ "$key" = "${protected_keys[0]}" ] \
          && [ "$version_id" = "${protected_version_ids[0]}" ]; } \
        || { [ "$key" = "${protected_keys[1]}" ] \
          && [ "$version_id" = "${protected_version_ids[1]}" ]; }; then
      continue
    fi
    if ! aws_s3api delete-object \
      --bucket "$NEXUS_DR_S3_BUCKET" \
      --key "$key" \
      --version-id "$version_id" >/dev/null; then
      die "versioned retention deletion failed for $kind: $key version $version_id"
    fi
  done <"$rows"
}

prune_versioned_count_tier() {
  local tier="$1" retain="$2"
  local protected_key="${3:-}" protected_version_id="${4:-}"
  local listing="$tmp_dir/$tier-version-listing.json"
  local plan="$tmp_dir/$tier-version-delete-plan.json"
  [ "$NEXUS_DR_STORAGE_PROVIDER:$NEXUS_DR_STORAGE_CONTROL_MODE" = aws-s3:versioned-s3 ] \
    || die "versioned count retention requires aws-s3:versioned-s3"
  list_versioned_objects "$database_root/$tier/" "$listing" "database-$tier"
  "$NEXUS_DR_PYTHON_BIN" "$VERSION_RETENTION_HELPER" \
    --listing "$listing" --prefix "$database_root" --output "$plan" \
    count --tier "$tier" --retain "$retain"
  execute_version_deletion_plan "$plan" "$database_root/$tier/" \
    "$protected_key" "$protected_version_id"
}

prune_visible_count_tier() {
  local tier="$1" retain="$2" protected_key="${3:-}"
  local listing="$tmp_dir/$tier-visible-listing.json"
  local plan="$tmp_dir/$tier-visible-delete-plan.txt"
  [ "$NEXUS_DR_STORAGE_PROVIDER:$NEXUS_DR_STORAGE_CONTROL_MODE" = cloudflare-r2:r2-approved-variance ] \
    || die "visible count retention is restricted to the approved R2 variance"
  if [ -n "$protected_key" ]; then
    [[ "$protected_key" == "$database_root/$tier/"nexus-db-*.sqlite.age ]] \
      || die "visible count retention protection key is unsafe"
  fi
  aws_s3api list-objects-v2 --bucket "$NEXUS_DR_S3_BUCKET" \
    --prefix "$database_root/$tier/" --output json >"$listing"
  "$NEXUS_DR_PYTHON_BIN" "$RETENTION_HELPER" \
    --listing "$listing" --prefix "$database_root" --output "$plan" \
    count --tier "$tier" --retain "$retain"
  while IFS= read -r key; do
    [ -n "$key" ] || continue
    if [ -n "$protected_key" ] && [ "$key" = "$protected_key" ]; then
      continue
    fi
    case "$key" in
      "$database_root/$tier/"nexus-db-*.sqlite.age) ;;
      *) die "retention helper returned an unsafe database key" ;;
    esac
    if ! aws_s3api delete-object \
      --bucket "$NEXUS_DR_S3_BUCKET" --key "$key" >/dev/null; then
      die "R2 visible retention deletion failed: $key"
    fi
  done <"$plan"
}

prune_count_tier() {
  case "$NEXUS_DR_STORAGE_PROVIDER:$NEXUS_DR_STORAGE_CONTROL_MODE" in
    aws-s3:versioned-s3) prune_versioned_count_tier "$@" ;;
    cloudflare-r2:r2-approved-variance) prune_visible_count_tier "$@" ;;
    *) die "unsupported storage mode reached count retention" ;;
  esac
}

confirm_database_after_retention() {
  local downloaded="$tmp_dir/database-post-retention.age"
  local confirmed_epoch
  local -a get_args=(--bucket "$NEXUS_DR_S3_BUCKET" --key "$hourly_key")
  if [ "$NEXUS_DR_STORAGE_PROVIDER" = aws-s3 ]; then
    get_args+=(--version-id "$hourly_database_version_id")
  fi
  verify_remote_object "$hourly_key" "$encrypted_sha" "$plaintext_sha" \
    NexusApplicationSqliteRecoveryPointV1 "$(size_file "$encrypted")" \
    "$created_epoch" "" "$hourly_database_version_id"
  if [ "$NEXUS_DR_STORAGE_PROVIDER" = aws-s3 ] \
      && [ "$LAST_VERIFIED_VERSION_ID" != "$hourly_database_version_id" ]; then
    die "post-retention hourly database VersionId changed"
  fi
  aws_s3api get-object "${get_args[@]}" "$downloaded" >/dev/null
  [ "$(size_file "$downloaded")" = "$(size_file "$encrypted")" ] \
    || die "post-retention hourly database object size changed"
  [ "$(sha256_file "$downloaded")" = "$encrypted_sha" ] \
    || die "post-retention hourly database encrypted digest changed"
  confirmed_epoch="$(date -u +%s)"
  [[ "$confirmed_epoch" =~ ^[0-9]+$ ]] \
    || die "hourly database confirmation time is invalid"
  database_confirmed_at="$("$NEXUS_DR_PYTHON_BIN" - "$confirmed_epoch" <<'PY'
from datetime import datetime, timezone
import sys

print(datetime.fromtimestamp(int(sys.argv[1]), timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"))
PY
)"
  rm -f -- "$downloaded"
}

prune_versioned_release_age() {
  local protected_key_one="${1:-}" protected_version_id_one="${2:-}"
  local protected_key_two="${3:-}" protected_version_id_two="${4:-}"
  local listing="$tmp_dir/releases-version-listing.json"
  local plan="$tmp_dir/releases-version-delete-plan.json"
  [ "$NEXUS_DR_STORAGE_PROVIDER:$NEXUS_DR_STORAGE_CONTROL_MODE" = aws-s3:versioned-s3 ] \
    || die "versioned release retention requires aws-s3:versioned-s3"
  list_versioned_objects "$NEXUS_DR_S3_PREFIX/releases/" "$listing" "releases"
  "$NEXUS_DR_PYTHON_BIN" "$VERSION_RETENTION_HELPER" \
    --listing "$listing" --prefix "$NEXUS_DR_S3_PREFIX" --output "$plan" \
    age --days 90 --now-epoch "$created_epoch" --grace-seconds 3600
  execute_version_deletion_plan "$plan" "$NEXUS_DR_S3_PREFIX/releases/" \
    "$protected_key_one" "$protected_version_id_one" \
    "$protected_key_two" "$protected_version_id_two"
}

prune_visible_release_age() {
  local protected_key_one="${1:-}" protected_key_two="${2:-}"
  local listing="$tmp_dir/releases-visible-listing.json"
  local plan="$tmp_dir/releases-visible-delete-plan.txt"
  local protected_key
  [ "$NEXUS_DR_STORAGE_PROVIDER:$NEXUS_DR_STORAGE_CONTROL_MODE" = cloudflare-r2:r2-approved-variance ] \
    || die "visible release retention is restricted to the approved R2 variance"
  for protected_key in "$protected_key_one" "$protected_key_two"; do
    [ -z "$protected_key" ] \
      || [[ "$protected_key" == "$NEXUS_DR_S3_PREFIX/releases/"v*.tar.gz.*.age ]] \
      || die "visible retention protection key is unsafe"
  done
  aws_s3api list-objects-v2 --bucket "$NEXUS_DR_S3_BUCKET" \
    --prefix "$NEXUS_DR_S3_PREFIX/releases/" --output json >"$listing"
  "$NEXUS_DR_PYTHON_BIN" "$RETENTION_HELPER" \
    --listing "$listing" --prefix "$NEXUS_DR_S3_PREFIX" --output "$plan" \
    age --days 90 --now-epoch "$created_epoch"
  while IFS= read -r key; do
    [ -n "$key" ] || continue
    if [ "$key" = "$protected_key_one" ] \
        || [ "$key" = "$protected_key_two" ]; then
      continue
    fi
    case "$key" in
      "$NEXUS_DR_S3_PREFIX/releases/"v*.tar.gz.*.age) ;;
      *) die "retention helper returned an unsafe release key" ;;
    esac
    if ! aws_s3api delete-object \
      --bucket "$NEXUS_DR_S3_BUCKET" --key "$key" >/dev/null; then
      die "R2 visible retention deletion failed: $key"
    fi
  done <"$plan"
}

prune_release_age() {
  case "$NEXUS_DR_STORAGE_PROVIDER:$NEXUS_DR_STORAGE_CONTROL_MODE" in
    aws-s3:versioned-s3) prune_versioned_release_age "$@" ;;
    cloudflare-r2:r2-approved-variance)
      prune_visible_release_age "${1:-}" "${3:-}"
      ;;
    *) die "unsupported storage mode reached release retention" ;;
  esac
}
# END version-aware S3 retention functions

confirm_required_release_after_retention() {
  local head="$tmp_dir/required-release-post-retention-head.json"
  local encrypted="$tmp_dir/required-release-post-retention.age"
  local confirmed_epoch confirmation_fields
  local -a head_args=(--bucket "$NEXUS_DR_S3_BUCKET" --key "$required_release_key")
  local -a get_args=(--bucket "$NEXUS_DR_S3_BUCKET" --key "$required_release_key")
  [ "$required_release_prepared" = true ] \
    || die "required release was not prepared for post-retention confirmation"
  if [ "$NEXUS_DR_STORAGE_PROVIDER" = aws-s3 ]; then
    head_args+=(--version-id "$required_release_version_id")
    get_args+=(--version-id "$required_release_version_id")
  fi
  aws_s3api head-object "${head_args[@]}" >"$head"
  aws_s3api get-object "${get_args[@]}" "$encrypted" >/dev/null
  confirmed_epoch="$(date -u +%s)"
  [[ "$confirmed_epoch" =~ ^[0-9]+$ ]] \
    || die "required release confirmation time is invalid"
  confirmation_fields="$("$NEXUS_DR_PYTHON_BIN" - "$head" "$encrypted" \
    "$NEXUS_DR_STORAGE_PROVIDER" "$NEXUS_DR_STORAGE_CONTROL_MODE" \
    "$required_release_version_id" "$required_release_retain_until" \
    "$required_release_encrypted_sha" "$required_release_sha" \
    "$required_release_basename" "$required_release_encrypted_size" \
    "$required_release_created_epoch" "$confirmed_epoch" <<'PY'
from datetime import datetime, timezone
import hashlib
import json
import os
import re
import sys

(
    head_path,
    encrypted_path,
    provider,
    control_mode,
    expected_version_id,
    expected_retain_until,
    expected_encrypted_sha,
    expected_plaintext_sha,
    expected_original_name,
    expected_size_raw,
    expected_created_epoch,
    confirmed_epoch_raw,
) = sys.argv[1:]
try:
    value = json.load(open(head_path, encoding="utf-8"))
except (OSError, json.JSONDecodeError) as error:
    raise SystemExit(f"post-retention required release head is unreadable: {error}")
if not isinstance(value, dict):
    raise SystemExit("post-retention required release head is invalid")
metadata_value = value.get("Metadata")
if not isinstance(metadata_value, dict):
    raise SystemExit("post-retention required release metadata is invalid")
metadata = {
    str(key).lower(): str(item)
    for key, item in metadata_value.items()
}
if (
    metadata.get("schema-version") != "NexusReleaseRollbackEscrowV1"
    or metadata.get("encrypted-sha256") != expected_encrypted_sha
    or metadata.get("plaintext-sha256") != expected_plaintext_sha
    or metadata.get("original-name") != expected_original_name
    or metadata.get("created-epoch") != expected_created_epoch
    or not re.fullmatch(r"[0-9a-f]{64}", expected_encrypted_sha)
    or not re.fullmatch(r"[0-9a-f]{64}", expected_plaintext_sha)
    or not re.fullmatch(r"[0-9]+", expected_created_epoch)
):
    raise SystemExit("post-retention required release metadata identity changed")
try:
    expected_size = int(expected_size_raw)
except ValueError as error:
    raise SystemExit("required release expected size is invalid") from error
content_length = value.get("ContentLength")
if (
    expected_size <= 0
    or not isinstance(content_length, int)
    or isinstance(content_length, bool)
    or content_length != expected_size
    or os.path.getsize(encrypted_path) != expected_size
):
    raise SystemExit("post-retention required release object size changed")
digest = hashlib.sha256()
with open(encrypted_path, "rb") as source:
    for chunk in iter(lambda: source.read(1024 * 1024), b""):
        digest.update(chunk)
if digest.hexdigest() != expected_encrypted_sha:
    raise SystemExit("post-retention required release encrypted digest changed")

retain_until = ""
if provider == "aws-s3" and control_mode == "versioned-s3":
    version_id = value.get("VersionId")
    if (
        not re.fullmatch(r"[A-Za-z0-9._~+=:/-]{1,1024}", version_id or "")
        or version_id != expected_version_id
    ):
        raise SystemExit("post-retention required release VersionId changed")
    if value.get("ObjectLockMode") != "COMPLIANCE":
        raise SystemExit("post-retention required release object lock mode is invalid")
    try:
        retained = datetime.fromisoformat(
            str(value.get("ObjectLockRetainUntilDate", "")).replace("Z", "+00:00"),
        )
    except ValueError as error:
        raise SystemExit(
            "post-retention required release deadline is invalid",
        ) from error
    if retained.tzinfo is None:
        raise SystemExit("post-retention required release deadline has no timezone")
    retain_until = retained.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    if (
        retain_until != expected_retain_until
        or int(retained.astimezone(timezone.utc).timestamp())
            < int(confirmed_epoch_raw) + 90 * 86400
    ):
        raise SystemExit(
            "post-retention required release deadline does not cover confirmation",
        )
elif provider == "cloudflare-r2" and control_mode == "r2-approved-variance":
    if (
        expected_version_id
        or expected_retain_until
        or value.get("VersionId") not in (None, "null")
        or value.get("ObjectLockMode") not in (None, "")
        or value.get("ObjectLockRetainUntilDate") not in (None, "")
    ):
        raise SystemExit("post-retention required release R2 variance changed")
else:
    raise SystemExit("post-retention required release storage mode is invalid")

confirmed_at = datetime.fromtimestamp(
    int(confirmed_epoch_raw),
    timezone.utc,
).strftime("%Y-%m-%dT%H:%M:%SZ")
print(confirmed_at, retain_until, sep="|")
PY
)" || die "post-retention required release confirmation failed"
  IFS='|' read -r required_release_confirmed_at \
    required_release_retain_until <<<"$confirmation_fields"
  [ -n "$required_release_confirmed_at" ] \
    || die "post-retention required release confirmation time is missing"
  rm -f -- "$encrypted"
  required_release_confirmed=true
}

confirm_current_recovery_after_retention() {
  local head="$tmp_dir/current-recovery-post-retention-head.json"
  local encrypted="$tmp_dir/current-recovery-post-retention.age"
  local confirmed_epoch confirmation_fields
  local -a head_args=(--bucket "$NEXUS_DR_S3_BUCKET" --key "$required_recovery_key")
  local -a get_args=(--bucket "$NEXUS_DR_S3_BUCKET" --key "$required_recovery_key")
  if [ "$NEXUS_DR_STORAGE_PROVIDER" = aws-s3 ]; then
    head_args+=(--version-id "$required_recovery_version_id")
    get_args+=(--version-id "$required_recovery_version_id")
  fi
  aws_s3api head-object "${head_args[@]}" >"$head"
  aws_s3api get-object "${get_args[@]}" "$encrypted" >/dev/null
  confirmed_epoch="$(date -u +%s)"
  [[ "$confirmed_epoch" =~ ^[0-9]+$ ]] \
    || die "current recovery runtime confirmation time is invalid"
  confirmation_fields="$("$NEXUS_DR_PYTHON_BIN" - "$head" "$encrypted" \
    "$NEXUS_DR_STORAGE_PROVIDER" "$NEXUS_DR_STORAGE_CONTROL_MODE" \
    "$required_recovery_version_id" \
    "$required_recovery_retain_until" "$required_recovery_archive_sha" \
    "$recovery_basename" "$confirmed_epoch" <<'PY'
from datetime import datetime, timezone
import hashlib
import json
import os
import re
import sys

(
    head_path,
    encrypted_path,
    provider,
    control_mode,
    expected_version_id,
    expected_retain_until,
    expected_plaintext_sha,
    expected_original_name,
    confirmed_epoch_raw,
) = sys.argv[1:]
try:
    value = json.load(open(head_path, encoding="utf-8"))
except (OSError, json.JSONDecodeError) as error:
    raise SystemExit(f"post-retention recovery head is unreadable: {error}")
if not isinstance(value, dict):
    raise SystemExit("post-retention recovery head is invalid")
metadata_value = value.get("Metadata")
if not isinstance(metadata_value, dict):
    raise SystemExit("post-retention recovery metadata is invalid")
metadata = {
    str(key).lower(): str(item)
    for key, item in metadata_value.items()
}
encrypted_sha = metadata.get("encrypted-sha256", "")
if (
    metadata.get("schema-version") != "NexusCurrentRecoveryRuntimeV1"
    or metadata.get("plaintext-sha256") != expected_plaintext_sha
    or metadata.get("original-name") != expected_original_name
    or not re.fullmatch(r"[0-9a-f]{64}", encrypted_sha)
):
    raise SystemExit("post-retention recovery metadata identity is invalid")
content_length = value.get("ContentLength")
if (
    not isinstance(content_length, int)
    or isinstance(content_length, bool)
    or content_length <= 0
    or os.path.getsize(encrypted_path) != content_length
):
    raise SystemExit("post-retention recovery object size is invalid")
digest = hashlib.sha256()
with open(encrypted_path, "rb") as source:
    for chunk in iter(lambda: source.read(1024 * 1024), b""):
        digest.update(chunk)
if digest.hexdigest() != encrypted_sha:
    raise SystemExit("post-retention recovery encrypted digest is invalid")

retain_until = ""
if provider == "aws-s3" and control_mode == "versioned-s3":
    version_id = value.get("VersionId")
    if (
        not re.fullmatch(r"[A-Za-z0-9._~+=:/-]{1,1024}", version_id or "")
        or version_id != expected_version_id
    ):
        raise SystemExit("post-retention recovery VersionId changed")
    if value.get("ObjectLockMode") != "COMPLIANCE":
        raise SystemExit("post-retention recovery object lock mode is invalid")
    try:
        retained = datetime.fromisoformat(
            str(value.get("ObjectLockRetainUntilDate", "")).replace("Z", "+00:00"),
        )
    except ValueError as error:
        raise SystemExit("post-retention recovery deadline is invalid") from error
    if retained.tzinfo is None:
        raise SystemExit("post-retention recovery deadline has no timezone")
    retain_until = retained.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    if (
        retain_until != expected_retain_until
        or int(retained.astimezone(timezone.utc).timestamp())
            < int(confirmed_epoch_raw) + 90 * 86400
    ):
        raise SystemExit(
            "post-retention recovery deadline does not cover confirmation",
        )
else:
    if (
        provider != "cloudflare-r2"
        or control_mode != "r2-approved-variance"
        or expected_version_id
        or expected_retain_until
        or value.get("VersionId") not in (None, "null")
        or value.get("ObjectLockMode") not in (None, "")
        or value.get("ObjectLockRetainUntilDate") not in (None, "")
    ):
        raise SystemExit("post-retention R2 variance identity is invalid")

confirmed_at = datetime.fromtimestamp(
    int(confirmed_epoch_raw),
    timezone.utc,
).strftime("%Y-%m-%dT%H:%M:%SZ")
print(confirmed_at, retain_until, sep="|")
PY
)" || die "post-retention current recovery confirmation failed"
  IFS='|' read -r required_recovery_confirmed_at \
    required_recovery_retain_until <<<"$confirmation_fields"
  [ -n "$required_recovery_confirmed_at" ] \
    || die "post-retention current recovery confirmation time is missing"
  rm -f -- "$encrypted"
}

prune_count_tier hourly 24 "$hourly_key" "$hourly_database_version_id"
prune_count_tier daily 7
prune_count_tier weekly 4
prune_count_tier monthly 6
database_confirmed_at=""
confirm_database_after_retention

release_count=0
required_release_confirmed=false
required_release_prepared=false
required_release_sha=""
required_release_key=""
required_release_basename=""
required_release_encrypted_sha=""
required_release_encrypted_size=""
required_release_created_epoch=""
required_release_version_id=""
required_release_retain_until=""
required_release_confirmed_at=""
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
  release_encrypted_sha=""
  release_encrypted_size=""
  release_created_epoch=""
  release_version_id=""
  release_retain_until=""
  release_requires_fresh_retention=false
  if [ -n "$REQUIRED_RELEASE" ] && [ "$archive" = "$REQUIRED_RELEASE" ]; then
    release_requires_fresh_retention=true
  fi
  if [ "$release_requires_fresh_retention" != true ] \
      && aws_s3api head-object --bucket "$NEXUS_DR_S3_BUCKET" \
        --key "$release_key" >"$release_head" 2>/dev/null; then
    release_fields="$("$NEXUS_DR_PYTHON_BIN" - "$release_head" "$archive_sha" \
      "$basename" "$NEXUS_DR_STORAGE_PROVIDER" "$NEXUS_DR_STORAGE_CONTROL_MODE" \
      "$created_epoch" "$release_requires_fresh_retention" <<'PY'
from datetime import datetime, timezone
import json
import re
import sys

(
    head_path,
    expected_plaintext_sha,
    expected_original_name,
    provider,
    control_mode,
    minimum_epoch_raw,
    require_fresh_retention_raw,
) = sys.argv[1:]
try:
    value = json.load(open(head_path, encoding="utf-8"))
except (OSError, json.JSONDecodeError) as error:
    raise SystemExit(f"existing release escrow head is unreadable: {error}")
if not isinstance(value, dict) or not isinstance(value.get("Metadata"), dict):
    raise SystemExit("existing release escrow head is invalid")
metadata = {str(key).lower(): str(item) for key, item in value.get("Metadata", {}).items()}
if (
    metadata.get("plaintext-sha256") != expected_plaintext_sha
    or metadata.get("original-name") != expected_original_name
):
    raise SystemExit("existing release escrow metadata does not match the local rollback bundle")
if metadata.get("schema-version") != "NexusReleaseRollbackEscrowV1":
    raise SystemExit("existing release escrow schema is invalid")
encrypted_sha = metadata.get("encrypted-sha256", "")
if not re.fullmatch(r"[0-9a-f]{64}", encrypted_sha):
    raise SystemExit("existing release escrow encrypted digest is invalid")
content_length = value.get("ContentLength")
if (
    not isinstance(content_length, int)
    or isinstance(content_length, bool)
    or content_length <= 0
):
    raise SystemExit("existing release escrow object is empty")
created = metadata.get("created-epoch", "")
if not re.fullmatch(r"[0-9]+", created):
    raise SystemExit("existing release escrow created epoch is invalid")
if require_fresh_retention_raw not in {"true", "false"}:
    raise SystemExit("existing release escrow retention policy is invalid")
version_id = ""
retain_until = ""
if provider == "aws-s3" and control_mode == "versioned-s3":
    version_id = value.get("VersionId", "")
    if not re.fullmatch(r"[A-Za-z0-9._~+=:/-]{1,1024}", version_id):
        raise SystemExit("existing release escrow exact VersionId is invalid")
    if value.get("ObjectLockMode") != "COMPLIANCE":
        raise SystemExit("existing release escrow is missing S3 compliance retention")
    try:
        retention = datetime.fromisoformat(
            str(value.get("ObjectLockRetainUntilDate", "")).replace("Z", "+00:00"),
        )
    except ValueError as error:
        raise SystemExit(
            "existing release escrow S3 retention timestamp is invalid",
        ) from error
    if (
        retention.tzinfo is None
        or int(retention.astimezone(timezone.utc).timestamp())
            < (
                int(minimum_epoch_raw)
                if require_fresh_retention_raw == "true"
                else int(created)
            ) + 90 * 86400
    ):
        raise SystemExit(
            "existing release escrow S3 retention does not cover this confirmation",
        )
    retain_until = retention.astimezone(timezone.utc).strftime(
        "%Y-%m-%dT%H:%M:%SZ",
    )
elif provider == "cloudflare-r2" and control_mode == "r2-approved-variance":
    if (
        value.get("VersionId") not in (None, "null")
        or value.get("ObjectLockMode") not in (None, "")
        or value.get("ObjectLockRetainUntilDate") not in (None, "")
    ):
        raise SystemExit("existing release escrow R2 variance is invalid")
else:
    raise SystemExit("existing release escrow storage mode is invalid")
print(
    encrypted_sha,
    content_length,
    created,
    version_id,
    retain_until,
    sep="|",
)
PY
)" || die "existing release escrow identity did not verify: $basename"
    IFS='|' read -r release_encrypted_sha release_encrypted_size \
      release_created_epoch release_version_id release_retain_until \
      <<<"$release_fields"
  else
    release_encrypted="$tmp_dir/$basename.$archive_sha.age"
    age --encrypt --recipient "$NEXUS_DR_AGE_RECIPIENT" --output "$release_encrypted" "$archive"
    [ -s "$release_encrypted" ] || die "age produced an empty release escrow object"
    chmod 0600 "$release_encrypted"
    [ "$(sha256_file "$archive")" = "$archive_sha" ] \
      || die "rollback bundle changed while it was being encrypted: $basename"
    release_encrypted_sha="$(sha256_file "$release_encrypted")"
    release_encrypted_size="$(size_file "$release_encrypted")"
    release_created_epoch="$created_epoch"
    put_encrypted_object "$release_key" "$release_encrypted" "$release_encrypted_sha" \
      "$archive_sha" NexusReleaseRollbackEscrowV1 "$created_epoch" "$basename"
    release_version_id="$LAST_VERIFIED_VERSION_ID"
    release_retain_until="$LAST_VERIFIED_RETAIN_UNTIL"
    rm -f -- "$release_encrypted"
  fi
  if [ -n "$REQUIRED_RELEASE" ] && [ "$archive" = "$REQUIRED_RELEASE" ]; then
    required_release_prepared=true
    required_release_sha="$archive_sha"
    required_release_key="$release_key"
    required_release_basename="$basename"
    required_release_encrypted_sha="$release_encrypted_sha"
    required_release_encrypted_size="$release_encrypted_size"
    required_release_created_epoch="$release_created_epoch"
    required_release_version_id="$release_version_id"
    required_release_retain_until="$release_retain_until"
  fi
  release_count=$((release_count + 1))
done

if [ -n "$REQUIRED_RELEASE" ] && [ "$required_release_prepared" != true ]; then
  die "required release escrow was not prepared for confirmation"
fi
if [ "$required_release_prepared" = true ] \
    && [ "$NEXUS_DR_STORAGE_PROVIDER" = aws-s3 ]; then
  [[ "$required_release_version_id" =~ ^[A-Za-z0-9._~+=:/-]{1,1024}$ ]] \
    || die "required release is missing its exact S3 VersionId"
  required_release_retain_until="$(
    validate_aws_retain_until "$required_release_retain_until" \
      "required release" "$created_epoch"
  )" || die "required release retention is insufficient"
fi

required_recovery_confirmed=false
required_recovery_archive_sha=""
required_recovery_key=""
required_recovery_version_id=""
required_recovery_retain_until=""
required_recovery_confirmed_at=""
required_recovery_encrypted_sha=""
required_recovery_encrypted_size=""
required_recovery_manifest_sha=""
required_recovery_staging_sha=""
if [ -n "$REQUIRED_RECOVERY_RUNTIME" ]; then
  recovery_archive="$tmp_dir/current-recovery-runtime.tar.gz"
  "$NEXUS_DR_PYTHON_BIN" "$RECOVERY_ARCHIVE_HELPER" pack \
    --root "$REQUIRED_RECOVERY_RUNTIME" \
    --descriptor "$RECOVERY_DESCRIPTOR" \
    --manifest "$RECOVERY_RELEASE_MANIFEST" \
    --staging-attestation "$RECOVERY_STAGING_ATTESTATION" \
    --output "$recovery_archive" >"$tmp_dir/current-recovery-pack.json"
  chmod 0600 "$recovery_archive" "$tmp_dir/current-recovery-pack.json"
  "$NEXUS_DR_PYTHON_BIN" "$RECOVERY_ARCHIVE_HELPER" inspect \
    --archive "$recovery_archive" >"$tmp_dir/current-recovery-inspect.json"
  chmod 0600 "$tmp_dir/current-recovery-inspect.json"
  required_recovery_archive_sha="$(sha256_file "$recovery_archive")"
  recovery_fields="$("$NEXUS_DR_PYTHON_BIN" - "$tmp_dir/current-recovery-inspect.json" \
    "$RECOVERY_RUNTIME_SHA" "$RECOVERY_ARTIFACT_DIGEST" "$RECOVERY_INSTALLED_RUNTIME_DIGEST" \
    "$RECOVERY_RUNTIME_DIGEST" <<'PY'
import json
import re
import sys

path, runtime_sha, artifact, installed, recovery = sys.argv[1:]
value = json.load(open(path, encoding="utf-8"))
identity = value.get("identity", {})
if (
    value.get("schemaVersion") != "NexusCurrentRecoveryRuntimeArchiveV1"
    or value.get("status") != "passed"
    or identity.get("runtimeSha") != runtime_sha
    or identity.get("artifactDigest") != artifact
    or identity.get("installedRuntimeDigest") != installed
    or identity.get("recoveryRuntimeDigest") != recovery
    or not re.fullmatch(r"[A-Za-z0-9.+-]+", identity.get("packageVersion", ""))
):
    raise SystemExit("current recovery archive identity is invalid")
print(
    identity["packageVersion"],
    identity["releaseManifestSha256"],
    identity["stagingAttestationSha256"],
    sep="\t",
)
PY
)" || die "current recovery archive inspection failed"
  IFS=$'\t' read -r recovery_version required_recovery_manifest_sha \
    required_recovery_staging_sha <<<"$recovery_fields"
  recovery_basename="v${recovery_version}+current-${RECOVERY_RUNTIME_SHA}+escrow-${RECOVERY_ESCROW_ID}+phase-${RECOVERY_ESCROW_PHASE}.tar.gz"
  required_recovery_key="$NEXUS_DR_S3_PREFIX/releases/$recovery_basename.$required_recovery_archive_sha.age"
  recovery_encrypted="$tmp_dir/$recovery_basename.$required_recovery_archive_sha.age"
  age --encrypt --recipient "$NEXUS_DR_AGE_RECIPIENT" \
    --output "$recovery_encrypted" "$recovery_archive"
  [ -s "$recovery_encrypted" ] || die "age produced an empty current recovery runtime"
  chmod 0600 "$recovery_encrypted"
  [ "$(sha256_file "$recovery_archive")" = "$required_recovery_archive_sha" ] \
    || die "current recovery runtime changed during encryption"
  required_recovery_encrypted_sha="$(sha256_file "$recovery_encrypted")"
  required_recovery_encrypted_size="$(size_file "$recovery_encrypted")"
  put_encrypted_object "$required_recovery_key" "$recovery_encrypted" \
    "$required_recovery_encrypted_sha" "$required_recovery_archive_sha" \
    NexusCurrentRecoveryRuntimeV1 "$created_epoch" "$recovery_basename"
  required_recovery_version_id="$LAST_VERIFIED_VERSION_ID"
  required_recovery_retain_until="$LAST_VERIFIED_RETAIN_UNTIL"
  rm -f -- "$recovery_encrypted"
  if [ "$NEXUS_DR_STORAGE_PROVIDER" = aws-s3 ]; then
    [[ "$required_recovery_version_id" =~ ^[A-Za-z0-9._~+=:/-]{1,1024}$ ]] \
      || die "current recovery runtime confirmation is missing its exact S3 VersionId"
    required_recovery_retain_until="$(
      validate_aws_retain_until "$required_recovery_retain_until" \
        "current recovery runtime" "$created_epoch"
    )" || die "current recovery runtime retention is insufficient"
  fi
fi

prune_release_age \
  "$required_release_key" "$required_release_version_id" \
  "$required_recovery_key" "$required_recovery_version_id"
if [ -n "$REQUIRED_RELEASE" ]; then
  confirm_required_release_after_retention
fi
if [ -n "$REQUIRED_RECOVERY_RUNTIME" ]; then
  confirm_current_recovery_after_retention
  required_recovery_confirmed=true
fi

if [ "$JSON_OUTPUT" = true ]; then
  "$NEXUS_DR_PYTHON_BIN" - "$hourly_key" "$plaintext_sha" \
    "$encrypted_sha" "$(size_file "$encrypted")" \
    "$hourly_database_version_id" "$database_confirmed_at" \
    "$release_count" "$REQUIRED_RELEASE" \
    "$required_release_sha" "$required_release_key" \
    "$required_release_encrypted_sha" "$required_release_encrypted_size" \
    "$NEXUS_DR_STORAGE_PROVIDER" \
    "$NEXUS_DR_STORAGE_CONTROL_MODE" "$required_release_confirmed_at" \
    "$required_release_retain_until" "$required_release_version_id" \
    "$required_release_confirmed" "$REQUIRED_RECOVERY_RUNTIME" \
    "$required_recovery_archive_sha" "$required_recovery_key" \
    "$required_recovery_encrypted_sha" "$required_recovery_encrypted_size" \
    "$RECOVERY_RUNTIME_SHA" \
    "$RECOVERY_ARTIFACT_DIGEST" "$RECOVERY_INSTALLED_RUNTIME_DIGEST" \
    "$RECOVERY_RUNTIME_DIGEST" "$required_recovery_manifest_sha" \
    "$required_recovery_staging_sha" "$RECOVERY_ESCROW_ID" "$RECOVERY_ESCROW_PHASE" \
    "$required_recovery_confirmed_at" "$required_recovery_retain_until" \
    "$required_recovery_version_id" "$required_recovery_confirmed" <<'PY'
import json
import sys
(
    database_key,
    database_sha,
    database_encrypted_sha,
    database_encrypted_size,
    database_version_id,
    database_confirmed_at,
    count,
    required_path,
    release_sha,
    release_key,
    release_encrypted_sha,
    release_encrypted_size,
    provider,
    control_mode,
    release_confirmed_at,
    release_retain_until,
    release_version_id,
    release_confirmed,
    recovery_path,
    recovery_sha,
    recovery_key,
    recovery_encrypted_sha,
    recovery_encrypted_size,
    runtime_sha,
    artifact_digest,
    installed_digest,
    recovery_digest,
    manifest_sha,
    staging_sha,
    recovery_escrow_id,
    recovery_escrow_phase,
    recovery_confirmed_at,
    recovery_retain_until,
    recovery_version_id,
    recovery_confirmed,
) = sys.argv[1:]
print(json.dumps({
    "schema": "nexus.application-dr-backup-result.v1",
    "status": "passed",
    "encrypted": True,
    "storageProvider": provider,
    "storageControlMode": control_mode,
    "releasePrefixLockVerified": True,
    "databaseKey": database_key,
    "databaseSha256": database_sha,
    "databaseEncryptedSha256": database_encrypted_sha,
    "databaseEncryptedSizeBytes": int(database_encrypted_size),
    "databaseObjectVersionId": database_version_id or None,
    "databaseConfirmedAt": database_confirmed_at,
    "databaseRetentionVariance": (
        "r2-approved-variance"
        if provider == "cloudflare-r2"
        else None
    ),
    "databaseApprovedUnversionedVariance": provider == "cloudflare-r2",
    "releaseBundles": int(count),
    "requiredRelease": None if not required_path else {
        "path": required_path,
        "plaintextSha256": release_sha,
        "objectKey": release_key,
        "encryptedSha256": release_encrypted_sha,
        "encryptedSizeBytes": int(release_encrypted_size),
        "confirmedAt": release_confirmed_at,
        "retainUntil": release_retain_until or None,
        "objectVersionId": release_version_id or None,
        "retentionVariance": (
            "r2-approved-variance"
            if provider == "cloudflare-r2"
            else None
        ),
        "approvedUnversionedVariance": provider == "cloudflare-r2",
        "confirmed": release_confirmed == "true",
    },
    "requiredRecoveryRuntime": None if not recovery_path else {
        "path": recovery_path,
        "plaintextSha256": recovery_sha,
        "objectKey": recovery_key,
        "encryptedSha256": recovery_encrypted_sha,
        "encryptedSizeBytes": int(recovery_encrypted_size),
        "runtimeSha": runtime_sha,
        "artifactDigest": artifact_digest,
        "installedRuntimeDigest": installed_digest,
        "recoveryRuntimeDigest": recovery_digest,
        "releaseManifestSha256": manifest_sha,
        "stagingAttestationSha256": staging_sha,
        "escrowId": recovery_escrow_id,
        "escrowPhase": recovery_escrow_phase,
        "confirmedAt": recovery_confirmed_at,
        "retainUntil": recovery_retain_until or None,
        "objectVersionId": recovery_version_id or None,
        "retentionVariance": (
            "r2-approved-variance"
            if provider == "cloudflare-r2"
            else None
        ),
        "approvedUnversionedVariance": provider == "cloudflare-r2",
        "confirmed": recovery_confirmed == "true",
    },
}, separators=(",", ":")))
PY
else
  echo "application_dr_backup_complete encrypted=true storageProvider=$NEXUS_DR_STORAGE_PROVIDER storageControlMode=$NEXUS_DR_STORAGE_CONTROL_MODE releasePrefixLock=verified databaseKey=$hourly_key databaseSha256=$plaintext_sha releaseBundles=$release_count databaseRetention=24,7,4,6 releaseRetentionDays=90"
fi
