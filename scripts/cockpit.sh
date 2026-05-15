#!/usr/bin/env bash
# cockpit.sh — launcher for the Local Dev Cockpit
#
# Starts scripts/cockpit/server.js on 127.0.0.1:8210 (override with
# NEXUS_COCKPIT_PORT), waits for it to bind, opens the browser, and
# stays attached. Ctrl-C cleanly stops the server.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [ -f .env.local ]; then
  # shellcheck disable=SC1091
  set -a; source .env.local; set +a
fi

PORT="${NEXUS_COCKPIT_PORT:-8210}"
URL="http://127.0.0.1:${PORT}"

if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: node not found on PATH. Install Node 20+ first." >&2
  exit 1
fi

cockpit_port_pids() {
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | sort -u || true
  fi
}

wait_for_port_release() {
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if [ -z "$(cockpit_port_pids)" ]; then
      return 0
    fi
    sleep 0.2
  done
  return 1
}

if existing_status="$(curl -fsS "$URL/api/status" 2>/dev/null)" && printf '%s' "$existing_status" | grep -q '"cockpit"'; then
  echo "Existing Cockpit process found on $URL; restarting it so commands match the current files."
  PIDS="$(cockpit_port_pids)"
  if [ -z "$PIDS" ]; then
    echo "ERROR: could not find the existing Cockpit listener PID for port $PORT." >&2
    exit 1
  fi
  # shellcheck disable=SC2086
  kill $PIDS 2>/dev/null || true
  if ! wait_for_port_release; then
    # shellcheck disable=SC2086
    kill -KILL $PIDS 2>/dev/null || true
    wait_for_port_release || {
      echo "ERROR: port $PORT is still busy after stopping the previous Cockpit." >&2
      exit 1
    }
  fi
elif existing_page="$(curl -fsS "$URL" 2>/dev/null)" && printf '%s' "$existing_page" | grep -q 'Nexus Hub.*Local Cockpit'; then
  echo "Existing Cockpit process found on $URL; restarting it so commands match the current files."
  PIDS="$(cockpit_port_pids)"
  if [ -z "$PIDS" ]; then
    echo "ERROR: could not find the existing Cockpit listener PID for port $PORT." >&2
    exit 1
  fi
  # shellcheck disable=SC2086
  kill $PIDS 2>/dev/null || true
  if ! wait_for_port_release; then
    # shellcheck disable=SC2086
    kill -KILL $PIDS 2>/dev/null || true
    wait_for_port_release || {
      echo "ERROR: port $PORT is still busy after stopping the previous Cockpit." >&2
      exit 1
    }
  fi
elif [ -n "$(cockpit_port_pids)" ]; then
  echo "ERROR: port $PORT is already in use by a non-Cockpit process." >&2
  echo "Set NEXUS_COCKPIT_PORT to another port or stop the listener first." >&2
  exit 1
fi

echo "═══════════════════════════════════════════════"
echo "  Nexus Hub — Local Dev Cockpit"
echo "═══════════════════════════════════════════════"
echo "URL: $URL"
echo ""

node "$ROOT/scripts/cockpit/server.js" --port "$PORT" &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null || true' EXIT INT TERM

# Wait a beat for the server to bind, then poke the browser.
for _ in 1 2 3 4 5; do
  if curl -fsS "$URL" >/dev/null 2>&1; then
    open "$URL" 2>/dev/null || true
    OPENED=1
    break
  fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    wait "$SERVER_PID"
    exit $?
  fi
  sleep 0.4
done

if [ "${OPENED:-0}" != "1" ]; then
  echo "ERROR: Cockpit did not start on $URL." >&2
  exit 1
fi

wait "$SERVER_PID"
