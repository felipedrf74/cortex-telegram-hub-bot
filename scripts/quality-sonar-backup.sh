#!/usr/bin/env bash
# Create a verified PostgreSQL custom-format dump, encrypt it with an off-host
# age recipient, upload to S3-compatible storage, and enforce 7 daily/4 weekly
# retention. No plaintext dump leaves the private temporary directory.
set -euo pipefail
umask 077

CONFIG=/etc/sonarqube/backup.env
STACK_DIR="${SONAR_STACK_DIR:-/srv/sonarqube}"
SECRETS_FILE="${SONAR_SECRETS_FILE:-/etc/sonarqube/sonarqube.env}"
SUCCESS_RECEIPT="${SONAR_BACKUP_SUCCESS_RECEIPT:-/var/lib/nexus-sonarqube/last-backup-success.v2.json}"
BACKUP_TIMER=nexus-sonarqube-backup.timer
MAX_AGE_HOURS=26
ACTION=backup
ACTION_SET=false
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AWS_CREDENTIAL_BOUNDARY_HELPER="$SCRIPT_DIR/aws-credential-process-boundary.py"
[ -f "$AWS_CREDENTIAL_BOUNDARY_HELPER" ] \
  || AWS_CREDENTIAL_BOUNDARY_HELPER=/usr/local/sbin/quality-sonar-aws-credential-process-boundary.py
RETENTION_HELPER="$SCRIPT_DIR/quality-sonar-retention.mjs"
[ -f "$RETENTION_HELPER" ] \
  || RETENTION_HELPER=/usr/local/sbin/quality-sonar-retention.mjs

usage() {
  echo "Usage: quality-sonar-backup.sh [--config <mode-0600-file>] [--verify-config|--verify-freshness [--max-age-hours <1-168>]|--enable-timer]"
}
select_action() {
  [ "$ACTION_SET" = false ] || { echo "Select exactly one Sonar backup action" >&2; exit 64; }
  ACTION="$1"
  ACTION_SET=true
}
while [ $# -gt 0 ]; do
  case "$1" in
    --config) CONFIG="$2"; shift 2 ;;
    --verify-config) select_action verify; shift ;;
    --verify-freshness) select_action freshness; shift ;;
    --max-age-hours) MAX_AGE_HOURS="$2"; shift 2 ;;
    --enable-timer) select_action enable; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 64 ;;
  esac
done

