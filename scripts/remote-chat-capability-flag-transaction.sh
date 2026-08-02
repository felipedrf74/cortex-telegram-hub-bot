#!/usr/bin/env bash
# Server-side exact-release chat capability transaction.
set -euo pipefail
umask 077

readonly FLAG_RECEIPT_SCHEMA='nexus.chat-capability-flag-transaction.v1'
readonly SECRET_RECEIPT_SCHEMA='nexus.chat-capability-secret-transaction.v1'
readonly OBSERVATION_PLAN_SCHEMA='nexus.chat-capability-observation-plan.v1'
readonly OBSERVATION_RECEIPT_SCHEMA='nexus.chat-capability-observation-receipt.v1'
readonly SHADOW_HOOK_PLAN_SCHEMA='nexus.chat-shadow-route-hook-plan.v1'
readonly SHADOW_HOOK_RECEIPT_SCHEMA='nexus.chat-shadow-route-hook-transaction.v1'
readonly USER_RELEASE_LOCK='/home/dominguez/.local/state/nexus-release/.release.lock'
readonly ROOT_SONAR_LOCK='/run/lock/nexus-release-sonar.lock'
readonly STATE_ROOT='/home/dominguez/.local/state/nexus-release/chat-capability-flags'
readonly STAGING_BASE_DIR='/home/dominguez/telegram-hub-bot-staging'
readonly PRODUCTION_BASE_DIR='/home/dominguez/telegram-hub-bot'
readonly STAGING_BACKEND_PORT=8201
readonly PM2_BIN='/usr/local/bin/pm2'
readonly NODE_BIN='/usr/bin/node'
readonly TIMEOUT_BIN='/usr/bin/timeout'

COMMAND="${1:-}"
ROLE="${2:-}"
BASE_DIR="${3:-}"
RUNTIME_SHA="${4:-}"
ARTIFACT_DIGEST="${5:-}"
shift $(( $# >= 5 ? 5 : $# ))

FLAG=''
DESIRED_VALUE=''
TRANSITION_REASON=''
TRANSACTION_ID=''
ACK_PLAN=''
SINCE=''
UNTIL=''
DEDICATED_ID=''

RELEASE_DIR=''
HELPER=''
ENV_FILE=''
BACKEND_APP=''
CONTENT_APP=''
BACKEND_PORT=''
CONTENT_PORT=''
PENDING_PLAN=''
PENDING_PRIVATE=''
SEQUENCE_FILE=''
CLAIM_PLAN=''
CLAIM_PRIVATE=''
CLAIM_RECEIPT=''
BACKUP_FILE=''
PERMIT_FILE=''
PLAN_DIGEST=''
TRANSACTION_KIND=''
ROLLBACK_ARMED=false
ENV_MUTATED=false
RECEIPT_WRITTEN=false
STAGING_RELEASE_DIR=''
STAGING_ENV_FILE=''
STAGING_DATABASE_PATH=''
STAGING_ENABLE_RECEIPT_FILE=''
RAW_EVIDENCE_FILE=''
HEALTH_EVIDENCE_FILE=''
SHADOW_HOOK_RECEIPT_FILE=''
DASHBOARD_EVIDENCE_FILE=''
STAGING_SMOKE_EVIDENCE_FILE=''
MONITOR_EVIDENCE_FILE=''
STAGING_OBSERVATION_EVIDENCE_FILE=''
STAGING_FLAG_EVIDENCE_FILE=''
OBSERVATION_LEDGER_BEFORE_FILE=''
OBSERVATION_LEDGER_AFTER_FILE=''
OBSERVATION_HEALTH_BEFORE_FILE=''
OBSERVATION_CLAIM_PLAN=''
OBSERVATION_RECEIPT_FILE=''
OBSERVATION_TEMP_DIR=''
STARTED_AT="$($NODE_BIN -e 'process.stdout.write(new Date().toISOString())')"

die() {
  printf 'remote chat capability transaction: %s\n' "$*" >&2
  exit 1
}

case "$ROLE" in
  staging)
    [ "$BASE_DIR" = '/home/dominguez/telegram-hub-bot-staging' ] \
      || die 'unexpected staging base'
    BACKEND_APP='nexus-hub-staging'
    CONTENT_APP='content-engine-staging'
    BACKEND_PORT=8201
    CONTENT_PORT=8101
    ;;
  production)
    [ "$BASE_DIR" = '/home/dominguez/telegram-hub-bot' ] \
      || die 'unexpected production base'
    BACKEND_APP='nexus-hub'
    CONTENT_APP='content-engine'
    BACKEND_PORT=8200
    CONTENT_PORT=8100
    ;;
  *) die 'role must be staging or production' ;;
esac
[[ "$RUNTIME_SHA" =~ ^[0-9a-f]{40}$ ]] || die 'runtime SHA is invalid'
[[ "$ARTIFACT_DIGEST" =~ ^[0-9a-f]{64}$ ]] || die 'artifact digest is invalid'
case "$COMMAND" in
  inspect)
    { [ "$#" -eq 3 ] || [ "$#" -eq 5 ]; } \
      || die 'inspect requires flag, value, transition reason, and only an optional routing window'
    FLAG="$1"
    DESIRED_VALUE="$2"
    TRANSITION_REASON="$3"
    if [ "$#" -eq 5 ]; then
      SINCE="$4"
      UNTIL="$5"
    fi
    case "$DESIRED_VALUE" in true|false) ;; *) die 'desired flag value is invalid' ;; esac
    case "$FLAG" in
      AI_ROUTING_MANIFEST_CLASSIFIER|AI_ROUTING_MANIFEST_ORCHESTRATOR|AI_ROUTING_MANIFEST_SHADOW|AI_ROUTING_MANIFEST_REGISTRY)
        if [ "$ROLE" = staging ] && [ "$DESIRED_VALUE" = true ]; then
          [ -n "$SINCE" ] && [ -n "$UNTIL" ] \
            || die 'staging routing enable inspect requires one explicit immutable window'
        elif [ -n "$SINCE" ] || [ -n "$UNTIL" ]; then
          die 'routing windows are accepted only for staging enables'
        fi
        ;;
      *)
        [ -z "$SINCE" ] && [ -z "$UNTIL" ] \
          || die 'routing windows are not accepted for this flag transition'
        ;;
    esac
    ;;
  apply|apply-secrets)
    [ "$#" -eq 2 ] || die 'apply requires transaction ID and acknowledged plan digest'
    TRANSACTION_ID="$1"
    ACK_PLAN="$2"
    [[ "$TRANSACTION_ID" =~ ^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{12}$ ]] \
      || die 'transaction ID is invalid'
    [[ "$ACK_PLAN" =~ ^sha256:[0-9a-f]{64}$ ]] || die 'acknowledged plan digest is invalid'
    PLAN_DIGEST="$ACK_PLAN"
    ;;
  inspect-observation)
    [ "$ROLE" = staging ] || die 'capability observation inspection is staging-only'
    [ "$#" -eq 1 ] || die 'inspect-observation requires one governed capability flag'
    FLAG="$1"
    ;;
  apply-observation)
    [ "$ROLE" = staging ] || die 'capability observation apply is staging-only'
    [ "$#" -eq 3 ] || die 'apply-observation requires flag, transaction ID, and acknowledged plan digest'
    FLAG="$1"
    TRANSACTION_ID="$2"
    ACK_PLAN="$3"
    [[ "$TRANSACTION_ID" =~ ^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{12}$ ]] \
      || die 'observation transaction ID is invalid'
    [[ "$ACK_PLAN" =~ ^sha256:[0-9a-f]{64}$ ]] \
      || die 'acknowledged observation plan digest is invalid'
    PLAN_DIGEST="$ACK_PLAN"
    ;;
  inspect-shadow-hook)
    [ "$ROLE" = staging ] || die 'shadow route hook inspection is staging-only'
    [ "$#" -eq 2 ] || die 'inspect-shadow-hook requires value and transition reason'
    DESIRED_VALUE="$1"
    TRANSITION_REASON="$2"
    case "$DESIRED_VALUE" in true|false) ;; *) die 'shadow route hook value is invalid' ;; esac
    case "$TRANSITION_REASON" in
      dedicated_eval_evidence_collection|operator_rollback|quality_regression|health_regression) ;;
      *) die 'shadow route hook transition reason is invalid' ;;
    esac
    ;;
  apply-shadow-hook)
    [ "$ROLE" = staging ] || die 'shadow route hook apply is staging-only'
    [ "$#" -eq 2 ] || die 'apply-shadow-hook requires transaction ID and acknowledged plan digest'
    TRANSACTION_ID="$1"
    ACK_PLAN="$2"
    [[ "$TRANSACTION_ID" =~ ^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{12}$ ]] \
      || die 'shadow route hook transaction ID is invalid'
    [[ "$ACK_PLAN" =~ ^sha256:[0-9a-f]{64}$ ]] \
      || die 'acknowledged shadow route hook plan digest is invalid'
    PLAN_DIGEST="$ACK_PLAN"
    ;;
  inspect-secrets)
    [ "$#" -eq 0 ] || die 'inspect-secrets accepts no additional arguments'
    ;;
  *) die 'command must be inspect, apply, inspect-observation, apply-observation, inspect-secrets, apply-secrets, inspect-shadow-hook, or apply-shadow-hook' ;;
esac
case "$COMMAND" in
  apply) TRANSACTION_KIND='flag' ;;
  apply-secrets) TRANSACTION_KIND='secret' ;;
  apply-observation) TRANSACTION_KIND='observation' ;;
  apply-shadow-hook) TRANSACTION_KIND='shadow_hook' ;;
esac

if [ "$COMMAND" = inspect-observation ] || [ "$COMMAND" = apply-observation ]; then
  case "$FLAG" in
    AI_ROUTING_MANIFEST_CLASSIFIER|AI_ROUTING_MANIFEST_ORCHESTRATOR|AI_ROUTING_MANIFEST_SHADOW|AI_ROUTING_MANIFEST_REGISTRY|AI_ROUTING_CLARIFY|AI_CLASSIFY_MANIFEST_PROMPT|AI_CROSS_SKILL_EXECUTION) ;;
    *) die 'observation flag is outside the governed capability allowlist' ;;
  esac
fi

[ -x "$PM2_BIN" ] || die 'PM2 is unavailable'
[ -x "$NODE_BIN" ] || die 'Node is unavailable'
[ -x "$TIMEOUT_BIN" ] || die 'timeout is unavailable'
if [ -n "$SINCE" ] || [ -n "$UNTIL" ]; then
  "$NODE_BIN" - "$SINCE" "$UNTIL" <<'NODE' \
    || die 'routing evidence window must be ordered canonical UTC timestamps'
const [since, until] = process.argv.slice(2);
const canonical = (value) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
if (!canonical(since) || !canonical(until) || Date.parse(until) < Date.parse(since)) {
  process.exit(1);
}
NODE
fi
[ -d "$BASE_DIR" ] && [ ! -L "$BASE_DIR" ] || die 'release base is unsafe'
[ -d "$BASE_DIR/releases" ] && [ ! -L "$BASE_DIR/releases" ] || die 'releases root is unsafe'
[ -L "$BASE_DIR/current" ] || die 'current selector is not a symlink'
ENV_FILE="$BASE_DIR/.env"
[ -f "$ENV_FILE" ] && [ ! -L "$ENV_FILE" ] || die '.env must be a regular non-symbolic file'
[ "$(stat -c '%U:%a' "$ENV_FILE")" = "$(id -un):600" ] || die '.env owner or mode is unsafe'
"$NODE_BIN" - "$ENV_FILE" <<'NODE' || die '.env must be a single-link ordinary file'
const fs = require('node:fs');
const stat = fs.lstatSync(process.argv[2]);
if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) process.exit(1);
NODE

install -d -m 700 "$(dirname "$USER_RELEASE_LOCK")" "$STATE_ROOT" \
  "$STATE_ROOT/claims" "$STATE_ROOT/observations"
[ -d "$STATE_ROOT" ] && [ ! -L "$STATE_ROOT" ] \
  && [ -d "$STATE_ROOT/claims" ] && [ ! -L "$STATE_ROOT/claims" ] \
  && [ -d "$STATE_ROOT/observations" ] && [ ! -L "$STATE_ROOT/observations" ] \
  || die 'capability state or claims directory is unsafe'
PERMIT_FILE="$STATE_ROOT/$ROLE.runtime-permit.json"
[ -f "$USER_RELEASE_LOCK" ] && [ ! -L "$USER_RELEASE_LOCK" ] || die 'shared release lock is unavailable'
[ "$(stat -c '%U:%a' "$USER_RELEASE_LOCK")" = "$(id -un):600" ] \
  || die 'shared release lock owner or mode is unsafe'
exec 9<>"$USER_RELEASE_LOCK"
flock -n 9 || die 'another release, flag, or Sonar-sensitive action is active'
[ -f "$ROOT_SONAR_LOCK" ] && [ ! -L "$ROOT_SONAR_LOCK" ] \
  || die 'root/Sonar mutex is unavailable'
[ "$(stat -c '%U:%G:%a' "$ROOT_SONAR_LOCK")" = 'root:dominguez:660' ] \
  || die 'root/Sonar mutex owner or mode is unsafe'
exec 8<>"$ROOT_SONAR_LOCK"
flock -n 8 || die 'a root maintenance or Sonar action is active'

resolve_current_release() {
  local releases_real current_real
  releases_real="$(cd -P "$BASE_DIR/releases" && pwd -P)"
  current_real="$(readlink -f "$BASE_DIR/current")"
  [ -n "$current_real" ] && [ -d "$current_real" ] && [ ! -L "$current_real" ] \
    || die 'current release cannot be resolved safely'
  [ "$(dirname "$current_real")" = "$releases_real" ] \
    || die 'current release is not one direct child of releases'
  [ -f "$current_real/.complete.json" ] && [ ! -L "$current_real/.complete.json" ] \
    || die 'current completion marker is missing or symbolic'
  "$NODE_BIN" - "$current_real/.complete.json" "$current_real" \
    "$RUNTIME_SHA" "$ARTIFACT_DIGEST" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const [file, release, sha, digest] = process.argv.slice(2);
const stat = fs.lstatSync(file);
const value = JSON.parse(fs.readFileSync(file, 'utf8'));
if (!stat.isFile() || stat.isSymbolicLink()
    || value?.schema !== 'nexus.release-bundle.v1'
    || value.runtimeSha !== sha || value.artifactDigest !== digest
    || path.basename(release) !== `${sha}-${digest.slice(0, 12)}`) process.exit(1);
NODE
  RELEASE_DIR="$current_real"
  HELPER="$RELEASE_DIR/scripts/lib/chat-capability-flag-transaction.mjs"
  [ -f "$HELPER" ] && [ ! -L "$HELPER" ] || die 'flag transaction helper is absent or unsafe'
  [ "$(readlink -f "${BASH_SOURCE[0]}")" \
      = "$RELEASE_DIR/scripts/remote-chat-capability-flag-transaction.sh" ] \
    || die 'transaction is not executing from the exact current release'
  "$NODE_BIN" "$RELEASE_DIR/scripts/release-artifact-manifest.mjs" \
    --verify-installed-source "$RELEASE_DIR" \
    --expected-runtime-sha "$RUNTIME_SHA" \
    --expected-digest "$ARTIFACT_DIGEST" >/dev/null
}

resolve_current_release

resolve_exact_staging_release() {
  if [ "$ROLE" = staging ]; then
    STAGING_RELEASE_DIR="$RELEASE_DIR"
    STAGING_ENV_FILE="$ENV_FILE"
  else
    [ -d "$STAGING_BASE_DIR" ] && [ ! -L "$STAGING_BASE_DIR" ] \
      || die 'staging release base is unsafe'
    [ -d "$STAGING_BASE_DIR/releases" ] && [ ! -L "$STAGING_BASE_DIR/releases" ] \
      || die 'staging releases root is unsafe'
    [ -L "$STAGING_BASE_DIR/current" ] || die 'staging current selector is not a symlink'
    local releases_real current_real expected_release
    releases_real="$(cd -P "$STAGING_BASE_DIR/releases" && pwd -P)"
    current_real="$(readlink -f "$STAGING_BASE_DIR/current")"
    expected_release="$releases_real/$RUNTIME_SHA-${ARTIFACT_DIGEST:0:12}"
    [ "$current_real" = "$expected_release" ] && [ -d "$current_real" ] \
      && [ ! -L "$current_real" ] \
      || die 'staging current release does not match the exact production candidate'
    [ "$(dirname "$current_real")" = "$releases_real" ] \
      || die 'staging current release is not one direct child of releases'
    [ -f "$current_real/.complete.json" ] && [ ! -L "$current_real/.complete.json" ] \
      || die 'staging completion marker is missing or symbolic'
    "$NODE_BIN" - "$current_real/.complete.json" "$current_real" \
      "$RUNTIME_SHA" "$ARTIFACT_DIGEST" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const [file, release, sha, digest] = process.argv.slice(2);
const stat = fs.lstatSync(file);
const value = JSON.parse(fs.readFileSync(file, 'utf8'));
if (!stat.isFile() || stat.isSymbolicLink()
    || value?.schema !== 'nexus.release-bundle.v1'
    || value.runtimeSha !== sha || value.artifactDigest !== digest
    || path.basename(release) !== `${sha}-${digest.slice(0, 12)}`) process.exit(1);
NODE
    "$NODE_BIN" "$RELEASE_DIR/scripts/release-artifact-manifest.mjs" \
      --verify-installed-source "$current_real" \
      --expected-runtime-sha "$RUNTIME_SHA" \
      --expected-digest "$ARTIFACT_DIGEST" >/dev/null
    STAGING_RELEASE_DIR="$current_real"
    STAGING_ENV_FILE="$STAGING_BASE_DIR/.env"
  fi
  [ -f "$STAGING_ENV_FILE" ] && [ ! -L "$STAGING_ENV_FILE" ] \
    || die 'staging .env must be a regular non-symbolic file'
  [ "$(stat -c '%U:%a' "$STAGING_ENV_FILE")" = "$(id -un):600" ] \
    || die 'staging .env owner or mode is unsafe'
  "$NODE_BIN" - "$STAGING_ENV_FILE" "$PRODUCTION_BASE_DIR/.env" <<'NODE' \
    || die 'staging and production environment files are not isolated ordinary files'
const fs = require('node:fs');
const [stagingFile, productionFile] = process.argv.slice(2);
const staging = fs.lstatSync(stagingFile);
if (!staging.isFile() || staging.isSymbolicLink() || staging.nlink !== 1) process.exit(1);
if (fs.existsSync(productionFile)) {
  const production = fs.lstatSync(productionFile);
  if (!production.isFile() || production.isSymbolicLink() || production.nlink !== 1
      || (production.dev === staging.dev && production.ino === staging.ino)) process.exit(1);
}
NODE
  [ -d "$STAGING_BASE_DIR/data" ] && [ ! -L "$STAGING_BASE_DIR/data" ] \
    || die 'staging data directory is unsafe'
  STAGING_DATABASE_PATH="$STAGING_BASE_DIR/data/bot.db"
  [ -f "$STAGING_DATABASE_PATH" ] && [ ! -L "$STAGING_DATABASE_PATH" ] \
    || die 'staging database must be a regular non-symbolic file'
  "$NODE_BIN" - "$STAGING_DATABASE_PATH" "$PRODUCTION_BASE_DIR/data/bot.db" <<'NODE' \
    || die 'staging and production databases are not isolated ordinary files'
const fs = require('node:fs');
const [stagingFile, productionFile] = process.argv.slice(2);
const staging = fs.lstatSync(stagingFile);
if (!staging.isFile() || staging.isSymbolicLink()) process.exit(1);
if (fs.existsSync(productionFile)) {
  const production = fs.lstatSync(productionFile);
  if (!production.isFile() || production.isSymbolicLink()
      || (production.dev === staging.dev && production.ino === staging.ino)) process.exit(1);
}
NODE
}

attest_dedicated_eval_identity() {
  [ "$ROLE" = staging ] || die 'dedicated evaluation identity attestation is staging-only'
  [ -n "$STAGING_DATABASE_PATH" ] || die 'staging database is unavailable for identity attestation'
  env -i \
    "HOME=$HOME" \
    "USER=$(id -un)" \
    "LOGNAME=$(id -un)" \
    'PATH=/usr/local/bin:/usr/bin:/bin' \
    "NODE_PATH=$STAGING_RELEASE_DIR/node_modules" \
    "$TIMEOUT_BIN" --foreground 30s \
    "$NODE_BIN" --env-file="$STAGING_ENV_FILE" - \
      "$STAGING_RELEASE_DIR" "$STAGING_DATABASE_PATH" <<'NODE'
const path = require('node:path');
const [release, databasePath] = process.argv.slice(2);
const dedicatedId = Number(String(process.env.CHAT_EVAL_DEDICATED_TENANT_ID ?? '').trim());
if (!Number.isSafeInteger(dedicatedId) || dedicatedId < 1) {
  throw new Error('dedicated evaluation tenant is unavailable');
}
const Database = require(path.join(release, 'node_modules/better-sqlite3'));
const database = new Database(databasePath, { readonly: true, fileMustExist: true });
try {
  database.pragma('query_only = ON');
  const rows = database.prepare('SELECT id, email FROM users WHERE id = ?').all(dedicatedId);
  const normalizedEmail = typeof rows[0]?.email === 'string'
    ? rows[0].email.trim().toLowerCase()
    : '';
  if (rows.length !== 1 || rows[0].id !== dedicatedId
      || !normalizedEmail.endsWith('.invalid')) {
    throw new Error('dedicated evaluation identity is not the synthetic staging principal');
  }
  process.stdout.write(String(dedicatedId));
} finally {
  database.close();
}
NODE
}

assert_shadow_route_hook_runtime_state() {
  local desired="$1"
  local dedicated_id="$2"
  [ -f "$RELEASE_DIR/dist/services/runtime-flags.js" ] \
    && [ ! -L "$RELEASE_DIR/dist/services/runtime-flags.js" ] \
    || die 'installed runtime flag reader is unavailable'
  env -i \
    "HOME=$HOME" \
    "USER=$(id -un)" \
    "LOGNAME=$(id -un)" \
    'PATH=/usr/local/bin:/usr/bin:/bin' \
    "NODE_PATH=$RELEASE_DIR/node_modules" \
    "NEXUS_RELEASE_ROLE=$ROLE" \
    "NEXUS_RELEASE_BASE_DIR=$BASE_DIR" \
    "NEXUS_RELEASE_SHA=$RUNTIME_SHA" \
    "NEXUS_RELEASE_ARTIFACT_SHA256=$ARTIFACT_DIGEST" \
     "$TIMEOUT_BIN" --foreground 30s \
     "$NODE_BIN" --env-file="$ENV_FILE" - \
       "$RELEASE_DIR/dist/services/runtime-flags.js" "$desired" "$dedicated_id" \
       "$BACKEND_PORT" "$ROLE" "$RUNTIME_SHA" "$ARTIFACT_DIGEST" <<'NODE'
const http = require('node:http');
const [modulePath, desiredRaw, dedicatedRaw, backendPortRaw, role, runtimeSha,
  artifactDigest] = process.argv.slice(2);
const flags = require(modulePath);
const desired = desiredRaw === 'true';
const dedicatedId = Number(dedicatedRaw);
if (!Number.isSafeInteger(dedicatedId) || dedicatedId < 1) process.exit(1);
const dedicatedScope = { userId: dedicatedId, tenantId: dedicatedId };
const unrelatedScope = { userId: dedicatedId + 1, tenantId: dedicatedId + 1 };
if (flags.isChatCoreV2ShadowRouteHookEnabled(process.env, dedicatedScope) !== desired
    || flags.isChatCoreV2ShadowRouteHookEnabled(process.env, unrelatedScope) !== false
    || flags.isChatCoreV2ShadowPlannerEnabled(process.env, dedicatedScope) !== false) {
  process.exit(1);
}
const request = () => new Promise((resolve, reject) => {
  const token = process.env.HEALTH_TOKEN;
  if (!token) return reject(new Error('health token unavailable'));
  const req = http.get({
    hostname: '127.0.0.1',
    port: Number(backendPortRaw),
    path: '/health/detailed',
    headers: { Authorization: `Bearer ${token}` },
    timeout: 5_000,
  }, (response) => {
    let body = '';
    response.setEncoding('utf8');
    response.on('data', (chunk) => { body += chunk; });
    response.on('end', () => resolve({ status: response.statusCode, body }));
  });
  req.on('timeout', () => req.destroy(new Error('health timeout')));
  req.on('error', reject);
});
request().then(({ status, body }) => {
  const health = JSON.parse(body);
  const attestation = health?.releaseAttestation;
  if (status !== 200 || health?.status !== 'healthy'
      || attestation?.schema !== 'nexus.chat-capability-release-attestation.v2'
      || attestation.role !== role || attestation.runtimeSha !== runtimeSha
      || attestation.artifactDigest !== artifactDigest
      || attestation.shadowRouteHookEffective?.global !== false
      || attestation.shadowRouteHookEffective?.dedicatedEval?.present !== true
      || attestation.shadowRouteHookEffective?.dedicatedEval?.user !== desired
      || attestation.shadowRouteHookEffective?.dedicatedEval?.tenant !== desired
      || attestation.shadowPlannerEffective?.global !== false
      || attestation.shadowPlannerEffective?.dedicatedEval?.present !== true
      || attestation.shadowPlannerEffective?.dedicatedEval?.user !== false
      || attestation.shadowPlannerEffective?.dedicatedEval?.tenant !== false) {
    process.exit(1);
  }
}).catch(() => process.exit(1));
NODE
}

collect_staging_http_json() {
  local route="$1"
  local auth_kind="$2"
  local output="$3"
  env -i \
    "HOME=$HOME" \
    "USER=$(id -un)" \
    "LOGNAME=$(id -un)" \
    'PATH=/usr/local/bin:/usr/bin:/bin' \
    "NODE_PATH=$STAGING_RELEASE_DIR/node_modules" \
    "DATABASE_PATH=$STAGING_DATABASE_PATH" \
    "DB_PATH=$STAGING_DATABASE_PATH" \
    "NEXUS_RELEASE_ROLE=staging" \
    "NEXUS_RELEASE_DIR=$STAGING_RELEASE_DIR" \
    "NEXUS_RELEASE_BASE_DIR=$STAGING_BASE_DIR" \
    "NEXUS_RELEASE_SHA=$RUNTIME_SHA" \
    "NEXUS_RELEASE_ARTIFACT_SHA256=$ARTIFACT_DIGEST" \
    "$TIMEOUT_BIN" --foreground 30s \
    "$NODE_BIN" --env-file="$STAGING_ENV_FILE" - \
      "$STAGING_BACKEND_PORT" "$route" "$auth_kind" \
      "$STAGING_RELEASE_DIR" "$STAGING_DATABASE_PATH" "$output" <<'NODE'
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const [portRaw, route, authKind, release, databasePath, output] = process.argv.slice(2);
const headers = {};
if (authKind === 'health') {
  if (!process.env.HEALTH_TOKEN) throw new Error('HEALTH_TOKEN is unavailable');
  headers.Authorization = `Bearer ${process.env.HEALTH_TOKEN}`;
} else if (authKind === 'portal') {
  if (process.env.PORTAL_REQUIRE_SESSION_AUTH === 'true') {
    const tool = path.join(release, 'dist/tools/portal-session-token.js');
    const stat = fs.lstatSync(tool);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error('installed portal session tool is unsafe');
    }
    const minted = spawnSync(process.execPath, [
      tool,
      '--actor', 'staging-smoke@nexushub.me',
      '--scope', 'admin',
      '--ttl-ms', '120000',
      '--json',
    ], {
      cwd: release,
      env: { ...process.env, DATABASE_PATH: databasePath, DB_PATH: databasePath },
      encoding: 'utf8',
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
    });
    if (minted.status !== 0) throw new Error('could not mint a scoped staging portal session');
    const token = JSON.parse(minted.stdout).token;
    if (typeof token !== 'string' || token.length < 16) {
      throw new Error('scoped staging portal session is invalid');
    }
    headers['x-portal-session'] = token;
  } else {
    const token = process.env.PORTAL_ADMIN_TOKEN || process.env.PORTAL_TOKEN;
    if (!token) throw new Error('staging portal admin token is unavailable');
    headers.Authorization = `Bearer ${token}`;
  }
} else {
  throw new Error('unsupported staging evidence auth mode');
}
const request = http.get({
  hostname: '127.0.0.1',
  port: Number(portRaw),
  path: route,
  headers,
  timeout: 5_000,
}, (response) => {
  let body = '';
  response.setEncoding('utf8');
  response.on('data', (chunk) => {
    body += chunk;
    if (body.length > 5 * 1024 * 1024) request.destroy(new Error('evidence response too large'));
  });
  response.on('end', () => {
    if (response.statusCode !== 200) throw new Error('staging evidence endpoint failed');
    JSON.parse(body);
    fs.writeFileSync(output, body, { mode: 0o600 });
  });
});
request.on('timeout', () => request.destroy(new Error('staging evidence request timed out')));
request.on('error', () => process.exit(1));
NODE
}

