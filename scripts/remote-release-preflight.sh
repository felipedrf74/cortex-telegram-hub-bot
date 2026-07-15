#!/usr/bin/env bash
# Validate the host configuration that an exact release will inherit before any
# PM2/current switch. This script runs on the target host from the immutable
# release tree; it never prints environment values.
set -euo pipefail
umask 077

ROLE=""
BASE_DIR=""
RELEASE_DIR=""
NODE_BIN="/usr/bin/node"

usage() {
  echo "Usage: remote-release-preflight.sh --role <staging|production> --base-dir <path> --release-dir <path> [--node-bin <path>]"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --role) ROLE="$2"; shift 2 ;;
    --base-dir) BASE_DIR="$2"; shift 2 ;;
    --release-dir) RELEASE_DIR="$2"; shift 2 ;;
    --node-bin) NODE_BIN="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 64 ;;
  esac
done

case "$ROLE" in staging|production) ;; *) echo "invalid release role" >&2; exit 64 ;; esac
[[ "$BASE_DIR" == /* && "$RELEASE_DIR" == "$BASE_DIR"/releases/* ]] || {
  echo "unsafe exact-release preflight path" >&2
  exit 64
}
[ -x "$NODE_BIN" ] || { echo "release Node binary is unavailable: $NODE_BIN" >&2; exit 1; }
[ -d "$RELEASE_DIR" ] || { echo "exact release directory is missing" >&2; exit 1; }

ENV_FILE="$BASE_DIR/.env"
[ -f "$ENV_FILE" ] && [ ! -L "$ENV_FILE" ] || {
  echo "release environment must be a non-symlink regular file" >&2
  exit 1
}
[ -L "$RELEASE_DIR/.env" ] || { echo "release .env link is missing" >&2; exit 1; }
[ "$(readlink -f "$RELEASE_DIR/.env")" = "$(readlink -f "$ENV_FILE")" ] || {
  echo "release .env link does not resolve to the canonical base environment" >&2
  exit 1
}

env_mode="$(stat -c '%a' "$ENV_FILE" 2>/dev/null || stat -f '%Lp' "$ENV_FILE" 2>/dev/null || true)"
case "$env_mode" in 400|600) ;; *) echo "release environment mode must be 400 or 600" >&2; exit 1 ;; esac
env_owner="$(stat -c '%U' "$ENV_FILE" 2>/dev/null || stat -f '%Su' "$ENV_FILE" 2>/dev/null || true)"
current_owner="$(id -un)"
[ -n "$env_owner" ] && [ "$env_owner" = "$current_owner" ] || {
  echo "release environment owner does not match the operator" >&2
  exit 1
}

"$NODE_BIN" - "$ENV_FILE" "$ROLE" <<'NODE'
const fs = require('fs');
const [envFile, role] = process.argv.slice(2);
const values = new Map();
for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/u)) {
  const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/u);
  if (!match || match[0].trimStart().startsWith('#')) continue;
  let value = match[2].trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  values.set(match[1], value.trim());
}
const configured = (key) => Boolean(values.get(key));
const missing = [];
for (const key of [
  'DATABASE_PATH',
  'CONTENT_ENGINE_PORT',
  'OAUTH_ENCRYPTION_KEY',
  'INTERNAL_API_SECRET',
  'AI_CALL_TIMEOUT_MS',
]) {
  if (!configured(key)) missing.push(key);
}
if (!configured('NEXUS_BACKEND_BASE_URL') && !configured('NEXUS_BACKEND_PORT')) {
  missing.push('NEXUS_BACKEND_BASE_URL_OR_NEXUS_BACKEND_PORT');
}
if (!configured('GEMINI_API_KEY') && !configured('OPENAI_API_KEY')) {
  missing.push('GEMINI_API_KEY_OR_OPENAI_API_KEY');
}
if ((values.get('PORTAL_REQUIRE_SESSION_AUTH') || '').toLowerCase() === 'true') {
  if (!configured('PORTAL_SESSION_SECRET')) missing.push('PORTAL_SESSION_SECRET');
} else if (!configured('PORTAL_TOKEN')) {
  missing.push('PORTAL_TOKEN');
}
if (role === 'staging' && !configured('PORTAL_PORT')) missing.push('PORTAL_PORT');
if (role === 'production') {
  if (!['1', 'true', 'yes'].includes((values.get('BACKUP_ENCRYPT') || '').toLowerCase())) {
    missing.push('BACKUP_ENCRYPT=true');
  }
  if (!configured('BACKUP_KEY')) missing.push('BACKUP_KEY');
}
if (missing.length) {
  console.error(`release environment is missing required configuration: ${missing.join(', ')}`);
  process.exit(1);
}
console.log(`release_env_preflight_ok role=${role} requiredKeys=validated`);
NODE

owner_args=()
node_env="staging"
staging_flag="true"
if [ "$ROLE" = "production" ]; then
  owner_args+=(--strict)
  node_env="production"
  staging_flag="false"
fi

set +e
owner_output="$(mktemp)"
chmod 600 "$owner_output"
cleanup_owner_output() { rm -f "$owner_output"; }
trap cleanup_owner_output EXIT
(
  cd "$RELEASE_DIR"
  DOTENV_CONFIG_PATH="$ENV_FILE" \
    NODE_ENV="$node_env" \
    STAGING="$staging_flag" \
    DATABASE_PATH="$BASE_DIR/data/bot.db" \
    "$NODE_BIN" -r dotenv/config dist/tools/owner-bootstrap-preflight.js "${owner_args[@]}"
) >"$owner_output" 2>&1
owner_status=$?
set -e
if [ "$owner_status" -ne 0 ]; then
  if [ "$ROLE" = "staging" ]; then
    echo "warning: staging owner bootstrap preflight reported status $owner_status" >&2
  else
    echo "production owner bootstrap preflight failed" >&2
    exit "$owner_status"
  fi
fi

# The bootstrap tool may report database paths or private owner identifiers.
# Its raw output stays in a private temporary file and is never forwarded by
# release mode. Emit only stable, non-identifying validation categories.
printf 'release_preflight_ok role=%s envPermissions=private envOwnership=validated ownerPolicy=%s\n' \
  "$ROLE" "$([ "$ROLE" = production ] && printf strict || printf warning)"
