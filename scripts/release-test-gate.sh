#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

resolve_content_engine_python() {
  if [ -n "${CONTENT_ENGINE_PYTHON:-}" ]; then
    printf '%s\n' "$CONTENT_ENGINE_PYTHON"
    return 0
  fi
  for candidate in \
    "$ROOT/content-engine/.venv312/bin/python" \
    "$ROOT/content-engine/.venv/bin/python" \
    python3.12
  do
    if command -v "$candidate" >/dev/null 2>&1; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  echo "No Python interpreter found for release-artifact pytest" >&2
  return 1
}

BASE_REF="origin/main"
while [ $# -gt 0 ]; do
  case "$1" in
    --base)
      [ "$#" -ge 2 ] && [ -n "$2" ] || { echo "--base requires a ref" >&2; exit 64; }
      BASE_REF="$2"; shift 2
      ;;
    -h|--help)
      echo "Usage: scripts/release-test-gate.sh [--base <sha>]"
      exit 0
      ;;
    *) echo "Unknown argument: $1" >&2; exit 64 ;;
  esac
done

BASE_SHA="$(git rev-parse --verify --quiet --end-of-options "${BASE_REF}^{commit}")" || {
  echo "Release test base does not resolve: $BASE_REF" >&2
  exit 64
}

RESULT_PATH="$ROOT/.local/release/test-results.json"
STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
mkdir -p "$(dirname "$RESULT_PATH")"

REQUIRED_NODE_VERSION="$(tr -d '[:space:]' < "$ROOT/.nvmrc")"
ACTUAL_NODE_VERSION="$(node -p 'process.versions.node')"
if [ "$ACTUAL_NODE_VERSION" != "$REQUIRED_NODE_VERSION" ]; then
  echo "release tests require Node $REQUIRED_NODE_VERSION; found $ACTUAL_NODE_VERSION" >&2
  exit 1
fi

write_result() {
  local status="$1"
  local exit_code="$2"
  RESULT_STATUS="$status" RESULT_EXIT_CODE="$exit_code" RESULT_BASE_SHA="$BASE_SHA" \
    RESULT_STARTED_AT="$STARTED_AT" RESULT_PATH="$RESULT_PATH" node - <<'NODE'
const fs = require('fs');
const cp = require('child_process');
const pythonBin = process.env.RESULT_PYTHON_BIN;
const result = {
  schema: 'nexus.release-test-results.v1',
  status: process.env.RESULT_STATUS,
  exitCode: Number(process.env.RESULT_EXIT_CODE),
  runtimeSha: cp.execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  baseSha: process.env.RESULT_BASE_SHA,
  startedAt: process.env.RESULT_STARTED_AT,
  completedAt: new Date().toISOString(),
  toolchain: {
    node: process.version,
    python: cp.execFileSync(pythonBin, ['--version'], { encoding: 'utf8' }).trim(),
  },
  commands: ['typecheck', 'build', 'migration-rehearsal', 'changed-critical-union', 'content-engine-pytest', 'artifact-validation'],
};
fs.writeFileSync(process.env.RESULT_PATH, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
NODE
}

on_exit() {
  local exit_code=$?
  if [ "$exit_code" -eq 0 ]; then
    write_result passed 0
  else
    write_result failed "$exit_code"
  fi
}
trap on_exit EXIT

PYTHON_BIN="$(resolve_content_engine_python)"
export RESULT_PYTHON_BIN="$PYTHON_BIN"

npm run typecheck
npm run build
node scripts/migration-safety-check.mjs \
  --base "$BASE_SHA" \
  --changed-only \
  --approval-mode review \
  --review-evidence "${NEXUS_MIGRATION_REVIEW_EVIDENCE:-.local/release/migration-review/current.json}"
node scripts/run-test-tier.mjs changed --base "$BASE_SHA"
"$PYTHON_BIN" -m pytest --version >/dev/null
(cd content-engine && "$PYTHON_BIN" -m pytest tests/ -q)
mkdir -p .local/release
node scripts/release-artifact-manifest.mjs --write .local/release/artifact-manifest.json
node scripts/test-inventory.mjs
echo "Release test gate passed for $(git rev-parse HEAD)."
