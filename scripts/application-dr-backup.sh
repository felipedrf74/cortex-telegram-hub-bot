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

trusted_root_executable() {
  local path="$1" label="$2" owner mode
  [[ "$path" == /* && "$path" != / && -f "$path" && ! -L "$path" && -x "$path" ]] \
    || die "$label must be an absolute executable non-symlink regular file"
  [ "$(realpath -e -- "$path")" = "$path" ] || die "$label must not traverse symlinks"
  owner="$(stat -c '%U' -- "$path")"
  mode="$(stat -c '%a' -- "$path")"
  [ "$owner" = root ] || die "$label must be root-owned"
  (( (8#$mode & 0022) == 0 )) || die "$label must not be group/world writable"
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
if [ "$NEXUS_DR_STORAGE_PROVIDER" = aws-s3 ]; then
  expected_aws_s3_endpoint="https://s3.${AWS_REGION:-us-east-1}.amazonaws.com"
  [ "$NEXUS_DR_S3_ENDPOINT" = "$expected_aws_s3_endpoint" ] \
    || die "AWS S3 endpoint must match the canonical configured regional endpoint"
  aws_boundary_required=(
    AWS_CONFIG_FILE
    AWS_PROFILE
    AWS_SHARED_CREDENTIALS_FILE
    AWS_EC2_METADATA_DISABLED
    NEXUS_DR_AWS_SIGNING_HELPER
    NEXUS_DR_AWS_SIGNING_HELPER_SHA256
    NEXUS_DR_AWS_BACKUP_ROLE_ARN
  )
  for key in "${aws_boundary_required[@]}"; do
    [ -n "${!key:-}" ] || die "AWS S3 configuration is missing $key"
  done
  [ "$AWS_SHARED_CREDENTIALS_FILE" = /dev/null ] \
    || die "AWS_SHARED_CREDENTIALS_FILE must be /dev/null in AWS S3 mode"
  case "$AWS_EC2_METADATA_DISABLED" in
    true|TRUE) ;;
    *) die "AWS_EC2_METADATA_DISABLED must be true in AWS S3 mode" ;;
  esac
  private_root_file "$AWS_CONFIG_FILE" "AWS credential-process configuration"
  trusted_root_executable "$NEXUS_DR_AWS_SIGNING_HELPER" "aws_signing_helper"
  [[ "$NEXUS_DR_AWS_SIGNING_HELPER_SHA256" =~ ^[a-f0-9]{64}$ ]] \
    || die "reviewed aws_signing_helper SHA-256 is invalid"
  [ "$AWS_PROFILE" = nexus-application-dr-backup ] \
    || die "AWS_PROFILE must be nexus-application-dr-backup in AWS S3 mode"
  [[ "$NEXUS_DR_AWS_BACKUP_ROLE_ARN" =~ ^arn:aws:iam::[0-9]{12}:role/[A-Za-z0-9+=,.@_/-]{1,512}$ ]] \
    || die "application DR backup role ARN is invalid"
fi

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
if [ -n "$REQUIRED_RELEASE" ] && [ "$recovery_argument_count" -ne 10 ]; then
  die "required release escrow must be bound to a complete promotion recovery transaction"
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
VERSION_RETENTION_HELPER="$SCRIPT_DIR/application-dr-version-retention.py"
STORAGE_CONTROL_HELPER="$SCRIPT_DIR/application-dr-storage-controls.py"
AWS_CREDENTIAL_BOUNDARY_HELPER="$SCRIPT_DIR/aws-credential-process-boundary.py"
RECOVERY_ARCHIVE_HELPER="$SCRIPT_DIR/application-dr-recovery-archive.py"
for helper in "$SQLITE_HELPER" "$RETENTION_HELPER" "$VERSION_RETENTION_HELPER" \
  "$STORAGE_CONTROL_HELPER" "$AWS_CREDENTIAL_BOUNDARY_HELPER" \
  "$RECOVERY_ARCHIVE_HELPER"; do
  [[ -f "$helper" && ! -L "$helper" ]] || die "installed helper is missing: $helper"
  [ "$(stat -c '%U:%G:%a' -- "$helper")" = root:root:644 ] \
    || die "installed helper must be root:root mode 0644: $helper"
done
for command in age aws flock sha256sum stat tar; do
  command -v "$command" >/dev/null 2>&1 || die "$command is required"
done
printf '' | age --encrypt --recipient "$NEXUS_DR_AGE_RECIPIENT" >/dev/null \
  || die "age recipient checksum is invalid"
if [ "$NEXUS_DR_STORAGE_PROVIDER" = aws-s3 ]; then
  "$NEXUS_DR_PYTHON_BIN" "$AWS_CREDENTIAL_BOUNDARY_HELPER" \
    --config "$AWS_CONFIG_FILE" \
    --profile "$AWS_PROFILE" \
    --region "${AWS_REGION:-us-east-1}" \
    --helper "$NEXUS_DR_AWS_SIGNING_HELPER" \
    --helper-sha256 "$NEXUS_DR_AWS_SIGNING_HELPER_SHA256" \
    --expected-role-arn "$NEXUS_DR_AWS_BACKUP_ROLE_ARN" >/dev/null
fi
"$NEXUS_DR_PYTHON_BIN" "$STORAGE_CONTROL_HELPER" \
  --evidence "$NEXUS_DR_STORAGE_CONTROL_EVIDENCE" \
  --provider "$NEXUS_DR_STORAGE_PROVIDER" \
  --control-mode "$NEXUS_DR_STORAGE_CONTROL_MODE" \
  --endpoint "$NEXUS_DR_S3_ENDPOINT" \
  --bucket "$NEXUS_DR_S3_BUCKET" \
  --prefix "$NEXUS_DR_S3_PREFIX" >/dev/null

if [ "$ACTION" = verify ]; then
  echo "application_dr_backup_config_ok encryption=age transport=s3-compatible storageProvider=$NEXUS_DR_STORAGE_PROVIDER storageControlMode=$NEXUS_DR_STORAGE_CONTROL_MODE releasePrefixLock=verified databaseRetentionPolicy=24-hourly,7-daily,4-weekly,6-monthly releaseRetentionPolicy=90-days"
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
import sys

path, label = sys.argv[1:]
try:
    value = json.load(open(path, encoding="utf-8"))
except (OSError, json.JSONDecodeError) as error:
    raise SystemExit(f"{label} is unreadable: {error}")

def valid_version_id(value):
    if not isinstance(value, str) or value == "null":
        return False
    try:
        encoded = value.encode("utf-8")
    except UnicodeEncodeError:
        return False
    return (
        1 <= len(encoded) <= 1024
        and not any(
            ord(character) < 32 or ord(character) == 127
            for character in value
        )
    )

version_id = value.get("VersionId") if isinstance(value, dict) else None
if not valid_version_id(version_id):
    raise SystemExit(f"{label} has no valid exact VersionId")
print(version_id)
PY
}

aws_version_id_is_safe() {
  local version_id="$1"
  "$NEXUS_DR_PYTHON_BIN" - "$version_id" <<'PY'
import sys

value = sys.argv[1]
try:
    encoded = value.encode("utf-8")
except UnicodeEncodeError:
    raise SystemExit(1)
if (
    value == "null"
    or not 1 <= len(encoded) <= 1024
    or any(ord(character) < 32 or ord(character) == 127 for character in value)
):
    raise SystemExit(1)
PY
}

aws_opaque_from_base64() {
  local encoded="$1" label="$2" kind="$3"
  "$NEXUS_DR_PYTHON_BIN" - "$encoded" "$label" "$kind" <<'PY'
import base64
import binascii
import sys

encoded, label, kind = sys.argv[1:]
if kind not in {"key", "version"}:
    raise SystemExit(f"{label} transport kind is invalid")
try:
    raw = base64.b64decode(encoded, validate=True)
    value = raw.decode("utf-8")
except (binascii.Error, UnicodeDecodeError) as error:
    raise SystemExit(f"{label} transport is invalid: {error}")
if (
    not 1 <= len(raw) <= 1024
    or (kind == "version" and value == "null")
    or any(ord(character) < 32 or ord(character) == 127 for character in value)
):
    raise SystemExit(f"{label} transport value is unsafe")
print(value)
PY
}

aws_retain_until_from_json() {
  local document="$1" label="$2" minimum_epoch="$3" minimum_days="$4"
  "$NEXUS_DR_PYTHON_BIN" - "$document" "$label" "$minimum_epoch" \
    "$minimum_days" <<'PY'
from datetime import datetime, timezone
import json
import sys

path, label, minimum_raw, minimum_days_raw = sys.argv[1:]
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
        < int(minimum_raw) + int(minimum_days_raw) * 86400
):
    raise SystemExit(
        f"{label} retention deadline is shorter than {minimum_days_raw} days",
    )
print(retained.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"))
PY
}

validate_aws_retain_until() {
  local retain_until="$1" label="$2" minimum_epoch="$3"
  local minimum_days="${4:-90}"
  "$NEXUS_DR_PYTHON_BIN" - "$retain_until" "$label" "$minimum_epoch" \
    "$minimum_days" <<'PY'
from datetime import datetime, timezone
import sys

raw, label, minimum_raw, minimum_days_raw = sys.argv[1:]
try:
    retained = datetime.fromisoformat(raw.replace("Z", "+00:00"))
except ValueError as error:
    raise SystemExit(f"{label} retention deadline is invalid") from error
if (
    retained.tzinfo is None
    or int(retained.astimezone(timezone.utc).timestamp())
        < int(minimum_raw) + int(minimum_days_raw) * 86400
):
    raise SystemExit(
        f"{label} retention deadline is shorter than {minimum_days_raw} days",
    )
print(retained.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"))
PY
}

aws_retain_until_for_floor() {
  local created_epoch="$1" minimum_retention_days="$2"
  "$NEXUS_DR_PYTHON_BIN" - "$created_epoch" \
    "$minimum_retention_days" <<'PY'
from datetime import datetime, timezone
import sys

retain_epoch = int(sys.argv[1]) + (int(sys.argv[2]) + 1) * 86400
print(datetime.fromtimestamp(retain_epoch, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"))
PY
}

database_key_suffixes_from_epoch() {
  local captured_epoch="$1"
  "$NEXUS_DR_PYTHON_BIN" - "$captured_epoch" <<'PY'
from datetime import datetime, timezone
import sys

captured = datetime.fromtimestamp(int(sys.argv[1]), timezone.utc)
print(
    captured.strftime("%Y%m%dT%H%M%SZ"),
    captured.strftime("%Y%m%d"),
    captured.strftime("%G-W%V"),
    captured.strftime("%Y%m"),
    sep="\t",
)
PY
}

LAST_VERIFIED_VERSION_ID=""
LAST_VERIFIED_RETAIN_UNTIL=""
LAST_VERIFIED_ENCRYPTED_SHA=""
LAST_VERIFIED_ENCRYPTED_SIZE=""
LAST_VERIFIED_CREATED_EPOCH=""
verify_remote_object() {
  local key="$1" encrypted_sha="$2" plaintext_sha="$3" schema="$4"
  local expected_size="$5" created_epoch="$6" original_name="${7:-}"
  local expected_version_id="${8:-}" minimum_retention_days="${9:-0}"
  local verified_version_id
  local head="$tmp_dir/head-$(printf '%s' "$key" | sha256sum | awk '{print $1}').json"
  local -a head_args=(--bucket "$NEXUS_DR_S3_BUCKET" --key "$key")
  if [ "$NEXUS_DR_STORAGE_PROVIDER" = aws-s3 ]; then
    head_args+=(--checksum-mode ENABLED)
    [ -z "$expected_version_id" ] || head_args+=("--version-id=$expected_version_id")
  fi
  aws_s3api head-object "${head_args[@]}" >"$head"
  verified_version_id="$("$NEXUS_DR_PYTHON_BIN" - "$head" "$encrypted_sha" \
    "$plaintext_sha" "$schema" "$expected_size" "$created_epoch" "$original_name" \
    "$NEXUS_DR_STORAGE_PROVIDER" "$expected_version_id" \
    "$minimum_retention_days" <<'PY'
import base64
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
    minimum_retention_days_raw,
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

def valid_version_id(candidate):
    if not isinstance(candidate, str) or candidate == "null":
        return False
    try:
        encoded = candidate.encode("utf-8")
    except UnicodeEncodeError:
        return False
    return (
        1 <= len(encoded) <= 1024
        and not any(
            ord(character) < 32 or ord(character) == 127
            for character in candidate
        )
    )

if provider == "aws-s3":
    try:
        checksum = base64.b64decode(
            value.get("ChecksumSHA256", ""),
            validate=True,
        ).hex()
    except (TypeError, ValueError):
        raise SystemExit("uploaded object SHA256 checksum proof is invalid")
    if checksum != encrypted:
        raise SystemExit("uploaded object SHA256 checksum did not verify")
    version_id = value.get("VersionId")
    if (
        not valid_version_id(version_id)
        or (expected_version_id and version_id != expected_version_id)
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
minimum_retention_days = int(minimum_retention_days_raw)
if minimum_retention_days < 0:
    raise SystemExit("uploaded object retention policy is invalid")
if minimum_retention_days and provider == "aws-s3":
    if value.get("ObjectLockMode") != "COMPLIANCE":
        raise SystemExit("uploaded object is missing S3 compliance retention")
    raw_retention = value.get("ObjectLockRetainUntilDate", "")
    try:
        retention = datetime.fromisoformat(raw_retention.replace("Z", "+00:00"))
    except (TypeError, ValueError):
        raise SystemExit("uploaded object S3 retention timestamp is invalid")
    if retention.tzinfo is None:
        raise SystemExit("uploaded object S3 retention timestamp has no timezone")
    if (
        int(retention.astimezone(timezone.utc).timestamp())
        < int(created) + minimum_retention_days * 86400
    ):
        raise SystemExit(
            "uploaded object S3 retention is shorter than the governed floor",
        )
PY
)" || die "uploaded object verification failed: $key"
  LAST_VERIFIED_VERSION_ID="$verified_version_id"
  LAST_VERIFIED_RETAIN_UNTIL=""
  LAST_VERIFIED_ENCRYPTED_SHA="$encrypted_sha"
  LAST_VERIFIED_ENCRYPTED_SIZE="$expected_size"
  LAST_VERIFIED_CREATED_EPOCH="$created_epoch"
  if [ "$minimum_retention_days" -gt 0 ] \
      && [ "$NEXUS_DR_STORAGE_PROVIDER" = aws-s3 ]; then
    LAST_VERIFIED_RETAIN_UNTIL="$(
      aws_retain_until_from_json "$head" "uploaded release escrow head" \
        "$created_epoch" "$minimum_retention_days"
    )" || die "uploaded release escrow retention deadline did not verify"
  fi
}

aws_error_code_from_file() {
  local error_file="$1"
  "$NEXUS_DR_PYTHON_BIN" - "$error_file" <<'PY'
from pathlib import Path
import re
import sys

path = Path(sys.argv[1])
try:
    raw = path.read_text(encoding="utf-8", errors="replace")
except OSError as error:
    raise SystemExit(f"AWS error response is unreadable: {error}")
if len(raw.encode("utf-8")) > 65536:
    raise SystemExit("AWS error response exceeds the bounded size")
match = re.search(
    r"An error occurred \(([A-Za-z0-9]+)\) when calling the PutObject operation",
    raw,
)
if not match:
    raise SystemExit("AWS PutObject error code is unavailable")
print(match.group(1))
PY
}

verify_existing_period_object() {
  local key="$1" tier="$2" minimum_retention_days="$3"
  local expected_version_id="${4:-}"
  local head="$tmp_dir/existing-$(printf '%s' "$key" | sha256sum | awk '{print $1}').json"
  local -a head_args=(
    --bucket "$NEXUS_DR_S3_BUCKET"
    --key "$key"
    --checksum-mode ENABLED
  )
  local fields
  [ -z "$expected_version_id" ] \
    || head_args+=("--version-id=$expected_version_id")
  aws_s3api head-object "${head_args[@]}" >"$head"
  fields="$("$NEXUS_DR_PYTHON_BIN" - "$head" "$key" "$database_root" \
    "$tier" "$minimum_retention_days" "$expected_version_id" <<'PY'
import base64
from datetime import datetime, timezone
import json
import re
import sys

(
    head_path,
    key,
    database_root,
    tier,
    minimum_days_raw,
    expected_version_id,
) = sys.argv[1:]
try:
    value = json.load(open(head_path, encoding="utf-8"))
except (OSError, json.JSONDecodeError) as error:
    raise SystemExit(f"existing period head is unreadable: {error}")
if not isinstance(value, dict):
    raise SystemExit("existing period head is invalid")
metadata = {
    str(name).lower(): str(item)
    for name, item in value.get("Metadata", {}).items()
}
encrypted_sha = metadata.get("encrypted-sha256", "")
plaintext_sha = metadata.get("plaintext-sha256", "")
if (
    not re.fullmatch(r"[0-9a-f]{64}", encrypted_sha)
    or not re.fullmatch(r"[0-9a-f]{64}", plaintext_sha)
    or metadata.get("schema-version")
        != "NexusApplicationSqliteRecoveryPointV1"
):
    raise SystemExit("existing period recovery-point metadata is invalid")
try:
    checksum_sha = base64.b64decode(
        value.get("ChecksumSHA256", ""),
        validate=True,
    ).hex()
except (TypeError, ValueError):
    raise SystemExit("existing period SHA256 checksum proof is invalid")
if checksum_sha != encrypted_sha:
    raise SystemExit("existing period SHA256 checksum does not match metadata")
if not isinstance(value.get("ContentLength"), int) or value["ContentLength"] < 1:
    raise SystemExit("existing period object size is invalid")

def valid_version_id(candidate):
    if not isinstance(candidate, str) or candidate == "null":
        return False
    try:
        encoded = candidate.encode("utf-8")
    except UnicodeEncodeError:
        return False
    return (
        1 <= len(encoded) <= 1024
        and not any(
            ord(character) < 32 or ord(character) == 127
            for character in candidate
        )
    )

version_id = value.get("VersionId")
if (
    not valid_version_id(version_id)
    or (expected_version_id and version_id != expected_version_id)
):
    raise SystemExit("existing period exact VersionId is invalid")
if value.get("ObjectLockMode") != "COMPLIANCE":
    raise SystemExit("existing period object is missing COMPLIANCE retention")
try:
    created_epoch = int(metadata.get("created-epoch", ""))
    created = datetime.fromtimestamp(created_epoch, timezone.utc)
    retained = datetime.fromisoformat(
        str(value.get("ObjectLockRetainUntilDate", "")).replace("Z", "+00:00"),
    )
except (OverflowError, TypeError, ValueError) as error:
    raise SystemExit("existing period timestamps are invalid") from error
if retained.tzinfo is None:
    raise SystemExit("existing period retention timestamp has no timezone")
minimum_days = int(minimum_days_raw)
if int(retained.astimezone(timezone.utc).timestamp()) < (
    created_epoch + minimum_days * 86400
):
    raise SystemExit("existing period retention is shorter than the governed floor")
prefix = f"{database_root}/{tier}/nexus-db-"
if not key.startswith(prefix) or not key.endswith(".sqlite.age"):
    raise SystemExit("existing period key is outside the governed tier")
suffix = key[len(prefix):-len(".sqlite.age")]
expected = {
    "hourly": created.strftime("%Y%m%dT%H%M%SZ"),
    "daily": created.strftime("%Y%m%d"),
    "weekly": created.strftime("%G-W%V"),
    "monthly": created.strftime("%Y%m"),
}.get(tier)
if expected is None or suffix != expected:
    raise SystemExit("existing period creation time does not match its calendar key")
print(
    base64.b64encode(version_id.encode("utf-8")).decode("ascii"),
    retained.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    encrypted_sha,
    value["ContentLength"],
    created_epoch,
    sep="|",
)
PY
)" || die "existing $tier recovery point did not verify"
  local version_id_b64
  IFS='|' read -r version_id_b64 LAST_VERIFIED_RETAIN_UNTIL \
    LAST_VERIFIED_ENCRYPTED_SHA LAST_VERIFIED_ENCRYPTED_SIZE \
    LAST_VERIFIED_CREATED_EPOCH <<<"$fields"
  LAST_VERIFIED_VERSION_ID="$(
    aws_opaque_from_base64 "$version_id_b64" \
      "existing $tier recovery point VersionId" version
  )" || die "existing $tier recovery point VersionId transport did not verify"
}

verify_existing_exact_object() {
  local key="$1" plaintext_sha="$2" schema="$3" original_name="$4"
  local minimum_retention_days="$5"
  local expected_version_id="${6:-}"
  local head="$tmp_dir/existing-exact-$(printf '%s' "$key" | sha256sum | awk '{print $1}').json"
  local -a head_args=(
    --bucket "$NEXUS_DR_S3_BUCKET"
    --key "$key"
    --checksum-mode ENABLED
  )
  local fields
  [ -z "$expected_version_id" ] \
    || head_args+=("--version-id=$expected_version_id")
  aws_s3api head-object "${head_args[@]}" >"$head"
  fields="$("$NEXUS_DR_PYTHON_BIN" - "$head" "$plaintext_sha" "$schema" \
    "$original_name" "$minimum_retention_days" "$expected_version_id" <<'PY'
import base64
from datetime import datetime, timezone
import json
import re
import sys

(
    head_path,
    expected_plaintext,
    schema,
    original,
    minimum_days_raw,
    expected_version_id,
) = sys.argv[1:]
try:
    value = json.load(open(head_path, encoding="utf-8"))
except (OSError, json.JSONDecodeError) as error:
    raise SystemExit(f"existing exact object head is unreadable: {error}")
if not isinstance(value, dict):
    raise SystemExit("existing exact object head is invalid")
metadata = {
    str(name).lower(): str(item)
    for name, item in value.get("Metadata", {}).items()
}
encrypted_sha = metadata.get("encrypted-sha256", "")
if (
    metadata.get("plaintext-sha256") != expected_plaintext
    or metadata.get("schema-version") != schema
    or not re.fullmatch(r"[0-9a-f]{64}", encrypted_sha)
):
    raise SystemExit("existing exact object metadata is invalid")
if original and metadata.get("original-name") != original:
    raise SystemExit("existing exact object original filename is invalid")
try:
    checksum_sha = base64.b64decode(
        value.get("ChecksumSHA256", ""),
        validate=True,
    ).hex()
except (TypeError, ValueError):
    raise SystemExit("existing exact object SHA256 checksum proof is invalid")
if checksum_sha != encrypted_sha:
    raise SystemExit("existing exact object SHA256 checksum does not match metadata")
if not isinstance(value.get("ContentLength"), int) or value["ContentLength"] < 1:
    raise SystemExit("existing exact object size is invalid")

def valid_version_id(candidate):
    if not isinstance(candidate, str) or candidate == "null":
        return False
    try:
        encoded = candidate.encode("utf-8")
    except UnicodeEncodeError:
        return False
    return (
        1 <= len(encoded) <= 1024
        and not any(
            ord(character) < 32 or ord(character) == 127
            for character in candidate
        )
    )

version_id = value.get("VersionId")
if (
    not valid_version_id(version_id)
    or (expected_version_id and version_id != expected_version_id)
):
    raise SystemExit("existing exact object VersionId is invalid")
if value.get("ObjectLockMode") != "COMPLIANCE":
    raise SystemExit("existing exact object is missing COMPLIANCE retention")
try:
    created_epoch = int(metadata.get("created-epoch", ""))
    retained = datetime.fromisoformat(
        str(value.get("ObjectLockRetainUntilDate", "")).replace("Z", "+00:00"),
    )
except (TypeError, ValueError) as error:
    raise SystemExit("existing exact object timestamps are invalid") from error
if retained.tzinfo is None:
    raise SystemExit("existing exact object retention timestamp has no timezone")
if int(retained.astimezone(timezone.utc).timestamp()) < (
    created_epoch + int(minimum_days_raw) * 86400
):
    raise SystemExit("existing exact object retention is shorter than its floor")
print(
    base64.b64encode(version_id.encode("utf-8")).decode("ascii"),
    retained.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    encrypted_sha,
    value["ContentLength"],
    created_epoch,
    sep="|",
)
PY
)" || die "existing exact governed object did not verify"
  local version_id_b64
  IFS='|' read -r version_id_b64 LAST_VERIFIED_RETAIN_UNTIL \
    LAST_VERIFIED_ENCRYPTED_SHA LAST_VERIFIED_ENCRYPTED_SIZE \
    LAST_VERIFIED_CREATED_EPOCH <<<"$fields"
  LAST_VERIFIED_VERSION_ID="$(
    aws_opaque_from_base64 "$version_id_b64" \
      "existing exact governed object VersionId" version
  )" || die "existing exact governed object VersionId transport did not verify"
}

extend_existing_exact_object_retention() {
  local key="$1" plaintext_sha="$2" schema="$3" original_name="$4"
  local minimum_retention_days="$5" confirmation_epoch="$6"
  local existing_version_id="$LAST_VERIFIED_VERSION_ID"
  local existing_retain_until="$LAST_VERIFIED_RETAIN_UNTIL"
  local desired_retain_until decision
  desired_retain_until="$(
    aws_retain_until_for_floor "$confirmation_epoch" "$minimum_retention_days"
  )"
  decision="$("$NEXUS_DR_PYTHON_BIN" - "$existing_retain_until" \
    "$desired_retain_until" <<'PY'
from datetime import datetime, timezone
import sys

def parse(raw: str) -> datetime:
    value = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    if value.tzinfo is None:
        raise SystemExit("exact object retention timestamp has no timezone")
    return value.astimezone(timezone.utc)

print("extend" if parse(sys.argv[1]) < parse(sys.argv[2]) else "keep")
PY
)" || die "existing exact object retention comparison failed"
  if [ "$decision" = extend ]; then
    aws_s3api put-object-retention \
      --bucket "$NEXUS_DR_S3_BUCKET" \
      --key "$key" \
      --version-id="$existing_version_id" \
      --retention "Mode=COMPLIANCE,RetainUntilDate=$desired_retain_until" \
      >/dev/null \
      || die "existing exact object COMPLIANCE retention extension failed"
  elif [ "$decision" != keep ]; then
    die "existing exact object retention comparison was invalid"
  fi
  verify_existing_exact_object "$key" "$plaintext_sha" "$schema" \
    "$original_name" "$minimum_retention_days" "$existing_version_id"
  [ "$LAST_VERIFIED_VERSION_ID" = "$existing_version_id" ] \
    || die "existing exact object VersionId changed during retention extension"
  LAST_VERIFIED_RETAIN_UNTIL="$(
    validate_aws_retain_until "$LAST_VERIFIED_RETAIN_UNTIL" \
      "existing exact governed object" "$confirmation_epoch" \
      "$minimum_retention_days"
  )" || die "existing exact object retention does not cover this confirmation"
}

put_encrypted_object() {
  local key="$1" encrypted="$2" encrypted_sha="$3" plaintext_sha="$4"
  local schema="$5" created_epoch="$6" original_name="${7:-}"
  local minimum_retention_days="${8:-0}" collision_policy="${9:-fail}"
  local metadata="encrypted-sha256=$encrypted_sha,plaintext-sha256=$plaintext_sha,schema-version=$schema,created-epoch=$created_epoch"
  local object_lock_args=() put_args=()
  local retain_until="" put_response put_error put_version_id="" error_code
  local attempt=1
  [ -z "$original_name" ] || metadata="$metadata,original-name=$original_name"
  case "$collision_policy" in
    fail|exact|period-daily|period-weekly|period-monthly) ;;
    *) die "unsupported governed object collision policy" ;;
  esac
  if [ "$NEXUS_DR_STORAGE_PROVIDER" = aws-s3 ]; then
    [[ "$minimum_retention_days" =~ ^[0-9]+$ ]] \
      && [ "$minimum_retention_days" -gt 0 ] \
      || die "AWS governed objects require a positive retention floor"
    retain_until="$(
      aws_retain_until_for_floor "$created_epoch" "$minimum_retention_days"
    )"
    object_lock_args=(
      --checksum-algorithm SHA256
      --if-none-match '*'
      --object-lock-mode COMPLIANCE
      --object-lock-retain-until-date "$retain_until"
    )
  fi
  put_response="$tmp_dir/put-$(printf '%s' "$key" | sha256sum | awk '{print $1}').json"
  put_error="$put_response.error"
  put_args=(
    put-object
    --bucket "$NEXUS_DR_S3_BUCKET" \
    --key "$key" \
    --body "$encrypted" \
    --content-type application/octet-stream \
    "${object_lock_args[@]}" \
    --metadata "$metadata"
  )
  while :; do
    if aws_s3api "${put_args[@]}" >"$put_response" 2>"$put_error"; then
      if [ "$NEXUS_DR_STORAGE_PROVIDER" = aws-s3 ]; then
        put_version_id="$(aws_version_id_from_json "$put_response" "put-object response")" \
          || die "put-object did not return an exact S3 VersionId"
      fi
      verify_remote_object "$key" "$encrypted_sha" "$plaintext_sha" "$schema" \
        "$(size_file "$encrypted")" "$created_epoch" "$original_name" \
        "$put_version_id" "$minimum_retention_days"
      return
    fi
    [ "$NEXUS_DR_STORAGE_PROVIDER" = aws-s3 ] \
      || die "S3-compatible put-object failed"
    error_code="$(aws_error_code_from_file "$put_error")" \
      || die "AWS put-object failed without a stable error code"
    if [ "$error_code" = ConditionalRequestConflict ] && [ "$attempt" -eq 1 ]; then
      attempt=2
      continue
    fi
    if [ "$error_code" = PreconditionFailed ]; then
      case "$collision_policy" in
        period-daily|period-weekly|period-monthly)
          verify_existing_period_object \
            "$key" "${collision_policy#period-}" "$minimum_retention_days"
          return
          ;;
        exact)
          verify_existing_exact_object "$key" "$plaintext_sha" "$schema" \
            "$original_name" "$minimum_retention_days"
          extend_existing_exact_object_retention "$key" "$plaintext_sha" \
            "$schema" "$original_name" "$minimum_retention_days" \
            "$created_epoch"
          return
          ;;
        fail)
          die "write-once object key already exists: $key"
          ;;
      esac
    fi
    die "governed AWS put-object failed with code $error_code"
  done
}

created_epoch="$(date -u +%s)"
database_key_fields="$(database_key_suffixes_from_epoch "$created_epoch")"
IFS=$'\t' read -r timestamp daily_suffix weekly_suffix monthly_suffix \
  <<<"$database_key_fields"
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
daily_key="$database_root/daily/nexus-db-$daily_suffix.sqlite.age"
weekly_key="$database_root/weekly/nexus-db-$weekly_suffix.sqlite.age"
monthly_key="$database_root/monthly/nexus-db-$monthly_suffix.sqlite.age"
hourly_database_version_id=""
put_encrypted_object "$hourly_key" "$encrypted" "$encrypted_sha" \
  "$plaintext_sha" NexusApplicationSqliteRecoveryPointV1 "$created_epoch" \
  "" 2 fail
hourly_database_version_id="$LAST_VERIFIED_VERSION_ID"
put_encrypted_object "$daily_key" "$encrypted" "$encrypted_sha" \
  "$plaintext_sha" NexusApplicationSqliteRecoveryPointV1 "$created_epoch" \
  "" 8 period-daily
put_encrypted_object "$weekly_key" "$encrypted" "$encrypted_sha" \
  "$plaintext_sha" NexusApplicationSqliteRecoveryPointV1 "$created_epoch" \
  "" 35 period-weekly
put_encrypted_object "$monthly_key" "$encrypted" "$encrypted_sha" \
  "$plaintext_sha" NexusApplicationSqliteRecoveryPointV1 "$created_epoch" \
  "" 190 period-monthly
if [ "$NEXUS_DR_STORAGE_PROVIDER" = aws-s3 ]; then
  aws_version_id_is_safe "$hourly_database_version_id" \
    || die "hourly database recovery point is missing its exact S3 VersionId"
fi

# BEGIN version-aware S3 retention functions
list_versioned_objects() {
  local prefix="$1" listing="$2" label="$3"
  local key_marker="" version_id_marker="" next_key_marker next_version_id_marker
  local next_key_marker_b64 next_version_id_marker_b64
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
        "--version-id-marker=$version_id_marker"
      )
    fi
    aws_s3api "${request[@]}" >"$page"
    if ! "$NEXUS_DR_PYTHON_BIN" - "$page" "$prefix" "$key_marker" \
      "$version_id_marker" >"$page_state" <<'PY'
import base64
import json
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

def valid_opaque_utf8(value):
    if not isinstance(value, str):
        return False
    try:
        encoded = value.encode("utf-8")
    except UnicodeEncodeError:
        return False
    return (
        1 <= len(encoded) <= 1024
        and not any(
            ord(character) < 32 or ord(character) == 127
            for character in value
        )
    )

def marker(name):
    raw = page.get(name)
    if raw in (None, ""):
        return ""
    if not valid_opaque_utf8(raw):
        raise SystemExit(f"version listing {name} is invalid")
    if "VersionId" in name and raw == "null":
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
    base64.b64encode(next_key_marker.encode("utf-8")).decode("ascii"),
    base64.b64encode(next_version_marker.encode("utf-8")).decode("ascii"),
    len(versions) + len(delete_markers),
    sep="|",
)
PY
    then
      die "version listing page validation failed: $label page $page_index"
    fi
    IFS='|' read -r truncated next_key_marker_b64 \
      next_version_id_marker_b64 page_entry_count <"$page_state"
    next_key_marker=""
    next_version_id_marker=""
    if [ -n "$next_key_marker_b64" ]; then
      next_key_marker="$(
        aws_opaque_from_base64 "$next_key_marker_b64" \
          "version listing next key marker" key
      )" || die "version listing key marker transport failed: $label page $page_index"
    fi
    if [ -n "$next_version_id_marker_b64" ]; then
      next_version_id_marker="$(
        aws_opaque_from_base64 "$next_version_id_marker_b64" \
          "version listing next VersionId marker" version
      )" || die "version listing VersionId marker transport failed: $label page $page_index"
    fi
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

aws_retention_evidence=""
collect_aws_retention_evidence() {
  local listing="$tmp_dir/database-version-listing.json"
  local maturity_seal="$NEXUS_DR_STATE_DIR/aws-retention-maturity.json"
  [ "$NEXUS_DR_STORAGE_PROVIDER:$NEXUS_DR_STORAGE_CONTROL_MODE" = aws-s3:versioned-s3 ] \
    || die "versioned retention evidence requires aws-s3:versioned-s3"
  aws_retention_evidence="$tmp_dir/database-retention-evidence.json"
  list_versioned_objects "$database_root/" "$listing" "database"
  "$NEXUS_DR_PYTHON_BIN" "$VERSION_RETENTION_HELPER" \
    --listing "$listing" \
    --prefix "$database_root" \
    --output "$aws_retention_evidence" \
    --now-epoch "$created_epoch" \
    --maturity-seal "$maturity_seal" \
    --bucket "$NEXUS_DR_S3_BUCKET" \
    --expected-hourly-key "$hourly_key" \
    --expected-daily-key "$daily_key" \
    --expected-weekly-key "$weekly_key" \
    --expected-monthly-key "$monthly_key"
  verify_aws_retention_evidence_objects
}

verify_aws_retention_evidence_objects() {
  local rows="$tmp_dir/database-retention-selected-versions.tsv"
  local tier key version_id minimum_days verified_count=0
  "$NEXUS_DR_PYTHON_BIN" - "$aws_retention_evidence" >"$rows" <<'PY'
import json
import sys

path = sys.argv[1]
value = json.load(open(path, encoding="utf-8"))
policy = {"hourly": 2, "daily": 8, "weekly": 35, "monthly": 190}
required = {"hourly": 24, "daily": 7, "weekly": 4, "monthly": 6}
if (
    value.get("schemaVersion") != "NexusApplicationDrRetentionEvidenceV1"
    or value.get("inventoryOnly") is not True
    or value.get("currentPeriodsVerified") is not True
    or value.get("selectedObjectsVerified") is not False
    or not isinstance(value.get("tiers"), dict)
):
    raise SystemExit("retention evidence selected-version envelope is invalid")

def valid_version_id(candidate):
    if not isinstance(candidate, str) or candidate == "null":
        return False
    try:
        encoded = candidate.encode("utf-8")
    except UnicodeEncodeError:
        return False
    return (
        1 <= len(encoded) <= 1024
        and not any(
            ord(character) < 32 or ord(character) == 127
            for character in candidate
        )
    )

seen = set()
for tier, minimum_days in policy.items():
    item = value["tiers"].get(tier)
    selected = item.get("selectedVersions") if isinstance(item, dict) else None
    if (
        not isinstance(selected, list)
        or not 1 <= len(selected) <= required[tier]
        or item.get("coveredRequiredPeriods") != len(selected)
    ):
        raise SystemExit(f"retention evidence selected {tier} versions are invalid")
    for entry in selected:
        if not isinstance(entry, dict):
            raise SystemExit("retention evidence selected version is invalid")
        key = entry.get("key")
        version_id = entry.get("versionId")
        if (
            not isinstance(key, str)
            or "\t" in key
            or "\n" in key
            or not valid_version_id(version_id)
            or (key, version_id) in seen
        ):
            raise SystemExit("retention evidence selected identity is invalid")
        seen.add((key, version_id))
        print(tier, key, version_id, minimum_days, sep="\t")
PY
  chmod 0600 "$rows"
  while IFS=$'\t' read -r tier key version_id minimum_days; do
    [ -n "$tier" ] || continue
    verify_existing_period_object \
      "$key" "$tier" "$minimum_days" "$version_id"
    verified_count=$((verified_count + 1))
  done <"$rows"
  [ "$verified_count" -gt 0 ] \
    || die "retention evidence selected no exact versions for verification"
  "$NEXUS_DR_PYTHON_BIN" - "$aws_retention_evidence" "$verified_count" <<'PY'
import json
import os
from pathlib import Path
import sys

path = Path(sys.argv[1])
verified_count = int(sys.argv[2])
value = json.loads(path.read_text(encoding="utf-8"))
selected_count = sum(
    len(item["selectedVersions"])
    for item in value["tiers"].values()
)
if selected_count != verified_count:
    raise SystemExit("retention evidence verified-object count changed")
value["selectedObjectsVerified"] = True
value["selectedObjectCount"] = verified_count
temporary = path.with_name(f".{path.name}.verified")
if temporary.exists() or temporary.is_symlink():
    raise SystemExit("retention evidence verification temporary path exists")
temporary.write_text(
    json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n",
    encoding="utf-8",
)
temporary.chmod(0o600)
os.replace(temporary, path)
PY
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

apply_database_retention() {
  case "$NEXUS_DR_STORAGE_PROVIDER:$NEXUS_DR_STORAGE_CONTROL_MODE" in
    aws-s3:versioned-s3)
      collect_aws_retention_evidence
      ;;
    cloudflare-r2:r2-approved-variance)
      prune_visible_count_tier hourly 24 "$hourly_key"
      prune_visible_count_tier daily 7 "$daily_key"
      prune_visible_count_tier weekly 4 "$weekly_key"
      prune_visible_count_tier monthly 6 "$monthly_key"
      ;;
    *) die "unsupported storage mode reached database retention" ;;
  esac
}

confirm_database_after_retention() {
  local downloaded="$tmp_dir/database-post-retention.age"
  local confirmed_epoch
  local -a get_args=(--bucket "$NEXUS_DR_S3_BUCKET" --key "$hourly_key")
  if [ "$NEXUS_DR_STORAGE_PROVIDER" = aws-s3 ]; then
    get_args+=("--version-id=$hourly_database_version_id")
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
    aws-s3:versioned-s3)
      # AWS expiry is owned exclusively by reviewed S3 Lifecycle rules.
      ;;
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
    head_args+=(
      "--version-id=$required_release_version_id"
      --checksum-mode ENABLED
    )
    get_args+=("--version-id=$required_release_version_id")
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
import base64
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

def valid_version_id(candidate):
    if not isinstance(candidate, str) or candidate == "null":
        return False
    try:
        encoded = candidate.encode("utf-8")
    except UnicodeEncodeError:
        return False
    return (
        1 <= len(encoded) <= 1024
        and not any(
            ord(character) < 32 or ord(character) == 127
            for character in candidate
        )
    )

retain_until = ""
if provider == "aws-s3" and control_mode == "versioned-s3":
    try:
        checksum_sha = base64.b64decode(
            value.get("ChecksumSHA256", ""),
            validate=True,
        ).hex()
    except (TypeError, ValueError):
        raise SystemExit("post-retention required release checksum proof is invalid")
    if checksum_sha != expected_encrypted_sha:
        raise SystemExit("post-retention required release checksum changed")
    version_id = value.get("VersionId")
    if (
        not valid_version_id(version_id)
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
    head_args+=(
      "--version-id=$required_recovery_version_id"
      --checksum-mode ENABLED
    )
    get_args+=("--version-id=$required_recovery_version_id")
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
import base64
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

def valid_version_id(candidate):
    if not isinstance(candidate, str) or candidate == "null":
        return False
    try:
        encoded = candidate.encode("utf-8")
    except UnicodeEncodeError:
        return False
    return (
        1 <= len(encoded) <= 1024
        and not any(
            ord(character) < 32 or ord(character) == 127
            for character in candidate
        )
    )

retain_until = ""
if provider == "aws-s3" and control_mode == "versioned-s3":
    try:
        checksum_sha = base64.b64decode(
            value.get("ChecksumSHA256", ""),
            validate=True,
        ).hex()
    except (TypeError, ValueError):
        raise SystemExit("post-retention recovery checksum proof is invalid")
    if checksum_sha != encrypted_sha:
        raise SystemExit("post-retention recovery checksum changed")
    version_id = value.get("VersionId")
    if (
        not valid_version_id(version_id)
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

apply_database_retention
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
  release_object_basename="$basename"
  if [ -n "$REQUIRED_RELEASE" ] && [ "$archive" = "$REQUIRED_RELEASE" ]; then
    release_object_basename="${basename%.tar.gz}+rollback-escrow-${RECOVERY_ESCROW_ID}+phase-${RECOVERY_ESCROW_PHASE}.tar.gz"
  fi
  release_key="$NEXUS_DR_S3_PREFIX/releases/$release_object_basename.$archive_sha.age"
  release_head="$tmp_dir/release-head-$archive_sha.json"
  release_encrypted_sha=""
  release_encrypted_size=""
  release_created_epoch=""
  release_version_id=""
  release_retain_until=""
  release_requires_fresh_retention=false
  release_head_args=(
    --bucket "$NEXUS_DR_S3_BUCKET"
    --key "$release_key"
  )
  if [ "$NEXUS_DR_STORAGE_PROVIDER" = aws-s3 ]; then
    release_head_args+=(--checksum-mode ENABLED)
  fi
  if [ -n "$REQUIRED_RELEASE" ] && [ "$archive" = "$REQUIRED_RELEASE" ]; then
    release_requires_fresh_retention=true
  fi
  if [ "$release_requires_fresh_retention" != true ] \
      && aws_s3api head-object "${release_head_args[@]}" \
        >"$release_head" 2>/dev/null; then
    release_fields="$("$NEXUS_DR_PYTHON_BIN" - "$release_head" "$archive_sha" \
      "$basename" "$NEXUS_DR_STORAGE_PROVIDER" "$NEXUS_DR_STORAGE_CONTROL_MODE" \
      "$created_epoch" "$release_requires_fresh_retention" <<'PY'
import base64
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

def valid_version_id(candidate):
    if not isinstance(candidate, str) or candidate == "null":
        return False
    try:
        encoded = candidate.encode("utf-8")
    except UnicodeEncodeError:
        return False
    return (
        1 <= len(encoded) <= 1024
        and not any(
            ord(character) < 32 or ord(character) == 127
            for character in candidate
        )
    )

version_id = ""
retain_until = ""
if provider == "aws-s3" and control_mode == "versioned-s3":
    try:
        checksum_sha = base64.b64decode(
            value.get("ChecksumSHA256", ""),
            validate=True,
        ).hex()
    except (TypeError, ValueError):
        raise SystemExit("existing release escrow SHA256 checksum proof is invalid")
    if checksum_sha != encrypted_sha:
        raise SystemExit("existing release escrow SHA256 checksum does not match metadata")
    version_id = value.get("VersionId", "")
    if not valid_version_id(version_id):
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
    base64.b64encode(version_id.encode("utf-8")).decode("ascii"),
    retain_until,
    sep="|",
)
PY
)" || die "existing release escrow identity did not verify: $basename"
    IFS='|' read -r release_encrypted_sha release_encrypted_size \
      release_created_epoch release_version_id_b64 release_retain_until \
      <<<"$release_fields"
    release_version_id="$("$NEXUS_DR_PYTHON_BIN" - "$release_version_id_b64" <<'PY'
import base64
import binascii
import sys

try:
    value = base64.b64decode(sys.argv[1], validate=True).decode("utf-8")
except (binascii.Error, UnicodeDecodeError) as error:
    raise SystemExit(f"existing release VersionId transport is invalid: {error}")
print(value)
PY
)" || die "existing release VersionId transport did not verify: $basename"
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
      "$archive_sha" NexusReleaseRollbackEscrowV1 "$created_epoch" "$basename" \
      90 exact
    release_version_id="$LAST_VERIFIED_VERSION_ID"
    release_retain_until="$LAST_VERIFIED_RETAIN_UNTIL"
    release_encrypted_sha="$LAST_VERIFIED_ENCRYPTED_SHA"
    release_encrypted_size="$LAST_VERIFIED_ENCRYPTED_SIZE"
    release_created_epoch="$LAST_VERIFIED_CREATED_EPOCH"
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
  aws_version_id_is_safe "$required_release_version_id" \
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
    NexusCurrentRecoveryRuntimeV1 "$created_epoch" "$recovery_basename" 90 exact
  required_recovery_version_id="$LAST_VERIFIED_VERSION_ID"
  required_recovery_retain_until="$LAST_VERIFIED_RETAIN_UNTIL"
  required_recovery_encrypted_sha="$LAST_VERIFIED_ENCRYPTED_SHA"
  required_recovery_encrypted_size="$LAST_VERIFIED_ENCRYPTED_SIZE"
  rm -f -- "$recovery_encrypted"
  if [ "$NEXUS_DR_STORAGE_PROVIDER" = aws-s3 ]; then
    aws_version_id_is_safe "$required_recovery_version_id" \
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

database_retention_maturity="not-measured-r2-variance"
database_retention_floor_observed="not-applicable"
database_retention_objects_verified="not-applicable"
if [ "$NEXUS_DR_STORAGE_PROVIDER" = aws-s3 ]; then
  IFS=$'\t' read -r database_retention_maturity \
    database_retention_floor_observed database_retention_objects_verified \
    < <("$NEXUS_DR_PYTHON_BIN" - "$aws_retention_evidence" <<'PY'
import json
import sys

value = json.load(open(sys.argv[1], encoding="utf-8"))
print(
    value.get("maturityStatus"),
    str(value.get("floorObserved")).lower(),
    str(value.get("selectedObjectsVerified")).lower(),
    sep="\t",
)
PY
)
fi

if [ "$JSON_OUTPUT" = true ]; then
  "$NEXUS_DR_PYTHON_BIN" - "$hourly_key" "$plaintext_sha" \
    "$encrypted_sha" "$(size_file "$encrypted")" \
    "$hourly_database_version_id" "$database_confirmed_at" \
    "$release_count" "$REQUIRED_RELEASE" \
    "$required_release_sha" "$required_release_key" \
    "$required_release_encrypted_sha" "$required_release_encrypted_size" \
    "$NEXUS_DR_STORAGE_PROVIDER" \
    "$NEXUS_DR_STORAGE_CONTROL_MODE" "$aws_retention_evidence" \
    "$required_release_confirmed_at" \
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
    retention_evidence_path,
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
retention_evidence = None
if retention_evidence_path:
    try:
        with open(retention_evidence_path, encoding="utf-8") as source:
            retention_evidence = json.load(source)
    except (OSError, json.JSONDecodeError) as error:
        raise SystemExit(f"database retention evidence is unreadable: {error}")
    if (
        not isinstance(retention_evidence, dict)
        or retention_evidence.get("schemaVersion")
            != "NexusApplicationDrRetentionEvidenceV1"
        or retention_evidence.get("inventoryOnly") is not True
        or retention_evidence.get("selectedObjectsVerified") is not True
        or retention_evidence.get("maturityStatus") not in {"warming", "mature"}
        or (
            retention_evidence.get("maturityStatus") == "mature"
            and retention_evidence.get("maturitySealed") is not True
        )
        or "deletions" in retention_evidence
    ):
        raise SystemExit("database retention evidence is invalid")
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
    "databaseRetentionEvidence": retention_evidence,
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
  echo "application_dr_backup_complete encrypted=true storageProvider=$NEXUS_DR_STORAGE_PROVIDER storageControlMode=$NEXUS_DR_STORAGE_CONTROL_MODE releasePrefixLock=verified databaseKey=$hourly_key databaseSha256=$plaintext_sha releaseBundles=$release_count databaseRetentionPolicy=24,7,4,6 databaseRetentionMaturity=$database_retention_maturity databaseRetentionFloorObserved=$database_retention_floor_observed databaseRetentionObjectsVerified=$database_retention_objects_verified releaseRetentionPolicyDays=90"
fi
