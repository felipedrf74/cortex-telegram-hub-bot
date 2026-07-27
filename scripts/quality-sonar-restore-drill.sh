#!/usr/bin/env bash
# Restore one encrypted S3 backup into isolated project-scoped volumes and
# prove SonarQube can start with a fresh Elasticsearch volume (forcing reindex).
# The live advisory stack must be stopped before this drill can run.
set -euo pipefail
umask 077

CONFIG=/etc/sonarqube/backup.env
IDENTITY_FILE=""
BACKUP_KEY=""
BACKUP_VERSION_ID=""
CHECKSUM_VERSION_ID=""
OUTPUT=""
STACK_DIR="${SONAR_STACK_DIR:-/srv/sonarqube}"
RESTORE_EVIDENCE_DIR=/var/lib/nexus-sonarqube/restore-evidence
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AWS_CREDENTIAL_BOUNDARY_HELPER="$SCRIPT_DIR/aws-credential-process-boundary.py"
[ -f "$AWS_CREDENTIAL_BOUNDARY_HELPER" ] \
  || AWS_CREDENTIAL_BOUNDARY_HELPER=/usr/local/sbin/quality-sonar-aws-credential-process-boundary.py

usage() {
  echo "Usage: quality-sonar-restore-drill.sh --backup-key <exact-s3-key> --backup-version-id <version> --checksum-version-id <version> --identity-file <age-key> --output /var/lib/nexus-sonarqube/restore-evidence/sonar-restore-<new-id>.json [--config <file>]"
}
while [ $# -gt 0 ]; do
  case "$1" in
    --config) CONFIG="$2"; shift 2 ;;
    --identity-file) IDENTITY_FILE="$2"; shift 2 ;;
    --backup-key) BACKUP_KEY="$2"; shift 2 ;;
    --backup-version-id) BACKUP_VERSION_ID="$2"; shift 2 ;;
    --checksum-version-id) CHECKSUM_VERSION_ID="$2"; shift 2 ;;
    --output) OUTPUT="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 64 ;;
  esac
done

