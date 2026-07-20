#!/usr/bin/env bash
# Full local Nexus product engine runner.
#
# This is a pre-production validation harness for the whole local product
# runtime behind the iOS app. It deliberately defaults to local-only data,
# loopback binding, blank model-provider keys, and a local SQLite database.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_DIR="${FULL_NEXUS_STATE_DIR:-$ROOT/.local/full-nexus}"
BACKEND_PID_FILE="$STATE_DIR/backend.pid"
CONTENT_PID_FILE="$STATE_DIR/content-engine.pid"
AUTH_FILE="${FULL_NEXUS_AUTH_FILE:-$STATE_DIR/local-ios-auth.json}"
LOG_DIR="$STATE_DIR/logs"
ENV_FILE="${FULL_NEXUS_ENV_FILE:-$ROOT/.env.local-full-nexus}"

DEFAULT_PORT="${PORTAL_PORT:-8200}"
DEFAULT_BIND="${PORTAL_BIND:-127.0.0.1}"
DEFAULT_CONTENT_PORT="${CONTENT_ENGINE_PORT:-8102}"
BASE_URL="${FULL_NEXUS_BASE_URL:-http://127.0.0.1:${DEFAULT_PORT}}"
LOCAL_DEVICE_ID="${FULL_NEXUS_DEVICE_ID:-local-full-nexus-smoke-device}"
LOCAL_INVITE_CODE="${IOS_INVITE_CODE:-LOCAL-BETA-2026}"

usage() {
  cat <<'EOF'
Usage:
  scripts/full-nexus-local-engine.sh <command>

Commands:
  doctor       Print local runtime prerequisites and current state.
  start        Build and start the local backend, plus optional content engine.
  up           Build and run the backend attached in the foreground.
  health       Probe public local health/API endpoints.
  auth-token   Register a local sandbox iOS user and write an auth token file.
  smoke        Run local health and authenticated iOS API smoke when possible.
  chat-tenant-smoke
               Seed local Chat tenants/context and run tenant-isolation smoke.
  cross-skill-fixtures
               Run deterministic Training/Secretary/Cooking/Finance/Content fixture checks.
  chat-eval    Run deterministic Chat evaluation and day-to-day simulation fixtures.
  full-smoke   Run health/auth smoke plus local fixture/security smoke commands.
  status       Show PID, port, and auth-token state.
  stop         Stop local backend/content-engine processes started by this runner.
  cleanup      Remove local smoke artifacts after services are stopped.

Important env vars:
  FULL_NEXUS_ENV_FILE                         Optional local env file.
  NEXUS_LOCAL_START_CONTENT_ENGINE=1          Also start Python content engine.
  NEXUS_LOCAL_ALLOW_MODEL_CALLS=1             Preserve model-provider keys.
  NEXUS_LOCAL_RUN_AUTH_SMOKE=0                Skip authenticated API smoke.
  FULL_NEXUS_RESET_DB=1                       Remove local DB during cleanup.
EOF
}

ensure_dirs() {
  mkdir -p "$STATE_DIR" "$LOG_DIR" "$ROOT/data"
  if [[ "${NEXUS_CONTENT_LIVE_EVAL_RUNTIME:-0}" == "1" ]]; then
    chmod 700 "$STATE_DIR" "$LOG_DIR"
  fi
}

