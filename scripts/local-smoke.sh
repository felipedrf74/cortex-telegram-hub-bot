#!/usr/bin/env bash
# local-smoke.sh — 5-check contract for the local Docker sandbox.
#
# Mirrors the shape of scripts/staging-smoke.sh, minus the PM2 + remote
# SSH checks (compose health replaces those). The fifth check shells in
# via `docker compose exec` to run PRAGMA integrity_check on the SQLite
# DB so the same DB-integrity assertion holds.
#
# Exit 0 on all green, non-zero on any failure. Prints a colored summary
# line at the end.
#
# Usage:
#   ./scripts/local-smoke.sh           # default (8200/8100)
#   ./scripts/local-smoke.sh -v        # verbose response bodies
#   NEXUS_LOCAL_PORT_TS=8210 ./scripts/local-smoke.sh

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [ -f .env.local ]; then
  # shellcheck disable=SC1091
  set -a; source .env.local; set +a
fi

NEXUS_PORT="${NEXUS_LOCAL_PORT_TS:-8200}"
BASE_URL="http://127.0.0.1:${NEXUS_PORT}"
VERBOSE=0
if [ "${1:-}" = "-v" ]; then VERBOSE=1; fi

PORTAL_AUTH_HEADERS=()
if [ -n "${PORTAL_READ_TOKEN:-}" ]; then
  PORTAL_AUTH_HEADERS=(-H "Authorization: Bearer ${PORTAL_READ_TOKEN}")
elif [ -n "${PORTAL_WRITE_TOKEN:-}" ]; then
  PORTAL_AUTH_HEADERS=(-H "Authorization: Bearer ${PORTAL_WRITE_TOKEN}")
elif [ -n "${PORTAL_ADMIN_TOKEN:-}" ]; then
  PORTAL_AUTH_HEADERS=(-H "Authorization: Bearer ${PORTAL_ADMIN_TOKEN}")
elif [ -n "${PORTAL_TOKEN:-}" ]; then
  PORTAL_AUTH_HEADERS=(-H "Authorization: Bearer ${PORTAL_TOKEN}")
fi

# ANSI colors (skip if not a TTY)
if [ -t 1 ]; then
  C_GREEN=$(printf '\033[32m'); C_RED=$(printf '\033[31m'); C_RESET=$(printf '\033[0m'); C_BOLD=$(printf '\033[1m')
else
  C_GREEN=""; C_RED=""; C_RESET=""; C_BOLD=""
fi

PASS=0
FAIL=0
FAILED=()

check() {
  # check <label> <command...>
  local label="$1"; shift
  local output
  if output="$("$@" 2>&1)"; then
    PASS=$((PASS + 1))
    printf "  %s✓%s %s\n" "$C_GREEN" "$C_RESET" "$label"
    if [ "$VERBOSE" -eq 1 ] && [ -n "$output" ]; then
      printf "       %s\n" "$output" | head -5
    fi
  else
    FAIL=$((FAIL + 1))
    FAILED+=("$label")
    printf "  %s✗%s %s\n" "$C_RED" "$C_RESET" "$label"
    if [ -n "$output" ]; then
      printf "       %s\n" "$output" | head -5
    fi
  fi
}

echo "═══════════════════════════════════════════════"
echo "  Nexus Hub — local smoke ($BASE_URL)"
echo "═══════════════════════════════════════════════"
echo ""

# ──────────────────────────────────────────────────────────────────────
# Check 1: /health returns 200 with status:healthy or status:ok
check_health() {
  local body
  body=$(curl -fsS "$BASE_URL/health")
  # Accept both "healthy" and "ok" — different code paths use slightly
  # different status strings, but both mean OK.
  echo "$body" | grep -qE '"status":\s*"(healthy|ok)"' || {
    echo "unexpected body: $body"
    return 1
  }
}
check "GET /health returns 200 + status:(healthy|ok)" check_health

# ──────────────────────────────────────────────────────────────────────
# Check 2: /api/snapshot has .version and .uptime
check_snapshot() {
  local body
  body=$(curl -fsS "${PORTAL_AUTH_HEADERS[@]}" "$BASE_URL/api/snapshot") || return 1
  echo "$body" | grep -qE '"version"' || { echo "missing .version"; return 1; }
  echo "$body" | grep -qE '"uptime"' || { echo "missing .uptime"; return 1; }
}
check "GET /api/snapshot has .version and .uptime" check_snapshot

# ──────────────────────────────────────────────────────────────────────
# Check 3: /api/v1/dashboard returns 401 + canonical envelope when
# unauthenticated. This is the single most important contract check —
# malformed iOS API responses break the app at the first screen.
check_dashboard_401() {
  local response
  response=$(curl -s -o /tmp/nexus-smoke-body.$$ -w "%{http_code}" "$BASE_URL/api/v1/dashboard") || return 1
  if [ "$response" != "401" ]; then
    echo "expected 401, got $response"
    cat /tmp/nexus-smoke-body.$$ 2>/dev/null | head -3
    rm -f /tmp/nexus-smoke-body.$$
    return 1
  fi
  local body
  body=$(cat /tmp/nexus-smoke-body.$$)
  rm -f /tmp/nexus-smoke-body.$$
  # Canonical envelope: {ok:false, error:{code, message}, timestamp}
  echo "$body" | grep -qE '"ok":\s*false' || { echo "envelope missing ok:false: $body"; return 1; }
  echo "$body" | grep -qE '"error"' || { echo "envelope missing .error: $body"; return 1; }
  echo "$body" | grep -qE '"timestamp"' || { echo "envelope missing .timestamp: $body"; return 1; }
}
check "GET /api/v1/dashboard returns 401 + canonical envelope" check_dashboard_401

# ──────────────────────────────────────────────────────────────────────
# Check 4: /api/cost-by-domain returns the dashboard shape
check_cost_dashboard() {
  local body
  body=$(curl -fsS "${PORTAL_AUTH_HEADERS[@]}" "$BASE_URL/api/cost-by-domain?days=7") || return 1
  echo "$body" | grep -qE '"totalCost"|"providerSplit"|"dailySeries"' \
    || { echo "missing dashboard fields"; return 1; }
}
check "GET /api/cost-by-domain has dashboard shape" check_cost_dashboard

# ──────────────────────────────────────────────────────────────────────
# Check 5: SQLite PRAGMA integrity_check via docker exec
check_db_integrity() {
  local out
  out=$(docker compose -f docker-compose.local.yml exec -T nexus-hub \
    sh -c 'sqlite3 ${DATABASE_PATH:-/app/data/local.db} "PRAGMA integrity_check"' 2>&1) || {
    echo "docker exec failed: $out"
    return 1
  }
  echo "$out" | grep -q '^ok$' || { echo "integrity_check returned: $out"; return 1; }
}
check "SQLite PRAGMA integrity_check == ok" check_db_integrity

# ──────────────────────────────────────────────────────────────────────
echo ""
TOTAL=$((PASS + FAIL))
if [ "$FAIL" -eq 0 ]; then
  printf "%s%s✓ %d/%d checks passed%s\n" "$C_BOLD" "$C_GREEN" "$PASS" "$TOTAL" "$C_RESET"
  exit 0
else
  printf "%s%s✗ %d/%d failed%s\n" "$C_BOLD" "$C_RED" "$FAIL" "$TOTAL" "$C_RESET"
  for f in "${FAILED[@]}"; do
    printf "  - %s\n" "$f"
  done
  exit 1
fi
