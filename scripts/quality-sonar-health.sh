#!/usr/bin/env bash
# Wait for SonarQube's public system status without requiring an admin token.
set -euo pipefail
umask 077

URL=http://127.0.0.1:9000
ATTEMPTS=80
INTERVAL=10
CURL_BIN="$(command -v curl 2>/dev/null || true)"
NODE_BIN="$(command -v node 2>/dev/null || true)"

while [ $# -gt 0 ]; do
  case "$1" in
    --url) URL="$2"; shift 2 ;;
    --attempts) ATTEMPTS="$2"; shift 2 ;;
    --interval) INTERVAL="$2"; shift 2 ;;
    -h|--help) echo "Usage: quality-sonar-health.sh [--url http://127.0.0.1:9000] [--attempts 1-180] [--interval 0-60]"; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 64 ;;
  esac
done

case "$URL" in http://127.0.0.1:9000|http://localhost:9000|http://127.0.0.1:19000|http://localhost:19000) ;; *) echo "Sonar health URL must use an approved loopback port" >&2; exit 64 ;; esac
[[ "$ATTEMPTS" =~ ^[0-9]+$ ]] && [ "$ATTEMPTS" -ge 1 ] && [ "$ATTEMPTS" -le 180 ] || { echo "Invalid health attempt count" >&2; exit 64; }
[[ "$INTERVAL" =~ ^[0-9]+$ ]] && [ "$INTERVAL" -le 60 ] || { echo "Invalid health interval" >&2; exit 64; }
[ -x "$CURL_BIN" ] && [ -x "$NODE_BIN" ] || { echo "curl and node are required" >&2; exit 1; }

body="$(mktemp)"
cleanup() { rm -f "$body"; }
trap cleanup EXIT
chmod 0600 "$body"

for attempt in $(seq 1 "$ATTEMPTS"); do
  : >"$body"
  if "$CURL_BIN" --fail --silent --show-error --connect-timeout 2 --max-time 5 \
      "$URL/api/system/status" -o "$body" 2>/dev/null \
      && "$NODE_BIN" - "$body" <<'NODE'
const fs = require('fs');
const body = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (body.status !== 'UP') process.exit(1);
NODE
  then
    echo "sonarqube_health_ok status=UP attempt=$attempt"
    exit 0
  fi
  [ "$attempt" -eq "$ATTEMPTS" ] || [ "$INTERVAL" -eq 0 ] || sleep "$INTERVAL"
done

echo "SonarQube did not reach status UP after $ATTEMPTS attempts" >&2
exit 1