run_backend_process() {
  if [[ "${NEXUS_CONTENT_LIVE_EVAL_RUNTIME:-0}" != "1" ]]; then
    exec node dist/index.js
  fi
  exec env -i \
    HOME="${HOME:-/tmp}" PATH="$PATH" TMPDIR="${TMPDIR:-/tmp}" \
    NODE_ENV=development ENV=development STAGING=false \
    NEXUS_CONTENT_LIVE_EVAL_RUNTIME=1 NEXUS_BACKGROUND_JOBS_ENABLED=0 \
    CONTENT_LIVE_EVAL_ENABLED=1 NEXUS_LOCAL_ALLOW_MODEL_CALLS=1 \
    PAID_AI_COST_CONTROLS_ENFORCEMENT_ENABLED=true \
    DATABASE_PATH="$DATABASE_PATH" PORTAL_ENABLED=true PORTAL_BIND=127.0.0.1 PORTAL_PORT="$PORTAL_PORT" \
    PORTAL_ALLOW_LOCAL_BYPASS=true HEALTH_ALLOW_UNAUTHENTICATED=true IOS_API_ENABLED=true \
    IOS_API_JWT_SECRET="$IOS_API_JWT_SECRET" IOS_INVITE_CODE="$IOS_INVITE_CODE" IOS_OWNER_CODE="$IOS_OWNER_CODE" \
    PAYWALL_ENABLED=false OAUTH_ENCRYPTION_KEY="$OAUTH_ENCRYPTION_KEY" FINANCE_ENCRYPTION_ENABLED=false BACKUP_ENABLED=false \
    CONTENT_ENGINE_ENABLED=true CONTENT_ENGINE_PORT="$CONTENT_ENGINE_PORT" CONTENT_ENGINE_BASE_URL="http://127.0.0.1:$CONTENT_ENGINE_PORT" \
    INTERNAL_API_SECRET="$INTERNAL_API_SECRET" INTERNAL_ATTRIBUTION_SECRET="${INTERNAL_ATTRIBUTION_SECRET:-$INTERNAL_API_SECRET}" INTERNAL_REQUIRE_LOOPBACK=true \
    TELEGRAM_LEGACY_DELIVERY=false TELEGRAM_BOT_TOKEN=content-live-eval-disabled \
    LOG_LEVEL="${LOG_LEVEL:-info}" TIMEZONE="${TIMEZONE:-Europe/Lisbon}" AI_CALL_TIMEOUT_MS="${AI_CALL_TIMEOUT_MS:-15000}" \
    GLOBAL_DAILY_COST_LIMIT="$GLOBAL_DAILY_COST_LIMIT" PER_USER_DAILY_USD_CAP="${PER_USER_DAILY_USD_CAP:-1.00}" \
    OPENAI_API_KEY="${OPENAI_API_KEY:-}" OPENAI_MODEL="${OPENAI_MODEL:-}" OPENAI_CLASSIFIER_MODEL="${OPENAI_CLASSIFIER_MODEL:-}" \
    GEMINI_API_KEY="${GEMINI_API_KEY:-}" GEMINI_MODEL="${GEMINI_MODEL:-}" GEMINI_CLASSIFIER_MODEL="${GEMINI_CLASSIFIER_MODEL:-}" GEMINI_FALLBACK_MODEL="${GEMINI_FALLBACK_MODEL:-}" \
    ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-}" ANTHROPIC_ENABLED="${ANTHROPIC_ENABLED:-false}" ANTHROPIC_MODEL="${ANTHROPIC_MODEL:-}" ANTHROPIC_CLASSIFIER_MODEL="${ANTHROPIC_CLASSIFIER_MODEL:-}" \
    AI_CLASSIFY_PRIMARY="${AI_CLASSIFY_PRIMARY:-}" AI_CLASSIFY_FALLBACK="${AI_CLASSIFY_FALLBACK:-}" \
    AI_CHAT_PRIMARY="${AI_CHAT_PRIMARY:-}" AI_CHAT_FALLBACK="${AI_CHAT_FALLBACK:-}" \
    AI_TOOL_USE_PRIMARY="${AI_TOOL_USE_PRIMARY:-}" AI_TOOL_USE_FALLBACK="${AI_TOOL_USE_FALLBACK:-}" \
    AI_SCRIPT_GENERATION_PRIMARY="${AI_SCRIPT_GENERATION_PRIMARY:-}" AI_SCRIPT_GENERATION_FALLBACK="${AI_SCRIPT_GENERATION_FALLBACK:-}" \
    node dist/index.js
}

