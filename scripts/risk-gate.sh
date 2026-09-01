#!/usr/bin/env bash
set -euo pipefail

while IFS= read -r git_environment_name; do
  unset "$git_environment_name"
done < <(compgen -e | LC_ALL=C sort | grep '^GIT_' || true)
export GIT_NO_REPLACE_OBJECTS=1

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

BASE_REF=""
EXPLICIT_FILES=""
STAGED_ONLY=false
DRY_RUN=false
FORCE_FULL=false
SKIP_TYPECHECK=false
SKIP_PYTHON=false
SKIP_MIGRATIONS=false
COVERAGE=false
COVERAGE_SHARDS=1
REPORTER="${NEXUS_RISK_GATE_REPORTER:-dot}"
JSON_OUTPUT="${NEXUS_RISK_GATE_JSON_OUTPUT:-}"
SELECTION_OUTPUT="${NEXUS_TEST_SELECTION_OUTPUT:-.local/test-selection.json}"

usage() {
  cat <<'EOF'
Usage:
  scripts/risk-gate.sh [--base <ref>] [--files <comma-list>|--staged] [--dry-run]

Options:
  --base <ref>        Exact base ref for changed-file classification.
  --files <list>      Comma-separated file list for focused verification.
  --staged            Classify the exact staged index, including rename sides.
  --full              Run the complete deterministic Vitest suite manually.
  --skip-typecheck    Skip tsc when another job already owns type checking.
  --skip-python       Skip conditional content-engine pytest.
  --skip-migrations   Skip conditional migration safety checks.
  --coverage          Collect coverage in the same selected Vitest invocation.
  --coverage-shards N Split one selected coverage set into 1-4 merged shards.
  --dry-run           Print commands without executing them.

Env:
  NEXUS_RISK_GATE_REPORTER=dot
  NEXUS_RISK_GATE_JSON_OUTPUT=.local/...
  NEXUS_TEST_SELECTION_OUTPUT=.local/...
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --base)
      [ $# -ge 2 ] || { echo "--base requires a ref." >&2; exit 64; }
      BASE_REF="$2"
      shift 2
      ;;
    --files)
      [ $# -ge 2 ] || { echo "--files requires a comma-separated list." >&2; exit 64; }
      EXPLICIT_FILES="$2"
      shift 2
      ;;
    --staged) STAGED_ONLY=true; shift ;;
    --full) FORCE_FULL=true; shift ;;
    --skip-typecheck) SKIP_TYPECHECK=true; shift ;;
    --skip-python) SKIP_PYTHON=true; shift ;;
    --skip-migrations) SKIP_MIGRATIONS=true; shift ;;
    --coverage) COVERAGE=true; shift ;;
    --coverage-shards)
      [ $# -ge 2 ] || { echo "--coverage-shards requires a count." >&2; exit 64; }
      COVERAGE_SHARDS="$2"
      shift 2
      ;;
    --dry-run) DRY_RUN=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown arg: $1" >&2; usage >&2; exit 64 ;;
  esac
done

if ! [[ "$COVERAGE_SHARDS" =~ ^[1-4]$ ]]; then
  echo "--coverage-shards must be an integer from 1 through 4." >&2
  exit 64
fi
if [ "$COVERAGE_SHARDS" != "1" ] && [ "$COVERAGE" != "true" ]; then
  echo "--coverage-shards requires --coverage." >&2
  exit 64
fi

if [ "$STAGED_ONLY" = "true" ] && { [ -n "$BASE_REF" ] || [ -n "$EXPLICIT_FILES" ]; }; then
  echo "--staged cannot be combined with --base or --files." >&2
  exit 64
fi

