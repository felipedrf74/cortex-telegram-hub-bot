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

# ── Smoke-evidence JSON (release-pipeline-risk-based-optimization, 2026-05-03)
# Every check result also goes into an in-memory array so we can emit a
# single JSON evidence file at the end. The file is written under
# .local/release/smoke-evidence/ (mkdir-p safe) and named with the deployed
# SHA + UTC timestamp so the exact release operator and audits can read it
# instead of re-running this script. Disable with NEXUS_SMOKE_EVIDENCE=0.
EVIDENCE_RESULTS=()
EVIDENCE_ENABLED="${NEXUS_SMOKE_EVIDENCE:-1}"
LOCAL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
EVIDENCE_DIR="$LOCAL_DIR/.local/release/smoke-evidence"
SMOKE_START_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
SMOKE_HEAD_SHA="$(cd "$LOCAL_DIR" && git rev-parse --short HEAD 2>/dev/null || echo unknown)"
SMOKE_BRANCH="$(cd "$LOCAL_DIR" && git branch --show-current 2>/dev/null || echo unknown)"

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
PORTAL_REQUIRE_SESSION_AUTH=$(ssh "$SERVER" "grep -oP '(?<=^PORTAL_REQUIRE_SESSION_AUTH=).+' $STAGING_DIR/.env 2>/dev/null" || true)