run_content_engine_process() {
  local python_bin="$1"
  if [[ "${NEXUS_CONTENT_LIVE_EVAL_RUNTIME:-0}" != "1" ]]; then
    exec "$python_bin" main.py
  fi
  exec env -i \
    HOME="${HOME:-/tmp}" PATH="$PATH" TMPDIR="${TMPDIR:-/tmp}" \
    PYTHONPATH="$ROOT/content-engine" NODE_ENV=development ENV=development \
    NEXUS_CONTENT_LIVE_EVAL_RUNTIME=1 NEXUS_LOCAL_ALLOW_MODEL_CALLS=1 CONTENT_ENGINE_FIXTURE_MODE=0 CONTENT_ENGINE_RESEARCH_NETWORK_DISABLED=1 \
    CONTENT_ENGINE_PORT="$CONTENT_ENGINE_PORT" NEXUS_BACKEND_BASE_URL="$BASE_URL" \
    INTERNAL_API_SECRET="$INTERNAL_API_SECRET" \
    "$python_bin" main.py
}

source_env_file() {
  if [[ -f "$ENV_FILE" ]]; then
    # shellcheck disable=SC1090
    set -a; source "$ENV_FILE"; set +a
  fi
}

apply_local_defaults() {
  export NODE_ENV="${NODE_ENV:-development}"
  export ENV="${ENV:-development}"
  export STAGING="${STAGING:-false}"
  export TELEGRAM_LEGACY_DELIVERY="${TELEGRAM_LEGACY_DELIVERY:-false}"
  export TELEGRAM_BOT_TOKEN="${TELEGRAM_BOT_TOKEN:-local-full-nexus-telegram-token-disabled}"
  export TELEGRAM_ALLOWED_USER_IDS="${TELEGRAM_ALLOWED_USER_IDS:-100000001}"
  export OWNER_TELEGRAM_ID="${OWNER_TELEGRAM_ID:-100000001}"
  export PORTAL_ENABLED="${PORTAL_ENABLED:-true}"
  export PORTAL_BIND="${PORTAL_BIND:-$DEFAULT_BIND}"
  export PORTAL_PORT="${PORTAL_PORT:-$DEFAULT_PORT}"
  export PORTAL_ALLOW_LOCAL_BYPASS="${PORTAL_ALLOW_LOCAL_BYPASS:-true}"
  export HEALTH_ALLOW_UNAUTHENTICATED="${HEALTH_ALLOW_UNAUTHENTICATED:-true}"
  export IOS_API_ENABLED="${IOS_API_ENABLED:-true}"
  export IOS_API_JWT_SECRET="${IOS_API_JWT_SECRET:-local-full-nexus-ios-jwt-secret-000000000000000000000000000000}"
  export IOS_INVITE_CODE="${IOS_INVITE_CODE:-$LOCAL_INVITE_CODE}"
  export IOS_OWNER_CODE="${IOS_OWNER_CODE:-LOCAL-OWNER-2026}"
  export PAYWALL_ENABLED="${PAYWALL_ENABLED:-false}"
  export DATABASE_PATH="${DATABASE_PATH:-$ROOT/data/local-full-nexus-smoke.db}"
  export OAUTH_ENCRYPTION_KEY="${OAUTH_ENCRYPTION_KEY:-local-full-nexus-oauth-key-000000000000000000000000000000}"
  export FINANCE_ENCRYPTION_ENABLED="${FINANCE_ENCRYPTION_ENABLED:-false}"
  export BACKUP_ENABLED="${BACKUP_ENABLED:-false}"
  export CONTENT_ENGINE_ENABLED="${CONTENT_ENGINE_ENABLED:-false}"
  export CONTENT_ENGINE_PORT="${CONTENT_ENGINE_PORT:-$DEFAULT_CONTENT_PORT}"
  export INTERNAL_API_SECRET="${INTERNAL_API_SECRET:-local-full-nexus-internal-secret}"
  export NEXUS_MULTISKILL_MESH="${NEXUS_MULTISKILL_MESH:-on}"
  export LOG_LEVEL="${LOG_LEVEL:-info}"
  export TIMEZONE="${TIMEZONE:-Europe/Lisbon}"
  export AI_CALL_TIMEOUT_MS="${AI_CALL_TIMEOUT_MS:-15000}"
  export GLOBAL_DAILY_COST_LIMIT="${GLOBAL_DAILY_COST_LIMIT:-1.00}"

  if [[ "${NEXUS_LOCAL_ALLOW_MODEL_CALLS:-0}" != "1" ]]; then
    export OPENAI_API_KEY=""
    export GEMINI_API_KEY=""
    export ANTHROPIC_API_KEY=""
    export ANTHROPIC_ENABLED="false"
  fi
}

