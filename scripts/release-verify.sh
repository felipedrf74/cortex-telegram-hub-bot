#!/usr/bin/env bash
# Deterministic release verification runner. It does not deploy.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

SHARD=""
RUN_PYTEST=true
RUN_VITEST=true
BASE_REF="origin/main"

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
    --base)
      [ "$#" -ge 2 ] && [ -n "$2" ] || { echo "--base requires a ref" >&2; exit 64; }
      BASE_REF="$2"; shift 2
      ;;
    --shard)
      [ "$#" -ge 2 ] && [ -n "$2" ] || { echo "--shard requires a value" >&2; exit 64; }
      SHARD="$2"; shift 2
      ;;
    --skip-pytest) RUN_PYTEST=false; shift ;;
    --skip-vitest) RUN_VITEST=false; shift ;;
    -h|--help)
      sed -n '2,80p' "$0" | sed 's/^# \?//'
      exit 0
      ;;
    *) echo "Unknown arg: $1" >&2; exit 64 ;;
  esac
done

BASE_SHA="$(git rev-parse --verify --quiet --end-of-options "${BASE_REF}^{commit}")" || {
  echo "Release verification base does not resolve: $BASE_REF" >&2
  exit 64
}

echo "═══════════════════════════════════════════════"
echo "  Nexus release verify"
echo "═══════════════════════════════════════════════"

npm run typecheck
npm run science-policy:check
npm run build
node scripts/migration-safety-check.mjs \
  --base "$BASE_SHA" \
  --changed-only \
  --approval-mode review \
  --review-evidence "${NEXUS_MIGRATION_REVIEW_EVIDENCE:-.local/release/migration-review/current.json}"
scripts/cannot-skip-gate-dashboard.sh --json --no-evidence --base "$BASE_SHA" >/tmp/nexus-cannot-skip-dashboard.json
scripts/notification-release-gate.sh

if [ "$RUN_VITEST" = true ]; then
  if [ -n "$SHARD" ]; then
    node scripts/run-test-tier.mjs deterministic --shard "$SHARD" --reporter default
  else
    node scripts/run-test-tier.mjs deterministic --reporter default
  fi
fi

if [ "$RUN_PYTEST" = true ]; then
  PYTHON_BIN="$(resolve_content_engine_python)"
  "$PYTHON_BIN" -m pytest --version >/dev/null
  (cd content-engine && "$PYTHON_BIN" -m pytest tests/ -v)
fi

echo "✅ release verify complete"
