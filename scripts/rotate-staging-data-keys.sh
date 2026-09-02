#!/usr/bin/env bash
# Offline operator procedure for rotating the live staging OAuth, Garmin,
# Apple Health, and Finance data-encryption keys. This script is intentionally local-only;
# run it on the VPS as the owner of both live roots.

set +x
set -euo pipefail
umask 077

readonly ACKNOWLEDGEMENT='SERVICES_STOPPED_AND_WRITES_DRAINED'
readonly BACKEND_APP='nexus-hub-staging'
readonly CONTENT_APP='content-engine-staging'
readonly BACKEND_PORT='8201'
readonly CONTENT_PORT='8101'
readonly EXPECTED_ROTATOR_SHA256='27ef7e16b77454222fc7f831e72e77728e8e7e11547990012530e9ca49fbc170'

STAGING_ROOT=''
PRODUCTION_ROOT=''
STAGING_CURRENT_RELEASE=''
STAGING_RELEASE_SHA=''
STAGING_RELEASE_ARTIFACT_SHA256=''
PRODUCTION_CURRENT_RELEASE=''
PRODUCTION_RELEASE_SHA=''
PRODUCTION_RELEASE_ARTIFACT_SHA256=''
BACKUP_DIR=''
BACKUP_DB=''
STAGING_ENV=''
STAGING_AGENTS_ENV=''
PRODUCTION_ENV=''
PRODUCTION_AGENTS_ENV=''
NEXT_ENV=''
NEXT_AGENTS_ENV=''
ECOSYSTEM=''
ROTATOR=''
CONTENT_ROOT=''
CONTENT_PYTHON=''
DB_PATH=''
PM2=''
SANITIZED_PATH=''
SAFE_PM2_HOME=''
OPERATOR=''
RELEASE_LOCK_FILE=''
RELEASE_LOCK_FD=''

SERVICES_STOPPED=0
APPLY_ATTEMPTED=0
APPLY_CONFIRMED=0
ENV_ACTIVATED=0
COMPLETED=0
POSTAPPLY_STOP_VERIFIED=0
STAGING_FINANCE_BOOTSTRAP_ALLOWED=0

OLD_OAUTH_ENCRYPTION_KEY=''
OLD_GARMIN_ENCRYPTION_KEY=''
OLD_HEALTH_DATA_ENCRYPTION_KEY=''
OLD_FINANCE_ENCRYPTION_KEY=''
NEW_OAUTH_ENCRYPTION_KEY=''
NEW_GARMIN_ENCRYPTION_KEY=''
NEW_HEALTH_DATA_ENCRYPTION_KEY=''
NEW_FINANCE_ENCRYPTION_KEY=''
PEER_OAUTH_ENCRYPTION_KEY=''
PEER_GARMIN_ENCRYPTION_KEY=''
PEER_HEALTH_DATA_ENCRYPTION_KEY=''
PEER_FINANCE_ENCRYPTION_KEY=''

usage() {
  cat <<'USAGE'
Usage:
  rotate-staging-data-keys.sh \
    --staging-root=/home/dominguez/telegram-hub-bot-staging \
    --production-root=/home/dominguez/telegram-hub-bot

The two absolute roots are mandatory. The script never accepts key material
on the command line and never prints key material or decrypted data.
USAGE
}

die() {
  printf 'ERROR: %s\n' "$1" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "required command is unavailable: $1"
}

canonical_directory() {
  local directory="$1"
  [[ -d "$directory" ]] || return 1
  (cd -P -- "$directory" && pwd -P)
}

canonical_file() {
  node -e '
    const fs = require("node:fs");
    const value = process.argv[1];
    const stat = fs.statSync(value);
    if (!stat.isFile()) process.exit(2);
    process.stdout.write(fs.realpathSync(value));
  ' "$1"
}

resolve_current_release_identity() {
  local root="$1"
  local label="$2"
  local releases_root current_link release

  releases_root="$(canonical_directory "$root/releases")" \
    || die "$label releases root cannot be resolved"
  current_link="$root/current"
  [[ -d "$root/releases" && ! -L "$root/releases" ]] \
    || die "$label releases root must be a non-symlink directory"
  [[ -L "$current_link" ]] || die "$label current selector must be a symlink"
  release="$(canonical_directory "$current_link")" \
    || die "$label current selector cannot be resolved"
  [[ "$(dirname -- "$release")" == "$releases_root" ]] \
    || die "$label current selector must resolve to one direct child of releases"
  [[ -d "$release" && ! -L "$release" ]] \
    || die "$label current release must be a non-symlink directory"
  [[ -f "$release/.complete.json" && ! -L "$release/.complete.json" ]] \
    || die "$label current release completion marker is missing or symbolic"

  node - "$release" "$label" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const [release, label] = process.argv.slice(2);
const markerPath = path.join(release, '.complete.json');
const markerStat = fs.lstatSync(markerPath);
const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
if (!markerStat.isFile() || markerStat.isSymbolicLink()
    || marker?.schema !== 'nexus.release-bundle.v1'
    || !/^[0-9a-f]{40}$/u.test(marker.runtimeSha ?? '')
    || !/^[0-9a-f]{64}$/u.test(marker.artifactDigest ?? '')
    || path.basename(release)
      !== `${marker.runtimeSha}-${marker.artifactDigest.slice(0, 12)}`) {
  throw new Error(`${label} current release identity is invalid`);
}
process.stdout.write(`${release}\t${marker.runtimeSha}\t${marker.artifactDigest}`);
NODE
}

assert_current_release_unchanged() {
  local root="$1"
  local expected_release="$2"
  local expected_sha="$3"
  local expected_digest="$4"
  local label="$5"
  local observed observed_release observed_sha observed_digest

  observed="$(resolve_current_release_identity "$root" "$label")" \
    || die "$label current release identity is unavailable"
  IFS=$'\t' read -r observed_release observed_sha observed_digest <<<"$observed"
  [[ "$observed_release" == "$expected_release" \
    && "$observed_sha" == "$expected_sha" \
    && "$observed_digest" == "$expected_digest" ]] \
    || die "$label current release changed during data-key rotation"
}

assert_all_current_releases_unchanged() {
  assert_current_release_unchanged \
    "$STAGING_ROOT" "$STAGING_CURRENT_RELEASE" "$STAGING_RELEASE_SHA" \
    "$STAGING_RELEASE_ARTIFACT_SHA256" staging
  assert_current_release_unchanged \
    "$PRODUCTION_ROOT" "$PRODUCTION_CURRENT_RELEASE" "$PRODUCTION_RELEASE_SHA" \
    "$PRODUCTION_RELEASE_ARTIFACT_SHA256" production
}

acquire_release_lock() {
  local lock_directory
  lock_directory="$(dirname -- "$RELEASE_LOCK_FILE")"
  [[ -d "$lock_directory" && ! -L "$lock_directory" ]] \
    || die 'shared release lock directory is unavailable or symbolic'
  [[ -f "$RELEASE_LOCK_FILE" && ! -L "$RELEASE_LOCK_FILE" ]] \
    || die 'shared release lock is unavailable or symbolic'
  [[ "$(stat -c '%U:%a' -- "$RELEASE_LOCK_FILE")" == "$OPERATOR:600" ]] \
    || die 'shared release lock owner or mode is unsafe'
  exec {RELEASE_LOCK_FD}<>"$RELEASE_LOCK_FILE"
  flock -n "$RELEASE_LOCK_FD" \
    || die 'a release, Sonar scan, or another data-key rotation is active'
}

release_release_lock() {
  if [[ -n "$RELEASE_LOCK_FD" ]]; then
    flock -u "$RELEASE_LOCK_FD" >/dev/null 2>&1 || true
    exec {RELEASE_LOCK_FD}>&- 2>/dev/null || true
    RELEASE_LOCK_FD=''
  fi
}

verify_exact_rotator_artifact() {
  local artifact="$1"
  local expected_sha256="$2"
  local output actual_sha256
  [[ "$expected_sha256" =~ ^[0-9a-f]{64}$ ]] || die 'approved rotator digest is malformed'
  [[ -f "$artifact" && ! -L "$artifact" ]] \
    || die 'deployed dist rotator artifact is missing or is a symlink'
  output="$(sha256sum -- "$artifact")"
  actual_sha256="${output%% *}"
  [[ "$actual_sha256" == "$expected_sha256" ]] \
    || die 'staging rotator artifact does not match the exact approved digest'
}

assert_private_regular_file() {
  local file="$1"
  local label="$2"
  local mode owner

  [[ -f "$file" && ! -L "$file" ]] || die "$label must be a non-symlink regular file"
  mode="$(stat -c '%a' -- "$file")"
  case "$mode" in
    400|600) ;;
    *) die "$label must have mode 400 or 600" ;;
  esac
  owner="$(stat -c '%U' -- "$file")"
  [[ "$owner" == "$OPERATOR" ]] || die "$label must be owned by the current operator"
}