load_env() {
  source_env_file
  apply_local_defaults
  BASE_URL="${FULL_NEXUS_BASE_URL:-http://127.0.0.1:${PORTAL_PORT}}"
  LOCAL_INVITE_CODE="${IOS_INVITE_CODE}"
}

is_pid_running() {
  local pid="$1"
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null
}

pid_from_file() {
  local file="$1"
  [[ -f "$file" ]] && tr -d '[:space:]' < "$file" || true
}

wait_for_url() {
  local url="$1"
  local label="$2"
  local attempts="${3:-40}"
  local i
  for ((i = 1; i <= attempts; i++)); do
    if curl -fsS "$url" >/dev/null 2>&1; then
      echo "OK: $label is reachable at $url"
      return 0
    fi
    sleep 1
  done
  echo "ERROR: $label did not become reachable at $url" >&2
  return 1
}

tail_backend_log() {
  if [[ -f "$LOG_DIR/backend.log" ]]; then
    echo "Last backend log lines:" >&2
    tail -n 80 "$LOG_DIR/backend.log" >&2 || true
  fi
}

verify_backend_pid() {
  local pid
  pid="$(pid_from_file "$BACKEND_PID_FILE")"
  if ! is_pid_running "$pid"; then
    echo "ERROR: local backend process exited during startup." >&2
    tail_backend_log
    return 1
  fi
}

port_busy() {
  local port="$1"
  lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1
}

start_backend() {
  local existing
  existing="$(pid_from_file "$BACKEND_PID_FILE")"
  if is_pid_running "$existing"; then
    echo "Backend already running with PID $existing"
    return 0
  fi
  if port_busy "$PORTAL_PORT"; then
    echo "ERROR: port $PORTAL_PORT is already in use. Stop the owner before starting local Nexus." >&2
    return 1
  fi

  echo "Building backend..."
  (cd "$ROOT" && npm run build)

  echo "Starting local backend on ${PORTAL_BIND}:${PORTAL_PORT} with DB ${DATABASE_PATH}"
  (
    cd "$ROOT"
    if [[ "${NEXUS_CONTENT_LIVE_EVAL_RUNTIME:-0}" == "1" ]]; then
      run_backend_process >"$LOG_DIR/backend.log" 2>&1 < /dev/null &
    else
      nohup node dist/index.js >"$LOG_DIR/backend.log" 2>&1 < /dev/null &
    fi
    echo $! > "$BACKEND_PID_FILE"
  )
  if ! wait_for_url "$BASE_URL/api/v1/" "iOS API"; then
    tail_backend_log
    return 1
  fi
  verify_backend_pid
}

start_content_engine() {
  if [[ "${NEXUS_LOCAL_START_CONTENT_ENGINE:-0}" != "1" ]]; then
    return 0
  fi
  local existing
  existing="$(pid_from_file "$CONTENT_PID_FILE")"
  if is_pid_running "$existing"; then
    echo "Content engine already running with PID $existing"
    return 0
  fi
  if port_busy "$CONTENT_ENGINE_PORT"; then
    echo "ERROR: content-engine port $CONTENT_ENGINE_PORT is already in use." >&2
    return 1
  fi
  local python_bin="$ROOT/content-engine/.venv/bin/python"
  if [[ ! -x "$python_bin" ]]; then
    python_bin="$ROOT/content-engine/.venv313/bin/python"
  fi
  if [[ ! -x "$python_bin" ]]; then
    echo "ERROR: content-engine virtualenv not found. Expected content-engine/.venv/bin/python." >&2
    return 1
  fi
  echo "Starting content engine on 127.0.0.1:${CONTENT_ENGINE_PORT}"
  (
    cd "$ROOT/content-engine"
    if [[ "${NEXUS_CONTENT_LIVE_EVAL_RUNTIME:-0}" == "1" ]]; then
      run_content_engine_process "$python_bin" >"$LOG_DIR/content-engine.log" 2>&1 < /dev/null &
    else
      nohup "$python_bin" main.py >"$LOG_DIR/content-engine.log" 2>&1 < /dev/null &
    fi
    echo $! > "$CONTENT_PID_FILE"
  )
  wait_for_url "http://127.0.0.1:${CONTENT_ENGINE_PORT}/health" "content engine"
}