[ "$(id -u)" -eq 0 ] || { echo "Restore drill must run as root on an isolated Docker host" >&2; exit 1; }
for file in "$CONFIG" "$IDENTITY_FILE"; do
  [[ "$file" == /* ]] && [ -f "$file" ] && [ ! -L "$file" ] || { echo "Required private file is missing: $file" >&2; exit 1; }
  mode="$(stat -c '%a' "$file" 2>/dev/null || stat -f '%Lp' "$file")"
  [ "$mode" = 600 ] || { echo "Private drill files must have mode 0600" >&2; exit 1; }
  owner="$(stat -c '%U' "$file" 2>/dev/null || stat -f '%Su' "$file")"
  [ "$owner" = root ] || { echo "Private drill files must be owned by root" >&2; exit 1; }
done
[[ "$OUTPUT" == "$RESTORE_EVIDENCE_DIR/"* ]] \
  && [ "$(dirname -- "$OUTPUT")" = "$RESTORE_EVIDENCE_DIR" ] \
  && [[ "${OUTPUT##*/}" =~ ^sonar-restore-[A-Za-z0-9][A-Za-z0-9._-]{0,95}\.json$ ]] \
  || { echo "--output must be a new governed Sonar restore evidence path" >&2; exit 64; }

set -a
# shellcheck disable=SC1090
. "$CONFIG"
[ -f "$STACK_DIR/images.lock.env" ] && [ ! -L "$STACK_DIR/images.lock.env" ] || { echo "Immutable image lock is missing" >&2; exit 1; }
# shellcheck disable=SC1090
. "$STACK_DIR/images.lock.env"
set +a
for key in SONAR_BACKUP_S3_ENDPOINT SONAR_BACKUP_S3_BUCKET SONAR_BACKUP_S3_PREFIX \
  SONARQUBE_IMAGE POSTGRES_IMAGE AWS_CONFIG_FILE AWS_SHARED_CREDENTIALS_FILE \
  AWS_EC2_METADATA_DISABLED SONAR_BACKUP_AWS_SIGNING_HELPER \
  SONAR_BACKUP_AWS_SIGNING_HELPER_SHA256 AWS_PROFILE \
  SONAR_BACKUP_AWS_ROLE_ARN SONAR_RESTORE_AWS_PROFILE \
  SONAR_RESTORE_AWS_ROLE_ARN; do
  [ -n "${!key:-}" ] || { echo "Restore configuration is missing $key" >&2; exit 1; }
done
[ "$AWS_PROFILE" = nexus-sonarqube-backup ] \
  || { echo "Configured Sonar backup profile is invalid" >&2; exit 1; }
[ "$SONAR_RESTORE_AWS_PROFILE" = nexus-sonarqube-restore ] \
  || { echo "Sonar restore profile is invalid" >&2; exit 1; }
[ "$SONAR_BACKUP_AWS_ROLE_ARN" != "$SONAR_RESTORE_AWS_ROLE_ARN" ] \
  || { echo "Sonar writer and restore role ARNs must be distinct" >&2; exit 1; }
[[ "$SONAR_RESTORE_AWS_ROLE_ARN" =~ ^arn:aws:iam::[0-9]{12}:role/[A-Za-z0-9+=,.@_/-]{1,512}$ ]] \
  || { echo "Sonar restore role ARN is invalid" >&2; exit 1; }
export AWS_PROFILE="$SONAR_RESTORE_AWS_PROFILE"
[[ "$SONAR_BACKUP_AWS_SIGNING_HELPER_SHA256" =~ ^[a-f0-9]{64}$ ]] \
  || { echo "Reviewed aws_signing_helper SHA-256 is invalid" >&2; exit 1; }
[[ "$AWS_CONFIG_FILE" == /* ]] && [ -f "$AWS_CONFIG_FILE" ] && [ ! -L "$AWS_CONFIG_FILE" ] \
  || { echo "AWS credential-process config is missing" >&2; exit 1; }
aws_config_mode="$(stat -c '%a' "$AWS_CONFIG_FILE" 2>/dev/null || stat -f '%Lp' "$AWS_CONFIG_FILE")"
aws_config_owner="$(stat -c '%U' "$AWS_CONFIG_FILE" 2>/dev/null || stat -f '%Su' "$AWS_CONFIG_FILE")"
[ "$aws_config_mode" = 600 ] && [ "$aws_config_owner" = root ] \
  || { echo "AWS credential-process config must be root-owned mode 0600" >&2; exit 1; }
[[ "$SONAR_BACKUP_S3_ENDPOINT" =~ ^https://[^[:space:]]+$ ]] || { echo "S3 endpoint must use HTTPS" >&2; exit 1; }
expected_aws_s3_endpoint="https://s3.${AWS_REGION:-us-east-1}.amazonaws.com"
[ "$SONAR_BACKUP_S3_ENDPOINT" = "$expected_aws_s3_endpoint" ] \
  || { echo "Sonar restore endpoint must match the canonical regional AWS S3 endpoint" >&2; exit 1; }
expected_prefix="$SONAR_BACKUP_S3_PREFIX/"
escaped_prefix="${expected_prefix//./\\.}"
escaped_prefix="${escaped_prefix//\//\\/}"
[[ "$BACKUP_KEY" =~ ^${escaped_prefix}(daily|weekly)/nexus-sonarqube-[0-9]{8}T[0-9]{6}Z\.dump\.age$ ]] || {
  echo "Backup key is outside the governed Sonar retention namespace" >&2
  exit 1
}
[[ -n "$BACKUP_VERSION_ID" && -n "$CHECKSUM_VERSION_ID" ]] \
  || { echo "Restore drill requires exact data and checksum object VersionIds" >&2; exit 1; }

for command in docker age aws openssl curl node python3 realpath sha256sum ss flock; do
  command -v "$command" >/dev/null 2>&1 || { echo "$command is required for restore drill" >&2; exit 1; }
done
validate_restore_evidence_target() {
  local current="$RESTORE_EVIDENCE_DIR" owner mode canonical
  [ -d "$RESTORE_EVIDENCE_DIR" ] && [ ! -L "$RESTORE_EVIDENCE_DIR" ] \
    || { echo "Sonar restore evidence directory is missing or a symlink" >&2; return 1; }
  canonical="$(realpath -e -- "$RESTORE_EVIDENCE_DIR")"
  [ "$canonical" = "$RESTORE_EVIDENCE_DIR" ] \
    || { echo "Sonar restore evidence directory is noncanonical" >&2; return 1; }
  [ "$(stat -c '%U:%G:%a' -- "$RESTORE_EVIDENCE_DIR")" = root:root:700 ] \
    || { echo "Sonar restore evidence directory must be root-owned mode 0700" >&2; return 1; }
  while :; do
    [ -d "$current" ] && [ ! -L "$current" ] \
      || { echo "Sonar restore evidence path chain is unsafe" >&2; return 1; }
    [ "$(realpath -e -- "$current")" = "$current" ] \
      || { echo "Sonar restore evidence path chain traverses a symlink" >&2; return 1; }
    owner="$(stat -c '%U:%G' -- "$current")"
    mode="$(stat -c '%a' -- "$current")"
    [ "$owner" = root:root ] && (( (8#$mode & 0022) == 0 )) \
      || { echo "Sonar restore evidence path chain is not root-trusted" >&2; return 1; }
    [ "$current" = / ] && break
    current="$(dirname -- "$current")"
  done
  [ "$(realpath -m -- "$OUTPUT")" = "$OUTPUT" ] \
    || { echo "Sonar restore evidence output must be canonical" >&2; return 1; }
  [ ! -e "$OUTPUT" ] && [ ! -L "$OUTPUT" ] \
    || { echo "Sonar restore evidence output must be a new path" >&2; return 1; }
}
validate_restore_evidence_target
node - "$BACKUP_VERSION_ID" "$CHECKSUM_VERSION_ID" <<'NODE' || {
const values = process.argv.slice(2);
const valid = value => {
  if (typeof value !== 'string' || value === 'null') return false;
  const encoded = Buffer.from(value, 'utf8');
  return encoded.length >= 1 && encoded.length <= 1024
    && encoded.toString('utf8') === value
    && !/[\u0000-\u001f\u007f]/u.test(value);
};
if (values.length !== 2 || !values.every(valid)) process.exit(1);
NODE
  echo "Restore drill requires safe exact data and checksum object VersionIds" >&2
  exit 1
}
[ -f "$AWS_CREDENTIAL_BOUNDARY_HELPER" ] && [ ! -L "$AWS_CREDENTIAL_BOUNDARY_HELPER" ] \
  || { echo "AWS credential-process boundary helper is missing" >&2; exit 1; }
python3 "$AWS_CREDENTIAL_BOUNDARY_HELPER" \
  --config "$AWS_CONFIG_FILE" \
  --profile "$AWS_PROFILE" \
  --region "${AWS_REGION:-us-east-1}" \
  --helper "$SONAR_BACKUP_AWS_SIGNING_HELPER" \
  --helper-sha256 "$SONAR_BACKUP_AWS_SIGNING_HELPER_SHA256" \
  --expected-role-arn "$SONAR_RESTORE_AWS_ROLE_ARN" >/dev/null
[ -f "$STACK_DIR/compose.drill.yaml" ] || { echo "Restore-drill Compose file is missing" >&2; exit 1; }
mutex=/run/lock/nexus-release-sonar.lock
observed_host="$(hostname -s 2>/dev/null | tr '[:upper:]' '[:lower:]')"
if [ "$observed_host" = serverdominguez ] || [ -e "$mutex" ]; then
  [ -f "$mutex" ] && [ ! -L "$mutex" ] \
    && [ "$(stat -c '%U:%G' "$mutex")" = root:dominguez ] \
    && [ "$(stat -c '%a' "$mutex")" = 660 ] \
    || { echo "Preprovisioned root:dominguez mode-0660 release/Sonar mutex is invalid" >&2; exit 1; }
  exec 8<>"$mutex"
  flock -n 8 || { echo "Sonar restore drill refused: a release, scan, backup, or stack operation is active" >&2; exit 75; }
fi
if docker ps --quiet --filter label=com.docker.compose.project=nexus-sonarqube-advisory | grep -q .; then
  echo "Refusing restore drill while the live advisory Sonar stack is running" >&2
  exit 1
fi
if ss -ltnH 'sport = :19000' | grep -q .; then
  echo "Restore-drill loopback port 19000 is already in use" >&2
  exit 1
fi

tmp_dir="$(mktemp -d)"
project="nexus-sonar-drill-$$"
encrypted="$tmp_dir/backup.dump.age"
checksum="$tmp_dir/backup.dump.age.sha256"
dump="$tmp_dir/backup.dump"
started=false
evidence_stage=""
cleanup() {
  status=$?
  if [ "$started" = true ]; then
    SONAR_DRILL_PROJECT="$project" SONAR_DRILL_DB_PASSWORD="$drill_password" SONAR_DRILL_JWT_SECRET="$drill_jwt" \
      docker compose --project-name "$project" --env-file "$STACK_DIR/images.lock.env" -f "$STACK_DIR/compose.drill.yaml" down --volumes --remove-orphans >/dev/null 2>&1 || true
  fi
  [ -z "$evidence_stage" ] || rm -f -- "$evidence_stage"
  rm -rf "$tmp_dir"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
chmod 0700 "$tmp_dir"

aws_args=(--endpoint-url "$SONAR_BACKUP_S3_ENDPOINT" --region "${AWS_REGION:-us-east-1}")
aws "${aws_args[@]}" s3api get-object \
  --bucket "$SONAR_BACKUP_S3_BUCKET" --key "$BACKUP_KEY" \
  --version-id="$BACKUP_VERSION_ID" "$encrypted" >/dev/null
aws "${aws_args[@]}" s3api get-object \
  --bucket "$SONAR_BACKUP_S3_BUCKET" --key "$BACKUP_KEY.sha256" \
  --version-id="$CHECKSUM_VERSION_ID" "$checksum" >/dev/null
expected_digest="$(awk 'NR == 1 { print $1 }' "$checksum")"
[[ "$expected_digest" =~ ^[0-9a-f]{64}$ ]] || { echo "Backup checksum object is invalid" >&2; exit 1; }
[ "$(sha256sum "$encrypted" | awk '{ print $1 }')" = "$expected_digest" ] || { echo "Encrypted backup checksum mismatch" >&2; exit 1; }
age --decrypt --identity "$IDENTITY_FILE" --output "$dump" "$encrypted"
[ "$(dd if="$dump" bs=5 count=1 status=none)" = PGDMP ] || { echo "Decrypted object is not a PostgreSQL custom-format dump" >&2; exit 1; }
unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN AWS_SECURITY_TOKEN
unset AWS_PROFILE AWS_DEFAULT_PROFILE AWS_SHARED_CREDENTIALS_FILE AWS_CONFIG_FILE
unset AWS_WEB_IDENTITY_TOKEN_FILE AWS_ROLE_ARN AWS_ROLE_SESSION_NAME
unset AWS_CONTAINER_CREDENTIALS_FULL_URI AWS_CONTAINER_CREDENTIALS_RELATIVE_URI

drill_password="$(openssl rand -hex 32)"
drill_jwt="$(openssl rand -base64 48 | tr -d '\r\n')"
export SONAR_DRILL_PROJECT="$project" SONAR_DRILL_DB_PASSWORD="$drill_password" SONAR_DRILL_JWT_SECRET="$drill_jwt"
compose=(docker compose --project-name "$project" --env-file "$STACK_DIR/images.lock.env" -f "$STACK_DIR/compose.drill.yaml")
"${compose[@]}" up -d postgres
started=true
for _ in $(seq 1 60); do
  if "${compose[@]}" exec -T postgres pg_isready -U sonar_drill -d sonar_drill >/dev/null 2>&1; then break; fi
  sleep 2
done
"${compose[@]}" exec -T postgres pg_isready -U sonar_drill -d sonar_drill >/dev/null
"${compose[@]}" exec -T postgres pg_restore --list <"$dump" >/dev/null
"${compose[@]}" exec -T postgres sh -eu -c \
  'PGPASSWORD="$POSTGRES_PASSWORD" exec pg_restore --no-owner --no-privileges --exit-on-error --username sonar_drill --dbname sonar_drill' \
  <"$dump"
rm -f "$dump"
"${compose[@]}" up -d sonarqube

health="$SCRIPT_DIR/quality-sonar-health.sh"
[ -x "$health" ] || health=/usr/local/sbin/quality-sonar-health
"$health" --url http://127.0.0.1:19000 --attempts 120 --interval 5

validate_restore_evidence_target
evidence_stage="$(mktemp -p "$RESTORE_EVIDENCE_DIR" '.sonar-restore.next.XXXXXXXX')"
node - "$evidence_stage" "$OUTPUT" "$BACKUP_KEY" "$BACKUP_VERSION_ID" \
  "$CHECKSUM_VERSION_ID" "$expected_digest" <<'NODE'
const fs = require('fs');
const path = require('path');
const [
  stage,
  output,
  backupKey,
  backupVersionId,
  checksumVersionId,
  encryptedSha256,
] = process.argv.slice(2);
const evidence = {
  schemaVersion: 'SonarRestoreDrillV2',
  backupKey,
  backupVersionId,
  checksumVersionId,
  encryptedSha256,
  databaseRestoreVerified: true,
  freshElasticsearchVolume: true,
  reindexStartupVerified: true,
  sonarStatus: 'UP',
  completedAt: new Date().toISOString(),
};
const descriptor = fs.openSync(
  stage,
  fs.constants.O_WRONLY
    | fs.constants.O_TRUNC
    | (fs.constants.O_NOFOLLOW ?? 0),
);
try {
  const before = fs.fstatSync(descriptor);
  if (!before.isFile() || before.nlink !== 1 || before.uid !== 0) {
    throw new Error('unsafe Sonar restore evidence staging file');
  }
  fs.fchmodSync(descriptor, 0o600);
  fs.fchownSync(descriptor, 0, 0);
  fs.writeFileSync(descriptor, `${JSON.stringify(evidence, null, 2)}\n`, {
    encoding: 'utf8',
  });
  fs.fsyncSync(descriptor);
} finally {
  fs.closeSync(descriptor);
}
// link(2) is an atomic no-replace publication: an existing file or symlink at
// the requested output path makes the drill fail instead of overwriting it.
fs.linkSync(stage, output);
fs.unlinkSync(stage);
const directory = fs.openSync(
  path.dirname(output),
  fs.constants.O_RDONLY
    | (fs.constants.O_DIRECTORY ?? 0)
    | (fs.constants.O_NOFOLLOW ?? 0),
);
try {
  fs.fsyncSync(directory);
} finally {
  fs.closeSync(directory);
}
NODE
evidence_stage=""
[ -f "$OUTPUT" ] && [ ! -L "$OUTPUT" ] \
  && [ "$(stat -c '%U:%G:%a:%h' -- "$OUTPUT")" = root:root:600:1 ] \
  || { echo "Published Sonar restore evidence identity is unsafe" >&2; exit 1; }
echo "sonar_restore_drill_ok backupKey=$BACKUP_KEY reindex=fresh-volume evidence=$OUTPUT"
