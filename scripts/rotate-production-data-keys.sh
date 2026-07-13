#!/usr/bin/env bash
# Offline operator procedure for rotating the live production OAuth, Garmin,
# Apple Health, and Finance data-encryption keys. This script is intentionally local-only;
# run it on the VPS as the owner of both live roots.

set +x
set -euo pipefail
umask 077

readonly ACKNOWLEDGEMENT='SERVICES_STOPPED_AND_WRITES_DRAINED'
readonly BACKEND_APP='nexus-hub'
readonly CONTENT_APP='content-engine'
readonly BACKEND_PORT='8200'
readonly CONTENT_PORT='8100'
readonly PEER_BACKEND_APP='nexus-hub-staging'
readonly PEER_CONTENT_APP='content-engine-staging'
readonly PEER_BACKEND_PORT='8201'
readonly PEER_CONTENT_PORT='8101'
readonly EXPECTED_ROTATOR_SHA256='2efff86ae28c043a7622ed0fa0df8ab738a96115c0337429c4347e21e9412322'
readonly PRODUCTION_EDGE_HEALTH_URL='https://api.nexushub.me/health'
readonly POSTCHECK_CONTRACT_VERSION='2'

PRODUCTION_ROOT=''
STAGING_ROOT=''
BACKUP_DIR=''
BACKUP_DB=''
PRODUCTION_ENV=''
PRODUCTION_AGENTS_ENV=''
STAGING_ENV=''
STAGING_AGENTS_ENV=''
NEXT_ENV=''
NEXT_AGENTS_ENV=''
ECOSYSTEM=''
ROTATOR=''
STAGING_ROTATOR=''
CONTENT_ROOT=''
CONTENT_PYTHON=''
CONTENT_ENTRYPOINT=''
DB_PATH=''
PM2=''
SANITIZED_PATH=''
SAFE_PM2_HOME=''
CONTENT_OUT_LOG=''
CONTENT_ERROR_LOG=''
OPERATOR=''
POSTCHECK_SCRIPT=''
LOCAL_STATE_ROOT=''
LOCK_DIR=''
LOCK_FILE=''
LOCK_FD=''
STATE_DIR=''
PHASE_MARKER=''
PM2_DUMP=''
PM2_DUMP_BACKUP=''
PM2_BACKUP_NEXT=''
PHASE_TEMP_FILE=''

SERVICES_STOPPED=0
APPLY_ATTEMPTED=0
APPLY_CONFIRMED=0
ENV_ACTIVATED=0
COMPLETED=0
POSTAPPLY_STOP_VERIFIED=0
NEXT_ENV_CREATED=0
NEXT_AGENTS_ENV_CREATED=0
PHASE_MARKER_CREATED=0
RESURRECTION_STATE_SANITIZED=0

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
  rotate-production-data-keys.sh \
    --staging-root=/home/dominguez/telegram-hub-bot-staging \
    --production-root=/home/dominguez/telegram-hub-bot \
    --postcheck-script=/home/dominguez/telegram-hub-bot/.local/ops/production-rotation-postcheck.sh

The two absolute roots are mandatory. The script never accepts key material
on the command line and never prints key material or decrypted data. The
private postcheck script is mandatory and must emit the strict JSON contract
documented by validate_external_postcheck_result().
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

assert_private_directory() {
  local directory="$1"
  local label="$2"
  local mode owner

  [[ -d "$directory" && ! -L "$directory" ]] || die "$label must be a non-symlink directory"
  mode="$(stat -c '%a' -- "$directory")"
  [[ "$mode" == '700' ]] || die "$label must have mode 700"
  owner="$(stat -c '%U' -- "$directory")"
  [[ "$owner" == "$OPERATOR" ]] || die "$label must be owned by the current operator"
}

fsync_directory() {
  node - "$1" <<'NODE'
const fs = require('node:fs');
const directory = process.argv[2];
const descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
try {
  fs.fsyncSync(descriptor);
} finally {
  fs.closeSync(descriptor);
}
NODE
}

fsync_file() {
  node - "$1" <<'NODE'
const fs = require('node:fs');
const file = process.argv[2];
const descriptor = fs.openSync(file, fs.constants.O_RDONLY);
try {
  fs.fsyncSync(descriptor);
} finally {
  fs.closeSync(descriptor);
}
NODE
}

prepare_private_directory() {
  local directory="$1"
  local label="$2"
  local parent

  parent="$(dirname -- "$directory")"
  [[ -d "$parent" && ! -L "$parent" ]] || die "$label parent must be a non-symlink directory"
  [[ "$(stat -c '%U' -- "$parent")" == "$OPERATOR" ]] || die "$label parent owner is unsafe"
  if [[ ! -e "$directory" ]]; then
    mkdir -- "$directory"
  fi
  [[ -d "$directory" && ! -L "$directory" ]] || die "$label path is unsafe"
  chmod 700 -- "$directory"
  assert_private_directory "$directory" "$label"
}