routing_surface() {
  case "$FLAG" in
    AI_ROUTING_MANIFEST_CLASSIFIER) printf '%s\n' classifierKeyword ;;
    AI_ROUTING_MANIFEST_ORCHESTRATOR) printf '%s\n' orchestratorPrimary ;;
    AI_ROUTING_MANIFEST_SHADOW) printf '%s\n' shadowRoute ;;
    AI_ROUTING_MANIFEST_REGISTRY) printf '%s\n' registrySubset ;;
    *) return 1 ;;
  esac
}

select_exact_shadow_hook_enable_receipt() {
  local output="$1"
  "$NODE_BIN" --input-type=module - "$HELPER" "$ENV_FILE" \
    "$STATE_ROOT/claims" "$STATE_ROOT/staging.shadow-hook.sequence" \
    "$output" "$RUNTIME_SHA" "$ARTIFACT_DIGEST" <<'NODE'
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const [helperPath,envFile,claimsRoot,sequenceFile,output,runtimeSha,
  artifactDigest] = process.argv.slice(2);
const helper = await import(pathToFileURL(helperPath).href);
const privateNode = (file, label, { maximumBytes = 1024 * 1024 } = {}) => {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
      || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600
      || stat.size < 1 || stat.size > maximumBytes) {
    throw new Error(`${label} is unsafe`);
  }
  return stat;
};
const claimsStat = fs.lstatSync(claimsRoot);
if (!claimsStat.isDirectory() || claimsStat.isSymbolicLink()
    || claimsStat.uid !== process.getuid() || (claimsStat.mode & 0o777) !== 0o700) {
  throw new Error('shadow-hook claim root is unsafe');
}
privateNode(sequenceFile, 'shadow-hook sequence', { maximumBytes: 32 });
const sequenceRaw = fs.readFileSync(sequenceFile, 'utf8').trim();
if (!/^[1-9][0-9]*$/u.test(sequenceRaw)) {
  throw new Error('shadow-hook sequence is invalid');
}
const sequence = Number(sequenceRaw);
if (!Number.isSafeInteger(sequence)) throw new Error('shadow-hook sequence is outside the safe range');
const receipts = [];
for (const name of fs.readdirSync(claimsRoot).sort()) {
  if (!name.endsWith('.shadow-hook-receipt.json')) continue;
  const match = name.match(
    /^staging-(\d{8}T\d{6}Z-[0-9a-f]{12})\.shadow-hook-receipt\.json$/u,
  );
  if (!match) throw new Error('shadow-hook receipt filename is invalid');
  const file = path.join(claimsRoot, name);
  privateNode(file, 'shadow-hook receipt');
  const raw = fs.readFileSync(file, 'utf8');
  const receipt = helper.validateShadowRouteHookReceipt(JSON.parse(raw));
  if (receipt.transactionId !== match[1]) {
    throw new Error('shadow-hook receipt filename and transaction differ');
  }
  if (receipt.planSequence === sequence) receipts.push({ raw, receipt });
}
if (receipts.length !== 1) {
  throw new Error('current durable shadow-hook sequence does not have one exact receipt');
}
const { raw, receipt } = receipts[0];
if (receipt.schema !== 'nexus.chat-shadow-route-hook-transaction.v1'
    || receipt.status !== 'passed' || receipt.role !== 'staging'
    || receipt.runtimeSha !== runtimeSha || receipt.artifactDigest !== artifactDigest
    || receipt.action !== 'enable' || receipt.desiredValue !== true
    || receipt.transitionReason !== 'dedicated_eval_evidence_collection'
    || receipt.dedicatedIdentityAttested !== true
    || receipt.recorderAfter?.user !== true || receipt.recorderAfter?.tenant !== true
    || Object.values(receipt.health ?? {}).some((value) => value !== 'passed')
    || receipt.rollback?.status !== 'not_required') {
  throw new Error('current shadow-hook receipt is not an exact passed enable for this release');
}
const state = helper.readShadowRouteHookCollectionState(fs.readFileSync(envFile, 'utf8'));
if (state.dedicatedTenantId !== receipt.dedicatedTenantId
    || state.recorder?.user !== true || state.recorder?.tenant !== true
    || Object.values(state.prerequisites?.hmacsPresent ?? {}).some((value) => value !== true)
    || state.prerequisites?.shadowPlannerEffectiveOff !== true
    || state.prerequisites?.otherRecorderScopesAbsent !== true) {
  throw new Error('live shadow-hook collection state differs from its enable receipt');
}
const outputStat = fs.lstatSync(output);
if (!outputStat.isFile() || outputStat.isSymbolicLink() || outputStat.nlink !== 1
    || outputStat.uid !== process.getuid() || (outputStat.mode & 0o777) !== 0o600
    || outputStat.size !== 0) {
  throw new Error('shadow-hook receipt output is unsafe');
}
fs.writeFileSync(output, raw, { encoding: 'utf8', mode: 0o600 });
const descriptor = fs.openSync(output, 'r+');
try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
NODE
}