command_start() {
  ensure_dirs
  load_env
  start_backend
  start_content_engine
  echo "Local full Nexus product engine started."
  echo "Base URL: $BASE_URL"
  echo "Logs: $LOG_DIR"
}

command_up() {
  ensure_dirs
  load_env
  echo "Building backend..."
  (cd "$ROOT" && npm run build)
  echo "Running local backend attached on ${PORTAL_BIND}:${PORTAL_PORT} with DB ${DATABASE_PATH}"
  echo "Use Ctrl-C to stop. This mode is useful in CI/Codex shells that reap detached background jobs."
  cd "$ROOT"
  exec npm start
}

command_health() {
  ensure_dirs
  load_env
  echo "Checking $BASE_URL/api/v1/"
  curl -fsS "$BASE_URL/api/v1/" | node -e "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{const j=JSON.parse(s); console.log(JSON.stringify({name:j.name,version:j.version,status:j.status},null,2));})"
  if [[ "${NEXUS_LOCAL_START_CONTENT_ENGINE:-0}" == "1" ]]; then
    echo "Checking content engine"
    curl -fsS "http://127.0.0.1:${CONTENT_ENGINE_PORT}/health"
    echo
  fi
}

command_auth_token() {
  ensure_dirs
  load_env
  local legal_metadata
  legal_metadata="$(mktemp)"
  curl -fsS \
    -H "Accept: application/json" \
    "$BASE_URL/api/v1/legal/current" > "$legal_metadata"
  local payload
  payload="$(mktemp)"
  node - "$legal_metadata" "$payload" "$LOCAL_DEVICE_ID" "$LOCAL_INVITE_CODE" <<'EOF'
const fs = require('fs');
const metadata = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const legal = metadata.data || metadata;
const termsVersion = legal.documents?.terms?.version;
const privacyVersion = legal.documents?.privacy?.version;
if (!termsVersion || !privacyVersion) {
  console.error('Legal metadata did not contain current terms and privacy versions');
  process.exit(1);
}
fs.writeFileSync(process.argv[3], JSON.stringify({
  deviceId: process.argv[4],
  deviceName: 'Local Full Nexus Smoke',
  inviteCode: process.argv[5],
  acceptedLegal: {
    accepted: true,
    termsVersion,
    privacyVersion,
  },
}));
EOF
  rm -f "$legal_metadata"
  local response
  response="$(mktemp)"
  echo "Registering local sandbox iOS user at $BASE_URL/api/v1/auth/register"
  curl -fsS \
    -H "Content-Type: application/json" \
    -H "Accept: application/json" \
    -d @"$payload" \
    "$BASE_URL/api/v1/auth/register" > "$response"
  rm -f "$payload"
  node - "$response" "$AUTH_FILE" <<'EOF'
const fs = require('fs');
const source = process.argv[2];
const target = process.argv[3];
const raw = fs.readFileSync(source, 'utf8');
const json = JSON.parse(raw);
const payload = json.data || json;
if (!payload.accessToken) {
  console.error('Auth response did not contain accessToken');
  process.exit(1);
}
const normalized = {
  accessToken: payload.accessToken,
  refreshToken: payload.refreshToken,
  expiresIn: payload.expiresIn,
  user: payload.user,
};
fs.writeFileSync(target, JSON.stringify(normalized, null, 2));
console.log(JSON.stringify({
  ok: true,
  userId: payload.user?.id,
  expiresIn: payload.expiresIn,
  tokenFile: target,
}, null, 2));
EOF
  rm -f "$response"
}