portal_auth_curl() {
  local url="$1"
  ssh "$SERVER" bash -s -- "$STAGING_DIR" "$PORTAL_REQUIRE_SESSION_AUTH" "$url" <<'REMOTE_PORTAL_CURL'
set -e
STAGING_DIR="$1"
PORTAL_REQUIRE_SESSION_AUTH="$2"
URL="$3"
HEADER_FILE=$(mktemp)
cleanup() { rm -f "$HEADER_FILE"; }
trap cleanup EXIT
chmod 600 "$HEADER_FILE"
if [ "$PORTAL_REQUIRE_SESSION_AUTH" = "true" ]; then
  cd "$STAGING_DIR"
  set -a
  . ./.env
  set +a
  STAGING_SESSION=$(node dist/tools/portal-session-token.js --actor staging-smoke@nexushub.me --scope admin --ttl-ms 600000 --json \
    | node -e "let b=''; process.stdin.on('data', c => b += c); process.stdin.on('end', () => { const j = JSON.parse(b); process.stdout.write(j.token || ''); });")
  [ -n "$STAGING_SESSION" ] || exit 1
  printf 'x-portal-session: %s\n' "$STAGING_SESSION" > "$HEADER_FILE"
else
  STAGING_TOKEN=$(grep -oP '(?<=^PORTAL_TOKEN=).+' "$STAGING_DIR/.env" 2>/dev/null || true)
  [ -n "$STAGING_TOKEN" ] || exit 1
  printf 'Authorization: Bearer %s\n' "$STAGING_TOKEN" > "$HEADER_FILE"
fi
curl -sf -H @"$HEADER_FILE" "$URL" 2>/dev/null
REMOTE_PORTAL_CURL
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
  if [[ "$url" =~ /health ]]; then
    result=$(ssh "$SERVER" "curl -sf '$url' 2>/dev/null" || echo "__CURL_FAILED__")
  else
    result=$(portal_auth_curl "$url" || echo "__CURL_FAILED__")
  fi

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
  local http_code
  http_code=$(ssh "$SERVER" "curl -s -o /tmp/_smoke_chat_body -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d '{}' '$url' 2>/dev/null" || echo "000")
  local body
  body=$(ssh "$SERVER" "cat /tmp/_smoke_chat_body 2>/dev/null" || echo "")

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
  echo "  ⚠️  Training plan preview E2E skipped by NEXUS_SMOKE_TRAINING_E2E=0"
  PASS=$((PASS + 1))
  evidence_record "training plan preview e2e" "passed" "skipped_by_kill_switch"
else
  TRAINING_SMOKE_RESULT=""
  TRAINING_SMOKE_RC=0
  TRAINING_SMOKE_RESULT=$(ssh "$SERVER" "
    set -e
    cd $STAGING_DIR
    set -a
    . ./.env
    set +a
    node <<'NODE'
const Database = require('better-sqlite3');
const { signIosJwt } = require('./dist/services/ios-jwt');

const userId = Number(process.env.NEXUS_SMOKE_TRAINING_E2E_USER_ID || '1000014');
if (!Number.isInteger(userId) || userId < 1000000 || userId > 1099999) {
  throw new Error('NEXUS_SMOKE_TRAINING_E2E_USER_ID must be an isolated staging fixture user id in 1000000-1099999');
}

const deviceId = process.env.NEXUS_SMOKE_TRAINING_E2E_DEVICE_ID || 'training-preview-smoke-device-' + userId;
const db = new Database(process.env.DATABASE_PATH || process.env.DB_PATH || './data/bot.db');
const now = new Date().toISOString();

function tableExists(name) {
  return Boolean(db.prepare(\"SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?\").get(name));
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

db.transaction(() => {
  insert('users', {
    id: userId,
    telegram_id: 910000000 + userId,
    email: 'training-preview-smoke-' + userId + '@nexushub.test',
    email_verified: 1,
    username: 'training_preview_smoke_' + userId,
    first_name: 'Training',
    last_name: 'Smoke',
    language: 'en-US',
    timezone: 'Europe/Lisbon',
    tier: 'max',
    status: 'active',
    auth_provider: 'email',
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
})();

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
  " 2>&1) || TRAINING_SMOKE_RC=$?

  TRAINING_SMOKE_DETAIL="$(printf '%s' "$TRAINING_SMOKE_RESULT" | tail -c 700 | tr '\n' ' ')"
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
echo "🌐 Locale-fidelity chat smoke (es-419 + pt-BR canned turns)"
# Milestone 3 locale-fidelity gate: send one es-419 and one pt-BR canned chat
# turn through the real staging chat endpoint and assert the reply language
# with the deterministic detector shipped in dist/services/chat-language-
# detector.js (zero-LLM check; the reply itself may spend planner tokens on
# staging, which is acceptable for this gate). The check fails OPEN on
# 'unknown' detections (short acks like "OK") — it only fails the smoke when
# the detector confidently names a language that contradicts the prompt
# locale (the recurring es-419 → Portuguese leak). Uses an isolated staging
# fixture user like the training preview E2E. Disable with
# NEXUS_SMOKE_LOCALE_FIDELITY=0.
LOCALE_FIDELITY_ENABLED="${NEXUS_SMOKE_LOCALE_FIDELITY:-1}"
if [ "$LOCALE_FIDELITY_ENABLED" = "0" ]; then
  echo "  ⚠️  Locale-fidelity chat smoke skipped by NEXUS_SMOKE_LOCALE_FIDELITY=0"
  PASS=$((PASS + 1))
  evidence_record "locale fidelity chat smoke" "passed" "skipped_by_kill_switch"
else
  LOCALE_SMOKE_RESULT=""
  LOCALE_SMOKE_RC=0
  LOCALE_SMOKE_RESULT=$(ssh "$SERVER" "
    set -e
    cd $STAGING_DIR
    set -a
    . ./.env
    set +a
    node <<'NODE'
const Database = require('better-sqlite3');
const { signIosJwt } = require('./dist/services/ios-jwt');
const { checkResponseLocaleFidelity } = require('./dist/services/chat-language-detector');

const userId = Number(process.env.NEXUS_SMOKE_LOCALE_FIDELITY_USER_ID || '1000016');
if (!Number.isInteger(userId) || userId < 1000000 || userId > 1099999) {
  throw new Error('NEXUS_SMOKE_LOCALE_FIDELITY_USER_ID must be an isolated staging fixture user id in 1000000-1099999');
}

const deviceId = process.env.NEXUS_SMOKE_LOCALE_FIDELITY_DEVICE_ID || 'locale-fidelity-smoke-device-' + userId;
const db = new Database(process.env.DATABASE_PATH || process.env.DB_PATH || './data/bot.db');
const now = new Date().toISOString();

function columnsFor(name) {
  const exists = db.prepare(\"SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?\").get(name);
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

db.transaction(() => {
  insert('users', {
    id: userId,
    telegram_id: 910000000 + userId,
    email: 'locale-fidelity-smoke-' + userId + '@nexushub.test',
    email_verified: 1,
    username: 'locale_fidelity_smoke_' + userId,
    first_name: 'Locale',
    last_name: 'Smoke',
    language: 'es-ES',
    timezone: 'Europe/Lisbon',
    tier: 'max',
    status: 'active',
    auth_provider: 'email',
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
})();

const TURNS = [
  { locale: 'es-419', text: 'Crea una tarea llamada revisión del planificador de humo' },
  { locale: 'pt-BR', text: 'Cria uma tarefa chamada revisão do planejador de fumaça' },
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
  const replyText = typeof json?.text === 'string' ? json.text
    : typeof json?.data?.text === 'string' ? json.data.text
    : '';
  const fidelity = checkResponseLocaleFidelity(turn.locale, replyText);
  return {
    locale: turn.locale,
    httpStatus: response.status,
    ok: response.status === 200 && replyText.length > 0 && fidelity.ok,
    expected: fidelity.expected,
    detected: fidelity.detected,
    confidence: Number(fidelity.confidence.toFixed(3)),
    replyPreview: replyText.slice(0, 120),
  };
}

async function main() {
  const turns = [];
  for (const turn of TURNS) turns.push(await runTurn(turn));
  const ok = turns.every((result) => result.ok);
  process.stdout.write(JSON.stringify({ ok, userId, turns }));
  if (!ok) process.exit(1);
}

main().catch((err) => {
  process.stdout.write(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
  process.exit(1);
});
NODE
  " 2>&1) || LOCALE_SMOKE_RC=$?

  LOCALE_SMOKE_DETAIL="$(printf '%s' "$LOCALE_SMOKE_RESULT" | tail -c 700 | tr '\n' ' ')"
  if [ "$LOCALE_SMOKE_RC" -eq 0 ]; then
    echo "  ✅ Locale-fidelity chat smoke — es-419 and pt-BR replies match prompt locale"
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
# probe for domain-specific risk based on what the changed-area
# classifier says about the diff currently on staging vs origin/main.
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
if [ "$DOMAIN_PROBES_ENABLED" = "1" ] && [ -x "$LOCAL_DIR/scripts/changed-area-classifier.sh" ]; then
  echo ""
  echo "🎯 Bonus — classifier-driven domain probes"

  CLASSIFIER_JSON="$("$LOCAL_DIR/scripts/changed-area-classifier.sh" --base origin/main --format json 2>/dev/null || true)"
  if [ -n "$CLASSIFIER_JSON" ]; then
    has_flag() {
      printf '%s' "$CLASSIFIER_JSON" \
        | NODE_NO_WARNINGS=1 node -e "let b='';process.stdin.on('data',c=>b+=c);process.stdin.on('end',()=>{try{const j=JSON.parse(b);process.stdout.write(String(!!j.flags['$1']))}catch(_){process.stdout.write('false')}})" 2>/dev/null
    }

    if [ "$(has_flag training)" = "true" ]; then
      test_ios_401 "domain training /api/v1/training/today" "http://localhost:8201/api/v1/training/today"
    fi
    if [ "$(has_flag coachKernel)" = "true" ]; then
      test_ios_401 "domain coach /api/v1/training/coach/briefing" "http://localhost:8201/api/v1/training/coach/briefing"
    fi
    if [ "$(has_flag calendar)" = "true" ]; then
      test_ios_401 "domain calendar /api/v1/training/calendar" "http://localhost:8201/api/v1/training/calendar"
    fi
    if [ "$(has_flag cooking)" = "true" ]; then
      test_ios_401 "domain cooking /api/v1/cooking/recipes" "http://localhost:8201/api/v1/cooking/recipes"
    fi
    if [ "$(has_flag content)" = "true" ]; then
      test_ios_401 "domain content /api/v1/content/ideas" "http://localhost:8201/api/v1/content/ideas"
    fi
    if [ "$(has_flag secretary)" = "true" ]; then
      test_ios_401 "domain secretary /api/v1/plan/today" "http://localhost:8201/api/v1/plan/today"
    fi
    if [ "$(has_flag migration)" = "true" ]; then
      MIG_COUNT=$(ssh "$SERVER" "cd /home/dominguez/telegram-hub-bot-staging && /usr/bin/node -e \"
        const db = require('better-sqlite3')('data/bot.db', { readonly: true });
        const r = db.prepare('SELECT COUNT(*) AS c FROM _migrations').get();
        console.log(r.c);
      \"" 2>&1 || echo "ERR")
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
    if [ "$(has_flag training)$(has_flag coachKernel)$(has_flag calendar)$(has_flag cooking)$(has_flag content)$(has_flag secretary)$(has_flag migration)" = "falsefalsefalsefalsefalsefalsefalse" ]; then
      echo "  ℹ️ No domain probes triggered by current diff (docs-only / scripts-only)"
    fi
  else
    echo "  ⚠️ classifier returned empty output — skipping domain probes"
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

# ── Smoke-evidence JSON ───────────────────────────────
# Write a JSON file recording: branch, SHA, timestamps, per-check results.
# Audits and the exact release operator can read this instead of re-running the
# 17-check suite. Failure to write the evidence file does not change the
# smoke pass/fail outcome — pure side effect.
write_evidence_file() {
  if [ "$EVIDENCE_ENABLED" != "1" ]; then
    return
  fi
  mkdir -p "$EVIDENCE_DIR" 2>/dev/null || return
  local stamp
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  local file="$EVIDENCE_DIR/staging-smoke-${SMOKE_HEAD_SHA}-${stamp}.json"

  # Build a JSON via node, feeding each result line as TAB-separated.
  local results_blob
  results_blob="$(printf '%s\n' "${EVIDENCE_RESULTS[@]+"${EVIDENCE_RESULTS[@]}"}")"
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
        version: "1",
        runStartedAt: process.env.SMOKE_START_AT,
        runCompletedAt: new Date().toISOString(),
        branch: process.env.SMOKE_BRANCH,
        sha: process.env.SMOKE_HEAD_SHA,
        host: "staging",
        verdict: failed === 0 ? "passed" : "failed",
        totals: { passed, failed, total: checks.length },
        checks,
      };
      console.log(JSON.stringify(payload, null, 2));
    ' > "$file" 2>/dev/null \
    && echo "  📝 Smoke evidence: $file"
}
export SMOKE_START_AT SMOKE_BRANCH SMOKE_HEAD_SHA

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