collect_routing_divergence() {
  local output="$1"
  local surface versions divergence_version resolver_version
  surface="$(routing_surface)" || die 'routing evidence surface is unavailable'
  [ -f "$STAGING_RELEASE_DIR/scripts/routing-divergence-report.mjs" ] \
    && [ ! -L "$STAGING_RELEASE_DIR/scripts/routing-divergence-report.mjs" ] \
    || die 'installed routing divergence collector is unavailable'
  versions="$("$NODE_BIN" - \
    "$STAGING_RELEASE_DIR/dist/services/intent-resolution/divergence-shadow.js" \
    "$STAGING_RELEASE_DIR/dist/services/intent-resolution/intent-resolver.js" <<'NODE'
const fs = require('node:fs');
const [divergenceFile, resolverFile] = process.argv.slice(2);
const extract = (file, name) => {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${name} source is unsafe`);
  const source = fs.readFileSync(file, 'utf8');
  const pattern = new RegExp(`exports\\.${name} = '([A-Za-z0-9@._:-]{1,128})';`, 'gu');
  const matches = [...source.matchAll(pattern)];
  if (matches.length !== 1) throw new Error(`${name} is not uniquely available`);
  return matches[0][1];
};
process.stdout.write(`${extract(divergenceFile, 'ROUTING_DIVERGENCE_SHADOW_VERSION')} ${extract(resolverFile, 'INTENT_RESOLVER_VERSION')}\n`);
NODE
  )" || die 'could not derive exact installed routing telemetry versions'
  read -r divergence_version resolver_version <<< "$versions"
  (
    cd "$STAGING_RELEASE_DIR"
    env -i \
      "HOME=$HOME" \
      "USER=$(id -un)" \
      "LOGNAME=$(id -un)" \
      'PATH=/usr/local/bin:/usr/bin:/bin' \
      "NODE_PATH=$STAGING_RELEASE_DIR/node_modules" \
      "DATABASE_PATH=$STAGING_DATABASE_PATH" \
      "$TIMEOUT_BIN" --foreground 60s \
      "$NODE_BIN" scripts/routing-divergence-report.mjs \
        --db="$STAGING_DATABASE_PATH" \
        --surface="$surface" \
        --minimum-comparisons=200 \
        --since="$SINCE" \
        --until="$UNTIL" \
        --runtime-sha="$RUNTIME_SHA" \
        --artifact-digest="$ARTIFACT_DIGEST" \
        --environment=staging \
        --divergence-version="$divergence_version" \
        --resolver-version="$resolver_version" \
        --shadow-hook-receipt="$SHADOW_HOOK_RECEIPT_FILE" \
        --live-health="$HEALTH_EVIDENCE_FILE" \
        --gate --json > "$output"
  )
}

collect_action_skill_gate() {
  local output="$1"
  local generated_at
  generated_at="$($NODE_BIN -e 'process.stdout.write(new Date().toISOString())')"
  [ -f "$STAGING_RELEASE_DIR/dist/tools/routing-action-skill-accuracy.js" ] \
    && [ ! -L "$STAGING_RELEASE_DIR/dist/tools/routing-action-skill-accuracy.js" ] \
    || die 'installed cache-only action-skill collector is unavailable'
  (
    cd "$STAGING_RELEASE_DIR"
    env -i \
      "HOME=$HOME" \
      "USER=$(id -un)" \
      "LOGNAME=$(id -un)" \
      'PATH=/usr/local/bin:/usr/bin:/bin' \
      "NODE_PATH=$STAGING_RELEASE_DIR/node_modules" \
      "DATABASE_PATH=$STAGING_DATABASE_PATH" \
      "$TIMEOUT_BIN" --foreground 60s \
      "$NODE_BIN" --env-file="$STAGING_ENV_FILE" \
        dist/tools/routing-action-skill-accuracy.js \
        --db="$STAGING_DATABASE_PATH" \
        --runtime-sha="$RUNTIME_SHA" \
        --artifact-digest="$ARTIFACT_DIGEST" \
        --generated-at="$generated_at" \
        --gate > "$output"
  )
}

collect_cross_skill_preflight() {
  local output="$1"
  local generated_at
  generated_at="$($NODE_BIN -e 'process.stdout.write(new Date().toISOString())')"
  [ -f "$STAGING_RELEASE_DIR/dist/tools/chat-capability-cross-skill-preflight.js" ] \
    && [ ! -L "$STAGING_RELEASE_DIR/dist/tools/chat-capability-cross-skill-preflight.js" ] \
    || die 'installed cross-skill preflight collector is unavailable'
  (
    cd "$STAGING_RELEASE_DIR"
    env -i \
      "HOME=$HOME" \
      "USER=$(id -un)" \
      "LOGNAME=$(id -un)" \
      'PATH=/usr/local/bin:/usr/bin:/bin' \
      "NODE_PATH=$STAGING_RELEASE_DIR/node_modules" \
      "$TIMEOUT_BIN" --foreground 60s \
      "$NODE_BIN" --env-file="$STAGING_ENV_FILE" \
        dist/tools/chat-capability-cross-skill-preflight.js \
        --runtime-sha="$RUNTIME_SHA" \
        --artifact-digest="$ARTIFACT_DIGEST" \
        --generated-at="$generated_at" \
        --json > "$output"
  )
}

collect_cross_skill_smoke() {
  local output="$1"
  [ -f "$STAGING_RELEASE_DIR/scripts/training-cross-skill-staging-smoke.sh" ] \
    && [ ! -L "$STAGING_RELEASE_DIR/scripts/training-cross-skill-staging-smoke.sh" ] \
    || die 'installed cross-skill staging smoke is unavailable'
  env -i \
    "HOME=$HOME" \
    "USER=$(id -un)" \
    "LOGNAME=$(id -un)" \
    'PATH=/usr/local/bin:/usr/bin:/bin' \
    "NODE_PATH=$STAGING_RELEASE_DIR/node_modules" \
    "$TIMEOUT_BIN" --foreground 180s \
    "$NODE_BIN" --env-file="$STAGING_ENV_FILE" - \
      "$STAGING_RELEASE_DIR" "$STAGING_BASE_DIR" "$STAGING_DATABASE_PATH" \
      "$RUNTIME_SHA" "$ARTIFACT_DIGEST" "$output" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const [release, base, databasePath, runtimeSha, artifactDigest, output] = process.argv.slice(2);
const userId = Number(process.env.TRAINING_CROSS_SKILL_STAGING_USER_ID);
const dedicatedTenantId = Number(process.env.CHAT_EVAL_DEDICATED_TENANT_ID);
if (!Number.isSafeInteger(userId) || userId < 1
    || !Number.isSafeInteger(dedicatedTenantId) || dedicatedTenantId < 1
    || userId !== dedicatedTenantId) {
  throw new Error('dedicated staging cross-skill user is unavailable');
}
const Database = require(path.join(release, 'node_modules/better-sqlite3'));
const database = new Database(databasePath, { readonly: true, fileMustExist: true });
try {
  database.pragma('query_only = ON');
  const rows = database.prepare('SELECT id, email FROM users WHERE id = ?').all(userId);
  const normalizedEmail = typeof rows[0]?.email === 'string'
    ? rows[0].email.trim().toLowerCase()
    : '';
  if (rows.length !== 1 || rows[0].id !== userId || !normalizedEmail.endsWith('.invalid')) {
    throw new Error('cross-skill user is not the provisioned dedicated evaluation tenant');
  }
} finally {
  database.close();
}
const script = path.join(release, 'scripts/training-cross-skill-staging-smoke.sh');
const result = spawnSync(script, ['--json'], {
  cwd: release,
  env: {
    ...process.env,
    STAGING: 'true',
    TRAINING_CROSS_SKILL_STAGING_SMOKE: '1',
    TRAINING_CROSS_SKILL_STAGING_USER_ID: String(userId),
    TRAINING_CROSS_SKILL_DEDICATED_IDENTITY_ATTESTED: '1',
    DATABASE_PATH: databasePath,
    DB_PATH: databasePath,
    NEXUS_RELEASE_ROLE: 'staging',
    NEXUS_RELEASE_DIR: release,
    NEXUS_RELEASE_BASE_DIR: base,
    NEXUS_RELEASE_SHA: runtimeSha,
    NEXUS_RELEASE_ARTIFACT_SHA256: artifactDigest,
    AI_ROUTING_MANIFEST_KILL: 'false',
    AI_CROSS_SKILL_EXECUTION: 'true',
  },
  encoding: 'utf8',
  timeout: 170_000,
  maxBuffer: 5 * 1024 * 1024,
});
if (result.status !== 0) throw new Error('cross-skill staging smoke did not pass');
JSON.parse(result.stdout);
fs.writeFileSync(output, result.stdout, { mode: 0o600 });
NODE
}

select_mature_exact_staging_enable_receipt() {
  local output="$1"
  "$NODE_BIN" --input-type=module - "$HELPER" "$ENV_FILE" \
    "$STATE_ROOT/claims" "$STATE_ROOT/staging.flag.sequence" \
    "$output" "$FLAG" "$RUNTIME_SHA" \
    "$ARTIFACT_DIGEST" <<'NODE'
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const [helperPath,envFile,claimsRoot,flagSequenceFile,output,flag,runtimeSha,
  artifactDigest] = process.argv.slice(2);
const helper = await import(pathToFileURL(helperPath).href);
const claimsStat = fs.lstatSync(claimsRoot);
if (!claimsStat.isDirectory() || claimsStat.isSymbolicLink()) {
  throw new Error('staging flag claim root is unsafe');
}
const sequenceStat = fs.lstatSync(flagSequenceFile);
const sequenceRaw = fs.readFileSync(flagSequenceFile, 'utf8').trim();
if (!sequenceStat.isFile() || sequenceStat.isSymbolicLink() || sequenceStat.nlink !== 1
    || sequenceStat.uid !== process.getuid() || (sequenceStat.mode & 0o777) !== 0o600
    || !/^[1-9][0-9]*$/u.test(sequenceRaw)) {
  throw new Error('durable staging flag sequence is unsafe or invalid');
}
const currentFlagSequence = Number(sequenceRaw);
if (!Number.isSafeInteger(currentFlagSequence)) {
  throw new Error('durable staging flag sequence is outside the safe range');
}
const configured = helper.readCapabilityFlagState(fs.readFileSync(envFile, 'utf8'));
const expected = { ...configured, [flag]: true };
const sameState = (value) => Object.keys(expected).length === Object.keys(value ?? {}).length
  && Object.entries(expected).every(([key, expectedValue]) => value[key] === expectedValue);
const candidates = [];
for (const name of fs.readdirSync(claimsRoot).sort()) {
  const match = name.match(/^staging-(\d{8}T\d{6}Z-[0-9a-f]{12})\.flag-receipt\.json$/u);
  if (!match) continue;
  const file = path.join(claimsRoot, name);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
      || (stat.mode & 0o777) !== 0o600 || stat.uid !== process.getuid()) {
    throw new Error('staging flag claim receipt is unsafe');
  }
  const raw = fs.readFileSync(file, 'utf8');
  const parsed = JSON.parse(raw);
  if (parsed?.role !== 'staging' || parsed.runtimeSha !== runtimeSha
      || parsed.artifactDigest !== artifactDigest || parsed.flag !== flag) continue;
  const receipt = helper.validateCapabilityFlagReceipt(parsed);
  if (receipt.transactionId !== match[1]) {
    throw new Error('staging flag claim filename does not match its receipt');
  }
  if (receipt.status === 'passed' && receipt.desiredValue === true
      && sameState(receipt.configuredAfter) && sameState(receipt.effectiveAfter)) {
    candidates.push({ raw, receipt });
  }
}
if (candidates.length === 0) throw new Error('no exact passed staging ON flag claim receipt exists');
const latestSequence = Math.max(...candidates.map(({ receipt }) => receipt.planSequence));
const latest = candidates.filter(({ receipt }) => receipt.planSequence === latestSequence);
if (latest.length !== 1) throw new Error('latest exact passed staging ON flag claim receipt is ambiguous');
if (latest[0].receipt.planSequence !== currentFlagSequence) {
  throw new Error(
    'latest passed staging ON receipt does not match the current consumed flag sequence',
  );
}
// One extra second absorbs the smoke producer's timestamp boundary and keeps
// the canonical `startedAt >= enableCompletedAt + 300s` comparison fail closed.
if (Date.now() - Date.parse(latest[0].receipt.completedAt) < 301_000) {
  throw new Error('staging enable is younger than the required five-minute observation interval; retry inspect later');
}
fs.writeFileSync(output, latest[0].raw, { mode: 0o600 });
NODE
}

collect_chat_quality_monitor() {
  local output="$1"
  local enable_receipt_file="$2"
  local alert_window_started_at
  alert_window_started_at="$("$NODE_BIN" --input-type=module - \
    "$HELPER" "$enable_receipt_file" <<'NODE'
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
const [helperPath, receiptFile] = process.argv.slice(2);
const helper = await import(pathToFileURL(helperPath).href);
const stat = fs.lstatSync(receiptFile);
if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) process.exit(1);
const receipt = helper.validateCapabilityFlagReceipt(
  JSON.parse(fs.readFileSync(receiptFile, 'utf8')),
);
if (receipt.status !== 'passed' || receipt.role !== 'staging') process.exit(1);
process.stdout.write(receipt.completedAt);
NODE
  )" || die 'cannot bind the quality monitor alert window to the staging enable receipt'
  [ -f "$STAGING_RELEASE_DIR/dist/services/chat-quality-regression-monitor.js" ] \
    && [ ! -L "$STAGING_RELEASE_DIR/dist/services/chat-quality-regression-monitor.js" ] \
    || die 'installed chat-quality regression monitor is unavailable'
  (
    cd "$STAGING_RELEASE_DIR"
    env -i \
      "HOME=$HOME" \
      "USER=$(id -un)" \
      "LOGNAME=$(id -un)" \
      'PATH=/usr/local/bin:/usr/bin:/bin' \
      "NODE_PATH=$STAGING_RELEASE_DIR/node_modules" \
      "DATABASE_PATH=$STAGING_DATABASE_PATH" \
      "DB_PATH=$STAGING_DATABASE_PATH" \
      "NEXUS_RELEASE_ROLE=staging" \
      "NEXUS_RELEASE_DIR=$STAGING_RELEASE_DIR" \
      "NEXUS_RELEASE_BASE_DIR=$STAGING_BASE_DIR" \
      "NEXUS_RELEASE_SHA=$RUNTIME_SHA" \
      "NEXUS_RELEASE_ARTIFACT_SHA256=$ARTIFACT_DIGEST" \
      "$TIMEOUT_BIN" --foreground 60s \
      "$NODE_BIN" --env-file="$STAGING_ENV_FILE" - \
        "$STAGING_RELEASE_DIR" "$STAGING_DATABASE_PATH" "$RUNTIME_SHA" \
        "$ARTIFACT_DIGEST" "$output" "$alert_window_started_at" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const [release,databasePath,runtimeSha,artifactDigest,output,alertWindowStartedAt]
  = process.argv.slice(2);
if (process.env.CHAT_QUALITY_REGRESSION_MONITOR_DISABLED === '1') {
  throw new Error('chat-quality regression monitor is disabled');
}
const Database = require(path.join(release, 'node_modules/better-sqlite3'));
const monitor = require(path.join(release, 'dist/services/chat-quality-regression-monitor.js'));
const database = new Database(databasePath, { readonly: true, fileMustExist: true });
database.pragma('query_only = ON');
const startedAt = new Date().toISOString();
const main = async () => {
  try {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(alertWindowStartedAt)
        || new Date(Date.parse(alertWindowStartedAt)).toISOString() !== alertWindowStartedAt) {
      throw new Error('durable alert window timestamp is invalid');
    }
    const monitoredAlertSources = [
      'chat_quality_regression_monitor',
      'chat_v2_retirement_monitor',
    ];
    const table = database.prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'operator_alerts'",
    ).get();
    if (table?.present !== 1) throw new Error('durable operator alert table is unavailable');
    const columns = new Set(database.prepare('PRAGMA table_info(operator_alerts)').all()
      .map((row) => row.name));
    for (const column of ['source', 'created_at', 'last_seen_at', 'status']) {
      if (!columns.has(column)) throw new Error('durable operator alert schema is incomplete');
    }
    // SQLite datetime('now') rows have whole-second precision. Floor the query
    // boundary so an alert in the enable completion second cannot evade proof.
    const alertWindowFloor = new Date(
      Math.floor(Date.parse(alertWindowStartedAt) / 1000) * 1000,
    ).toISOString();
    const readDurableAlertState = () => {
      const malformedTimestampRowCount = Number(database.prepare(`
        SELECT COUNT(*) AS count
        FROM operator_alerts
        WHERE source IN (?, ?)
          AND (julianday(created_at) IS NULL OR julianday(last_seen_at) IS NULL)
      `).get(...monitoredAlertSources)?.count ?? -1);
      if (!Number.isSafeInteger(malformedTimestampRowCount)
          || malformedTimestampRowCount !== 0) {
        throw new Error('durable operator alert timestamps are malformed');
      }
      const activityRowCount = Number(database.prepare(`
        SELECT COUNT(*) AS count
        FROM operator_alerts
        WHERE source IN (?, ?)
          AND (
            julianday(created_at) >= julianday(?)
            OR julianday(last_seen_at) >= julianday(?)
          )
      `).get(
        ...monitoredAlertSources,
        alertWindowFloor,
        alertWindowFloor,
      )?.count ?? -1);
      if (!Number.isSafeInteger(activityRowCount) || activityRowCount < 0) {
        throw new Error('durable operator alert activity count is invalid');
      }
      return { activityRowCount };
    };
    const initialAlertState = readDurableAlertState();
    const result = await monitor.runChatQualityRegressionMonitor({
      db: database,
      now: new Date(),
      recordAlert: () => ({ ok: false, reason: 'read_only_capability_observation' }),
    });
    // Re-read after the asynchronous monitor so an all-status alert created or
    // updated while it ran cannot evade the evidence written below.
    const finalAlertState = readDurableAlertState();
    const durableAlertActivityRowCount = Math.max(
      initialAlertState.activityRowCount,
      finalAlertState.activityRowCount,
    );
    const completedAt = new Date().toISOString();
    const alertCount = result.readinessHealthAlertCount
      + result.readinessRegressionAlertCount
      + result.behaviorRegressionAlertCount
      + result.fallbackRegressionAlertCount;
    const verdict = result.readinessAvailable === true
      && result.readinessArtifactHealthy === true
      && result.readinessUnavailableReason === null
      && result.recordedAlertCount === 0 && alertCount === 0
      && durableAlertActivityRowCount === 0
      ? 'passed' : 'failed';
    const report = {
      schema: 'nexus.chat-capability-quality-monitor.v1',
      runtimeSha,
      artifactDigest,
      startedAt,
      completedAt,
      ...result,
      monitoredAlertSources,
      alertWindowStartedAt,
      durableAlertActivityRowCount,
      verdict,
    };
    fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    if (verdict !== 'passed') process.exitCode = 1;
  } finally {
    database.close();
  }
};
main().catch((error) => {
  try { database.close(); } catch {}
  process.stderr.write(`chat-quality monitor observation failed: ${error.message}\n`);
  process.exit(1);
});
NODE
  )
}

select_existing_canonical_staging_smoke() {
  local smoke_root expected_production_sequence
  local -a selected
  smoke_root="$STAGING_BASE_DIR/.local/release/smoke-evidence"
  [ -d "$smoke_root" ] && [ ! -L "$STAGING_BASE_DIR/.local" ] \
    && [ ! -L "$STAGING_BASE_DIR/.local/release" ] && [ ! -L "$smoke_root" ] \
    || die 'canonical staging smoke evidence root is unavailable or unsafe'
  expected_production_sequence="${1:-$(read_expected_production_flag_plan_sequence)}"
  mapfile -t selected < <("$NODE_BIN" --input-type=module - \
    "$HELPER" "$STAGING_ENABLE_RECEIPT_FILE" "$smoke_root" \
    "$STATE_ROOT/observations" "$STATE_ROOT/staging.observation.sequence" \
    "$STAGING_ENV_FILE" "$FLAG" \
    "$RUNTIME_SHA" "$ARTIFACT_DIGEST" "$expected_production_sequence" <<'NODE'
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
const [helperPath,enableReceiptFile,smokeRoot,observationsRoot,observationSequenceFile,
  stagingEnvFile,flag,runtimeSha,artifactDigest,expectedProductionSequenceRaw]
  = process.argv.slice(2);
const helper = await import(pathToFileURL(helperPath).href);
const safeFile = (file, label) => {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
      || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600) {
    throw new Error(`${label} is unsafe`);
  }
  return fs.readFileSync(file, 'utf8');
};
const enableReceiptRaw = safeFile(enableReceiptFile, 'preselected staging enable receipt');
const enableReceipt = helper.validateCapabilityFlagReceipt(JSON.parse(enableReceiptRaw));
if (enableReceipt.flag !== flag || enableReceipt.runtimeSha !== runtimeSha
    || enableReceipt.artifactDigest !== artifactDigest || enableReceipt.status !== 'passed'
    || enableReceipt.desiredValue !== true) {
  throw new Error('preselected staging enable receipt does not bind the production target');
}
const expectedProductionSequence = Number(expectedProductionSequenceRaw);
if (!Number.isSafeInteger(expectedProductionSequence) || expectedProductionSequence < 1) {
  throw new Error('expected production flag sequence is invalid');
}
const stagingConfigured = helper.readCapabilityFlagState(
  safeFile(stagingEnvFile, 'staging environment'),
);
const rootStat = fs.lstatSync(observationsRoot);
if (!rootStat.isDirectory() || rootStat.isSymbolicLink()
    || rootStat.uid !== process.getuid() || (rootStat.mode & 0o777) !== 0o700) {
  throw new Error('observation receipt root is unsafe');
}
const observationSequenceRaw = safeFile(
  observationSequenceFile,
  'durable staging observation sequence',
).trim();
if (!/^[1-9][0-9]*$/u.test(observationSequenceRaw)) {
  throw new Error('durable staging observation sequence is invalid');
}
const currentObservationSequence = Number(observationSequenceRaw);
if (!Number.isSafeInteger(currentObservationSequence)) {
  throw new Error('durable staging observation sequence is outside the safe range');
}
let latestConsumedClaimSequence = 0;
for (const name of fs.readdirSync(observationsRoot).sort()) {
  if (!/^staging-\d{8}T\d{6}Z-[0-9a-f]{12}\.observation-plan\.json$/u.test(name)) {
    continue;
  }
  const claim = helper.validateCapabilityObservationPlan(JSON.parse(safeFile(
    path.join(observationsRoot, name),
    'consumed staging observation claim',
  )));
  latestConsumedClaimSequence = Math.max(
    latestConsumedClaimSequence,
    claim.observationSequence,
  );
}
if (latestConsumedClaimSequence > currentObservationSequence) {
  throw new Error('a later consumed observation claim has no passed receipt');
}
if (latestConsumedClaimSequence !== currentObservationSequence) {
  throw new Error('durable staging observation sequence has no exact consumed claim');
}
const candidates = [];
for (const name of fs.readdirSync(smokeRoot).sort()) {
  const match = name.match(
    /^chat-capability-(\d{8}T\d{6}Z-[0-9a-f]{12})-staging-observation\.json$/u,
  );
  if (!match) continue;
  const transactionId = match[1];
  const sidecar = path.join(smokeRoot, name);
  const smoke = path.join(
    smokeRoot,
    `chat-capability-${transactionId}-staging-smoke.json`,
  );
  const flagEvidence = path.join(
    smokeRoot,
    `chat-capability-${transactionId}-staging-flag-evidence.json`,
  );
  const stateReceipt = path.join(
    observationsRoot,
    `staging-${transactionId}.observation-receipt.json`,
  );
  if (!fs.existsSync(smoke) || !fs.existsSync(stateReceipt)) continue;
  const observationRaw = safeFile(sidecar, 'observation evidence sidecar');
  if (safeFile(stateReceipt, 'observation state receipt') !== observationRaw) {
    throw new Error('observation sidecar and durable state receipt bytes differ');
  }
  const observation = helper.validateCapabilityObservationReceipt(
    JSON.parse(observationRaw),
  );
  if (observation.transactionId !== transactionId
      || observation.flag !== flag || observation.runtimeSha !== runtimeSha
      || observation.artifactDigest !== artifactDigest
      || observation.enableTransactionId !== enableReceipt.transactionId
      || observation.enableReceiptSha256
        !== createHash('sha256').update(enableReceiptRaw).digest('hex')
      || observation.expectedProductionPlanSequence !== expectedProductionSequence
      || Date.now() > Date.parse(observation.expiresAt)
      || JSON.stringify(observation.configuredAfter) !== JSON.stringify(stagingConfigured)
      || JSON.stringify(observation.effectiveAfter) !== JSON.stringify(stagingConfigured)
      || observation.masterKillAfter !== false) {
    continue;
  }
  const smokeRaw = safeFile(smoke, 'canonical staging smoke receipt');
  if (createHash('sha256').update(smokeRaw).digest('hex') !== observation.smokeSha256) {
    throw new Error('observation sidecar does not bind its exact canonical smoke sibling');
  }
  const requiresFlagRaw = [
    'AI_CLASSIFY_MANIFEST_PROMPT',
    'AI_CROSS_SKILL_EXECUTION',
  ].includes(flag);
  let selectedFlagEvidence = null;
  if (requiresFlagRaw) {
    const flagRaw = safeFile(flagEvidence, 'flag-specific staging observation evidence');
    if (createHash('sha256').update(flagRaw).digest('hex')
        !== observation.flagSpecificEvidence?.evidenceSha256) {
      throw new Error('observation sidecar does not bind its flag-specific raw evidence');
    }
    selectedFlagEvidence = flagEvidence;
  } else if (fs.existsSync(flagEvidence)) {
    throw new Error('unexpected flag-specific raw evidence exists for this observation');
  }
  candidates.push({ observation, sidecar, smoke, flagEvidence: selectedFlagEvidence });
}
if (candidates.length === 0) {
  throw new Error('no exact unexpired paired staging observation evidence exists');
}
const latestSequence = Math.max(...candidates.map(({ observation }) => (
  observation.observationSequence
)));
const latest = candidates.filter(({ observation }) => (
  observation.observationSequence === latestSequence
));
if (latest.length !== 1) {
  throw new Error('latest exact staging observation evidence is ambiguous');
}
if (latest[0].observation.observationSequence !== currentObservationSequence) {
  throw new Error(
    'latest passed observation does not match the current consumed observation sequence',
  );
}
process.stdout.write(`${latest[0].smoke}\n${latest[0].sidecar}\n`);
if (latest[0].flagEvidence !== null) process.stdout.write(`${latest[0].flagEvidence}\n`);
NODE
  ) || die 'owner-authorized exact canonical staging smoke requires paired observation evidence'
  { [ "${#selected[@]}" -eq 2 ] || [ "${#selected[@]}" -eq 3 ]; } \
    || die 'staging observation selector returned an invalid evidence pair'
  STAGING_SMOKE_EVIDENCE_FILE="${selected[0]}"
  STAGING_OBSERVATION_EVIDENCE_FILE="${selected[1]}"
  STAGING_FLAG_EVIDENCE_FILE="${selected[2]:-}"
  [[ "$STAGING_SMOKE_EVIDENCE_FILE" == "$smoke_root/"* ]] \
    && [[ "$STAGING_OBSERVATION_EVIDENCE_FILE" == "$smoke_root/"* ]] \
    || die 'selected staging observation evidence escaped its root'
  [ -z "$STAGING_FLAG_EVIDENCE_FILE" ] \
    || [[ "$STAGING_FLAG_EVIDENCE_FILE" == "$smoke_root/"* ]] \
    || die 'selected flag-specific staging evidence escaped its root'
}
collect_production_staging_prerequisite_sources() {
  STAGING_ENABLE_RECEIPT_FILE="$(mktemp "$STATE_ROOT/.staging-enable-receipt.XXXXXX")"
  select_mature_exact_staging_enable_receipt "$STAGING_ENABLE_RECEIPT_FILE"
  select_existing_canonical_staging_smoke
}

collect_global_provider_ledger_snapshot() {
  local output="$1"
  env -i \
    "HOME=$HOME" \
    "USER=$(id -un)" \
    "LOGNAME=$(id -un)" \
    'PATH=/usr/local/bin:/usr/bin:/bin' \
    "NODE_PATH=$STAGING_RELEASE_DIR/node_modules" \
    "$TIMEOUT_BIN" --foreground 30s \
    "$NODE_BIN" - "$STAGING_RELEASE_DIR" "$STAGING_DATABASE_PATH" "$output" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const [release,databasePath,output] = process.argv.slice(2);
const Database = require(path.join(release, 'node_modules/better-sqlite3'));
const database = new Database(databasePath, { readonly: true, fileMustExist: true });
try {
  database.pragma('query_only = ON');
  const snapshot = (table, costColumn, costKey) => {
    const exists = database.prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?",
    ).get(table)?.present === 1;
    if (!exists) throw new Error(`required global ledger table is unavailable: ${table}`);
    const columns = new Set(database.prepare(`PRAGMA table_info(${table})`).all()
      .map((row) => row.name));
    for (const column of ['id', costColumn]) {
      if (!columns.has(column)) throw new Error(`required global ledger column is unavailable: ${table}.${column}`);
    }
    const row = database.prepare(`
      SELECT COUNT(*) AS row_count, MAX(id) AS max_id,
             COALESCE(SUM(${costColumn}), 0) AS total_cost
      FROM ${table}
    `).get();
    const rowCount = Number(row?.row_count ?? -1);
    const maxId = row?.max_id === null ? null : Number(row?.max_id);
    const totalCost = Number(row?.total_cost ?? Number.NaN);
    if (!Number.isSafeInteger(rowCount) || rowCount < 0
        || (maxId !== null && (!Number.isSafeInteger(maxId) || maxId < 1))
        || (rowCount === 0) !== (maxId === null)
        || !Number.isFinite(totalCost) || totalCost < 0) {
      throw new Error(`global ledger snapshot is invalid: ${table}`);
    }
    return { tablePresent: true, rowCount, maxId, [costKey]: totalCost };
  };
  const report = {
    schema: 'nexus.chat-capability-global-provider-ledger-snapshot.v1',
    scope: 'global',
    observedAt: new Date().toISOString(),
    apiUsage: snapshot('api_usage', 'cost_usd', 'totalCostUsd'),
    hardCeilingReservations: snapshot(
      'ai_provider_attempt_reservations',
      'reserved_cost_usd',
      'totalReservedCostUsd',
    ),
  };
  const descriptor = fs.openSync(output, 'wx', 0o600);
  try { fs.writeFileSync(descriptor, `${JSON.stringify(report, null, 2)}\n`); fs.fsyncSync(descriptor); }
  finally { fs.closeSync(descriptor); }
} finally {
  database.close();
}
NODE
}

read_expected_production_flag_plan_sequence() {
  "$NODE_BIN" - "$STATE_ROOT/production.flag.sequence" \
    "$STATE_ROOT/production.flag.pending.json" <<'NODE'
const fs = require('node:fs');
const [sequenceFile,pendingFile] = process.argv.slice(2);
if (fs.existsSync(pendingFile)) throw new Error('an unconsumed production flag plan blocks observation');
let sequence = 0;
if (fs.existsSync(sequenceFile)) {
  const stat = fs.lstatSync(sequenceFile);
  const raw = fs.readFileSync(sequenceFile, 'utf8').trim();
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
      || !/^(?:0|[1-9][0-9]*)$/u.test(raw)) {
    throw new Error('production flag sequence is unsafe or invalid');
  }
  sequence = Number(raw);
}
if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence >= Number.MAX_SAFE_INTEGER) {
  throw new Error('production flag sequence cannot advance');
}
process.stdout.write(String(sequence + 1));
NODE
}

read_observation_sequence() {
  "$NODE_BIN" - "$SEQUENCE_FILE" <<'NODE'
const fs = require('node:fs');
const file = process.argv[2];
if (!fs.existsSync(file)) {
  process.stdout.write('0');
  process.exit(0);
}
const stat = fs.lstatSync(file);
const raw = fs.readFileSync(file, 'utf8').trim();
if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
    || (stat.mode & 0o777) !== 0o600 || stat.uid !== process.getuid()
    || !/^(?:0|[1-9][0-9]*)$/u.test(raw)) {
  throw new Error('observation sequence is unsafe or invalid');
}
const sequence = Number(raw);
if (!Number.isSafeInteger(sequence) || sequence < 0
    || sequence >= Number.MAX_SAFE_INTEGER) {
  throw new Error('observation sequence cannot advance');
}
process.stdout.write(String(sequence));
NODE
}

build_current_observation_plan() {
  local output="$1"
  local enable_receipt_file="$2"
  local health_file="$3"
  local generated_at="$4"
  local previous_sequence="$5"
  local expected_production_sequence="$6"
  "$NODE_BIN" --input-type=module - "$HELPER" "$ENV_FILE" \
    "$enable_receipt_file" "$health_file" "$STAGING_RELEASE_DIR" \
    "$FLAG" "$RUNTIME_SHA" "$ARTIFACT_DIGEST" "$generated_at" \
    "$previous_sequence" "$expected_production_sequence" "$output" <<'NODE'
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const [helperPath,envFile,receiptFile,healthFile,release,flag,runtimeSha,
  artifactDigest,generatedAt,previousSequenceRaw,expectedProductionSequenceRaw,
  output] = process.argv.slice(2);
const helper = await import(pathToFileURL(helperPath).href);
const health = JSON.parse(fs.readFileSync(healthFile, 'utf8'));
const attestation = health?.releaseAttestation;
if (health?.status !== 'healthy' || health?.database !== 'connected'
    || health?.databaseProbe?.status !== 'connected' || !Number.isSafeInteger(health?.uptime)
    || health.uptime < 300 || attestation?.schema !== 'nexus.chat-capability-release-attestation.v2'
    || attestation.role !== 'staging' || attestation.runtimeSha !== runtimeSha
    || attestation.artifactDigest !== artifactDigest
    || attestation.capabilityRuntimeGuard?.status !== 'clear'
    || attestation.capabilityRuntimeGuard?.transactionId !== null
    || attestation.capabilityRuntimeGuard?.planDigest !== null) {
  throw new Error('observation live staging health or runtime guard is not exact and stable');
}
const masterKill = attestation.capabilityFlags?.masterKill;
if (typeof masterKill !== 'boolean' || masterKill) {
  throw new Error('observation requires the master kill off');
}
const configured = { ...attestation.capabilityFlags.configured, AI_ROUTING_MANIFEST_KILL: masterKill };
const effective = { ...attestation.capabilityFlags.effective, AI_ROUTING_MANIFEST_KILL: masterKill };
const envSource = fs.readFileSync(envFile, 'utf8');
const envConfigured = helper.readCapabilityFlagState(envSource);
if (JSON.stringify(envConfigured) !== JSON.stringify(configured)) {
  throw new Error('observation environment and live configured prefix differ');
}
const require = createRequire(import.meta.url);
const dotenv = require(path.join(release, 'node_modules/dotenv'));
const parsed = dotenv.parse(envSource);
const enabled = (raw) => ['true', 'on', '1', 'shadow']
  .includes(String(raw ?? '').trim().toLowerCase());
const globalRaw = parsed.CHAT_CORE_V2_SHADOW_PLANNER_ENABLED;
const scoped = (kind, id) => enabled(
  parsed[`CHAT_CORE_V2_SHADOW_PLANNER_ENABLED_${kind}_${id}`] ?? globalRaw,
);
const shadowPlannerEffective = {
  global: enabled(globalRaw),
  user1000014: scoped('USER', 1000014),
  tenant1000014: scoped('TENANT', 1000014),
  user1000016: scoped('USER', 1000016),
  tenant1000016: scoped('TENANT', 1000016),
  dedicatedEval: (() => {
    const raw = String(parsed.CHAT_EVAL_DEDICATED_TENANT_ID ?? '').trim();
    const id = Number(raw);
    const present = /^[1-9][0-9]*$/u.test(raw)
      && Number.isSafeInteger(id) && String(id) === raw;
    return {
      present,
      user: present ? scoped('USER', id) : null,
      tenant: present ? scoped('TENANT', id) : null,
    };
  })(),
};
const attestedShadowPlannerEffective = attestation.shadowPlannerEffective;
if (JSON.stringify(attestedShadowPlannerEffective) !== JSON.stringify(shadowPlannerEffective)
    || Object.entries(shadowPlannerEffective)
      .filter(([key]) => key !== 'dedicatedEval')
      .some(([, value]) => value !== false)
    || (shadowPlannerEffective.dedicatedEval.present
      && (shadowPlannerEffective.dedicatedEval.user !== false
        || shadowPlannerEffective.dedicatedEval.tenant !== false))) {
  throw new Error('observation requires exact process-effective shadow planning off for every fixture scope');
}
const smokeScript = path.join(release, 'scripts/staging-smoke.sh');
const smokeStat = fs.lstatSync(smokeScript);
if (!smokeStat.isFile() || smokeStat.isSymbolicLink() || smokeStat.nlink !== 1) {
  throw new Error('installed canonical staging smoke is unsafe');
}
const plan = helper.buildCapabilityObservationPlan({
  role: 'staging', runtimeSha, artifactDigest, flag,
  previousObservationSequence: Number(previousSequenceRaw),
  receiptRaw: fs.readFileSync(receiptFile, 'utf8'),
  liveConfigured: configured,
  liveEffective: effective,
  liveMasterKill: masterKill,
  shadowPlannerEffective,
  smokeScriptSha256: createHash('sha256').update(fs.readFileSync(smokeScript)).digest('hex'),
  expectedProductionPlanSequence: Number(expectedProductionSequenceRaw),
  generatedAt,
});
fs.writeFileSync(output, `${JSON.stringify(plan, null, 2)}\n`, { mode: 0o600 });
NODE
}

prepare_observation_evidence_root() {
  local smoke_root="$STAGING_BASE_DIR/.local/release/smoke-evidence"
  install -d -m 700 "$STAGING_BASE_DIR/.local" \
    "$STAGING_BASE_DIR/.local/release" "$smoke_root"
  "$NODE_BIN" - "$STAGING_BASE_DIR/.local" \
    "$STAGING_BASE_DIR/.local/release" "$smoke_root" <<'NODE'
const fs = require('node:fs');
for (const directory of process.argv.slice(2)) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid()
      || (stat.mode & 0o777) !== 0o700) {
    throw new Error('observation evidence directory is unsafe');
  }
}
NODE
  printf '%s\n' "$smoke_root"
}

run_staging_capability_observation() {
  local smoke_root smoke_file sidecar_file smoke_log cross_skill_file
  local receipt_temp checked_at expected_production_sequence
  resolve_exact_staging_release
  OBSERVATION_TEMP_DIR="$(mktemp -d "$STATE_ROOT/.observation-$TRANSACTION_ID.XXXXXX")"
  chmod 700 "$OBSERVATION_TEMP_DIR"
  smoke_root="$(prepare_observation_evidence_root)"
  smoke_file="$smoke_root/chat-capability-$TRANSACTION_ID-staging-smoke.json"
  sidecar_file="$smoke_root/chat-capability-$TRANSACTION_ID-staging-observation.json"
  smoke_log="$OBSERVATION_TEMP_DIR/staging-smoke.log"
  cross_skill_file="$OBSERVATION_TEMP_DIR/cross-skill-smoke.json"
  [ ! -e "$smoke_file" ] && [ ! -e "$sidecar_file" ] \
    || die 'observation evidence already exists for this transaction'

  OBSERVATION_HEALTH_BEFORE_FILE="$OBSERVATION_TEMP_DIR/health-before.json"
  collect_staging_http_json '/health/detailed' health "$OBSERVATION_HEALTH_BEFORE_FILE"
  OBSERVATION_LEDGER_BEFORE_FILE="$OBSERVATION_TEMP_DIR/provider-ledger-before.json"
  collect_global_provider_ledger_snapshot "$OBSERVATION_LEDGER_BEFORE_FILE"

  "$NODE_BIN" --input-type=module - "$HELPER" "$OBSERVATION_CLAIM_PLAN" \
    "$STAGING_RELEASE_DIR/scripts/staging-smoke.sh" "$OBSERVATION_HEALTH_BEFORE_FILE" <<'NODE'
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
const [helperPath,planFile,smokeScript,healthFile] = process.argv.slice(2);
const helper = await import(pathToFileURL(helperPath).href);
const plan = helper.validateCapabilityObservationPlan(
  JSON.parse(fs.readFileSync(planFile, 'utf8')),
);
const stat = fs.lstatSync(smokeScript);
if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
    || createHash('sha256').update(fs.readFileSync(smokeScript)).digest('hex')
      !== plan.smokeScriptSha256) {
  throw new Error('installed canonical smoke bytes changed after observation inspect');
}
const health = JSON.parse(fs.readFileSync(healthFile, 'utf8'));
const attestation = health?.releaseAttestation;
const configured = {
  ...attestation?.capabilityFlags?.configured,
  AI_ROUTING_MANIFEST_KILL: attestation?.capabilityFlags?.masterKill,
};
const effective = {
  ...attestation?.capabilityFlags?.effective,
  AI_ROUTING_MANIFEST_KILL: attestation?.capabilityFlags?.masterKill,
};
if (health?.status !== 'healthy' || health?.database !== 'connected'
    || attestation?.runtimeSha !== plan.runtimeSha
    || attestation?.artifactDigest !== plan.artifactDigest
    || JSON.stringify(configured) !== JSON.stringify(plan.configured)
    || JSON.stringify(effective) !== JSON.stringify(plan.effective)
    || JSON.stringify(attestation?.shadowPlannerEffective)
      !== JSON.stringify(plan.shadowPlannerEffective)) {
  throw new Error('live staging state changed before canonical observation smoke');
}
if (Date.now() < Date.parse(plan.smokeNotBefore) || Date.now() > Date.parse(plan.expiresAt)) {
  throw new Error('canonical observation smoke is outside the inspected time window');
}
NODE

  (
    cd "$STAGING_RELEASE_DIR"
    env -i \
      "HOME=$HOME" \
      "USER=$(id -un)" \
      "LOGNAME=$(id -un)" \
      'PATH=/usr/local/bin:/usr/bin:/bin' \
      "STAGING_PATH=$STAGING_BASE_DIR" \
      'NEXUS_STAGING_SMOKE_LOCAL_SERVER=1' \
      'NEXUS_SMOKE_REQUIRE_EXACT_IDENTITY=1' \
      'NEXUS_SMOKE_EVIDENCE=1' \
      "NEXUS_SMOKE_EVIDENCE_DIR=$smoke_root" \
      "NEXUS_SMOKE_EVIDENCE_PATH=$smoke_file" \
      'NEXUS_SMOKE_TRAINING_E2E=1' \
      'NEXUS_SMOKE_TRAINING_E2E_USER_ID=1000014' \
      'NEXUS_SMOKE_LOCALE_FIDELITY=1' \
      'NEXUS_SMOKE_LOCALE_FIDELITY_USER_ID=1000016' \
      "NEXUS_RELEASE_ROLE=staging" \
      "NEXUS_RELEASE_DIR=$STAGING_RELEASE_DIR" \
      "NEXUS_RELEASE_BASE_DIR=$STAGING_BASE_DIR" \
      "NEXUS_RELEASE_SHA=$RUNTIME_SHA" \
      "NEXUS_RELEASE_ARTIFACT_SHA256=$ARTIFACT_DIGEST" \
      "$TIMEOUT_BIN" --foreground 480s \
      "$STAGING_RELEASE_DIR/scripts/staging-smoke.sh" > "$smoke_log" 2>&1
  )
  [ -f "$smoke_file" ] && [ ! -L "$smoke_file" ] \
    || die 'canonical observation smoke did not publish exact evidence'

  RAW_EVIDENCE_FILE=''
  case "$FLAG" in
    AI_CLASSIFY_MANIFEST_PROMPT)
      RAW_EVIDENCE_FILE="$OBSERVATION_TEMP_DIR/action-skill-gate.json"
      collect_action_skill_gate "$RAW_EVIDENCE_FILE"
      ;;
    AI_CROSS_SKILL_EXECUTION)
      RAW_EVIDENCE_FILE="$cross_skill_file"
      collect_cross_skill_smoke "$RAW_EVIDENCE_FILE"
      ;;
  esac

  DASHBOARD_EVIDENCE_FILE="$OBSERVATION_TEMP_DIR/dashboard.json"
  collect_staging_http_json '/api/portal/chat-quality' portal "$DASHBOARD_EVIDENCE_FILE"
  if [ -n "$RAW_EVIDENCE_FILE" ]; then
    STAGING_FLAG_EVIDENCE_FILE="$smoke_root/chat-capability-$TRANSACTION_ID-staging-flag-evidence.json"
    "$NODE_BIN" - "$RAW_EVIDENCE_FILE" "$STAGING_FLAG_EVIDENCE_FILE" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const [source,destination] = process.argv.slice(2);
const sourceStat = fs.lstatSync(source);
if (!sourceStat.isFile() || sourceStat.isSymbolicLink() || sourceStat.nlink !== 1
    || fs.existsSync(destination)) {
  throw new Error('flag-specific observation evidence path is unsafe');
}
const descriptor = fs.openSync(destination, 'wx', 0o600);
try { fs.writeFileSync(descriptor, fs.readFileSync(source)); fs.fsyncSync(descriptor); }
finally { fs.closeSync(descriptor); }
const parent = fs.openSync(path.dirname(destination), 'r');
try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
NODE
    RAW_EVIDENCE_FILE="$STAGING_FLAG_EVIDENCE_FILE"
  fi
  MONITOR_EVIDENCE_FILE="$OBSERVATION_TEMP_DIR/quality-monitor.json"
  collect_chat_quality_monitor "$MONITOR_EVIDENCE_FILE" "$STAGING_ENABLE_RECEIPT_FILE"
  HEALTH_EVIDENCE_FILE="$OBSERVATION_TEMP_DIR/health-after.json"
  collect_staging_http_json '/health/detailed' health "$HEALTH_EVIDENCE_FILE"
  OBSERVATION_LEDGER_AFTER_FILE="$OBSERVATION_TEMP_DIR/provider-ledger-after.json"
  collect_global_provider_ledger_snapshot "$OBSERVATION_LEDGER_AFTER_FILE"
  expected_production_sequence="$(read_expected_production_flag_plan_sequence)"
  checked_at="$($NODE_BIN -e 'process.stdout.write(new Date().toISOString())')"
  receipt_temp="$OBSERVATION_TEMP_DIR/observation-receipt.json"

  "$NODE_BIN" --input-type=module - "$HELPER" "$OBSERVATION_CLAIM_PLAN" \
    "$STAGING_ENABLE_RECEIPT_FILE" "$smoke_file" "$DASHBOARD_EVIDENCE_FILE" \
    "$MONITOR_EVIDENCE_FILE" "$HEALTH_EVIDENCE_FILE" \
    "$OBSERVATION_HEALTH_BEFORE_FILE" "$OBSERVATION_LEDGER_BEFORE_FILE" \
    "$OBSERVATION_LEDGER_AFTER_FILE" "$RAW_EVIDENCE_FILE" \
    "$TRANSACTION_ID" "$STARTED_AT" "$checked_at" \
    "$expected_production_sequence" "$receipt_temp" <<'NODE'
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
const [helperPath,planFile,enableReceiptFile,smokeFile,dashboardFile,monitorFile,
  healthAfterFile,healthBeforeFile,ledgerBeforeFile,ledgerAfterFile,flagEvidenceFile,
  transactionId,startedAt,checkedAt,expectedProductionSequenceRaw,output]
  = process.argv.slice(2);
const helper = await import(pathToFileURL(helperPath).href);
const plan = helper.validateCapabilityObservationPlan(
  JSON.parse(fs.readFileSync(planFile, 'utf8')),
);
if (plan.expectedProductionPlanSequence !== Number(expectedProductionSequenceRaw)) {
  throw new Error('production flag sequence changed during staging observation');
}
const readOrdinary = (file, label) => {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new Error(`${label} is unsafe`);
  }
  return fs.readFileSync(file, 'utf8');
};
const enableReceiptRaw = readOrdinary(enableReceiptFile, 'enable receipt');
const smokeRaw = readOrdinary(smokeFile, 'canonical smoke evidence');
const dashboardRaw = readOrdinary(dashboardFile, 'chat-quality dashboard');
const monitorRaw = readOrdinary(monitorFile, 'chat-quality monitor');
const healthAfterRaw = readOrdinary(healthAfterFile, 'health after smoke');
const healthBefore = JSON.parse(readOrdinary(healthBeforeFile, 'health before smoke'));
const healthAfter = JSON.parse(healthAfterRaw);
const state = (health, label) => {
  const attestation = health?.releaseAttestation;
  if (health?.status !== 'healthy' || health?.database !== 'connected'
      || attestation?.runtimeSha !== plan.runtimeSha
      || attestation?.artifactDigest !== plan.artifactDigest
      || JSON.stringify(attestation?.shadowPlannerEffective)
        !== JSON.stringify(plan.shadowPlannerEffective)) {
    throw new Error(`${label} does not attest the exact observed release`);
  }
  return {
    configured: {
      ...attestation.capabilityFlags.configured,
      AI_ROUTING_MANIFEST_KILL: attestation.capabilityFlags.masterKill,
    },
    effective: {
      ...attestation.capabilityFlags.effective,
      AI_ROUTING_MANIFEST_KILL: attestation.capabilityFlags.masterKill,
    },
    masterKill: attestation.capabilityFlags.masterKill,
  };
};
const beforeState = state(healthBefore, 'health before smoke');
const afterState = state(healthAfter, 'health after smoke');
const stagingPrerequisite = helper.buildStagingCapabilityPrerequisite({
  receiptRaw: enableReceiptRaw,
  healthRaw: healthAfterRaw,
  dashboardRaw,
  smokeRaw,
  monitorRaw,
  flag: plan.flag,
  runtimeSha: plan.runtimeSha,
  artifactDigest: plan.artifactDigest,
  checkedAt,
});
const beforeLedger = JSON.parse(readOrdinary(ledgerBeforeFile, 'provider ledger before'));
const afterLedger = JSON.parse(readOrdinary(ledgerAfterFile, 'provider ledger after'));
if (beforeLedger?.schema !== 'nexus.chat-capability-global-provider-ledger-snapshot.v1'
    || afterLedger?.schema !== beforeLedger.schema
    || beforeLedger.scope !== 'global' || afterLedger.scope !== 'global'
    || JSON.stringify(beforeLedger.apiUsage) !== JSON.stringify(afterLedger.apiUsage)
    || JSON.stringify(beforeLedger.hardCeilingReservations)
      !== JSON.stringify(afterLedger.hardCeilingReservations)) {
  throw new Error('observation created durable provider usage or hard-ceiling reservation deltas');
}
const providerLedger = {
  scope: 'global',
  expectedFixtureUserIds: [1_000_014, 1_000_016],
  apiUsageBefore: beforeLedger.apiUsage,
  apiUsageAfter: afterLedger.apiUsage,
  apiUsageRowDelta: 0,
  apiUsageCostDeltaUsd: 0,
  hardCeilingReservationsBefore: beforeLedger.hardCeilingReservations,
  hardCeilingReservationsAfter: afterLedger.hardCeilingReservations,
  hardCeilingReservationRowDelta: 0,
  hardCeilingReservedCostDeltaUsd: 0,
};
let flagSpecificEvidence = null;
if (plan.flag === 'AI_ROUTING_CLARIFY') {
  flagSpecificEvidence = helper.buildClarifyBudgetEvidenceAttestation({
    receiptRaw: enableReceiptRaw,
    dashboardRaw,
    healthRaw: healthAfterRaw,
    flag: plan.flag,
    runtimeSha: plan.runtimeSha,
    artifactDigest: plan.artifactDigest,
    checkedAt,
  });
} else if (plan.flag === 'AI_CLASSIFY_MANIFEST_PROMPT') {
  flagSpecificEvidence = helper.buildActionSkillEvidenceAttestation({
    rawEvidence: readOrdinary(flagEvidenceFile, 'action-skill current cache gate'),
    healthRaw: healthAfterRaw,
    flag: plan.flag,
    runtimeSha: plan.runtimeSha,
    artifactDigest: plan.artifactDigest,
    configuredFlags: afterState.configured,
    checkedAt,
  });
} else if (plan.flag === 'AI_CROSS_SKILL_EXECUTION') {
  flagSpecificEvidence = helper.buildCrossSkillSmokeEvidenceAttestation({
    rawEvidence: readOrdinary(flagEvidenceFile, 'cross-skill staging smoke'),
    healthRaw: healthAfterRaw,
    flag: plan.flag,
    runtimeSha: plan.runtimeSha,
    artifactDigest: plan.artifactDigest,
    configuredFlags: afterState.configured,
    checkedAt,
  });
}
const receipt = helper.buildCapabilityObservationReceipt({
  plan,
  transactionId,
  stagingPrerequisite,
  smokeRaw,
  observationStartedAt: startedAt,
  observationCompletedAt: checkedAt,
  configuredBefore: beforeState.configured,
  effectiveBefore: beforeState.effective,
  masterKillBefore: beforeState.masterKill,
  configuredAfter: afterState.configured,
  effectiveAfter: afterState.effective,
  masterKillAfter: afterState.masterKill,
  flagSpecificEvidence,
  providerLedger,
});
const receiptFile = output;
const descriptor = fs.openSync(receiptFile, 'wx', 0o600);
try { fs.writeFileSync(descriptor, `${JSON.stringify(receipt, null, 2)}\n`); fs.fsyncSync(descriptor); }
finally { fs.closeSync(descriptor); }
NODE

  "$NODE_BIN" --input-type=module - "$HELPER" "$receipt_temp" "$smoke_file" \
    "$OBSERVATION_RECEIPT_FILE" "$sidecar_file" <<'NODE'
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
const [helperPath,source,smokeFile,stateReceipt,sidecar] = process.argv.slice(2);
const helper = await import(pathToFileURL(helperPath).href);
const sourceStat = fs.lstatSync(source);
if (!sourceStat.isFile() || sourceStat.isSymbolicLink() || sourceStat.nlink !== 1) {
  throw new Error('observation receipt source is unsafe');
}
const raw = fs.readFileSync(source, 'utf8');
const receipt = helper.validateCapabilityObservationReceipt(JSON.parse(raw));
const smokeSha256 = createHash('sha256').update(fs.readFileSync(smokeFile)).digest('hex');
if (receipt.smokeSha256 !== smokeSha256) {
  throw new Error('observation receipt does not bind the exact canonical smoke bytes');
}
for (const destination of [stateReceipt, sidecar]) {
  if (fs.existsSync(destination)) throw new Error('observation receipt destination already exists');
  const temporary = `${destination}.next-${process.pid}`;
  const descriptor = fs.openSync(temporary, 'wx', 0o600);
  try { fs.writeFileSync(descriptor, raw); fs.fsyncSync(descriptor); }
  finally { fs.closeSync(descriptor); }
}
for (const destination of [sidecar, stateReceipt]) {
  fs.renameSync(`${destination}.next-${process.pid}`, destination);
  const parent = fs.openSync(path.dirname(destination), 'r');
  try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
  const stat = fs.lstatSync(destination);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
      || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600
      || fs.readFileSync(destination, 'utf8') !== raw) {
    throw new Error('durable observation receipt verification failed');
  }
}
NODE
  RAW_EVIDENCE_FILE=''
  RECEIPT_WRITTEN=true
  cat "$OBSERVATION_RECEIPT_FILE"
}

collect_native_evidence_sources() {
  [ "$DESIRED_VALUE" = true ] && [ "$FLAG" != AI_ROUTING_MANIFEST_KILL ] || return 0
  resolve_exact_staging_release
  case "$ROLE:$FLAG" in
    staging:AI_ROUTING_MANIFEST_CLASSIFIER|staging:AI_ROUTING_MANIFEST_ORCHESTRATOR|staging:AI_ROUTING_MANIFEST_SHADOW|staging:AI_ROUTING_MANIFEST_REGISTRY)
      SHADOW_HOOK_RECEIPT_FILE="$(mktemp "$STATE_ROOT/.shadow-hook-enable-receipt.XXXXXX")"
      select_exact_shadow_hook_enable_receipt "$SHADOW_HOOK_RECEIPT_FILE"
      HEALTH_EVIDENCE_FILE="$(mktemp "$STATE_ROOT/.routing-health-evidence.XXXXXX")"
      collect_staging_http_json '/health/detailed' health "$HEALTH_EVIDENCE_FILE"
      RAW_EVIDENCE_FILE="$(mktemp "$STATE_ROOT/.routing-evidence.XXXXXX")"
      collect_routing_divergence "$RAW_EVIDENCE_FILE"
      return 0
      ;;
    staging:AI_ROUTING_CLARIFY)
      DASHBOARD_EVIDENCE_FILE="$(mktemp "$STATE_ROOT/.dashboard-evidence.XXXXXX")"
      collect_staging_http_json '/api/portal/chat-quality' portal "$DASHBOARD_EVIDENCE_FILE"
      ;;
    staging:AI_CLASSIFY_MANIFEST_PROMPT)
      RAW_EVIDENCE_FILE="$(mktemp "$STATE_ROOT/.action-skill-evidence.XXXXXX")"
      collect_action_skill_gate "$RAW_EVIDENCE_FILE"
      ;;
    staging:AI_CROSS_SKILL_EXECUTION)
      RAW_EVIDENCE_FILE="$(mktemp "$STATE_ROOT/.cross-skill-preflight.XXXXXX")"
      collect_cross_skill_preflight "$RAW_EVIDENCE_FILE"
      ;;
    production:AI_ROUTING_MANIFEST_CLASSIFIER|production:AI_ROUTING_MANIFEST_ORCHESTRATOR|production:AI_ROUTING_MANIFEST_SHADOW|production:AI_ROUTING_MANIFEST_REGISTRY|production:AI_CLASSIFY_MANIFEST_PROMPT)
      ;;
    production:AI_ROUTING_CLARIFY)
      ;;
    production:AI_CROSS_SKILL_EXECUTION)
      ;;
    *) die 'native evidence collection is not implemented for this enable' ;;
  esac
  if [ "$ROLE" = production ]; then
    collect_production_staging_prerequisite_sources
    return 0
  fi
  HEALTH_EVIDENCE_FILE="$(mktemp "$STATE_ROOT/.health-evidence.XXXXXX")"
  collect_staging_http_json '/health/detailed' health "$HEALTH_EVIDENCE_FILE"
}

revalidate_routing_shadow_binding() {
  local plan_file="$1"
  local pm2_file="$2"
  if ! "$NODE_BIN" - "$plan_file" <<'NODE'
const fs = require('node:fs');
const record = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const plan = record.plan ?? record;
const routing = new Set([
  'AI_ROUTING_MANIFEST_CLASSIFIER',
  'AI_ROUTING_MANIFEST_ORCHESTRATOR',
  'AI_ROUTING_MANIFEST_SHADOW',
  'AI_ROUTING_MANIFEST_REGISTRY',
]);
process.exit(plan.role === 'staging' && plan.desiredValue === true && routing.has(plan.flag) ? 0 : 1);
NODE
  then
    return 0
  fi

  resolve_exact_staging_release
  local receipt_file health_file checked_at
  receipt_file="$(mktemp "$STATE_ROOT/.apply-shadow-hook-receipt.XXXXXX")"
  health_file="$(mktemp "$STATE_ROOT/.apply-shadow-hook-health.XXXXXX")"
  SHADOW_HOOK_RECEIPT_FILE="$receipt_file"
  HEALTH_EVIDENCE_FILE="$health_file"
  select_exact_shadow_hook_enable_receipt "$receipt_file"
  collect_staging_http_json '/health/detailed' health "$health_file"
  checked_at="$($NODE_BIN -e 'process.stdout.write(new Date().toISOString())')"
  "$NODE_BIN" --input-type=module - "$HELPER" "$plan_file" "$receipt_file" \
    "$health_file" "$pm2_file" "$checked_at" <<'NODE'
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
const [helperPath,planFile,receiptFile,healthFile,pm2File,checkedAt] = process.argv.slice(2);
const helper = await import(pathToFileURL(helperPath).href);
const persisted = JSON.parse(fs.readFileSync(planFile, 'utf8'));
const plan = persisted.plan ?? persisted;
const evidence = plan.evidenceAttestation;
const receiptRaw = fs.readFileSync(receiptFile, 'utf8');
const receipt = helper.validateShadowRouteHookReceipt(JSON.parse(receiptRaw));
const receiptSha256 = createHash('sha256').update(receiptRaw).digest('hex');
if (receipt.status !== 'passed' || receipt.action !== 'enable'
    || receipt.role !== plan.role || receipt.runtimeSha !== plan.runtimeSha
    || receipt.artifactDigest !== plan.artifactDigest
    || receiptSha256 !== evidence?.shadowHookReceiptSha256
    || receipt.transactionId !== evidence?.shadowHookTransactionId
    || receipt.planDigest !== evidence?.shadowHookPlanDigest
    || receipt.planSequence !== evidence?.shadowHookPlanSequence
    || receipt.completedAt !== evidence?.shadowHookCompletedAt
    || receipt.dedicatedTenantId !== evidence?.dedicatedTenantId
    || Date.parse(evidence?.windowSinceInclusive) < Date.parse(receipt.completedAt)) {
  throw new Error('current shadow-hook receipt no longer matches the reviewed routing evidence');
}
const healthRaw = fs.readFileSync(healthFile, 'utf8');
const health = JSON.parse(healthRaw);
const attestation = health?.releaseAttestation;
const pm2 = JSON.parse(fs.readFileSync(pm2File, 'utf8'));
const timestamp = Date.parse(health?.timestamp);
if (health?.status !== 'healthy' || health?.database !== 'connected'
    || health?.databaseProbe?.status !== 'connected'
    || attestation?.schema !== 'nexus.chat-capability-release-attestation.v2'
    || attestation.role !== 'staging' || attestation.runtimeSha !== plan.runtimeSha
    || attestation.artifactDigest !== plan.artifactDigest
    || attestation.processId !== pm2.backend.pid
    || attestation.capabilityRuntimeGuard?.status !== 'clear'
    || attestation.capabilityRuntimeGuard?.transactionId !== null
    || attestation.capabilityRuntimeGuard?.planDigest !== null
    || attestation.capabilityFlags?.masterKill !== false
    || !Number.isFinite(timestamp) || timestamp > Date.parse(checkedAt)
    || Date.parse(checkedAt) - timestamp > 30_000) {
  throw new Error('current routing shadow-hook health is stale or has the wrong release identity');
}
const expectedConfigured = { ...plan.configuredBefore };
delete expectedConfigured.AI_ROUTING_MANIFEST_KILL;
if (JSON.stringify(attestation.capabilityFlags.configured) !== JSON.stringify(expectedConfigured)
    || JSON.stringify(attestation.capabilityFlags.effective) !== JSON.stringify(expectedConfigured)
    || attestation.shadowRouteHookEffective?.global !== false
    || attestation.shadowRouteHookEffective?.dedicatedEval?.present !== true
    || attestation.shadowRouteHookEffective?.dedicatedEval?.user !== true
    || attestation.shadowRouteHookEffective?.dedicatedEval?.tenant !== true
    || attestation.shadowPlannerEffective?.global !== false
    || attestation.shadowPlannerEffective?.dedicatedEval?.present !== true
    || attestation.shadowPlannerEffective?.dedicatedEval?.user !== false
    || attestation.shadowPlannerEffective?.dedicatedEval?.tenant !== false) {
  throw new Error('current routing shadow-hook state differs from the reviewed rollout prefix');
}
NODE
  rm -f -- "$receipt_file" "$health_file"
  SHADOW_HOOK_RECEIPT_FILE=''
  HEALTH_EVIDENCE_FILE=''
}

revalidate_apply_staging_prerequisite() {
  [ "$ROLE" = production ] || return 0
  if ! "$NODE_BIN" - "$CLAIM_PLAN" <<'NODE'
const fs = require('node:fs');
const persisted = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const plan = persisted.plan ?? persisted;
process.exit(plan.desiredValue === true && plan.flag !== 'AI_ROUTING_MANIFEST_KILL' ? 0 : 1);
NODE
  then
    return 0
  fi
  FLAG="$("$NODE_BIN" - "$CLAIM_PLAN" <<'NODE'
const fs = require('node:fs');
const persisted = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const plan = persisted.plan ?? persisted;
process.stdout.write(plan.flag);
NODE
  )"
  EXPECTED_PRODUCTION_SEQUENCE="$("$NODE_BIN" - "$CLAIM_PLAN" <<'NODE'
const fs = require('node:fs');
const persisted = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const plan = persisted.plan ?? persisted;
process.stdout.write(String(plan.planSequence));
NODE
  )"
  resolve_exact_staging_release
  STAGING_ENABLE_RECEIPT_FILE="$(mktemp "$STATE_ROOT/.apply-enable-receipt.XXXXXX")"
  select_mature_exact_staging_enable_receipt "$STAGING_ENABLE_RECEIPT_FILE"
  select_existing_canonical_staging_smoke "$EXPECTED_PRODUCTION_SEQUENCE"
  RAW_EVIDENCE_FILE=''
  case "$FLAG" in
    AI_CLASSIFY_MANIFEST_PROMPT)
      RAW_EVIDENCE_FILE="$(mktemp "$STATE_ROOT/.apply-action-skill-evidence.XXXXXX")"
      collect_action_skill_gate "$RAW_EVIDENCE_FILE"
      ;;
  esac
  MONITOR_EVIDENCE_FILE="$(mktemp "$STATE_ROOT/.apply-monitor-evidence.XXXXXX")"
  collect_chat_quality_monitor "$MONITOR_EVIDENCE_FILE" "$STAGING_ENABLE_RECEIPT_FILE"
  DASHBOARD_EVIDENCE_FILE="$(mktemp "$STATE_ROOT/.apply-dashboard-evidence.XXXXXX")"
  collect_staging_http_json '/api/portal/chat-quality' portal "$DASHBOARD_EVIDENCE_FILE"
  HEALTH_EVIDENCE_FILE="$(mktemp "$STATE_ROOT/.apply-health-evidence.XXXXXX")"
  collect_staging_http_json '/health/detailed' health "$HEALTH_EVIDENCE_FILE"
  "$NODE_BIN" --input-type=module - "$HELPER" "$CLAIM_PLAN" \
    "$STAGING_ENABLE_RECEIPT_FILE" "$STAGING_SMOKE_EVIDENCE_FILE" \
    "$STAGING_OBSERVATION_EVIDENCE_FILE" "$STAGING_FLAG_EVIDENCE_FILE" \
    "$HEALTH_EVIDENCE_FILE" "$DASHBOARD_EVIDENCE_FILE" "$RAW_EVIDENCE_FILE" \
    "$MONITOR_EVIDENCE_FILE" "$STAGING_ENV_FILE" <<'NODE'
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
const [helperPath,claimPlan,enableReceiptFile,smokeFile,observationFile,
  observedFlagEvidenceFile,healthFile,dashboardFile,currentActionFile,monitorFile,
  stagingEnvFile] = process.argv.slice(2);
const helper = await import(pathToFileURL(helperPath).href);
const persisted = JSON.parse(fs.readFileSync(claimPlan, 'utf8'));
const plan = persisted.plan ?? persisted;
const rebuilt = helper.buildCapabilityFlagPlan({
  role: plan.role,
  runtimeSha: plan.runtimeSha,
  artifactDigest: plan.artifactDigest,
  flag: plan.flag,
  desiredValue: plan.desiredValue,
  configuredFlags: plan.configuredBefore,
  previousPlanSequence: plan.previousPlanSequence,
  transitionReason: plan.transitionReason,
  evidenceAttestation: plan.evidenceAttestation,
  stagingPrerequisite: plan.stagingPrerequisite,
  generatedAt: plan.generatedAt,
});
if (JSON.stringify(rebuilt) !== JSON.stringify(plan)
    || plan.role !== 'production' || plan.desiredValue !== true
    || plan.flag === 'AI_ROUTING_MANIFEST_KILL') {
  throw new Error('claimed production enable plan is invalid');
}
const readOrdinary = (file, label) => {
  if (!file) throw new Error(`${label} path is unavailable`);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
      || (stat.mode & 0o777) !== 0o600 || stat.uid !== process.getuid()) {
    throw new Error(`${label} is unsafe`);
  }
  return fs.readFileSync(file, 'utf8');
};
const enableReceiptRaw = readOrdinary(enableReceiptFile, 'staging enable receipt');
const enableReceipt = helper.validateCapabilityFlagReceipt(JSON.parse(enableReceiptRaw));
const smokeRaw = readOrdinary(smokeFile, 'canonical staging smoke receipt');
const observationRaw = readOrdinary(observationFile, 'staging observation receipt');
const observation = helper.validateCapabilityObservationReceipt(JSON.parse(observationRaw));
const checkedAt = new Date().toISOString();
const freshPrerequisite = helper.buildProductionStagingCapabilityPrerequisiteFromObservation({
  observationRaw,
  flag: plan.flag,
  runtimeSha: plan.runtimeSha,
  artifactDigest: plan.artifactDigest,
  checkedAt,
});
if (JSON.stringify(freshPrerequisite) !== JSON.stringify(plan.stagingPrerequisite)
    || freshPrerequisite.expectedProductionPlanSequence !== plan.planSequence
    || observation.enableTransactionId !== enableReceipt.transactionId
    || observation.enableReceiptSha256
      !== createHash('sha256').update(enableReceiptRaw).digest('hex')
    || observation.smokeSha256 !== createHash('sha256').update(smokeRaw).digest('hex')
    || observation.expectedProductionPlanSequence !== plan.planSequence
    || JSON.stringify(observation.configuredAfter) !== JSON.stringify(plan.configuredAfter)
    || JSON.stringify(observation.effectiveAfter) !== JSON.stringify(plan.effectiveAfter)
    || JSON.stringify(helper.readCapabilityFlagState(
      readOrdinary(stagingEnvFile, 'staging environment'),
    )) !== JSON.stringify(plan.configuredAfter)) {
  throw new Error('apply-time observation no longer matches the reviewed production plan');
}
const healthRaw = readOrdinary(healthFile, 'current staging health');
const health = JSON.parse(healthRaw);
const attestation = health?.releaseAttestation;
const currentConfigured = {
  ...attestation?.capabilityFlags?.configured,
  AI_ROUTING_MANIFEST_KILL: attestation?.capabilityFlags?.masterKill,
};
const currentEffective = {
  ...attestation?.capabilityFlags?.effective,
  AI_ROUTING_MANIFEST_KILL: attestation?.capabilityFlags?.masterKill,
};
if (health?.status !== 'healthy' || health?.database !== 'connected'
    || attestation?.runtimeSha !== plan.runtimeSha
    || attestation?.artifactDigest !== plan.artifactDigest
    || JSON.stringify(currentConfigured) !== JSON.stringify(plan.configuredAfter)
    || JSON.stringify(currentEffective) !== JSON.stringify(plan.effectiveAfter)
    || JSON.stringify(attestation?.shadowPlannerEffective)
      !== JSON.stringify(observation.shadowPlannerEffective)) {
  throw new Error('current staging health no longer matches the observed target-on release');
}
const currentBasePrerequisite = helper.buildStagingCapabilityPrerequisite({
  receiptRaw: enableReceiptRaw,
  healthRaw,
  dashboardRaw: readOrdinary(dashboardFile, 'current chat-quality dashboard'),
  smokeRaw,
  monitorRaw: readOrdinary(monitorFile, 'current chat-quality monitor'),
  flag: plan.flag,
  runtimeSha: plan.runtimeSha,
  artifactDigest: plan.artifactDigest,
  checkedAt,
});
const reviewedBasePrerequisite = freshPrerequisite.basePrerequisite;
for (const key of [
  'flag', 'runtimeSha', 'artifactDigest', 'enableTransactionId',
  'enableReceiptSha256', 'enableCompletedAt', 'normalSmokeSha256',
  'normalSmokeProfile', 'normalSmokeStartedAt', 'normalSmokeCompletedAt',
  'normalSmokeCheckCount', 'observationMinimumMs',
]) {
  if (currentBasePrerequisite[key] !== reviewedBasePrerequisite[key]) {
    throw new Error('current quality proof changed an immutable staging prerequisite identity');
  }
}
if (JSON.stringify(currentBasePrerequisite.stagingConfigured)
      !== JSON.stringify(reviewedBasePrerequisite.stagingConfigured)
    || JSON.stringify(currentBasePrerequisite.stagingEffective)
      !== JSON.stringify(reviewedBasePrerequisite.stagingEffective)
    || currentBasePrerequisite.masterKill !== reviewedBasePrerequisite.masterKill
    || currentBasePrerequisite.qualityMonitorVerdict !== 'passed'
    || currentBasePrerequisite.durableAlertActivityRowCount !== 0
    || currentBasePrerequisite.scheduledMonitorLastResult !== 'success') {
  throw new Error('current staging quality or durable alert proof no longer passes');
}
if (plan.flag.startsWith('AI_ROUTING_MANIFEST_')) {
  if (JSON.stringify(plan.evidenceAttestation) !== JSON.stringify(enableReceipt.evidenceAttestation)
      || observation.flagSpecificEvidence !== null) {
    throw new Error('routing evidence no longer matches the immutable target-off staging receipt');
  }
} else {
  if (JSON.stringify(plan.evidenceAttestation) !== JSON.stringify(observation.flagSpecificEvidence)) {
    throw new Error('production evidence no longer matches the observed target-on receipt');
  }
  if (plan.flag === 'AI_ROUTING_CLARIFY') {
    const fresh = helper.buildClarifyBudgetEvidenceAttestation({
      receiptRaw: enableReceiptRaw,
      dashboardRaw: readOrdinary(dashboardFile, 'current clarify dashboard'),
      healthRaw,
      flag: plan.flag,
      runtimeSha: plan.runtimeSha,
      artifactDigest: plan.artifactDigest,
      checkedAt,
    });
    if (fresh.clarifyRate > 0.1 || fresh.candidateClarifyRate > 0.1
        || fresh.baselineDashboardSha256 !== plan.evidenceAttestation.baselineDashboardSha256
        || fresh.baselineGeneratedAt !== plan.evidenceAttestation.baselineGeneratedAt) {
      throw new Error('current clarify evidence exceeds budget or changed its baseline');
    }
  } else if (plan.flag === 'AI_CLASSIFY_MANIFEST_PROMPT') {
    const fresh = helper.buildActionSkillEvidenceAttestation({
      rawEvidence: readOrdinary(currentActionFile, 'current action-skill cache gate'),
      healthRaw,
      flag: plan.flag,
      runtimeSha: plan.runtimeSha,
      artifactDigest: plan.artifactDigest,
      configuredFlags: currentConfigured,
      checkedAt,
    });
    for (const key of [
      'labeledRows', 'cacheRows', 'corpusIdentityDigest', 'promptSha256',
      'refreshPlanDigest', 'hardBudgetUsd',
    ]) {
      if (fresh[key] !== plan.evidenceAttestation[key]) {
        throw new Error('current action-skill cache identity changed after review');
      }
    }
    if (fresh.agreementRate < 0.95 || fresh.gatePassed !== true) {
      throw new Error('current action-skill cache gate no longer passes');
    }
  } else if (plan.flag === 'AI_CROSS_SKILL_EXECUTION') {
    const fresh = helper.buildCrossSkillSmokeEvidenceAttestation({
      rawEvidence: readOrdinary(
        observedFlagEvidenceFile,
        'observation-bound cross-skill smoke report',
      ),
      healthRaw,
      flag: plan.flag,
      runtimeSha: plan.runtimeSha,
      artifactDigest: plan.artifactDigest,
      configuredFlags: currentConfigured,
      checkedAt,
    });
    for (const key of [
      'evidenceSha256', 'runId', 'dedicatedIdentitySource', 'outputRefsDecision',
      'operationCount',
    ]) {
      if (fresh[key] !== plan.evidenceAttestation[key]) {
        throw new Error('cross-skill observation identity changed after review');
      }
    }
  }
}
NODE
}

if [ "$COMMAND" = inspect ] || [ "$COMMAND" = apply ]; then
  PENDING_PLAN="$STATE_ROOT/$ROLE.flag.pending.json"
  PENDING_PRIVATE="$STATE_ROOT/$ROLE.flag.pending.private.json"
  SEQUENCE_FILE="$STATE_ROOT/$ROLE.flag.sequence"
elif [ "$COMMAND" = inspect-observation ] || [ "$COMMAND" = apply-observation ]; then
  PENDING_PLAN="$STATE_ROOT/staging.observation.pending.json"
  SEQUENCE_FILE="$STATE_ROOT/staging.observation.sequence"
  OBSERVATION_CLAIM_PLAN="$STATE_ROOT/observations/staging-$TRANSACTION_ID.observation-plan.json"
  OBSERVATION_RECEIPT_FILE="$STATE_ROOT/observations/staging-$TRANSACTION_ID.observation-receipt.json"
elif [ "$COMMAND" = inspect-shadow-hook ] || [ "$COMMAND" = apply-shadow-hook ]; then
  PENDING_PLAN="$STATE_ROOT/staging.shadow-hook.pending.json"
  PENDING_PRIVATE="$STATE_ROOT/staging.shadow-hook.pending.private.json"
  SEQUENCE_FILE="$STATE_ROOT/staging.shadow-hook.sequence"
else
  PENDING_PLAN="$STATE_ROOT/$ROLE.secrets.pending.json"
  PENDING_PRIVATE="$STATE_ROOT/$ROLE.secrets.pending.private.json"
  SEQUENCE_FILE="$STATE_ROOT/$ROLE.secrets.sequence"
fi

pm2_env() {
  "$TIMEOUT_BIN" --foreground 30s env -i \
    "HOME=$HOME" \
    "USER=$(id -un)" \
    "LOGNAME=$(id -un)" \
    'PATH=/usr/local/bin:/usr/bin:/bin' \
    "PM2_HOME=$HOME/.pm2" \
    "NEXUS_RELEASE_DIR=$RELEASE_DIR" \
    "NEXUS_RELEASE_BASE_DIR=$BASE_DIR" \
    "NEXUS_RELEASE_ROLE=$ROLE" \
    "NEXUS_RELEASE_SHA=$RUNTIME_SHA" \
    "NEXUS_RELEASE_ARTIFACT_SHA256=$ARTIFACT_DIGEST" \
    "GIT_COMMIT=$RUNTIME_SHA" \
    "$PM2_BIN" "$@"
}

write_pm2_snapshot() {
  local output="$1"
  local raw
  raw="$(mktemp "$STATE_ROOT/.pm2.XXXXXX")"
  if ! "$TIMEOUT_BIN" --foreground 10s "$PM2_BIN" jlist > "$raw"; then
    rm -f -- "$raw"
    return 1
  fi
  if ! "$NODE_BIN" - "$raw" "$output" "$BACKEND_APP" "$CONTENT_APP" \
    "$RELEASE_DIR" "$ROLE" "$RUNTIME_SHA" "$ARTIFACT_DIGEST" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const [raw, output, backendName, contentName, release, role, sha, digest] = process.argv.slice(2);
const rows = JSON.parse(fs.readFileSync(raw, 'utf8'));
const pick = (name, content) => {
  const matches = rows.filter((row) => row?.name === name);
  if (matches.length !== 1) throw new Error(`expected one PM2 process: ${name}`);
  const row = matches[0];
  const env = row.pm2_env ?? {};
  const expectedCwd = content ? path.join(release, 'content-engine') : release;
  const expectedExecPath = content ? '/usr/bin/python3.12' : path.join(release, 'dist/index.js');
  if (env.status !== 'online' || env.pm_cwd !== expectedCwd
      || env.pm_exec_path !== expectedExecPath
      || env.NEXUS_RELEASE_ROLE !== role
      || (env.NEXUS_RELEASE_SHA ?? env.GIT_COMMIT) !== sha
      || env.NEXUS_RELEASE_ARTIFACT_SHA256 !== digest
      || !Number.isSafeInteger(row.pid) || row.pid < 1
      || !Number.isFinite(env.pm_uptime) || env.pm_uptime < 1) {
    throw new Error(`PM2 identity mismatch: ${name}`);
  }
  return {
    name,
    pid: row.pid,
    pmUptimeMs: env.pm_uptime,
    cwd: env.pm_cwd,
    execPath: env.pm_exec_path,
  };
};
const body = { backend: pick(backendName, false), content: pick(contentName, true) };
const temporary = `${output}.next-${process.pid}`;
const descriptor = fs.openSync(temporary, 'wx', 0o600);
try { fs.writeFileSync(descriptor, `${JSON.stringify(body)}\n`); fs.fsyncSync(descriptor); }
finally { fs.closeSync(descriptor); }
fs.renameSync(temporary, output);
const parent = fs.openSync(path.dirname(output), 'r');
try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
NODE
  then
    rm -f -- "$raw"
    return 1
  fi
  rm -f -- "$raw"
}

restart_backend() {
  pm2_env delete "$BACKEND_APP" >/dev/null
  pm2_env start "$RELEASE_DIR/ecosystem.release.config.js" --only "$BACKEND_APP" >/dev/null
  pm2_env save --force >/dev/null
}

assert_pm2_transition() {
  local before="$1"
  local after="$2"
  local expect_restart="$3"
  "$NODE_BIN" - "$before" "$after" "$expect_restart" <<'NODE'
const fs = require('node:fs');
const [beforeFile, afterFile, expectRestart] = process.argv.slice(2);
const before = JSON.parse(fs.readFileSync(beforeFile, 'utf8'));
const after = JSON.parse(fs.readFileSync(afterFile, 'utf8'));
if (after.content.pid !== before.content.pid
    || after.content.pmUptimeMs !== before.content.pmUptimeMs) {
  throw new Error('content process changed during backend-only transaction');
}
if (expectRestart === 'true') {
  if (after.backend.pid === before.backend.pid
      || after.backend.pmUptimeMs <= before.backend.pmUptimeMs) {
    throw new Error('backend process was not recreated');
  }
} else if (after.backend.pid !== before.backend.pid
    || after.backend.pmUptimeMs !== before.backend.pmUptimeMs) {
  throw new Error('no-op secret transaction changed backend process');
}
NODE
}

health_once() {
  local plan_file="$1"
  local state_key="$2"
  local expected_pid="$3"
  local expected_guard="$4"
  env -i \
    "HOME=$HOME" \
    "USER=$(id -un)" \
    'PATH=/usr/local/bin:/usr/bin:/bin' \
    "$NODE_BIN" --env-file="$ENV_FILE" - "$BACKEND_PORT" "$CONTENT_PORT" \
      "$ROLE" "$RUNTIME_SHA" "$ARTIFACT_DIGEST" "$expected_pid" \
      "$plan_file" "$state_key" "$expected_guard" "$TRANSACTION_ID" \
      "$PLAN_DIGEST" <<'NODE'
const http = require('node:http');
const fs = require('node:fs');
const [backendPort, contentPort, role, sha, digest, expectedPid, planFile, stateKey,
  expectedGuard, transactionId, planDigest] = process.argv.slice(2);
const request = (port, route, headers = {}) => new Promise((resolve, reject) => {
  const req = http.get({ hostname: '127.0.0.1', port: Number(port), path: route, headers, timeout: 5000 }, (res) => {
    let body = '';
    res.setEncoding('utf8');
    res.on('data', (chunk) => { body += chunk; });
    res.on('end', () => resolve({ status: res.statusCode, body }));
  });
  req.on('timeout', () => req.destroy(new Error('health timeout')));
  req.on('error', reject);
});
const main = async () => {
  const token = process.env.HEALTH_TOKEN;
  if (!token) throw new Error('HEALTH_TOKEN is unavailable');
  const [backend, content] = await Promise.all([
    request(backendPort, '/health/detailed', { Authorization: `Bearer ${token}` }),
    request(contentPort, '/health'),
  ]);
  if (backend.status !== 200 || content.status !== 200) throw new Error('health endpoint failed');
  const body = JSON.parse(backend.body);
  const attestation = body.releaseAttestation;
  if (attestation?.schema !== 'nexus.chat-capability-release-attestation.v2'
      || attestation.role !== role || attestation.runtimeSha !== sha
      || attestation.artifactDigest !== digest
      || attestation.processId !== Number(expectedPid)) throw new Error('release attestation mismatch');
  const runtimeGuard = attestation.capabilityRuntimeGuard;
  if (expectedGuard === 'authorized') {
    if (runtimeGuard?.status !== 'authorized'
        || runtimeGuard.transactionId !== transactionId
        || runtimeGuard.planDigest !== planDigest) {
      throw new Error('runtime transaction permit is not authorized');
    }
  } else if (expectedGuard === 'clear') {
    if (runtimeGuard?.status !== 'clear' || runtimeGuard.transactionId !== null
        || runtimeGuard.planDigest !== null) {
      throw new Error('runtime transaction guard did not return to clear');
    }
  } else {
    throw new Error('runtime transaction guard expectation is invalid');
  }
  const persisted = JSON.parse(fs.readFileSync(planFile, 'utf8'));
  const plan = persisted.plan ?? persisted;
  const state = plan[stateKey];
  if (state) {
    const configured = { ...state };
    const masterKill = configured.AI_ROUTING_MANIFEST_KILL;
    delete configured.AI_ROUTING_MANIFEST_KILL;
    if (JSON.stringify(attestation.capabilityFlags.configured) !== JSON.stringify(configured)
        || attestation.capabilityFlags.masterKill !== masterKill) {
      throw new Error('configured flag attestation mismatch');
    }
    const effective = { ...plan[stateKey.replace('configured', 'effective')] };
    delete effective.AI_ROUTING_MANIFEST_KILL;
    if (JSON.stringify(attestation.capabilityFlags.effective) !== JSON.stringify(effective)) {
      throw new Error('effective flag attestation mismatch');
    }
    if (configured.AI_CLASSIFY_MANIFEST_PROMPT
        && attestation.classifierPromptRuntimeForceDisabled) {
      throw new Error('manifest prompt boot guard force-disabled an enabled flag');
    }
  }
};
main().catch(() => process.exit(1));
NODE
}

wait_healthy() {
  local plan_file="$1"
  local state_key="$2"
  local expected_pid="$3"
  local expected_guard="$4"
  local deadline=$((SECONDS + 45))
  until health_once "$plan_file" "$state_key" "$expected_pid" "$expected_guard"; do
    [ "$SECONDS" -lt "$deadline" ] || return 1
    sleep 2
  done
  sleep 5
  health_once "$plan_file" "$state_key" "$expected_pid" "$expected_guard"
}

atomic_write_json() {
  local destination="$1"
  local source="$2"
  "$NODE_BIN" - "$destination" "$source" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const [destination, source] = process.argv.slice(2);
const value = JSON.parse(fs.readFileSync(source, 'utf8'));
const body = `${JSON.stringify(value, null, 2)}\n`;
const temporary = `${destination}.next-${process.pid}`;
const descriptor = fs.openSync(temporary, 'wx', 0o600);
try { fs.writeFileSync(descriptor, body); fs.fsyncSync(descriptor); }
finally { fs.closeSync(descriptor); }
fs.renameSync(temporary, destination);
const parent = fs.openSync(path.dirname(destination), 'r');
try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
NODE
}

durable_remove() {
  local target="$1"
  [ -e "$target" ] || return 0
  rm -f -- "$target"
  "$NODE_BIN" - "$(dirname "$target")" <<'NODE'
const fs = require('node:fs');
const descriptor = fs.openSync(process.argv[2], 'r');
try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
NODE
}

write_runtime_permit() {
  local phase="$1"
  local state_file="$2"
  local state_key="$3"
  [ -n "$TRANSACTION_ID" ] && [ -n "$PLAN_DIGEST" ] \
    || die 'runtime permit requires an exact transaction and plan digest'
  "$NODE_BIN" --input-type=module - "$HELPER" "$PERMIT_FILE" "$ENV_FILE" \
    "$state_file" "$state_key" "$phase" "$TRANSACTION_ID" "$PLAN_DIGEST" \
    "$ROLE" "$RUNTIME_SHA" "$ARTIFACT_DIGEST" "$$" <<'NODE'
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
const [helperPath,permitFile,envFile,stateFile,stateKey,phase,transactionId,
  planDigest,role,runtimeSha,artifactDigest,controllerPidRaw] = process.argv.slice(2);
const helper = await import(pathToFileURL(helperPath).href);
if (!['apply', 'rollback', 'committed_recovery'].includes(phase)) {
  throw new Error('runtime permit phase is invalid');
}
const persisted = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
const state = persisted.plan?.[stateKey] ?? persisted[stateKey];
const configuredFlags = helper.readCapabilityFlagState(fs.readFileSync(envFile, 'utf8'));
if (JSON.stringify(state) !== JSON.stringify(configuredFlags)) {
  throw new Error('runtime permit configured state does not match exact environment bytes');
}
const controllerPid = Number(controllerPidRaw);
if (!Number.isSafeInteger(controllerPid) || controllerPid < 1) {
  throw new Error('runtime permit controller PID is invalid');
}
const bootId = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
const stat = fs.readFileSync(`/proc/${controllerPid}/stat`, 'utf8').trim();
const close = stat.lastIndexOf(')');
const fieldsFromState = close > 0 ? stat.slice(close + 2).split(/\s+/u) : [];
const startTicks = fieldsFromState[19];
if (!/^[0-9a-f-]{16,64}$/iu.test(bootId) || !/^[0-9]+$/u.test(startTicks ?? '')) {
  throw new Error('runtime permit controller identity is unavailable');
}
const environmentSource = fs.readFileSync(envFile, 'utf8');
const issued = new Date();
const permit = {
  schema: 'nexus.chat-capability-runtime-permit.v1',
  transactionId,
  planDigest,
  role,
  runtimeSha,
  artifactDigest,
  phase,
  environmentSha256: createHash('sha256').update(environmentSource).digest('hex'),
  configuredFlags,
  controller: { pid: controllerPid, startTicks, bootId },
  issuedAt: issued.toISOString(),
  expiresAt: new Date(issued.getTime() + 5 * 60_000).toISOString(),
};
if (fs.existsSync(permitFile)) {
  const existing = fs.lstatSync(permitFile);
  if (!existing.isFile() || existing.isSymbolicLink()) {
    throw new Error('existing runtime permit path is unsafe');
  }
}
const temporary = `${permitFile}.next-${controllerPid}`;
const descriptor = fs.openSync(temporary, 'wx', 0o600);
try {
  fs.writeFileSync(descriptor, `${JSON.stringify(permit, null, 2)}\n`);
  fs.fsyncSync(descriptor);
} finally {
  fs.closeSync(descriptor);
}
fs.renameSync(temporary, permitFile);
const parent = fs.openSync(path.dirname(permitFile), 'r');
try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
NODE
}

write_minimal_failure_receipt() {
  [ -n "$TRANSACTION_ID" ] || return 0
  local schema='nexus.chat-capability-flag-attempt.v1'
  [ "$COMMAND" = apply-secrets ] && schema='nexus.chat-capability-secret-attempt.v1'
  [ "$COMMAND" = apply-shadow-hook ] && schema='nexus.chat-shadow-route-hook-attempt.v1'
  local temporary
  temporary="$(mktemp "$STATE_ROOT/.failure.XXXXXX")"
  "$NODE_BIN" - "$temporary" "$schema" "$TRANSACTION_ID" "$ROLE" \
    "$RUNTIME_SHA" "$ARTIFACT_DIGEST" "$PLAN_DIGEST" "$STARTED_AT" <<'NODE'
const fs = require('node:fs');
const [file,schema,transactionId,role,runtimeSha,artifactDigest,planDigest,startedAt] = process.argv.slice(2);
fs.writeFileSync(file, `${JSON.stringify({
  schema, transactionId, role, runtimeSha, artifactDigest, planDigest,
  status: 'failed', phase: 'precondition', startedAt,
  completedAt: new Date().toISOString(), rollback: { status: 'not_required' },
}, null, 2)}\n`, { mode: 0o600 });
NODE
  atomic_write_json "$STATE_ROOT/$ROLE.json" "$temporary"
  rm -f -- "$temporary"
  RECEIPT_WRITTEN=true
}

restore_environment() {
  local backup="$1"
  [ -f "$backup" ] && [ ! -L "$backup" ] || return 1
  "$NODE_BIN" --input-type=module - "$HELPER" "$ENV_FILE" "$backup" \
    "$CLAIM_PRIVATE" <<'NODE'
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
const [helperPath, environment, backup, privateFile] = process.argv.slice(2);
const helper = await import(pathToFileURL(helperPath).href);
const currentContents = fs.readFileSync(environment, 'utf8');
const preimageContents = fs.readFileSync(backup, 'utf8');
const privateState = JSON.parse(fs.readFileSync(privateFile, 'utf8'));
const mutation = privateState.mutation;
const expectedPreimageSha256 = mutation?.preimageSha256
  ?? privateState.environmentPrecondition?.sha256;
const observedPreimageSha256 = createHash('sha256')
  .update(Buffer.from(preimageContents)).digest('hex');
if (!/^[0-9a-f]{64}$/u.test(expectedPreimageSha256 ?? '')
    || observedPreimageSha256 !== expectedPreimageSha256) {
  throw new Error('private rollback preimage hash is invalid');
}
if (currentContents === preimageContents) process.exit(0);
if (!mutation) {
  throw new Error('private rollback mutation precondition is absent');
}
helper.prepareDotenvRollbackRestoration({
  currentContents,
  expectedMutatedSha256: mutation.mutatedSha256,
  preimageContents,
  expectedPreimageSha256: mutation.preimageSha256,
});
helper.restoreCapabilitySecretDotenvFile({
  filePath: environment,
  backupPath: backup,
  expectedContents: currentContents,
});
NODE
}

write_rollback_receipt() {
  local rollback_status="$1"
  local temporary
  temporary="$(mktemp "$STATE_ROOT/.rollback.XXXXXX")"
  "$NODE_BIN" --input-type=module - "$HELPER" "$CLAIM_PLAN" "$temporary" \
    "$TRANSACTION_KIND" "$TRANSACTION_ID" "$STARTED_AT" "$rollback_status" <<'NODE'
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
const [helperPath,planFile,file,kind,transactionId,startedAt,rollbackStatus] = process.argv.slice(2);
const helper = await import(pathToFileURL(helperPath).href);
const persisted = JSON.parse(fs.readFileSync(planFile, 'utf8'));
const plan = persisted.plan ?? persisted;
const failed = rollbackStatus === 'rollback_failed';
const receipt = kind === 'secret'
  ? helper.buildCapabilitySecretReceipt({
      plan,
      transactionId,
      status: rollbackStatus,
      startedAt,
      completedAt: new Date().toISOString(),
      health: {
        backend: failed ? 'failed' : 'passed',
        identity: failed ? 'failed' : 'passed',
      },
      rollback: { status: rollbackStatus },
    })
  : kind === 'shadow_hook'
    ? helper.buildShadowRouteHookReceipt({
      plan,
      transactionId,
      status: rollbackStatus,
      startedAt,
      completedAt: new Date().toISOString(),
      health: {
        backend: failed ? 'failed' : 'passed',
        identity: failed ? 'failed' : 'passed',
        shadowHook: failed ? 'failed' : 'passed',
      },
      rollback: { status: rollbackStatus },
    })
    : helper.buildCapabilityFlagReceipt({
      plan,
      transactionId,
      status: rollbackStatus,
      startedAt,
      completedAt: new Date().toISOString(),
      health: {
        backend: failed ? 'failed' : 'passed',
        content: failed ? 'failed' : 'passed',
        identity: failed ? 'failed' : 'passed',
      },
      rollback: { status: rollbackStatus },
    });
fs.writeFileSync(file, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
NODE
  atomic_write_json "$STATE_ROOT/$ROLE.json" "$temporary"
  rm -f -- "$temporary"
  RECEIPT_WRITTEN=true
}

on_exit() {
  local status=$?
  trap - EXIT INT TERM
  if [ "$status" -ne 0 ] && { [ "$COMMAND" = apply ] || [ "$COMMAND" = apply-secrets ] \
      || [ "$COMMAND" = apply-shadow-hook ]; }; then
    if [ "$ROLLBACK_ARMED" = true ] && [ "$ENV_MUTATED" = true ]; then
      local rollback_plan="$CLAIM_PLAN"
      local rollback_state='configuredBefore'
      if [ "$TRANSACTION_KIND" = secret ]; then
        rollback_plan="$CLAIM_PRIVATE"
        rollback_state='configuredFlags'
      elif [ "$TRANSACTION_KIND" = shadow_hook ]; then
        rollback_plan="$CLAIM_PRIVATE"
        rollback_state='configuredFlags'
      fi
      if restore_environment "$BACKUP_FILE" \
          && write_runtime_permit rollback "$rollback_plan" "$rollback_state" \
          && restart_backend; then
        local restored_snapshot restored_pid
        restored_snapshot="$(mktemp "$STATE_ROOT/.restored-pm2.XXXXXX")"
        if write_pm2_snapshot "$restored_snapshot"; then
          restored_pid="$($NODE_BIN -e 'const fs=require("node:fs");process.stdout.write(String(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).backend.pid))' "$restored_snapshot")"
          if wait_healthy "$rollback_plan" "$rollback_state" "$restored_pid" authorized; then
            local rollback_runtime_valid=true
            if [ "$TRANSACTION_KIND" = shadow_hook ]; then
              local rollback_desired rollback_dedicated
              rollback_desired="$($NODE_BIN -e 'const p=require(process.argv[1]);process.stdout.write(String(p.recorderBefore.user))' "$CLAIM_PLAN")"
              rollback_dedicated="$($NODE_BIN -e 'const p=require(process.argv[1]);process.stdout.write(String(p.dedicatedTenantId))' "$CLAIM_PLAN")"
              assert_shadow_route_hook_runtime_state "$rollback_desired" "$rollback_dedicated" \
                || rollback_runtime_valid=false
            fi
            if [ "$rollback_runtime_valid" = true ]; then
              write_rollback_receipt rolled_back
              durable_remove "$BACKUP_FILE"
              durable_remove "$PERMIT_FILE"
            else
              write_rollback_receipt rollback_failed
            fi
          else
            write_rollback_receipt rollback_failed
          fi
        else
          write_rollback_receipt rollback_failed
        fi
        rm -f -- "${restored_snapshot:-}"
      else
        write_rollback_receipt rollback_failed
      fi
    elif [ "$RECEIPT_WRITTEN" = false ]; then
      write_minimal_failure_receipt || true
    fi
  fi
  if [ -n "$TRANSACTION_ID" ]; then
    rm -f -- "$ENV_FILE.next-$TRANSACTION_ID"
    [ -z "$CLAIM_PRIVATE" ] || rm -f -- "$CLAIM_PRIVATE.next-$TRANSACTION_ID"
  fi
  rm -f -- "${EVIDENCE_FILE:-}" "${RAW_EVIDENCE_FILE:-}" \
    "${HEALTH_EVIDENCE_FILE:-}" "${SHADOW_HOOK_RECEIPT_FILE:-}" \
    "${DASHBOARD_EVIDENCE_FILE:-}" \
    "${MONITOR_EVIDENCE_FILE:-}" "${STAGING_ENABLE_RECEIPT_FILE:-}" \
    "${PM2_BEFORE_TEMP:-}" "${PM2_AFTER_TEMP:-}" \
    "${OBSERVATION_LEDGER_BEFORE_FILE:-}" "${OBSERVATION_LEDGER_AFTER_FILE:-}" \
    "${OBSERVATION_HEALTH_BEFORE_FILE:-}"
  if [ -n "${OBSERVATION_TEMP_DIR:-}" ] && [ -d "$OBSERVATION_TEMP_DIR" ]; then
    find "$OBSERVATION_TEMP_DIR" -mindepth 1 -maxdepth 1 -type f -delete 2>/dev/null || true
    rmdir "$OBSERVATION_TEMP_DIR" 2>/dev/null || true
  fi
  exit "$status"
}
trap on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

recover_interrupted_transaction() {
  local saved_command="$COMMAND"
  local saved_kind="$TRANSACTION_KIND"
  local saved_transaction_id="$TRANSACTION_ID"
  local saved_plan_digest="$PLAN_DIGEST"
  local saved_started_at="$STARTED_AT"
  local saved_claim_plan="$CLAIM_PLAN"
  local saved_claim_private="$CLAIM_PRIVATE"
  local saved_claim_receipt="$CLAIM_RECEIPT"
  local backups=()
  shopt -s nullglob
  backups=("$BASE_DIR"/.env.before-chat-capability-*)
  shopt -u nullglob
  [ "${#backups[@]}" -le 1 ] || die 'multiple interrupted capability transactions require manual recovery'
  [ "${#backups[@]}" -eq 1 ] || return 0

  COMMAND='recover'
  BACKUP_FILE="${backups[0]}"
  [ -f "$BACKUP_FILE" ] && [ ! -L "$BACKUP_FILE" ] \
    || die 'interrupted capability backup is unsafe'
  TRANSACTION_ID="${BACKUP_FILE##*.env.before-chat-capability-}"
  [[ "$TRANSACTION_ID" =~ ^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{12}$ ]] \
    || die 'interrupted capability transaction ID is invalid'

  local flag_plan="$STATE_ROOT/claims/$ROLE-$TRANSACTION_ID.flag-plan.json"
  local flag_private="$STATE_ROOT/claims/$ROLE-$TRANSACTION_ID.flag-private.json"
  local secret_plan="$STATE_ROOT/claims/$ROLE-$TRANSACTION_ID.secret-plan.json"
  local secret_private="$STATE_ROOT/claims/$ROLE-$TRANSACTION_ID.secret-private.json"
  local shadow_hook_plan="$STATE_ROOT/claims/$ROLE-$TRANSACTION_ID.shadow-hook-plan.json"
  local shadow_hook_private="$STATE_ROOT/claims/$ROLE-$TRANSACTION_ID.shadow-hook-private.json"
  if [ -f "$flag_plan" ] && [ -f "$flag_private" ] \
      && [ ! -e "$secret_plan" ] && [ ! -e "$secret_private" ] \
      && [ ! -e "$shadow_hook_plan" ] && [ ! -e "$shadow_hook_private" ]; then
    TRANSACTION_KIND='flag'
    CLAIM_PLAN="$flag_plan"
    CLAIM_PRIVATE="$flag_private"
    CLAIM_RECEIPT="$STATE_ROOT/claims/$ROLE-$TRANSACTION_ID.flag-receipt.json"
  elif [ -f "$secret_plan" ] && [ -f "$secret_private" ] \
      && [ ! -e "$flag_plan" ] && [ ! -e "$flag_private" ] \
      && [ ! -e "$shadow_hook_plan" ] && [ ! -e "$shadow_hook_private" ]; then
    TRANSACTION_KIND='secret'
    CLAIM_PLAN="$secret_plan"
    CLAIM_PRIVATE="$secret_private"
    CLAIM_RECEIPT="$STATE_ROOT/claims/$ROLE-$TRANSACTION_ID.secret-receipt.json"
  elif [ -f "$shadow_hook_plan" ] && [ -f "$shadow_hook_private" ] \
      && [ ! -e "$flag_plan" ] && [ ! -e "$flag_private" ] \
      && [ ! -e "$secret_plan" ] && [ ! -e "$secret_private" ]; then
    TRANSACTION_KIND='shadow_hook'
    CLAIM_PLAN="$shadow_hook_plan"
    CLAIM_PRIVATE="$shadow_hook_private"
    CLAIM_RECEIPT="$STATE_ROOT/claims/$ROLE-$TRANSACTION_ID.shadow-hook-receipt.json"
  else
    die 'interrupted capability transaction claim is missing or ambiguous'
  fi
  [ ! -L "$CLAIM_PLAN" ] && [ ! -L "$CLAIM_PRIVATE" ] \
    || die 'interrupted capability claim is symbolic'

  PLAN_DIGEST="$($NODE_BIN - "$CLAIM_PLAN" <<'NODE'
const fs = require('node:fs');
const persisted = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const plan = persisted.plan ?? persisted;
if (!/^sha256:[0-9a-f]{64}$/u.test(plan.planDigest ?? '')) process.exit(1);
process.stdout.write(plan.planDigest);
NODE
)" || die 'interrupted capability claim digest is invalid'
  STARTED_AT="$($NODE_BIN - "$CLAIM_PLAN" <<'NODE'
const fs = require('node:fs');
const persisted = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const plan = persisted.plan ?? persisted;
const value = persisted.claimedAt ?? plan.generatedAt;
if (!Number.isFinite(Date.parse(value))) process.exit(1);
process.stdout.write(value);
NODE
)" || die 'interrupted capability claim timestamp is invalid'

  if [ -f "$CLAIM_RECEIPT" ] && [ ! -L "$CLAIM_RECEIPT" ]; then
    "$NODE_BIN" --input-type=module - "$HELPER" "$CLAIM_RECEIPT" \
      "$CLAIM_PLAN" "$CLAIM_PRIVATE" "$ENV_FILE" "$TRANSACTION_KIND" \
      "$ROLE" "$RUNTIME_SHA" "$ARTIFACT_DIGEST" "$TRANSACTION_ID" <<'NODE'
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
const [helperPath,receiptFile,planFile,privateFile,envFile,kind,
  role,runtimeSha,artifactDigest,transactionId] = process.argv.slice(2);
const helper = await import(pathToFileURL(helperPath).href);
const receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
const persisted = JSON.parse(fs.readFileSync(planFile, 'utf8'));
const plan = persisted.plan ?? persisted;
const privateState = JSON.parse(fs.readFileSync(privateFile, 'utf8'));
const validated = kind === 'secret'
  ? helper.validateCapabilitySecretReceipt(receipt)
  : kind === 'shadow_hook'
    ? helper.validateShadowRouteHookReceipt(receipt)
    : helper.validateCapabilityFlagReceipt(receipt);
if (validated.status !== 'passed' || validated.transactionId !== transactionId
    || validated.role !== role || validated.runtimeSha !== runtimeSha
    || validated.artifactDigest !== artifactDigest
    || validated.planDigest !== plan.planDigest) process.exit(1);
const currentHash = createHash('sha256').update(fs.readFileSync(envFile)).digest('hex');
const expectedHash = privateState.mutation?.mutatedSha256
  ?? privateState.environmentPrecondition?.sha256;
if (currentHash !== expectedHash) process.exit(1);
NODE
    local committed_snapshot committed_pid committed_plan committed_state
    committed_snapshot="$(mktemp "$STATE_ROOT/.recovered-commit-pm2.XXXXXX")"
    write_pm2_snapshot "$committed_snapshot"
    committed_pid="$($NODE_BIN -e 'const fs=require("node:fs");process.stdout.write(String(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).backend.pid))' "$committed_snapshot")"
    committed_plan="$CLAIM_PLAN"
    committed_state='configuredAfter'
    if [ "$TRANSACTION_KIND" = secret ]; then
      committed_plan="$CLAIM_PRIVATE"
      committed_state='configuredFlags'
    elif [ "$TRANSACTION_KIND" = shadow_hook ]; then
      committed_plan="$CLAIM_PRIVATE"
      committed_state='configuredFlags'
    fi
    write_runtime_permit committed_recovery "$committed_plan" "$committed_state"
    wait_healthy "$committed_plan" "$committed_state" "$committed_pid" authorized \
      || die 'interrupted committed capability transaction is unhealthy'
    if [ "$TRANSACTION_KIND" = shadow_hook ]; then
      local committed_desired committed_dedicated
      committed_desired="$($NODE_BIN -e 'const p=require(process.argv[1]);process.stdout.write(String(p.desiredValue))' "$CLAIM_PLAN")"
      committed_dedicated="$($NODE_BIN -e 'const p=require(process.argv[1]);process.stdout.write(String(p.dedicatedTenantId))' "$CLAIM_PLAN")"
      assert_shadow_route_hook_runtime_state "$committed_desired" "$committed_dedicated" \
        || die 'interrupted committed shadow route hook state is invalid'
    fi
    durable_remove "$BACKUP_FILE"
    durable_remove "$PERMIT_FILE"
    wait_healthy "$committed_plan" "$committed_state" "$committed_pid" clear \
      || die 'interrupted committed capability guard did not clear'
    if [ "$TRANSACTION_KIND" = shadow_hook ]; then
      assert_shadow_route_hook_runtime_state "$committed_desired" "$committed_dedicated" \
        || die 'committed shadow route hook state changed after guard clear'
    fi
    atomic_write_json "$STATE_ROOT/$ROLE.json" "$CLAIM_RECEIPT"
    rm -f -- "$committed_snapshot"
  else
    local restored_snapshot restored_pid restored_plan restored_state
    restored_plan="$CLAIM_PLAN"
    restored_state='configuredBefore'
    if [ "$TRANSACTION_KIND" = secret ]; then
      restored_plan="$CLAIM_PRIVATE"
      restored_state='configuredFlags'
    elif [ "$TRANSACTION_KIND" = shadow_hook ]; then
      restored_plan="$CLAIM_PRIVATE"
      restored_state='configuredFlags'
    fi
    restore_environment "$BACKUP_FILE" \
      || die 'interrupted capability transaction cannot restore its exact preimage'
    write_runtime_permit rollback "$restored_plan" "$restored_state"
    restart_backend
    restored_snapshot="$(mktemp "$STATE_ROOT/.recovered-rollback-pm2.XXXXXX")"
    write_pm2_snapshot "$restored_snapshot"
    restored_pid="$($NODE_BIN -e 'const fs=require("node:fs");process.stdout.write(String(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).backend.pid))' "$restored_snapshot")"
    wait_healthy "$restored_plan" "$restored_state" "$restored_pid" authorized \
      || die 'interrupted capability rollback health verification failed'
    if [ "$TRANSACTION_KIND" = shadow_hook ]; then
      local restored_desired restored_dedicated
      restored_desired="$($NODE_BIN -e 'const p=require(process.argv[1]);process.stdout.write(String(p.recorderBefore.user))' "$CLAIM_PLAN")"
      restored_dedicated="$($NODE_BIN -e 'const p=require(process.argv[1]);process.stdout.write(String(p.dedicatedTenantId))' "$CLAIM_PLAN")"
      assert_shadow_route_hook_runtime_state "$restored_desired" "$restored_dedicated" \
        || die 'interrupted shadow route hook rollback state is invalid'
    fi
    write_rollback_receipt rolled_back
    durable_remove "$BACKUP_FILE"
    durable_remove "$PERMIT_FILE"
    rm -f -- "$restored_snapshot"
  fi

  COMMAND="$saved_command"
  TRANSACTION_KIND="$saved_kind"
  TRANSACTION_ID="$saved_transaction_id"
  PLAN_DIGEST="$saved_plan_digest"
  STARTED_AT="$saved_started_at"
  CLAIM_PLAN="$saved_claim_plan"
  CLAIM_PRIVATE="$saved_claim_private"
  CLAIM_RECEIPT="$saved_claim_receipt"
  BACKUP_FILE=''
  RECEIPT_WRITTEN=false
  ROLLBACK_ARMED=false
  ENV_MUTATED=false
}

recover_committed_receipt_gap() {
  local candidates=()
  shopt -s nullglob
  candidates=(
    "$STATE_ROOT/claims/$ROLE-"*.flag-receipt.json
    "$STATE_ROOT/claims/$ROLE-"*.secret-receipt.json
    "$STATE_ROOT/claims/$ROLE-"*.shadow-hook-receipt.json
  )
  shopt -u nullglob
  [ "${#candidates[@]}" -gt 0 ] || return 0
  local external="$STATE_ROOT/$ROLE.json"
  local candidate
  candidate="$($NODE_BIN --input-type=module - "$HELPER" "$ROLE" "$RUNTIME_SHA" \
    "$ARTIFACT_DIGEST" "$external" "${candidates[@]}" <<'NODE'
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
const [helperPath,role,runtimeSha,artifactDigest,external,...files] = process.argv.slice(2);
const helper = await import(pathToFileURL(helperPath).href);
const parsed = files.map((file) => {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('claim receipt is unsafe');
  const receipt = JSON.parse(fs.readFileSync(file, 'utf8'));
  const validated = file.endsWith('.secret-receipt.json')
    ? helper.validateCapabilitySecretReceipt(receipt)
    : file.endsWith('.shadow-hook-receipt.json')
      ? helper.validateShadowRouteHookReceipt(receipt)
      : helper.validateCapabilityFlagReceipt(receipt);
  if (validated.status !== 'passed' || validated.role !== role
      || validated.runtimeSha !== runtimeSha
      || validated.artifactDigest !== artifactDigest) return null;
  return { file, receipt: validated };
}).filter(Boolean).sort((left, right) => (
  Date.parse(right.receipt.completedAt) - Date.parse(left.receipt.completedAt)
));
if (parsed.length === 0) process.exit(0);
const latest = parsed[0];
if (fs.existsSync(external)) {
  const stat = fs.lstatSync(external);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('external receipt is unsafe');
  const receipt = JSON.parse(fs.readFileSync(external, 'utf8'));
  if (receipt.transactionId === latest.receipt.transactionId
      || (Number.isFinite(Date.parse(receipt.completedAt))
        && Date.parse(receipt.completedAt) >= Date.parse(latest.receipt.completedAt))) {
    process.exit(0);
  }
}
process.stdout.write(latest.file);
NODE
)" || die 'cannot classify committed capability receipt state'
  [ -n "$candidate" ] || return 0
  [[ "$candidate" == "$STATE_ROOT/claims/$ROLE-"* ]] \
    || die 'committed capability receipt path escaped its claim root'

  local filename="${candidate##*/}"
  local gap_kind gap_id claim_plan claim_private state_key health_plan
  if [[ "$filename" =~ ^$ROLE-([0-9]{8}T[0-9]{6}Z-[0-9a-f]{12})\.flag-receipt\.json$ ]]; then
    gap_kind='flag'
    gap_id="${BASH_REMATCH[1]}"
    claim_plan="$STATE_ROOT/claims/$ROLE-$gap_id.flag-plan.json"
    claim_private="$STATE_ROOT/claims/$ROLE-$gap_id.flag-private.json"
    health_plan="$claim_plan"
    state_key='configuredAfter'
  elif [[ "$filename" =~ ^$ROLE-([0-9]{8}T[0-9]{6}Z-[0-9a-f]{12})\.secret-receipt\.json$ ]]; then
    gap_kind='secret'
    gap_id="${BASH_REMATCH[1]}"
    claim_plan="$STATE_ROOT/claims/$ROLE-$gap_id.secret-plan.json"
    claim_private="$STATE_ROOT/claims/$ROLE-$gap_id.secret-private.json"
    health_plan="$claim_private"
    state_key='configuredFlags'
  elif [[ "$filename" =~ ^$ROLE-([0-9]{8}T[0-9]{6}Z-[0-9a-f]{12})\.shadow-hook-receipt\.json$ ]]; then
    gap_kind='shadow_hook'
    gap_id="${BASH_REMATCH[1]}"
    claim_plan="$STATE_ROOT/claims/$ROLE-$gap_id.shadow-hook-plan.json"
    claim_private="$STATE_ROOT/claims/$ROLE-$gap_id.shadow-hook-private.json"
    health_plan="$claim_private"
    state_key='configuredFlags'
  else
    die 'committed capability receipt filename is invalid'
  fi
  [ -f "$claim_plan" ] && [ ! -L "$claim_plan" ] \
    && [ -f "$claim_private" ] && [ ! -L "$claim_private" ] \
    || die 'committed capability receipt claim is unavailable'

  "$NODE_BIN" --input-type=module - "$HELPER" "$candidate" "$claim_plan" \
    "$gap_kind" "$gap_id" <<'NODE'
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
const [helperPath,receiptFile,planFile,kind,transactionId] = process.argv.slice(2);
const helper = await import(pathToFileURL(helperPath).href);
const receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
const persisted = JSON.parse(fs.readFileSync(planFile, 'utf8'));
const plan = persisted.plan ?? persisted;
const validated = kind === 'secret'
  ? helper.validateCapabilitySecretReceipt(receipt)
  : kind === 'shadow_hook'
    ? helper.validateShadowRouteHookReceipt(receipt)
    : helper.validateCapabilityFlagReceipt(receipt);
if (validated.transactionId !== transactionId
    || validated.planDigest !== plan.planDigest
    || validated.runtimeSha !== plan.runtimeSha
    || validated.artifactDigest !== plan.artifactDigest
    || validated.role !== plan.role) process.exit(1);
NODE

  "$NODE_BIN" - "$claim_private" "$ENV_FILE" <<'NODE'
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const [privateFile,envFile] = process.argv.slice(2);
const privateState = JSON.parse(fs.readFileSync(privateFile, 'utf8'));
const expected = privateState.mutation?.mutatedSha256
  ?? privateState.environmentPrecondition?.sha256;
const observed = createHash('sha256').update(fs.readFileSync(envFile)).digest('hex');
if (!/^[0-9a-f]{64}$/u.test(expected ?? '') || observed !== expected) process.exit(1);
NODE
  local gap_snapshot gap_pid
  gap_snapshot="$(mktemp "$STATE_ROOT/.receipt-gap-pm2.XXXXXX")"
  write_pm2_snapshot "$gap_snapshot"
  gap_pid="$($NODE_BIN -e 'const fs=require("node:fs");process.stdout.write(String(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).backend.pid))' "$gap_snapshot")"
  wait_healthy "$health_plan" "$state_key" "$gap_pid" clear \
    || die 'committed capability receipt gap is unhealthy'
  if [ "$gap_kind" = shadow_hook ]; then
    local gap_desired gap_dedicated
    gap_desired="$($NODE_BIN -e 'const p=require(process.argv[1]);process.stdout.write(String(p.desiredValue))' "$claim_plan")"
    gap_dedicated="$($NODE_BIN -e 'const p=require(process.argv[1]);process.stdout.write(String(p.dedicatedTenantId))' "$claim_plan")"
    assert_shadow_route_hook_runtime_state "$gap_desired" "$gap_dedicated" \
      || die 'committed shadow route hook receipt gap state is invalid'
  fi
  atomic_write_json "$external" "$candidate"
  rm -f -- "$gap_snapshot"
}

recover_interrupted_transaction
recover_committed_receipt_gap

reuse_current_pending_flag_plan() {
  [ -f "$PENDING_PLAN" ] && [ ! -L "$PENDING_PLAN" ] || return 1
  local output status
  output="$(mktemp "$STATE_ROOT/.existing-plan.XXXXXX")"
  set +e
  "$NODE_BIN" --input-type=module - "$HELPER" "$ENV_FILE" "$PENDING_PLAN" \
    "$SEQUENCE_FILE" "$PM2_BEFORE_TEMP" "$RELEASE_DIR" "$ROLE" \
    "$RUNTIME_SHA" "$ARTIFACT_DIGEST" "$FLAG" "$DESIRED_VALUE" \
    "$TRANSITION_REASON" > "$output" <<'NODE'
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
const [helperPath,envFile,pendingPlan,sequenceFile,pm2File,release,role,
  runtimeSha,artifactDigest,flag,desiredValue,transitionReason] = process.argv.slice(2);
const helper = await import(pathToFileURL(helperPath).href);
const record = JSON.parse(fs.readFileSync(pendingPlan, 'utf8'));
const plan = record.plan;
if (plan.role !== role || plan.runtimeSha !== runtimeSha
    || plan.artifactDigest !== artifactDigest || plan.flag !== flag
    || plan.desiredValue !== (desiredValue === 'true')
    || plan.transitionReason !== transitionReason) {
  throw new Error('a different unconsumed pending plan already exists');
}
const rebuilt = helper.buildCapabilityFlagPlan({
  role: plan.role,
  runtimeSha: plan.runtimeSha,
  artifactDigest: plan.artifactDigest,
  flag: plan.flag,
  desiredValue: plan.desiredValue,
  configuredFlags: plan.configuredBefore,
  previousPlanSequence: plan.previousPlanSequence,
  transitionReason: plan.transitionReason,
  evidenceAttestation: plan.evidenceAttestation,
  stagingPrerequisite: plan.stagingPrerequisite,
  generatedAt: plan.generatedAt,
});
if (JSON.stringify(rebuilt) !== JSON.stringify(plan)) {
  throw new Error('pending plan bytes do not reconstruct exactly');
}
const source = fs.readFileSync(envFile, 'utf8');
const pm2 = JSON.parse(fs.readFileSync(pm2File, 'utf8'));
const privatePreconditions = {
  envSha256: createHash('sha256').update(Buffer.from(source)).digest('hex'),
  releaseDir: release,
  backendProcess: {
    name: pm2.backend.name,
    pid: pm2.backend.pid,
    pmUptimeMs: pm2.backend.pmUptimeMs,
  },
  contentProcess: {
    name: pm2.content.name,
    pid: pm2.content.pid,
    pmUptimeMs: pm2.content.pmUptimeMs,
  },
};
const latest = fs.existsSync(sequenceFile)
  ? Number(fs.readFileSync(sequenceFile, 'utf8').trim())
  : 0;
const stale = Date.now() - Date.parse(record.createdAt) > 60 * 60 * 1000
  || record.envSha256 !== privatePreconditions.envSha256
  || record.releaseDir !== privatePreconditions.releaseDir
  || JSON.stringify(record.backendProcess) !== JSON.stringify(privatePreconditions.backendProcess)
  || JSON.stringify(record.contentProcess) !== JSON.stringify(privatePreconditions.contentProcess);
if (stale) process.exit(2);
helper.createPendingCapabilityPlanRecord({
  latestPlanSequence: latest,
  existingPending: record,
  plan: rebuilt,
  privatePreconditions,
  createdAt: record.createdAt,
});
process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
NODE
  status=$?
  set -e
  case "$status" in
    0) cat "$output"; rm -f -- "$output"; return 0 ;;
    2) rm -f -- "$output"; return 1 ;;
    *) rm -f -- "$output"; die 'existing pending flag plan is invalid or belongs to another transition' ;;
  esac
}

# Inspection and apply bodies below use the pure helper for plan/dotenv policy;
# the shell owns host identity, locks, PM2, health, and rollback.
case "$COMMAND" in
  inspect)
    PM2_BEFORE_TEMP="$(mktemp "$STATE_ROOT/.pm2-before.XXXXXX")"
    write_pm2_snapshot "$PM2_BEFORE_TEMP"
    if reuse_current_pending_flag_plan; then
      exit 0
    fi
    collect_native_evidence_sources
    "$NODE_BIN" --input-type=module - "$HELPER" "$ENV_FILE" "$PENDING_PLAN" \
      "$SEQUENCE_FILE" "$PM2_BEFORE_TEMP" "$RELEASE_DIR" \
      "$ROLE" "$RUNTIME_SHA" "$ARTIFACT_DIGEST" "$FLAG" "$DESIRED_VALUE" \
      "$TRANSITION_REASON" "$RAW_EVIDENCE_FILE" "$HEALTH_EVIDENCE_FILE" \
      "$DASHBOARD_EVIDENCE_FILE" "$STATE_ROOT/claims" \
      "$STAGING_RELEASE_DIR" "$STAGING_SMOKE_EVIDENCE_FILE" \
      "$MONITOR_EVIDENCE_FILE" "$STAGING_ENABLE_RECEIPT_FILE" \
      "$STAGING_OBSERVATION_EVIDENCE_FILE" "$SHADOW_HOOK_RECEIPT_FILE" <<'NODE'
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
const [helperPath,envFile,pendingPlan,sequenceFile,pm2File,release,
  role,runtimeSha,artifactDigest,flag,desiredValue,transitionReason,rawEvidenceFile,
  healthEvidenceFile,dashboardEvidenceFile,claimsRoot,stagingRelease,smokeEvidenceFile,
  monitorEvidenceFile,preselectedReceiptFile,observationEvidenceFile,
  shadowHookReceiptFile] = process.argv.slice(2);
const helper = await import(pathToFileURL(helperPath).href);
const source = fs.readFileSync(envFile, 'utf8');
const configuredFlags = helper.readCapabilityFlagState(source);
let previousPlanSequence = 0;
if (fs.existsSync(sequenceFile)) {
  const raw = fs.readFileSync(sequenceFile, 'utf8').trim();
  if (!/^(?:0|[1-9][0-9]*)$/u.test(raw)) throw new Error('invalid sequence state');
  previousPlanSequence = Number(raw);
}
let existingRecord = fs.existsSync(pendingPlan)
  ? JSON.parse(fs.readFileSync(pendingPlan, 'utf8'))
  : null;
const pm2 = JSON.parse(fs.readFileSync(pm2File, 'utf8'));
const envSha256 = createHash('sha256').update(Buffer.from(source)).digest('hex');
const privatePreconditions = {
  envSha256,
  releaseDir: release,
  backendProcess: {
    name: pm2.backend.name,
    pid: pm2.backend.pid,
    pmUptimeMs: pm2.backend.pmUptimeMs,
  },
  contentProcess: {
    name: pm2.content.name,
    pid: pm2.content.pid,
    pmUptimeMs: pm2.content.pmUptimeMs,
  },
};
const sameProcess = (left, right) => left?.name === right.name
  && left?.pid === right.pid && left?.pmUptimeMs === right.pmUptimeMs;
if (existingRecord !== null) {
  const expired = Date.now() - Date.parse(existingRecord.createdAt) > 60 * 60 * 1000;
  const stale = existingRecord.envSha256 !== privatePreconditions.envSha256
    || existingRecord.releaseDir !== privatePreconditions.releaseDir
    || !sameProcess(existingRecord.backendProcess, privatePreconditions.backendProcess)
    || !sameProcess(existingRecord.contentProcess, privatePreconditions.contentProcess);
  if (expired || stale) {
    const archiveRoot = path.join(path.dirname(pendingPlan), 'expired');
    fs.mkdirSync(archiveRoot, { recursive: true, mode: 0o700 });
    const archive = path.join(archiveRoot, `${role}.flag.${existingRecord.planDigest.slice(7)}.json`);
    if (fs.existsSync(archive)) throw new Error('stale pending flag plan archive already exists');
    fs.renameSync(pendingPlan, archive);
    const parent = fs.openSync(archiveRoot, 'r');
    try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
    existingRecord = null;
  }
}
let generatedAt = existingRecord?.plan?.generatedAt ?? null;
const readRaw = (file, label) => {
  if (!file) throw new Error(`${label} path is unavailable`);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new Error(`${label} path is unsafe`);
  }
  const raw = fs.readFileSync(file, 'utf8');
  if (!raw.trim()) throw new Error(`${label} is empty`);
  return raw;
};
let evidenceAttestation = existingRecord?.plan?.evidenceAttestation ?? null;
let stagingPrerequisite = existingRecord?.plan?.stagingPrerequisite ?? null;
if (existingRecord === null && desiredValue === 'true'
    && flag !== 'AI_ROUTING_MANIFEST_KILL') {
  const checkedAt = new Date().toISOString();
  let stagingReceiptRaw = null;
  let stagingReceipt = null;
  let observation = null;
  if (role === 'production') {
    const claimsStat = fs.lstatSync(claimsRoot);
    if (!claimsStat.isDirectory() || claimsStat.isSymbolicLink()) {
      throw new Error('staging flag claim root is unsafe');
    }
    const expectedConfiguredAfter = { ...configuredFlags, [flag]: true };
    const sameState = (value) => Object.keys(expectedConfiguredAfter).length
      === Object.keys(value ?? {}).length
      && Object.entries(expectedConfiguredAfter).every(([key, expected]) => value[key] === expected);
    const candidates = [];
    for (const name of fs.readdirSync(claimsRoot).sort()) {
      const match = name.match(
        /^staging-(\d{8}T\d{6}Z-[0-9a-f]{12})\.flag-receipt\.json$/u,
      );
      if (!match) continue;
      const file = path.join(claimsRoot, name);
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
          || (stat.mode & 0o777) !== 0o600 || stat.uid !== process.getuid()) {
        throw new Error('staging flag claim receipt is unsafe');
      }
      const raw = fs.readFileSync(file, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed?.role !== 'staging' || parsed.runtimeSha !== runtimeSha
          || parsed.artifactDigest !== artifactDigest || parsed.flag !== flag) {
        continue;
      }
      const receipt = helper.validateCapabilityFlagReceipt(parsed);
      if (receipt.transactionId !== match[1]) {
        throw new Error('staging flag claim filename does not match its receipt');
      }
      if (receipt.status === 'passed' && receipt.role === 'staging'
          && receipt.runtimeSha === runtimeSha && receipt.artifactDigest === artifactDigest
          && receipt.flag === flag && receipt.desiredValue === true
          && sameState(receipt.configuredAfter)
          && sameState(receipt.effectiveAfter)) {
        candidates.push({ raw, receipt });
      }
    }
    if (candidates.length === 0) {
      throw new Error('no exact passed staging ON flag claim receipt exists');
    }
    const latestSequence = Math.max(...candidates.map(({ receipt }) => receipt.planSequence));
    const latest = candidates.filter(({ receipt }) => receipt.planSequence === latestSequence);
    if (latest.length !== 1) {
      throw new Error('latest exact passed staging ON flag claim receipt is ambiguous');
    }
    ({ raw: stagingReceiptRaw, receipt: stagingReceipt } = latest[0]);
    const preselectedReceiptRaw = readRaw(
      preselectedReceiptFile,
      'mature preselected staging enable receipt',
    );
    if (preselectedReceiptRaw !== stagingReceiptRaw) {
      throw new Error('latest staging enable receipt changed during evidence collection');
    }
    const observationRaw = readRaw(
      observationEvidenceFile,
      'paired staging observation receipt',
    );
    observation = helper.validateCapabilityObservationReceipt(JSON.parse(observationRaw));
    if (observation.enableReceiptSha256
        !== createHash('sha256').update(stagingReceiptRaw).digest('hex')) {
      throw new Error('paired observation does not bind the exact staging enable receipt');
    }
    stagingPrerequisite = helper.buildProductionStagingCapabilityPrerequisiteFromObservation({
      observationRaw,
      flag,
      runtimeSha,
      artifactDigest,
      checkedAt,
    });
  }
  switch (flag) {
    case 'AI_ROUTING_MANIFEST_CLASSIFIER':
    case 'AI_ROUTING_MANIFEST_ORCHESTRATOR':
    case 'AI_ROUTING_MANIFEST_SHADOW':
    case 'AI_ROUTING_MANIFEST_REGISTRY':
      evidenceAttestation = role === 'staging'
        ? helper.buildCapabilityEvidenceAttestation({
            rawEvidence: readRaw(rawEvidenceFile, 'routing divergence report'),
            flag,
            runtimeSha,
            artifactDigest,
            configuredFlags,
            shadowHookReceiptRaw: readRaw(
              shadowHookReceiptFile,
              'current shadow-hook enable receipt',
            ),
            healthRaw: readRaw(healthEvidenceFile, 'live staging health'),
            checkedAt,
          })
        : stagingReceipt.evidenceAttestation;
      break;
    case 'AI_ROUTING_CLARIFY':
      evidenceAttestation = role === 'staging'
        ? helper.buildClarifyCalibrationEvidenceAttestation({
            calibrationRaw: readRaw(
              path.join(stagingRelease, 'config/routing-calibration.json'),
              'routing calibration',
            ),
            dashboardRaw: readRaw(dashboardEvidenceFile, 'clarify baseline dashboard'),
            healthRaw: readRaw(healthEvidenceFile, 'live staging health'),
            flag,
            runtimeSha,
            artifactDigest,
            configuredFlags,
            checkedAt,
          })
        : observation.flagSpecificEvidence;
      break;
    case 'AI_CLASSIFY_MANIFEST_PROMPT':
      evidenceAttestation = role === 'staging'
        ? helper.buildActionSkillEvidenceAttestation({
            rawEvidence: readRaw(rawEvidenceFile, 'action-skill cache-only gate'),
            healthRaw: readRaw(healthEvidenceFile, 'live staging health'),
            flag,
            runtimeSha,
            artifactDigest,
            configuredFlags,
            checkedAt,
          })
        : observation.flagSpecificEvidence;
      break;
    case 'AI_CROSS_SKILL_EXECUTION':
      evidenceAttestation = role === 'staging'
        ? helper.buildCrossSkillPreflightEvidenceAttestation({
            rawEvidence: readRaw(rawEvidenceFile, 'cross-skill preflight report'),
            healthRaw: readRaw(healthEvidenceFile, 'live staging health'),
            flag,
            runtimeSha,
            artifactDigest,
            configuredFlags,
            checkedAt,
          })
        : observation.flagSpecificEvidence;
      break;
    default:
      throw new Error('native evidence builder is unavailable for the requested enable');
  }
}
generatedAt ??= new Date().toISOString();
const plan = helper.buildCapabilityFlagPlan({
  role, runtimeSha, artifactDigest, flag, desiredValue: desiredValue === 'true',
  configuredFlags, previousPlanSequence, transitionReason, evidenceAttestation,
  stagingPrerequisite,
  generatedAt,
});
const record = helper.createPendingCapabilityPlanRecord({
  latestPlanSequence: previousPlanSequence,
  existingPending: existingRecord,
  plan,
  privatePreconditions,
  createdAt: generatedAt,
});
const atomic = (file, value) => {
  const temporary = `${file}.next-${process.pid}`;
  const descriptor = fs.openSync(temporary, 'wx', 0o600);
  try { fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`); fs.fsyncSync(descriptor); }
  finally { fs.closeSync(descriptor); }
  fs.renameSync(temporary, file);
  const parent = fs.openSync(path.dirname(file), 'r');
  try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
};
if (existingRecord !== null) {
  process.stdout.write(`${JSON.stringify(record.plan, null, 2)}\n`);
  process.exit(0);
}
atomic(pendingPlan, record);
process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
NODE
    ;;

  apply)
    [ "${NEXUS_RELEASE_OWNER_AUTHORIZED:-0}" = 1 ] \
      || die 'apply requires NEXUS_RELEASE_OWNER_AUTHORIZED=1'
    CLAIM_PLAN="$STATE_ROOT/claims/$ROLE-$TRANSACTION_ID.flag-plan.json"
    CLAIM_PRIVATE="$STATE_ROOT/claims/$ROLE-$TRANSACTION_ID.flag-private.json"
    CLAIM_RECEIPT="$STATE_ROOT/claims/$ROLE-$TRANSACTION_ID.flag-receipt.json"
    PM2_BEFORE_TEMP="$(mktemp "$STATE_ROOT/.pm2-before.XXXXXX")"
    write_pm2_snapshot "$PM2_BEFORE_TEMP"
    revalidate_routing_shadow_binding "$PENDING_PLAN" "$PM2_BEFORE_TEMP"
    "$NODE_BIN" --input-type=module - "$HELPER" "$ENV_FILE" "$PENDING_PLAN" \
      "$SEQUENCE_FILE" "$CLAIM_PLAN" "$CLAIM_PRIVATE" "$PM2_BEFORE_TEMP" \
      "$RELEASE_DIR" "$ACK_PLAN" "$ROLE" "$RUNTIME_SHA" \
      "$ARTIFACT_DIGEST" "$TRANSACTION_ID" <<'NODE'
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
const [helperPath,envFile,pendingPlan,sequenceFile,claimPlan,claimPrivate,pm2File,
  release,ack,expectedRole,expectedRuntimeSha,expectedArtifactDigest,transactionId] = process.argv.slice(2);