# Read one strict 64-hex key from a dotenv file. If the primary name is
# missing, use the explicit fallback name. Parsing is data-only: the dotenv
# file is never sourced or evaluated.
read_effective_key() {
  local file="$1"
  local primary="$2"
  local fallback="$3"
  node - "$file" "$primary" "$fallback" <<'NODE'
const fs = require('node:fs');
const [file, primary, fallback] = process.argv.slice(2);
const text = fs.readFileSync(file, 'utf8');

function read(name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^\\s*(?:export\\s+)?${escaped}\\s*=`, 'u');
  const matches = text.split(/\r?\n/u).filter((line) => pattern.test(line));
  if (matches.length > 1) throw new Error(`duplicate ${name} assignment`);
  if (matches.length === 0) return undefined;

  let value = matches[0].replace(pattern, '').trim();
  if ((value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  } else {
    value = value.replace(/\s+#.*$/u, '').trim();
  }
  if (!/^[0-9a-fA-F]{64}$/u.test(value)) {
    throw new Error(`${name} must be exactly 64 hexadecimal characters`);
  }
  return value;
}

try {
  const value = read(primary) ?? read(fallback);
  if (!value) throw new Error(`${primary} and fallback ${fallback} are missing`);
  process.stdout.write(value);
} catch (error) {
  process.stderr.write(`dotenv key read failed: ${error.message}\n`);
  process.exit(1);
}
NODE
}

dotenv_assignment_count() {
  local file="$1"
  local name="$2"
  node - "$file" "$name" <<'NODE'
const fs = require('node:fs');
const [file, name] = process.argv.slice(2);
const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const pattern = new RegExp(`^\\s*(?:export\\s+)?${escaped}\\s*=`, 'u');
const count = fs.readFileSync(file, 'utf8').split(/\r?\n/u).filter((line) => pattern.test(line)).length;
process.stdout.write(String(count));
NODE
}

assert_optional_key_parity() {
  local file="$1"
  local name="$2"
  local expected="$3"
  local label="$4"
  local count actual
  count="$(dotenv_assignment_count "$file" "$name")"
  case "$count" in
    0) return 0 ;;
    1)
      actual="$(read_effective_key "$file" "$name" "$name")"
      [[ "$actual" == "$expected" ]] || die "$label is not in encryption-key parity"
      ;;
    *) die "$label contains duplicate encryption-key assignments" ;;
  esac
}

assert_staging_finance_surface_empty() {
  local root="$1"
  local database="$2"
  node - "$root" "$database" <<'NODE'
const path = require('node:path');
const [root, databasePath] = process.argv.slice(2);
const Database = require(path.join(root, 'node_modules', 'better-sqlite3'));
const db = new Database(databasePath, { readonly: true, fileMustExist: true });
const specs = [
  ['finance_transactions', ['encrypted_amount', 'encrypted_description']],
  ['finance_tax_events', [
    'encrypted_gross_income',
    'encrypted_deductions',
    'encrypted_taxable_income',
    'encrypted_tax_due',
    'encrypted_inss_due',
    'encrypted_notes',
  ]],
];
try {
  for (const [table, columns] of specs) {
    const present = db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
    ).get(table);
    if (!present) continue;
    const actual = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((entry) => entry.name));
    if (columns.some((column) => !actual.has(column))) process.exit(2);
    const predicate = columns.map((column) => `(${column} IS NOT NULL AND ${column} <> '')`).join(' OR ');
    const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${predicate}`).get();
    if (!Number.isSafeInteger(row?.count) || row.count !== 0) process.exit(3);
  }
} finally {
  db.close();
}
NODE
}

generate_hex_key() {
  node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))'
}

