#!/usr/bin/env bash
set -euo pipefail

if [ ! -f dist/tools/training-full-flow-staging-smoke.js ]; then
  echo "dist/tools/training-full-flow-staging-smoke.js not found. Building first..."
  npm run build >/dev/null
fi

exec scripts/with-smoke-evidence.sh training-full-flow-staging \
  node dist/tools/training-full-flow-staging-smoke.js "$@"