const helper = await import(pathToFileURL(helperPath).href);
if (!fs.existsSync(pendingPlan)) throw new Error('no pending plan');
const record = JSON.parse(fs.readFileSync(pendingPlan, 'utf8'));
const plan = record.plan;
helper.assertCapabilityFlagApplyAuthorization({
  ownerAuthorized: process.env.NEXUS_RELEASE_OWNER_AUTHORIZED,
  ackPlan: ack,
  planDigest: plan.planDigest,
});
const rebuilt = helper.buildCapabilityFlagPlan({
  role: plan.role, runtimeSha: plan.runtimeSha, artifactDigest: plan.artifactDigest,
  flag: plan.flag, desiredValue: plan.desiredValue,
  configuredFlags: plan.configuredBefore,
  previousPlanSequence: plan.previousPlanSequence,
  transitionReason: plan.transitionReason,
  evidenceAttestation: plan.evidenceAttestation,
  stagingPrerequisite: plan.stagingPrerequisite,
  generatedAt: plan.generatedAt,
});
if (JSON.stringify(rebuilt) !== JSON.stringify(plan)) throw new Error('pending plan changed');
if (Date.now() - Date.parse(plan.generatedAt) > 60 * 60 * 1000) {
  throw new Error('pending flag plan expired after one hour');
}
const claimed = helper.claimPendingCapabilityPlanRecord({
  record,
  ackPlan: ack,
  expectedRole,
  expectedRuntimeSha,
  expectedArtifactDigest,
  expectedPlanSequence: plan.planSequence,
  transactionId,
  claimedAt: new Date().toISOString(),
});
const source = fs.readFileSync(envFile, 'utf8');
const stat = fs.lstatSync(envFile);
const envSha256 = createHash('sha256').update(Buffer.from(source)).digest('hex');
const pm2 = JSON.parse(fs.readFileSync(pm2File, 'utf8'));
const sameProcess = (expected, observed) => expected.name === observed.name
  && expected.pid === observed.pid && expected.pmUptimeMs === observed.pmUptimeMs;