assert_all_keys_unique() {
  local label="$1"
  shift
  local values=("$@")
  local left right
  for ((left = 0; left < ${#values[@]}; left += 1)); do
    [[ "${values[$left]}" =~ ^[0-9a-fA-F]{64}$ ]] \
      || die "$label contains a malformed key"
    for ((right = left + 1; right < ${#values[@]}; right += 1)); do
      [[ "${values[$left]}" != "${values[$right]}" ]] \
        || die "$label keys are not dedicated and distinct"
    done
  done
}

is_disallowed_key() {
  local candidate="$1"
  shift
  local value
  for value in "$@"; do
    [[ "$candidate" != "$value" ]] || return 0
  done
  return 1
}

generate_unique_destination_key() {
  local candidate
  while true; do
    candidate="$(generate_hex_key)"
    [[ "$candidate" =~ ^[0-9a-f]{64}$ ]] || die 'generated key failed the 64-hex invariant'
    if ! is_disallowed_key "$candidate" "$@"; then
      process_generated_key="$candidate"
      return 0
    fi
  done
}

clear_rotation_variables() {
  unset OLD_OAUTH_ENCRYPTION_KEY OLD_GARMIN_ENCRYPTION_KEY OLD_HEALTH_DATA_ENCRYPTION_KEY
  unset OLD_FINANCE_ENCRYPTION_KEY
  unset NEW_OAUTH_ENCRYPTION_KEY NEW_GARMIN_ENCRYPTION_KEY NEW_HEALTH_DATA_ENCRYPTION_KEY
  unset NEW_FINANCE_ENCRYPTION_KEY
  unset PEER_OAUTH_ENCRYPTION_KEY PEER_GARMIN_ENCRYPTION_KEY PEER_HEALTH_DATA_ENCRYPTION_KEY
  unset PEER_FINANCE_ENCRYPTION_KEY
  unset ROTATE_NEXT_OAUTH ROTATE_NEXT_GARMIN ROTATE_NEXT_HEALTH ROTATE_NEXT_FINANCE ROTATE_FINANCE_MODE
  unset process_generated_key all_existing_keys
  unset staging_agents_oauth staging_agents_garmin staging_agents_health staging_agents_finance
  unset production_agents_oauth production_agents_garmin production_agents_health production_agents_finance
}

write_next_env() {
  local source_file="$1"
  local destination_file="$2"
  local finance_mode="${3:-initialize}"
  [[ "$finance_mode" == 'initialize' || "$finance_mode" == 'if-present' ]] \
    || die 'invalid Finance dotenv rewrite mode'
  ROTATE_NEXT_OAUTH="$NEW_OAUTH_ENCRYPTION_KEY" \
  ROTATE_NEXT_GARMIN="$NEW_GARMIN_ENCRYPTION_KEY" \
  ROTATE_NEXT_HEALTH="$NEW_HEALTH_DATA_ENCRYPTION_KEY" \
  ROTATE_NEXT_FINANCE="$NEW_FINANCE_ENCRYPTION_KEY" \
  ROTATE_FINANCE_MODE="$finance_mode" \
    node - "$source_file" "$destination_file" <<'NODE'
const fs = require('node:fs');
const [source, destination] = process.argv.slice(2);
const replacements = new Map([
  ['OAUTH_ENCRYPTION_KEY', process.env.ROTATE_NEXT_OAUTH],
  ['GARMIN_ENCRYPTION_KEY', process.env.ROTATE_NEXT_GARMIN],
  ['HEALTH_DATA_ENCRYPTION_KEY', process.env.ROTATE_NEXT_HEALTH],
]);
const financeMode = process.env.ROTATE_FINANCE_MODE;
if (financeMode !== 'initialize' && financeMode !== 'if-present') {
  throw new Error('invalid Finance dotenv rewrite mode');
}

for (const [name, value] of replacements) {
  if (!/^[0-9a-f]{64}$/u.test(value ?? '')) {
    throw new Error(`${name} destination value is not strict 64-hex`);
  }
}
if (!/^[0-9a-f]{64}$/u.test(process.env.ROTATE_NEXT_FINANCE ?? '')) {
  throw new Error('FINANCE_ENCRYPTION_KEY destination value is not strict 64-hex');
}
if (fs.existsSync(destination)) throw new Error('next dotenv file already exists');

const original = fs.readFileSync(source, 'utf8');
const hadFinalNewline = original.endsWith('\n');
let lines = original.split(/\r?\n/u);
if (hadFinalNewline) lines.pop();

const financePattern = /^\s*(?:export\s+)?FINANCE_ENCRYPTION_KEY\s*=/u;
const financeCount = lines.filter((line) => financePattern.test(line)).length;
if (financeCount > 1) throw new Error('duplicate FINANCE_ENCRYPTION_KEY assignment');
if (financeMode === 'initialize' || financeCount === 1) {
  replacements.set('FINANCE_ENCRYPTION_KEY', process.env.ROTATE_NEXT_FINANCE);
}

for (const [name, value] of replacements) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^\\s*(?:export\\s+)?${escaped}\\s*=`, 'u');
  const indices = [];
  lines.forEach((line, index) => { if (pattern.test(line)) indices.push(index); });
  if (indices.length > 1) throw new Error(`duplicate ${name} assignment`);
  if (indices.length === 1) lines[indices[0]] = `${name}=${value}`;
  else lines.push(`${name}=${value}`);
}

const content = `${lines.join('\n')}\n`;
let fd;
let created = false;
try {
  fd = fs.openSync(destination, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
  created = true;
  fs.writeFileSync(fd, content, { encoding: 'utf8' });
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  fd = undefined;
  fs.chmodSync(destination, 0o600);
} catch (error) {
  if (fd !== undefined) fs.closeSync(fd);
  if (created) fs.rmSync(destination, { force: true });
  throw error;
}
NODE
}

validate_next_env() {
  local file="$1"
  local finance_mode="${2:-initialize}"
  local oauth garmin health finance mode
  [[ "$finance_mode" == 'initialize' || "$finance_mode" == 'if-present' ]] \
    || die 'invalid Finance dotenv validation mode'
  [[ -f "$file" && ! -L "$file" ]] || die 'next dotenv file is missing or unsafe'
  mode="$(stat -c '%a' -- "$file")"
  [[ "$mode" == '600' ]] || die 'next dotenv file must have mode 600'
  oauth="$(read_effective_key "$file" OAUTH_ENCRYPTION_KEY OAUTH_ENCRYPTION_KEY)"
  garmin="$(read_effective_key "$file" GARMIN_ENCRYPTION_KEY OAUTH_ENCRYPTION_KEY)"
  health="$(read_effective_key "$file" HEALTH_DATA_ENCRYPTION_KEY OAUTH_ENCRYPTION_KEY)"
  [[ "$oauth" == "$NEW_OAUTH_ENCRYPTION_KEY" ]] || die 'next OAuth key validation failed'
  [[ "$garmin" == "$NEW_GARMIN_ENCRYPTION_KEY" ]] || die 'next Garmin key validation failed'
  [[ "$health" == "$NEW_HEALTH_DATA_ENCRYPTION_KEY" ]] || die 'next Health key validation failed'
  if [[ "$finance_mode" == 'initialize' ]]; then
    finance="$(read_effective_key "$file" FINANCE_ENCRYPTION_KEY FINANCE_ENCRYPTION_KEY)"
    [[ "$finance" == "$NEW_FINANCE_ENCRYPTION_KEY" ]] || die 'next Finance key validation failed'
  else
    assert_optional_key_parity \
      "$file" FINANCE_ENCRYPTION_KEY "$NEW_FINANCE_ENCRYPTION_KEY" 'optional next Finance key'
  fi
}

sanitized_pm2() {
  env -i \
    HOME="$HOME" \
    USER="$OPERATOR" \
    LOGNAME="$OPERATOR" \
    PATH="$SANITIZED_PATH" \
    PM2_HOME="$SAFE_PM2_HOME" \
    "$PM2" "$@"
}

staging_release_pm2() {
  env -i \
    HOME="$HOME" \
    USER="$OPERATOR" \
    LOGNAME="$OPERATOR" \
    PATH="$SANITIZED_PATH" \
    PM2_HOME="$SAFE_PM2_HOME" \
    NEXUS_RELEASE_DIR="$STAGING_CURRENT_RELEASE" \
    NEXUS_RELEASE_BASE_DIR="$STAGING_ROOT" \
    NEXUS_RELEASE_ROLE=staging \
    NEXUS_RELEASE_SHA="$STAGING_RELEASE_SHA" \
    NEXUS_RELEASE_ARTIFACT_SHA256="$STAGING_RELEASE_ARTIFACT_SHA256" \
    GIT_COMMIT="$STAGING_RELEASE_SHA" \
    "$PM2" "$@"
}

secure_existing_pm2_resurrection_permissions() {
  local file
  [[ -d "$SAFE_PM2_HOME" && ! -L "$SAFE_PM2_HOME" ]] \
    || die 'PM2 home must be a non-symlink directory'
  [[ "$(stat -c '%U' -- "$SAFE_PM2_HOME")" == "$OPERATOR" ]] \
    || die 'PM2 home owner is unsafe'
  chmod 700 -- "$SAFE_PM2_HOME"
  [[ "$(stat -c '%a' -- "$SAFE_PM2_HOME")" == '700' ]] \
    || die 'PM2 home mode is unsafe'
  for file in "$SAFE_PM2_HOME/dump.pm2" "$SAFE_PM2_HOME/dump.pm2.bak"; do
    if [[ -e "$file" ]]; then
      [[ -f "$file" && ! -L "$file" ]] || die 'PM2 resurrection file is unsafe'
      [[ "$(stat -c '%U' -- "$file")" == "$OPERATOR" ]] \
        || die 'PM2 resurrection file owner is unsafe'
      chmod 600 -- "$file"
      [[ "$(stat -c '%a' -- "$file")" == '600' ]] \
        || die 'PM2 resurrection file mode is unsafe'
    fi
  done
}

pm2_status() {
  local name="$1"
  sanitized_pm2 jlist 2>/dev/null | node -e '
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => {
      const name = process.argv[1];
      const processes = JSON.parse(input);
      const matches = processes.filter((entry) => entry.name === name);
      if (matches.length !== 1) process.exit(2);
      const status = matches[0]?.pm2_env?.status;
      if (typeof status !== "string") process.exit(3);
      process.stdout.write(status);
    });
  ' "$name"
}

assert_pm2_online() {
  local name="$1"
  [[ "$(pm2_status "$name")" == 'online' ]] || die "$name is not online"
}

assert_pm2_stopped() {
  local name="$1"
  [[ "$(pm2_status "$name")" == 'stopped' ]] || die "$name did not reach PM2 stopped state"
}

assert_pm2_release_identity() {
  local release="$1"
  local sha="$2"
  local digest="$3"
  local backend_name="$4"
  local content_name="$5"

  sanitized_pm2 jlist 2>/dev/null | node -e '
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => {
      const [release, sha, digest, backendName, contentName] = process.argv.slice(1);
      const processes = JSON.parse(input);
      const required = [
        [backendName, release],
        [contentName, `${release}/content-engine`],
      ];
      for (const [name, cwd] of required) {
        const matches = processes.filter((entry) => entry.name === name);
        if (matches.length !== 1) process.exit(2);
        const environment = matches[0]?.pm2_env ?? {};
        if (environment.status !== "online"
            || environment.pm_cwd !== cwd
            || (name === backendName
              && environment.pm_exec_path !== `${release}/dist/index.js`)
            || (name === contentName
              && (environment.pm_exec_path !== "/usr/bin/python3.12"
                || environment.PYTHONPATH !== `${release}/content-engine/vendor`))
            || environment.NEXUS_RELEASE_SHA !== sha
            || environment.NEXUS_RELEASE_ARTIFACT_SHA256 !== digest) {
          process.exit(3);
        }
      }
    });
  ' "$release" "$sha" "$digest" "$backend_name" "$content_name"
}

assert_no_rotation_variables_in_pm2() {
  sanitized_pm2 jlist 2>/dev/null | node -e '
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => {
      const names = new Set(process.argv.slice(1));
      const forbidden = [
        "OLD_OAUTH_ENCRYPTION_KEY", "OLD_GARMIN_ENCRYPTION_KEY", "OLD_HEALTH_DATA_ENCRYPTION_KEY",
        "NEW_OAUTH_ENCRYPTION_KEY", "NEW_GARMIN_ENCRYPTION_KEY", "NEW_HEALTH_DATA_ENCRYPTION_KEY",
        "PEER_OAUTH_ENCRYPTION_KEY", "PEER_GARMIN_ENCRYPTION_KEY", "PEER_HEALTH_DATA_ENCRYPTION_KEY",
        "ROTATE_NEXT_OAUTH", "ROTATE_NEXT_GARMIN", "ROTATE_NEXT_HEALTH",
      ];
      const processes = JSON.parse(input).filter((entry) => names.has(entry.name));
      if (processes.length !== names.size) process.exit(2);
      for (const processEntry of processes) {
        const environment = processEntry.pm2_env ?? {};
        if (forbidden.some((name) => Object.prototype.hasOwnProperty.call(environment, name))) {
          process.exit(3);
        }
      }
    });
  ' "$BACKEND_APP" "$CONTENT_APP" || die 'PM2 persisted a forbidden rotation variable'
}

stop_staging_services() {
  assert_all_current_releases_unchanged
  # Set the state before the first stop so a partial PM2 failure still causes
  # the EXIT trap to restart the unchanged pre-apply runtime.
  SERVICES_STOPPED=1
  sanitized_pm2 stop "$CONTENT_APP" >/dev/null 2>&1
  sanitized_pm2 stop "$BACKEND_APP" >/dev/null 2>&1
  assert_all_current_releases_unchanged
}

stop_staging_services_quietly() {
  (assert_all_current_releases_unchanged) >/dev/null 2>&1 || return 1
  sanitized_pm2 stop "$CONTENT_APP" >/dev/null 2>&1 || true
  sanitized_pm2 stop "$BACKEND_APP" >/dev/null 2>&1 || true
  SERVICES_STOPPED=1
  (assert_all_current_releases_unchanged) >/dev/null 2>&1 || return 1
}

verify_no_staging_writer_quietly() {
  local name status file port
  for name in "$CONTENT_APP" "$BACKEND_APP"; do
    status="$(pm2_status "$name" 2>/dev/null || true)"
    case "$status" in
      ''|stopped|errored) ;;
      *) return 1 ;;
    esac
  done
  for port in "$CONTENT_PORT" "$BACKEND_PORT"; do
    lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1 && return 1
  done
  for file in "$DB_PATH" "$DB_PATH-wal" "$DB_PATH-shm"; do
    if [[ -e "$file" ]] && lsof -nP -- "$file" >/dev/null 2>&1; then
      return 1
    fi
  done
  return 0
}

start_old_staging_services() {
  clear_rotation_variables
  (assert_all_current_releases_unchanged) || return 1
  if ! (
    assert_all_current_releases_unchanged
    cd -- "$STAGING_CURRENT_RELEASE"
    staging_release_pm2 startOrReload "$ECOSYSTEM" \
      --only "$BACKEND_APP,$CONTENT_APP" --update-env >/dev/null 2>&1
    assert_all_current_releases_unchanged
  ); then
    return 1
  fi
  SERVICES_STOPPED=0
  (assert_all_current_releases_unchanged) || return 1
  assert_pm2_release_identity \
    "$STAGING_CURRENT_RELEASE" "$STAGING_RELEASE_SHA" \
    "$STAGING_RELEASE_ARTIFACT_SHA256" "$BACKEND_APP" "$CONTENT_APP" || return 1
}

recreate_staging_services() {
  clear_rotation_variables
  assert_all_current_releases_unchanged
  sanitized_pm2 delete "$CONTENT_APP" >/dev/null 2>&1 || true
  assert_all_current_releases_unchanged
  sanitized_pm2 delete "$BACKEND_APP" >/dev/null 2>&1 || true
  assert_all_current_releases_unchanged
  (
    cd -- "$STAGING_CURRENT_RELEASE"
    staging_release_pm2 startOrReload "$ECOSYSTEM" \
      --only "$BACKEND_APP,$CONTENT_APP" --update-env >/dev/null 2>&1
  )
  SERVICES_STOPPED=0
  assert_all_current_releases_unchanged
  assert_no_rotation_variables_in_pm2
  assert_pm2_release_identity \
    "$STAGING_CURRENT_RELEASE" "$STAGING_RELEASE_SHA" \
    "$STAGING_RELEASE_ARTIFACT_SHA256" "$BACKEND_APP" "$CONTENT_APP" \
    || die 'recreated staging PM2 processes do not match the exact current release'
}

assert_ports_closed() {
  local port
  for port in "$CONTENT_PORT" "$BACKEND_PORT"; do
    if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
      die "TCP port $port still has a listener"
    fi
  done
}

assert_database_handles_closed() {
  local file
  for file in "$DB_PATH" "$DB_PATH-wal" "$DB_PATH-shm"; do
    if [[ -e "$file" ]] && lsof -nP -- "$file" >/dev/null 2>&1; then
      die 'database, WAL, or SHM file still has an open handle'
    fi
  done
}

assert_staging_quiescent() {
  assert_pm2_stopped "$CONTENT_APP"
  assert_pm2_stopped "$BACKEND_APP"
  assert_ports_closed
  assert_database_handles_closed
}

file_size() {
  local file="$1"
  if [[ -f "$file" ]]; then
    stat -c '%s' -- "$file"
  else
    printf '0'
  fi
}

count_new_decryption_errors() {
  local file="$1"
  local offset="$2"
  node - "$file" "$offset" <<'NODE'
const fs = require('node:fs');
const [file, rawOffset] = process.argv.slice(2);
if (!fs.existsSync(file)) {
  process.stdout.write('0');
  process.exit(0);
}
const stat = fs.statSync(file);
let offset = Number.parseInt(rawOffset, 10);
if (!Number.isSafeInteger(offset) || offset < 0 || offset > stat.size) offset = 0;
const length = stat.size - offset;
const fd = fs.openSync(file, 'r');
let text = '';
try {
  if (length > 0) {
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, offset);
    text = buffer.toString('utf8');
  }
} finally {
  fs.closeSync(fd);
}
const pattern = /(?:decrypt(?:ion)?[^\n]{0,100}(?:fail|error|unable|invalid)|(?:fail|error|unable)[^\n]{0,100}decrypt|unsupported state or unable to authenticate data|bad decrypt)/giu;
process.stdout.write(String((text.match(pattern) ?? []).length));
NODE
}

run_rotator() {
  OLD_OAUTH_ENCRYPTION_KEY="$OLD_OAUTH_ENCRYPTION_KEY" \
  OLD_GARMIN_ENCRYPTION_KEY="$OLD_GARMIN_ENCRYPTION_KEY" \
  OLD_HEALTH_DATA_ENCRYPTION_KEY="$OLD_HEALTH_DATA_ENCRYPTION_KEY" \
  OLD_FINANCE_ENCRYPTION_KEY="$OLD_FINANCE_ENCRYPTION_KEY" \
  NEW_OAUTH_ENCRYPTION_KEY="$NEW_OAUTH_ENCRYPTION_KEY" \
  NEW_GARMIN_ENCRYPTION_KEY="$NEW_GARMIN_ENCRYPTION_KEY" \
  NEW_HEALTH_DATA_ENCRYPTION_KEY="$NEW_HEALTH_DATA_ENCRYPTION_KEY" \
  NEW_FINANCE_ENCRYPTION_KEY="$NEW_FINANCE_ENCRYPTION_KEY" \
  PEER_OAUTH_ENCRYPTION_KEY="$PEER_OAUTH_ENCRYPTION_KEY" \
  PEER_GARMIN_ENCRYPTION_KEY="$PEER_GARMIN_ENCRYPTION_KEY" \
  PEER_HEALTH_DATA_ENCRYPTION_KEY="$PEER_HEALTH_DATA_ENCRYPTION_KEY" \
  PEER_FINANCE_ENCRYPTION_KEY="$PEER_FINANCE_ENCRYPTION_KEY" \
    node "$ROTATOR" "$@"
}

validate_rotation_result() {
  local file="$1"
  local expected_mode="$2"
  local require_verified="$3"
  node - "$file" "$expected_mode" "$require_verified" <<'NODE'
const fs = require('node:fs');
const [file, expectedMode, requireVerified] = process.argv.slice(2);
const result = JSON.parse(fs.readFileSync(file, 'utf8'));
const integer = (value) => Number.isSafeInteger(value) && value >= 0;
const counts = (value) => value
  && integer(value.nonempty)
  && integer(value.needsRotation)
  && integer(value.alreadyNew)
  && integer(value.undecryptable)
  && value.needsRotation + value.alreadyNew + value.undecryptable === value.nonempty;
const expectedTables = [
  'user_oauth_tokens',
  'webhook_subscriptions',
  'webhook_events',
  'garmin_sessions',
  'garmin_user_tokens',
  'apple_health_data',
  'finance_transactions',
  'finance_tax_events',
];

if (result.mode !== expectedMode || result.environment !== 'staging') process.exit(2);
if (!Array.isArray(result.tables) || result.tables.length !== expectedTables.length) process.exit(3);
for (let index = 0; index < expectedTables.length; index += 1) {
  const table = result.tables[index];
  if (table?.table !== expectedTables[index]
      || typeof table.present !== 'boolean'
      || !integer(table.rows)
      || !counts(table)) process.exit(10);
}
if (!counts(result.totals) || !counts(result.postVerification)) process.exit(4);
if (!integer(result.appliedValues) || result.totals.undecryptable !== 0) process.exit(5);

if (expectedMode === 'dry-run') {
  if (result.appliedValues !== 0 || result.backupVerified !== false) process.exit(6);
} else if (expectedMode === 'apply') {
  if (result.backupVerified !== true
      || result.appliedValues !== result.totals.needsRotation
      || result.postVerification.verified !== true
      || result.postVerification.needsRotation !== 0
      || result.postVerification.undecryptable !== 0
      || result.postVerification.nonempty !== result.totals.nonempty) process.exit(7);
} else {
  process.exit(8);
}

if (requireVerified === 'yes' && (
  result.postVerification.verified !== true
  || result.postVerification.needsRotation !== 0
  || result.postVerification.undecryptable !== 0
)) process.exit(9);

process.stdout.write([
  result.totals.nonempty,
  result.totals.needsRotation,
  result.totals.alreadyNew,
  result.totals.undecryptable,
  result.appliedValues,
].join('/'));
NODE
}

create_consistent_backup() {
  local error_file="$BACKUP_DIR/backup-error.txt"
  if ! node - "$STAGING_CURRENT_RELEASE" "$DB_PATH" "$BACKUP_DB" 2>"$error_file" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const [root, sourcePath, backupPath] = process.argv.slice(2);
const Database = require(path.join(root, 'node_modules', 'better-sqlite3'));

(async () => {
  if (fs.existsSync(backupPath)) throw new Error('backup destination already exists');
  const source = new Database(sourcePath, { readonly: true, fileMustExist: true });
  try {
    await source.backup(backupPath);
  } finally {
    source.close();
  }
  fs.chmodSync(backupPath, 0o600);
  const backup = new Database(backupPath, { readonly: true, fileMustExist: true });
  try {
    const rows = backup.pragma('integrity_check');
    if (rows.length !== 1 || rows[0]?.integrity_check !== 'ok') {
      throw new Error('backup integrity check failed');
    }
  } finally {
    backup.close();
  }
})().catch((error) => {
  process.stderr.write(`consistent backup failed: ${error.message}\n`);
  process.exit(1);
});
NODE
  then
    die "consistent SQLite backup failed; inspect protected file $error_file"
  fi
  [[ "$(stat -c '%a' -- "$BACKUP_DB")" == '600' ]] || die 'database backup mode is not 600'
}

check_database_integrity() {
  node - "$STAGING_CURRENT_RELEASE" "$DB_PATH" <<'NODE'
const path = require('node:path');
const [root, databasePath] = process.argv.slice(2);
const Database = require(path.join(root, 'node_modules', 'better-sqlite3'));
const database = new Database(databasePath, { readonly: true, fileMustExist: true });
try {
  const rows = database.pragma('integrity_check');
  if (rows.length !== 1 || rows[0]?.integrity_check !== 'ok') process.exit(2);
} finally {
  database.close();
}
NODE
}

wait_for_staging_health() {
  local attempt
  for attempt in $(seq 1 30); do
    if [[ "$(pm2_status "$CONTENT_APP" 2>/dev/null || true)" == 'online' \
      && "$(pm2_status "$BACKEND_APP" 2>/dev/null || true)" == 'online' ]] \
      && curl --noproxy '*' -fsS --max-time 2 "http://127.0.0.1:$CONTENT_PORT/health" >/dev/null 2>&1 \
      && curl --noproxy '*' -fsS --max-time 2 "http://127.0.0.1:$BACKEND_PORT/health" >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  return 1
}

load_rotation_variables() {
  local old_file="$1"
  local next_file="$2"
  local peer_file="$3"
  local old_finance_count next_finance_count
  OLD_OAUTH_ENCRYPTION_KEY="$(read_effective_key "$old_file" OAUTH_ENCRYPTION_KEY OAUTH_ENCRYPTION_KEY)"
  OLD_GARMIN_ENCRYPTION_KEY="$(read_effective_key "$old_file" GARMIN_ENCRYPTION_KEY OAUTH_ENCRYPTION_KEY)"
  OLD_HEALTH_DATA_ENCRYPTION_KEY="$(read_effective_key "$old_file" HEALTH_DATA_ENCRYPTION_KEY OAUTH_ENCRYPTION_KEY)"
  NEW_OAUTH_ENCRYPTION_KEY="$(read_effective_key "$next_file" OAUTH_ENCRYPTION_KEY OAUTH_ENCRYPTION_KEY)"
  NEW_GARMIN_ENCRYPTION_KEY="$(read_effective_key "$next_file" GARMIN_ENCRYPTION_KEY OAUTH_ENCRYPTION_KEY)"
  NEW_HEALTH_DATA_ENCRYPTION_KEY="$(read_effective_key "$next_file" HEALTH_DATA_ENCRYPTION_KEY OAUTH_ENCRYPTION_KEY)"
  PEER_OAUTH_ENCRYPTION_KEY="$(read_effective_key "$peer_file" OAUTH_ENCRYPTION_KEY OAUTH_ENCRYPTION_KEY)"
  PEER_GARMIN_ENCRYPTION_KEY="$(read_effective_key "$peer_file" GARMIN_ENCRYPTION_KEY OAUTH_ENCRYPTION_KEY)"
  PEER_HEALTH_DATA_ENCRYPTION_KEY="$(read_effective_key "$peer_file" HEALTH_DATA_ENCRYPTION_KEY OAUTH_ENCRYPTION_KEY)"
  PEER_FINANCE_ENCRYPTION_KEY="$(read_effective_key "$peer_file" FINANCE_ENCRYPTION_KEY FINANCE_ENCRYPTION_KEY)"

  old_finance_count="$(dotenv_assignment_count "$old_file" FINANCE_ENCRYPTION_KEY)"
  case "$old_finance_count" in
    1) OLD_FINANCE_ENCRYPTION_KEY="$(read_effective_key "$old_file" FINANCE_ENCRYPTION_KEY FINANCE_ENCRYPTION_KEY)" ;;
    0)
      [[ "$STAGING_FINANCE_BOOTSTRAP_ALLOWED" -eq 1 ]] \
        || die 'staging FINANCE_ENCRYPTION_KEY is missing without an approved empty-surface bootstrap'
      OLD_FINANCE_ENCRYPTION_KEY="$PEER_FINANCE_ENCRYPTION_KEY"
      ;;
    *) die 'staging old environment contains duplicate FINANCE_ENCRYPTION_KEY assignments' ;;
  esac

  next_finance_count="$(dotenv_assignment_count "$next_file" FINANCE_ENCRYPTION_KEY)"
  case "$next_finance_count" in
    1) NEW_FINANCE_ENCRYPTION_KEY="$(read_effective_key "$next_file" FINANCE_ENCRYPTION_KEY FINANCE_ENCRYPTION_KEY)" ;;
    0)
      [[ "$STAGING_FINANCE_BOOTSTRAP_ALLOWED" -eq 1 && "$next_file" == "$old_file" ]] \
        || die 'staging next environment is missing FINANCE_ENCRYPTION_KEY'
      NEW_FINANCE_ENCRYPTION_KEY="$OLD_FINANCE_ENCRYPTION_KEY"
      ;;
    *) die 'staging next environment contains duplicate FINANCE_ENCRYPTION_KEY assignments' ;;
  esac
}

quoted() {
  printf '%q' "$1"
}

print_manual_rollback_steps() {
  local quarantine="$BACKUP_DIR/ambiguous-post-apply-state"
  local db_next="$DB_PATH.rollback-next"
  local env_next="$STAGING_ROOT/.env.rollback-next"
  local agents_next="$STAGING_ROOT/.env.agents.rollback-next"

  printf '\nROTATION STATE IS AMBIGUOUS OR POST-APPLY VALIDATION FAILED.\n' >&2
  if [[ "$POSTAPPLY_STOP_VERIFIED" -eq 1 ]]; then
    printf 'Both staging services are non-running, both ports are closed, and DB handles are absent.\n' >&2
  else
    printf 'CRITICAL: stopped-state proof failed. Do not run rollback until all staging writers, ports, and DB handles are quiescent.\n' >&2
  fi
  printf 'The script did not restore or destroy the rotated database.\n' >&2
  printf 'Inspect the protected results first. If rollback is approved, run these exact steps as %s:\n' "$OPERATOR" >&2
  printf '  mkdir -m 700 -- %s\n' "$(quoted "$quarantine")" >&2
  printf '  install -m 600 -- %s %s\n' "$(quoted "$DB_PATH")" "$(quoted "$quarantine/bot.db.after-apply")" >&2
  printf '  [ ! -e %s ] || mv -- %s %s\n' "$(quoted "$DB_PATH-wal")" "$(quoted "$DB_PATH-wal")" "$(quoted "$quarantine/bot.db-wal.after-apply")" >&2
  printf '  [ ! -e %s ] || mv -- %s %s\n' "$(quoted "$DB_PATH-shm")" "$(quoted "$DB_PATH-shm")" "$(quoted "$quarantine/bot.db-shm.after-apply")" >&2
  printf '  install -m 600 -- %s %s && mv -f -- %s %s\n' "$(quoted "$BACKUP_DB")" "$(quoted "$db_next")" "$(quoted "$db_next")" "$(quoted "$DB_PATH")" >&2
  printf '  install -m 600 -- %s %s && mv -f -- %s %s\n' "$(quoted "$BACKUP_DIR/.env.before")" "$(quoted "$env_next")" "$(quoted "$env_next")" "$(quoted "$STAGING_ENV")" >&2
  printf '  install -m 600 -- %s %s && mv -f -- %s %s\n' "$(quoted "$BACKUP_DIR/.env.agents.before")" "$(quoted "$agents_next")" "$(quoted "$agents_next")" "$(quoted "$STAGING_AGENTS_ENV")" >&2
  printf '  unset OLD_OAUTH_ENCRYPTION_KEY OLD_GARMIN_ENCRYPTION_KEY OLD_HEALTH_DATA_ENCRYPTION_KEY OLD_FINANCE_ENCRYPTION_KEY NEW_OAUTH_ENCRYPTION_KEY NEW_GARMIN_ENCRYPTION_KEY NEW_HEALTH_DATA_ENCRYPTION_KEY NEW_FINANCE_ENCRYPTION_KEY PEER_OAUTH_ENCRYPTION_KEY PEER_GARMIN_ENCRYPTION_KEY PEER_HEALTH_DATA_ENCRYPTION_KEY PEER_FINANCE_ENCRYPTION_KEY\n' >&2
  printf '  env -i HOME=%s USER=%s LOGNAME=%s PATH=%s PM2_HOME=%s %s delete %s %s\n' \
    "$(quoted "$HOME")" "$(quoted "$OPERATOR")" "$(quoted "$OPERATOR")" "$(quoted "$SANITIZED_PATH")" "$(quoted "$SAFE_PM2_HOME")" "$(quoted "$PM2")" "$(quoted "$CONTENT_APP")" "$(quoted "$BACKEND_APP")" >&2
  printf '  cd -- %s && env -i HOME=%s USER=%s LOGNAME=%s PATH=%s PM2_HOME=%s NEXUS_RELEASE_DIR=%s NEXUS_RELEASE_BASE_DIR=%s NEXUS_RELEASE_ROLE=staging NEXUS_RELEASE_SHA=%s NEXUS_RELEASE_ARTIFACT_SHA256=%s GIT_COMMIT=%s %s startOrReload %s --only %s,%s --update-env\n' \
    "$(quoted "$STAGING_CURRENT_RELEASE")" "$(quoted "$HOME")" "$(quoted "$OPERATOR")" \
    "$(quoted "$OPERATOR")" "$(quoted "$SANITIZED_PATH")" "$(quoted "$SAFE_PM2_HOME")" \
    "$(quoted "$STAGING_CURRENT_RELEASE")" "$(quoted "$STAGING_ROOT")" \
    "$(quoted "$STAGING_RELEASE_SHA")" "$(quoted "$STAGING_RELEASE_ARTIFACT_SHA256")" \
    "$(quoted "$STAGING_RELEASE_SHA")" "$(quoted "$PM2")" "$(quoted "$ECOSYSTEM")" \
    "$(quoted "$BACKEND_APP")" "$(quoted "$CONTENT_APP")" >&2
  printf 'Do not delete %s or %s until rollback and decryption checks are complete.\n' "$BACKUP_DIR" "$quarantine" >&2
}

on_exit() {
  local status="$1"
  set +e
  set +x

  if [[ "$COMPLETED" -eq 1 || "$status" -eq 0 ]]; then
    clear_rotation_variables
    release_release_lock
    return
  fi

  if [[ "$APPLY_ATTEMPTED" -eq 1 ]]; then
    clear_rotation_variables
    stop_staging_services_quietly
    if verify_no_staging_writer_quietly; then
      POSTAPPLY_STOP_VERIFIED=1
    fi
    print_manual_rollback_steps
  else
    clear_rotation_variables
    rm -f -- "${NEXT_ENV:-}" "${NEXT_AGENTS_ENV:-}" 2>/dev/null || true
    if [[ "$SERVICES_STOPPED" -eq 1 ]]; then
      if start_old_staging_services; then
        printf 'Pre-apply failure: staging services were restarted with the unchanged environment and database.\n' >&2
      else
        printf 'Pre-apply failure: automatic restart of the unchanged staging services failed; start them from %s.\n' "$ECOSYSTEM" >&2
      fi
    fi
    if [[ -n "$BACKUP_DIR" ]]; then
      printf 'Protected rollback directory: %s\n' "$BACKUP_DIR" >&2
    fi
  fi
  release_release_lock
}

if [[ "${ROTATION_SCRIPT_LIBRARY_MODE:-0}" == '1' ]]; then
  return 0 2>/dev/null || exit 0
fi

trap 'on_exit $?' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

for argument in "$@"; do
  case "$argument" in
    --staging-root=*)
      [[ -z "$STAGING_ROOT" ]] || die '--staging-root may be supplied only once'
      STAGING_ROOT="${argument#*=}"
      ;;
    --production-root=*)
      [[ -z "$PRODUCTION_ROOT" ]] || die '--production-root may be supplied only once'
      PRODUCTION_ROOT="${argument#*=}"
      ;;
    --help|-h)
      [[ "$#" -eq 1 ]] || die '--help cannot be combined with other arguments'
      usage
      COMPLETED=1
      exit 0
      ;;
    *) die 'unknown or malformed argument' ;;
  esac
done

[[ -n "$STAGING_ROOT" && -n "$PRODUCTION_ROOT" ]] || { usage >&2; die 'both live roots are required'; }
[[ "$STAGING_ROOT" == /* && "$PRODUCTION_ROOT" == /* ]] || die 'both live roots must be absolute'

require_command node
require_command stat
require_command lsof
require_command curl
require_command install
require_command cmp
require_command mktemp
require_command sha256sum
require_command flock
OPERATOR="$(id -un)"
[[ -n "${HOME:-}" && "$HOME" == /* ]] || die 'operator HOME is unavailable or not absolute'
RELEASE_LOCK_FILE="$HOME/.local/state/nexus-release/.release.lock"
STAGING_ROOT="$(canonical_directory "$STAGING_ROOT")" || die 'staging root is unavailable'
PRODUCTION_ROOT="$(canonical_directory "$PRODUCTION_ROOT")" || die 'production root is unavailable'
[[ "$STAGING_ROOT" != "$PRODUCTION_ROOT" ]] || die 'staging and production roots must differ'

acquire_release_lock
staging_identity="$(resolve_current_release_identity "$STAGING_ROOT" staging)" \
  || die 'staging current release identity is unavailable'
IFS=$'\t' read -r STAGING_CURRENT_RELEASE STAGING_RELEASE_SHA \
  STAGING_RELEASE_ARTIFACT_SHA256 <<<"$staging_identity"
production_identity="$(resolve_current_release_identity "$PRODUCTION_ROOT" production)" \
  || die 'production current release identity is unavailable'
IFS=$'\t' read -r PRODUCTION_CURRENT_RELEASE PRODUCTION_RELEASE_SHA \
  PRODUCTION_RELEASE_ARTIFACT_SHA256 <<<"$production_identity"

STAGING_ENV="$STAGING_ROOT/.env"
STAGING_AGENTS_ENV="$STAGING_ROOT/.env.agents"
PRODUCTION_ENV="$PRODUCTION_ROOT/.env"
PRODUCTION_AGENTS_ENV="$PRODUCTION_ROOT/.env.agents"
NEXT_ENV="$STAGING_ROOT/.env.next"
NEXT_AGENTS_ENV="$STAGING_ROOT/.env.agents.next"
ECOSYSTEM="$STAGING_CURRENT_RELEASE/ecosystem.release.config.js"
ROTATOR="$STAGING_CURRENT_RELEASE/dist/tools/rotate-data-encryption-keys.js"
CONTENT_ROOT="$STAGING_CURRENT_RELEASE/content-engine"
CONTENT_PYTHON='/usr/bin/python3.12'

assert_private_regular_file "$STAGING_ENV" 'staging .env'
assert_private_regular_file "$STAGING_AGENTS_ENV" 'staging .env.agents'
assert_private_regular_file "$PRODUCTION_ENV" 'production .env'
assert_private_regular_file "$PRODUCTION_AGENTS_ENV" 'production .env.agents'
[[ ! -e "$NEXT_ENV" && ! -e "$NEXT_AGENTS_ENV" ]] || die 'a stale next dotenv file already exists'

verify_exact_rotator_artifact "$ROTATOR" "$EXPECTED_ROTATOR_SHA256"
[[ -f "$STAGING_CURRENT_RELEASE/node_modules/better-sqlite3/package.json" ]] \
  || die 'deployed better-sqlite3 dependency is missing'
[[ -f "$ECOSYSTEM" && ! -L "$ECOSYSTEM" ]] || die 'staging ecosystem artifact is missing or is a symlink'
[[ -d "$CONTENT_ROOT" && ! -L "$CONTENT_ROOT" ]] \
  || die 'staging content-engine root is unavailable or is a symlink'
[[ -x "$CONTENT_PYTHON" ]] || die 'staging content-engine Python executable is unavailable'
[[ -d "$CONTENT_ROOT/vendor" && ! -L "$CONTENT_ROOT/vendor" ]] \
  || die 'staging content-engine vendor dependencies are unavailable or symbolic'
[[ -f "$CONTENT_ROOT/main.py" && ! -L "$CONTENT_ROOT/main.py" ]] \
  || die 'staging content-engine entrypoint is unavailable or is a symlink'
node --check "$ROTATOR" >/dev/null 2>&1 || die 'deployed dist rotator fails JavaScript syntax validation'
node "$ROTATOR" --help >/dev/null 2>&1 || die 'deployed dist rotator help preflight failed'
node - "$ROTATOR" "$ACKNOWLEDGEMENT" <<'NODE' || die 'deployed dist rotator API preflight failed'
const [rotatorPath, acknowledgement] = process.argv.slice(2);
const rotator = require(rotatorPath);
if (rotator.SERVICE_STOPPED_ACKNOWLEDGEMENT !== acknowledgement) process.exit(2);
if (typeof rotator.runDataEncryptionKeyRotation !== 'function') process.exit(3);
NODE

NEXUS_RELEASE_DIR="$STAGING_CURRENT_RELEASE" \
NEXUS_RELEASE_BASE_DIR="$STAGING_ROOT" \
NEXUS_RELEASE_ROLE=staging \
NEXUS_RELEASE_SHA="$STAGING_RELEASE_SHA" \
NEXUS_RELEASE_ARTIFACT_SHA256="$STAGING_RELEASE_ARTIFACT_SHA256" \
  node - "$STAGING_CURRENT_RELEASE" "$ECOSYSTEM" <<'NODE' \
  || die 'staging ecosystem paths do not bind to the exact current release'
const path = require('node:path');
const [root, ecosystemPath] = process.argv.slice(2);
const ecosystem = require(ecosystemPath);
const apps = Array.isArray(ecosystem.apps) ? ecosystem.apps : [];
const backend = apps.find((app) => app.name === 'nexus-hub-staging');
const content = apps.find((app) => app.name === 'content-engine-staging');
if (!backend || !content) process.exit(2);
if (path.resolve(backend.cwd) !== path.resolve(root)) process.exit(3);
if (path.resolve(content.cwd) !== path.resolve(root, 'content-engine')) process.exit(4);
if (content.script !== '/usr/bin/python3.12') process.exit(5);
if (content.env?.PYTHONPATH !== path.resolve(root, 'content-engine/vendor')) process.exit(6);
NODE

PM2="${PM2_BIN:-$HOME/.npm-global/bin/pm2}"
if [[ ! -x "$PM2" ]]; then
  PM2="$(command -v pm2 || true)"
fi
[[ -n "$PM2" && -x "$PM2" ]] || die 'PM2 executable is unavailable'
SANITIZED_PATH="$(dirname -- "$(command -v node)"):$(dirname -- "$PM2"):/usr/local/bin:/usr/bin:/bin"
SAFE_PM2_HOME="${PM2_HOME:-$HOME/.pm2}"
secure_existing_pm2_resurrection_permissions

assert_pm2_online "$CONTENT_APP"
assert_pm2_online "$BACKEND_APP"
assert_pm2_release_identity \
  "$STAGING_CURRENT_RELEASE" "$STAGING_RELEASE_SHA" \
  "$STAGING_RELEASE_ARTIFACT_SHA256" "$BACKEND_APP" "$CONTENT_APP" \
  || die 'staging PM2 processes do not match the exact current release identity'
assert_pm2_release_identity \
  "$PRODUCTION_CURRENT_RELEASE" "$PRODUCTION_RELEASE_SHA" \
  "$PRODUCTION_RELEASE_ARTIFACT_SHA256" nexus-hub content-engine \
  || die 'production peer PM2 processes do not match its exact current release identity'
assert_all_current_releases_unchanged

configured_database="$(read_effective_key "$STAGING_ENV" DATABASE_PATH DATABASE_PATH 2>/dev/null || true)"
if [[ -z "$configured_database" ]]; then
  configured_database="$(node - "$STAGING_ENV" <<'NODE'
const fs = require('node:fs');
const text = fs.readFileSync(process.argv[2], 'utf8');
const matches = text.split(/\r?\n/u).filter((line) => /^\s*(?:export\s+)?DATABASE_PATH\s*=/u.test(line));
if (matches.length !== 1) process.exit(2);
let value = matches[0].replace(/^\s*(?:export\s+)?DATABASE_PATH\s*=/u, '').trim();
if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
else value = value.replace(/\s+#.*$/u, '').trim();
if (!value.startsWith('/') || value.includes('\0') || value.includes('\n')) process.exit(3);
process.stdout.write(value);
NODE
)" || die 'DATABASE_PATH could not be read safely from staging .env'
fi
[[ -f "$configured_database" && ! -L "$configured_database" ]] || die 'staging database must be a non-symlink regular file'
DB_PATH="$(canonical_file "$configured_database")" || die 'staging database path cannot be canonicalized'
[[ "$DB_PATH" == "$STAGING_ROOT"/data/* ]] || die 'staging database must be inside the supplied staging data root'
[[ "$configured_database" == "$DB_PATH" ]] || die 'staging DATABASE_PATH must already be canonical and non-symlinked'

staging_finance_count="$(dotenv_assignment_count "$STAGING_ENV" FINANCE_ENCRYPTION_KEY)"
case "$staging_finance_count" in
  0)
    assert_staging_finance_surface_empty "$STAGING_CURRENT_RELEASE" "$DB_PATH" \
      || die 'staging Finance key is missing but the encrypted Finance surface is not safely empty'
    STAGING_FINANCE_BOOTSTRAP_ALLOWED=1
    ;;
  1) STAGING_FINANCE_BOOTSTRAP_ALLOWED=0 ;;
  *) die 'staging .env contains duplicate FINANCE_ENCRYPTION_KEY assignments' ;;
esac

load_rotation_variables "$STAGING_ENV" "$STAGING_ENV" "$PRODUCTION_ENV"

staging_agents_oauth="$(read_effective_key "$STAGING_AGENTS_ENV" OAUTH_ENCRYPTION_KEY OAUTH_ENCRYPTION_KEY)"
staging_agents_garmin="$(read_effective_key "$STAGING_AGENTS_ENV" GARMIN_ENCRYPTION_KEY OAUTH_ENCRYPTION_KEY)"
staging_agents_health="$(read_effective_key "$STAGING_AGENTS_ENV" HEALTH_DATA_ENCRYPTION_KEY OAUTH_ENCRYPTION_KEY)"
[[ "$staging_agents_oauth" == "$OLD_OAUTH_ENCRYPTION_KEY" \
  && "$staging_agents_garmin" == "$OLD_GARMIN_ENCRYPTION_KEY" \
  && "$staging_agents_health" == "$OLD_HEALTH_DATA_ENCRYPTION_KEY" ]] \
  || die 'staging .env and .env.agents encryption keys are not in parity'
assert_optional_key_parity \
  "$STAGING_AGENTS_ENV" FINANCE_ENCRYPTION_KEY "$OLD_FINANCE_ENCRYPTION_KEY" \
  'optional staging .env.agents Finance key'

production_agents_oauth="$(read_effective_key "$PRODUCTION_AGENTS_ENV" OAUTH_ENCRYPTION_KEY OAUTH_ENCRYPTION_KEY)"
production_agents_garmin="$(read_effective_key "$PRODUCTION_AGENTS_ENV" GARMIN_ENCRYPTION_KEY OAUTH_ENCRYPTION_KEY)"
production_agents_health="$(read_effective_key "$PRODUCTION_AGENTS_ENV" HEALTH_DATA_ENCRYPTION_KEY OAUTH_ENCRYPTION_KEY)"
[[ "$production_agents_oauth" == "$PEER_OAUTH_ENCRYPTION_KEY" \
  && "$production_agents_garmin" == "$PEER_GARMIN_ENCRYPTION_KEY" \
  && "$production_agents_health" == "$PEER_HEALTH_DATA_ENCRYPTION_KEY" ]] \
  || die 'production .env and .env.agents encryption keys are not in parity'
assert_optional_key_parity \
  "$PRODUCTION_AGENTS_ENV" FINANCE_ENCRYPTION_KEY "$PEER_FINANCE_ENCRYPTION_KEY" \
  'optional production .env.agents Finance key'

all_existing_keys=(
  "$OLD_OAUTH_ENCRYPTION_KEY"
  "$OLD_GARMIN_ENCRYPTION_KEY"
  "$OLD_HEALTH_DATA_ENCRYPTION_KEY"
  "$OLD_FINANCE_ENCRYPTION_KEY"
  "$PEER_OAUTH_ENCRYPTION_KEY"
  "$PEER_GARMIN_ENCRYPTION_KEY"
  "$PEER_HEALTH_DATA_ENCRYPTION_KEY"
  "$PEER_FINANCE_ENCRYPTION_KEY"
)
generate_unique_destination_key "${all_existing_keys[@]}"
NEW_OAUTH_ENCRYPTION_KEY="$process_generated_key"
generate_unique_destination_key "${all_existing_keys[@]}" "$NEW_OAUTH_ENCRYPTION_KEY"
NEW_GARMIN_ENCRYPTION_KEY="$process_generated_key"
generate_unique_destination_key "${all_existing_keys[@]}" "$NEW_OAUTH_ENCRYPTION_KEY" "$NEW_GARMIN_ENCRYPTION_KEY"
NEW_HEALTH_DATA_ENCRYPTION_KEY="$process_generated_key"
generate_unique_destination_key \
  "${all_existing_keys[@]}" \
  "$NEW_OAUTH_ENCRYPTION_KEY" \
  "$NEW_GARMIN_ENCRYPTION_KEY" \
  "$NEW_HEALTH_DATA_ENCRYPTION_KEY"
NEW_FINANCE_ENCRYPTION_KEY="$process_generated_key"
assert_all_keys_unique 'destination' \
  "$NEW_OAUTH_ENCRYPTION_KEY" \
  "$NEW_GARMIN_ENCRYPTION_KEY" \
  "$NEW_HEALTH_DATA_ENCRYPTION_KEY" \
  "$NEW_FINANCE_ENCRYPTION_KEY"

backup_parent="$STAGING_ROOT/.local/rotation-backups"
mkdir -p -- "$backup_parent"
chmod 700 -- "$STAGING_ROOT/.local" "$backup_parent"
BACKUP_DIR="$(mktemp -d "$backup_parent/staging-data-keys-$(date -u +%Y%m%dT%H%M%SZ)-XXXXXXXX")"
chmod 700 -- "$BACKUP_DIR"
[[ "$(stat -c '%U' -- "$BACKUP_DIR")" == "$OPERATOR" ]] || die 'backup directory owner is unsafe'
[[ "$(stat -c '%a' -- "$BACKUP_DIR")" == '700' ]] || die 'backup directory mode is unsafe'

install -m 600 -- "$STAGING_ENV" "$BACKUP_DIR/.env.before"
install -m 600 -- "$STAGING_AGENTS_ENV" "$BACKUP_DIR/.env.agents.before"
cmp -s -- "$STAGING_ENV" "$BACKUP_DIR/.env.before" || die 'staging .env rollback copy mismatch'
cmp -s -- "$STAGING_AGENTS_ENV" "$BACKUP_DIR/.env.agents.before" || die 'staging .env.agents rollback copy mismatch'

assert_all_current_releases_unchanged
write_next_env "$STAGING_ENV" "$NEXT_ENV" initialize
write_next_env "$STAGING_AGENTS_ENV" "$NEXT_AGENTS_ENV" if-present
validate_next_env "$NEXT_ENV" initialize
validate_next_env "$NEXT_AGENTS_ENV" if-present
assert_all_current_releases_unchanged

backend_out_log="$STAGING_ROOT/logs/out.log"
backend_error_log="$STAGING_ROOT/logs/error.log"
content_out_log="$STAGING_ROOT/logs/content-engine-out.log"
content_error_log="$STAGING_ROOT/logs/content-engine-error.log"
backend_out_offset="$(file_size "$backend_out_log")"
backend_error_offset="$(file_size "$backend_error_log")"
content_out_offset="$(file_size "$content_out_log")"
content_error_offset="$(file_size "$content_error_log")"

printf 'Preflight: deployed rotator, roots, environment parity, and destination-key constraints passed.\n'

live_result="$BACKUP_DIR/live-dry-run.json"
live_error="$BACKUP_DIR/live-dry-run-error.txt"
if ! run_rotator \
  --environment=staging \
  --database="$DB_PATH" \
  >"$live_result" 2>"$live_error"; then
  die "live dry-run failed; inspect protected file $live_error"
fi
live_counts="$(validate_rotation_result "$live_result" dry-run no)" || die 'live dry-run JSON failed validation'
printf 'Live dry-run: passed (nonempty/needs/already-new/undecryptable/applied=%s).\n' "$live_counts"

stop_staging_services
assert_staging_quiescent
printf 'Quiescence: both PM2 apps stopped, ports 8101/8201 closed, and DB/WAL/SHM handles absent.\n'

BACKUP_DB="$BACKUP_DIR/bot.db.before"
create_consistent_backup
printf 'Backup: consistent mode-600 better-sqlite3 backup passed integrity_check.\n'

stopped_result="$BACKUP_DIR/stopped-dry-run.json"
stopped_error="$BACKUP_DIR/stopped-dry-run-error.txt"
if ! run_rotator \
  --environment=staging \
  --database="$DB_PATH" \
  >"$stopped_result" 2>"$stopped_error"; then
  die "stopped-state dry-run failed; inspect protected file $stopped_error"
fi
stopped_counts="$(validate_rotation_result "$stopped_result" dry-run no)" || die 'stopped-state dry-run JSON failed validation'
printf 'Stopped-state dry-run: passed (nonempty/needs/already-new/undecryptable/applied=%s).\n' "$stopped_counts"

assert_staging_quiescent
cmp -s -- "$STAGING_ENV" "$BACKUP_DIR/.env.before" || die 'staging .env changed before apply'
cmp -s -- "$STAGING_AGENTS_ENV" "$BACKUP_DIR/.env.agents.before" || die 'staging .env.agents changed before apply'

apply_result="$BACKUP_DIR/apply-result.json"
apply_error="$BACKUP_DIR/apply-error.txt"
APPLY_ATTEMPTED=1
assert_all_current_releases_unchanged
if ! run_rotator \
  --environment=staging \
  --database="$DB_PATH" \
  --apply \
  --backup="$BACKUP_DB" \
  --services-stopped-ack="$ACKNOWLEDGEMENT" \
  >"$apply_result" 2>"$apply_error"; then
  die "apply returned failure; state remains stopped and must be inspected in $BACKUP_DIR"
fi
apply_counts="$(validate_rotation_result "$apply_result" apply yes)" || die 'apply JSON failed strict validation'
APPLY_CONFIRMED=1
assert_all_current_releases_unchanged
printf 'Apply: passed strict JSON validation (nonempty/needs/already-new/undecryptable/applied=%s).\n' "$apply_counts"

validate_next_env "$NEXT_ENV" initialize
validate_next_env "$NEXT_AGENTS_ENV" if-present
assert_all_current_releases_unchanged
mv -f -- "$NEXT_ENV" "$STAGING_ENV"
assert_all_current_releases_unchanged
mv -f -- "$NEXT_AGENTS_ENV" "$STAGING_AGENTS_ENV"
ENV_ACTIVATED=1
assert_all_current_releases_unchanged
assert_private_regular_file "$STAGING_ENV" 'activated staging .env'
assert_private_regular_file "$STAGING_AGENTS_ENV" 'activated staging .env.agents'
printf 'Environment activation: both next files atomically renamed into place.\n'

clear_rotation_variables
recreate_staging_services
wait_for_staging_health || die 'staging services did not become online and healthy after recreation'
assert_pm2_online "$CONTENT_APP"
assert_pm2_online "$BACKEND_APP"
assert_all_current_releases_unchanged
printf 'Runtime: staging apps recreated from ecosystem config in a sanitized environment; both health checks passed.\n'

check_database_integrity || die 'post-rotation database integrity_check failed'
printf 'Database: post-rotation integrity_check passed.\n'

load_rotation_variables "$BACKUP_DIR/.env.before" "$STAGING_ENV" "$PRODUCTION_ENV"
post_result="$BACKUP_DIR/post-rotation-dry-run.json"
post_error="$BACKUP_DIR/post-rotation-dry-run-error.txt"
if ! run_rotator \
  --environment=staging \
  --database="$DB_PATH" \
  >"$post_result" 2>"$post_error"; then
  die "post-rotation dry-run failed; inspect protected file $post_error"
fi
post_counts="$(validate_rotation_result "$post_result" dry-run yes)" || die 'post-rotation dry-run JSON failed validation'
clear_rotation_variables
printf 'Post-rotation dry-run: passed (nonempty/needs/already-new/undecryptable/applied=%s).\n' "$post_counts"

sleep 5
decryption_error_count=0
for result in \
  "$(count_new_decryption_errors "$backend_out_log" "$backend_out_offset")" \
  "$(count_new_decryption_errors "$backend_error_log" "$backend_error_offset")" \
  "$(count_new_decryption_errors "$content_out_log" "$content_out_offset")" \
  "$(count_new_decryption_errors "$content_error_log" "$content_error_offset")"; do
  [[ "$result" =~ ^[0-9]+$ ]] || die 'log decryption scan produced an invalid count'
  decryption_error_count=$((decryption_error_count + result))
done
[[ "$decryption_error_count" -eq 0 ]] || die 'new staging logs contain a decryption-failure signature'
printf 'Log scan: 0 new decryption-failure signatures.\n'

# The shared PM2 daemon still contains the production processes. Saving here
# would repersist their inherited secrets. Existing staging resurrection
# entries already load their keys from the rotated dotenv files, so preserve
# the existing state and only enforce private permissions. The production
# wrapper later recreates and saves all production entries from env-i.
secure_existing_pm2_resurrection_permissions
assert_all_current_releases_unchanged
COMPLETED=1
clear_rotation_variables
printf 'Rotation complete: all staging checks passed.\n'
printf 'Protected rollback directory: %s\n' "$BACKUP_DIR"
