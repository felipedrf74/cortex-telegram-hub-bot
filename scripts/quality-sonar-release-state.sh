#!/usr/bin/env bash
# Least-privilege release-side view of one Sonar project's Compute Engine state.
# The deploy account receives only the aggregate JSON, never the monitor token.
set -euo pipefail
umask 077

PROJECT_KEY=""
JSON_OUTPUT=false
SONAR_URL="http://127.0.0.1:9000"
TOKEN_FILE="/etc/sonarqube/release-monitor.token"
CURL_BIN="$(command -v curl 2>/dev/null || true)"
NODE_BIN="$(command -v node 2>/dev/null || true)"

usage() {
  echo "Usage: quality-sonar-release-state --project <key> --json"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --project) PROJECT_KEY="$2"; shift 2 ;;
    --json) JSON_OUTPUT=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 64 ;;
  esac
done

[[ "$PROJECT_KEY" =~ ^[A-Za-z0-9_.:-]+$ ]] || { echo "Invalid Sonar project key" >&2; exit 64; }
[ "$JSON_OUTPUT" = true ] || { echo "--json is required" >&2; exit 64; }

parse_active_tasks() {
  local component_file="$1" project_key="$2"
  "$NODE_BIN" - "$component_file" "$project_key" <<'NODE'
const fs = require('fs');
const [componentPath, projectKey] = process.argv.slice(2);
const value = JSON.parse(fs.readFileSync(componentPath, 'utf8'));
if (!value || typeof value !== 'object' || Array.isArray(value)
    || !Array.isArray(value.queue)) process.exit(1);

const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const seen = new Set();
function validateTask(task, statuses) {
  if (!task || typeof task !== 'object' || Array.isArray(task)
      || !idPattern.test(task.id || '') || !statuses.has(task.status)
      || (task.componentKey !== undefined && task.componentKey !== projectKey)
      || seen.has(task.id)) process.exit(1);
  seen.add(task.id);
}

for (const task of value.queue) {
  validateTask(task, new Set(['PENDING', 'IN_PROGRESS']));
}

let currentActive = 0;
if (value.current !== undefined && value.current !== null) {
  validateTask(
    value.current,
    new Set(['IN_PROGRESS', 'SUCCESS', 'FAILED', 'CANCELED']),
  );
  currentActive = value.current.status === 'IN_PROGRESS' ? 1 : 0;
}
process.stdout.write(String(value.queue.length + currentActive));
NODE
}

[ -x "$NODE_BIN" ] || { echo "node is required" >&2; exit 1; }
if [ "${NEXUS_RELEASE_TEST_MODE:-0}" = 1 ] \
    && [ -n "${NEXUS_SONAR_RELEASE_STATE_COMPONENT_FILE:-}" ]; then
  fixture="$NEXUS_SONAR_RELEASE_STATE_COMPONENT_FILE"
  [ -f "$fixture" ] && [ ! -L "$fixture" ] || {
    echo "Sonar CE test fixture is missing or unsafe" >&2
    exit 1
  }
  parse_active_tasks "$fixture" "$PROJECT_KEY" \
    || { echo "Sonar CE project response is invalid" >&2; exit 1; }
  exit 0
fi

[ "$(id -u)" -eq 0 ] || { echo "Sonar release-state monitor must run as root" >&2; exit 1; }
[ -x "$CURL_BIN" ] && [ -x "$NODE_BIN" ] || { echo "curl and node are required" >&2; exit 1; }

tmp_root="$(mktemp -d)"
status_body="$tmp_root/status.json"
component_body="$tmp_root/component.json"
auth_header="$tmp_root/auth-header"
cleanup() {
  unset token
  rm -rf "$tmp_root"
}
trap cleanup EXIT

set +e
status_code="$($CURL_BIN --silent --show-error --connect-timeout 2 --max-time 5 \
  --output "$status_body" --write-out '%{http_code}' "$SONAR_URL/api/system/status" 2>/dev/null)"
status_exit=$?
set -e
if [ "$status_exit" -eq 7 ]; then
  printf '{"schema":"nexus.sonarqube-release-state.v1","status":"passed","projectKey":"%s","activeTasks":0}\n' "$PROJECT_KEY"
  exit 0
fi
[ "$status_exit" -eq 0 ] && [ "$status_code" = 200 ] || {
  echo "Sonar status endpoint is unavailable" >&2
  exit 1
}
sonar_status="$($NODE_BIN -e 'const x=require(process.argv[1]);process.stdout.write(String(x.status||""))' "$status_body")"
[ "$sonar_status" = UP ] || { echo "Sonar is reachable but not UP" >&2; exit 1; }

[ -f "$TOKEN_FILE" ] && [ ! -L "$TOKEN_FILE" ] || { echo "Root Sonar release-monitor token is missing" >&2; exit 1; }
[ "$(stat -c '%a' "$TOKEN_FILE")" = 600 ] || { echo "Sonar release-monitor token must have mode 0600" >&2; exit 1; }
[ "$(stat -c '%U' "$TOKEN_FILE")" = root ] || { echo "Sonar release-monitor token must be root-owned" >&2; exit 1; }
token="$(tr -d '\r\n' <"$TOKEN_FILE")"
[[ "$token" =~ ^[A-Za-z0-9._-]{10,200}$ ]] || { echo "Sonar release-monitor token is invalid" >&2; exit 1; }
printf 'Authorization: Bearer %s\n' "$token" >"$auth_header"
chmod 0600 "$auth_header"
unset token

"$CURL_BIN" --fail --silent --show-error --connect-timeout 2 --max-time 5 \
  -H @"$auth_header" --get \
  --data-urlencode "component=$PROJECT_KEY" \
  "$SONAR_URL/api/ce/component" -o "$component_body"
active_tasks="$(parse_active_tasks "$component_body" "$PROJECT_KEY")" \
  || { echo "Sonar CE project response is invalid" >&2; exit 1; }

printf '{"schema":"nexus.sonarqube-release-state.v1","status":"passed","projectKey":"%s","activeTasks":%s}\n' \
  "$PROJECT_KEY" "$active_tasks"