if (record.envSha256 !== envSha256 || record.releaseDir !== release
    || !sameProcess(record.backendProcess, pm2.backend)
    || !sameProcess(record.contentProcess, pm2.content)) {
  throw new Error('pending flag plan private preconditions changed after inspect');
}
if (JSON.stringify(helper.readCapabilityFlagState(source)) !== JSON.stringify(plan.configuredBefore)) {
  throw new Error('environment changed after inspect');
}
const privateState = {
  planDigest: plan.planDigest,
  release,
  environmentPrecondition: {
    device: stat.dev,
    inode: stat.ino,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    sha256: envSha256,
  },
  pm2,
};
let sequence = 0;
if (fs.existsSync(sequenceFile)) sequence = Number(fs.readFileSync(sequenceFile, 'utf8').trim());
if (sequence !== plan.previousPlanSequence) throw new Error('plan sequence was consumed or superseded');
const writeSequence = `${sequenceFile}.next-${process.pid}`;
const sequenceFd = fs.openSync(writeSequence, 'wx', 0o600);
try { fs.writeFileSync(sequenceFd, `${plan.planSequence}\n`); fs.fsyncSync(sequenceFd); }
finally { fs.closeSync(sequenceFd); }
fs.renameSync(writeSequence, sequenceFile);
const atomicExclusive = (file, value) => {
  if (fs.existsSync(file)) throw new Error('transaction claim already exists');
  const temporary = `${file}.next-${process.pid}`;
  const descriptor = fs.openSync(temporary, 'wx', 0o600);
  try { fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`); fs.fsyncSync(descriptor); }
  finally { fs.closeSync(descriptor); }
  fs.renameSync(temporary, file);
};
atomicExclusive(claimPlan, claimed);
atomicExclusive(claimPrivate, privateState);
let claimsParent = fs.openSync(path.dirname(claimPlan), 'r');
try { fs.fsyncSync(claimsParent); } finally { fs.closeSync(claimsParent); }
fs.unlinkSync(pendingPlan);
const parent = fs.openSync(path.dirname(sequenceFile), 'r');
try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
NODE
    resolve_current_release
    revalidate_apply_staging_prerequisite
    BACKUP_FILE="$BASE_DIR/.env.before-chat-capability-$TRANSACTION_ID"
    ROLLBACK_ARMED=true
    ENV_MUTATED=true
    "$NODE_BIN" --input-type=module - "$HELPER" "$ENV_FILE" "$CLAIM_PLAN" \
      "$CLAIM_PRIVATE" "$BACKUP_FILE" "$TRANSACTION_ID" <<'NODE'
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
const [helperPath,envFile,planFile,privateFile,backupFile,id] = process.argv.slice(2);
const helper = await import(pathToFileURL(helperPath).href);
const persisted = JSON.parse(fs.readFileSync(planFile, 'utf8'));
const plan = persisted.plan ?? persisted;
const privateState = JSON.parse(fs.readFileSync(privateFile, 'utf8'));
const source = fs.readFileSync(envFile, 'utf8');
const stat = fs.lstatSync(envFile);
const hash = createHash('sha256').update(Buffer.from(source)).digest('hex');
helper.assertDotenvCasPrecondition({
  expectedSha256: privateState.environmentPrecondition.sha256,
  expectedFileIdentity: {
    device: privateState.environmentPrecondition.device,
    inode: privateState.environmentPrecondition.inode,
    size: privateState.environmentPrecondition.size,
    mtimeMs: privateState.environmentPrecondition.mtimeMs,
  },
  observedContents: source,
  observedFileIdentity: {
    device: stat.dev,
    inode: stat.ino,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
  },
});
const rewritten = helper.rewriteCapabilityFlagDotenv({ source, plan });
const backupFd = fs.openSync(backupFile, 'wx', 0o600);
try { fs.writeFileSync(backupFd, source); fs.fsyncSync(backupFd); } finally { fs.closeSync(backupFd); }
let parent = fs.openSync(path.dirname(backupFile), 'r');
try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
const next = `${envFile}.next-${id}`;
const nextFd = fs.openSync(next, 'wx', 0o600);
try { fs.writeFileSync(nextFd, rewritten.contents); fs.fsyncSync(nextFd); } finally { fs.closeSync(nextFd); }
const recheck = fs.lstatSync(envFile);
const recheckHash = createHash('sha256').update(fs.readFileSync(envFile)).digest('hex');
helper.assertDotenvCasPrecondition({
  expectedSha256: hash,
  expectedFileIdentity: {
    device: stat.dev, inode: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs,
  },
  observedContents: fs.readFileSync(envFile, 'utf8'),
  observedFileIdentity: {
    device: recheck.dev,
    inode: recheck.ino,
    size: recheck.size,
    mtimeMs: recheck.mtimeMs,
  },
});
if (recheckHash !== hash) {
  fs.unlinkSync(next);
  throw new Error('environment changed before rename');
}
privateState.mutation = {
  preimageSha256: hash,
  mutatedSha256: createHash('sha256').update(Buffer.from(rewritten.contents)).digest('hex'),
};
const privateNext = `${privateFile}.next-${id}`;
const privateFd = fs.openSync(privateNext, 'wx', 0o600);
try { fs.writeFileSync(privateFd, `${JSON.stringify(privateState)}\n`); fs.fsyncSync(privateFd); }
finally { fs.closeSync(privateFd); }
fs.renameSync(privateNext, privateFile);
parent = fs.openSync(path.dirname(privateFile), 'r');
try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
fs.renameSync(next, envFile);
parent = fs.openSync(path.dirname(envFile), 'r');
try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
NODE
    resolve_current_release
    write_runtime_permit apply "$CLAIM_PLAN" configuredAfter
    restart_backend
    PM2_AFTER_TEMP="$(mktemp "$STATE_ROOT/.pm2-after.XXXXXX")"
    write_pm2_snapshot "$PM2_AFTER_TEMP"
    assert_pm2_transition "$PM2_BEFORE_TEMP" "$PM2_AFTER_TEMP" true
    BACKEND_PID="$($NODE_BIN -e 'const fs=require("node:fs");process.stdout.write(String(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).backend.pid))' "$PM2_AFTER_TEMP")"
    wait_healthy "$CLAIM_PLAN" configuredAfter "$BACKEND_PID" authorized
    RECEIPT_TEMP="$(mktemp "$STATE_ROOT/.receipt.XXXXXX")"
    "$NODE_BIN" --input-type=module - "$HELPER" "$CLAIM_PLAN" "$RECEIPT_TEMP" \
      "$TRANSACTION_ID" "$STARTED_AT" <<'NODE'
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
const [helperPath,planFile,receiptFile,transactionId,startedAt] = process.argv.slice(2);
const helper = await import(pathToFileURL(helperPath).href);
const persisted = JSON.parse(fs.readFileSync(planFile, 'utf8'));
const plan = persisted.plan ?? persisted;
const receipt = helper.buildCapabilityFlagReceipt({
  plan, transactionId, status: 'passed', startedAt,
  completedAt: new Date().toISOString(),
  health: { backend: 'passed', content: 'passed', identity: 'passed' },
  rollback: { status: 'not_required' },
});
helper.validateCapabilityFlagReceipt(receipt);
fs.writeFileSync(receiptFile, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
NODE
    atomic_write_json "$CLAIM_RECEIPT" "$RECEIPT_TEMP"
    RECEIPT_WRITTEN=true
    ROLLBACK_ARMED=false
    ENV_MUTATED=false
    durable_remove "$BACKUP_FILE"
    durable_remove "$PERMIT_FILE"
    wait_healthy "$CLAIM_PLAN" configuredAfter "$BACKEND_PID" clear
    atomic_write_json "$STATE_ROOT/$ROLE.json" "$CLAIM_RECEIPT"
    rm -f -- "$RECEIPT_TEMP"
    cat "$STATE_ROOT/$ROLE.json"
    ;;

  inspect-shadow-hook)
    resolve_exact_staging_release
    DEDICATED_ID="$(attest_dedicated_eval_identity)" \
      || die 'dedicated evaluation identity attestation failed'
    PM2_BEFORE_TEMP="$(mktemp "$STATE_ROOT/.shadow-hook-pm2-before.XXXXXX")"
    write_pm2_snapshot "$PM2_BEFORE_TEMP"
    "$NODE_BIN" --input-type=module - "$HELPER" "$ENV_FILE" "$PENDING_PLAN" \
      "$PENDING_PRIVATE" "$SEQUENCE_FILE" "$PM2_BEFORE_TEMP" "$RELEASE_DIR" \
      "$ROLE" "$RUNTIME_SHA" "$ARTIFACT_DIGEST" "$DESIRED_VALUE" \
      "$TRANSITION_REASON" "$DEDICATED_ID" <<'NODE'
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
const [helperPath,envFile,pendingPlan,pendingPrivate,sequenceFile,pm2File,release,
  role,runtimeSha,artifactDigest,desiredRaw,transitionReason,dedicatedRaw]
  = process.argv.slice(2);
const helper = await import(pathToFileURL(helperPath).href);
const source = fs.readFileSync(envFile, 'utf8');
const stat = fs.lstatSync(envFile);
const pm2 = JSON.parse(fs.readFileSync(pm2File, 'utf8'));
const dedicatedTenantId = Number(dedicatedRaw);
let previousPlanSequence = 0;
if (fs.existsSync(sequenceFile)) {
  const raw = fs.readFileSync(sequenceFile, 'utf8').trim();
  if (!/^(?:0|[1-9][0-9]*)$/u.test(raw)) throw new Error('invalid shadow-hook sequence state');
  previousPlanSequence = Number(raw);
}
const build = (generatedAt) => helper.buildShadowRouteHookPlan({
  role,
  runtimeSha,
  artifactDigest,
  dotenvSource: source,
  dedicatedIdentityAttested: true,
  desiredValue: desiredRaw === 'true',
  transitionReason,
  previousPlanSequence,
  generatedAt,
});
const privateStateFor = (planDigest) => ({
  schema: 'nexus.chat-shadow-route-hook-private.v1',
  planDigest,
  release,
  dedicatedTenantId,
  environmentPrecondition: {
    device: stat.dev,
    inode: stat.ino,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    sha256: createHash('sha256').update(Buffer.from(source)).digest('hex'),
  },
  pm2,
  configuredFlags: helper.readCapabilityFlagState(source),
});
const planExists = fs.existsSync(pendingPlan);
const privateExists = fs.existsSync(pendingPrivate);
if (planExists !== privateExists) throw new Error('pending shadow-hook state is incomplete');
if (planExists) {
  for (const file of [pendingPlan, pendingPrivate]) {
    const candidate = fs.lstatSync(file);
    if (!candidate.isFile() || candidate.isSymbolicLink() || candidate.nlink !== 1
        || (candidate.mode & 0o777) !== 0o600 || candidate.uid !== process.getuid()) {
      throw new Error('pending shadow-hook state is unsafe');
    }
  }
  const existingPlan = helper.validateShadowRouteHookPlan(
    JSON.parse(fs.readFileSync(pendingPlan, 'utf8')),
  );
  const existingPrivate = JSON.parse(fs.readFileSync(pendingPrivate, 'utf8'));
  const rebuilt = helper.buildShadowRouteHookPlan({
    role: existingPlan.role,
    runtimeSha: existingPlan.runtimeSha,
    artifactDigest: existingPlan.artifactDigest,
    dotenvSource: source,
    dedicatedIdentityAttested: true,
    desiredValue: existingPlan.desiredValue,
    transitionReason: existingPlan.transitionReason,
    previousPlanSequence: existingPlan.previousPlanSequence,
    generatedAt: existingPlan.generatedAt,
  });
  const expectedPrivate = privateStateFor(existingPlan.planDigest);
  const stale = Date.now() > Date.parse(existingPlan.expiresAt)
    || existingPlan.previousPlanSequence !== previousPlanSequence
    || JSON.stringify(existingPlan) !== JSON.stringify(rebuilt)
    || JSON.stringify(existingPrivate) !== JSON.stringify(expectedPrivate);
  if (!stale) {
    if (existingPlan.desiredValue !== (desiredRaw === 'true')
        || existingPlan.transitionReason !== transitionReason) {
      throw new Error('a different unconsumed shadow-hook plan already exists');
    }
    process.stdout.write(`${JSON.stringify(existingPlan, null, 2)}\n`);
    process.exit(0);
  }
  const archiveRoot = path.join(path.dirname(pendingPlan), 'expired');
  fs.mkdirSync(archiveRoot, { recursive: true, mode: 0o700 });
  const suffix = existingPlan.planDigest.slice(7);
  const archivedPlan = path.join(archiveRoot, `staging.shadow-hook.${suffix}.plan.json`);
  const archivedPrivate = path.join(archiveRoot, `staging.shadow-hook.${suffix}.private.json`);
  if (fs.existsSync(archivedPlan) || fs.existsSync(archivedPrivate)) {
    throw new Error('stale shadow-hook archive already exists');
  }
  fs.renameSync(pendingPlan, archivedPlan);
  fs.renameSync(pendingPrivate, archivedPrivate);
}
const plan = build(new Date().toISOString());
if (plan.dedicatedTenantId !== dedicatedTenantId) {
  throw new Error('dedicated evaluation identity changed during inspect');
}
const privateState = privateStateFor(plan.planDigest);
const atomic = (file, value) => {
  const temporary = `${file}.next-${process.pid}`;
  const descriptor = fs.openSync(temporary, 'wx', 0o600);
  try { fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`); fs.fsyncSync(descriptor); }
  finally { fs.closeSync(descriptor); }
  fs.renameSync(temporary, file);
  const parent = fs.openSync(path.dirname(file), 'r');
  try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
};
atomic(pendingPlan, plan);
atomic(pendingPrivate, privateState);
process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
NODE
    ;;

  apply-shadow-hook)
    [ "${NEXUS_RELEASE_OWNER_AUTHORIZED:-0}" = 1 ] \
      || die 'apply-shadow-hook requires NEXUS_RELEASE_OWNER_AUTHORIZED=1'
    CLAIM_PLAN="$STATE_ROOT/claims/$ROLE-$TRANSACTION_ID.shadow-hook-plan.json"
    CLAIM_PRIVATE="$STATE_ROOT/claims/$ROLE-$TRANSACTION_ID.shadow-hook-private.json"
    CLAIM_RECEIPT="$STATE_ROOT/claims/$ROLE-$TRANSACTION_ID.shadow-hook-receipt.json"
    resolve_exact_staging_release
    DEDICATED_ID="$(attest_dedicated_eval_identity)" \
      || die 'dedicated evaluation identity attestation failed'
    PM2_BEFORE_TEMP="$(mktemp "$STATE_ROOT/.shadow-hook-pm2-before.XXXXXX")"
    write_pm2_snapshot "$PM2_BEFORE_TEMP"
    "$NODE_BIN" --input-type=module - "$HELPER" "$ENV_FILE" "$PENDING_PLAN" \
      "$PENDING_PRIVATE" "$SEQUENCE_FILE" "$CLAIM_PLAN" "$CLAIM_PRIVATE" \
      "$PM2_BEFORE_TEMP" "$RELEASE_DIR" "$ACK_PLAN" "$ROLE" "$RUNTIME_SHA" \
      "$ARTIFACT_DIGEST" "$TRANSACTION_ID" "$DEDICATED_ID" <<'NODE'
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
const [helperPath,envFile,pendingPlan,pendingPrivate,sequenceFile,claimPlan,
  claimPrivate,pm2File,release,ack,role,runtimeSha,artifactDigest,transactionId,
  dedicatedRaw] = process.argv.slice(2);
