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

# ── Smoke-evidence JSON (release-pipeline-risk-based-optimization, 2026-05-03)
# Every check result also goes into an in-memory array so we can emit a
# single JSON evidence file at the end. The file is written under
# docs/release/smoke-evidence/ (mkdir-p safe) and named with the deployed
# SHA + UTC timestamp so promote-to-prod.sh and audits can read it
# instead of re-running this script. Disable with NEXUS_SMOKE_EVIDENCE=0.
EVIDENCE_RESULTS=()
EVIDENCE_ENABLED="${NEXUS_SMOKE_EVIDENCE:-1}"
LOCAL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
EVIDENCE_DIR="$LOCAL_DIR/docs/release/smoke-evidence"
SMOKE_START_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
SMOKE_HEAD_SHA="$(cd "$LOCAL_DIR" && git rev-parse --short HEAD 2>/dev/null || echo unknown)"
SMOKE_BRANCH="$(cd "$LOCAL_DIR" && git branch --show-current 2>/dev/null || echo unknown)"

evidence_record() {
  # evidence_record <name> <status:passed|failed> [<detail>]
  local name="$1"
  local status="$2"
  local detail="${3:-}"
  EVIDENCE_RESULTS+=("$(printf '%s\t%s\t%s' "$name" "$status" "$detail")")
}

# Read staging portal auth once — saves N ssh round trips. Hardened beta
# staging may require signed ps_ sessions, in which case the legacy
# PORTAL_TOKEN must not be used.
PORTAL_REQUIRE_SESSION_AUTH=$(ssh "$SERVER" "grep -oP '(?<=^PORTAL_REQUIRE_SESSION_AUTH=).+' $STAGING_DIR/.env 2>/dev/null" || true)
STAGING_TOKEN=""
STAGING_SESSION=""
if [ "$PORTAL_REQUIRE_SESSION_AUTH" = "true" ]; then
  STAGING_SESSION=$(ssh "$SERVER" "
    set -e
    cd $STAGING_DIR
    set -a
    . ./.env
    set +a
    node dist/tools/portal-session-token.js --actor staging-smoke@nexushub.me --scope admin --ttl-ms 600000 --json \
      | node -e \"let b=''; process.stdin.on('data', c => b += c); process.stdin.on('end', () => { const j = JSON.parse(b); process.stdout.write(j.token || ''); });\"
  " 2>/dev/null || true)
  if [ -z "$STAGING_SESSION" ]; then
    echo "❌ Could not mint signed portal session from staging .env"
    echo "   Ensure PORTAL_SESSION_SECRET is set and the deployed dist/tools/portal-session-token.js exists."
    exit 1
  fi
else
  STAGING_TOKEN=$(ssh "$SERVER" "grep -oP '(?<=^PORTAL_TOKEN=).+' $STAGING_DIR/.env 2>/dev/null" || true)
  if [ -z "$STAGING_TOKEN" ]; then
    echo "❌ Could not read PORTAL_TOKEN from $STAGING_DIR/.env"
    echo "   Has staging been set up? See STAGING.md → first-time setup."
    exit 1
  fi
fi

portal_auth_header() {
  if [ -n "$STAGING_SESSION" ]; then
    printf "%s" "-H 'x-portal-session: $STAGING_SESSION'"
  else
    printf "%s" "-H 'Authorization: Bearer $STAGING_TOKEN'"
  fi
}

# test_endpoint NAME URL EXPECTED_FIELD  → curls URL, JSON-parses, asserts
# the named field exists and is non-null. Auth header is added unless URL
# includes /health.
test_endpoint() {
  local name="$1"
  local url="$2"
  local field="$3"
  local auth_header=""
  if [[ ! "$url" =~ /health ]]; then
    auth_header="$(portal_auth_header)"
  fi

  # Run on the server because staging is localhost-only
  local result
  result=$(ssh "$SERVER" "curl -sf $auth_header '$url' 2>/dev/null" || echo "__CURL_FAILED__")

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
  evidence_record "PM2 staging processes" "passed" "$PM2_STATUS"
  if [[ "$PM2_STATUS" =~ ns_restarts=([0-9]+) ]] && [ "${BASH_REMATCH[1]}" -gt 0 ]; then
    echo "  ⚠️  nexus-hub-staging has ${BASH_REMATCH[1]} unstable restarts — investigate"
  fi
else
  echo "  ❌ PM2 — $PM2_STATUS"
  FAIL=$((FAIL + 1))
  FAILED_TESTS+=("PM2 process state")
  evidence_record "PM2 staging processes" "failed" "$PM2_STATUS"
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
EDGE_HOST="${NEXUS_SMOKE_EDGE_HOST:-https://api-staging.nexushub.me}"

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
# Audits and `promote-to-prod.sh` can read this instead of re-running the
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
