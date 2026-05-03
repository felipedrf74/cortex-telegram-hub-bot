#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [ ! -f dist/tools/training-calendar-staging-smoke.js ]; then
  echo "dist/tools/training-calendar-staging-smoke.js not found. Building first..."
  npm run build >/dev/null
fi

# Wrapped through with-smoke-evidence.sh so the run leaves a JSON evidence
# file under docs/release/smoke-evidence/. Disable with NEXUS_SMOKE_EVIDENCE=0.
exec scripts/with-smoke-evidence.sh training-calendar-staging \
  node dist/tools/training-calendar-staging-smoke.js "$@"