const helper = await import(pathToFileURL(helperPath).href);
if (!fs.existsSync(pendingPlan) || !fs.existsSync(pendingPrivate)) {
  throw new Error('no complete pending shadow-hook plan');
}
const plan = helper.validateShadowRouteHookPlan(
  JSON.parse(fs.readFileSync(pendingPlan, 'utf8')),
);
helper.assertShadowRouteHookApplyAuthorization({
  ownerAuthorized: process.env.NEXUS_RELEASE_OWNER_AUTHORIZED,
  ackPlan: ack,
  plan,
  now: new Date().toISOString(),
});
if (plan.role !== role || plan.runtimeSha !== runtimeSha
    || plan.artifactDigest !== artifactDigest
    || plan.dedicatedTenantId !== Number(dedicatedRaw)) {
  throw new Error('pending shadow-hook plan identity changed');
}
const privateState = JSON.parse(fs.readFileSync(pendingPrivate, 'utf8'));
if (privateState.schema !== 'nexus.chat-shadow-route-hook-private.v1'
    || privateState.planDigest !== plan.planDigest
    || privateState.release !== release
    || privateState.dedicatedTenantId !== plan.dedicatedTenantId) {
  throw new Error('pending shadow-hook private state changed');
}
const source = fs.readFileSync(envFile, 'utf8');
const stat = fs.lstatSync(envFile);
helper.assertDotenvCasPrecondition({
  expectedSha256: privateState.environmentPrecondition.sha256,
  expectedFileIdentity: {
    device: privateState.environmentPrecondition.device,
    inode: privateState.environmentPrecondition.inode,
    size: privateState.environmentPrecondition.size,
    mtimeMs: privateState.environmentPrecondition.mtimeMs,
  },
  observedContents: source,
  observedFileIdentity: {
    device: stat.dev,
    inode: stat.ino,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
  },
});
const rebuilt = helper.buildShadowRouteHookPlan({
  role: plan.role,
  runtimeSha: plan.runtimeSha,
  artifactDigest: plan.artifactDigest,
  dotenvSource: source,
  dedicatedIdentityAttested: true,
  desiredValue: plan.desiredValue,
  transitionReason: plan.transitionReason,
  previousPlanSequence: plan.previousPlanSequence,
  generatedAt: plan.generatedAt,
});
if (JSON.stringify(rebuilt) !== JSON.stringify(plan)
    || JSON.stringify(helper.readCapabilityFlagState(source))
      !== JSON.stringify(privateState.configuredFlags)) {
  throw new Error('live shadow-hook state changed after inspect');
}
const pm2 = JSON.parse(fs.readFileSync(pm2File, 'utf8'));
if (JSON.stringify(pm2) !== JSON.stringify(privateState.pm2)) {
  throw new Error('PM2 changed after shadow-hook inspect');
}
let sequence = 0;
if (fs.existsSync(sequenceFile)) sequence = Number(fs.readFileSync(sequenceFile, 'utf8').trim());
if (sequence !== plan.previousPlanSequence) throw new Error('shadow-hook plan sequence was consumed');
for (const file of [claimPlan, claimPrivate]) {
  if (fs.existsSync(file)) throw new Error('shadow-hook transaction claim already exists');
}
const atomicExclusive = (file, value) => {
  const temporary = `${file}.next-${transactionId}`;
  const descriptor = fs.openSync(temporary, 'wx', 0o600);
  try { fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`); fs.fsyncSync(descriptor); }
  finally { fs.closeSync(descriptor); }
  fs.renameSync(temporary, file);
};
atomicExclusive(claimPlan, plan);
atomicExclusive(claimPrivate, privateState);
const sequenceNext = `${sequenceFile}.next-${transactionId}`;
const sequenceDescriptor = fs.openSync(sequenceNext, 'wx', 0o600);
try { fs.writeFileSync(sequenceDescriptor, `${plan.planSequence}\n`); fs.fsyncSync(sequenceDescriptor); }
finally { fs.closeSync(sequenceDescriptor); }
fs.renameSync(sequenceNext, sequenceFile);
fs.unlinkSync(pendingPlan);
fs.unlinkSync(pendingPrivate);
const parent = fs.openSync(path.dirname(sequenceFile), 'r');
try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
NODE
    resolve_current_release
    BACKUP_FILE="$BASE_DIR/.env.before-chat-capability-$TRANSACTION_ID"
    ROLLBACK_ARMED=true
    ENV_MUTATED=true
    "$NODE_BIN" --input-type=module - "$HELPER" "$ENV_FILE" "$CLAIM_PLAN" \
      "$CLAIM_PRIVATE" "$BACKUP_FILE" "$TRANSACTION_ID" <<'NODE'
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
const [helperPath,envFile,planFile,privateFile,backupFile,id] = process.argv.slice(2);
const helper = await import(pathToFileURL(helperPath).href);
const plan = helper.validateShadowRouteHookPlan(JSON.parse(fs.readFileSync(planFile, 'utf8')));
const privateState = JSON.parse(fs.readFileSync(privateFile, 'utf8'));
const source = fs.readFileSync(envFile, 'utf8');
const stat = fs.lstatSync(envFile);
helper.assertDotenvCasPrecondition({
  expectedSha256: privateState.environmentPrecondition.sha256,
  expectedFileIdentity: {
    device: privateState.environmentPrecondition.device,
    inode: privateState.environmentPrecondition.inode,
    size: privateState.environmentPrecondition.size,
    mtimeMs: privateState.environmentPrecondition.mtimeMs,
  },
  observedContents: source,
  observedFileIdentity: {
    device: stat.dev, inode: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs,
  },
});
const rewritten = helper.rewriteShadowRouteHookDotenv({ source, plan });
privateState.mutation = {
  preimageSha256: createHash('sha256').update(Buffer.from(source)).digest('hex'),
  mutatedSha256: createHash('sha256').update(Buffer.from(rewritten.contents)).digest('hex'),
};
const privateNext = `${privateFile}.next-${id}`;
const privateDescriptor = fs.openSync(privateNext, 'wx', 0o600);
try { fs.writeFileSync(privateDescriptor, `${JSON.stringify(privateState)}\n`); fs.fsyncSync(privateDescriptor); }
finally { fs.closeSync(privateDescriptor); }
fs.renameSync(privateNext, privateFile);
let parent = fs.openSync(path.dirname(privateFile), 'r');
try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
helper.replaceCapabilitySecretDotenvFile({
  filePath: envFile,
  backupPath: backupFile,
  expectedContents: source,
  nextContents: rewritten.contents,
  temporarySuffix: id,
});
NODE
    resolve_current_release
    write_runtime_permit apply "$CLAIM_PRIVATE" configuredFlags
    restart_backend
    PM2_AFTER_TEMP="$(mktemp "$STATE_ROOT/.shadow-hook-pm2-after.XXXXXX")"
    write_pm2_snapshot "$PM2_AFTER_TEMP"
    assert_pm2_transition "$PM2_BEFORE_TEMP" "$PM2_AFTER_TEMP" true
    BACKEND_PID="$($NODE_BIN -e 'const fs=require("node:fs");process.stdout.write(String(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).backend.pid))' "$PM2_AFTER_TEMP")"
    wait_healthy "$CLAIM_PRIVATE" configuredFlags "$BACKEND_PID" authorized
    DESIRED_VALUE="$($NODE_BIN -e 'const p=require(process.argv[1]);process.stdout.write(String(p.desiredValue))' "$CLAIM_PLAN")"
    DEDICATED_ID="$($NODE_BIN -e 'const p=require(process.argv[1]);process.stdout.write(String(p.dedicatedTenantId))' "$CLAIM_PLAN")"
    assert_shadow_route_hook_runtime_state "$DESIRED_VALUE" "$DEDICATED_ID" \
      || die 'shadow route hook runtime state did not match the plan'
    RECEIPT_TEMP="$(mktemp "$STATE_ROOT/.shadow-hook-receipt.XXXXXX")"
    "$NODE_BIN" --input-type=module - "$HELPER" "$CLAIM_PLAN" "$RECEIPT_TEMP" \
      "$TRANSACTION_ID" "$STARTED_AT" <<'NODE'
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
const [helperPath,planFile,receiptFile,transactionId,startedAt] = process.argv.slice(2);
const helper = await import(pathToFileURL(helperPath).href);
const plan = helper.validateShadowRouteHookPlan(JSON.parse(fs.readFileSync(planFile, 'utf8')));
const receipt = helper.buildShadowRouteHookReceipt({
  plan,
  transactionId,
  status: 'passed',
  startedAt,
  completedAt: new Date().toISOString(),
  health: { backend: 'passed', identity: 'passed', shadowHook: 'passed' },
  rollback: { status: 'not_required' },
});
helper.validateShadowRouteHookReceipt(receipt);
fs.writeFileSync(receiptFile, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
NODE
    atomic_write_json "$CLAIM_RECEIPT" "$RECEIPT_TEMP"
    RECEIPT_WRITTEN=true
    ROLLBACK_ARMED=false
    ENV_MUTATED=false
    durable_remove "$BACKUP_FILE"
    durable_remove "$PERMIT_FILE"
    wait_healthy "$CLAIM_PRIVATE" configuredFlags "$BACKEND_PID" clear
    assert_shadow_route_hook_runtime_state "$DESIRED_VALUE" "$DEDICATED_ID" \
      || die 'committed shadow route hook runtime state is invalid'
    atomic_write_json "$STATE_ROOT/$ROLE.json" "$CLAIM_RECEIPT"
    rm -f -- "$RECEIPT_TEMP"
    cat "$STATE_ROOT/$ROLE.json"
    ;;

  inspect-observation)
    resolve_exact_staging_release
    STAGING_ENABLE_RECEIPT_FILE="$(mktemp "$STATE_ROOT/.observation-enable-receipt.XXXXXX")"
    select_mature_exact_staging_enable_receipt "$STAGING_ENABLE_RECEIPT_FILE"
    OBSERVATION_HEALTH_BEFORE_FILE="$(mktemp "$STATE_ROOT/.observation-health.XXXXXX")"
    collect_staging_http_json '/health/detailed' health "$OBSERVATION_HEALTH_BEFORE_FILE"
    OBSERVATION_SEQUENCE="$(read_observation_sequence)"
    EXPECTED_PRODUCTION_SEQUENCE="$(read_expected_production_flag_plan_sequence)"
    GENERATED_AT="$($NODE_BIN --input-type=module - "$HELPER" "$PENDING_PLAN" \
      "$SEQUENCE_FILE" "$FLAG" "$RUNTIME_SHA" "$ARTIFACT_DIGEST" \
      "$OBSERVATION_SEQUENCE" "$EXPECTED_PRODUCTION_SEQUENCE" <<'NODE'
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const [helperPath,pendingPlan,sequenceFile,flag,runtimeSha,artifactDigest,
  currentSequenceRaw,expectedProductionSequenceRaw] = process.argv.slice(2);
const helper = await import(pathToFileURL(helperPath).href);
const now = new Date().toISOString();
if (!fs.existsSync(pendingPlan)) {
  process.stdout.write(now);
  process.exit(0);
}
const stat = fs.lstatSync(pendingPlan);
if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
    || (stat.mode & 0o777) !== 0o600 || stat.uid !== process.getuid()) {
  throw new Error('pending observation plan is unsafe');
}
const plan = helper.validateCapabilityObservationPlan(
  JSON.parse(fs.readFileSync(pendingPlan, 'utf8')),
);
const expired = Date.now() > Date.parse(plan.expiresAt);
const sequenceStale = plan.previousObservationSequence !== Number(currentSequenceRaw)
  || plan.expectedProductionPlanSequence !== Number(expectedProductionSequenceRaw);
if (expired || sequenceStale) {
  const archiveRoot = path.join(path.dirname(pendingPlan), 'expired');
  fs.mkdirSync(archiveRoot, { recursive: true, mode: 0o700 });
  const archiveStat = fs.lstatSync(archiveRoot);
  if (!archiveStat.isDirectory() || archiveStat.isSymbolicLink()
      || archiveStat.uid !== process.getuid() || (archiveStat.mode & 0o777) !== 0o700) {
    throw new Error('expired observation archive is unsafe');
  }
  const archive = path.join(
    archiveRoot,
    `staging.observation.${plan.planDigest.slice(7)}.json`,
  );
  if (fs.existsSync(archive)) throw new Error('expired observation archive already exists');
  fs.renameSync(pendingPlan, archive);
  const parent = fs.openSync(archiveRoot, 'r');
  try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
  process.stdout.write(now);
  process.exit(0);
}
if (plan.flag !== flag || plan.runtimeSha !== runtimeSha
    || plan.artifactDigest !== artifactDigest) {
  throw new Error('another unexpired observation plan is pending');
}
process.stdout.write(plan.generatedAt);
NODE
    )" || die 'pending observation plan is invalid or belongs to another target'
    OBSERVATION_PLAN_TEMP="$(mktemp "$STATE_ROOT/.observation-plan.XXXXXX")"
    build_current_observation_plan "$OBSERVATION_PLAN_TEMP" \
      "$STAGING_ENABLE_RECEIPT_FILE" "$OBSERVATION_HEALTH_BEFORE_FILE" \
      "$GENERATED_AT" "$OBSERVATION_SEQUENCE" "$EXPECTED_PRODUCTION_SEQUENCE"
    "$NODE_BIN" --input-type=module - "$HELPER" "$OBSERVATION_PLAN_TEMP" \
      "$PENDING_PLAN" <<'NODE'
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const [helperPath,source,pendingPlan] = process.argv.slice(2);
const helper = await import(pathToFileURL(helperPath).href);
const plan = helper.validateCapabilityObservationPlan(
  JSON.parse(fs.readFileSync(source, 'utf8')),
);
const body = `${JSON.stringify(plan, null, 2)}\n`;
if (fs.existsSync(pendingPlan)) {
  const stat = fs.lstatSync(pendingPlan);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
      || fs.readFileSync(pendingPlan, 'utf8') !== body) {
    throw new Error('live staging observation state changed after inspect began');
  }
} else {
  const temporary = `${pendingPlan}.next-${process.pid}`;
  const descriptor = fs.openSync(temporary, 'wx', 0o600);
  try { fs.writeFileSync(descriptor, body); fs.fsyncSync(descriptor); }
  finally { fs.closeSync(descriptor); }
  fs.renameSync(temporary, pendingPlan);
  const parent = fs.openSync(path.dirname(pendingPlan), 'r');
  try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
}
process.stdout.write(body);
NODE
    rm -f -- "$OBSERVATION_PLAN_TEMP"
    ;;

  apply-observation)
    [ "${NEXUS_RELEASE_OWNER_AUTHORIZED:-0}" = 1 ] \
      || die 'apply-observation requires NEXUS_RELEASE_OWNER_AUTHORIZED=1'
    [ ! -e "$OBSERVATION_CLAIM_PLAN" ] && [ ! -e "$OBSERVATION_RECEIPT_FILE" ] \
      || die 'observation transaction ID already exists'
    resolve_exact_staging_release
    STAGING_ENABLE_RECEIPT_FILE="$(mktemp "$STATE_ROOT/.observation-enable-receipt.XXXXXX")"
    select_mature_exact_staging_enable_receipt "$STAGING_ENABLE_RECEIPT_FILE"
    OBSERVATION_HEALTH_BEFORE_FILE="$(mktemp "$STATE_ROOT/.observation-health.XXXXXX")"
    collect_staging_http_json '/health/detailed' health "$OBSERVATION_HEALTH_BEFORE_FILE"
    OBSERVATION_SEQUENCE="$(read_observation_sequence)"
    EXPECTED_PRODUCTION_SEQUENCE="$(read_expected_production_flag_plan_sequence)"
    GENERATED_AT="$($NODE_BIN --input-type=module - "$HELPER" "$PENDING_PLAN" \
      "$FLAG" "$RUNTIME_SHA" "$ARTIFACT_DIGEST" "$ACK_PLAN" \
      "$OBSERVATION_SEQUENCE" "$EXPECTED_PRODUCTION_SEQUENCE" <<'NODE'
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
const [helperPath,pendingPlan,flag,runtimeSha,artifactDigest,ack,
  currentSequenceRaw,expectedProductionSequenceRaw] = process.argv.slice(2);
const helper = await import(pathToFileURL(helperPath).href);
if (!fs.existsSync(pendingPlan)) throw new Error('no pending observation plan');
const stat = fs.lstatSync(pendingPlan);
if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
    || (stat.mode & 0o777) !== 0o600 || stat.uid !== process.getuid()) {
  throw new Error('pending observation plan is unsafe');
}
const plan = helper.validateCapabilityObservationPlan(
  JSON.parse(fs.readFileSync(pendingPlan, 'utf8')),
);
helper.assertCapabilityFlagApplyAuthorization({
  ownerAuthorized: process.env.NEXUS_RELEASE_OWNER_AUTHORIZED,
  ackPlan: ack,
  planDigest: plan.planDigest,
});
if (plan.flag !== flag || plan.runtimeSha !== runtimeSha
    || plan.artifactDigest !== artifactDigest || plan.planDigest !== ack
    || plan.previousObservationSequence !== Number(currentSequenceRaw)
    || plan.expectedProductionPlanSequence !== Number(expectedProductionSequenceRaw)
    || Date.now() > Date.parse(plan.expiresAt)) {
  throw new Error('pending observation plan identity, sequence, or expiry changed');
}
process.stdout.write(plan.generatedAt);
NODE
    )" || die 'pending observation plan is not authorized for this exact apply'
    OBSERVATION_PLAN_TEMP="$(mktemp "$STATE_ROOT/.observation-revalidate.XXXXXX")"
    build_current_observation_plan "$OBSERVATION_PLAN_TEMP" \
      "$STAGING_ENABLE_RECEIPT_FILE" "$OBSERVATION_HEALTH_BEFORE_FILE" \
      "$GENERATED_AT" "$OBSERVATION_SEQUENCE" "$EXPECTED_PRODUCTION_SEQUENCE"
    "$NODE_BIN" --input-type=module - "$HELPER" "$PENDING_PLAN" \
      "$OBSERVATION_PLAN_TEMP" "$SEQUENCE_FILE" "$OBSERVATION_CLAIM_PLAN" \
      "$ACK_PLAN" "$TRANSACTION_ID" <<'NODE'
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const [helperPath,pendingPlan,revalidatedPlan,sequenceFile,claimPlan,ack,
  transactionId] = process.argv.slice(2);
const helper = await import(pathToFileURL(helperPath).href);
const pendingRaw = fs.readFileSync(pendingPlan, 'utf8');
const freshRaw = fs.readFileSync(revalidatedPlan, 'utf8');
const plan = helper.validateCapabilityObservationPlan(JSON.parse(pendingRaw));
const fresh = helper.validateCapabilityObservationPlan(JSON.parse(freshRaw));
if (JSON.stringify(plan) !== JSON.stringify(fresh) || plan.planDigest !== ack) {
  throw new Error('live staging observation preconditions changed after inspect');
}
let sequence = 0;
if (fs.existsSync(sequenceFile)) sequence = Number(fs.readFileSync(sequenceFile, 'utf8').trim());
if (sequence !== plan.previousObservationSequence) {
  throw new Error('observation sequence was consumed or superseded');
}
if (fs.existsSync(claimPlan)) throw new Error('observation claim already exists');
const claimTemporary = `${claimPlan}.next-${transactionId}`;
const claimDescriptor = fs.openSync(claimTemporary, 'wx', 0o600);
try { fs.writeFileSync(claimDescriptor, `${JSON.stringify(plan, null, 2)}\n`); fs.fsyncSync(claimDescriptor); }
finally { fs.closeSync(claimDescriptor); }
fs.renameSync(claimTemporary, claimPlan);
let parent = fs.openSync(path.dirname(claimPlan), 'r');
try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
const sequenceTemporary = `${sequenceFile}.next-${transactionId}`;
const sequenceDescriptor = fs.openSync(sequenceTemporary, 'wx', 0o600);
try { fs.writeFileSync(sequenceDescriptor, `${plan.observationSequence}\n`); fs.fsyncSync(sequenceDescriptor); }
finally { fs.closeSync(sequenceDescriptor); }
fs.renameSync(sequenceTemporary, sequenceFile);
fs.unlinkSync(pendingPlan);
parent = fs.openSync(path.dirname(sequenceFile), 'r');
try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
NODE
    rm -f -- "$OBSERVATION_PLAN_TEMP"
    run_staging_capability_observation
    ;;

  inspect-secrets)
    PM2_BEFORE_TEMP="$(mktemp "$STATE_ROOT/.pm2-before.XXXXXX")"
    write_pm2_snapshot "$PM2_BEFORE_TEMP"
    "$NODE_BIN" --input-type=module - "$HELPER" "$ENV_FILE" "$PENDING_PLAN" \
      "$SEQUENCE_FILE" "$PM2_BEFORE_TEMP" "$RELEASE_DIR" \
      "$ROLE" "$RUNTIME_SHA" "$ARTIFACT_DIGEST" <<'NODE'
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
const [helperPath,envFile,pendingPlan,sequenceFile,pm2File,release,
  role,runtimeSha,artifactDigest] = process.argv.slice(2);
const helper = await import(pathToFileURL(helperPath).href);
const source = fs.readFileSync(envFile, 'utf8');
const secretPresence = helper.readCapabilitySecretPresence(source);
let previousPlanSequence = 0;
if (fs.existsSync(sequenceFile)) {
  const raw = fs.readFileSync(sequenceFile, 'utf8').trim();
  if (!/^(?:0|[1-9][0-9]*)$/u.test(raw)) throw new Error('invalid secret sequence state');
  previousPlanSequence = Number(raw);
}
const build = (generatedAt) => helper.buildCapabilitySecretPlan({
  role, runtimeSha, artifactDigest, secretPresence, previousPlanSequence, generatedAt,
});
const stat = fs.lstatSync(envFile);
const configuredFlags = helper.readCapabilityFlagState(source);
const effectiveFlags = { ...configuredFlags };
if (configuredFlags.AI_ROUTING_MANIFEST_KILL) {
  for (const name of helper.CHAT_CAPABILITY_FLAGS) {
    if (name !== 'AI_ROUTING_MANIFEST_KILL') effectiveFlags[name] = false;
  }
}
const privateState = {
  release,
  environmentPrecondition: {
    device: stat.dev,
    inode: stat.ino,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    sha256: createHash('sha256').update(Buffer.from(source)).digest('hex'),
  },
  pm2: JSON.parse(fs.readFileSync(pm2File, 'utf8')),
  configuredFlags,
  effectiveFlags,
};
const atomic = (file, value) => {
  const temporary = `${file}.next-${process.pid}`;
  const descriptor = fs.openSync(temporary, 'wx', 0o600);
  try { fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`); fs.fsyncSync(descriptor); }
  finally { fs.closeSync(descriptor); }
  fs.renameSync(temporary, file);
  const parent = fs.openSync(path.dirname(file), 'r');
  try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
};
let existingRecord = fs.existsSync(pendingPlan)
  ? JSON.parse(fs.readFileSync(pendingPlan, 'utf8'))
  : null;
