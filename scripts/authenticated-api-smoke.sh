#!/usr/bin/env bash
# ─────────────────────────────────────────────────────
# authenticated-api-smoke.sh — smoke-test authenticated iOS API routes
#
# Runs a curated list of user-facing `/api/v1` routes with the same
# request shape the iOS app uses in runtime:
#   - Authorization: Bearer <access token>
#   - X-Language: <language code>
#   - Accept: application/json
#   - User-Agent: NexusHubiOS/1 CFNetwork
#
# This is intentionally a lightweight operator/developer script for
# post-deploy validation, not a full test harness. It reduces the
# "works in the app but fails in curl" problem by always sending
# app-like headers.
#
# Usage:
#   TOKEN='<jwt>' ./scripts/authenticated-api-smoke.sh
#   ./scripts/authenticated-api-smoke.sh --token-file /tmp/nexus-auth.json
#   ./scripts/authenticated-api-smoke.sh --base-url https://nexushub.me --language en
# ─────────────────────────────────────────────────────
set -euo pipefail

BASE_URL="${BASE_URL:-https://api.nexushub.me}"
LANGUAGE="${LANGUAGE:-pt-BR}"
USER_AGENT="${USER_AGENT:-NexusHubiOS/1 CFNetwork Darwin}"
TOKEN="${TOKEN:-${NEXUS_AUTH_TOKEN:-}}"
TOKEN_FILE="${TOKEN_FILE:-}"
VERBOSE=false

usage() {
  cat <<'EOF'
Usage:
  TOKEN='<jwt>' ./scripts/authenticated-api-smoke.sh
  ./scripts/authenticated-api-smoke.sh --token-file /path/to/auth.json

Options:
  --base-url URL       Base HTTPS URL to test (default: https://api.nexushub.me)
  --language CODE      X-Language header value (default: pt-BR)
  --token VALUE        Bearer token
  --token-file PATH    File containing a raw token or JSON with accessToken/token/jwt
  --verbose            Print response snippets for passing endpoints too
  --help               Show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --base-url)
      BASE_URL="$2"
      shift 2
      ;;
    --language)
      LANGUAGE="$2"
      shift 2
      ;;
    --token)
      TOKEN="$2"
      shift 2
      ;;
    --token-file)
      TOKEN_FILE="$2"
      shift 2
      ;;
    --verbose|-v)
      VERBOSE=true
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1"
      usage
      exit 1
      ;;
  esac
done

if [[ -n "$TOKEN_FILE" ]]; then
  if [[ ! -f "$TOKEN_FILE" ]]; then
    echo "❌ Token file not found: $TOKEN_FILE"
    exit 1
  fi
  TOKEN="$(node - "$TOKEN_FILE" <<'EOF'
const fs = require('fs');
const path = process.argv[2];
const raw = fs.readFileSync(path, 'utf8').trim();
if (!raw) process.exit(2);
try {
  const parsed = JSON.parse(raw);
  const token = parsed.accessToken || parsed.token || parsed.jwt;
  if (typeof token === 'string' && token.trim()) {
    process.stdout.write(token.trim());
    process.exit(0);
  }
} catch {}
process.stdout.write(raw);
EOF
)"
fi

TOKEN="$(printf '%s' "$TOKEN" | tr -d '\r\n')"
if [[ -z "$TOKEN" ]]; then
  echo "❌ Missing token. Provide --token, --token-file, TOKEN, or NEXUS_AUTH_TOKEN."
  exit 1
fi

PASS=0
FAIL=0
FAILED=()

TMP_DIR="$(mktemp -d)"
cleanup() { rm -rf "$TMP_DIR"; }
trap cleanup EXIT

test_endpoint() {
  local name="$1"
  local path="$2"
  local body_file="$TMP_DIR/body.$PASS.$FAIL.json"
  local status
  status="$(
    curl -sS \
      -o "$body_file" \
      -w '%{http_code}' \
      -H "Authorization: Bearer $TOKEN" \
      -H "Accept: application/json" \
      -H "X-Language: $LANGUAGE" \
      -H "User-Agent: $USER_AGENT" \
      "$BASE_URL$path" || true
  )"

  if [[ ! "$status" =~ ^2[0-9][0-9]$ ]]; then
    echo "  ❌ $name — HTTP $status"
    if [[ -s "$body_file" ]]; then
      echo "     $(head -c 220 "$body_file")"
    fi
    FAIL=$((FAIL + 1))
    FAILED+=("$name")
    return 1
  fi

  local check
  check="$(node - "$body_file" <<'EOF'
const fs = require('fs');
const path = process.argv[2];
const raw = fs.readFileSync(path, 'utf8');
try {
  const json = JSON.parse(raw);
  if (json && json.ok === true) {
    process.stdout.write('OK');
  } else {
    process.stdout.write('NOT_OK');
  }
} catch (error) {
  process.stdout.write(`NOT_JSON:${error.message}`);
}
EOF
)"

  if [[ "$check" != "OK" ]]; then
    echo "  ❌ $name — $check"
    if [[ -s "$body_file" ]]; then
      echo "     $(head -c 220 "$body_file")"
    fi
    FAIL=$((FAIL + 1))
    FAILED+=("$name")
    return 1
  fi

  echo "  ✅ $name"
  if [[ "$VERBOSE" == true ]]; then
    echo "     $(head -c 180 "$body_file")"
  fi
  PASS=$((PASS + 1))
}

echo "═══════════════════════════════════════════════"
echo "  🔐 Nexus Hub Authenticated API Smoke"
echo "═══════════════════════════════════════════════"
echo "Base URL: $BASE_URL"
echo "Language: $LANGUAGE"
echo ""

test_endpoint "Dashboard" "/api/v1/dashboard" || true
test_endpoint "Plan today" "/api/v1/plan/today" || true
test_endpoint "Plan week" "/api/v1/plan/week" || true
test_endpoint "Task lists" "/api/v1/tasks/lists" || true
test_endpoint "Today tasks" "/api/v1/tasks/filtered?filter=today" || true
test_endpoint "Training summary" "/api/v1/training/summary" || true
test_endpoint "Training today" "/api/v1/training/today" || true
test_endpoint "Content pipeline" "/api/v1/content/pipeline" || true
test_endpoint "Content intelligence summary" "/api/v1/content/intelligence" || true
TODAY="$(TZ=Europe/Lisbon date +%F)"
test_endpoint "Current meal plan" "/api/v1/cooking/meal-plan?from=$TODAY&to=$TODAY" || true
test_endpoint "Finance monthly summary" "/api/v1/finance/monthly-summary" || true
test_endpoint "Connections" "/api/v1/settings/connections" || true
test_endpoint "Inbox" "/api/v1/notifications/inbox?limit=5" || true

echo ""
echo "═══════════════════════════════════════════════"
TOTAL=$((PASS + FAIL))
if [[ "$FAIL" -eq 0 ]]; then
  echo "  ✅ ALL $TOTAL AUTHENTICATED SMOKE TESTS PASSED"
  echo "═══════════════════════════════════════════════"
  exit 0
else
  echo "  ❌ $FAIL of $TOTAL AUTHENTICATED SMOKE TESTS FAILED"
  echo ""
  echo "  Failed endpoints:"
  for item in "${FAILED[@]}"; do
    echo "    - $item"
  done
  echo "═══════════════════════════════════════════════"
  exit 1
fi
