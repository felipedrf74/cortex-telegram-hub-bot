#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [ ! -f dist/tools/decision-center-notification-smoke.js ]; then
  echo "dist/tools/decision-center-notification-smoke.js not found. Building first..."
  npm run build
fi

exec node dist/tools/decision-center-notification-smoke.js "$@"