command_smoke() {
  ensure_dirs
  load_env
  command_health
  if [[ "${NEXUS_LOCAL_RUN_AUTH_SMOKE:-1}" != "1" ]]; then
    echo "Authenticated API smoke skipped by NEXUS_LOCAL_RUN_AUTH_SMOKE=0"
    return 0
  fi
  if [[ ! -s "$AUTH_FILE" ]]; then
    command_auth_token
  fi
  echo "Running authenticated iOS API smoke against $BASE_URL"
  BASE_URL="$BASE_URL" "$ROOT/scripts/authenticated-api-smoke.sh" --base-url "$BASE_URL" --token-file "$AUTH_FILE"
}

command_chat_tenant_smoke() {
  ensure_dirs
  load_env
  if ! curl -fsS "$BASE_URL/api/v1/" >/dev/null 2>&1; then
    echo "ERROR: local backend is not reachable at $BASE_URL. Start it with 'start' or 'up' first." >&2
    return 1
  fi
  echo "Running Chat tenant-isolation smoke against $BASE_URL"
  CHAT_TENANT_SMOKE_BASE_URL="$BASE_URL" \
    IOS_INVITE_CODE="$LOCAL_INVITE_CODE" \
    PORTAL_ADMIN_TOKEN="${PORTAL_ADMIN_TOKEN:-local-chat-tenant-admin}" \
    DATABASE_PATH="$DATABASE_PATH" \
    node "$ROOT/scripts/chat-tenant-security-smoke.js" \
      --base-url "$BASE_URL" \
      --invite-code "$LOCAL_INVITE_CODE" \
      --portal-admin-token "${PORTAL_ADMIN_TOKEN:-local-chat-tenant-admin}"
}

command_cross_skill_fixtures() {
  ensure_dirs
  load_env
  local results_path="$STATE_DIR/cross-skill-fixture-results.md"
  echo "Running deterministic cross-skill fixture checks"
  set +e
  TRAINING_CROSS_SKILL_STAGING_RESULTS_PATH="$results_path" \
    "$ROOT/scripts/training-cross-skill-staging-smoke.sh" --dry-run
  local rc=$?
  set -e
  if [[ "$rc" -eq 1 ]]; then
    return 1
  fi
  if [[ "$rc" -eq 2 ]]; then
    echo "Cross-skill fixture checks completed; staging runtime section is blocked by design in local dry-run mode."
  elif [[ "$rc" -ne 0 ]]; then
    return "$rc"
  fi
  echo "Cross-skill fixture report: $results_path"
}

command_chat_eval() {
  ensure_dirs
  load_env
  if [[ ! -f "$ROOT/dist/tools/chat-evaluation-harness.js" || ! -f "$ROOT/dist/tools/chat-day-to-day-simulation.js" ]]; then
    echo "Building backend tools for Chat fixture evaluation..."
    (cd "$ROOT" && npm run build)
  fi
  echo "Running deterministic Chat evaluation fixtures"
  (cd "$ROOT" && CHAT_EVAL_MODE=fixture node dist/tools/chat-evaluation-harness.js)
  echo "Running deterministic Chat day-to-day simulation fixtures"
  (cd "$ROOT" && node dist/tools/chat-day-to-day-simulation.js)
}

command_full_smoke() {
  ensure_dirs
  load_env
  command_smoke
  command_chat_tenant_smoke
  command_cross_skill_fixtures
  command_chat_eval
}

stop_pid_file() {
  local label="$1"
  local file="$2"
  local pid
  pid="$(pid_from_file "$file")"
  if ! is_pid_running "$pid"; then
    [[ -f "$file" ]] && rm -f "$file"
    echo "$label: not running"
    return 0
  fi
  echo "Stopping $label PID $pid"
  kill "$pid" 2>/dev/null || true
  local i
  for ((i = 1; i <= 20; i++)); do
    if ! is_pid_running "$pid"; then
      rm -f "$file"
      echo "$label stopped"
      return 0
    fi
    sleep 1
  done
  echo "Force-stopping $label PID $pid"
  kill -9 "$pid" 2>/dev/null || true
  rm -f "$file"
}

