#!/usr/bin/env bash
# Create a verified PostgreSQL custom-format dump, encrypt it with an off-host
# age recipient, upload to S3-compatible storage, and enforce 7 daily/4 weekly
# retention. No plaintext dump leaves the private temporary directory.
set -euo pipefail
umask 077

CONFIG=/etc/sonarqube/backup.env
STACK_DIR="${SONAR_STACK_DIR:-/srv/sonarqube}"
SECRETS_FILE="${SONAR_SECRETS_FILE:-/etc/sonarqube/sonarqube.env}"
SUCCESS_RECEIPT="${SONAR_BACKUP_SUCCESS_RECEIPT:-/var/lib/nexus-sonarqube/last-backup-success.v1.json}"
BACKUP_TIMER=nexus-sonarqube-backup.timer
MAX_AGE_HOURS=26
ACTION=backup
ACTION_SET=false

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
if (value.schemaVersion !== 'SonarBackupSuccessV1'
    || value.encrypted !== true || value.remoteObjectVerified !== true
    || value.retention?.daily !== 7 || value.retention?.weekly !== 4
    || typeof value.dailyKey !== 'string'
    || !/\/daily\/nexus-sonarqube-[0-9]{8}T[0-9]{6}Z\.dump\.age$/u.test(value.dailyKey)
    || !/^[a-f0-9]{64}$/u.test(value.encryptedSha256 || '')
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

required=(SONAR_BACKUP_S3_ENDPOINT SONAR_BACKUP_S3_BUCKET SONAR_BACKUP_S3_PREFIX SONAR_BACKUP_AGE_RECIPIENT SONAR_DB_NAME SONAR_DB_USER SONAR_DB_PASSWORD)
for key in "${required[@]}"; do
  [ -n "${!key:-}" ] || { echo "Backup configuration is missing $key" >&2; exit 1; }
done
[[ "$SONAR_BACKUP_S3_ENDPOINT" =~ ^https://[^[:space:]]+$ ]] || { echo "S3 endpoint must use HTTPS" >&2; exit 1; }
[[ "$SONAR_BACKUP_S3_BUCKET" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{1,62}$ ]] || { echo "Invalid S3 bucket" >&2; exit 1; }
[[ "$SONAR_BACKUP_S3_PREFIX" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]*[A-Za-z0-9]$ ]] \
  && [[ "$SONAR_BACKUP_S3_PREFIX" != *..* ]] \
  && [[ "$SONAR_BACKUP_S3_PREFIX" != //* ]] || { echo "Invalid S3 prefix" >&2; exit 1; }
[[ "$SONAR_DB_NAME" =~ ^[A-Za-z0-9_]+$ && "$SONAR_DB_USER" =~ ^[A-Za-z0-9_]+$ ]] || { echo "Invalid Sonar database identity" >&2; exit 1; }
[[ "$SONAR_BACKUP_AGE_RECIPIENT" =~ ^age1[0-9a-z]{58}$ ]] || { echo "Invalid native age recipient" >&2; exit 1; }

for command in docker age aws sha256sum flock node; do
  command -v "$command" >/dev/null 2>&1 || { echo "$command is required for Sonar backup" >&2; exit 1; }
done
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
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
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

aws_args=(--endpoint-url "$SONAR_BACKUP_S3_ENDPOINT" --region "${AWS_REGION:-us-east-1}")
upload_pair() {
  local tier="$1" key="$SONAR_BACKUP_S3_PREFIX/$tier/$basename"
  aws "${aws_args[@]}" s3api put-object --bucket "$SONAR_BACKUP_S3_BUCKET" --key "$key" --body "$encrypted" --content-type application/octet-stream >/dev/null
  aws "${aws_args[@]}" s3api put-object --bucket "$SONAR_BACKUP_S3_BUCKET" --key "$key.sha256" --body "$checksum" --content-type text/plain >/dev/null
  aws "${aws_args[@]}" s3api head-object --bucket "$SONAR_BACKUP_S3_BUCKET" --key "$key" >/dev/null
}

upload_pair daily
weekly_uploaded=false
if [ "$(date -u +%u)" = 7 ]; then
  upload_pair weekly
  weekly_uploaded=true
fi

prune_tier() {
  local tier="$1" retain="$2" listing="$tmp_dir/$tier.json" deletions="$tmp_dir/$tier-delete.txt"
  local prefix="$SONAR_BACKUP_S3_PREFIX/$tier/"
  aws "${aws_args[@]}" s3api list-objects-v2 --bucket "$SONAR_BACKUP_S3_BUCKET" --prefix "$prefix" --output json >"$listing"
  node - "$listing" "$prefix" "$retain" "$deletions" <<'NODE'
const fs = require('fs');
const [listingPath, prefix, retainRaw, output] = process.argv.slice(2);
const retain = Number(retainRaw);
const pattern = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}nexus-sonarqube-[0-9]{8}T[0-9]{6}Z\\.dump\\.age$`);
const body = JSON.parse(fs.readFileSync(listingPath, 'utf8'));
const keys = (body.Contents || []).map(item => item.Key).filter(key => pattern.test(key)).sort().reverse();
fs.writeFileSync(output, `${keys.slice(retain).join('\n')}${keys.length > retain ? '\n' : ''}`, { mode: 0o600 });
NODE
  while IFS= read -r key; do
    [ -n "$key" ] || continue
    case "$key" in "$prefix"nexus-sonarqube-????????T??????Z.dump.age) ;; *) echo "Refusing unsafe backup deletion key" >&2; exit 1 ;; esac
    aws "${aws_args[@]}" s3api delete-object --bucket "$SONAR_BACKUP_S3_BUCKET" --key "$key" >/dev/null
    aws "${aws_args[@]}" s3api delete-object --bucket "$SONAR_BACKUP_S3_BUCKET" --key "$key.sha256" >/dev/null
  done <"$deletions"
}

prune_tier daily 7
prune_tier weekly 4

write_success_receipt() {
  local receipt_dir temporary encrypted_sha256
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
  node - "$temporary" "$SONAR_BACKUP_S3_PREFIX/daily/$basename" \
    "$encrypted_sha256" "$weekly_uploaded" <<'NODE'
const fs = require('fs');
const [output, dailyKey, encryptedSha256, weeklyUploaded] = process.argv.slice(2);
const value = {
  schemaVersion: 'SonarBackupSuccessV1',
  encrypted: true,
  remoteObjectVerified: true,
  dailyKey,
  encryptedSha256,
  weeklyUploaded: weeklyUploaded === 'true',
  retention: { daily: 7, weekly: 4 },
  completedAt: new Date().toISOString(),
};
fs.writeFileSync(output, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'w' });
const descriptor = fs.openSync(output, 'r');
try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
NODE
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
