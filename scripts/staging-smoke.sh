#!/usr/bin/env bash
# ─────────────────────────────────────────────────────
# staging-smoke.sh — Smoke-test the staging install
#
# Quarter audit item: blue-green-lite "validated promote".
#
# Hits a curated list of staging endpoints and checks they return the
# expected shape. Exit code 0 = all tests passed (staging is safe to
# promote to prod). Exit code 1 = at least one test failed.
#
# Used as a gate by the exact release operator, which refuses to promote
# staging into prod unless this smoke test exits 0.
#
# Tests run from the SERVER (via ssh) because that's the only place that
# can reach 8201/8101 (staging is bound to localhost-only by default).
#
# What we test:
#   1. /health on both processes responds
#   2. /api/snapshot returns valid JSON with version + uptime
#   3. /api/cost-by-domain returns valid JSON with the new fields
#      (endpoints, providerSplit, dailySeries) — proves the cost
#      dashboard endpoint isn't broken
#   4. The DB is open and sane (PRAGMA integrity_check via the snapshot)
#   5. The bot mode is correct (polling=false in staging, true in prod)
#
# Usage:
#   ./scripts/staging-smoke.sh                # Run all tests
#   ./scripts/staging-smoke.sh -v             # Verbose output
# ─────────────────────────────────────────────────────
set -euo pipefail

SERVER="${DEPLOY_SERVER:-dominguez@serverdominguez}"
STAGING_ROOT="${STAGING_PATH:-/home/dominguez/telegram-hub-bot-staging}"
STAGING_RELEASE=""
VERBOSE=false
LOCAL_SERVER_MODE="${NEXUS_STAGING_SMOKE_LOCAL_SERVER:-0}"

# Every remote check remains sequential, but they reuse one authenticated SSH
# transport instead of paying a new handshake for each endpoint and database
# probe. The control socket lives in a private, short-path directory and is
# explicitly closed when the smoke command exits.
SSH_CONTROL_DIR="$(mktemp -d /tmp/nexus-staging-ssh.XXXXXX)"
chmod 700 "$SSH_CONTROL_DIR"
SSH_CONTROL_PATH="$SSH_CONTROL_DIR/control"

smoke_ssh() {
  if [ "$LOCAL_SERVER_MODE" = 1 ]; then
    [ "${1:-}" = "$SERVER" ] || {
      echo "local staging smoke received an unexpected server target" >&2
      return 64
    }
    shift
    if [ "$#" -eq 1 ]; then
      /bin/bash -c "$1"
    else
      command "$@"
    fi
    return
  fi
  command ssh \
    -o ControlMaster=auto \
    -o ControlPersist=30 \
    -o "ControlPath=$SSH_CONTROL_PATH" \
    "$@"
}

cleanup_smoke_transport() {
  if [ "$LOCAL_SERVER_MODE" != 1 ]; then
    command ssh -o "ControlPath=$SSH_CONTROL_PATH" -O exit "$SERVER" >/dev/null 2>&1 || true
  fi
  rm -f "$SSH_CONTROL_PATH" 2>/dev/null || true
  rmdir "$SSH_CONTROL_DIR" 2>/dev/null || true
}
trap cleanup_smoke_transport EXIT

