#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [ ! -f dist/tools/training-calendar-staging-smoke.js ]; then
  echo "dist/tools/training-calendar-staging-smoke.js not found. Building first..."
  npm run build >/dev/null
fi

node dist/tools/training-calendar-staging-smoke.js "$@"