if (existingRecord !== null) {
  if (existingRecord.schema !== 'nexus.chat-capability-secret-pending.v1'
      || !existingRecord.plan || !existingRecord.privateState) {
    throw new Error('pending secret plan record is invalid');
  }
  const expired = Date.now() - Date.parse(existingRecord.plan.generatedAt) > 60 * 60 * 1000;
  const stale = JSON.stringify(existingRecord.privateState) !== JSON.stringify({
    ...privateState,
    planDigest: existingRecord.plan.planDigest,
  });
  if (expired || stale) {
    const archiveRoot = path.join(path.dirname(pendingPlan), 'expired');
    fs.mkdirSync(archiveRoot, { recursive: true, mode: 0o700 });
    const archive = path.join(
      archiveRoot,
      `${role}.secrets.${existingRecord.plan.planDigest.slice(7)}.json`,
    );
    if (fs.existsSync(archive)) throw new Error('stale pending secret plan archive already exists');
    fs.renameSync(pendingPlan, archive);
    const parent = fs.openSync(archiveRoot, 'r');
    try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
    existingRecord = null;
  }
}
const generatedAt = existingRecord?.plan?.generatedAt ?? new Date().toISOString();
const plan = build(generatedAt);
if (existingRecord !== null) {
  if (JSON.stringify(existingRecord.plan) !== JSON.stringify(plan)) {
    throw new Error('a different pending secret plan cannot replace the unconsumed plan');
  }
  process.stdout.write(`${JSON.stringify(existingRecord.plan, null, 2)}\n`);
  process.exit(0);
}
atomic(pendingPlan, {
  schema: 'nexus.chat-capability-secret-pending.v1',
  plan,
  privateState: { ...privateState, planDigest: plan.planDigest },
});
process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
NODE
    ;;

  apply-secrets)
    [ "${NEXUS_RELEASE_OWNER_AUTHORIZED:-0}" = 1 ] \
      || die 'apply-secrets requires NEXUS_RELEASE_OWNER_AUTHORIZED=1'
    CLAIM_PLAN="$STATE_ROOT/claims/$ROLE-$TRANSACTION_ID.secret-plan.json"
    CLAIM_PRIVATE="$STATE_ROOT/claims/$ROLE-$TRANSACTION_ID.secret-private.json"
    CLAIM_RECEIPT="$STATE_ROOT/claims/$ROLE-$TRANSACTION_ID.secret-receipt.json"
    PM2_BEFORE_TEMP="$(mktemp "$STATE_ROOT/.pm2-before.XXXXXX")"
    write_pm2_snapshot "$PM2_BEFORE_TEMP"
    "$NODE_BIN" --input-type=module - "$HELPER" "$ENV_FILE" "$PENDING_PLAN" \
      "$SEQUENCE_FILE" "$CLAIM_PLAN" "$CLAIM_PRIVATE" "$PM2_BEFORE_TEMP" \
      "$ACK_PLAN" "$ROLE" "$RUNTIME_SHA" "$ARTIFACT_DIGEST" <<'NODE'
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const [helperPath,envFile,pendingPlan,sequenceFile,claimPlan,claimPrivate,pm2File,
  ack,expectedRole,expectedRuntimeSha,expectedArtifactDigest] = process.argv.slice(2);