resolve_staging_release() {
  smoke_ssh "$SERVER" bash -s -- "$STAGING_ROOT" <<'REMOTE_RESOLVE_STAGING'
set -euo pipefail
staging_root="$1"
case "$staging_root" in /*) ;; *) echo "staging root must be absolute" >&2; exit 64 ;; esac
[ "$staging_root" != / ] && [ -d "$staging_root" ] && [ ! -L "$staging_root" ] || {
  echo "staging root is missing, unsafe, or symbolic" >&2
  exit 1
}
[ -d "$staging_root/releases" ] && [ ! -L "$staging_root/releases" ] || {
  echo "staging releases directory is missing or unsafe" >&2
  exit 1
}
[ -f "$staging_root/.env" ] && [ ! -L "$staging_root/.env" ] || {
  echo "staging base environment is missing or unsafe" >&2
  exit 1
}
[ -d "$staging_root/data" ] && [ ! -L "$staging_root/data" ] || {
  echo "staging base data directory is missing or unsafe" >&2
  exit 1
}
[ -f "$staging_root/data/bot.db" ] && [ ! -L "$staging_root/data/bot.db" ] || {
  echo "staging base database is missing or unsafe" >&2
  exit 1
}
[ -L "$staging_root/current" ] || {
  echo "staging current selector is not a symlink" >&2
  exit 1
}
staging_release="$(readlink -f -- "$staging_root/current")"
case "$staging_release" in
  "$staging_root"/releases/*) ;;
  *) echo "staging current selector escapes releases" >&2; exit 1 ;;
esac
[ -d "$staging_release" ] && [ ! -L "$staging_release" ] || {
  echo "exact staging release is missing or unsafe" >&2
  exit 1
}
for required in dist node_modules scripts; do
  [ -d "$staging_release/$required" ] && [ ! -L "$staging_release/$required" ] || {
    echo "exact staging release is missing $required" >&2
    exit 1
  }
done
[ -L "$staging_release/.env" ] \
  && [ "$(readlink -f -- "$staging_release/.env")" = "$staging_root/.env" ] || {
  echo "exact staging release does not source the base environment" >&2
  exit 1
}
[ -L "$staging_release/data" ] \
  && [ "$(readlink -f -- "$staging_release/data")" = "$staging_root/data" ] || {
  echo "exact staging release does not use the base data directory" >&2
  exit 1
}
printf '%s\n' "$staging_release"
REMOTE_RESOLVE_STAGING
}

assert_staging_selector() {
  smoke_ssh "$SERVER" bash -s -- "$STAGING_ROOT" "$STAGING_RELEASE" <<'REMOTE_ASSERT_STAGING'
set -euo pipefail
staging_root="$1"
expected_release="$2"
[ -L "$staging_root/current" ]
actual_release="$(readlink -f -- "$staging_root/current")"
[ "$actual_release" = "$expected_release" ] || {
  echo "staging current selector changed during smoke operation" >&2
  exit 1
}
REMOTE_ASSERT_STAGING
}

if [ "${1:-}" = "-v" ]; then
  VERBOSE=true
fi

STAGING_RELEASE="$(resolve_staging_release)" || {
  echo "❌ Could not resolve a safe immutable staging/current release" >&2
  exit 1
}
assert_staging_selector

SMOKE_RUNTIME_SHA=''
SMOKE_ARTIFACT_DIGEST=''
read -r SMOKE_RUNTIME_SHA SMOKE_ARTIFACT_DIGEST < <(
  smoke_ssh "$SERVER" /usr/bin/node - "$STAGING_ROOT" "$STAGING_RELEASE" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const [root, release] = process.argv.slice(2);
const selector = path.join(root, 'current');
if (!fs.lstatSync(selector).isSymbolicLink() || fs.realpathSync(selector) !== release) {
  process.exit(1);
}
const file = path.join(release, '.complete.json');
const stat = fs.lstatSync(file);
const value = JSON.parse(fs.readFileSync(file, 'utf8'));
if (!stat.isFile() || stat.isSymbolicLink()
    || value?.schema !== 'nexus.release-bundle.v1'
    || !/^[0-9a-f]{40}$/u.test(value.runtimeSha ?? '')
    || !/^[0-9a-f]{64}$/u.test(value.artifactDigest ?? '')
    || path.basename(release) !== `${value.runtimeSha}-${value.artifactDigest.slice(0, 12)}`) {
  process.exit(1);
}
if (fs.realpathSync(selector) !== release) process.exit(1);
process.stdout.write(`${value.runtimeSha} ${value.artifactDigest}\n`);
NODE
) || {
  echo "exact staging completion identity is missing or invalid" >&2
  exit 1
}

if [ "${NEXUS_SMOKE_REQUIRE_EXACT_IDENTITY:-0}" = 1 ] || [ "$LOCAL_SERVER_MODE" = 1 ]; then
  [ "${NEXUS_RELEASE_SHA:-}" = "$SMOKE_RUNTIME_SHA" ] \
    && [ "${NEXUS_RELEASE_ARTIFACT_SHA256:-}" = "$SMOKE_ARTIFACT_DIGEST" ] || {
    echo "local server mode requires exact release identity" >&2
    exit 1
  }
fi

echo "═══════════════════════════════════════════════"
echo "  🧪 Nexus Hub Staging Smoke Test"
echo "═══════════════════════════════════════════════"
echo ""

PASS=0
FAIL=0
FAILED_TESTS=()

# ── Smoke-evidence JSON (release-pipeline-risk-based-optimization, 2026-05-03)
# Every check result also goes into an in-memory array so we can emit a
# single JSON evidence file at the end. The file is written under
# .local/release/smoke-evidence/ (mkdir-p safe) and named with the deployed
# SHA + UTC timestamp so the exact release operator and audits can read it
# instead of re-running this script. Disable with NEXUS_SMOKE_EVIDENCE=0.
EVIDENCE_RESULTS=()
EVIDENCE_ENABLED="${NEXUS_SMOKE_EVIDENCE:-1}"
LOCAL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
EVIDENCE_DIR="${NEXUS_SMOKE_EVIDENCE_DIR:-$LOCAL_DIR/.local/release/smoke-evidence}"
SMOKE_START_AT="$(node -e 'process.stdout.write(new Date().toISOString())')"
SMOKE_HEAD_SHA="$SMOKE_RUNTIME_SHA"
SMOKE_BRANCH="$(cd "$LOCAL_DIR" && git branch --show-current 2>/dev/null || echo unknown)"
SMOKE_PROFILE="nexus.staging-smoke.canonical.token-zero-locale.v2"
SMOKE_CLASSIFIER_BASE_SHA="${NEXUS_SMOKE_CLASSIFIER_BASE_SHA:-}"
SMOKE_CLASSIFIER_HEAD_SHA=""

evidence_record() {
  # evidence_record <name> <status:passed|failed> [<detail>]
  local name="$1"
  local status="$2"
  local detail="${3:-}"
  detail="${detail//$'\t'/ }"
  detail="${detail//$'\n'/; }"
  EVIDENCE_RESULTS+=("$(printf '%s\t%s\t%s' "$name" "$status" "$detail")")
}

# Determine the staging portal auth mode. Hardened beta staging may require
# signed ps_ sessions, in which case the legacy PORTAL_TOKEN must not be used.
# Tokens are read/minted only inside the remote shell and passed to curl via a
# 0600 header file so they never appear in local ssh or remote curl argv.
PORTAL_REQUIRE_SESSION_AUTH=$(smoke_ssh "$SERVER" bash -s -- "$STAGING_ROOT" "$STAGING_RELEASE" <<'REMOTE_PORTAL_AUTH_MODE'
set -euo pipefail
staging_root="$1"
staging_release="$2"
[ "$(readlink -f -- "$staging_root/current")" = "$staging_release" ]
grep -oP '(?<=^PORTAL_REQUIRE_SESSION_AUTH=).+' "$staging_root/.env" 2>/dev/null || true
[ "$(readlink -f -- "$staging_root/current")" = "$staging_release" ]
REMOTE_PORTAL_AUTH_MODE
)

portal_auth_curl() {
  local url="$1"
  smoke_ssh "$SERVER" bash -s -- \
    "$STAGING_ROOT" "$STAGING_RELEASE" "$PORTAL_REQUIRE_SESSION_AUTH" "$url" <<'REMOTE_PORTAL_CURL'
set -eo pipefail
STAGING_ROOT="$1"
STAGING_RELEASE="$2"
PORTAL_REQUIRE_SESSION_AUTH="$3"
URL="$4"
[ "$(readlink -f -- "$STAGING_ROOT/current")" = "$STAGING_RELEASE" ]
HEADER_FILE=$(mktemp)
cleanup() { rm -f "$HEADER_FILE"; }
trap cleanup EXIT
chmod 600 "$HEADER_FILE"
if [ "$PORTAL_REQUIRE_SESSION_AUTH" = "true" ]; then
  cd "$STAGING_RELEASE"
  set -a
  . "$STAGING_ROOT/.env"
  set +a
  export DATABASE_PATH="$STAGING_ROOT/data/bot.db"
  export DB_PATH="$STAGING_ROOT/data/bot.db"
  export NODE_PATH="$STAGING_RELEASE/node_modules"
  STAGING_SESSION=$(/usr/bin/node "$STAGING_RELEASE/dist/tools/portal-session-token.js" --actor staging-smoke@nexushub.me --scope admin --ttl-ms 600000 --json \
    | /usr/bin/node -e "let b=''; process.stdin.on('data', c => b += c); process.stdin.on('end', () => { const j = JSON.parse(b); process.stdout.write(j.token || ''); });")
  [ -n "$STAGING_SESSION" ] || exit 1
  printf 'x-portal-session: %s\n' "$STAGING_SESSION" > "$HEADER_FILE"
else
  STAGING_TOKEN=$(grep -oP '(?<=^PORTAL_TOKEN=).+' "$STAGING_ROOT/.env" 2>/dev/null || true)
  [ -n "$STAGING_TOKEN" ] || exit 1
  printf 'Authorization: Bearer %s\n' "$STAGING_TOKEN" > "$HEADER_FILE"
fi
curl -sf -H @"$HEADER_FILE" "$URL" 2>/dev/null
[ "$(readlink -f -- "$STAGING_ROOT/current")" = "$STAGING_RELEASE" ]
REMOTE_PORTAL_CURL
}

# Repeated field assertions for the same endpoint share one coherent response.
# This keeps every assertion and evidence record intact while avoiding repeated
# SSH execution and repeated staging-session minting for /api/snapshot and the
# cost dashboard.
ENDPOINT_CACHE_URLS=()
ENDPOINT_CACHE_RESULTS=()
ENDPOINT_RESULT=""

fetch_endpoint_once() {
  local url="$1"
  local index
  for index in "${!ENDPOINT_CACHE_URLS[@]}"; do
    if [ "${ENDPOINT_CACHE_URLS[$index]}" = "$url" ]; then
      ENDPOINT_RESULT="${ENDPOINT_CACHE_RESULTS[$index]}"
      return
    fi
  done

  if [[ "$url" =~ /health ]]; then
    ENDPOINT_RESULT=$(smoke_ssh "$SERVER" "curl -sf '$url' 2>/dev/null" || echo "__CURL_FAILED__")
  else
    ENDPOINT_RESULT=$(portal_auth_curl "$url" || echo "__CURL_FAILED__")
  fi
  ENDPOINT_CACHE_URLS+=("$url")
  ENDPOINT_CACHE_RESULTS+=("$ENDPOINT_RESULT")
}

# test_endpoint NAME URL EXPECTED_FIELD  → curls URL, JSON-parses, asserts
# the named field exists and is non-null. Auth header is added unless URL
# includes /health.
test_endpoint() {
  local name="$1"
  local url="$2"
  local field="$3"

  # Run on the server because staging is localhost-only
  local result
  fetch_endpoint_once "$url"
  result="$ENDPOINT_RESULT"

  if [ "$result" = "__CURL_FAILED__" ] || [ -z "$result" ]; then
    echo "  ❌ $name — curl failed (URL not responding)"
    FAIL=$((FAIL + 1))
    FAILED_TESTS+=("$name")
    evidence_record "$name" "failed" "curl_failed url=$url"
    return 1
  fi

  # JSON-parse and check the named field exists and is non-null
  local check
  check=$(echo "$result" | node -e "
    let body = '';
    process.stdin.on('data', (c) => body += c);
    process.stdin.on('end', () => {
      try {
        const j = JSON.parse(body);
        const v = j['$field'];
        if (v === undefined || v === null) {
          console.log('FIELD_MISSING');
        } else {
          console.log('OK:' + (typeof v === 'object' ? JSON.stringify(v).slice(0,40) : String(v).slice(0,40)));
        }
      } catch (e) {
        console.log('NOT_JSON:' + e.message);
      }
    });
  " 2>&1)

  if [[ "$check" =~ ^OK: ]]; then
    local val="${check#OK:}"
    echo "  ✅ $name — $field=$val"
    PASS=$((PASS + 1))
    evidence_record "$name" "passed" "$field=$val"
    return 0
  else
    echo "  ❌ $name — $check"
    FAIL=$((FAIL + 1))
    FAILED_TESTS+=("$name")
    evidence_record "$name" "failed" "$check"
    if [ "$VERBOSE" = true ]; then
      echo "     Full body: $(echo "$result" | head -c 200)"
    fi
    return 1
  fi
}

# ── Test suite ──────────────────────────────────────

echo "📡 1/6 — Health endpoints"
test_endpoint "content-engine /health"  "http://localhost:8101/health" "status" || true
test_endpoint "nexus-hub /api/snapshot" "http://localhost:8201/api/snapshot" "version" || true

echo ""
echo "🧠 2/6 — Snapshot has expected shape"
test_endpoint "snapshot.uptime"          "http://localhost:8201/api/snapshot" "uptime" || true
test_endpoint "snapshot.bot"             "http://localhost:8201/api/snapshot" "bot" || true
test_endpoint "snapshot.integrations"    "http://localhost:8201/api/snapshot" "integrations" || true
test_endpoint "snapshot.apiUsage"        "http://localhost:8201/api/snapshot" "apiUsage" || true

echo ""
echo "💸 3/6 — Per-endpoint cost dashboard"
test_endpoint "cost-by-domain.totalCost"     "http://localhost:8201/api/cost-by-domain?days=7" "totalCost" || true
test_endpoint "cost-by-domain.detailed"      "http://localhost:8201/api/cost-by-domain?days=7" "detailed" || true
test_endpoint "cost-by-domain.providerSplit" "http://localhost:8201/api/cost-by-domain?days=7" "providerSplit" || true
test_endpoint "cost-by-domain.dailySeries"   "http://localhost:8201/api/cost-by-domain?days=7" "dailySeries" || true

echo ""
echo "🔌 4/6 — Provider stats"
test_endpoint "provider-stats.providers"     "http://localhost:8201/api/provider-stats" "providers" || true

# ── iOS-surface smoke ───────────────────────────────
# Hit the canonical /api/v1/* routes the iOS app actually depends on.
# Without an auth token, each route MUST return 401 with the canonical
# envelope ({ ok: false, error: { code, message }, timestamp }). That
# tells us:
#   a) the route is mounted (not a 404)
#   b) auth middleware is active (not 200 leaking data)
#   c) error body is on-contract with the single envelope the rest of
#      /api/v1 uses, so a future drift on any route shows up here.
echo ""
echo "📱 iOS-surface contract smoke"
IOS_RESPONSE_CACHE_KEYS=()
IOS_RESPONSE_CACHE_VALUES=()
IOS_HTTP_CODE="000"
IOS_HTTP_BODY=""

fetch_ios_remote_response() {
  smoke_ssh "$SERVER" bash -s -- "$1" "$2" <<'REMOTE_IOS_CURL'
set -euo pipefail
method="$1"
url="$2"
case "$method" in GET|POST) ;; *) exit 64 ;; esac
case "$url" in http://localhost:8201/*) ;; *) exit 64 ;; esac
body_file="$(mktemp /tmp/nexus-staging-smoke.XXXXXX)"
trap 'rm -f "$body_file"' EXIT
curl_args=(-sS --connect-timeout 2 --max-time 10 -o "$body_file" -w '%{http_code}')
if [ "$method" = "POST" ]; then
  curl_args+=(-X POST -H 'Content-Type: application/json' -d '{}')
fi
if ! http_code="$(curl "${curl_args[@]}" "$url" 2>/dev/null)"; then
  http_code="000"
fi
case "$http_code" in
  [0-9][0-9][0-9]) ;;
  *) http_code="000" ;;
esac
body_size="$(wc -c < "$body_file" | tr -d ' ')"
[ "$body_size" -le 1048576 ] || exit 65
printf '%s\t' "$http_code"
base64 -w 0 "$body_file"
printf '\n'
REMOTE_IOS_CURL
}

fetch_ios_response_once() {
  local method="$1"
  local url="$2"
  local cache_key="$method $url"
  local index
  local capture=""
  for index in "${!IOS_RESPONSE_CACHE_KEYS[@]}"; do
    if [ "${IOS_RESPONSE_CACHE_KEYS[$index]}" = "$cache_key" ]; then
      capture="${IOS_RESPONSE_CACHE_VALUES[$index]}"
      break
    fi
  done
  if [ -z "$capture" ]; then
    capture="$(fetch_ios_remote_response "$method" "$url")" || capture=$'000\t'
    IOS_RESPONSE_CACHE_KEYS+=("$cache_key")
    IOS_RESPONSE_CACHE_VALUES+=("$capture")
  fi
  IOS_HTTP_CODE="${capture%%$'\t'*}"
  local body_base64="${capture#*$'\t'}"
  IOS_HTTP_BODY="$(printf '%s' "$body_base64" | node -e '
    let body = "";
    process.stdin.on("data", (chunk) => { body += chunk; });
    process.stdin.on("end", () => {
      try { process.stdout.write(Buffer.from(body.trim(), "base64")); }
      catch { process.exitCode = 1; }
    });
  ' 2>/dev/null || true)"
}

test_ios_401() {
  local name="$1"
  local url="$2"
  # No Authorization header — we EXPECT a 401
  fetch_ios_response_once GET "$url"
  local http_code="$IOS_HTTP_CODE"
  local body="$IOS_HTTP_BODY"

  if [ "$http_code" != "401" ]; then
    echo "  ❌ $name — expected 401, got $http_code"
    FAIL=$((FAIL + 1))
    FAILED_TESTS+=("$name (http $http_code)")
    evidence_record "$name" "failed" "http_code=$http_code expected=401"
    [ "$VERBOSE" = true ] && echo "     Body: $(echo "$body" | head -c 200)"
    return 1
  fi

  local shape
  shape=$(echo "$body" | node -e "
    let b='';
    process.stdin.on('data',c=>b+=c);
    process.stdin.on('end',()=>{
      try {
        const j=JSON.parse(b);
        // Canonical envelope: ok=false + error.code + error.message + timestamp
        const hasError = j.error && typeof j.error.code==='string' && typeof j.error.message==='string';
        if (j.ok === false && hasError && typeof j.timestamp === 'string') {
          console.log('OK');
        } else {
          console.log('BAD_SHAPE:'+JSON.stringify(j).slice(0,80));
        }
      } catch(e){ console.log('NOT_JSON:'+e.message); }
    });
  " 2>&1)

  if [ "$shape" = "OK" ]; then
    echo "  ✅ $name — 401 with canonical error envelope"
    PASS=$((PASS + 1))
    evidence_record "$name" "passed" "http_code=401 envelope=canonical"
  else
    echo "  ❌ $name — $shape"
    FAIL=$((FAIL + 1))
    FAILED_TESTS+=("$name (shape)")
    evidence_record "$name" "failed" "envelope=$shape"
  fi
}

test_ios_401 "iOS /api/v1/dashboard"     "http://localhost:8201/api/v1/dashboard"
test_ios_401 "iOS /api/v1/tasks/lists"   "http://localhost:8201/api/v1/tasks/lists"
test_ios_401 "iOS /api/v1/training/today" "http://localhost:8201/api/v1/training/today"
test_ios_401 "iOS /api/v1/plan/today"    "http://localhost:8201/api/v1/plan/today"

# Chat route boundary smoke — added 2026-05-26 after Codex round-10 QA
# flagged that staging-smoke did not exercise chat at all. This checks
# the route is MOUNTED and AUTH-GATED. Spending tokens on a real chat
# probe is left to the manual post-staging checks (CLAUDE.md deploy
# runbook) — staging-smoke must stay cheap and deterministic. A 405
# response is treated as acceptable for GET because the route is
# defined for POST only; the important guarantee is "not 404 and not
# 200-leaking-data".
test_ios_chat_route_mounted() {
  local url="http://localhost:8201/api/v1/chat/message"
  fetch_ios_response_once POST "$url"
  local http_code="$IOS_HTTP_CODE"
  local body="$IOS_HTTP_BODY"

  if [ "$http_code" = "401" ]; then
    local shape
    shape=$(echo "$body" | node -e "
      let b='';
      process.stdin.on('data',c=>b+=c);
      process.stdin.on('end',()=>{
        try {
          const j=JSON.parse(b);
          const hasError = j.error && typeof j.error.code==='string' && typeof j.error.message==='string';
          if (j.ok === false && hasError && typeof j.timestamp === 'string') {
            console.log('OK');
          } else {
            console.log('BAD_SHAPE:'+JSON.stringify(j).slice(0,80));
          }
        } catch(e){ console.log('NOT_JSON:'+e.message); }
      });
    " 2>&1)
    if [ "$shape" = "OK" ]; then
      echo "  ✅ iOS POST /api/v1/chat/message — 401 with canonical error envelope"
      PASS=$((PASS + 1))
      evidence_record "iOS chat-message route boundary" "passed" "http_code=401 envelope=canonical"
    else
      echo "  ❌ iOS POST /api/v1/chat/message — $shape"
      FAIL=$((FAIL + 1))
      FAILED_TESTS+=("iOS chat-message route (shape)")
      evidence_record "iOS chat-message route boundary" "failed" "envelope=$shape"
    fi
  elif [ "$http_code" = "404" ]; then
    echo "  ❌ iOS POST /api/v1/chat/message — route not mounted (404)"
    FAIL=$((FAIL + 1))
    FAILED_TESTS+=("iOS chat-message route (404 not mounted)")
    evidence_record "iOS chat-message route boundary" "failed" "http_code=404"
  else
    echo "  ❌ iOS POST /api/v1/chat/message — expected 401, got $http_code"
    FAIL=$((FAIL + 1))
    FAILED_TESTS+=("iOS chat-message route (http $http_code)")
    evidence_record "iOS chat-message route boundary" "failed" "http_code=$http_code expected=401"
    [ "$VERBOSE" = true ] && echo "     Body: $(echo "$body" | head -c 200)"
  fi
}
test_ios_chat_route_mounted

echo ""
echo "🏃 5/6 — Process state via PM2"
PM2_STATUS=$(smoke_ssh "$SERVER" "/home/dominguez/.npm-global/bin/pm2 jlist 2>/dev/null | /usr/bin/node -e \"
  let body = '';
  process.stdin.on('data', c => body += c);
  process.stdin.on('end', () => {
    try {
      const arr = JSON.parse(body);
      const ns = arr.find(p => p.name === 'nexus-hub-staging');
      const ce = arr.find(p => p.name === 'content-engine-staging');
      console.log('ns=' + (ns?.pm2_env?.status || 'absent'));
      console.log('ce=' + (ce?.pm2_env?.status || 'absent'));
      console.log('ns_restarts=' + (ns?.pm2_env?.unstable_restarts || 0));
    } catch (e) { console.log('parse_error:' + e.message); }
  });
\"" 2>&1)
pm2_ns_status="absent"
pm2_ce_status="absent"
pm2_ns_restarts="unknown"
if [[ "$PM2_STATUS" =~ ns=([^[:space:]]+) ]]; then
  pm2_ns_status="${BASH_REMATCH[1]}"
fi
if [[ "$PM2_STATUS" =~ ce=([^[:space:]]+) ]]; then
  pm2_ce_status="${BASH_REMATCH[1]}"
fi
if [[ "$PM2_STATUS" =~ ns_restarts=([0-9]+) ]]; then
  pm2_ns_restarts="${BASH_REMATCH[1]}"
fi

if [[ "$pm2_ns_status" == "online" ]]; then
  PASS=$((PASS + 1))
  evidence_record "pm2 nexus-hub online" "passed" "ns=$pm2_ns_status"
else
  FAIL=$((FAIL + 1))
  FAILED_TESTS+=("PM2 nexus-hub online")
  evidence_record "pm2 nexus-hub online" "failed" "ns=$pm2_ns_status raw=$PM2_STATUS"
fi

if [[ "$pm2_ce_status" == "online" ]]; then
  PASS=$((PASS + 1))
  evidence_record "pm2 content-engine online" "passed" "ce=$pm2_ce_status"
else
  FAIL=$((FAIL + 1))
  FAILED_TESTS+=("PM2 content-engine online")
  evidence_record "pm2 content-engine online" "failed" "ce=$pm2_ce_status raw=$PM2_STATUS"
fi

if [[ "$pm2_ns_restarts" == "0" ]]; then
  PASS=$((PASS + 1))
  evidence_record "pm2 nexus-hub restarts == 0" "passed" "ns_restarts=$pm2_ns_restarts"
else
  FAIL=$((FAIL + 1))
  FAILED_TESTS+=("PM2 nexus-hub restarts == 0")
  evidence_record "pm2 nexus-hub restarts == 0" "failed" "ns_restarts=$pm2_ns_restarts raw=$PM2_STATUS"
fi

if [[ "$pm2_ns_status" == "online" && "$pm2_ce_status" == "online" && "$pm2_ns_restarts" == "0" ]]; then
  echo "  ✅ PM2 — both staging processes online"
else
  echo "  ❌ PM2 — $PM2_STATUS"
fi

echo ""
echo "🏋️  Training plan preview E2E (isolated fixture seed, preview API only)"
TRAINING_E2E_ENABLED="${NEXUS_SMOKE_TRAINING_E2E:-1}"
if [ "$TRAINING_E2E_ENABLED" = "0" ]; then
  echo "  ❌ Training plan preview E2E disabled by NEXUS_SMOKE_TRAINING_E2E=0"
  FAIL=$((FAIL + 1))
  FAILED_TESTS+=("training plan preview e2e disabled")
  evidence_record "training plan preview e2e" "failed" "disabled_by_kill_switch"
else
  TRAINING_SMOKE_RESULT=""
  TRAINING_SMOKE_RC=0
  TRAINING_SMOKE_RESULT=$(smoke_ssh "$SERVER" bash -s -- \
    "$STAGING_ROOT" "$STAGING_RELEASE" 2>&1 <<'REMOTE_TRAINING_E2E'
set -eo pipefail
staging_root="$1"
staging_release="$2"
[ "$(readlink -f -- "$staging_root/current")" = "$staging_release" ]
cd "$staging_release"
set -a
. "$staging_root/.env"
set +a
export DATABASE_PATH="$staging_root/data/bot.db"
export DB_PATH="$staging_root/data/bot.db"
export NODE_PATH="$staging_release/node_modules"
/usr/bin/node <<'NODE'
const Database = require('better-sqlite3');
const { signIosJwt } = require('./dist/services/ios-jwt');

const userId = Number(process.env.NEXUS_SMOKE_TRAINING_E2E_USER_ID || '1000014');
if (userId !== 1000014) {
  throw new Error('NEXUS_SMOKE_TRAINING_E2E_USER_ID must remain the governed staging fixture user 1000014');
}

const deviceId = process.env.NEXUS_SMOKE_TRAINING_E2E_DEVICE_ID || 'training-preview-smoke-device-' + userId;
const fixturePrincipal = Object.freeze({
  id: userId,
  telegramId: 910000000 + userId,
  email: 'training-preview-smoke-' + userId + '@nexushub.test',
  username: 'training_preview_smoke_' + userId,
  authProvider: 'email',
});
const db = new Database(process.env.DATABASE_PATH || process.env.DB_PATH || './data/bot.db');
const now = new Date().toISOString();

function tableExists(name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(name));
}

function columnsFor(name) {
  if (!tableExists(name)) return new Set();
  return new Set(db.prepare('PRAGMA table_info(' + name + ')').all().map((row) => row.name));
}

function insert(table, values, mode = 'INSERT OR REPLACE') {
  const columns = columnsFor(table);
  if (columns.size === 0) return;
  const entries = Object.entries(values).filter(([column]) => columns.has(column));
  if (entries.length === 0) return;
  const names = entries.map(([column]) => column);
  const placeholders = names.map(() => '?').join(', ');
  db.prepare(mode + ' INTO ' + table + ' (' + names.join(', ') + ') VALUES (' + placeholders + ')')
    .run(...entries.map(([, value]) => value));
}

// GOVERNED_FIXTURE_USER_SEED_START
function seedGovernedFixtureUser(values) {
  const requiredIdentityColumns = ['id', 'telegram_id', 'email', 'username', 'auth_provider'];
  const userColumns = columnsFor('users');
  if (requiredIdentityColumns.some((column) => !userColumns.has(column))) {
    throw new Error('governed staging fixture principal columns are unavailable');
  }
  if (values.id !== fixturePrincipal.id
      || values.telegram_id !== fixturePrincipal.telegramId
      || values.email !== fixturePrincipal.email
      || values.username !== fixturePrincipal.username
      || values.auth_provider !== fixturePrincipal.authProvider) {
    throw new Error('governed staging fixture principal seed marker is invalid');
  }
  const matches = db.prepare(`
    SELECT id, telegram_id, email, username, auth_provider
    FROM users
    WHERE id = ? OR telegram_id = ? OR email = ? OR username = ?
  `).all(
    fixturePrincipal.id,
    fixturePrincipal.telegramId,
    fixturePrincipal.email,
    fixturePrincipal.username,
  );
  const exact = matches.length === 1
    && matches[0].id === fixturePrincipal.id
    && matches[0].telegram_id === fixturePrincipal.telegramId
    && matches[0].email === fixturePrincipal.email
    && matches[0].username === fixturePrincipal.username
    && matches[0].auth_provider === fixturePrincipal.authProvider;
  if (matches.length > 0 && !exact) {
    throw new Error('governed staging fixture principal collision');
  }
  const entries = Object.entries(values).filter(([column]) => userColumns.has(column));
  if (matches.length === 0) {
    const names = entries.map(([column]) => column);
    const placeholders = names.map(() => '?').join(', ');
    const result = db.prepare(
      'INSERT INTO users (' + names.join(', ') + ') VALUES (' + placeholders + ')',
    ).run(...entries.map(([, value]) => value));
    if (result.changes !== 1) {
      throw new Error('fixture principal changed during safe seed');
    }
    return;
  }
  const updates = entries.filter(([column]) => column !== 'id' && column !== 'created_at');
  const assignments = updates.map(([column]) => column + ' = ?').join(', ');
  const result = db.prepare(`
    UPDATE users SET ${assignments}
    WHERE id = ? AND telegram_id = ? AND email = ? AND username = ? AND auth_provider = ?
  `).run(
    ...updates.map(([, value]) => value),
    fixturePrincipal.id,
    fixturePrincipal.telegramId,
    fixturePrincipal.email,
    fixturePrincipal.username,
    fixturePrincipal.authProvider,
  );
  if (result.changes !== 1) {
    throw new Error('fixture principal changed during safe seed');
  }
}
// GOVERNED_FIXTURE_USER_SEED_END

db.transaction(() => {
  seedGovernedFixtureUser({
    id: fixturePrincipal.id,
    telegram_id: fixturePrincipal.telegramId,
    email: fixturePrincipal.email,
    email_verified: 1,
    username: fixturePrincipal.username,
    first_name: 'Training',
    last_name: 'Smoke',
    language: 'en-US',
    timezone: 'Europe/Lisbon',
    tier: 'max',
    status: 'active',
    auth_provider: fixturePrincipal.authProvider,
    daily_message_limit: 500,
    daily_token_limit: 1000000,
    daily_cost_limit_usd: 25,
    created_at: now,
    last_active_at: now,
  });
  insert('ios_devices', {
    user_id: userId,
    device_id: deviceId,
    device_name: 'Training Preview Smoke',
    refresh_token: 'training-preview-smoke-refresh-' + userId,
    refresh_token_hash: 'training-preview-smoke-refresh-hash-' + userId,
    last_active_at: now,
    created_at: now,
  }, 'INSERT OR IGNORE');
  insert('subscriptions', {
    user_id: userId,
    plan: 'max',
    period: 'monthly',
    status: 'active',
    provider: 'founder',
    provider_subscription_id: 'training-preview-smoke-subscription-' + userId,
    current_period_start: now,
    current_period_end: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    created_at: now,
    updated_at: now,
  });

  const profiles = [
    ['fitness', {
      experience_level: 'Advanced (3+ years)',
      weekly_frequency: '6+ days',
      training_goals: ['Endurance', 'Strength'],
      injuries: 'none',
      available_equipment: 'Full gym',
    }],
    ['triathlon-gym', {
      training_age: '5+ years',
      current_split: 'Upper/Lower',
      primary_goal: 'Support running',
      squat_1rm_kg: 140,
      bench_1rm_kg: 100,
      deadlift_1rm_kg: 180,
      sessions_per_week: '5+',
      equipment_access: 'Full commercial gym',
    }],
    ['triathlon-running', {
      weekly_mileage_km: 55,
      longest_recent_run_km: 24,
      easy_pace_min_per_km: '5:20',
      target_race: 'Marathon',
      target_race_date: '2026-10-18',
      preferred_workouts: ['Easy runs', 'Tempo', 'Long runs'],
      injury_history: 'none',
      weekly_availability_days: '6+',
    }],
  ];
  for (const [profileType, data] of profiles) {
    insert('user_profiles', {
      user_id: userId,
      profile_type: profileType,
      data: JSON.stringify(data),
      updated_at: now,
    });
  }

  insert('user_oauth_tokens', {
    user_id: userId,
    provider: 'outlook',
    access_token: 'training-preview-smoke-access-token',
    refresh_token: 'training-preview-smoke-refresh-token',
    token_type: 'Bearer',
    scopes: JSON.stringify([]),
    updated_at: now,
  });
}).immediate();

async function main() {
  const token = signIosJwt({
    userId,
    deviceId,
    staging_fixture: true,
    fixture: 'training-plan-preview-smoke',
  }, { expiresIn: '15m' });

  const payload = {
    objective: 'Lisbon Marathon October 2026',
    durationWeeks: 2,
    preferredTime: '07:00',
    preferredCardioTime: '07:00',
    preferredStrengthTime: '18:00',
    sessionsPerWeek: 5,
    runSessionsPerWeek: 5,
    strengthSessionsPerWeek: 5,
    startPolicy: 'today',
    longWorkoutDay: 'Saturday',
    goalMode: 'event_based',
    trainingPriority: 'running',
    raceDate: '2026-10-18',
    twoADayPreference: 'preferred',
    calendarSource: 'outlook',
  };

  const response = await fetch('http://localhost:8201/api/v1/training/plan/preview', {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + token,
      accept: 'application/json',
      'content-type': 'application/json',
      'x-language': 'en-US',
    },
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {}

  const blockerIds = (json?.data?.planLint?.blockers || []).map((blocker) => String(blocker.ruleId || blocker.code || ''));
  const warningCodes = (json?.data?.warnings || []).map((warning) => String(warning.code || warning.ruleId || ''));
  const ok = response.status === 200
    && json?.ok === true
    && json?.data?.status === 'preview'
    && blockerIds.length === 0
    && Array.isArray(json?.data?.phaseRoadmap)
    && json.data.phaseRoadmap.length > 0
    && json?.data?.weeklyTargets?.runSessionsPerWeek === 5
    && json?.data?.weeklyTargets?.strengthSessionsPerWeek === 5;

  const summary = {
    ok,
    httpStatus: response.status,
    responseOk: json?.ok ?? null,
    planStatus: json?.data?.status ?? null,
    userId,
    blockerIds,
    warningCodes,
    totalSessions: json?.data?.totalSessions ?? null,
    calendarFetchDegraded: json?.data?.calendarFetchDegraded ?? null,
    bodyPreview: ok ? undefined : text.slice(0, 500),
  };
  process.stdout.write(JSON.stringify(summary));
  if (!ok) process.exit(1);
}

main().catch((err) => {
  process.stdout.write(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
  process.exit(1);
});
NODE
[ "$(readlink -f -- "$staging_root/current")" = "$staging_release" ] || {
  echo "staging current selector changed during training smoke" >&2
  exit 1
}
REMOTE_TRAINING_E2E
  ) || TRAINING_SMOKE_RC=$?

  TRAINING_SMOKE_DETAIL=""
  if [ "$TRAINING_SMOKE_RC" -eq 0 ]; then
    if [ "${#TRAINING_SMOKE_RESULT}" -gt 16384 ]; then
      TRAINING_SMOKE_RC=1
      TRAINING_SMOKE_DETAIL="successful training smoke exceeded 16384-byte evidence limit"
    else
      TRAINING_SMOKE_DETAIL="$(printf '%s' "$TRAINING_SMOKE_RESULT" | node -e '
        let body = "";
        process.stdin.on("data", (chunk) => { body += chunk; });
        process.stdin.on("end", () => {
          try {
            process.stdout.write(JSON.stringify(JSON.parse(body)));
          } catch {
            process.exit(1);
          }
        });
      ')" || {
        TRAINING_SMOKE_RC=1
        TRAINING_SMOKE_DETAIL="successful training smoke did not emit one strict JSON document"
      }
    fi
  else
    TRAINING_SMOKE_DETAIL="$(printf '%s' "$TRAINING_SMOKE_RESULT" | tail -c 700 | tr '\n' ' ')"
  fi
  if [ "$TRAINING_SMOKE_RC" -eq 0 ]; then
    echo "  ✅ Training plan preview E2E — isolated fixture seeded; blocker-free preview"
    PASS=$((PASS + 1))
    evidence_record "training plan preview e2e" "passed" "$TRAINING_SMOKE_DETAIL"
  else
    echo "  ❌ Training plan preview E2E — failed"
    FAIL=$((FAIL + 1))
    FAILED_TESTS+=("training plan preview e2e")
    evidence_record "training plan preview e2e" "failed" "$TRAINING_SMOKE_DETAIL"
    [ "$VERBOSE" = true ] && echo "     Detail: $TRAINING_SMOKE_RESULT"
  fi
fi

echo ""
echo "🌐 Locale-fidelity chat smoke (token-zero EN + PT + legacy ES→EN fallback)"
# Supported-locale gate: send en-US and pt-BR turns plus one legacy es-419
# compatibility turn through the authenticated-identity fast path on the real
# staging chat endpoint. The legacy turn must follow the English fallback
# contract; Spanish is not a supported reply locale. Exact route metadata and
# a zero api_usage delta provide one local guard against provider use. The
# governed Phase 7 observation transaction separately proves zero provider
# attempt reservations across the entire canonical smoke. Assert reply
# language with the deterministic detector shipped in
# dist/services/chat-language-detector.js. The check fails closed on 'unknown'
# detections, but the fixed identity replies contain enough discriminative
# language for EN/PT. Uses an isolated staging fixture user like the training
# preview E2E.
# The persisted es-ES value intentionally exercises compatibility coercion;
# it is never rewritten or treated as a selectable locale. The signed gate treats
# NEXUS_SMOKE_LOCALE_FIDELITY=0 as a failure rather than accepting missing
# locale evidence.
LOCALE_FIDELITY_ENABLED="${NEXUS_SMOKE_LOCALE_FIDELITY:-1}"
if [ "$LOCALE_FIDELITY_ENABLED" = "0" ]; then
  echo "  ❌ Locale-fidelity chat smoke disabled by NEXUS_SMOKE_LOCALE_FIDELITY=0"
  FAIL=$((FAIL + 1))
  FAILED_TESTS+=("locale fidelity chat smoke disabled")
  evidence_record "locale fidelity chat smoke" "failed" "disabled_by_kill_switch"
else
  LOCALE_SMOKE_RESULT=""
  LOCALE_SMOKE_RC=0
  LOCALE_SMOKE_RESULT=$(smoke_ssh "$SERVER" bash -s -- \
    "$STAGING_ROOT" "$STAGING_RELEASE" 2>&1 <<'REMOTE_LOCALE_E2E'
set -eo pipefail
staging_root="$1"
staging_release="$2"
[ "$(readlink -f -- "$staging_root/current")" = "$staging_release" ]
cd "$staging_release"
set -a
. "$staging_root/.env"
set +a
export DATABASE_PATH="$staging_root/data/bot.db"
export DB_PATH="$staging_root/data/bot.db"
export NODE_PATH="$staging_release/node_modules"
/usr/bin/node <<'NODE'
const Database = require('better-sqlite3');
const { signIosJwt } = require('./dist/services/ios-jwt');
const { checkResponseLocaleFidelity } = require('./dist/services/chat-language-detector');

const userId = Number(process.env.NEXUS_SMOKE_LOCALE_FIDELITY_USER_ID || '1000016');
if (userId !== 1000016) {
  throw new Error('NEXUS_SMOKE_LOCALE_FIDELITY_USER_ID must remain the governed staging fixture user 1000016');
}

const deviceId = process.env.NEXUS_SMOKE_LOCALE_FIDELITY_DEVICE_ID || 'locale-fidelity-smoke-device-' + userId;
const fixturePrincipal = Object.freeze({
  id: userId,
  telegramId: 910000000 + userId,
  email: 'locale-fidelity-smoke-' + userId + '@nexushub.test',
  username: 'locale_fidelity_smoke_' + userId,
  authProvider: 'email',
});
const db = new Database(process.env.DATABASE_PATH || process.env.DB_PATH || './data/bot.db');
const now = new Date().toISOString();

function columnsFor(name) {
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(name);
  if (!exists) return new Set();
  return new Set(db.prepare('PRAGMA table_info(' + name + ')').all().map((row) => row.name));
}

function insert(table, values, mode = 'INSERT OR REPLACE') {
  const columns = columnsFor(table);
  if (columns.size === 0) return;
  const entries = Object.entries(values).filter(([column]) => columns.has(column));
  if (entries.length === 0) return;
  const names = entries.map(([column]) => column);
  const placeholders = names.map(() => '?').join(', ');
  db.prepare(mode + ' INTO ' + table + ' (' + names.join(', ') + ') VALUES (' + placeholders + ')')
    .run(...entries.map(([, value]) => value));
}

// GOVERNED_FIXTURE_USER_SEED_START
function seedGovernedFixtureUser(values) {
  const requiredIdentityColumns = ['id', 'telegram_id', 'email', 'username', 'auth_provider'];
  const userColumns = columnsFor('users');
  if (requiredIdentityColumns.some((column) => !userColumns.has(column))) {
    throw new Error('governed staging fixture principal columns are unavailable');
  }
  if (values.id !== fixturePrincipal.id
      || values.telegram_id !== fixturePrincipal.telegramId
      || values.email !== fixturePrincipal.email
      || values.username !== fixturePrincipal.username
      || values.auth_provider !== fixturePrincipal.authProvider) {
    throw new Error('governed staging fixture principal seed marker is invalid');
  }
  const matches = db.prepare(`
    SELECT id, telegram_id, email, username, auth_provider
    FROM users
    WHERE id = ? OR telegram_id = ? OR email = ? OR username = ?
  `).all(
    fixturePrincipal.id,
    fixturePrincipal.telegramId,
    fixturePrincipal.email,
    fixturePrincipal.username,
  );
  const exact = matches.length === 1
    && matches[0].id === fixturePrincipal.id
    && matches[0].telegram_id === fixturePrincipal.telegramId
    && matches[0].email === fixturePrincipal.email
    && matches[0].username === fixturePrincipal.username
    && matches[0].auth_provider === fixturePrincipal.authProvider;
  if (matches.length > 0 && !exact) {
    throw new Error('governed staging fixture principal collision');
  }
  const entries = Object.entries(values).filter(([column]) => userColumns.has(column));
  if (matches.length === 0) {
    const names = entries.map(([column]) => column);
    const placeholders = names.map(() => '?').join(', ');
    const result = db.prepare(
      'INSERT INTO users (' + names.join(', ') + ') VALUES (' + placeholders + ')',
    ).run(...entries.map(([, value]) => value));
    if (result.changes !== 1) {
      throw new Error('fixture principal changed during safe seed');
    }
    return;
  }
  const updates = entries.filter(([column]) => column !== 'id' && column !== 'created_at');
  const assignments = updates.map(([column]) => column + ' = ?').join(', ');
  const result = db.prepare(`
    UPDATE users SET ${assignments}
    WHERE id = ? AND telegram_id = ? AND email = ? AND username = ? AND auth_provider = ?
  `).run(
    ...updates.map(([, value]) => value),
    fixturePrincipal.id,
    fixturePrincipal.telegramId,
    fixturePrincipal.email,
    fixturePrincipal.username,
    fixturePrincipal.authProvider,
  );
  if (result.changes !== 1) {
    throw new Error('fixture principal changed during safe seed');
  }
}
// GOVERNED_FIXTURE_USER_SEED_END

db.transaction(() => {
  seedGovernedFixtureUser({
    id: fixturePrincipal.id,
    telegram_id: fixturePrincipal.telegramId,
    email: fixturePrincipal.email,
    email_verified: 1,
    username: fixturePrincipal.username,
    first_name: 'Locale',
    last_name: 'Smoke',
    language: 'es-ES',
    timezone: 'Europe/Lisbon',
    tier: 'max',
    status: 'active',
    auth_provider: fixturePrincipal.authProvider,
    daily_message_limit: 500,
    daily_token_limit: 1000000,
    daily_cost_limit_usd: 25,
    created_at: now,
    last_active_at: now,
  });
  insert('ios_devices', {
    user_id: userId,
    device_id: deviceId,
    device_name: 'Locale Fidelity Smoke',
    refresh_token: 'locale-fidelity-smoke-refresh-' + userId,
    refresh_token_hash: 'locale-fidelity-smoke-refresh-hash-' + userId,
    last_active_at: now,
    created_at: now,
  }, 'INSERT OR IGNORE');
  insert('subscriptions', {
    user_id: userId,
    plan: 'max',
    period: 'monthly',
    status: 'active',
    provider: 'founder',
    provider_subscription_id: 'locale-fidelity-smoke-subscription-' + userId,
    current_period_start: now,
    current_period_end: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    created_at: now,
    updated_at: now,
  });
}).immediate();

const TURNS = [
  { locale: 'es-419', expectedLocale: 'en-US', text: '¿Quién soy?' },
  { locale: 'en-US', expectedLocale: 'en-US', text: 'Who am I signed in as?' },
  { locale: 'pt-BR', text: 'Quem sou eu?' },
];

async function runTurn(turn) {
  const token = signIosJwt({
    userId,
    deviceId,
    staging_fixture: true,
    fixture: 'locale-fidelity-smoke',
  }, { expiresIn: '15m' });
  const response = await fetch('http://localhost:8201/api/v1/chat/message', {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + token,
      accept: 'application/json',
      'content-type': 'application/json',
      'x-language': turn.locale,
      'x-idempotency-key': 'locale-fidelity-smoke-' + turn.locale + '-' + Date.now(),
    },
    body: JSON.stringify({ text: turn.text }),
  });
  const raw = await response.text();
  let json = null;
  try { json = raw ? JSON.parse(raw) : null; } catch {}
  const storedLanguage = db.prepare('SELECT language FROM users WHERE id = ?')
    .get(userId)?.language ?? null;
  if (turn.locale === 'es-419' && storedLanguage !== 'es-ES') {
    throw new Error('legacy Spanish preference was rewritten during compatibility smoke');
  }
  const expectedLocale = turn.expectedLocale || turn.locale;
  const envelope = json?.data && typeof json.data === 'object' ? json.data : json;
  const replyText = typeof envelope?.text === 'string' ? envelope.text : '';
  const routeMethod = typeof envelope?.routeMethod === 'string' ? envelope.routeMethod : null;
  const metadata = envelope?.metadata && typeof envelope.metadata === 'object'
    ? envelope.metadata : null;
  const localeFidelity = checkResponseLocaleFidelity(expectedLocale, replyText);
  const ok = response.status === 200
    && routeMethod === 'authenticated-identity'
    && metadata?.type === 'authenticated_identity'
    && metadata?.userId === userId
    && metadata?.hasDisplayName === true
    && replyText.trim().length > 0
    && localeFidelity.ok;
  return {
    requestedLocale: turn.locale,
    expectedLocale,
    storedLanguage,
    httpStatus: response.status,
    ok,
    routeMethod,
    responseType: metadata?.type ?? null,
    authenticatedUserId: metadata?.userId ?? null,
    hasDisplayName: metadata?.hasDisplayName ?? null,
    expected: localeFidelity.expected,
    detected: localeFidelity.detected,
    confidence: Number(localeFidelity.confidence.toFixed(3)),
    replyPreview: replyText.slice(0, 120),
  };
}

async function main() {
  const providerUsageBefore = Number(db.prepare(
    'SELECT COUNT(*) AS count FROM api_usage WHERE user_id = ?',
  ).get(userId)?.count ?? 0);
  const turns = [];
  for (const turn of TURNS) turns.push(await runTurn(turn));
  const providerUsageAfter = Number(db.prepare(
    'SELECT COUNT(*) AS count FROM api_usage WHERE user_id = ?',
  ).get(userId)?.count ?? 0);
  const ok = turns.every((result) => result.ok)
    && providerUsageAfter === providerUsageBefore;
  process.stdout.write(JSON.stringify({
    ok,
    userId,
    providerUsageBefore,
    providerUsageAfter,
    providerUsageDelta: providerUsageAfter - providerUsageBefore,
    turns,
  }));
  if (!ok) process.exit(1);
}

main().catch((err) => {
  process.stdout.write(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
  process.exit(1);
});
NODE
[ "$(readlink -f -- "$staging_root/current")" = "$staging_release" ] || {
  echo "staging current selector changed during locale smoke" >&2
  exit 1
}
REMOTE_LOCALE_E2E
  ) || LOCALE_SMOKE_RC=$?

  LOCALE_SMOKE_DETAIL=""
  if [ "$LOCALE_SMOKE_RC" -eq 0 ]; then
    if [ "${#LOCALE_SMOKE_RESULT}" -gt 16384 ]; then
      LOCALE_SMOKE_RC=1
      LOCALE_SMOKE_DETAIL="successful locale smoke exceeded 16384-byte evidence limit"
    else
      LOCALE_SMOKE_DETAIL="$(printf '%s' "$LOCALE_SMOKE_RESULT" | node -e '
        let body = "";
        process.stdin.on("data", (chunk) => { body += chunk; });
        process.stdin.on("end", () => {
          try {
            process.stdout.write(JSON.stringify(JSON.parse(body)));
          } catch {
            process.exit(1);
          }
        });
      ')" || {
        LOCALE_SMOKE_RC=1
        LOCALE_SMOKE_DETAIL="successful locale smoke did not emit one strict JSON document"
      }
    fi
  else
    LOCALE_SMOKE_DETAIL="$(printf '%s' "$LOCALE_SMOKE_RESULT" | tail -c 700 | tr '\n' ' ')"
  fi
  if [ "$LOCALE_SMOKE_RC" -eq 0 ]; then
    echo "  ✅ Locale-fidelity chat smoke — token-zero EN/PT; legacy es-419 falls back to EN"
    PASS=$((PASS + 1))
    evidence_record "locale fidelity chat smoke" "passed" "$LOCALE_SMOKE_DETAIL"
  else
    echo "  ❌ Locale-fidelity chat smoke — reply language mismatch or request failed"
    FAIL=$((FAIL + 1))
    FAILED_TESTS+=("locale fidelity chat smoke")
    evidence_record "locale fidelity chat smoke" "failed" "$LOCALE_SMOKE_DETAIL"
    [ "$VERBOSE" = true ] && echo "     Detail: $LOCALE_SMOKE_RESULT"
  fi
fi

echo ""
echo "🗃  6/6 — DB integrity"
DB_CHECK_RC=0
DB_CHECK=$(smoke_ssh "$SERVER" bash -s -- "$STAGING_ROOT" "$STAGING_RELEASE" 2>&1 <<'REMOTE_DB_CHECK'
set -euo pipefail
staging_root="$1"
staging_release="$2"
[ "$(readlink -f -- "$staging_root/current")" = "$staging_release" ]
cd "$staging_release"
NODE_PATH="$staging_release/node_modules" /usr/bin/node - "$staging_root/data/bot.db" <<'NODE'
const Database = require('better-sqlite3');
const db = new Database(process.argv[2], { readonly: true, fileMustExist: true });
const result = db.pragma('integrity_check');
const foreignKeys = db.pragma('foreign_key_check');
db.close();
console.log(JSON.stringify({ integrity: result, foreignKeys }));
NODE
[ "$(readlink -f -- "$staging_root/current")" = "$staging_release" ] || {
  echo "staging current selector changed during database smoke" >&2
  exit 1
}
REMOTE_DB_CHECK
) || DB_CHECK_RC=$?
if [ "$DB_CHECK_RC" -ne 0 ]; then
  DB_CHECK="FAILED (staging DB integrity transport status $DB_CHECK_RC)"
fi
if printf '%s' "$DB_CHECK" | grep -Fq '"integrity_check":"ok"' \
    && printf '%s' "$DB_CHECK" | grep -Fq '"foreignKeys":[]'; then
  echo "  ✅ Staging DB integrity_check: ok"
  PASS=$((PASS + 1))
  evidence_record "Staging DB integrity" "passed" "integrity_check=ok"
else
  echo "  ❌ Staging DB integrity_check failed: $DB_CHECK"
  FAIL=$((FAIL + 1))
  FAILED_TESTS+=("DB integrity")
  evidence_record "Staging DB integrity" "failed" "$DB_CHECK"
fi

# ── Classifier-driven domain appendation (release-pipeline-risk-based-
# optimization, 2026-05-03):
# Past this point, the 17 generic checks have all run. We additionally
# probe for domain-specific risk based on what the changed-area classifier says
# about the signed RC selection base versus the exact staging SHA. Standalone
# smoke runs retain origin/main as a diagnostic fallback.
# This turns staging-smoke from "always 17 checks" into "17 generic +
# (classifier-driven) domain checks" without changing the generic
# pass/fail contract above.
#
# Classifier flags drive these probes:
#   training/coach-kernel  → /api/v1/training/today response shape (auth-401 only)
#   calendar               → /api/v1/training/calendar response shape (auth-401 only)
#   cooking                → /api/v1/cooking/recipes response shape (auth-401 only)
#   content                → /api/v1/content/ideas response shape (auth-401 only)
#   secretary              → /api/v1/plan/today response shape (auth-401 only)
#   migration              → migration count assertion (count > 0 in DB schema)
#
# All probes are auth-401 contract checks — they verify the route is
# mounted, returns the canonical error envelope, and isn't shadowing a
# 200 leak. They do NOT require auth tokens, do NOT mutate state, and
# are safe on every staging install.
#
# Disable with NEXUS_SMOKE_DOMAIN_PROBES=0.
DOMAIN_PROBES_ENABLED="${NEXUS_SMOKE_DOMAIN_PROBES:-1}"
if [ -n "${NEXUS_SMOKE_CLASSIFIER_BASE_SHA:-}" ]; then
  [ "$DOMAIN_PROBES_ENABLED" = "1" ] || {
    echo "  ❌ protected release domain probes cannot be disabled"
    exit 1
  }
  [ -x "$LOCAL_DIR/scripts/changed-area-classifier.sh" ] || {
    echo "  ❌ protected release changed-area classifier is missing or not executable"
    exit 1
  }
fi
if [ "$DOMAIN_PROBES_ENABLED" = "1" ] && [ -x "$LOCAL_DIR/scripts/changed-area-classifier.sh" ]; then
  echo ""
  echo "🎯 Bonus — classifier-driven domain probes"

  CLASSIFIER_BASE_SHA="${NEXUS_SMOKE_CLASSIFIER_BASE_SHA:-origin/main}"
  if [ -n "${NEXUS_SMOKE_CLASSIFIER_BASE_SHA:-}" ]; then
    [[ "$CLASSIFIER_BASE_SHA" =~ ^[0-9a-f]{40}$ ]] \
      && git -C "$LOCAL_DIR" merge-base --is-ancestor "$CLASSIFIER_BASE_SHA" HEAD || {
      echo "  ❌ protected release classifier base is invalid or not an ancestor"
      exit 1
    }
  fi
  CLASSIFIER_STATUS=0
  CLASSIFIER_JSON="$("$LOCAL_DIR/scripts/changed-area-classifier.sh" \
    --base "$CLASSIFIER_BASE_SHA" --format json 2>/dev/null)" || CLASSIFIER_STATUS=$?
  if [ -n "${NEXUS_SMOKE_CLASSIFIER_BASE_SHA:-}" ]; then
    CLASSIFIER_HEAD="$(git -C "$LOCAL_DIR" rev-parse HEAD)"
    SMOKE_CLASSIFIER_HEAD_SHA="$CLASSIFIER_HEAD"
    if [ "$CLASSIFIER_STATUS" -ne 0 ] || [ -z "$CLASSIFIER_JSON" ] \
      || ! printf '%s' "$CLASSIFIER_JSON" | node -e '
        let body = "";
        process.stdin.on("data", (chunk) => { body += chunk; });
        process.stdin.on("end", () => {
          try {
            const value = JSON.parse(body);
            const valid = value?.baseRef === process.argv[1]
              && value?.head === process.argv[2]
              && value?.flags && typeof value.flags === "object"
              && !Array.isArray(value.flags)
              && Array.isArray(value?.stagingSmoke?.domains);
            process.exit(valid ? 0 : 1);
          } catch {
            process.exit(1);
          }
        });
      ' "$CLASSIFIER_BASE_SHA" "$CLASSIFIER_HEAD"; then
      echo "  ❌ protected release changed-area classification failed or drifted"
      exit 1
    fi
  fi
  if [ -n "$CLASSIFIER_JSON" ]; then
    FLAGS_STATUS=0
    FLAGS_TSV="$(printf '%s' "$CLASSIFIER_JSON" | NODE_NO_WARNINGS=1 node -e '
      let body = "";
      process.stdin.on("data", (chunk) => { body += chunk; });
      process.stdin.on("end", () => {
        const value = JSON.parse(body);
        const names = [
          "training", "coachKernel", "calendar", "cooking",
          "content", "secretary", "migration",
        ];
        process.stdout.write(names.map((name) => String(value.flags?.[name] === true)).join("\t"));
      });
    ' 2>/dev/null)" || FLAGS_STATUS=$?
    if [ "$FLAGS_STATUS" -ne 0 ]; then
      if [ -n "${NEXUS_SMOKE_CLASSIFIER_BASE_SHA:-}" ]; then
        echo "  ❌ protected release classifier flags could not be parsed"
        exit 1
      fi
      echo "  ⚠️ classifier flags could not be parsed — skipping standalone domain probes"
      FLAGS_TSV="false	false	false	false	false	false	false"
    fi
    IFS=$'\t' read -r TRAINING_FLAG COACH_FLAG CALENDAR_FLAG COOKING_FLAG \
      CONTENT_FLAG SECRETARY_FLAG MIGRATION_FLAG <<<"$FLAGS_TSV"

    if [ "$TRAINING_FLAG" = "true" ]; then
      test_ios_401 "domain training /api/v1/training/today" "http://localhost:8201/api/v1/training/today"
    fi
    if [ "$COACH_FLAG" = "true" ]; then
      test_ios_401 "domain coach /api/v1/training/coach/briefing" "http://localhost:8201/api/v1/training/coach/briefing"
    fi
    if [ "$CALENDAR_FLAG" = "true" ]; then
      test_ios_401 "domain calendar /api/v1/training/calendar" "http://localhost:8201/api/v1/training/calendar"
    fi
    if [ "$COOKING_FLAG" = "true" ]; then
      test_ios_401 "domain cooking /api/v1/cooking/recipes" "http://localhost:8201/api/v1/cooking/recipes"
    fi
    if [ "$CONTENT_FLAG" = "true" ]; then
      test_ios_401 "domain content /api/v1/content/ideas" "http://localhost:8201/api/v1/content/ideas"
    fi
    if [ "$SECRETARY_FLAG" = "true" ]; then
      test_ios_401 "domain secretary /api/v1/plan/today" "http://localhost:8201/api/v1/plan/today"
    fi
    if [ "$MIGRATION_FLAG" = "true" ]; then
      MIG_COUNT=$(smoke_ssh "$SERVER" bash -s -- "$STAGING_ROOT" "$STAGING_RELEASE" 2>&1 <<'REMOTE_MIGRATION_COUNT'
set -euo pipefail
staging_root="$1"
staging_release="$2"
[ "$(readlink -f -- "$staging_root/current")" = "$staging_release" ]
cd "$staging_release"
NODE_PATH="$staging_release/node_modules" /usr/bin/node - "$staging_root/data/bot.db" <<'NODE'
const Database = require('better-sqlite3');
const db = new Database(process.argv[2], { readonly: true, fileMustExist: true });
const result = db.prepare('SELECT COUNT(*) AS c FROM _migrations').get();
db.close();
console.log(result.c);
NODE
[ "$(readlink -f -- "$staging_root/current")" = "$staging_release" ] || {
  echo "staging current selector changed during migration smoke" >&2
  exit 1
}
REMOTE_MIGRATION_COUNT
) || MIG_COUNT="ERR"
      if [[ "$MIG_COUNT" =~ ^[0-9]+$ ]] && [ "$MIG_COUNT" -gt 0 ]; then
        echo "  ✅ migrations applied — count=$MIG_COUNT"
        PASS=$((PASS + 1))
        evidence_record "domain migration count" "passed" "applied=$MIG_COUNT"
      else
        echo "  ❌ migrations applied count missing: $MIG_COUNT"
        FAIL=$((FAIL + 1))
        FAILED_TESTS+=("migration count")
        evidence_record "domain migration count" "failed" "$MIG_COUNT"
      fi
    fi

    # If no domain flags were active, say so explicitly.
    if [ "$FLAGS_TSV" = $'false\tfalse\tfalse\tfalse\tfalse\tfalse\tfalse' ]; then
      echo "  ℹ️ No domain probes triggered by current diff (docs-only / scripts-only)"
    fi
  else
    echo "  ⚠️ classifier returned empty output — skipping standalone domain probes"
  fi
fi

# Cloudflare edge contract. This is opt-in until the dashboard WAF rule exists:
# it must allow AI/monitor user-agents to /public-status, while keeping the
# same user-agents blocked everywhere else.
EDGE_VERIFY_ENABLED="${NEXUS_SMOKE_EDGE_VERIFY:-0}"
# Default to the production API hostname because that is the public surface
# external AI fetchers hit today. If/when api-staging.nexushub.me has a live
# DNS route and matching WAF exception, override with NEXUS_SMOKE_EDGE_HOST.
EDGE_HOST="${NEXUS_SMOKE_EDGE_HOST:-https://api.nexushub.me}"

test_edge_status_ok() {
  local name="$1"
  local url="$2"
  local ua="$3"
  local http_code body body_file
  body_file="$(mktemp)"
  http_code=$(curl -s -A "$ua" -o "$body_file" -w '%{http_code}' --max-time 15 "$url" 2>/dev/null || echo "000")
  body=$(cat "$body_file" 2>/dev/null || echo "")
  rm -f "$body_file"

  if [ "$http_code" != "200" ]; then
    echo "  ❌ $name — expected 200, got $http_code (WAF allowlist missing or wrong scope)"
    FAIL=$((FAIL + 1))
    FAILED_TESTS+=("$name (http $http_code)")
    evidence_record "$name" "failed" "http_code=$http_code expected=200 ua=$ua"
    [ "$VERBOSE" = true ] && echo "     Body: $(echo "$body" | head -c 200)"
    return 1
  fi

  if echo "$body" | grep -q '"status":"ok"'; then
    echo "  ✅ $name — 200 with status=ok"
    PASS=$((PASS + 1))
    evidence_record "$name" "passed" "http_code=200 ua=$ua"
  else
    echo "  ❌ $name — 200 but wrong body shape (expected {\"status\":\"ok\",...})"
    FAIL=$((FAIL + 1))
    FAILED_TESTS+=("$name (shape)")
    evidence_record "$name" "failed" "body_shape ua=$ua"
    [ "$VERBOSE" = true ] && echo "     Body: $(echo "$body" | head -c 200)"
  fi
}

test_edge_blocked() {
  local name="$1"
  local url="$2"
  local ua="$3"
  local http_code
  http_code=$(curl -s -A "$ua" -o /dev/null -w '%{http_code}' --max-time 15 "$url" 2>/dev/null || echo "000")

  if [ "$http_code" = "200" ]; then
    echo "  ❌ $name — got 200, expected block; WAF allowlist is too broad"
    FAIL=$((FAIL + 1))
    FAILED_TESTS+=("$name (allowlist too broad)")
    evidence_record "$name" "failed" "http_code=200 ua=$ua scope=too_broad"
  else
    echo "  ✅ $name — blocked at edge (http $http_code), allowlist is scoped"
    PASS=$((PASS + 1))
    evidence_record "$name" "passed" "http_code=$http_code ua=$ua scope=correct"
  fi
}

if [ "$EDGE_VERIFY_ENABLED" = "1" ]; then
  echo ""
  echo "🛡  Cloudflare edge contract"
  test_edge_status_ok "edge: ClaudeBot UA -> /public-status (allowed)" \
    "$EDGE_HOST/public-status" "ClaudeBot/1.0 (+https://www.anthropic.com)"
  test_edge_status_ok "edge: UptimeRobot UA -> /public-status (allowed)" \
    "$EDGE_HOST/public-status" "Mozilla/5.0+(compatible; UptimeRobot/2.0)"
  test_edge_blocked "edge: ClaudeBot UA -> /health (must stay blocked)" \
    "$EDGE_HOST/health" "ClaudeBot/1.0 (+https://www.anthropic.com)"
else
  echo ""
  echo "🛡  Cloudflare edge contract — skipped (set NEXUS_SMOKE_EDGE_VERIFY=1 to enable)"
  echo "    Enable after the WAF allowlist rule is configured in the Cloudflare dashboard."
  echo "    See: docs/runbooks/cloudflared-tunnel.md -> Edge Protection And AI Crawler Policy"
fi

# The exact-artifact release path runs the Ollama policy smoke here, inside the
# existing staging gate. This is deliberately sequential: no extra workflow,
# shard, worker, or release lane is introduced. The governed inventory phase
# accepts only the reviewed pre-cleanup four-tag set or the post-cleanup sole
# retained 3B tag, so releases remain possible on either side of the one-time
# owner-authorized deletion.
echo ""
echo "🦙 Ollama routing, inventory, and bounded-runtime policy"
OLLAMA_SMOKE_RESULT=""
OLLAMA_SMOKE_RC=0
run_ollama_release_smoke() {
smoke_ssh "$SERVER" bash -s -- "$STAGING_ROOT" "$STAGING_RELEASE" <<'REMOTE_OLLAMA_SMOKE'
set -euo pipefail
staging_root="$1"
release_dir="$2"
case "$release_dir" in /*) ;; *) echo "release directory must be absolute" >&2; exit 64 ;; esac
[ "$(readlink -f -- "$staging_root/current")" = "$release_dir" ] || {
  echo "staging current selector changed before Ollama smoke" >&2
  exit 1
}
[ "$release_dir" != / ] && [ -d "$release_dir" ] && [ ! -L "$release_dir" ] || {
  echo "release directory is missing, unsafe, or a symlink" >&2
  exit 1
}
smoke_script="$release_dir/scripts/staging-smoke-ollama.sh"
[ -f "$smoke_script" ] && [ ! -L "$smoke_script" ] || {
  echo "exact-release Ollama smoke is missing or a symlink" >&2
  exit 1
}
cd "$release_dir"
exec env \
  OLLAMA_INVENTORY_PHASE=release \
  NEXUS_HUB_BASE_URL=http://127.0.0.1:8201 \
  PM2_APP_NAME=nexus-hub-staging \
  PM2_BIN=/home/dominguez/.npm-global/bin/pm2 \
  /usr/bin/bash "$smoke_script"
REMOTE_OLLAMA_SMOKE
}
OLLAMA_SMOKE_RESULT=$(run_ollama_release_smoke) || OLLAMA_SMOKE_RC=$?
OLLAMA_SMOKE_DETAIL="$(printf '%s' "$OLLAMA_SMOKE_RESULT" | tail -c 1000 | tr '\n' '; ')"
if [ "$OLLAMA_SMOKE_RC" -eq 0 ]; then
  echo "  ✅ Ollama release policy — exact staging release passed"
  PASS=$((PASS + 1))
  evidence_record "Ollama release policy" "passed" "$OLLAMA_SMOKE_DETAIL"
else
  echo "  ❌ Ollama release policy — exact staging release failed"
  FAIL=$((FAIL + 1))
  FAILED_TESTS+=("Ollama release policy")
  evidence_record "Ollama release policy" "failed" "$OLLAMA_SMOKE_DETAIL"
  [ "$VERBOSE" = true ] && printf '     Detail: %s\n' "$OLLAMA_SMOKE_RESULT"
fi

if assert_staging_selector; then
  PASS=$((PASS + 1))
  evidence_record "immutable staging selector" "passed" "release=$STAGING_RELEASE"
else
  echo "  ❌ Staging current selector changed during smoke operation"
  FAIL=$((FAIL + 1))
  FAILED_TESTS+=("immutable staging selector")
  evidence_record "immutable staging selector" "failed" "expected_release=$STAGING_RELEASE"
fi

# ── Smoke-evidence JSON ───────────────────────────────
# Write a JSON file recording: branch, SHA, timestamps, per-check results.
# Audits and the exact release operator can read this instead of re-running the
# 17-check suite. Failure to write the evidence file does not change the
# smoke pass/fail outcome — pure side effect.
write_evidence_file() {
  if [ "$EVIDENCE_ENABLED" != "1" ]; then
    return
  fi
  if ! mkdir -p "$EVIDENCE_DIR" 2>/dev/null; then
    [ "${NEXUS_SMOKE_REQUIRE_EXACT_IDENTITY:-0}" != 1 ] || return 1
    return 0
  fi
  chmod 700 "$EVIDENCE_DIR" 2>/dev/null || {
    [ "${NEXUS_SMOKE_REQUIRE_EXACT_IDENTITY:-0}" != 1 ] || return 1
  }
  local stamp
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  local file="${NEXUS_SMOKE_EVIDENCE_PATH:-$EVIDENCE_DIR/staging-smoke-${SMOKE_HEAD_SHA}-${stamp}.json}"
  node - "$EVIDENCE_DIR" "$file" <<'NODE' || return 1
const fs = require('node:fs');
const path = require('node:path');
const [root, file] = process.argv.slice(2).map((value) => path.resolve(value));
const relative = path.relative(root, file);
if (!relative || relative.startsWith('..') || path.isAbsolute(relative)
    || path.extname(file) !== '.json' || fs.existsSync(file) || fs.lstatSync(root).isSymbolicLink()) {
  process.exit(1);
}
NODE

  # Build a JSON via node, feeding each result line as TAB-separated.
  local results_blob
  results_blob="$(printf '%s\n' "${EVIDENCE_RESULTS[@]+"${EVIDENCE_RESULTS[@]}"}")"
  if ! ( set -o noclobber
    printf '%s' "$results_blob" \
      | NODE_NO_WARNINGS=1 node -e '
      const lines = require("fs").readFileSync(0, "utf8").split("\n").filter(Boolean);
      const checks = lines.map((l) => {
        const [name, status, ...rest] = l.split("\t");
        return { name, status, detail: (rest.join("\t") || null) };
      });
      const passed = checks.filter((c) => c.status === "passed").length;
      const failed = checks.filter((c) => c.status === "failed").length;
      const payload = {
        version: "2",
        profile: process.env.SMOKE_PROFILE,
        runStartedAt: process.env.SMOKE_START_AT,
        runCompletedAt: new Date().toISOString(),
        branch: process.env.SMOKE_BRANCH,
        sha: process.env.SMOKE_HEAD_SHA,
        runtimeSha: process.env.SMOKE_RUNTIME_SHA,
        artifactDigest: process.env.SMOKE_ARTIFACT_DIGEST,
        classifierBaseSha: process.env.SMOKE_CLASSIFIER_BASE_SHA || null,
        classifierHeadSha: process.env.SMOKE_CLASSIFIER_HEAD_SHA || null,
        host: "staging",
        verdict: failed === 0 ? "passed" : "failed",
        totals: { passed, failed, total: checks.length },
        checks,
      };
      console.log(JSON.stringify(payload, null, 2));
      ' > "$file" 2>/dev/null
  ); then
    return 1
  fi
  chmod 600 "$file"
  node - "$file" <<'NODE' || return 1
const fs = require('node:fs');
const file = process.argv[2];
const evidenceStat = fs.lstatSync(file);
if (!evidenceStat.isFile() || evidenceStat.isSymbolicLink()
    || evidenceStat.uid !== process.getuid()
    || (evidenceStat.mode & 0o777) !== 0o600
    || evidenceStat.nlink !== 1) {
  process.exit(1);
}
NODE
  echo "  📝 Smoke evidence: $file"
}
export SMOKE_START_AT SMOKE_BRANCH SMOKE_HEAD_SHA SMOKE_RUNTIME_SHA SMOKE_ARTIFACT_DIGEST SMOKE_PROFILE
export SMOKE_CLASSIFIER_BASE_SHA SMOKE_CLASSIFIER_HEAD_SHA

# ── Summary ────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════════"
TOTAL=$((PASS + FAIL))
if [ "$FAIL" -eq 0 ]; then
  echo "  ✅ ALL $TOTAL TESTS PASSED — staging is safe to promote"
  write_evidence_file
  echo "═══════════════════════════════════════════════"
  exit 0
else
  echo "  ❌ $FAIL of $TOTAL TESTS FAILED"
  echo ""
  echo "  Failed tests:"
  for t in "${FAILED_TESTS[@]}"; do
    echo "    - $t"
  done
  write_evidence_file
  echo ""
  echo "  DO NOT promote to prod until these are fixed."
  echo "═══════════════════════════════════════════════"
  exit 1
fi
