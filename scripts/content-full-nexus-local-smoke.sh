#!/usr/bin/env bash
# Repeatable local Content Creation full-product smoke.
#
# This wraps the full local Nexus runner with Content-specific tests,
# deterministic provider fixture mode, eval artifact generation, eval-history
# persistence, and cleanup. It never enables real model/provider calls unless
# the operator explicitly overrides NEXUS_LOCAL_ALLOW_MODEL_CALLS=1.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_DIR="${CONTENT_SMOKE_STATE_DIR:-$ROOT/.local/content-full-nexus-smoke}"
DB_PATH="${CONTENT_SMOKE_DATABASE_PATH:-$ROOT/data/content-full-nexus-smoke.db}"
EVAL_DB_PATH="${CONTENT_EVAL_DB_PATH:-$ROOT/reports/content-eval/content-eval-history.sqlite}"
EVAL_JSON_PATH="${CONTENT_EVAL_JSON_PATH:-$ROOT/reports/content-eval/content-eval-latest.json}"
EVAL_MD_PATH="${CONTENT_EVAL_MARKDOWN_PATH:-$ROOT/docs/content/content-eval-baseline-results.md}"
PORTAL_PORT="${PORTAL_PORT:-8200}"

usage() {
  cat <<'EOF'
Usage:
  scripts/content-full-nexus-local-smoke.sh [run|doctor|cleanup|help]

Commands:
  run       Start local Nexus, run Content smoke/eval/test gates, persist eval
            metadata, and clean up local services. Default command.
  doctor    Print runner configuration and local runtime status.
  cleanup   Stop local services and remove smoke DB/auth artifacts.
  help      Show this help.

Important env vars:
  CONTENT_SMOKE_STATE_DIR       Local runner state dir.
  CONTENT_SMOKE_DATABASE_PATH   Local smoke SQLite DB.
  CONTENT_EVAL_DB_PATH          Local eval-history SQLite DB.
  CONTENT_SMOKE_KEEP_RUNNING=1  Do not stop the backend after run.
  CONTENT_SMOKE_SKIP_RUNTIME=1  Skip backend start/smoke and run tests/eval only.
  NEXUS_LOCAL_ALLOW_MODEL_CALLS=1 explicitly allows live provider calls.

Default behavior uses deterministic fixture mode and loopback-only local data.
EOF
}

export FULL_NEXUS_STATE_DIR="$STATE_DIR"
export DATABASE_PATH="$DB_PATH"
export FULL_NEXUS_RESET_DB="${FULL_NEXUS_RESET_DB:-1}"
export NEXUS_LOCAL_ALLOW_MODEL_CALLS="${NEXUS_LOCAL_ALLOW_MODEL_CALLS:-0}"
export NEXUS_MODEL_FIXTURE_MODE="${NEXUS_MODEL_FIXTURE_MODE:-1}"
export CONTENT_EVAL_MODE="${CONTENT_EVAL_MODE:-fixture}"
export CONTENT_EVAL_PERSIST_DB="${CONTENT_EVAL_PERSIST_DB:-1}"
export PORTAL_PORT

cleanup_services() {
  if [[ "${CONTENT_SMOKE_KEEP_RUNNING:-0}" == "1" ]]; then
    echo "CONTENT_SMOKE_KEEP_RUNNING=1; leaving local services running."
    return 0
  fi
  "$ROOT/scripts/full-nexus-local-engine.sh" cleanup || true
}

run_content_tests() {
  npm test -- --run \
    __tests__/services/content-tenant-scope.test.ts \
    __tests__/services/content-reference-provenance.test.ts \
    __tests__/services/content-domain-ontology.test.ts \
    __tests__/services/content-editorial-workflow.test.ts \
    __tests__/services/content-memory-profile.test.ts \
    __tests__/services/content-radar-engine.test.ts \
    __tests__/services/content-generation-quality.test.ts \
    __tests__/services/content-novelty-reuse.test.ts \
    __tests__/services/provider-registry-fixture-mode.test.ts \
    __tests__/api/content-admin-write-auth.test.ts \
    __tests__/services/content-dashboard-service.test.ts \
    __tests__/api/content-dashboard.test.ts
  npm run test:evaluate -- \
    __tests__/services/content-day-to-day-evaluation.test.ts \
    __tests__/services/content-eval-history.test.ts
}

run_eval() {
  npm run eval:content -- \
    --markdown "$EVAL_MD_PATH" \
    --json "$EVAL_JSON_PATH" \
    --fail-under 85 \
    --persist-db "$EVAL_DB_PATH"
}

command_doctor() {
  echo "Content full Nexus local smoke doctor"
  echo "Root: $ROOT"
  echo "Branch: $(git -C "$ROOT" branch --show-current)"
  echo "Commit: $(git -C "$ROOT" rev-parse --short HEAD)"
  echo "State dir: $STATE_DIR"
  echo "Smoke DB: $DB_PATH"
  echo "Eval DB: $EVAL_DB_PATH"
  echo "Eval JSON: $EVAL_JSON_PATH"
  echo "Eval Markdown: $EVAL_MD_PATH"
  echo "Model calls allowed: $NEXUS_LOCAL_ALLOW_MODEL_CALLS"
  echo "Fixture mode: $NEXUS_MODEL_FIXTURE_MODE"
  "$ROOT/scripts/full-nexus-local-engine.sh" status || true
}

command_cleanup() {
  cleanup_services
}

command_run() {
  trap cleanup_services EXIT
  echo "== Content full Nexus local smoke =="
  command_doctor
  if [[ "${CONTENT_SMOKE_SKIP_RUNTIME:-0}" != "1" ]]; then
    "$ROOT/scripts/full-nexus-local-engine.sh" cleanup
    "$ROOT/scripts/full-nexus-local-engine.sh" start
    "$ROOT/scripts/full-nexus-local-engine.sh" smoke
    "$ROOT/scripts/full-nexus-local-engine.sh" cross-skill-fixtures
    "$ROOT/scripts/full-nexus-local-engine.sh" chat-tenant-smoke
  else
    echo "CONTENT_SMOKE_SKIP_RUNTIME=1; skipping backend runtime smoke."
  fi
  run_content_tests
  run_eval
  echo "Content full Nexus local smoke completed."
  echo "Eval DB: $EVAL_DB_PATH"
}

case "${1:-run}" in
  run) command_run ;;
  doctor) command_doctor ;;
  cleanup) command_cleanup ;;
  help|-h|--help) usage ;;
  *)
    echo "Unknown command: $1" >&2
    usage
    exit 1
    ;;
esac
