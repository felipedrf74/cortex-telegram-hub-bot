#!/usr/bin/env bash
# Deterministic release verification runner. It does not deploy.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

SHARD=""
RUN_PYTEST=true
RUN_VITEST=true

resolve_content_engine_python() {
  if [ -n "${CONTENT_ENGINE_PYTHON:-}" ]; then
    printf '%s\n' "$CONTENT_ENGINE_PYTHON"
    return 0
  fi

  for candidate in \
    "$ROOT/content-engine/.venv313/bin/python" \
    "$ROOT/content-engine/.venv/bin/python" \
    "$ROOT/.venv/bin/python" \
    python3
  do
    if command -v "$candidate" >/dev/null 2>&1; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done

  echo "No Python interpreter found for content-engine pytest" >&2
  return 1
}

while [ $# -gt 0 ]; do
  case "$1" in
    --shard) SHARD="$2"; shift 2 ;;
    --skip-pytest) RUN_PYTEST=false; shift ;;
    --skip-vitest) RUN_VITEST=false; shift ;;
    -h|--help)
      sed -n '2,80p' "$0" | sed 's/^# \?//'
      exit 0
      ;;
    *) echo "Unknown arg: $1" >&2; exit 64 ;;
  esac
done

echo "═══════════════════════════════════════════════"
echo "  Nexus release verify"
echo "═══════════════════════════════════════════════"

npm run typecheck
npm run science-policy:check
npm run build
node scripts/migration-safety-check.mjs
scripts/cannot-skip-gate-dashboard.sh --json --no-evidence >/tmp/nexus-cannot-skip-dashboard.json

if [ "$RUN_VITEST" = true ]; then
  if [ -n "$SHARD" ]; then
    npx vitest run --shard="$SHARD"
  else
    npx vitest run
  fi
fi

if [ "$RUN_PYTEST" = true ]; then
  PYTHON_BIN="$(resolve_content_engine_python)"
  "$PYTHON_BIN" -m pytest --version >/dev/null
  (cd content-engine && "$PYTHON_BIN" -m pytest tests/ -v)
fi

echo "✅ release verify complete"