resolve_database_path() {
  local env_file="$1"
  local root="$2"
  node - "$env_file" "$root" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const [envFile, root] = process.argv.slice(2);
const text = fs.readFileSync(envFile, 'utf8');
const matches = text.split(/\r?\n/u)
  .filter((line) => /^\s*(?:export\s+)?DATABASE_PATH\s*=/u.test(line));
if (matches.length !== 1) throw new Error('DATABASE_PATH must have exactly one assignment');

let value = matches[0].replace(/^\s*(?:export\s+)?DATABASE_PATH\s*=/u, '').trim();
if ((value.startsWith('"') && value.endsWith('"'))
    || (value.startsWith("'") && value.endsWith("'"))) {
  value = value.slice(1, -1);
} else {
  value = value.replace(/\s+#.*$/u, '').trim();
}
if (!value || value.includes('\0') || value.includes('\n') || value.includes('\r')) {
  throw new Error('DATABASE_PATH is empty or malformed');
}

const candidate = path.isAbsolute(value) ? path.normalize(value) : path.resolve(root, value);
const candidateStat = fs.lstatSync(candidate);
if (candidateStat.isSymbolicLink() || !candidateStat.isFile()) {
  throw new Error('DATABASE_PATH must refer directly to a non-symlink regular file');
}
const canonicalRoot = fs.realpathSync(root);
const canonicalDataRoot = fs.realpathSync(path.join(canonicalRoot, 'data'));
const canonicalDatabase = fs.realpathSync(candidate);
if (canonicalDatabase === canonicalDataRoot
    || !canonicalDatabase.startsWith(`${canonicalDataRoot}${path.sep}`)) {
  throw new Error('DATABASE_PATH escapes the supplied production data root');
}
process.stdout.write(canonicalDatabase);
NODE
}

verify_exact_rotator_artifacts() {
  local production_artifact="$1"
  local staging_artifact="$2"
  local expected_sha256="$3"
  local production_output production_sha256 staging_output staging_sha256

  [[ "$expected_sha256" =~ ^[0-9a-f]{64}$ ]] || die 'approved rotator digest is malformed'
  [[ -f "$production_artifact" && ! -L "$production_artifact" ]] \
    || die 'deployed dist rotator artifact is missing or is a symlink'
  [[ -f "$staging_artifact" && ! -L "$staging_artifact" ]] \
    || die 'staging dist rotator artifact is missing or is a symlink'
  cmp -s -- "$production_artifact" "$staging_artifact" \
    || die 'production and proven staging rotator artifacts differ'

  production_output="$(sha256sum -- "$production_artifact")"
  staging_output="$(sha256sum -- "$staging_artifact")"
  production_sha256="${production_output%% *}"
  staging_sha256="${staging_output%% *}"
  [[ "$production_sha256" == "$expected_sha256" \
    && "$staging_sha256" == "$expected_sha256" ]] \
    || die 'production or staging rotator artifact does not match the exact approved digest'
}

acquire_rotation_lock() {
  prepare_private_directory "$LOCK_DIR" 'rotation lock directory'
  if [[ -e "$LOCK_FILE" ]]; then
    assert_private_regular_file "$LOCK_FILE" 'rotation lock file'
  else
    (umask 077; : > "$LOCK_FILE")
    chmod 600 -- "$LOCK_FILE"
    assert_private_regular_file "$LOCK_FILE" 'rotation lock file'
    fsync_directory "$LOCK_DIR"
  fi

  exec {LOCK_FD}>>"$LOCK_FILE"
  flock -n "$LOCK_FD" || die 'another production data-key rotation is already running'
}

release_rotation_lock() {
  if [[ -n "$LOCK_FD" ]]; then
    flock -u "$LOCK_FD" >/dev/null 2>&1 || true
    exec {LOCK_FD}>&- 2>/dev/null || true
    LOCK_FD=''
  fi
}

write_phase_marker() {
  local phase="$1"
  local temporary="$STATE_DIR/.production-data-keys.phase.$$"
  [[ ! -e "$temporary" ]] || die 'stale phase-marker temporary file exists'
  PHASE_TEMP_FILE="$temporary"
  ROTATION_PHASE="$phase" \
  ROTATION_BACKUP_DIR="$BACKUP_DIR" \
  ROTATION_DATABASE_PATH="$DB_PATH" \
  ROTATION_EXPECTED_SHA="$EXPECTED_ROTATOR_SHA256" \
    node - "$temporary" "$PHASE_MARKER" "$STATE_DIR" <<'NODE'
const fs = require('node:fs');
const [temporary, marker, directory] = process.argv.slice(2);
const payload = {
  version: 1,
  phase: process.env.ROTATION_PHASE,
  backupDir: process.env.ROTATION_BACKUP_DIR,
  databasePath: process.env.ROTATION_DATABASE_PATH,
  expectedRotatorSha256: process.env.ROTATION_EXPECTED_SHA,
  updatedAt: new Date().toISOString(),
};
const descriptor = fs.openSync(
  temporary,
  fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
  0o600,
);
try {
  fs.writeFileSync(descriptor, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  fs.fsyncSync(descriptor);
} finally {
  fs.closeSync(descriptor);
}
fs.renameSync(temporary, marker);
fs.chmodSync(marker, 0o600);
const directoryDescriptor = fs.openSync(directory, fs.constants.O_RDONLY);
try {
  fs.fsyncSync(directoryDescriptor);
} finally {
  fs.closeSync(directoryDescriptor);
}
NODE
  PHASE_TEMP_FILE=''
  PHASE_MARKER_CREATED=1
}

clear_phase_marker() {
  if [[ "$PHASE_MARKER_CREATED" -eq 1 && -n "$PHASE_MARKER" ]]; then
    rm -f -- "$PHASE_MARKER"
    fsync_directory "$STATE_DIR"
    PHASE_MARKER_CREATED=0
  fi
}

assert_no_unfinished_phase() {
  [[ ! -e "$PHASE_MARKER" ]] \
    || die "an unfinished production rotation phase marker exists: $PHASE_MARKER"
}

cleanup_invocation_next_files() {
  if [[ "$NEXT_ENV_CREATED" -eq 1 ]]; then
    rm -f -- "$NEXT_ENV"
    NEXT_ENV_CREATED=0
  fi
  if [[ "$NEXT_AGENTS_ENV_CREATED" -eq 1 ]]; then
    rm -f -- "$NEXT_AGENTS_ENV"
    NEXT_AGENTS_ENV_CREATED=0
  fi
  if [[ -n "$PM2_BACKUP_NEXT" ]]; then
    rm -f -- "$PM2_BACKUP_NEXT"
    PM2_BACKUP_NEXT=''
  fi
  if [[ -n "$PHASE_TEMP_FILE" ]]; then
    rm -f -- "$PHASE_TEMP_FILE"
    PHASE_TEMP_FILE=''
  fi
  if [[ -n "$PRODUCTION_ROOT" && -d "$PRODUCTION_ROOT" ]]; then
    fsync_directory "$PRODUCTION_ROOT" >/dev/null 2>&1 || true
  fi
  if [[ -n "$SAFE_PM2_HOME" && -d "$SAFE_PM2_HOME" ]]; then
    fsync_directory "$SAFE_PM2_HOME" >/dev/null 2>&1 || true
  fi
  if [[ -n "$STATE_DIR" && -d "$STATE_DIR" ]]; then
    fsync_directory "$STATE_DIR" >/dev/null 2>&1 || true
  fi
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

generate_hex_key() {
  node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))'
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
  local finance_mode="${3:-required}"
  [[ "$finance_mode" == 'required' || "$finance_mode" == 'if-present' ]] \
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
if (financeMode !== 'required' && financeMode !== 'if-present') {
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
if (financeMode === 'required' && financeCount !== 1) {
  throw new Error('FINANCE_ENCRYPTION_KEY must already exist in the primary environment');
}
if (financeMode === 'required' || financeCount === 1) {
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

  if [[ "$destination_file" == "$NEXT_ENV" ]]; then
    NEXT_ENV_CREATED=1
  elif [[ "$destination_file" == "$NEXT_AGENTS_ENV" ]]; then
    NEXT_AGENTS_ENV_CREATED=1
  fi
}

validate_next_env() {
  local file="$1"
  local finance_mode="${2:-required}"
  local oauth garmin health finance mode
  [[ "$finance_mode" == 'required' || "$finance_mode" == 'if-present' ]] \
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
  if [[ "$finance_mode" == 'required' ]]; then
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

sanitized_pm2_content_runtime() {
  env -i \
    HOME="$HOME" \
    USER="$OPERATOR" \
    LOGNAME="$OPERATOR" \
    PATH="$SANITIZED_PATH" \
    PM2_HOME="$SAFE_PM2_HOME" \
    NODE_ENV=production \
    ENV=production \
    "$PM2" "$@"
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

assert_no_rotation_variables_in_pm2() {
  sanitized_pm2 jlist 2>/dev/null | node -e '
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => {
      const names = new Set(process.argv.slice(1));
      const forbidden = [
        "OLD_OAUTH_ENCRYPTION_KEY", "OLD_GARMIN_ENCRYPTION_KEY", "OLD_HEALTH_DATA_ENCRYPTION_KEY",
        "OLD_FINANCE_ENCRYPTION_KEY",
        "NEW_OAUTH_ENCRYPTION_KEY", "NEW_GARMIN_ENCRYPTION_KEY", "NEW_HEALTH_DATA_ENCRYPTION_KEY",
        "NEW_FINANCE_ENCRYPTION_KEY",
        "PEER_OAUTH_ENCRYPTION_KEY", "PEER_GARMIN_ENCRYPTION_KEY", "PEER_HEALTH_DATA_ENCRYPTION_KEY",
        "PEER_FINANCE_ENCRYPTION_KEY",
        "ROTATE_NEXT_OAUTH", "ROTATE_NEXT_GARMIN", "ROTATE_NEXT_HEALTH", "ROTATE_NEXT_FINANCE",
      ];
      const processes = JSON.parse(input).filter((entry) => names.has(entry.name));
      if (processes.length !== names.size) process.exit(2);
      for (const processEntry of processes) {
        const environment = processEntry.pm2_env ?? {};
        if (forbidden.some((name) => Object.prototype.hasOwnProperty.call(environment, name))) {
          process.exit(3);
        }
        const sensitiveName = /(?:^|_)(?:TOKEN|SECRET|PASSWORD|ENCRYPTION_KEY|API_KEY|PRIVATE_KEY)(?:$|_)/iu;
        if (Object.keys(environment).some((name) => sensitiveName.test(name))) {
          process.exit(4);
        }
        if (environment.NODE_ENV !== "production" && environment.ENV !== "production") {
          process.exit(5);
        }
      }
    });
  ' "$BACKEND_APP" "$CONTENT_APP" || die 'PM2 persisted a forbidden rotation variable'
}

secure_pm2_storage_permissions() {
  [[ -d "$SAFE_PM2_HOME" && ! -L "$SAFE_PM2_HOME" ]] || die 'PM2 home must be a non-symlink directory'
  [[ "$(stat -c '%U' -- "$SAFE_PM2_HOME")" == "$OPERATOR" ]] || die 'PM2 home owner is unsafe'
  chmod 700 -- "$SAFE_PM2_HOME"
  assert_private_directory "$SAFE_PM2_HOME" 'PM2 home'

  local file
  for file in "$PM2_DUMP" "$PM2_DUMP_BACKUP"; do
    if [[ -e "$file" ]]; then
      [[ -f "$file" && ! -L "$file" ]] || die 'PM2 resurrection file is unsafe'
      [[ "$(stat -c '%U' -- "$file")" == "$OPERATOR" ]] || die 'PM2 resurrection file owner is unsafe'
      chmod 600 -- "$file"
      assert_private_regular_file "$file" 'PM2 resurrection file'
    fi
  done
  fsync_directory "$SAFE_PM2_HOME"
}

validate_pm2_dump() {
  local file="$1"
  local production_expectation="$2"
  node - "$file" "$production_expectation" "$BACKEND_APP" "$CONTENT_APP" <<'NODE'
const fs = require('node:fs');
const [file, productionExpectation, backendName, contentName] = process.argv.slice(2);
const entries = JSON.parse(fs.readFileSync(file, 'utf8'));
if (!Array.isArray(entries)) process.exit(2);
const sensitiveName = /(?:^|_)(?:TOKEN|SECRET|PASSWORD|ENCRYPTION_KEY|API_KEY|PRIVATE_KEY)(?:$|_)/iu;
function containsSensitiveName(value, depth = 0) {
  if (depth > 32) return true;
  if (!value || typeof value !== 'object') return false;
  for (const [key, child] of Object.entries(value)) {
    if (sensitiveName.test(key) || containsSensitiveName(child, depth + 1)) return true;
  }
  return false;
}
for (const entry of entries) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) process.exit(3);
  if (containsSensitiveName(entry)) process.exit(4);
}
const backend = entries.filter((entry) => entry.name === backendName);
const content = entries.filter((entry) => entry.name === contentName);
if (productionExpectation === 'absent') {
  if (backend.length !== 0 || content.length !== 0) process.exit(5);
} else if (productionExpectation === 'online') {
  if (backend.length !== 1 || content.length !== 1) process.exit(6);
  if (backend[0].status !== 'online' || content[0].status !== 'online') process.exit(7);
} else {
  process.exit(8);
}
NODE
}

sanitize_pm2_resurrection_files() {
  local production_expectation="$1"
  local backup_next="$SAFE_PM2_HOME/.dump.pm2.bak.next.$$"

  [[ -f "$PM2_DUMP" && ! -L "$PM2_DUMP" ]] || die 'PM2 save did not create a safe dump file'
  [[ "$(stat -c '%U' -- "$PM2_DUMP")" == "$OPERATOR" ]] || die 'PM2 dump owner is unsafe'
  chmod 600 -- "$PM2_DUMP"
  validate_pm2_dump "$PM2_DUMP" "$production_expectation" \
    || die 'PM2 dump contains a forbidden secret or unsafe production resurrection state'

  [[ ! -e "$backup_next" ]] || die 'stale PM2 backup-next file exists'
  PM2_BACKUP_NEXT="$backup_next"
  install -m 600 -- "$PM2_DUMP" "$backup_next"
  cmp -s -- "$PM2_DUMP" "$backup_next" || die 'PM2 backup sanitation copy mismatch'
  mv -f -- "$backup_next" "$PM2_DUMP_BACKUP"
  PM2_BACKUP_NEXT=''
  chmod 600 -- "$PM2_DUMP_BACKUP"
  fsync_directory "$SAFE_PM2_HOME"

  assert_private_regular_file "$PM2_DUMP" 'PM2 dump'
  assert_private_regular_file "$PM2_DUMP_BACKUP" 'PM2 dump backup'
  validate_pm2_dump "$PM2_DUMP_BACKUP" "$production_expectation" \
    || die 'PM2 dump backup contains a forbidden secret or unsafe production resurrection state'
}

save_sanitized_pm2_state() {
  local production_expectation="$1"
  sanitized_pm2 save >/dev/null 2>&1 || die 'PM2 state save failed'
  sanitize_pm2_resurrection_files "$production_expectation"
}

remove_production_from_resurrection_state() {
  sanitized_pm2 delete "$CONTENT_APP" >/dev/null 2>&1 \
    || die 'failed to remove content-engine from PM2 before apply'
  sanitized_pm2 delete "$BACKEND_APP" >/dev/null 2>&1 \
    || die 'failed to remove backend from PM2 before apply'

  sanitized_pm2 jlist 2>/dev/null | node -e '
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => {
      const names = new Set(process.argv.slice(1));
      const processes = JSON.parse(input);
      if (processes.some((entry) => names.has(entry.name))) process.exit(2);
    });
  ' "$BACKEND_APP" "$CONTENT_APP" || die 'production PM2 entries remain after deletion'

  save_sanitized_pm2_state absent
  RESURRECTION_STATE_SANITIZED=1
}

secure_database_files() {
  local database_directory file
  database_directory="$(dirname -- "$DB_PATH")"
  [[ -d "$database_directory" && ! -L "$database_directory" ]] \
    || die 'database directory is unsafe'
  [[ "$(stat -c '%U' -- "$database_directory")" == "$OPERATOR" ]] \
    || die 'database directory owner is unsafe'
  chmod 700 -- "$database_directory"
  assert_private_directory "$database_directory" 'database directory'
  for file in "$DB_PATH" "$DB_PATH-wal" "$DB_PATH-shm"; do
    if [[ -e "$file" ]]; then
      [[ -f "$file" && ! -L "$file" ]] || die 'database, WAL, or SHM path is unsafe'
      [[ "$(stat -c '%U' -- "$file")" == "$OPERATOR" ]] || die 'database, WAL, or SHM owner is unsafe'
      chmod 600 -- "$file"
      [[ "$(stat -c '%a' -- "$file")" == '600' ]] || die 'database, WAL, or SHM mode is not 600'
    fi
  done
}

stop_production_services() {
  # Set the state before the first stop so a partial PM2 failure still causes
  # the EXIT trap to restart the unchanged pre-apply runtime.
  SERVICES_STOPPED=1
  sanitized_pm2 stop "$CONTENT_APP" >/dev/null 2>&1
  sanitized_pm2 stop "$BACKEND_APP" >/dev/null 2>&1
}

stop_production_services_quietly() {
  sanitized_pm2 stop "$CONTENT_APP" >/dev/null 2>&1 || true
  sanitized_pm2 stop "$BACKEND_APP" >/dev/null 2>&1 || true
  SERVICES_STOPPED=1
}

verify_no_production_writer_quietly() {
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

start_old_production_services() {
  clear_rotation_variables
  if ! start_production_services_from_files; then
    return 1
  fi
  wait_for_production_health || return 1
  # save_sanitized_pm2_state uses die() in the normal operator path. Contain it
  # so a restoration failure can be reported by the existing EXIT handler.
  (save_sanitized_pm2_state online) || return 1
  RESURRECTION_STATE_SANITIZED=1
}

start_production_services_from_files() {
  clear_rotation_variables
  sanitized_pm2 delete "$CONTENT_APP" >/dev/null 2>&1 || true
  sanitized_pm2 delete "$BACKEND_APP" >/dev/null 2>&1 || true
  (
    cd -- "$CONTENT_ROOT"
    sanitized_pm2_content_runtime start "$CONTENT_PYTHON" \
      --name "$CONTENT_APP" \
      --cwd "$CONTENT_ROOT" \
      --interpreter none \
      --merge-logs \
      --output "$CONTENT_OUT_LOG" \
      --error "$CONTENT_ERROR_LOG" \
      -- main.py >/dev/null 2>&1
  )
  (
    cd -- "$PRODUCTION_ROOT"
    sanitized_pm2 start "$ECOSYSTEM" --only "$BACKEND_APP" >/dev/null 2>&1
  )
  SERVICES_STOPPED=0
  assert_no_rotation_variables_in_pm2
}

recreate_production_services() {
  start_production_services_from_files
}

assert_live_pm2_bindings() {
  sanitized_pm2 jlist 2>/dev/null | node -e '
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => {
      const [productionRoot, contentRoot, contentPython, backendName, contentName] = process.argv.slice(1);
      const processes = JSON.parse(input);
      const backendMatches = processes.filter((entry) => entry.name === backendName);
      const contentMatches = processes.filter((entry) => entry.name === contentName);
      if (backendMatches.length !== 1 || contentMatches.length !== 1) process.exit(2);

      const backend = backendMatches[0]?.pm2_env ?? {};
      const content = contentMatches[0]?.pm2_env ?? {};
      if (backend.pm_cwd !== productionRoot) process.exit(3);
      if (backend.pm_exec_path !== `${productionRoot}/dist/index.js`) process.exit(4);
      if (content.pm_cwd !== contentRoot) process.exit(5);
      if (content.pm_exec_path !== contentPython) process.exit(6);
      if (!Array.isArray(content.args) || content.args.length !== 1 || content.args[0] !== "main.py") {
        process.exit(7);
      }
    });
  ' "$PRODUCTION_ROOT" "$CONTENT_ROOT" "$CONTENT_PYTHON" "$BACKEND_APP" "$CONTENT_APP"
}

assert_peer_staging_ready() {
  [[ "$(pm2_status "$PEER_CONTENT_APP")" == 'online' ]] \
    || die 'staging content-engine peer is not online'
  [[ "$(pm2_status "$PEER_BACKEND_APP")" == 'online' ]] \
    || die 'staging backend peer is not online'
  curl --noproxy '*' -fsS --max-time 2 "http://127.0.0.1:$PEER_CONTENT_PORT/health" >/dev/null 2>&1 \
    || die 'staging content-engine peer health failed'
  curl --noproxy '*' -fsS --max-time 2 "http://127.0.0.1:$PEER_BACKEND_PORT/health" >/dev/null 2>&1 \
    || die 'staging backend peer health failed'
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

assert_production_quiescent() {
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
  'garmin_sessions',
  'garmin_user_tokens',
  'apple_health_data',
  'finance_transactions',
  'finance_tax_events',
];

if (result.mode !== expectedMode || result.environment !== 'production') process.exit(2);
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
  if ! node - "$PRODUCTION_ROOT" "$DB_PATH" "$BACKUP_DB" 2>"$error_file" <<'NODE'
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
  fsync_file "$BACKUP_DB"
  fsync_directory "$BACKUP_DIR"
}

check_database_integrity() {
  node - "$PRODUCTION_ROOT" "$DB_PATH" <<'NODE'
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

wait_for_production_health() {
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

validate_external_edge_health_result() {
  local response="$1"
  node - "$response" <<'NODE'
const fs = require('node:fs');
const payload = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (payload?.status !== 'healthy' || payload?.server?.status !== 'online'
    || payload?.server?.database !== 'connected') process.exit(2);
NODE
}

assert_external_edge_health() {
  local response="$BACKUP_DIR/production-edge-health.json"
  local error="$BACKUP_DIR/production-edge-health-error.txt"
  if ! curl --noproxy '*' -fsS --max-time 10 "$PRODUCTION_EDGE_HEALTH_URL" \
    >"$response" 2>"$error"; then
    die "production edge health failed; inspect protected file $error"
  fi
  validate_external_edge_health_result "$response" \
    || die 'production edge health payload failed validation'
}

validate_postcheck_script() {
  local mode owner canonical postcheck_directory
  [[ "$POSTCHECK_SCRIPT" == /* ]] || die 'postcheck script path must be absolute'
  [[ -f "$POSTCHECK_SCRIPT" && ! -L "$POSTCHECK_SCRIPT" ]] \
    || die 'postcheck script must be a non-symlink regular file'
  canonical="$(canonical_file "$POSTCHECK_SCRIPT")" || die 'postcheck script path cannot be canonicalized'
  [[ "$canonical" == "$POSTCHECK_SCRIPT" ]] || die 'postcheck script path must already be canonical'
  [[ "$POSTCHECK_SCRIPT" == "$PRODUCTION_ROOT"/.local/ops/* ]] \
    || die 'postcheck script must be inside the protected production .local/ops directory'
  postcheck_directory="$(dirname -- "$POSTCHECK_SCRIPT")"
  [[ "$postcheck_directory" == "$PRODUCTION_ROOT/.local/ops" ]] \
    || die 'postcheck script must be a direct child of the protected production .local/ops directory'
  assert_private_directory "$PRODUCTION_ROOT/.local" 'production .local directory'
  assert_private_directory "$postcheck_directory" 'production postcheck directory'
  mode="$(stat -c '%a' -- "$POSTCHECK_SCRIPT")"
  case "$mode" in
    500|700) ;;
    *) die 'postcheck script must have mode 500 or 700' ;;
  esac
  owner="$(stat -c '%U' -- "$POSTCHECK_SCRIPT")"
  [[ "$owner" == "$OPERATOR" ]] || die 'postcheck script owner is unsafe'
}

validate_external_postcheck_result() {
  local file="$1"
  node - "$file" "$POSTCHECK_CONTRACT_VERSION" <<'NODE'
const fs = require('node:fs');
const [file, expectedVersion] = process.argv.slice(2);
const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
const required = [
  'productionEdgeHealth',
  'stagingPeerHealth',
  'authenticatedOAuthRead',
  'authenticatedGarminRead',
  'authenticatedHealthRead',
  'authenticatedFinanceRead',
  'pm2Stable',
  'noNewAlerts',
];
const allowed = new Set(['version', ...required]);
if (!payload || typeof payload !== 'object' || Array.isArray(payload)) process.exit(2);
if (String(payload.version) !== expectedVersion) process.exit(3);
if (Object.keys(payload).some((key) => !allowed.has(key))) process.exit(4);
if (required.some((key) => payload[key] !== true)) process.exit(5);
NODE
}

run_external_postchecks() {
  local result="$BACKUP_DIR/external-postcheck.json"
  local error="$BACKUP_DIR/external-postcheck-error.txt"
  clear_rotation_variables
  if ! env -i \
    HOME="$HOME" \
    USER="$OPERATOR" \
    LOGNAME="$OPERATOR" \
    PATH="$SANITIZED_PATH" \
    PM2_HOME="$SAFE_PM2_HOME" \
    NEXUS_ROTATION_PRODUCTION_ROOT="$PRODUCTION_ROOT" \
    NEXUS_ROTATION_STAGING_ROOT="$STAGING_ROOT" \
    NEXUS_ROTATION_BACKUP_DIR="$BACKUP_DIR" \
    NEXUS_ROTATION_EXPECTED_ROTATOR_SHA256="$EXPECTED_ROTATOR_SHA256" \
      "$POSTCHECK_SCRIPT" >"$result" 2>"$error"; then
    die "external postcheck script failed; inspect protected file $error"
  fi
  validate_external_postcheck_result "$result" \
    || die 'external postcheck JSON failed the strict fail-closed contract'
}

load_rotation_variables() {
  local old_file="$1"
  local next_file="$2"
  local peer_file="$3"
  OLD_OAUTH_ENCRYPTION_KEY="$(read_effective_key "$old_file" OAUTH_ENCRYPTION_KEY OAUTH_ENCRYPTION_KEY)"
  OLD_GARMIN_ENCRYPTION_KEY="$(read_effective_key "$old_file" GARMIN_ENCRYPTION_KEY OAUTH_ENCRYPTION_KEY)"
  OLD_HEALTH_DATA_ENCRYPTION_KEY="$(read_effective_key "$old_file" HEALTH_DATA_ENCRYPTION_KEY OAUTH_ENCRYPTION_KEY)"
  OLD_FINANCE_ENCRYPTION_KEY="$(read_effective_key "$old_file" FINANCE_ENCRYPTION_KEY FINANCE_ENCRYPTION_KEY)"
  NEW_OAUTH_ENCRYPTION_KEY="$(read_effective_key "$next_file" OAUTH_ENCRYPTION_KEY OAUTH_ENCRYPTION_KEY)"
  NEW_GARMIN_ENCRYPTION_KEY="$(read_effective_key "$next_file" GARMIN_ENCRYPTION_KEY OAUTH_ENCRYPTION_KEY)"
  NEW_HEALTH_DATA_ENCRYPTION_KEY="$(read_effective_key "$next_file" HEALTH_DATA_ENCRYPTION_KEY OAUTH_ENCRYPTION_KEY)"
  NEW_FINANCE_ENCRYPTION_KEY="$(read_effective_key "$next_file" FINANCE_ENCRYPTION_KEY FINANCE_ENCRYPTION_KEY)"
  PEER_OAUTH_ENCRYPTION_KEY="$(read_effective_key "$peer_file" OAUTH_ENCRYPTION_KEY OAUTH_ENCRYPTION_KEY)"
  PEER_GARMIN_ENCRYPTION_KEY="$(read_effective_key "$peer_file" GARMIN_ENCRYPTION_KEY OAUTH_ENCRYPTION_KEY)"
  PEER_HEALTH_DATA_ENCRYPTION_KEY="$(read_effective_key "$peer_file" HEALTH_DATA_ENCRYPTION_KEY OAUTH_ENCRYPTION_KEY)"
  PEER_FINANCE_ENCRYPTION_KEY="$(read_effective_key "$peer_file" FINANCE_ENCRYPTION_KEY FINANCE_ENCRYPTION_KEY)"
}

quoted() {
  printf '%q' "$1"
}

print_manual_rollback_steps() {
  local quarantine="$BACKUP_DIR/ambiguous-post-apply-state"
  local db_next="$DB_PATH.rollback-next"
  local env_next="$PRODUCTION_ROOT/.env.rollback-next"
  local agents_next="$PRODUCTION_ROOT/.env.agents.rollback-next"

  printf '\nROTATION STATE IS AMBIGUOUS OR POST-APPLY VALIDATION FAILED.\n' >&2
  if [[ "$POSTAPPLY_STOP_VERIFIED" -eq 1 ]]; then
    printf 'Both production services are non-running, both ports are closed, and DB handles are absent.\n' >&2
  else
    printf 'CRITICAL: stopped-state proof failed. Do not run rollback until all production writers, ports, and DB handles are quiescent.\n' >&2
  fi
  printf 'The script did not restore or destroy the rotated database.\n' >&2
  if [[ -n "$PHASE_MARKER" ]]; then
    printf 'Durable recovery marker: %s\n' "$PHASE_MARKER" >&2
  fi
  printf 'Inspect the protected results first. If rollback is approved, run these exact steps as %s:\n' "$OPERATOR" >&2
  printf '  mkdir -m 700 -- %s\n' "$(quoted "$quarantine")" >&2
  printf '  install -m 600 -- %s %s\n' "$(quoted "$DB_PATH")" "$(quoted "$quarantine/bot.db.after-apply")" >&2
  printf '  [ ! -e %s ] || mv -- %s %s\n' "$(quoted "$DB_PATH-wal")" "$(quoted "$DB_PATH-wal")" "$(quoted "$quarantine/bot.db-wal.after-apply")" >&2
  printf '  [ ! -e %s ] || mv -- %s %s\n' "$(quoted "$DB_PATH-shm")" "$(quoted "$DB_PATH-shm")" "$(quoted "$quarantine/bot.db-shm.after-apply")" >&2
  printf '  install -m 600 -- %s %s && mv -f -- %s %s\n' "$(quoted "$BACKUP_DB")" "$(quoted "$db_next")" "$(quoted "$db_next")" "$(quoted "$DB_PATH")" >&2
  printf '  install -m 600 -- %s %s && mv -f -- %s %s\n' "$(quoted "$BACKUP_DIR/.env.before")" "$(quoted "$env_next")" "$(quoted "$env_next")" "$(quoted "$PRODUCTION_ENV")" >&2
  printf '  install -m 600 -- %s %s && mv -f -- %s %s\n' "$(quoted "$BACKUP_DIR/.env.agents.before")" "$(quoted "$agents_next")" "$(quoted "$agents_next")" "$(quoted "$PRODUCTION_AGENTS_ENV")" >&2
  printf '  unset OLD_OAUTH_ENCRYPTION_KEY OLD_GARMIN_ENCRYPTION_KEY OLD_HEALTH_DATA_ENCRYPTION_KEY OLD_FINANCE_ENCRYPTION_KEY NEW_OAUTH_ENCRYPTION_KEY NEW_GARMIN_ENCRYPTION_KEY NEW_HEALTH_DATA_ENCRYPTION_KEY NEW_FINANCE_ENCRYPTION_KEY PEER_OAUTH_ENCRYPTION_KEY PEER_GARMIN_ENCRYPTION_KEY PEER_HEALTH_DATA_ENCRYPTION_KEY PEER_FINANCE_ENCRYPTION_KEY\n' >&2
  printf '  env -i HOME=%s USER=%s LOGNAME=%s PATH=%s PM2_HOME=%s %s delete %s %s\n' \
    "$(quoted "$HOME")" "$(quoted "$OPERATOR")" "$(quoted "$OPERATOR")" "$(quoted "$SANITIZED_PATH")" "$(quoted "$SAFE_PM2_HOME")" "$(quoted "$PM2")" "$(quoted "$CONTENT_APP")" "$(quoted "$BACKEND_APP")" >&2
  printf '  cd -- %s && env -i HOME=%s USER=%s LOGNAME=%s PATH=%s PM2_HOME=%s NODE_ENV=production ENV=production %s start %s --name %s --cwd %s --interpreter none --merge-logs --output %s --error %s -- main.py\n' \
    "$(quoted "$CONTENT_ROOT")" "$(quoted "$HOME")" "$(quoted "$OPERATOR")" "$(quoted "$OPERATOR")" "$(quoted "$SANITIZED_PATH")" "$(quoted "$SAFE_PM2_HOME")" "$(quoted "$PM2")" "$(quoted "$CONTENT_PYTHON")" "$(quoted "$CONTENT_APP")" "$(quoted "$CONTENT_ROOT")" "$(quoted "$CONTENT_OUT_LOG")" "$(quoted "$CONTENT_ERROR_LOG")" >&2
  printf '  cd -- %s && env -i HOME=%s USER=%s LOGNAME=%s PATH=%s PM2_HOME=%s %s start %s --only %s\n' \
    "$(quoted "$PRODUCTION_ROOT")" "$(quoted "$HOME")" "$(quoted "$OPERATOR")" "$(quoted "$OPERATOR")" "$(quoted "$SANITIZED_PATH")" "$(quoted "$SAFE_PM2_HOME")" "$(quoted "$PM2")" "$(quoted "$ECOSYSTEM")" "$(quoted "$BACKEND_APP")" >&2
  printf '  env -i HOME=%s USER=%s LOGNAME=%s PATH=%s PM2_HOME=%s %s save\n' \
    "$(quoted "$HOME")" "$(quoted "$OPERATOR")" "$(quoted "$OPERATOR")" "$(quoted "$SANITIZED_PATH")" "$(quoted "$SAFE_PM2_HOME")" "$(quoted "$PM2")" >&2
  printf '  chmod 700 -- %s && chmod 600 -- %s\n' \
    "$(quoted "$SAFE_PM2_HOME")" "$(quoted "$PM2_DUMP")" >&2
  printf '  install -m 600 -- %s %s && mv -f -- %s %s\n' \
    "$(quoted "$PM2_DUMP")" "$(quoted "$SAFE_PM2_HOME/.dump.pm2.bak.rollback-next")" \
    "$(quoted "$SAFE_PM2_HOME/.dump.pm2.bak.rollback-next")" "$(quoted "$PM2_DUMP_BACKUP")" >&2
  printf 'Keep the durable phase marker until database decryption, PM2 dump sanitation, health, and external postchecks pass.\n' >&2
  printf 'Do not delete %s or %s until rollback and decryption checks are complete.\n' "$BACKUP_DIR" "$quarantine" >&2
}

on_exit() {
  local status="$1"
  local restored=0
  set +e
  set +x

  if [[ "$COMPLETED" -eq 1 || "$status" -eq 0 ]]; then
    clear_rotation_variables
    cleanup_invocation_next_files
    release_rotation_lock
    return
  fi

  if [[ "$APPLY_ATTEMPTED" -eq 1 ]]; then
    clear_rotation_variables
    cleanup_invocation_next_files
    stop_production_services_quietly
    if verify_no_production_writer_quietly; then
      POSTAPPLY_STOP_VERIFIED=1
    fi
    print_manual_rollback_steps
  else
    clear_rotation_variables
    cleanup_invocation_next_files
    if [[ "$SERVICES_STOPPED" -eq 1 ]]; then
      if start_old_production_services; then
        restored=1
        printf 'Pre-apply failure: production services were recreated with the unchanged environment and database.\n' >&2
      else
        printf 'Pre-apply failure: automatic recreation of the unchanged production services failed; use the protected rollback instructions.\n' >&2
      fi
    else
      restored=1
    fi
    if [[ "$restored" -eq 1 ]]; then
      clear_phase_marker
    fi
    if [[ -n "$BACKUP_DIR" ]]; then
      printf 'Protected rollback directory: %s\n' "$BACKUP_DIR" >&2
    fi
  fi
  release_rotation_lock
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
    --postcheck-script=*)
      [[ -z "$POSTCHECK_SCRIPT" ]] || die '--postcheck-script may be supplied only once'
      POSTCHECK_SCRIPT="${argument#*=}"
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

[[ -n "$PRODUCTION_ROOT" && -n "$STAGING_ROOT" && -n "$POSTCHECK_SCRIPT" ]] \
  || { usage >&2; die 'both live roots and the postcheck script are required'; }
[[ "$PRODUCTION_ROOT" == /* && "$STAGING_ROOT" == /* && "$POSTCHECK_SCRIPT" == /* ]] \
  || die 'both live roots and the postcheck script must be absolute'

require_command node
require_command stat
require_command lsof
require_command curl
require_command install
require_command cmp
require_command mktemp
require_command flock
require_command sha256sum
require_command chmod
require_command mkdir
require_command rm

OPERATOR="$(id -un)"
PRODUCTION_ROOT="$(canonical_directory "$PRODUCTION_ROOT")" || die 'production root is unavailable'
STAGING_ROOT="$(canonical_directory "$STAGING_ROOT")" || die 'staging root is unavailable'
[[ "$PRODUCTION_ROOT" != "$STAGING_ROOT" ]] || die 'staging and production roots must differ'

LOCAL_STATE_ROOT="$PRODUCTION_ROOT/.local"
if [[ ! -e "$LOCAL_STATE_ROOT" ]]; then
  mkdir -- "$LOCAL_STATE_ROOT"
  chmod 700 -- "$LOCAL_STATE_ROOT"
  fsync_directory "$PRODUCTION_ROOT"
fi
[[ -d "$LOCAL_STATE_ROOT" && ! -L "$LOCAL_STATE_ROOT" ]] || die 'production .local path is unsafe'
[[ "$(stat -c '%U' -- "$LOCAL_STATE_ROOT")" == "$OPERATOR" ]] || die 'production .local owner is unsafe'
chmod 700 -- "$LOCAL_STATE_ROOT"
assert_private_directory "$LOCAL_STATE_ROOT" 'production .local directory'
LOCK_DIR="$LOCAL_STATE_ROOT/rotation-locks"
LOCK_FILE="$LOCK_DIR/production-data-keys.lock"
STATE_DIR="$LOCAL_STATE_ROOT/rotation-state"
PHASE_MARKER="$STATE_DIR/production-data-keys.phase.json"
prepare_private_directory "$STATE_DIR" 'rotation state directory'
acquire_rotation_lock
assert_no_unfinished_phase

PRODUCTION_ENV="$PRODUCTION_ROOT/.env"
PRODUCTION_AGENTS_ENV="$PRODUCTION_ROOT/.env.agents"
STAGING_ENV="$STAGING_ROOT/.env"
STAGING_AGENTS_ENV="$STAGING_ROOT/.env.agents"
NEXT_ENV="$PRODUCTION_ROOT/.env.next"
NEXT_AGENTS_ENV="$PRODUCTION_ROOT/.env.agents.next"
ECOSYSTEM="$PRODUCTION_ROOT/ecosystem.config.js"
ROTATOR="$PRODUCTION_ROOT/dist/tools/rotate-data-encryption-keys.js"
STAGING_ROTATOR="$STAGING_ROOT/dist/tools/rotate-data-encryption-keys.js"
CONTENT_ROOT="$PRODUCTION_ROOT/content-engine"
CONTENT_PYTHON="$CONTENT_ROOT/.venv/bin/python3.12"
CONTENT_ENTRYPOINT="$CONTENT_ROOT/main.py"

validate_postcheck_script

assert_private_regular_file "$PRODUCTION_ENV" 'production .env'
assert_private_regular_file "$PRODUCTION_AGENTS_ENV" 'production .env.agents'
assert_private_regular_file "$STAGING_ENV" 'staging .env'
assert_private_regular_file "$STAGING_AGENTS_ENV" 'staging .env.agents'
[[ ! -e "$NEXT_ENV" && ! -e "$NEXT_AGENTS_ENV" ]] || die 'a stale next dotenv file already exists'

verify_exact_rotator_artifacts "$ROTATOR" "$STAGING_ROTATOR" "$EXPECTED_ROTATOR_SHA256"
[[ -f "$PRODUCTION_ROOT/node_modules/better-sqlite3/package.json" ]] || die 'deployed better-sqlite3 dependency is missing'
[[ -f "$ECOSYSTEM" && ! -L "$ECOSYSTEM" ]] || die 'production ecosystem artifact is missing or is a symlink'
[[ -d "$CONTENT_ROOT" && ! -L "$CONTENT_ROOT" ]] || die 'production content-engine root is unavailable or is a symlink'
[[ -x "$CONTENT_PYTHON" ]] || die 'production content-engine Python executable is unavailable'
[[ -f "$CONTENT_ENTRYPOINT" && ! -L "$CONTENT_ENTRYPOINT" ]] || die 'production content-engine entrypoint is unavailable or is a symlink'
node --check "$ROTATOR" >/dev/null 2>&1 || die 'deployed dist rotator fails JavaScript syntax validation'
node "$ROTATOR" --help >/dev/null 2>&1 || die 'deployed dist rotator help preflight failed'
node - "$ROTATOR" "$ACKNOWLEDGEMENT" <<'NODE' || die 'deployed dist rotator API preflight failed'
const [rotatorPath, acknowledgement] = process.argv.slice(2);
const rotator = require(rotatorPath);
if (rotator.SERVICE_STOPPED_ACKNOWLEDGEMENT !== acknowledgement) process.exit(2);
if (typeof rotator.runDataEncryptionKeyRotation !== 'function') process.exit(3);
NODE

node - "$PRODUCTION_ROOT" "$ECOSYSTEM" <<'NODE' || die 'production ecosystem paths do not bind to the supplied live root'
const path = require('node:path');
const [root, ecosystemPath] = process.argv.slice(2);
const ecosystem = require(ecosystemPath);
const apps = Array.isArray(ecosystem.apps) ? ecosystem.apps : [];
const backend = apps.find((app) => app.name === 'nexus-hub');
if (!backend || apps.length !== 1) process.exit(2);
if (path.resolve(backend.cwd) !== path.resolve(root)) process.exit(3);
if (path.resolve(root, backend.script) !== path.resolve(root, 'dist/index.js')) process.exit(4);
if (backend.env?.NODE_ENV !== 'production') process.exit(5);
NODE

PM2="${PM2_BIN:-$HOME/.npm-global/bin/pm2}"
if [[ ! -x "$PM2" ]]; then
  PM2="$(command -v pm2 || true)"
fi
[[ -n "$PM2" && -x "$PM2" ]] || die 'PM2 executable is unavailable'
SANITIZED_PATH="$(dirname -- "$(command -v node)"):$(dirname -- "$PM2"):/usr/local/bin:/usr/bin:/bin"
SAFE_PM2_HOME="${PM2_HOME:-$HOME/.pm2}"
CONTENT_OUT_LOG="$SAFE_PM2_HOME/logs/content-engine-out.log"
CONTENT_ERROR_LOG="$SAFE_PM2_HOME/logs/content-engine-error.log"
PM2_DUMP="$SAFE_PM2_HOME/dump.pm2"
PM2_DUMP_BACKUP="$SAFE_PM2_HOME/dump.pm2.bak"

secure_pm2_storage_permissions

assert_pm2_online "$CONTENT_APP"
assert_pm2_online "$BACKEND_APP"
assert_live_pm2_bindings || die 'live PM2 process bindings do not match the supplied production root'
assert_peer_staging_ready

DB_PATH="$(resolve_database_path "$PRODUCTION_ENV" "$PRODUCTION_ROOT")" \
  || die 'DATABASE_PATH could not be resolved safely inside the production data root'
[[ -f "$DB_PATH" && ! -L "$DB_PATH" ]] || die 'production database must be a non-symlink regular file'

load_rotation_variables "$PRODUCTION_ENV" "$PRODUCTION_ENV" "$STAGING_ENV"

production_agents_oauth="$(read_effective_key "$PRODUCTION_AGENTS_ENV" OAUTH_ENCRYPTION_KEY OAUTH_ENCRYPTION_KEY)"
production_agents_garmin="$(read_effective_key "$PRODUCTION_AGENTS_ENV" GARMIN_ENCRYPTION_KEY OAUTH_ENCRYPTION_KEY)"
production_agents_health="$(read_effective_key "$PRODUCTION_AGENTS_ENV" HEALTH_DATA_ENCRYPTION_KEY OAUTH_ENCRYPTION_KEY)"
[[ "$production_agents_oauth" == "$OLD_OAUTH_ENCRYPTION_KEY" \
  && "$production_agents_garmin" == "$OLD_GARMIN_ENCRYPTION_KEY" \
  && "$production_agents_health" == "$OLD_HEALTH_DATA_ENCRYPTION_KEY" ]] \
  || die 'production .env and .env.agents encryption keys are not in parity'
assert_optional_key_parity \
  "$PRODUCTION_AGENTS_ENV" FINANCE_ENCRYPTION_KEY "$OLD_FINANCE_ENCRYPTION_KEY" \
  'optional production .env.agents Finance key'

staging_agents_oauth="$(read_effective_key "$STAGING_AGENTS_ENV" OAUTH_ENCRYPTION_KEY OAUTH_ENCRYPTION_KEY)"
staging_agents_garmin="$(read_effective_key "$STAGING_AGENTS_ENV" GARMIN_ENCRYPTION_KEY OAUTH_ENCRYPTION_KEY)"
staging_agents_health="$(read_effective_key "$STAGING_AGENTS_ENV" HEALTH_DATA_ENCRYPTION_KEY OAUTH_ENCRYPTION_KEY)"
[[ "$staging_agents_oauth" == "$PEER_OAUTH_ENCRYPTION_KEY" \
  && "$staging_agents_garmin" == "$PEER_GARMIN_ENCRYPTION_KEY" \
  && "$staging_agents_health" == "$PEER_HEALTH_DATA_ENCRYPTION_KEY" ]] \
  || die 'staging .env and .env.agents encryption keys are not in parity'
assert_optional_key_parity \
  "$STAGING_AGENTS_ENV" FINANCE_ENCRYPTION_KEY "$PEER_FINANCE_ENCRYPTION_KEY" \
  'optional staging .env.agents Finance key'
assert_all_keys_unique 'staging peer' \
  "$PEER_OAUTH_ENCRYPTION_KEY" \
  "$PEER_GARMIN_ENCRYPTION_KEY" \
  "$PEER_HEALTH_DATA_ENCRYPTION_KEY" \
  "$PEER_FINANCE_ENCRYPTION_KEY"

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

backup_parent="$LOCAL_STATE_ROOT/rotation-backups"
prepare_private_directory "$backup_parent" 'rotation backup parent'
BACKUP_DIR="$(mktemp -d "$backup_parent/production-data-keys-$(date -u +%Y%m%dT%H%M%SZ)-XXXXXXXX")"
chmod 700 -- "$BACKUP_DIR"
[[ "$(stat -c '%U' -- "$BACKUP_DIR")" == "$OPERATOR" ]] || die 'backup directory owner is unsafe'
[[ "$(stat -c '%a' -- "$BACKUP_DIR")" == '700' ]] || die 'backup directory mode is unsafe'

install -m 600 -- "$PRODUCTION_ENV" "$BACKUP_DIR/.env.before"
install -m 600 -- "$PRODUCTION_AGENTS_ENV" "$BACKUP_DIR/.env.agents.before"
cmp -s -- "$PRODUCTION_ENV" "$BACKUP_DIR/.env.before" || die 'production .env rollback copy mismatch'
cmp -s -- "$PRODUCTION_AGENTS_ENV" "$BACKUP_DIR/.env.agents.before" || die 'production .env.agents rollback copy mismatch'
fsync_file "$BACKUP_DIR/.env.before"
fsync_file "$BACKUP_DIR/.env.agents.before"
fsync_directory "$BACKUP_DIR"
write_phase_marker prepared

write_next_env "$PRODUCTION_ENV" "$NEXT_ENV" required
write_next_env "$PRODUCTION_AGENTS_ENV" "$NEXT_AGENTS_ENV" if-present
validate_next_env "$NEXT_ENV" required
validate_next_env "$NEXT_AGENTS_ENV" if-present
fsync_directory "$PRODUCTION_ROOT"
write_phase_marker preflight_ready

backend_out_log="$PRODUCTION_ROOT/logs/out.log"
backend_error_log="$PRODUCTION_ROOT/logs/error.log"
content_out_log="$CONTENT_OUT_LOG"
content_error_log="$CONTENT_ERROR_LOG"
backend_out_offset="$(file_size "$backend_out_log")"
backend_error_offset="$(file_size "$backend_error_log")"
content_out_offset="$(file_size "$content_out_log")"
content_error_offset="$(file_size "$content_error_log")"

printf 'Preflight: deployed rotator, roots, environment parity, and destination-key constraints passed.\n'

live_result="$BACKUP_DIR/live-dry-run.json"
live_error="$BACKUP_DIR/live-dry-run-error.txt"
if ! run_rotator \
  --environment=production \
  --database="$DB_PATH" \
  >"$live_result" 2>"$live_error"; then
  die "live dry-run failed; inspect protected file $live_error"
fi
live_counts="$(validate_rotation_result "$live_result" dry-run no)" || die 'live dry-run JSON failed validation'
printf 'Live dry-run: passed (nonempty/needs/already-new/undecryptable/applied=%s).\n' "$live_counts"

stop_production_services
assert_production_quiescent
secure_database_files
write_phase_marker services_stopped
printf 'Quiescence: both PM2 apps stopped, ports 8100/8200 closed, and DB/WAL/SHM handles absent.\n'

BACKUP_DB="$BACKUP_DIR/bot.db.before"
create_consistent_backup
write_phase_marker backup_verified
printf 'Backup: consistent mode-600 better-sqlite3 backup passed integrity_check.\n'

stopped_result="$BACKUP_DIR/stopped-dry-run.json"
stopped_error="$BACKUP_DIR/stopped-dry-run-error.txt"
if ! run_rotator \
  --environment=production \
  --database="$DB_PATH" \
  >"$stopped_result" 2>"$stopped_error"; then
  die "stopped-state dry-run failed; inspect protected file $stopped_error"
fi
stopped_counts="$(validate_rotation_result "$stopped_result" dry-run no)" || die 'stopped-state dry-run JSON failed validation'
printf 'Stopped-state dry-run: passed (nonempty/needs/already-new/undecryptable/applied=%s).\n' "$stopped_counts"

assert_production_quiescent
cmp -s -- "$PRODUCTION_ENV" "$BACKUP_DIR/.env.before" || die 'production .env changed before apply'
cmp -s -- "$PRODUCTION_AGENTS_ENV" "$BACKUP_DIR/.env.agents.before" || die 'production .env.agents changed before apply'
remove_production_from_resurrection_state
verify_no_production_writer_quietly \
  || die 'production writer appeared after sanitizing the PM2 resurrection state'
write_phase_marker resurrection_state_sanitized
printf 'Resurrection safety: production PM2 entries removed; dump and backup are sanitized and mode 600.\n'

apply_result="$BACKUP_DIR/apply-result.json"
apply_error="$BACKUP_DIR/apply-error.txt"
write_phase_marker apply_started
APPLY_ATTEMPTED=1
if ! run_rotator \
  --environment=production \
  --database="$DB_PATH" \
  --apply \
  --backup="$BACKUP_DB" \
  --services-stopped-ack="$ACKNOWLEDGEMENT" \
  >"$apply_result" 2>"$apply_error"; then
  die "apply returned failure; state remains stopped and must be inspected in $BACKUP_DIR"
fi
apply_counts="$(validate_rotation_result "$apply_result" apply yes)" || die 'apply JSON failed strict validation'
APPLY_CONFIRMED=1
write_phase_marker apply_verified
printf 'Apply: passed strict JSON validation (nonempty/needs/already-new/undecryptable/applied=%s).\n' "$apply_counts"

validate_next_env "$NEXT_ENV" required
validate_next_env "$NEXT_AGENTS_ENV" if-present
mv -f -- "$NEXT_ENV" "$PRODUCTION_ENV"
NEXT_ENV_CREATED=0
fsync_directory "$PRODUCTION_ROOT"
mv -f -- "$NEXT_AGENTS_ENV" "$PRODUCTION_AGENTS_ENV"
NEXT_AGENTS_ENV_CREATED=0
fsync_directory "$PRODUCTION_ROOT"
ENV_ACTIVATED=1
assert_private_regular_file "$PRODUCTION_ENV" 'activated production .env'
assert_private_regular_file "$PRODUCTION_AGENTS_ENV" 'activated production .env.agents'
write_phase_marker environment_activated
printf 'Environment activation: both next files atomically renamed into place.\n'

clear_rotation_variables
recreate_production_services
wait_for_production_health || die 'production services did not become online and healthy after recreation'
assert_pm2_online "$CONTENT_APP"
assert_pm2_online "$BACKEND_APP"
secure_database_files
save_sanitized_pm2_state online
RESURRECTION_STATE_SANITIZED=1
write_phase_marker runtime_healthy
printf 'Runtime: production apps recreated from explicit live definitions in a sanitized environment; both health checks passed.\n'

check_database_integrity || die 'post-rotation database integrity_check failed'
printf 'Database: post-rotation integrity_check passed.\n'

load_rotation_variables "$BACKUP_DIR/.env.before" "$PRODUCTION_ENV" "$STAGING_ENV"
post_result="$BACKUP_DIR/post-rotation-dry-run.json"
post_error="$BACKUP_DIR/post-rotation-dry-run-error.txt"
if ! run_rotator \
  --environment=production \
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
[[ "$decryption_error_count" -eq 0 ]] || die 'new production logs contain a decryption-failure signature'
printf 'Log scan: 0 new decryption-failure signatures.\n'

assert_external_edge_health
run_external_postchecks
save_sanitized_pm2_state online
secure_database_files
write_phase_marker complete
clear_phase_marker
COMPLETED=1
clear_rotation_variables
printf 'Rotation complete: all production checks passed.\n'
printf 'Protected rollback directory: %s\n' "$BACKUP_DIR"