[ "$(id -u)" -eq 0 ] || { echo "Sonar backup must run as root" >&2; exit 1; }
[[ "$SUCCESS_RECEIPT" == /* ]] && [ "$SUCCESS_RECEIPT" != / ] \
  || { echo "Sonar backup success receipt must use a safe absolute path" >&2; exit 64; }
[[ "$MAX_AGE_HOURS" =~ ^[0-9]+$ ]] \
  && [ "$MAX_AGE_HOURS" -ge 1 ] && [ "$MAX_AGE_HOURS" -le 168 ] \
  || { echo "Invalid Sonar backup freshness window" >&2; exit 64; }

verify_freshness() {
  local node_bin
  node_bin="$(command -v node 2>/dev/null || true)"
  [ -x "$node_bin" ] || { echo "node is required for Sonar backup freshness verification" >&2; return 1; }
  [ -f "$SUCCESS_RECEIPT" ] && [ ! -L "$SUCCESS_RECEIPT" ] \
    || { echo "Sonar backup success receipt is missing or a symlink" >&2; return 1; }
  [ "$(stat -c '%U:%G:%a:%h' -- "$SUCCESS_RECEIPT")" = root:root:600:1 ] \
    || { echo "Sonar backup success receipt identity is unsafe" >&2; return 1; }
  "$node_bin" - "$SUCCESS_RECEIPT" "$MAX_AGE_HOURS" <<'NODE'
const fs = require('fs');
const [file, maxAgeHoursRaw] = process.argv.slice(2);
const expectedUid = process.env.NEXUS_RELEASE_TEST_MODE === '1' ? process.getuid() : 0;
const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
let body;
try {
  const before = fs.fstatSync(descriptor);
  body = fs.readFileSync(descriptor, 'utf8');
  const after = fs.fstatSync(descriptor);
  if (!before.isFile() || before.nlink !== 1 || before.uid !== expectedUid
      || before.dev !== after.dev || before.ino !== after.ino
      || before.size !== after.size || before.mtimeMs !== after.mtimeMs) process.exit(1);
} finally {
  fs.closeSync(descriptor);
}
const value = JSON.parse(body);
const completedAt = Date.parse(value.completedAt || '');
const ageMs = Date.now() - completedAt;
const maxAgeMs = Number(maxAgeHoursRaw) * 60 * 60 * 1000;
const backupKeyPattern = tier =>
  new RegExp(`/${tier}/nexus-sonarqube-[0-9]{8}T[0-9]{6}Z\\.dump\\.age$`, 'u');
const periodForKey = (key, tier) => {
  const match = /nexus-sonarqube-([0-9]{8}T[0-9]{6}Z)\.dump\.age$/u.exec(key);
  if (!match) return null;
  const timestamp = match[1];
  const date = new Date(
    `${timestamp.slice(0, 4)}-${timestamp.slice(4, 6)}-` +
      `${timestamp.slice(6, 8)}T${timestamp.slice(9, 11)}:` +
      `${timestamp.slice(11, 13)}:${timestamp.slice(13, 15)}Z`,
  );
  const normalized = Number.isFinite(date.getTime())
    ? date
      .toISOString()
      .replaceAll('-', '')
      .replaceAll(':', '')
      .replace('.000', '')
    : '';
  if (normalized !== timestamp) return null;
  if (tier === 'daily') {
    return `${timestamp.slice(0, 4)}-${timestamp.slice(4, 6)}-${timestamp.slice(6, 8)}`;
  }
  const working = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
  const weekday = working.getUTCDay() || 7;
  working.setUTCDate(working.getUTCDate() + 4 - weekday);
  const weekYear = working.getUTCFullYear();
  const yearStart = new Date(Date.UTC(weekYear, 0, 1));
  const week = Math.ceil(
    ((working.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7,
  );
  return `${weekYear}-W${String(week).padStart(2, '0')}`;
};
const isImmutableVersionId = candidate => {
  if (typeof candidate !== 'string' || candidate === 'null') return false;
  const encoded = Buffer.from(candidate, 'utf8');
  return encoded.length >= 1 && encoded.length <= 1024
    && encoded.toString('utf8') === candidate
    && !/[\u0000-\u001f\u007f]/u.test(candidate);
};
const isRetentionEvidence = (candidate, tier, target, minimum) => {
  const periodPattern = tier === 'daily'
    ? /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/u
    : /^[0-9]{4}-W[0-9]{2}$/u;
  const canonicalBase64Sha256 = value => {
    if (typeof value !== 'string' || !/^[A-Za-z0-9+/]{43}=$/u.test(value)) {
      return null;
    }
    const decoded = Buffer.from(value, 'base64');
    return decoded.length === 32 && decoded.toString('base64') === value
      ? decoded
      : null;
  };
  return candidate?.schemaVersion === 'SonarRetentionEvidenceV1'
    && candidate.tier === tier
    && candidate.periodKind === (tier === 'daily' ? 'utc-day' : 'iso-week')
    && candidate.targetDistinctPeriods === target
    && Number.isSafeInteger(candidate.retainedDistinctPeriods)
    && candidate.retainedDistinctPeriods >= minimum
    && candidate.retainedDistinctPeriods <= target
    && candidate.targetReached === (candidate.retainedDistinctPeriods === target)
    && candidate.maturityStatus
      === (candidate.retainedDistinctPeriods === target ? 'mature' : 'warming')
    && Array.isArray(candidate.selectedPeriods)
    && candidate.selectedPeriods.length === candidate.retainedDistinctPeriods
    && new Set(candidate.selectedPeriods).size === candidate.selectedPeriods.length
    && candidate.selectedPeriods.every(period => periodPattern.test(period))
    && Array.isArray(candidate.selectedKeys)
    && candidate.selectedKeys.length === candidate.retainedDistinctPeriods
    && new Set(candidate.selectedKeys).size === candidate.selectedKeys.length
    && candidate.selectedKeys.every(key =>
      typeof key === 'string' && backupKeyPattern(tier).test(key))
    && candidate.selectedKeys.every(
      (key, index) => periodForKey(key, tier) === candidate.selectedPeriods[index],
    )
    && Array.isArray(candidate.selectedPoints)
    && candidate.selectedPoints.length === candidate.retainedDistinctPeriods
    && candidate.selectedPoints.every((point, index) => {
      const dataChecksum = canonicalBase64Sha256(point?.dataChecksumSha256);
      return point?.schemaVersion === 'SonarRetentionPointV1'
        && point.tier === tier
        && point.period === candidate.selectedPeriods[index]
        && point.key === candidate.selectedKeys[index]
        && point.checksumKey === `${point.key}.sha256`
        && isImmutableVersionId(point.dataVersionId)
        && isImmutableVersionId(point.checksumVersionId)
        && /^[a-f0-9]{64}$/u.test(point.encryptedSha256 || '')
        && dataChecksum?.toString('hex') === point.encryptedSha256
        && canonicalBase64Sha256(point.checksumObjectChecksumSha256) !== null
        && Number.isSafeInteger(point.encryptedSizeBytes)
        && point.encryptedSizeBytes > 0
        && Number.isSafeInteger(point.checksumSizeBytes)
        && point.checksumSizeBytes > 0
        && point.checksumSizeBytes <= 4096;
    })
    && candidate.completePairNamesVerified === true
    && candidate.completePairsVerified === true
    && candidate.remotePairsVerified === true
    && candidate.postPruneVerified === true
    && candidate.excessObjectsAbsent === true
    && typeof candidate.protectedKeyVerified === 'boolean'
    && Number.isFinite(Date.parse(candidate.verifiedAt || ''));
};
const dailyPoint = value.retentionEvidence?.daily?.selectedPoints?.find(
  point => point.key === value.dailyKey,
);
const weeklyPoint = value.retentionEvidence?.weekly?.selectedPoints?.find(
  point => point.key === value.weeklyKey,
);
if (value.schemaVersion !== 'SonarBackupSuccessV2'
    || value.encrypted !== true || value.remoteObjectVerified !== true
    || value.retention?.daily !== 7 || value.retention?.weekly !== 4
    || value.retention?.basis !== 'distinct-utc-days-and-iso-weeks'
    || !isRetentionEvidence(value.retentionEvidence?.daily, 'daily', 7, 1)
    || !isRetentionEvidence(value.retentionEvidence?.weekly, 'weekly', 4, 0)
    || value.retentionEvidence.daily.protectedKeyVerified !== true
    || value.retentionEvidence.weekly.protectedKeyVerified !== value.weeklyUploaded
    || typeof value.dailyKey !== 'string'
    || !/\/daily\/nexus-sonarqube-[0-9]{8}T[0-9]{6}Z\.dump\.age$/u.test(value.dailyKey)
    || !value.retentionEvidence.daily.selectedKeys.includes(value.dailyKey)
    || !/^[a-f0-9]{64}$/u.test(value.encryptedSha256 || '')
    || !Number.isSafeInteger(value.encryptedSizeBytes) || value.encryptedSizeBytes <= 0
    || !isImmutableVersionId(value.dailyObjectVersionId)
    || !isImmutableVersionId(value.dailyChecksumVersionId)
    || dailyPoint?.dataVersionId !== value.dailyObjectVersionId
    || dailyPoint?.checksumVersionId !== value.dailyChecksumVersionId
    || dailyPoint?.encryptedSha256 !== value.encryptedSha256
    || dailyPoint?.encryptedSizeBytes !== value.encryptedSizeBytes
    || (value.weeklyUploaded === true
      ? (typeof value.weeklyKey !== 'string'
        || !/\/weekly\/nexus-sonarqube-[0-9]{8}T[0-9]{6}Z\.dump\.age$/u.test(value.weeklyKey)
        || !value.retentionEvidence.weekly.selectedKeys.includes(value.weeklyKey)
        || value.retentionEvidence.weekly.protectedKeyVerified !== true
        || !isImmutableVersionId(value.weeklyObjectVersionId)
        || !isImmutableVersionId(value.weeklyChecksumVersionId)
        || weeklyPoint?.dataVersionId !== value.weeklyObjectVersionId
        || weeklyPoint?.checksumVersionId !== value.weeklyChecksumVersionId
        || weeklyPoint?.encryptedSha256 !== value.encryptedSha256
        || weeklyPoint?.encryptedSizeBytes !== value.encryptedSizeBytes)
      : (value.weeklyKey !== null
        || value.weeklyObjectVersionId !== null
        || value.weeklyChecksumVersionId !== null))
    || value.remoteVerification?.method
      !== 'version-pinned-head-content-length-metadata-and-s3-sha256'
    || value.remoteVerification?.daily !== true
    || value.remoteVerification?.weekly !== value.weeklyUploaded
    || !Number.isFinite(completedAt) || ageMs < -5 * 60 * 1000 || ageMs > maxAgeMs) process.exit(1);
process.stdout.write(`sonar_backup_fresh ageHours=${(ageMs / 3_600_000).toFixed(2)} maxAgeHours=${maxAgeHoursRaw}\n`);
NODE
}

if [ "$ACTION" = freshness ]; then
  verify_freshness
  exit 0
fi

for file in "$CONFIG" "$SECRETS_FILE"; do
  [[ "$file" == /* ]] && [ -f "$file" ] && [ ! -L "$file" ] || { echo "Required external config is missing: $file" >&2; exit 1; }
  mode="$(stat -c '%a' "$file" 2>/dev/null || stat -f '%Lp' "$file")"
  owner="$(stat -c '%U' "$file" 2>/dev/null || stat -f '%Su' "$file")"
  [ "$mode" = 600 ] && [ "$owner" = root ] || { echo "External config must be root-owned mode 0600: $file" >&2; exit 1; }
done

set -a
# shellcheck disable=SC1090
. "$CONFIG"
# shellcheck disable=SC1090
. "$SECRETS_FILE"
set +a

required=(
  SONAR_BACKUP_S3_ENDPOINT
  SONAR_BACKUP_S3_BUCKET
  SONAR_BACKUP_S3_PREFIX
  SONAR_BACKUP_AGE_RECIPIENT
  SONAR_DB_NAME
  SONAR_DB_USER
  SONAR_DB_PASSWORD
  AWS_CONFIG_FILE
  AWS_PROFILE
  AWS_SHARED_CREDENTIALS_FILE
  AWS_EC2_METADATA_DISABLED
  SONAR_BACKUP_AWS_SIGNING_HELPER
  SONAR_BACKUP_AWS_SIGNING_HELPER_SHA256
  SONAR_BACKUP_AWS_ROLE_ARN
)
for key in "${required[@]}"; do
  [ -n "${!key:-}" ] || { echo "Backup configuration is missing $key" >&2; exit 1; }
done
[[ "$SONAR_BACKUP_S3_ENDPOINT" =~ ^https://[^[:space:]]+$ ]] || { echo "S3 endpoint must use HTTPS" >&2; exit 1; }
expected_aws_s3_endpoint="https://s3.${AWS_REGION:-us-east-1}.amazonaws.com"
[ "$SONAR_BACKUP_S3_ENDPOINT" = "$expected_aws_s3_endpoint" ] \
  || { echo "Sonar backup endpoint must match the canonical regional AWS S3 endpoint" >&2; exit 1; }
[[ "$SONAR_BACKUP_S3_BUCKET" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{1,62}$ ]] || { echo "Invalid S3 bucket" >&2; exit 1; }
[[ "$SONAR_BACKUP_S3_PREFIX" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]*[A-Za-z0-9]$ ]] \
  && [[ "$SONAR_BACKUP_S3_PREFIX" != *..* ]] \
  && [[ "$SONAR_BACKUP_S3_PREFIX" != //* ]] || { echo "Invalid S3 prefix" >&2; exit 1; }
[[ "$SONAR_DB_NAME" =~ ^[A-Za-z0-9_]+$ && "$SONAR_DB_USER" =~ ^[A-Za-z0-9_]+$ ]] || { echo "Invalid Sonar database identity" >&2; exit 1; }
[[ "$SONAR_BACKUP_AGE_RECIPIENT" =~ ^age1[0-9a-z]{58}$ ]] || { echo "Invalid native age recipient" >&2; exit 1; }
[[ "$SONAR_BACKUP_AWS_SIGNING_HELPER_SHA256" =~ ^[a-f0-9]{64}$ ]] \
  || { echo "Reviewed aws_signing_helper SHA-256 is invalid" >&2; exit 1; }
[ "$AWS_PROFILE" = nexus-sonarqube-backup ] \
  || { echo "AWS_PROFILE must be nexus-sonarqube-backup" >&2; exit 1; }
[[ "$SONAR_BACKUP_AWS_ROLE_ARN" =~ ^arn:aws:iam::[0-9]{12}:role/[A-Za-z0-9+=,.@_/-]{1,512}$ ]] \
  || { echo "Sonar backup role ARN is invalid" >&2; exit 1; }

for file in "$AWS_CONFIG_FILE"; do
  [[ "$file" == /* ]] && [ -f "$file" ] && [ ! -L "$file" ] \
    || { echo "AWS credential-process config is missing: $file" >&2; exit 1; }
  mode="$(stat -c '%a' "$file" 2>/dev/null || stat -f '%Lp' "$file")"
  owner="$(stat -c '%U' "$file" 2>/dev/null || stat -f '%Su' "$file")"
  [ "$mode" = 600 ] && [ "$owner" = root ] \
    || { echo "AWS credential-process config must be root-owned mode 0600" >&2; exit 1; }
done
[[ "$SONAR_BACKUP_AWS_SIGNING_HELPER" == /* ]] \
  && [ "$SONAR_BACKUP_AWS_SIGNING_HELPER" != / ] \
  && [ -f "$SONAR_BACKUP_AWS_SIGNING_HELPER" ] \
  && [ ! -L "$SONAR_BACKUP_AWS_SIGNING_HELPER" ] \
  && [ -x "$SONAR_BACKUP_AWS_SIGNING_HELPER" ] \
  || { echo "aws_signing_helper must be an absolute executable non-symlink file" >&2; exit 1; }
helper_owner="$(stat -c '%U' "$SONAR_BACKUP_AWS_SIGNING_HELPER" 2>/dev/null || stat -f '%Su' "$SONAR_BACKUP_AWS_SIGNING_HELPER")"
helper_mode="$(stat -c '%a' "$SONAR_BACKUP_AWS_SIGNING_HELPER" 2>/dev/null || stat -f '%Lp' "$SONAR_BACKUP_AWS_SIGNING_HELPER")"
[ "$helper_owner" = root ] \
  && (( (8#$helper_mode & 0022) == 0 )) \
  || { echo "aws_signing_helper must be root-owned and not group/world writable" >&2; exit 1; }

for command in docker age aws sha256sum flock mv node openssl python3; do
  command -v "$command" >/dev/null 2>&1 || { echo "$command is required for Sonar backup" >&2; exit 1; }
done
[ -f "$AWS_CREDENTIAL_BOUNDARY_HELPER" ] && [ ! -L "$AWS_CREDENTIAL_BOUNDARY_HELPER" ] \
  || { echo "AWS credential-process boundary helper is missing" >&2; exit 1; }
[ -f "$RETENTION_HELPER" ] && [ ! -L "$RETENTION_HELPER" ] \
  || { echo "Sonar distinct-period retention helper is missing" >&2; exit 1; }
python3 "$AWS_CREDENTIAL_BOUNDARY_HELPER" \
  --config "$AWS_CONFIG_FILE" \
  --profile "$AWS_PROFILE" \
  --region "${AWS_REGION:-us-east-1}" \
  --helper "$SONAR_BACKUP_AWS_SIGNING_HELPER" \
  --helper-sha256 "$SONAR_BACKUP_AWS_SIGNING_HELPER_SHA256" \
  --expected-role-arn "$SONAR_BACKUP_AWS_ROLE_ARN" >/dev/null
[ "$ACTION" != enable ] || command -v systemctl >/dev/null 2>&1 \
  || { echo "systemctl is required to enable the Sonar backup timer" >&2; exit 1; }
[ -f "$STACK_DIR/compose.yaml" ] && [ -f "$STACK_DIR/images.lock.env" ] || { echo "Sonar stack files are missing" >&2; exit 1; }

if [ "$ACTION" = verify ]; then
  probe_dir="$(mktemp -d)"
  cleanup_probe() { rm -rf "$probe_dir"; }
  trap cleanup_probe EXIT
  chmod 0700 "$probe_dir"
  printf 'nexus-sonarqube-backup-readiness\n' >"$probe_dir/probe.txt"
  age --encrypt --recipient "$SONAR_BACKUP_AGE_RECIPIENT" \
    --output "$probe_dir/probe.age" "$probe_dir/probe.txt"
  [ -s "$probe_dir/probe.age" ] || { echo "age encryption readiness probe failed" >&2; exit 1; }
  aws --cli-connect-timeout 5 --cli-read-timeout 10 \
      --endpoint-url "$SONAR_BACKUP_S3_ENDPOINT" \
      --region "${AWS_REGION:-us-east-1}" \
      s3api head-bucket --bucket "$SONAR_BACKUP_S3_BUCKET" >/dev/null
  versioning_probe="$probe_dir/versioning.json"
  aws --cli-connect-timeout 5 --cli-read-timeout 10 \
      --endpoint-url "$SONAR_BACKUP_S3_ENDPOINT" \
      --region "${AWS_REGION:-us-east-1}" \
      s3api get-bucket-versioning \
      --bucket "$SONAR_BACKUP_S3_BUCKET" >"$versioning_probe"
  node -e \
    'const v=require(process.argv[1]);if(v.Status!=="Enabled")process.exit(1)' \
    "$versioning_probe" \
    || { echo "Sonar backup bucket versioning must be enabled" >&2; exit 1; }
  echo "sonar_backup_config_ok encryption=age transport=s3-compatible remoteBucket=head-ok retention=7-daily,4-weekly"
  exit 0
fi

mutex=/run/lock/nexus-release-sonar.lock
[ -f "$mutex" ] && [ ! -L "$mutex" ] \
  && [ "$(stat -c '%U:%G' "$mutex")" = root:dominguez ] \
  && [ "$(stat -c '%a' "$mutex")" = 660 ] \
  || { echo "Preprovisioned root:dominguez mode-0660 release/Sonar mutex is invalid" >&2; exit 1; }
exec 8<>"$mutex"
flock -n 8 || { echo "Sonar backup skipped: a release, scan, or stack operation is active" >&2; exit 75; }

compose=(docker compose --project-directory "$STACK_DIR" --env-file "$STACK_DIR/images.lock.env" --env-file "$SECRETS_FILE" -f "$STACK_DIR/compose.yaml")
"${compose[@]}" ps --status running --quiet postgres | grep -q . || { echo "Sonar PostgreSQL container is not running" >&2; exit 1; }

tmp_dir="$(mktemp -d)"
cleanup() { rm -rf "$tmp_dir"; }
trap cleanup EXIT
chmod 0700 "$tmp_dir"
utc_anchor="$(date -u '+%Y%m%dT%H%M%SZ %u')"
timestamp="${utc_anchor% *}"
utc_weekday="${utc_anchor##* }"
[[ "$timestamp" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] \
  && [[ "$utc_weekday" =~ ^[1-7]$ ]] \
  || { echo "UTC backup anchor is invalid" >&2; exit 1; }
basename="nexus-sonarqube-$timestamp.dump.age"
dump="$tmp_dir/sonar.dump"
encrypted="$tmp_dir/$basename"
checksum="$tmp_dir/$basename.sha256"

"${compose[@]}" exec -T postgres sh -eu -c \
  'PGPASSWORD="$POSTGRES_PASSWORD" exec pg_dump --format=custom --no-owner --no-privileges --username "$1" --dbname "$2"' \
  sh "$SONAR_DB_USER" "$SONAR_DB_NAME" >"$dump"
[ -s "$dump" ] || { echo "pg_dump produced an empty backup" >&2; exit 1; }
"${compose[@]}" exec -T postgres pg_restore --list <"$dump" >/dev/null
age --encrypt --recipient "$SONAR_BACKUP_AGE_RECIPIENT" --output "$encrypted" "$dump"
[ -s "$encrypted" ] || { echo "age produced an empty encrypted backup" >&2; exit 1; }
rm -f "$dump"
unset SONAR_DB_PASSWORD SONAR_AUTH_JWTBASE64HS256SECRET
printf '%s  %s\n' "$(sha256sum "$encrypted" | awk '{ print $1 }')" "$basename" >"$checksum"
encrypted_s3_checksum_sha256="$(
  openssl dgst -sha256 -binary "$encrypted" | openssl base64 -A
)"
checksum_s3_checksum_sha256="$(
  openssl dgst -sha256 -binary "$checksum" | openssl base64 -A
)"
[[ "$encrypted_s3_checksum_sha256" =~ ^[A-Za-z0-9+/]{43}=$ ]] \
  && [[ "$checksum_s3_checksum_sha256" =~ ^[A-Za-z0-9+/]{43}=$ ]] \
  || { echo "Local Sonar S3 checksum identity is invalid" >&2; exit 1; }

aws_args=(--endpoint-url "$SONAR_BACKUP_S3_ENDPOINT" --region "${AWS_REGION:-us-east-1}")
bucket_versioning="$tmp_dir/bucket-versioning.json"
aws "${aws_args[@]}" s3api get-bucket-versioning \
  --bucket "$SONAR_BACKUP_S3_BUCKET" >"$bucket_versioning"
node -e \
  'const v=require(process.argv[1]);if(v.Status!=="Enabled")process.exit(1)' \
  "$bucket_versioning" \
  || { echo "Sonar backup requires enabled S3 bucket versioning" >&2; exit 1; }
daily_object_version_id=""
daily_checksum_version_id=""
weekly_object_version_id=""
weekly_checksum_version_id=""
upload_pair() {
  local tier="$1" key="$SONAR_BACKUP_S3_PREFIX/$tier/$basename"
  local encrypted_sha256 encrypted_size checksum_size head checksum_head
  local object_put checksum_put object_version_id checksum_version_id
  encrypted_sha256="$(awk 'NR == 1 { print $1 }' "$checksum")"
  encrypted_size="$(stat -c '%s' "$encrypted")"
  checksum_size="$(stat -c '%s' "$checksum")"
  head="$tmp_dir/$tier-head.json"
  checksum_head="$tmp_dir/$tier-checksum-head.json"
  object_put="$tmp_dir/$tier-object-put.json"
  checksum_put="$tmp_dir/$tier-checksum-put.json"
  [[ "$encrypted_sha256" =~ ^[a-f0-9]{64}$ ]] \
    && [[ "$encrypted_size" =~ ^[1-9][0-9]*$ ]] \
    || { echo "Local encrypted Sonar backup identity is invalid" >&2; exit 1; }
  aws "${aws_args[@]}" s3api put-object \
    --bucket "$SONAR_BACKUP_S3_BUCKET" \
    --key "$key" \
    --body "$encrypted" \
    --content-type application/octet-stream \
    --checksum-algorithm SHA256 \
    --checksum-sha256 "$encrypted_s3_checksum_sha256" \
    --metadata "encrypted-sha256=$encrypted_sha256" >"$object_put"
  aws "${aws_args[@]}" s3api put-object \
    --bucket "$SONAR_BACKUP_S3_BUCKET" \
    --key "$key.sha256" \
    --body "$checksum" \
    --content-type text/plain \
    --checksum-algorithm SHA256 \
    --checksum-sha256 "$checksum_s3_checksum_sha256" >"$checksum_put"
  object_version_id="$(node -e \
    'const v=require(process.argv[1]).VersionId,b=typeof v==="string"?Buffer.from(v,"utf8"):null;if(!b||v==="null"||b.length<1||b.length>1024||b.toString("utf8")!==v||/[\u0000-\u001f\u007f]/u.test(v))process.exit(1);process.stdout.write(v)' \
    "$object_put")"
  checksum_version_id="$(node -e \
    'const v=require(process.argv[1]).VersionId,b=typeof v==="string"?Buffer.from(v,"utf8"):null;if(!b||v==="null"||b.length<1||b.length>1024||b.toString("utf8")!==v||/[\u0000-\u001f\u007f]/u.test(v))process.exit(1);process.stdout.write(v)' \
    "$checksum_put")"
  [ -n "$object_version_id" ] && [ -n "$checksum_version_id" ] \
    || { echo "Sonar backup bucket must return immutable object VersionIds" >&2; exit 1; }
  aws "${aws_args[@]}" s3api head-object \
    --bucket "$SONAR_BACKUP_S3_BUCKET" --key "$key" \
    --checksum-mode ENABLED \
    --version-id="$object_version_id" >"$head"
  aws "${aws_args[@]}" s3api head-object \
    --bucket "$SONAR_BACKUP_S3_BUCKET" --key "$key.sha256" \
    --checksum-mode ENABLED \
    --version-id="$checksum_version_id" >"$checksum_head"
  node - "$head" "$checksum_head" "$encrypted_size" "$checksum_size" \
    "$encrypted_sha256" "$encrypted_s3_checksum_sha256" \
    "$checksum_s3_checksum_sha256" \
    "$object_version_id" "$checksum_version_id" <<'NODE'
const fs = require('fs');
const [
  headPath,
  checksumHeadPath,
  expectedSizeRaw,
  expectedChecksumSizeRaw,
  expectedSha256,
  expectedDataChecksumSha256,
  expectedChecksumObjectChecksumSha256,
  expectedVersionId,
  expectedChecksumVersionId,
] = process.argv.slice(2);
const head = JSON.parse(fs.readFileSync(headPath, 'utf8'));
const checksumHead = JSON.parse(fs.readFileSync(checksumHeadPath, 'utf8'));
const metadata = Object.fromEntries(
  Object.entries(head.Metadata || {}).map(([key, value]) => [key.toLowerCase(), value]),
);
if (Number(head.ContentLength) !== Number(expectedSizeRaw)
    || metadata['encrypted-sha256'] !== expectedSha256
    || head.ChecksumSHA256 !== expectedDataChecksumSha256
    || head.VersionId !== expectedVersionId
    || Number(checksumHead.ContentLength) !== Number(expectedChecksumSizeRaw)
    || checksumHead.ChecksumSHA256 !== expectedChecksumObjectChecksumSha256
    || checksumHead.VersionId !== expectedChecksumVersionId) {
  throw new Error('remote encrypted Sonar backup identity differs from local bytes');
}
NODE
  case "$tier" in
    daily)
      daily_object_version_id="$object_version_id"
      daily_checksum_version_id="$checksum_version_id"
      ;;
    weekly)
      weekly_object_version_id="$object_version_id"
      weekly_checksum_version_id="$checksum_version_id"
      ;;
    *) echo "Unsupported Sonar backup tier" >&2; exit 1 ;;
  esac
}

upload_pair daily
weekly_uploaded=false
if [ "$utc_weekday" = 7 ]; then
  upload_pair weekly
  weekly_uploaded=true
fi

daily_retention_evidence="$tmp_dir/daily-retention-evidence.json"
weekly_retention_evidence="$tmp_dir/weekly-retention-evidence.json"
attest_retained_pairs() {
  local tier="$1" selection_evidence="$2" attestations="$3"
  local selections="$tmp_dir/$tier-retention-selections.tsv"
  local index=0 period key extra
  local data_head checksum_head checksum_file data_head_final checksum_head_final
  local checksum_version_id

  node - "$selection_evidence" "$selections" "$attestations" <<'NODE'
const fs = require('fs');
const [evidencePath, selectionsPath, attestationsPath] = process.argv.slice(2);
const value = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
if ((value.schemaVersion !== 'SonarRetentionPlanV1'
      && value.schemaVersion !== 'SonarRetentionEvidenceV1')
    || !Array.isArray(value.selectedPeriods)
    || !Array.isArray(value.selectedKeys)
    || value.selectedPeriods.length !== value.selectedKeys.length
    || value.selectedKeys.some(key =>
      typeof key !== 'string' || !/^[A-Za-z0-9._/-]+$/u.test(key))
    || value.selectedPeriods.some(period =>
      typeof period !== 'string' || !/^[0-9]{4}-(?:[0-9]{2}-[0-9]{2}|W[0-9]{2})$/u.test(period))) {
  throw new Error('Sonar retention inventory evidence cannot be transported safely');
}
fs.writeFileSync(
  selectionsPath,
  value.selectedKeys.length === 0
    ? ''
    : `${value.selectedKeys
      .map((key, index) => `${value.selectedPeriods[index]}\t${key}`)
      .join('\n')}\n`,
  { encoding: 'utf8', flag: 'wx', mode: 0o600 },
);
fs.writeFileSync(attestationsPath, '', {
  encoding: 'utf8',
  flag: 'wx',
  mode: 0o600,
});
NODE

  while IFS=$'\t' read -r period key extra; do
    [ -n "$period" ] && [ -n "$key" ] && [ -z "$extra" ] \
      || { echo "Sonar retention selection row is unsafe" >&2; return 1; }
    case "$key" in
      "$SONAR_BACKUP_S3_PREFIX/$tier/"nexus-sonarqube-????????T??????Z.dump.age) ;;
      *) echo "Sonar retention selected an unsafe key" >&2; return 1 ;;
    esac
    data_head="$tmp_dir/$tier-retained-$index-data-head.json"
    checksum_head="$tmp_dir/$tier-retained-$index-checksum-head.json"
    checksum_file="$tmp_dir/$tier-retained-$index.sha256"
    data_head_final="$tmp_dir/$tier-retained-$index-data-head-final.json"
    checksum_head_final="$tmp_dir/$tier-retained-$index-checksum-head-final.json"

    aws "${aws_args[@]}" s3api head-object \
      --bucket "$SONAR_BACKUP_S3_BUCKET" \
      --key "$key" \
      --checksum-mode ENABLED >"$data_head"
    aws "${aws_args[@]}" s3api head-object \
      --bucket "$SONAR_BACKUP_S3_BUCKET" \
      --key "$key.sha256" \
      --checksum-mode ENABLED >"$checksum_head"
    checksum_version_id="$(node -e '
      const value=require(process.argv[1]);
      const v=value.VersionId;
      const b=typeof v==="string"?Buffer.from(v,"utf8"):null;
      const checksum=value.ChecksumSHA256;
      const decoded=typeof checksum==="string"
        ?Buffer.from(checksum,"base64")
        :null;
      if(!b||v==="null"||b.length<1||b.length>1024
          ||b.toString("utf8")!==v||/[\u0000-\u001f\u007f]/u.test(v)
          ||!Number.isSafeInteger(Number(value.ContentLength))
          ||Number(value.ContentLength)<1||Number(value.ContentLength)>4096
          ||!decoded||decoded.length!==32||decoded.toString("base64")!==checksum)
        process.exit(1);
      process.stdout.write(v);
    ' "$checksum_head")"
    [ -n "$checksum_version_id" ] \
      || { echo "Retained Sonar checksum VersionId is invalid" >&2; return 1; }
    aws "${aws_args[@]}" s3api get-object \
      --bucket "$SONAR_BACKUP_S3_BUCKET" \
      --key "$key.sha256" \
      --version-id="$checksum_version_id" \
      "$checksum_file" >/dev/null
    aws "${aws_args[@]}" s3api head-object \
      --bucket "$SONAR_BACKUP_S3_BUCKET" \
      --key "$key" \
      --checksum-mode ENABLED >"$data_head_final"
    aws "${aws_args[@]}" s3api head-object \
      --bucket "$SONAR_BACKUP_S3_BUCKET" \
      --key "$key.sha256" \
      --checksum-mode ENABLED >"$checksum_head_final"

    node - "$tier" "$period" "$key" "$data_head" "$checksum_head" \
      "$checksum_file" "$data_head_final" "$checksum_head_final" \
      "$attestations" <<'NODE'
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const [
  tier,
  period,
  key,
  dataHeadPath,
  checksumHeadPath,
  checksumPath,
  finalDataHeadPath,
  finalChecksumHeadPath,
  attestationsPath,
] = process.argv.slice(2);
const data = JSON.parse(fs.readFileSync(dataHeadPath, 'utf8'));
const checksum = JSON.parse(fs.readFileSync(checksumHeadPath, 'utf8'));
const finalData = JSON.parse(fs.readFileSync(finalDataHeadPath, 'utf8'));
const finalChecksum = JSON.parse(fs.readFileSync(finalChecksumHeadPath, 'utf8'));
const checksumBody = fs.readFileSync(checksumPath);
const opaqueVersionId = value => {
  if (typeof value !== 'string' || value === 'null') return false;
  const encoded = Buffer.from(value, 'utf8');
  return encoded.length >= 1
    && encoded.length <= 1024
    && encoded.toString('utf8') === value
    && !/[\u0000-\u001f\u007f]/u.test(value);
};
const canonicalBase64Sha256 = value => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]{43}=$/u.test(value)) {
    return null;
  }
  const decoded = Buffer.from(value, 'base64');
  return decoded.length === 32 && decoded.toString('base64') === value
    ? decoded
    : null;
};
const metadata = Object.fromEntries(
  Object.entries(data.Metadata || {}).map(([name, value]) => [
    name.toLowerCase(),
    value,
  ]),
);
const encryptedSha256 = metadata['encrypted-sha256'];
const dataChecksum = canonicalBase64Sha256(data.ChecksumSHA256);
const checksumObjectChecksum = canonicalBase64Sha256(checksum.ChecksumSHA256);
const checksumBodySha256 = crypto
  .createHash('sha256')
  .update(checksumBody)
  .digest('base64');
const expectedChecksumBody = `${encryptedSha256}  ${path.basename(key)}\n`;
if (!opaqueVersionId(data.VersionId)
    || !opaqueVersionId(checksum.VersionId)
    || finalData.VersionId !== data.VersionId
    || finalChecksum.VersionId !== checksum.VersionId
    || finalData.ChecksumSHA256 !== data.ChecksumSHA256
    || finalChecksum.ChecksumSHA256 !== checksum.ChecksumSHA256
    || Number(finalData.ContentLength) !== Number(data.ContentLength)
    || Number(finalChecksum.ContentLength) !== Number(checksum.ContentLength)
    || !/^[a-f0-9]{64}$/u.test(encryptedSha256 || '')
    || !dataChecksum
    || dataChecksum.toString('hex') !== encryptedSha256
    || !checksumObjectChecksum
    || checksumBodySha256 !== checksum.ChecksumSHA256
    || checksumBody.toString('utf8') !== expectedChecksumBody
    || !Number.isSafeInteger(Number(data.ContentLength))
    || Number(data.ContentLength) <= 0
    || !Number.isSafeInteger(Number(checksum.ContentLength))
    || Number(checksum.ContentLength) !== checksumBody.length
    || checksumBody.length <= 0
    || checksumBody.length > 4096) {
  throw new Error('Retained Sonar backup pair failed exact remote attestation');
}
const point = {
  schemaVersion: 'SonarRetentionPointV1',
  tier,
  period,
  key,
  checksumKey: `${key}.sha256`,
  dataVersionId: data.VersionId,
  checksumVersionId: checksum.VersionId,
  encryptedSha256,
  encryptedSizeBytes: Number(data.ContentLength),
  checksumSizeBytes: Number(checksum.ContentLength),
  dataChecksumSha256: data.ChecksumSHA256,
  checksumObjectChecksumSha256: checksum.ChecksumSHA256,
};
fs.appendFileSync(attestationsPath, `${JSON.stringify(point)}\n`, {
  encoding: 'utf8',
});
NODE
    index=$((index + 1))
  done <"$selections"

}

revalidate_retained_pairs() {
  local tier="$1" inventory_evidence="$2" attestations="$3" output="$4"
  local candidate="$tmp_dir/$tier-retention-bound-candidate.json"
  local rows="$tmp_dir/$tier-retention-revalidation.tsv"
  local index key extra data_head checksum_head

  node "$RETENTION_HELPER" bind \
    --evidence "$inventory_evidence" \
    --attestations "$attestations" \
    --output "$candidate"
  node - "$candidate" "$rows" <<'NODE'
const fs = require('fs');
const [candidatePath, output] = process.argv.slice(2);
const value = JSON.parse(fs.readFileSync(candidatePath, 'utf8'));
if (value.schemaVersion !== 'SonarRetentionEvidenceV1'
    || value.completePairsVerified !== true
    || !Array.isArray(value.selectedPoints)
    || value.selectedPoints.some(point =>
      typeof point?.key !== 'string'
      || !/^[A-Za-z0-9._/-]+$/u.test(point.key))) {
  throw new Error('Bound Sonar retention evidence is invalid');
}
fs.writeFileSync(
  output,
  value.selectedPoints.length === 0
    ? ''
    : `${value.selectedPoints
      .map((point, index) => `${index}\t${point.key}`)
      .join('\n')}\n`,
  { encoding: 'utf8', flag: 'wx', mode: 0o600 },
);
NODE
  while IFS=$'\t' read -r index key extra; do
    [[ "$index" =~ ^[0-9]+$ ]] && [ -n "$key" ] && [ -z "$extra" ] \
      || { echo "Sonar retention revalidation row is unsafe" >&2; return 1; }
    case "$key" in
      "$SONAR_BACKUP_S3_PREFIX/$tier/"nexus-sonarqube-????????T??????Z.dump.age) ;;
      *) echo "Sonar retention revalidation selected an unsafe key" >&2; return 1 ;;
    esac
    data_head="$tmp_dir/$tier-retained-$index-post-prune-data-head.json"
    checksum_head="$tmp_dir/$tier-retained-$index-post-prune-checksum-head.json"
    aws "${aws_args[@]}" s3api head-object \
      --bucket "$SONAR_BACKUP_S3_BUCKET" \
      --key "$key" \
      --checksum-mode ENABLED >"$data_head"
    aws "${aws_args[@]}" s3api head-object \
      --bucket "$SONAR_BACKUP_S3_BUCKET" \
      --key "$key.sha256" \
      --checksum-mode ENABLED >"$checksum_head"
    node - "$candidate" "$index" "$data_head" "$checksum_head" <<'NODE'
const fs = require('fs');
const [candidatePath, indexRaw, dataHeadPath, checksumHeadPath] =
  process.argv.slice(2);
const point = JSON.parse(
  fs.readFileSync(candidatePath, 'utf8'),
).selectedPoints?.[Number(indexRaw)];
const data = JSON.parse(fs.readFileSync(dataHeadPath, 'utf8'));
const checksum = JSON.parse(fs.readFileSync(checksumHeadPath, 'utf8'));
const metadata = Object.fromEntries(
  Object.entries(data.Metadata || {}).map(([name, value]) => [
    name.toLowerCase(),
    value,
  ]),
);
if (!point
    || data.VersionId !== point.dataVersionId
    || checksum.VersionId !== point.checksumVersionId
    || data.ChecksumSHA256 !== point.dataChecksumSha256
    || checksum.ChecksumSHA256 !== point.checksumObjectChecksumSha256
    || metadata['encrypted-sha256'] !== point.encryptedSha256
    || Number(data.ContentLength) !== point.encryptedSizeBytes
    || Number(checksum.ContentLength) !== point.checksumSizeBytes) {
  throw new Error('Retained Sonar pair changed during retention pruning');
}
NODE
  done <"$rows"
  mv -T -- "$candidate" "$output"
}

prune_tier() {
  local tier="$1" retain="$2" protected_key="$3"
  local prefix="$SONAR_BACKUP_S3_PREFIX/$tier/"
  local listing="$tmp_dir/$tier-retention-before.json"
  local plan="$tmp_dir/$tier-retention-plan.json"
  local deletions="$tmp_dir/$tier-retention-delete.txt"
  local post_listing="$tmp_dir/$tier-retention-after.json"
  local inventory_evidence="$tmp_dir/$tier-retention-inventory-evidence.json"
  local attestations="$tmp_dir/$tier-retention-attestations.jsonl"
  local evidence="$tmp_dir/$tier-retention-evidence.json"
  local deletion_result deletion_index=0
  local plan_args=(
    plan
    --listing "$listing"
    --prefix "$prefix"
    --tier "$tier"
    --retain "$retain"
    --output "$plan"
  )
  [ -z "$protected_key" ] || plan_args+=(--protected-key "$protected_key")

  aws "${aws_args[@]}" s3api list-objects-v2 \
    --bucket "$SONAR_BACKUP_S3_BUCKET" \
    --prefix "$prefix" \
    --no-paginate \
    --max-keys 1000 \
    --output json >"$listing"
  node "$RETENTION_HELPER" "${plan_args[@]}"
  # Prove every selected recovery point before mutating any visible key. A
  # corrupt newest-by-name pair must not hide an older usable point.
  attest_retained_pairs "$tier" "$plan" "$attestations"
  node - "$plan" "$deletions" <<'NODE'
const fs = require('fs');
const [planPath, output] = process.argv.slice(2);
const value = JSON.parse(fs.readFileSync(planPath, 'utf8'));
if (value.schemaVersion !== 'SonarRetentionPlanV1'
    || !Array.isArray(value.deleteKeys)
    || value.deleteKeys.some(key => typeof key !== 'string' || /[\r\n\u0000]/u.test(key))) {
  throw new Error('Sonar retention plan cannot be transported safely');
}
fs.writeFileSync(
  output,
  value.deleteKeys.length === 0 ? '' : `${value.deleteKeys.join('\n')}\n`,
  { mode: 0o600, flag: 'wx' },
);
NODE
  while IFS= read -r key; do
    [ -n "$key" ] || continue
    case "$key" in
      "$prefix"nexus-sonarqube-????????T??????Z.dump.age|\
      "$prefix"nexus-sonarqube-????????T??????Z.dump.age.sha256) ;;
      *) echo "Refusing unsafe Sonar retention deletion key" >&2; exit 1 ;;
    esac
    deletion_result="$tmp_dir/$tier-retention-delete-$deletion_index.json"
    aws "${aws_args[@]}" s3api delete-object \
      --bucket "$SONAR_BACKUP_S3_BUCKET" \
      --key "$key" >"$deletion_result"
    node - "$deletion_result" <<'NODE'
const value = require(process.argv[2]);
const versionId = value.VersionId;
const encoded = typeof versionId === 'string'
  ? Buffer.from(versionId, 'utf8')
  : null;
if (value.DeleteMarker !== true
    || !encoded
    || versionId === 'null'
    || encoded.length < 1
    || encoded.length > 1024
    || encoded.toString('utf8') !== versionId
    || /[\u0000-\u001f\u007f]/u.test(versionId)) {
  throw new Error(
    'Sonar retention deletion did not create an immutable delete marker',
  );
}
NODE
    deletion_index=$((deletion_index + 1))
  done <"$deletions"

  aws "${aws_args[@]}" s3api list-objects-v2 \
    --bucket "$SONAR_BACKUP_S3_BUCKET" \
    --prefix "$prefix" \
    --no-paginate \
    --max-keys 1000 \
    --output json >"$post_listing"
  node "$RETENTION_HELPER" verify \
    --listing "$post_listing" \
    --prefix "$prefix" \
    --tier "$tier" \
    --retain "$retain" \
    --plan "$plan" \
    --output "$inventory_evidence"
  revalidate_retained_pairs \
    "$tier" "$inventory_evidence" "$attestations" "$evidence"
}

prune_tier daily 7 "$SONAR_BACKUP_S3_PREFIX/daily/$basename"
if [ "$weekly_uploaded" = true ]; then
  prune_tier weekly 4 "$SONAR_BACKUP_S3_PREFIX/weekly/$basename"
else
  prune_tier weekly 4 ""
fi

write_success_receipt() {
  local receipt_dir temporary encrypted_sha256 encrypted_size
  receipt_dir="$(dirname -- "$SUCCESS_RECEIPT")"
  [ -d "$receipt_dir" ] && [ ! -L "$receipt_dir" ] \
    && [ "$(stat -c '%U:%G:%a' -- "$receipt_dir")" = root:root:700 ] \
    || { echo "Sonar backup receipt directory is unsafe" >&2; return 1; }
  if [ -e "$SUCCESS_RECEIPT" ] || [ -L "$SUCCESS_RECEIPT" ]; then
    [ -f "$SUCCESS_RECEIPT" ] && [ ! -L "$SUCCESS_RECEIPT" ] \
      && [ "$(stat -c '%U:%G:%a:%h' -- "$SUCCESS_RECEIPT")" = root:root:600:1 ] \
      || { echo "Existing Sonar backup success receipt is unsafe" >&2; return 1; }
  fi
  temporary="$(mktemp "$receipt_dir/.last-backup-success.next.XXXXXXXX")"
  encrypted_sha256="$(awk 'NR == 1 { print $1 }' "$checksum")"
  encrypted_size="$(stat -c '%s' "$encrypted")"
  if ! node - "$temporary" "$SONAR_BACKUP_S3_PREFIX/daily/$basename" \
    "$encrypted_sha256" "$encrypted_size" "$daily_object_version_id" \
    "$daily_checksum_version_id" "$weekly_uploaded" \
    "$weekly_object_version_id" "$weekly_checksum_version_id" \
    "$daily_retention_evidence" "$weekly_retention_evidence" \
    "$SUCCESS_RECEIPT" <<'NODE'
const fs = require('fs');
const [
  output,
  dailyKey,
  encryptedSha256,
  encryptedSizeBytesRaw,
  dailyObjectVersionId,
  dailyChecksumVersionId,
  weeklyUploaded,
  weeklyObjectVersionId,
  weeklyChecksumVersionId,
  dailyRetentionEvidencePath,
  weeklyRetentionEvidencePath,
  priorReceiptPath,
] = process.argv.slice(2);
const dailyRetentionEvidence = JSON.parse(
  fs.readFileSync(dailyRetentionEvidencePath, 'utf8'),
);
const weeklyRetentionEvidence = JSON.parse(
  fs.readFileSync(weeklyRetentionEvidencePath, 'utf8'),
);
let prior = null;
try {
  prior = JSON.parse(fs.readFileSync(priorReceiptPath, 'utf8'));
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}
if ((prior?.retentionEvidence?.daily?.targetReached === true
      && dailyRetentionEvidence.targetReached !== true)
    || (prior?.retentionEvidence?.weekly?.targetReached === true
      && weeklyRetentionEvidence.targetReached !== true)) {
  throw new Error(
    'Sonar retention maturity regressed below an established target',
  );
}
const value = {
  schemaVersion: 'SonarBackupSuccessV2',
  encrypted: true,
  remoteObjectVerified: true,
  dailyKey,
  encryptedSha256,
  encryptedSizeBytes: Number(encryptedSizeBytesRaw),
  dailyObjectVersionId,
  dailyChecksumVersionId,
  weeklyUploaded: weeklyUploaded === 'true',
  weeklyKey:
    weeklyUploaded === 'true'
      ? dailyKey.replace('/daily/', '/weekly/')
      : null,
  weeklyObjectVersionId: weeklyUploaded === 'true' ? weeklyObjectVersionId : null,
  weeklyChecksumVersionId: weeklyUploaded === 'true' ? weeklyChecksumVersionId : null,
  remoteVerification: {
    method: 'version-pinned-head-content-length-metadata-and-s3-sha256',
    daily: true,
    weekly: weeklyUploaded === 'true',
  },
  retention: {
    daily: 7,
    weekly: 4,
    basis: 'distinct-utc-days-and-iso-weeks',
  },
  retentionEvidence: {
    daily: dailyRetentionEvidence,
    weekly: weeklyRetentionEvidence,
  },
  completedAt: new Date().toISOString(),
};
fs.writeFileSync(output, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'w' });
const descriptor = fs.openSync(output, 'r');
try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
NODE
  then
    rm -f -- "$temporary"
    return 1
  fi
  chmod 0600 "$temporary"
  chown root:root "$temporary"
  mv -fT -- "$temporary" "$SUCCESS_RECEIPT"
  node - "$receipt_dir" <<'NODE'
const fs = require('fs');
const descriptor = fs.openSync(process.argv[2], 'r');
try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
NODE
}
write_success_receipt

if [ "$ACTION" = enable ]; then
  # The first encrypted off-host backup is complete before the owner enables
  # the schedule. Release the non-waiting mutex before systemd starts the timer;
  # a persistent first activation may immediately request another backup.
  flock -u 8
  exec 8>&-
  systemctl enable --now "$BACKUP_TIMER"
  if ! systemctl is-enabled --quiet "$BACKUP_TIMER" \
      || ! systemctl is-active --quiet "$BACKUP_TIMER"; then
    systemctl disable --now "$BACKUP_TIMER" >/dev/null 2>&1 || true
    echo "Sonar backup timer did not become enabled and active" >&2
    exit 1
  fi
  verify_freshness >/dev/null
  echo "sonar_backup_timer_enabled ownerAction=true timer=$BACKUP_TIMER freshnessHours=$MAX_AGE_HOURS"
fi
echo "sonar_backup_complete encrypted=true dailyKey=$SONAR_BACKUP_S3_PREFIX/daily/$basename weekly=$weekly_uploaded retention=7,4"