validate_local_output() {
  local name="$1"
  local value="$2"
  [ -z "$value" ] && return
  case "$value" in
    .local/*)
      if [[ "$value" == *"/../"* \
         || "$value" == *"/./"* \
         || "$value" == *"//"* \
         || "$value" == *$'\n'* \
         || "$value" == *$'\r'* ]]; then
        echo "$name must be a canonical path under .local/." >&2
        exit 64
      fi
      ;;
    *) echo "$name must stay under .local/." >&2; exit 64 ;;
  esac
}

validate_local_output NEXUS_RISK_GATE_JSON_OUTPUT "$JSON_OUTPUT"
validate_local_output NEXUS_TEST_SELECTION_OUTPUT "$SELECTION_OUTPUT"

if [ "$DRY_RUN" != "true" ]; then
  git rev-parse --is-inside-work-tree >/dev/null
fi

run_cmd() {
  printf '▶ %s\n' "$*"
  if [ "$DRY_RUN" != "true" ]; then
    "$@"
  fi
}

CLASSIFIER_JSON_FILE="$(mktemp)"
trap 'rm -f "$CLASSIFIER_JSON_FILE"' EXIT

classifier_args=(--format json)
[ -z "$BASE_REF" ] || classifier_args+=(--base "$BASE_REF")
[ -z "$EXPLICIT_FILES" ] || classifier_args+=(--files "$EXPLICIT_FILES")
[ "$STAGED_ONLY" != "true" ] || classifier_args+=(--staged)

if ! scripts/changed-area-classifier.sh "${classifier_args[@]}" > "$CLASSIFIER_JSON_FILE"; then
  echo "❌ classifier failed — refusing an incomplete local safety gate" >&2
  exit 1
fi

json_get() {
  node -e '
    const fs = require("fs");
    const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    let value = data;
    for (const part of process.argv[2].split(".")) value = value?.[part];
    if (Array.isArray(value)) process.stdout.write(value.length ? `${value.join("\n")}\n` : "");
    else if (value !== null && value !== undefined) process.stdout.write(String(value));
  ' "$CLASSIFIER_JSON_FILE" "$1"
}

resolve_base() {
  local candidate="${BASE_REF:-$(json_get "baseRef")}"
  local resolved=""
  if [ -n "$candidate" ]; then
    resolved="$(git rev-parse --verify --quiet "${candidate}^{commit}" 2>/dev/null || true)"
  fi
  if [[ "$resolved" =~ ^[0-9a-f]{40}$ ]]; then
    printf '%s' "$resolved"
  else
    git rev-parse --verify 'HEAD^{commit}'
  fi
}

VITEST_MODE="$(json_get "vitest.mode")"
BASE_FOR_CHANGED="$(resolve_base)"
PYTHON_ENGINE="$(json_get "flags.pythonEngine")"
MIGRATION_CHANGED="$(json_get "flags.migration")"
[ "$FORCE_FULL" != "true" ] || VITEST_MODE="full"

echo "═══════════════════════════════════════════════"
echo "  Nexus lean risk gate"
echo "═══════════════════════════════════════════════"
echo "base: $BASE_FOR_CHANGED"
echo "vitest mode: $VITEST_MODE"

if [ "$SKIP_TYPECHECK" != "true" ]; then
  run_cmd npx tsc --noEmit
fi

case "$VITEST_MODE" in
  skip)
    echo "🧪 Vitest skipped: $(json_get "vitest.skipReason")"
    ;;
  full)
    tier_args=(node scripts/run-test-tier.mjs deterministic --reporter "$REPORTER")
    [ -z "$JSON_OUTPUT" ] || tier_args+=(--json-output "$JSON_OUTPUT")
    run_cmd "${tier_args[@]}"
    ;;
  focused)
    if [ "$DRY_RUN" = "true" ]; then
      echo "▶ node scripts/select-vitest-files.mjs --base $BASE_FOR_CHANGED --classifier <classifier-json>"
      if [ "$COVERAGE" = "true" ]; then
        echo "▶ node scripts/run-test-tier.mjs deterministic --reporter $REPORTER --coverage --coverage-base $BASE_FOR_CHANGED --coverage-shards $COVERAGE_SHARDS <core+owning-group-tests+static-dependents+changed-tests>"
        if [ "$COVERAGE_SHARDS" != "1" ]; then
          echo "▶ vitest --merge-reports=<private-shard-dir> --coverage"
        fi
      else
        echo "▶ npx vitest run --reporter=$REPORTER <core+owning-group-tests+static-dependents+changed-tests>"
      fi
      if [ "$COVERAGE" = "true" ]; then
        echo "▶ node scripts/changed-coverage-gate.mjs --base $BASE_FOR_CHANGED --classifier <classifier-json> --selection $SELECTION_OUTPUT --coverage-dir .local/coverage/selected"
      fi
    else
      SELECTED_FILES=()
      while IFS= read -r selected_file; do
        [ -z "$selected_file" ] || SELECTED_FILES+=("$selected_file")
      done < <(node scripts/select-vitest-files.mjs \
        --base "$BASE_FOR_CHANGED" \
        --classifier "$CLASSIFIER_JSON_FILE" \
        --output "$SELECTION_OUTPUT")
      if [ "${#SELECTED_FILES[@]}" -eq 0 ]; then
        echo "❌ focused selection was empty — refusing an untested change" >&2
        exit 1
      fi
      tier_args=(node scripts/run-test-tier.mjs deterministic --reporter "$REPORTER")
      [ -z "$JSON_OUTPUT" ] || tier_args+=(--json-output "$JSON_OUTPUT")
      [ "$COVERAGE" != "true" ] || tier_args+=(
        --coverage
        --coverage-base "$BASE_FOR_CHANGED"
        --coverage-shards "$COVERAGE_SHARDS"
      )
      run_cmd "${tier_args[@]}" "${SELECTED_FILES[@]}"
      if [ "$COVERAGE" = "true" ]; then
        run_cmd node scripts/changed-coverage-gate.mjs \
          --base "$BASE_FOR_CHANGED" \
          --classifier "$CLASSIFIER_JSON_FILE" \
          --selection "$SELECTION_OUTPUT" \
          --coverage-dir .local/coverage/selected
      fi
    fi
    ;;
  *)
    echo "❌ unknown vitest mode '$VITEST_MODE' — refusing ambiguous selection" >&2
    exit 1
    ;;
esac

if [ "$PYTHON_ENGINE" = "true" ] && [ "$SKIP_PYTHON" != "true" ]; then
  PYTHON_BIN="${CONTENT_ENGINE_PYTHON:-}"
  if [ -z "$PYTHON_BIN" ]; then
    for candidate in \
      "$ROOT/content-engine/.venv-codex313/bin/python" \
      "$ROOT/content-engine/.venv313/bin/python" \
      "$ROOT/content-engine/.venv/bin/python"; do
      if [ -x "$candidate" ]; then
        PYTHON_BIN="$candidate"
        break
      fi
    done
  fi
  run_cmd "${PYTHON_BIN:-python3}" -m pytest "$ROOT/content-engine/tests"
fi

if [ "$MIGRATION_CHANGED" = "true" ] && [ "$SKIP_MIGRATIONS" != "true" ]; then
  run_cmd node scripts/migration-safety-check.mjs \
    --base "$BASE_FOR_CHANGED" \
    --changed-only \
    --approval-mode scan
fi

echo "✅ risk gate complete"
