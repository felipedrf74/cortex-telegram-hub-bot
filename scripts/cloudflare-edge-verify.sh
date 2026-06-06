#!/usr/bin/env bash
set -euo pipefail

MARKETING_HOST="${NEXUS_MARKETING_EDGE_HOST:-https://nexushub.me}"
API_HOST="${NEXUS_API_EDGE_HOST:-https://api.nexushub.me}"

failures=0

status_code() {
  local url="$1"
  local ua="$2"
  curl -sS -L -o /dev/null -w '%{http_code}' -A "$ua" "$url" || true
}

assert_status() {
  local label="$1"
  local url="$2"
  local ua="$3"
  local expected="$4"
  local code
  code="$(status_code "$url" "$ua")"
  if [ "$code" = "$expected" ]; then
    printf '[PASS] %s -> %s\n' "$label" "$code"
  else
    printf '[FAIL] %s -> got %s, expected %s\n' "$label" "$code" "$expected"
    failures=$((failures + 1))
  fi
}

assert_not_status() {
  local label="$1"
  local url="$2"
  local ua="$3"
  local forbidden="$4"
  local code
  code="$(status_code "$url" "$ua")"
  if [ "$code" != "$forbidden" ]; then
    printf '[PASS] %s -> %s\n' "$label" "$code"
  else
    printf '[FAIL] %s -> got forbidden status %s\n' "$label" "$code"
    failures=$((failures + 1))
  fi
}

echo "Marketing host: $MARKETING_HOST"
assert_status "marketing ClaudeBot" "$MARKETING_HOST/" "ClaudeBot/1.0 (+https://www.anthropic.com)" "200"
assert_status "marketing Claude-Web" "$MARKETING_HOST/" "Claude-Web/1.0" "200"
assert_status "marketing anthropic-ai" "$MARKETING_HOST/" "anthropic-ai" "200"
assert_status "marketing ChatGPT-User" "$MARKETING_HOST/" "ChatGPT-User/1.0" "200"
assert_status "marketing PerplexityBot" "$MARKETING_HOST/" "PerplexityBot/1.0" "200"

echo
echo "API host: $API_HOST"
assert_status "api ClaudeBot public-status" "$API_HOST/public-status" "ClaudeBot/1.0 (+https://www.anthropic.com)" "200"
assert_status "api UptimeRobot public-status" "$API_HOST/public-status" "Mozilla/5.0+(compatible; UptimeRobot/2.0)" "200"
assert_not_status "api ClaudeBot health remains protected" "$API_HOST/health" "ClaudeBot/1.0 (+https://www.anthropic.com)" "200"

echo
echo "Robots contract: $MARKETING_HOST/robots.txt"
robots_file="$(mktemp)"
trap 'rm -f "$robots_file"' EXIT
curl -fsSL "$MARKETING_HOST/robots.txt" > "$robots_file" || true
if grep -q '# BEGIN Cloudflare Managed content' "$robots_file"; then
  echo "[FAIL] robots.txt still contains Cloudflare Managed content"
  failures=$((failures + 1))
else
  echo "[PASS] robots.txt is not Cloudflare Managed"
fi

if grep -A2 -E '^User-agent: ClaudeBot$' "$robots_file" | grep -q 'Allow: /'; then
  echo "[PASS] robots.txt explicitly allows ClaudeBot"
else
  echo "[FAIL] robots.txt does not explicitly allow ClaudeBot"
  failures=$((failures + 1))
fi

echo
echo "LLM discovery contract: $MARKETING_HOST/llms.txt"
llms_file="$(mktemp)"
trap 'rm -f "$robots_file" "$llms_file"' EXIT
curl -fsSL "$MARKETING_HOST/llms.txt" > "$llms_file" || true
if head -1 "$llms_file" | grep -q '^# Nexus Hub$'; then
  echo "[PASS] llms.txt is deployed"
else
  echo "[FAIL] llms.txt is not deployed as the canonical Markdown file"
  failures=$((failures + 1))
fi

if grep -q '\$14\.99/month or R\$69\.99/month' "$llms_file" \
  && grep -q '\$24\.99/month or R\$119\.99/month' "$llms_file"; then
  echo "[PASS] llms.txt contains current Pro/Max prices"
else
  echo "[FAIL] llms.txt does not contain current Pro/Max prices"
  failures=$((failures + 1))
fi

if [ "$failures" -gt 0 ]; then
  echo
  echo "Cloudflare edge contract failed with $failures issue(s)."
  echo "Run scripts/cloudflare-edge-release.sh --apply with a Cloudflare API token, then rerun this verifier."
  exit 1
fi

echo
echo "Cloudflare edge contract passed."