command_stop() {
  ensure_dirs
  load_env
  stop_pid_file "content engine" "$CONTENT_PID_FILE"
  stop_pid_file "backend" "$BACKEND_PID_FILE"
  echo "Port verification:"
  lsof -nP -iTCP:"$PORTAL_PORT" -sTCP:LISTEN || true
  if [[ "${NEXUS_LOCAL_START_CONTENT_ENGINE:-0}" == "1" ]]; then
    lsof -nP -iTCP:"$CONTENT_ENGINE_PORT" -sTCP:LISTEN || true
  fi
}

command_status() {
  ensure_dirs
  load_env
  local backend_pid content_pid
  backend_pid="$(pid_from_file "$BACKEND_PID_FILE")"
  content_pid="$(pid_from_file "$CONTENT_PID_FILE")"
  echo "Backend PID: ${backend_pid:-none}"
  if is_pid_running "$backend_pid"; then echo "Backend running: yes"; else echo "Backend running: no"; fi
  if port_busy "$PORTAL_PORT"; then echo "Backend listener: yes"; else echo "Backend listener: no"; fi
  echo "Content PID: ${content_pid:-none}"
  if is_pid_running "$content_pid"; then echo "Content running: yes"; else echo "Content running: no"; fi
  echo "Base URL: $BASE_URL"
  echo "DB: $DATABASE_PATH"
  echo "Auth file: $AUTH_FILE"
  [[ -s "$AUTH_FILE" ]] && echo "Auth token: present" || echo "Auth token: absent"
  echo "Listeners:"
  lsof -nP -iTCP:"$PORTAL_PORT" -sTCP:LISTEN || true
}

command_cleanup() {
  ensure_dirs
  load_env
  command_stop
  rm -f "$AUTH_FILE"
  if [[ "${FULL_NEXUS_RESET_DB:-0}" == "1" ]]; then
    rm -f "$DATABASE_PATH" "$DATABASE_PATH-shm" "$DATABASE_PATH-wal"
    echo "Removed local smoke DB: $DATABASE_PATH"
  fi
  find "$STATE_DIR" -type f -name '*.tmp' -delete 2>/dev/null || true
  echo "Cleanup complete."
}

command_doctor() {
  ensure_dirs
  load_env
  echo "Full local Nexus product engine doctor"
  echo "Root: $ROOT"
  echo "Branch: $(git -C "$ROOT" branch --show-current)"
  echo "Commit: $(git -C "$ROOT" rev-parse --short HEAD)"
  echo "Node: $(node --version 2>/dev/null || echo missing)"
  echo "npm: $(npm --version 2>/dev/null || echo missing)"
  echo "curl: $(command -v curl || echo missing)"
  echo "lsof: $(command -v lsof || echo missing)"
  echo "Backend port: $PORTAL_PORT"
  echo "Content port: $CONTENT_ENGINE_PORT"
  echo "Env file: $ENV_FILE"
  echo "Env file exists: $([[ -f "$ENV_FILE" ]] && echo yes || echo no)"
  echo "Model calls allowed: ${NEXUS_LOCAL_ALLOW_MODEL_CALLS:-0}"
  echo "Content engine requested: ${NEXUS_LOCAL_START_CONTENT_ENGINE:-0}"
  echo "Local DB: $DATABASE_PATH"
}

main() {
  local command="${1:-}"
  case "$command" in
    doctor) command_doctor ;;
    start) command_start ;;
    up) command_up ;;
    health) command_health ;;
    auth-token) command_auth_token ;;
    smoke) command_smoke ;;
    chat-tenant-smoke) command_chat_tenant_smoke ;;
    cross-skill-fixtures) command_cross_skill_fixtures ;;
    chat-eval) command_chat_eval ;;
    full-smoke) command_full_smoke ;;
    status) command_status ;;
    stop) command_stop ;;
    cleanup) command_cleanup ;;
    -h|--help|help|"") usage ;;
    *)
      echo "Unknown command: $command" >&2
      usage
      exit 1
      ;;
  esac
}

main "$@"
