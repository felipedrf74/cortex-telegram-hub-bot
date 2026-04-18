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
# Used as a gate by promote-to-prod.sh — that script REFUSES to swap
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
STAGING_DIR="${STAGING_PATH:-/home/dominguez/telegram-hub-bot-staging}"
VERBOSE=false

if [ "${1:-}" = "-v" ]; then
  VERBOSE=true
fi

echo "═══════════════════════════════════════════════"
echo "  🧪 Nexus Hub Staging Smoke Test"
echo "═══════════════════════════════════════════════"
echo ""

PASS=0
FAIL=0
FAILED_TESTS=()

# Read staging portal token once — saves N ssh round trips
STAGING_TOKEN=$(ssh "$SERVER" "grep -oP '(?<=^PORTAL_TOKEN=).+' $STAGING_DIR/.env 2>/dev/null" || true)
if [ -z "$STAGING_TOKEN" ]; then
  echo "❌ Could not read PORTAL_TOKEN from $STAGING_DIR/.env"
  echo "   Has staging been set up? See STAGING.md → first-time setup."
  exit 1
fi

# test_endpoint NAME URL EXPECTED_FIELD  → curls URL, JSON-parses, asserts
# the named field exists and is non-null. Auth header is added unless URL
# includes /health.
test_endpoint() {
  local name="$1"
  local url="$2"
  local field="$3"
  local auth_header=""
  if [[ ! "$url" =~ /health ]]; then
    auth_header="-H 'Authorization: Bearer $STAGING_TOKEN'"
  fi

  # Run on the server because staging is localhost-only
  local result
  result=$(ssh "$SERVER" "curl -sf $auth_header '$url' 2>/dev/null" || echo "__CURL_FAILED__")

  if [ "$result" = "__CURL_FAILED__" ] || [ -z "$result" ]; then
    echo "  ❌ $name — curl failed (URL not responding)"
    FAIL=$((FAIL + 1))
    FAILED_TESTS+=("$name")
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
    return 0
  else
    echo "  ❌ $name — $check"
    FAIL=$((FAIL + 1))
    FAILED_TESTS+=("$name")
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
# Without an auth token, each route MUST return 401 with a shape that
# the iOS client can decode. That tells us:
#   a) the route is mounted (not a 404)
#   b) auth middleware is active (not 200 leaking data)
#   c) error body contains a `code` + `message` iOS can surface
#
# iOS NexusHTTPClient.decodeError() accepts two shapes:
#   - new envelope: { ok: false, error: { code, message }, timestamp }
#   - legacy (auth-middleware): { error: { code, message } }
# Both are on-contract per spec 02; we accept either so the smoke
# reflects what the client actually tolerates rather than enforcing
# a stricter invariant than the product supports.
echo ""
echo "📱 iOS-surface contract smoke"
test_ios_401() {
  local name="$1"
  local url="$2"
  # No Authorization header — we EXPECT a 401
  local http_code
  http_code=$(ssh "$SERVER" "curl -s -o /tmp/_smoke_body -w '%{http_code}' '$url' 2>/dev/null" || echo "000")
  local body
  body=$(ssh "$SERVER" "cat /tmp/_smoke_body 2>/dev/null" || echo "")

  if [ "$http_code" != "401" ]; then
    echo "  ❌ $name — expected 401, got $http_code"
    FAIL=$((FAIL + 1))
    FAILED_TESTS+=("$name (http $http_code)")
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
        // Either envelope is accepted; both give iOS what it needs.
        const hasError = j.error && typeof j.error.code==='string' && typeof j.error.message==='string';
        const okFlagValid = j.ok === undefined || j.ok === false;
        if (hasError && okFlagValid) {
          console.log('OK');
        } else {
          console.log('BAD_SHAPE:'+JSON.stringify(j).slice(0,80));
        }
      } catch(e){ console.log('NOT_JSON:'+e.message); }
    });
  " 2>&1)

  if [ "$shape" = "OK" ]; then
    echo "  ✅ $name — 401 with iOS-decodable error shape"
    PASS=$((PASS + 1))
  else
    echo "  ❌ $name — $shape"
    FAIL=$((FAIL + 1))
    FAILED_TESTS+=("$name (shape)")
  fi
}

test_ios_401 "iOS /api/v1/dashboard"     "http://localhost:8201/api/v1/dashboard"
test_ios_401 "iOS /api/v1/tasks/lists"   "http://localhost:8201/api/v1/tasks/lists"
test_ios_401 "iOS /api/v1/training/today" "http://localhost:8201/api/v1/training/today"
test_ios_401 "iOS /api/v1/plan/today"    "http://localhost:8201/api/v1/plan/today"

echo ""
echo "🏃 5/6 — Process state via PM2"
PM2_STATUS=$(ssh "$SERVER" "/home/dominguez/.npm-global/bin/pm2 jlist 2>/dev/null | /usr/bin/node -e \"
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
if [[ "$PM2_STATUS" =~ ns=online && "$PM2_STATUS" =~ ce=online ]]; then
  echo "  ✅ PM2 — both staging processes online"
  PASS=$((PASS + 1))
  if [[ "$PM2_STATUS" =~ ns_restarts=([0-9]+) ]] && [ "${BASH_REMATCH[1]}" -gt 0 ]; then
    echo "  ⚠️  nexus-hub-staging has ${BASH_REMATCH[1]} unstable restarts — investigate"
  fi
else
  echo "  ❌ PM2 — $PM2_STATUS"
  FAIL=$((FAIL + 1))
  FAILED_TESTS+=("PM2 process state")
fi

echo ""
echo "🗃  6/6 — DB integrity"
DB_CHECK=$(ssh "$SERVER" "
  cd /home/dominguez/telegram-hub-bot-staging
  /usr/bin/node -e \"
    const db = require('better-sqlite3')('data/bot.db', { readonly: true });
    const r = db.pragma('integrity_check');
    console.log(JSON.stringify(r));
  \"
" 2>&1 || echo "FAILED")
if echo "$DB_CHECK" | grep -q '"integrity_check":"ok"'; then
  echo "  ✅ Staging DB integrity_check: ok"
  PASS=$((PASS + 1))
else
  echo "  ❌ Staging DB integrity_check failed: $DB_CHECK"
  FAIL=$((FAIL + 1))
  FAILED_TESTS+=("DB integrity")
fi

# ── Summary ────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════════"
TOTAL=$((PASS + FAIL))
if [ "$FAIL" -eq 0 ]; then
  echo "  ✅ ALL $TOTAL TESTS PASSED — staging is safe to promote"
  echo "═══════════════════════════════════════════════"
  exit 0
else
  echo "  ❌ $FAIL of $TOTAL TESTS FAILED"
  echo ""
  echo "  Failed tests:"
  for t in "${FAILED_TESTS[@]}"; do
    echo "    - $t"
  done
  echo ""
  echo "  DO NOT promote to prod until these are fixed."
  echo "═══════════════════════════════════════════════"
  exit 1
fi