const helper = await import(pathToFileURL(helperPath).href);
if (!fs.existsSync(pendingPlan)) throw new Error('no pending secret plan');
const record = JSON.parse(fs.readFileSync(pendingPlan, 'utf8'));
if (record.schema !== 'nexus.chat-capability-secret-pending.v1'
    || !record.plan || !record.privateState) throw new Error('pending secret plan record is invalid');
const plan = record.plan;
const privateState = record.privateState;
helper.assertCapabilityFlagApplyAuthorization({
  ownerAuthorized: process.env.NEXUS_RELEASE_OWNER_AUTHORIZED,
  ackPlan: ack,
  planDigest: plan.planDigest,
});
const rebuilt = helper.buildCapabilitySecretPlan({
  role: plan.role,
  runtimeSha: plan.runtimeSha,
  artifactDigest: plan.artifactDigest,
  secretPresence: plan.presentBefore,
  previousPlanSequence: plan.previousPlanSequence,
  generatedAt: plan.generatedAt,
});
if (JSON.stringify(rebuilt) !== JSON.stringify(plan)
    || privateState.planDigest !== plan.planDigest) throw new Error('pending secret plan changed');
if (plan.role !== expectedRole || plan.runtimeSha !== expectedRuntimeSha
    || plan.artifactDigest !== expectedArtifactDigest) {
  throw new Error('pending secret plan release identity changed');
}
if (Date.now() - Date.parse(plan.generatedAt) > 60 * 60 * 1000) {
  throw new Error('pending secret plan expired after one hour');
}
const source = fs.readFileSync(envFile, 'utf8');
const stat = fs.lstatSync(envFile);
helper.assertDotenvCasPrecondition({
  expectedSha256: privateState.environmentPrecondition.sha256,
  expectedFileIdentity: {
    device: privateState.environmentPrecondition.device,
    inode: privateState.environmentPrecondition.inode,
    size: privateState.environmentPrecondition.size,
    mtimeMs: privateState.environmentPrecondition.mtimeMs,
  },
  observedContents: source,
  observedFileIdentity: {
    device: stat.dev,
    inode: stat.ino,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
  },
});
if (JSON.stringify(helper.readCapabilitySecretPresence(source))
    !== JSON.stringify(plan.presentBefore)
    || JSON.stringify(helper.readCapabilityFlagState(source))
      !== JSON.stringify(privateState.configuredFlags)) {
  throw new Error('environment state changed after secret inspect');
}
const observedPm2 = JSON.parse(fs.readFileSync(pm2File, 'utf8'));
if (JSON.stringify(observedPm2) !== JSON.stringify(privateState.pm2)) {
  throw new Error('PM2 changed after secret inspect');
}
let sequence = 0;
if (fs.existsSync(sequenceFile)) sequence = Number(fs.readFileSync(sequenceFile, 'utf8').trim());
if (sequence !== plan.previousPlanSequence) throw new Error('secret plan sequence was consumed');
const writeSequence = `${sequenceFile}.next-${process.pid}`;
const sequenceFd = fs.openSync(writeSequence, 'wx', 0o600);
try { fs.writeFileSync(sequenceFd, `${plan.planSequence}\n`); fs.fsyncSync(sequenceFd); }
finally { fs.closeSync(sequenceFd); }
fs.renameSync(writeSequence, sequenceFile);
const atomicExclusive = (file, value) => {
  if (fs.existsSync(file)) throw new Error('secret transaction claim already exists');
  const temporary = `${file}.next-${process.pid}`;
  const descriptor = fs.openSync(temporary, 'wx', 0o600);
  try { fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`); fs.fsyncSync(descriptor); }
  finally { fs.closeSync(descriptor); }
  fs.renameSync(temporary, file);
};
atomicExclusive(claimPlan, plan);
atomicExclusive(claimPrivate, { ...privateState, planDigest: plan.planDigest });
let claimsParent = fs.openSync(path.dirname(claimPlan), 'r');
try { fs.fsyncSync(claimsParent); } finally { fs.closeSync(claimsParent); }
fs.unlinkSync(pendingPlan);
const parent = fs.openSync(path.dirname(sequenceFile), 'r');
try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
NODE
    resolve_current_release
    SECRET_RESTART_REQUIRED="$($NODE_BIN -e '
const plan=require(process.argv[1]);
process.stdout.write(Object.values(plan.actions).includes("generate")?"true":"false");
' "$CLAIM_PLAN")"
    if [ "$SECRET_RESTART_REQUIRED" = true ]; then
      BACKUP_FILE="$BASE_DIR/.env.before-chat-capability-$TRANSACTION_ID"
      ROLLBACK_ARMED=true
      ENV_MUTATED=true
      "$NODE_BIN" --input-type=module - "$HELPER" "$ENV_FILE" "$CLAIM_PLAN" \
        "$CLAIM_PRIVATE" "$BACKUP_FILE" "$TRANSACTION_ID" <<'NODE'
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
const [helperPath,envFile,planFile,privateFile,backupFile,id] = process.argv.slice(2);
const helper = await import(pathToFileURL(helperPath).href);
const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'));
const privateState = JSON.parse(fs.readFileSync(privateFile, 'utf8'));
const source = fs.readFileSync(envFile, 'utf8');
const stat = fs.lstatSync(envFile);
helper.assertDotenvCasPrecondition({
  expectedSha256: privateState.environmentPrecondition.sha256,
  expectedFileIdentity: {
    device: privateState.environmentPrecondition.device,
    inode: privateState.environmentPrecondition.inode,
    size: privateState.environmentPrecondition.size,
    mtimeMs: privateState.environmentPrecondition.mtimeMs,
  },
  observedContents: source,
  observedFileIdentity: {
    device: stat.dev, inode: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs,
  },
});
const rewritten = helper.rewriteCapabilitySecretDotenv({
  source,
  plan,
  generateSecret: () => randomBytes(32).toString('hex'),
});
privateState.mutation = {
  preimageSha256: createHash('sha256').update(Buffer.from(source)).digest('hex'),
  mutatedSha256: createHash('sha256').update(Buffer.from(rewritten.contents)).digest('hex'),
};
const privateNext = `${privateFile}.next-${id}`;
const privateFd = fs.openSync(privateNext, 'wx', 0o600);
try { fs.writeFileSync(privateFd, `${JSON.stringify(privateState)}\n`); fs.fsyncSync(privateFd); }
finally { fs.closeSync(privateFd); }
fs.renameSync(privateNext, privateFile);
let parent = fs.openSync(path.dirname(privateFile), 'r');
try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
helper.replaceCapabilitySecretDotenvFile({
  filePath: envFile,
  backupPath: backupFile,
  expectedContents: source,
  nextContents: rewritten.contents,
  temporarySuffix: id,
});
NODE
      resolve_current_release
      write_runtime_permit apply "$CLAIM_PRIVATE" configuredFlags
      restart_backend
    fi
    PM2_AFTER_TEMP="$(mktemp "$STATE_ROOT/.pm2-after.XXXXXX")"
    write_pm2_snapshot "$PM2_AFTER_TEMP"
    assert_pm2_transition "$PM2_BEFORE_TEMP" "$PM2_AFTER_TEMP" "$SECRET_RESTART_REQUIRED"
    BACKEND_PID="$($NODE_BIN -e 'const fs=require("node:fs");process.stdout.write(String(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).backend.pid))' "$PM2_AFTER_TEMP")"
    if [ "$SECRET_RESTART_REQUIRED" = true ]; then
      wait_healthy "$CLAIM_PRIVATE" configuredFlags "$BACKEND_PID" authorized
    else
      wait_healthy "$CLAIM_PRIVATE" configuredFlags "$BACKEND_PID" clear
    fi
    RECEIPT_TEMP="$(mktemp "$STATE_ROOT/.secret-receipt.XXXXXX")"
    "$NODE_BIN" --input-type=module - "$HELPER" "$CLAIM_PLAN" "$RECEIPT_TEMP" \
      "$TRANSACTION_ID" "$STARTED_AT" <<'NODE'
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
const [helperPath,planFile,receiptFile,transactionId,startedAt] = process.argv.slice(2);
const helper = await import(pathToFileURL(helperPath).href);
const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'));
const receipt = helper.buildCapabilitySecretReceipt({
  plan, transactionId, status: 'passed', startedAt,
  completedAt: new Date().toISOString(),
  health: { backend: 'passed', identity: 'passed' },
  rollback: { status: 'not_required' },
});
helper.validateCapabilitySecretReceipt(receipt);
fs.writeFileSync(receiptFile, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
NODE
    atomic_write_json "$CLAIM_RECEIPT" "$RECEIPT_TEMP"
    RECEIPT_WRITTEN=true
    ROLLBACK_ARMED=false
    ENV_MUTATED=false
    if [ -n "$BACKUP_FILE" ]; then
      durable_remove "$BACKUP_FILE"
      durable_remove "$PERMIT_FILE"
      wait_healthy "$CLAIM_PRIVATE" configuredFlags "$BACKEND_PID" clear
    fi
    atomic_write_json "$STATE_ROOT/$ROLE.json" "$CLAIM_RECEIPT"
    rm -f -- "$RECEIPT_TEMP"
    cat "$STATE_ROOT/$ROLE.json"
    ;;
esac
